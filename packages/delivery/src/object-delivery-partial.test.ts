import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GateSpec } from "@claudexor/review";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  WorkspaceManager,
} from "@claudexor/workspace";
import { finalVerifyBlocks, finalVerifyPatch } from "./final-verifier.js";
import { revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// #501: delivery onto a partial clone. A complete one (every file of its checkout
// present, also when shallow) verifies and delivers like any clone; one whose
// commit has content the repository never fetched (a sparse checkout of a partial
// clone) is refused before anything is written, and the fresh verifier itself never
// passes a tree that its checkout left incomplete. Nothing is fetched: the upstream
// is gone before any delivery runs.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-partial-delivery-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
});
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: ENV })
    .toString("utf8")
    .trim();
const peek = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" } })
    .toString("utf8")
    .trim();
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
/** Objects of a commit's tree its repository does not hold, counted without fetching. */
const missingAt = (repo: string, rev: string) =>
  execFileSync("git", ["-C", repo, "rev-list", "--objects", "--no-walk", "--missing=print", rev], {
    env: { ...ENV, GIT_NO_LAZY_FETCH: "1" },
  })
    .toString("utf8")
    .split("\n")
    .filter((line) => line.startsWith("?")).length;

type Shape = "partial" | "shallow-partial" | "sparse-partial";

/** An upstream (kept/value.txt, outside/b.txt), a target cloned from it with a blob
 * filter, and a complete clone of it; the upstream then moves away. */
function world(shape: Shape) {
  const base = mkdtempSync(join(tmpdir(), "cx-partial-delivery-"));
  dirs.push(base);
  // The upstream stays on a plain path: Git drops `--filter` from a `file://` URL
  // with a non-ASCII character in it and makes a complete clone.
  const root = join(base, "dir with space ü");
  mkdirSync(root);
  const work = join(base, "work");
  mkdirSync(join(work, "kept"), { recursive: true });
  mkdirSync(join(work, "outside"));
  git(work, ["init", "-q", "-b", "main"]);
  writeFileSync(join(work, "outside", "b.txt"), "outside\n");
  for (const value of ["one", "two"]) {
    writeFileSync(join(work, "kept", "value.txt"), `${value}\n`);
    git(work, ["add", "-A"]);
    git(work, ["commit", "-qm", value]);
  }
  const upstream = join(base, "upstream.git");
  git(base, ["clone", "-q", "--bare", work, upstream]);
  git(upstream, ["config", "uploadpack.allowFilter", "true"]);
  git(upstream, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const url = `file://${upstream}`;
  const target = join(root, "target");
  const depth = shape === "shallow-partial" ? ["--depth", "1"] : [];
  git(root, ["clone", "-q", "--no-checkout", "--filter=blob:none", ...depth, url, target]);
  if (shape === "sparse-partial") git(target, ["sparse-checkout", "set", "--cone", "kept"]);
  git(target, ["checkout", "-q", "main"]);
  const complete = join(root, "complete");
  if (shape === "sparse-partial") git(root, ["clone", "-q", url, complete]);
  // The fixture has the shape it is named after.
  expect(git(target, ["config", "remote.origin.promisor"])).toBe("true");
  expect(missingAt(target, "HEAD")).toBe(shape === "sparse-partial" ? 1 : 0);
  expect(git(target, ["rev-parse", "--is-shallow-repository"])).toBe(
    String(shape === "shallow-partial"),
  );
  renameSync(upstream, `${upstream}.gone`);
  return { root, target, complete };
}

/** A gate that passes only when the verify clone holds every file of the composed tree. */
const wholeTree: GateSpec = {
  id: "whole-tree",
  program: process.execPath,
  args: [
    "-e",
    `const fs = require("node:fs");
     const ok = fs.readFileSync("kept/value.txt", "utf8") === "candidate\\n" &&
       fs.readFileSync("outside/b.txt", "utf8") === "outside\\n";
     process.exit(ok ? 0 : 3);`,
  ],
};

// Real Git end to end: generous on a loaded machine, still a hang detector.
describe("verifyAndDeliver onto a partial clone (#501)", { timeout: 120_000 }, () => {
  for (const shape of ["partial", "shallow-partial"] as const)
    it(`a complete ${shape} clone: the real envelope's result verifies whole, applies and reverts`, async () => {
      const w = world(shape);
      const runDir = mkdtempSync(join(w.root, "run-"));
      const manager = new WorkspaceManager(w.target, { runtimeRoot: join(w.root, "runtime") });
      const envelope = await manager.create({
        taskId: "t1",
        attemptId: "a01",
        dirtyPolicy: "snapshot",
        custody: { runId: "run-1", runDir },
      });
      writeFileSync(join(envelope.worktree_path, "kept", "value.txt"), "candidate\n");
      const captured = await manager.captureDiff(envelope, runDir);
      expect(captured.captureIncomplete).toBe(false);
      writeFileSync(join(w.target, "new.txt"), "user untracked\n");

      const delivered = await verifyAndDeliver(
        w.target,
        { result: captured.result!, renderedPatch: captured.diff },
        { mode: "apply", projectRoot: w.target, owner: runDir },
        [wholeTree],
      );
      expect(delivered.finalVerify).toMatchObject({ applied_cleanly: true, gates_passed: true });
      expect(delivered.applied).toBe(true);
      expect(read(join(w.target, "kept", "value.txt"))).toBe("candidate\n");
      expect(read(join(w.target, "new.txt"))).toBe("user untracked\n");
      const anchor = await createPairRevertAnchor(w.target, delivered.deliveryPair!);
      expect((await revertInPlaceFromAnchor(w.target, anchor)).reverted).toBe(true);
      expect(read(join(w.target, "kept", "value.txt"))).toBe("two\n");
      expect(read(join(w.target, "new.txt"))).toBe("user untracked\n");
    });

  it("a sparse partial clone: refused before any write, and its fresh verify never passes", async () => {
    const w = world("sparse-partial");
    // A result made elsewhere for this project (its own envelope is refused, above).
    writeFileSync(join(w.complete, "kept", "value.txt"), "candidate\n");
    const runDir = mkdtempSync(join(w.root, "run-"));
    const captured = await captureWorkingTreeTransient(w.complete, "HEAD", [], {
      projectRoot: w.target,
      owner: runDir,
    });
    const before = [
      peek(w.target, ["status", "--porcelain=v1"]),
      peek(w.target, ["ls-files", "-v"]),
    ];
    const delivered = await verifyAndDeliver(
      w.target,
      { result: captured.result!, renderedPatch: captured.patch },
      { mode: "apply", projectRoot: w.target, owner: runDir },
      [wholeTree],
    );
    expect(delivered).toMatchObject({ applied: false, refused: true, treeMutated: false });
    expect(delivered.refusal?.code).toBe("result_objects_missing");
    expect(read(join(w.target, "kept", "value.txt"))).toBe("two\n");
    expect([
      peek(w.target, ["status", "--porcelain=v1"]),
      peek(w.target, ["ls-files", "-v"]),
    ]).toEqual(before);

    const head = git(w.target, ["rev-parse", "HEAD"]);
    const tree = git(w.target, ["rev-parse", "HEAD^{tree}"]);
    const verified = await finalVerifyPatch(
      w.target,
      { baseSha: head, baseTree: tree, tree, projectRoot: w.target },
      [wholeTree],
      { emit: () => undefined },
    );
    expect(verified.applied_cleanly).toBeNull();
    expect(verified.reason).toContain(`isolated clone of ${head} is incomplete`);
    expect(verified.reason).toContain("outside/b.txt");
    expect(finalVerifyBlocks(verified)).toBe(true);
  });
});
