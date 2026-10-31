import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  isolatedCloneAdd,
  objectStorePath,
  snapshotTree,
} from "@claudexor/workspace";
import { revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// #535 R5 M1: a file the user marked skip-worktree reads as unchanged to Git, also
// when it is gone. The snapshot's clean check kept that mark on an absent file, so a
// clean worktree's snapshot held HEAD's blob where a dirty one's `add -A` recorded the
// deletion. A revert of a delivered deletion therefore answered reverted:true with the
// file still gone; a revert after the user deleted a delivered modification called it
// already done; a delivery recreated a file the user had deleted; an in-place turn
// reported a deletion its agent never made. Commit-class delivery trusted `git status`,
// which marks blind, then committed what they hid or failed "not uptodate". A
// skip-worktree file outside the sparse-checkout patterns is meant to be absent and
// stays as HEAD has it.
const dirs: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-marks-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
});
afterEach(() => {
  if (configDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: ENV })
    .toString("utf8")
    .trim();
const read = (repo: string, path: string) =>
  existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf8") : null;
const showOrNull = (repo: string, spec: string) => {
  try {
    return git(repo, "show", spec);
  } catch {
    return null;
  }
};
/** An answer's fields that say what happened, so a failure shows them. */
const brief = (answer: {
  applied?: boolean;
  reverted?: boolean;
  treeMutated?: boolean;
  refusal?: { code: string };
  detail?: string;
  reason?: string;
}) => ({
  applied: answer.applied,
  reverted: answer.reverted,
  treeMutated: answer.treeMutated,
  code: answer.refusal?.code,
  detail: answer.detail ?? answer.reason,
});

/** near/f.txt is the marked file, near/a.txt and far/x.txt are ordinary; `edit` makes
 * the result in a full clone. With `sparse`, the target is a cone of near/. */
async function fixture(edit: (clone: string) => void, sparse = false) {
  const repo = mkdtempSync(join(tmpdir(), "cx-marks-"));
  const run = mkdtempSync(join(tmpdir(), "cx-marks-run-"));
  dirs.push(repo, run);
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "near"));
  mkdirSync(join(repo, "far"));
  writeFileSync(join(repo, "near/f.txt"), "f\n");
  writeFileSync(join(repo, "near/a.txt"), "a\n");
  writeFileSync(join(repo, "far/x.txt"), "x\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const clone = join(mkdtempSync(join(tmpdir(), "cx-marks-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
  edit(clone);
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  expect(captured.captureIncomplete).toBe(false);
  const delivery = { result: captured.result!, renderedPatch: captured.patch };
  if (sparse) git(repo, "sparse-checkout", "set", "--cone", "near");
  return {
    repo,
    run,
    delivery,
    deliver: (mode: "apply" | "commit" | "branch") =>
      verifyAndDeliver(
        repo,
        delivery,
        { mode, message: "deliver", projectRoot: repo, owner: run },
        [],
      ),
    revert: async (pair: Parameters<typeof createPairRevertAnchor>[1]) =>
      revertInPlaceFromAnchor(repo, await createPairRevertAnchor(repo, pair, repo), repo),
  };
}

const deleteF = (clone: string) => rmSync(join(clone, "near/f.txt"));
const editF = (clone: string) => writeFileSync(join(clone, "near/f.txt"), "f delivered\n");
const editA = (clone: string) => writeFileSync(join(clone, "near/a.txt"), "a delivered\n");

for (const sparse of [false, true])
  describe(`a file the user marked skip-worktree${sparse ? " inside a cone" : ""}`, () => {
    it("a revert brings back what the delivery deleted, mark and all", async () => {
      const f = await fixture(deleteF, sparse);
      git(f.repo, "update-index", "--skip-worktree", "near/f.txt");
      // A sparse checkout reads a present file's mark as cleared; the index keeps it.
      const mark = git(f.repo, "ls-files", "-t", "near/f.txt");
      const applied = await f.deliver("apply");
      expect(applied).toMatchObject({ applied: true });
      expect(read(f.repo, "near/f.txt")).toBeNull();

      expect(await f.revert(applied.deliveryPair!)).toMatchObject({ reverted: true });
      expect(read(f.repo, "near/f.txt")).toBe("f\n");
      expect(git(f.repo, "ls-files", "-t", "near/f.txt")).toBe(mark);
    });

    it("a revert refuses, keeping the user's deletion of what the delivery changed", async () => {
      const f = await fixture(editF, sparse);
      git(f.repo, "update-index", "--skip-worktree", "near/f.txt");
      const applied = await f.deliver("apply");
      expect(applied).toMatchObject({ applied: true });
      expect(read(f.repo, "near/f.txt")).toBe("f delivered\n");
      rmSync(join(f.repo, "near/f.txt"));

      expect(brief(await f.revert(applied.deliveryPair!))).toMatchObject({
        reverted: false,
        code: "revert_conflict",
      });
      expect(read(f.repo, "near/f.txt")).toBeNull();
    });

    it("a delivery that changes it after the user deleted it refuses, writing nothing", async () => {
      const f = await fixture((clone) => (editF(clone), editA(clone)), sparse);
      git(f.repo, "update-index", "--skip-worktree", "near/f.txt");
      rmSync(join(f.repo, "near/f.txt"));

      const applied = await f.deliver("apply");
      expect(brief(applied)).toMatchObject({
        applied: false,
        treeMutated: false,
        code: "delivery_conflict",
      });
      expect(read(f.repo, "near/f.txt")).toBeNull();
      expect(read(f.repo, "near/a.txt")).toBe("a\n");
    });

    it("a delivery and revert elsewhere leave its deletion and mark alone", async () => {
      const f = await fixture(editA, sparse);
      git(f.repo, "update-index", "--skip-worktree", "near/f.txt");
      rmSync(join(f.repo, "near/f.txt"));
      const applied = await f.deliver("apply");
      expect(applied).toMatchObject({ applied: true });
      expect(read(f.repo, "near/a.txt")).toBe("a delivered\n");
      expect(await f.revert(applied.deliveryPair!)).toMatchObject({ reverted: true });
      expect(read(f.repo, "near/a.txt")).toBe("a\n");
      expect(read(f.repo, "near/f.txt")).toBeNull();
      expect(git(f.repo, "ls-files", "-t", "near/f.txt")).toBe("S near/f.txt");
    });

    it("a revert of a modification it delivered restores the user's bytes (the control)", async () => {
      const f = await fixture(editF, sparse);
      git(f.repo, "update-index", "--skip-worktree", "near/f.txt");
      const mark = git(f.repo, "ls-files", "-t", "near/f.txt");
      const applied = await f.deliver("apply");
      expect(applied).toMatchObject({ applied: true });
      expect(await f.revert(applied.deliveryPair!)).toMatchObject({ reverted: true });
      expect(read(f.repo, "near/f.txt")).toBe("f\n");
      expect(git(f.repo, "ls-files", "-t", "near/f.txt")).toBe(mark);
    });
  });

