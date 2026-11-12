import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GateSpec } from "@claudexor/review";
import { createPairRevertAnchor, objectStorePath, WorkspaceManager } from "@claudexor/workspace";
import { revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// #501: a delivery target that is a shallow clone. The delivery writes its dirty
// snapshot and its composed tree into the target only, then verifies them in a
// fresh private clone (INV-115), which must read the target's objects as a full
// clone's does. Producer and consumer are the production ones: a real
// WorkspaceManager envelope and capture, then verifyAndDeliver as the apply route
// calls it.
const dirs: string[] = [];
// Each test removes its own repositories: one sweep at the end of the file can
// outlast the hook timeout on a loaded machine (#376).
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
beforeEach(() => {
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-shallow-delivery-config-"));
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
const git = (repo: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", repo, ...args], { env: ENV, input })
    .toString("utf8")
    .trim();
/** A read that never refreshes the index it may be comparing. */
const peek = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" } })
    .toString("utf8")
    .trim();
const holds = (args: string[], oid: string) =>
  spawnSync("git", [...args, "cat-file", "-e", oid], { env: ENV }).status === 0;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CANDIDATE_FILE = "cändidate file.txt";
const USER_EDIT = "three\nuser ü edit, unsaved\n";

function filesUnder(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(dir, entry.name), root)
      : [relative(root, join(dir, entry.name))],
  );
}
const fingerprint = (dir: string) =>
  sha(
    filesUnder(dir)
      .sort()
      .map((file) => `${file}\0${sha(readFileSync(join(dir, file)))}`)
      .join("\n"),
  );

type Shape = "shallow" | "full" | "linked-shallow";

/** An upstream of three commits and a target cloned from it, under a path with a space and non-ASCII. */
function world(shape: Shape) {
  const root = join(mkdtempSync(join(tmpdir(), "cx-shallow-delivery-")), "dir with space ü");
  dirs.push(join(root, ".."));
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-q", "-b", "main"]);
  writeFileSync(join(work, "stable.txt"), "stable\n");
  for (const value of ["one", "two", "three"]) {
    writeFileSync(join(work, "value.txt"), `${value}\n`);
    git(work, ["add", "-A"]);
    git(work, ["commit", "-qm", value]);
  }
  const upstream = join(root, "upstream.git");
  git(root, ["clone", "-q", "--bare", work, upstream]);
  const url = `file://${upstream}`;
  const depth = shape === "full" ? [] : ["--depth", "1"];
  let target = join(root, "target");
  git(root, ["clone", "-q", ...depth, url, target]);
  if (shape === "linked-shallow") {
    const main = target;
    target = join(root, "linked target");
    git(main, ["worktree", "add", "-q", "-b", "side", target]);
  }
  expect(git(target, ["rev-parse", "--is-shallow-repository"])).toBe(String(shape !== "full"));
  const userDirty = () => {
    writeFileSync(join(target, "value.txt"), USER_EDIT);
    writeFileSync(join(target, "new ü.txt"), "user untracked\n");
  };
  return { root, target, upstream, userDirty };
}

/** The real producer: an isolated envelope over the target, a harness edit and commit, the capture. */
async function produce(w: ReturnType<typeof world>) {
  const runDir = mkdtempSync(join(w.root, "run-"));
  const manager = new WorkspaceManager(w.target, { runtimeRoot: join(w.root, "runtime") });
  const envelope = await manager.create({
    taskId: "t1",
    attemptId: "a01",
    dirtyPolicy: "snapshot",
    custody: { runId: "run-1", runDir },
  });
  // The envelope is the same private clone as the verifier's: the target's objects
  // first, whatever the target's depth, then the project store once one exists
  // (a dirty base created it).
  const common = peek(w.target, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const store = join(objectStorePath(w.target), "objects");
  const alternates = readFileSync(
    join(envelope.worktree_path, ".git", "objects", "info", "alternates"),
    "utf8",
  );
  expect(alternates.split("\n").map((line) => (line ? realpathSync(line) : line))).toEqual([
    realpathSync(join(common, "objects")),
    ...(existsSync(store) ? [realpathSync(store)] : []),
    "",
  ]);
  writeFileSync(join(envelope.worktree_path, "stable.txt"), "candidate edit\n");
  writeFileSync(join(envelope.worktree_path, CANDIDATE_FILE), "candidate file\n");
  git(envelope.worktree_path, ["add", "-A"]);
  git(envelope.worktree_path, ["commit", "-qm", "harness commit inside its envelope"]);
  const harnessCommit = git(envelope.worktree_path, ["rev-parse", "HEAD"]);
  const captured = await manager.captureDiff(envelope, runDir);
  expect(captured.captureIncomplete).toBe(false);
  return {
    runDir,
    baseSha: envelope.base_sha!,
    harnessCommit,
    delivery: {
      result: captured.result!,
      renderedPatch: captured.patchViewUnavailable ? null : captured.diff,
    },
  };
}

/** Everything a delivery must leave as Git and the user see it, except the paths it delivers. */
function targetState(target: string) {
  const gitDir = peek(target, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const common = peek(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return {
    head: peek(target, ["rev-parse", "HEAD"]),
    symbolicHead: peek(target, ["symbolic-ref", "-q", "HEAD"]),
    refs: peek(target, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    index: sha(readFileSync(join(gitDir, "index"))),
    shallow: read(join(common, "shallow")),
    alternates: existsSync(join(common, "objects", "info", "alternates")),
  };
}

/** A gate that checks the composed tree in the verify clone and writes one object there. */
function verifyTreeGate(expected: Record<string, string | null>, probe: string): GateSpec {
  const script = `
    const { execFileSync } = require("node:child_process");
    const { existsSync, readFileSync } = require("node:fs");
    const expected = ${JSON.stringify(expected)};
    for (const [file, text] of Object.entries(expected)) {
      const seen = existsSync(file) ? readFileSync(file, "utf8") : null;
      if (seen !== text) { console.error(file, JSON.stringify(seen)); process.exit(3); }
    }
    const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], { input: ${JSON.stringify(probe)} })
      .toString().trim();
    execFileSync("git", ["cat-file", "-e", oid]);
  `;
  return {
    id: "verify-tree",
    program: process.execPath,
    args: ["-e", script],
    envAllowlist: ["PATH", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"],
  };
}

interface Case {
  shape: Shape;
  /** after: the user edits while the run is in flight; start: the tree was dirty when it began. */
  dirty?: "after" | "start";
  /** The target's HEAD gains a commit after the capture. */
  moveHead?: boolean;
  mode?: "apply" | "commit";
  failingGate?: boolean;
}

async function deliver(c: Case) {
  const w = world(c.shape);
  if (c.dirty === "start") w.userDirty();
  const produced = await produce(w);
  if (c.dirty === "after") w.userDirty();
  if (c.moveHead) {
    writeFileSync(join(w.target, "moved.txt"), "moved after the capture\n");
    git(w.target, ["add", "moved.txt"]);
    git(w.target, ["commit", "-qm", "moved"]);
  }
  // Commit times have one-second resolution: the delivery's own snapshot of an
  // unchanged dirty tree is then a different commit from the envelope's base.
  if (c.dirty === "start") await sleep(1100);
  const userFiles = c.dirty
    ? { "value.txt": USER_EDIT, "new ü.txt": "user untracked\n" }
    : { "value.txt": "three\n", "new ü.txt": null };
  const probe = `private probe ${randomUUID()}\n`;
  const gates = [
    verifyTreeGate(
      {
        ...userFiles,
        "stable.txt": "candidate edit\n",
        [CANDIDATE_FILE]: "candidate file\n",
        "moved.txt": c.moveHead ? "moved after the capture\n" : null,
      },
      probe,
    ),
    ...(c.failingGate
      ? [{ id: "fails", program: process.execPath, args: ["-e", "process.exit(9)"] }]
      : []),
  ];
  const before = targetState(w.target);
  const upstream = fingerprint(w.upstream);
  const delivered = await verifyAndDeliver(
    w.target,
    produced.delivery,
    { mode: c.mode ?? "apply", projectRoot: w.target, owner: produced.runDir },
    gates,
  );
  const store = objectStorePath(w.target);
  // INV-072: what the harness and the verifier wrote stays in their private clones.
  expect(holds(["-C", w.target], produced.harnessCommit)).toBe(false);
  const probeOid = git(w.target, ["hash-object", "--stdin"], probe);
  expect(holds(["-C", w.target], probeOid)).toBe(false);
  expect(holds(["--git-dir", store], probeOid)).toBe(false);
  expect(peek(w.target, ["for-each-ref", "refs/heads/claudexor"])).toBe("");
  expect(fingerprint(w.upstream)).toBe(upstream);
  for (const [file, text] of Object.entries(userFiles))
    expect(read(join(w.target, file))).toBe(text);
  return { w, produced, before, delivered };
}

// Real Git end to end: generous on a loaded machine, still a hang detector.
describe("verifyAndDeliver onto a shallow clone (#501)", { timeout: 120_000 }, () => {
  it("dirtied after the capture: verified on its snapshot, applied, and reverted on its pair", async () => {
    const { w, before, delivered } = await deliver({ shape: "shallow", dirty: "after" });
    expect(delivered.finalVerify).toMatchObject({ applied_cleanly: true, gates_passed: true });
    expect(delivered).toMatchObject({ applied: true, treeMutated: true });
    expect(read(join(w.target, "stable.txt"))).toBe("candidate edit\n");
    expect(read(join(w.target, CANDIDATE_FILE))).toBe("candidate file\n");
    expect(targetState(w.target)).toEqual(before);

    const anchor = await createPairRevertAnchor(w.target, delivered.deliveryPair!);
    expect((await revertInPlaceFromAnchor(w.target, anchor)).reverted).toBe(true);
    expect(read(join(w.target, "stable.txt"))).toBe("stable\n");
    expect(existsSync(join(w.target, CANDIDATE_FILE))).toBe(false);
    expect(read(join(w.target, "value.txt"))).toBe(USER_EDIT);
    expect(read(join(w.target, "new ü.txt"))).toBe("user untracked\n");
    expect(targetState(w.target)).toEqual(before);
  });

  it("dirty before the run began: a later snapshot of the same tree delivers too", async () => {
    const { w, produced, before, delivered } = await deliver({ shape: "shallow", dirty: "start" });
    expect(delivered.targetPreimageSha).not.toBe(produced.baseSha);
    expect(delivered.finalVerify).toMatchObject({ applied_cleanly: true, gates_passed: true });
    expect(delivered.applied).toBe(true);
    expect(read(join(w.target, CANDIDATE_FILE))).toBe("candidate file\n");
    expect(targetState(w.target)).toEqual(before);
  });

  it("clean, HEAD moved after the capture: apply verifies a composed tree only the target holds", async () => {
    const { w, before, delivered } = await deliver({ shape: "shallow", moveHead: true });
    expect(delivered.finalVerify).toMatchObject({ applied_cleanly: true, gates_passed: true });
    expect(delivered.applied).toBe(true);
    expect(read(join(w.target, "moved.txt"))).toBe("moved after the capture\n");
    expect(read(join(w.target, "stable.txt"))).toBe("candidate edit\n");
    expect(targetState(w.target)).toEqual(before);
  });

  it("clean, HEAD moved after the capture: commit lands on the moved HEAD", async () => {
    const { w, before, delivered } = await deliver({
      shape: "shallow",
      moveHead: true,
      mode: "commit",
    });
    expect(delivered.finalVerify).toMatchObject({ applied_cleanly: true, gates_passed: true });
    expect(delivered.applied).toBe(true);
    expect(git(w.target, ["rev-parse", "HEAD"])).toBe(delivered.commit);
    expect(git(w.target, ["rev-parse", "HEAD^"])).toBe(before.head);
    expect(git(w.target, ["show", "HEAD:stable.txt"])).toBe("candidate edit");
    expect(git(w.target, ["show", "HEAD:moved.txt"])).toBe("moved after the capture");
    expect(peek(w.target, ["status", "--porcelain=v1"])).toBe("");
  });

  it("a genuinely dirty target still refuses commit with its own reason, after a clean verify", async () => {
    const { w, before, delivered } = await deliver({
      shape: "shallow",
      dirty: "after",
      mode: "commit",
    });
    expect(delivered.finalVerify).toMatchObject({ applied_cleanly: true, gates_passed: true });
    expect(delivered.applied).toBe(false);
    expect(delivered.detail).toBe("working tree is dirty; refusing delivery mutation");
    expect(delivered.commit).toBeUndefined();
    expect(read(join(w.target, "stable.txt"))).toBe("stable\n");
    expect(targetState(w.target)).toEqual(before);
  });

  it("a gate that fails in the verify clone still blocks the write", async () => {
    const { w, before, delivered } = await deliver({
      shape: "shallow",
      dirty: "after",
      failingGate: true,
    });
    expect(delivered.finalVerify).toMatchObject({ applied_cleanly: true, gates_passed: false });
    expect(delivered).toMatchObject({ applied: false, refused: true, treeMutated: false });
    expect(read(join(w.target, "stable.txt"))).toBe("stable\n");
    expect(existsSync(join(w.target, CANDIDATE_FILE))).toBe(false);
    expect(targetState(w.target)).toEqual(before);
  });

  for (const shape of ["full", "linked-shallow"] as const)
    it(`${shape} target, dirtied after the capture, delivers the same way`, async () => {
      const { w, before, delivered } = await deliver({ shape, dirty: "after" });
      expect(delivered.finalVerify).toMatchObject({ applied_cleanly: true, gates_passed: true });
      expect(delivered.applied).toBe(true);
      expect(read(join(w.target, CANDIDATE_FILE))).toBe("candidate file\n");
      expect(targetState(w.target)).toEqual(before);
    });
});
