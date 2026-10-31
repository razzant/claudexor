import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceError } from "@claudexor/core";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  isolatedCloneAdd,
} from "@claudexor/workspace";
import { revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// #535 teardown: a revert that throws says only what it knows. A fault before the
// revert's write (reading the target) restored nothing; one thrown from inside the
// revert's own write may come after files were restored, so its receipt never says
// "nothing was restored". The fault is injected at the module boundary, after the
// real revert ran (or before the real snapshot), so the tree shows what happened.
let afterRevert: Error | null = null;
let beforeSnapshot: Error | null = null;
vi.mock("@claudexor/workspace", async (original) => {
  const actual = await original<typeof import("@claudexor/workspace")>();
  return {
    ...actual,
    revertDeliveryPair: async (...args: Parameters<typeof actual.revertDeliveryPair>) => {
      const reverted = await actual.revertDeliveryPair(...args);
      if (afterRevert) throw afterRevert;
      return reverted;
    },
    snapshotTree: async (...args: Parameters<typeof actual.snapshotTree>) => {
      if (beforeSnapshot) throw beforeSnapshot;
      return actual.snapshotTree(...args);
    },
  };
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  afterRevert = null;
  beforeSnapshot = null;
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-revert-fault-config-"));
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

/** An applied object delivery of a.txt "candidate" over "base", and its revert anchor. */
async function applied() {
  const repo = mkdtempSync(join(tmpdir(), "cx-revert-fault-"));
  const run = mkdtempSync(join(tmpdir(), "cx-revert-fault-run-"));
  dirs.push(repo, run);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  const clone = join(mkdtempSync(join(tmpdir(), "cx-revert-fault-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, ["rev-parse", "HEAD"]));
  writeFileSync(join(clone, "a.txt"), "candidate\n");
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  const delivered = await verifyAndDeliver(
    repo,
    { result: captured.result!, renderedPatch: captured.patch },
    { mode: "apply", owner: run },
  );
  expect(delivered.applied).toBe(true);
  return { repo, anchor: await createPairRevertAnchor(repo, delivered.deliveryPair!, repo) };
}

describe("a revert that throws claims only what it knows", () => {
  it("a fault thrown from inside the revert's write never says nothing was restored", async () => {
    const f = await applied();
    afterRevert = new WorkspaceError("injected fault after the revert's checkout");

    const reverted = await revertInPlaceFromAnchor(f.repo, f.anchor, f.repo);

    // The write did restore the file: the receipt must not deny it.
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("base\n");
    expect(reverted).toMatchObject({ reverted: false, reasonCode: "reverse_apply_failed" });
    expect(reverted.reason).not.toContain("nothing was restored");
    expect(reverted.reason).toContain("what it restored is unknown");
  });

  it("a fault before the revert's write still says nothing was restored", async () => {
    const f = await applied();
    beforeSnapshot = new WorkspaceError("injected fault reading the target");

    const reverted = await revertInPlaceFromAnchor(f.repo, f.anchor, f.repo);

    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("candidate\n");
    expect(reverted).toMatchObject({ reverted: false, reasonCode: "reverse_apply_failed" });
    expect(reverted.reason).toContain("the revert could not run, so nothing was restored");
  });
});