describe("the snapshot of a worktree whose marked file is gone", () => {
  it("records the deletion whether or not anything else is dirty", async () => {
    const f = await fixture(editA);
    git(f.repo, "update-index", "--skip-worktree", "near/f.txt");
    rmSync(join(f.repo, "near/f.txt"));
    const clean = await snapshotTree(f.repo);
    expect(showOrNull(f.repo, `${clean}:near/f.txt`)).toBeNull();

    writeFileSync(join(f.repo, "far/x.txt"), "x edited\n");
    const dirty = await snapshotTree(f.repo);
    expect(showOrNull(f.repo, `${dirty}:near/f.txt`)).toBeNull();
    expect(git(f.repo, "diff-tree", "-r", "--name-only", clean, dirty)).toBe("far/x.txt");
  });

  it("an in-place turn does not report a deletion its agent never made", async () => {
    const f = await fixture(editA);
    git(f.repo, "update-index", "--skip-worktree", "near/f.txt");
    rmSync(join(f.repo, "near/f.txt"));
    const base = await snapshotTree(f.repo);
    writeFileSync(join(f.repo, "near/a.txt"), "the agent's edit\n");

    const turn = await captureWorkingTreeTransient(f.repo, base, [], {
      projectRoot: f.repo,
      owner: f.run,
    });
    const changed = execFileSync(
      "git",
      [
        "-C",
        f.repo,
        "diff-tree",
        "-r",
        "--name-status",
        turn.result!.base_tree,
        turn.result!.candidate_tree,
      ],
      // The capture's objects are in the project store, not the repository.
      {
        env: { ...ENV, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(objectStorePath(f.repo), "objects") },
      },
    );
    expect(changed.toString("utf8").trim()).toBe("M\tnear/a.txt");
  });

  it("keeps a sparse checkout's excluded files as HEAD has them (the control)", async () => {
    const f = await fixture(editA, true);
    expect(git(f.repo, "ls-files", "-t", "far/x.txt")).toBe("S far/x.txt");
    expect(await snapshotTree(f.repo)).toBe(git(f.repo, "rev-parse", "HEAD"));
    writeFileSync(join(f.repo, "near/a.txt"), "dirty\n");
    const dirty = await snapshotTree(f.repo);
    expect(showOrNull(f.repo, `${dirty}:far/x.txt`)).toBe("x");
  });
});

describe("commit-class delivery over files the user's marks hide", () => {
  for (const [mark, flag] of [
    ["assume-unchanged", "--assume-unchanged"],
    ["skip-worktree", "--skip-worktree"],
  ] as const) {
    it(`commits the result onto HEAD, keeping a hidden ${mark} edit out of it and on disk`, async () => {
      const f = await fixture(editA);
      git(f.repo, "update-index", flag, "far/x.txt");
      writeFileSync(join(f.repo, "far/x.txt"), "the user's local setting\n");
      const marks = git(f.repo, "ls-files", "-v");

      const committed = await f.deliver("commit");
      expect(brief(committed)).toMatchObject({ applied: true });
      expect(showOrNull(f.repo, `${committed.commit}:near/a.txt`)).toBe("a delivered");
      expect(showOrNull(f.repo, `${committed.commit}:far/x.txt`)).toBe("x");
      expect(read(f.repo, "far/x.txt")).toBe("the user's local setting\n");
      expect(git(f.repo, "ls-files", "-v")).toBe(marks);
    });

    it(`never commits the local deletion of a ${mark} file`, async () => {
      const f = await fixture(editA);
      git(f.repo, "update-index", flag, "far/x.txt");
      rmSync(join(f.repo, "far/x.txt"));

      const committed = await f.deliver("branch");
      expect(brief(committed)).toMatchObject({ applied: true });
      expect(showOrNull(f.repo, `${committed.commit}:far/x.txt`)).toBe("x");
      expect(showOrNull(f.repo, `${committed.commit}:near/a.txt`)).toBe("a delivered");
      expect(read(f.repo, "far/x.txt")).toBeNull();
    });

    it(`refuses a result that changes a ${mark} file the user deleted, writing nothing`, async () => {
      const f = await fixture(editF);
      git(f.repo, "update-index", flag, "near/f.txt");
      rmSync(join(f.repo, "near/f.txt"));
      const head = git(f.repo, "rev-parse", "HEAD");

      const committed = await f.deliver("commit");
      expect(brief(committed)).toMatchObject({ applied: false, treeMutated: false });
      expect(read(f.repo, "near/f.txt")).toBeNull();
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(head);
    });
  }
});
