import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  GitOperationError,
  isolatedCloneAdd,
} from "@claudexor/workspace";
import { revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// #535 repair r1 (F7): the delivery pair (T, M) must be in the project store
// before the target is mutated, and a replay of an already-applied delivery
// must hand back that pair. A fault in the store transfer (no space, a killed
// Git child, the prune-lock wait) is injected at the store import.
let retainFault: Error | null = null;
// The same kind of fault earlier on the path: the import, the snapshot, the composition.
let importFault: Error | null = null;
let snapshotFault: Error | null = null;
let composeFault: Error | null = null;
vi.mock("@claudexor/workspace", async (original) => {
  const actual = await original<typeof import("@claudexor/workspace")>();
  return {
    ...actual,
    retainInObjectStore: async (...args: Parameters<typeof actual.retainInObjectStore>) => {
      if (retainFault) throw retainFault;
      return actual.retainInObjectStore(...args);
    },
    importIntoRepository: async (...args: Parameters<typeof actual.importIntoRepository>) => {
      if (importFault) throw importFault;
      return actual.importIntoRepository(...args);
    },
    snapshotTree: async (...args: Parameters<typeof actual.snapshotTree>) => {
      if (snapshotFault) throw snapshotFault;
      return actual.snapshotTree(...args);
    },
    composeOnTarget: async (...args: Parameters<typeof actual.composeOnTarget>) => {
      if (composeFault) throw composeFault;
      return actual.composeOnTarget(...args);
    },
  };
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  retainFault = null;
  importFault = null;
  snapshotFault = null;
  composeFault = null;
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-delivery-pair-config-"));
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

/** A user repo, a run directory owning the delivery, and a captured object result. */
async function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "cx-delivery-pair-"));
  const run = mkdtempSync(join(tmpdir(), "cx-delivery-pair-run-"));
  dirs.push(repo, run);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  const clone = join(mkdtempSync(join(tmpdir(), "cx-delivery-pair-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, ["rev-parse", "HEAD"]));
  writeFileSync(join(clone, "a.txt"), "candidate\n");
  writeFileSync(join(clone, "new.txt"), "new\n");
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  expect(captured.captureIncomplete).toBe(false);
  return { repo, run, result: captured.result!, renderedPatch: captured.patch };
}

const noSpace = () =>
  new GitOperationError("capture_space_insufficient", "object copy needs more space than is free");

describe("delivery pair custody precedes mutation (F7)", () => {
  it("apply: a store fault refuses before any file is written", async () => {
    const f = await fixture();
    const head = git(f.repo, ["rev-parse", "HEAD"]);
    retainFault = noSpace();
    const outcome = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run }).catch(
      (error: unknown) => error,
    );
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("base\n");
    expect(existsSync(join(f.repo, "new.txt"))).toBe(false);
    expect(git(f.repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(outcome).toMatchObject({
      applied: false,
      refused: true,
      treeMutated: false,
      refusal: { code: "space_insufficient" },
    });
  });

  it("commit: a store fault refuses before the commit or any ref is written", async () => {
    const f = await fixture();
    const head = git(f.repo, ["rev-parse", "HEAD"]);
    retainFault = noSpace();
    const outcome = await verifyAndDeliver(f.repo, f, { mode: "commit", owner: f.run }).catch(
      (error: unknown) => error,
    );
    expect(git(f.repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(f.repo, ["status", "--porcelain"])).toBe("");
    expect(outcome).toMatchObject({ applied: false, refused: true, treeMutated: false });
  });

  it.each([
    ["the import", () => (importFault = noSpace())],
    ["the composition", () => (composeFault = noSpace())],
    ["the snapshot", () => (snapshotFault = noSpace())],
  ] as const)("a store fault in %s refuses typed with nothing written", async (_where, arm) => {
    const f = await fixture();
    const head = git(f.repo, ["rev-parse", "HEAD"]);
    arm();

    const delivered = await verifyAndDeliver(
      f.repo,
      { result: f.result, renderedPatch: f.renderedPatch },
      { mode: "apply", projectRoot: f.repo, owner: f.run },
      [],
    );

    expect(delivered).toMatchObject({
      applied: false,
      refused: true,
      treeMutated: false,
      refusal: { code: "space_insufficient" },
    });
    expect(git(f.repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("base\n");
    expect(existsSync(join(f.repo, "new.txt"))).toBe(false);
  });

  it("a revert whose import faults answers typed, nothing changed", async () => {
    const f = await fixture();
    const delivered = await verifyAndDeliver(
      f.repo,
      { result: f.result, renderedPatch: f.renderedPatch },
      { mode: "apply", projectRoot: f.repo, owner: f.run },
      [],
    );
    expect(delivered.applied).toBe(true);
    const anchor = await createPairRevertAnchor(f.repo, delivered.deliveryPair!, f.repo);
    importFault = noSpace();

    const reverted = await revertInPlaceFromAnchor(f.repo, anchor, f.repo);

    expect(reverted).toMatchObject({
      reverted: false,
      refusal: { code: "space_insufficient" },
    });
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("candidate\n");
  });

  it("a replay of an applied delivery returns its retained pair, so revert stays available", async () => {
    const f = await fixture();
    const first = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
    expect(first).toMatchObject({ applied: true, treeMutated: true });
    expect(first.deliveryPair).toBeDefined();
    // The caller died before it recorded the delivery; the replay finds the tree applied.
    const replay = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
    expect(replay).toMatchObject({ applied: true, alreadyApplied: true, treeMutated: false });
    expect(replay.deliveryPair).toEqual(first.deliveryPair);
    const anchor = await createPairRevertAnchor(f.repo, replay.deliveryPair!);
    expect((await revertInPlaceFromAnchor(f.repo, anchor)).reverted).toBe(true);
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("base\n");
    expect(existsSync(join(f.repo, "new.txt"))).toBe(false);
  });
});
