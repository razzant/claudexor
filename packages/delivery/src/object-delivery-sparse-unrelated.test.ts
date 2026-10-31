import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  isolatedCloneAdd,
} from "@claudexor/workspace";
import {
  checkResultOnTarget,
  locateScanner,
  revertInPlaceFromAnchor,
  verifyAndDeliver,
} from "./index.js";

// #535 R5 S1: in a sparse checkout (cone or non-cone) Git's checkout reapplies the
// patterns to every entry, so a clean file outside them that holds no skip-worktree
// mark (a conflict resolved there, a file restored after narrowing) was deleted by a
// delivery or revert that never addressed it: `read-tree -m -u` in apply, revert and
// take-back and on the real index in branch, commit and pr, and the checkout back
// after a failed pr push (plain Git's `checkout -b` does it too). Apply answered
// applied:true and the revert reverted:true with the file gone. Only the paths an
// operation addresses may change; every other file, present, absent or dirty, stays
// as it was, and so do these files' index marks (none of them is a present file
// with a skip-worktree mark, which Git itself clears in a sparse checkout).
const dirs: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-sparse-unrelated-config-"));
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

// A sparse index also makes Git 2.53's own `checkout -b` reapply the patterns (Apple
// Git 2.50.1 does so with a plain index too).
const PATTERNS = {
  cone: ["--cone", "near"],
  "non-cone": ["--no-cone", "/near/", "/top.txt"],
  "sparse-index cone": ["--cone", "--sparse-index", "near"],
} as const;

/**
 * near/ inside the patterns, far/ outside. The result (made in a full clone) changes
 * near/n.txt and, when `filtered`, adds near/new.weird, which the target's checkout
 * filter does not round-trip; the target then narrows to near/.
 */
async function fixture(patterns: readonly string[], filtered = false) {
  const repo = mkdtempSync(join(tmpdir(), "cx-sparse-unrelated-"));
  const run = mkdtempSync(join(tmpdir(), "cx-sparse-unrelated-run-"));
  dirs.push(repo, run);
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "near"));
  mkdirSync(join(repo, "far"));
  writeFileSync(join(repo, "near/n.txt"), "n\n");
  for (const name of ["x", "y", "z"]) writeFileSync(join(repo, `far/${name}.txt`), `${name}\n`);
  writeFileSync(join(repo, "top.txt"), "t\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const clone = join(mkdtempSync(join(tmpdir(), "cx-sparse-unrelated-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
  writeFileSync(join(clone, "near/n.txt"), "n delivered\n");
  if (filtered) writeFileSync(join(clone, "near/new.weird"), "new\n");
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  expect(captured.captureIncomplete).toBe(false);
  const delivery = { result: captured.result!, renderedPatch: captured.patch };
  git(repo, "sparse-checkout", "set", ...patterns);
  return { repo, run, delivery };
}

/** far/x.txt back on disk without its skip-worktree mark, as Git leaves a conflict
 * resolved outside the patterns; with `dirty`, far/z.txt too, holding the user's edit. */
function restoreUnrelated(repo: string, dirty = false) {
  mkdirSync(join(repo, "far"), { recursive: true });
  writeFileSync(join(repo, "far/x.txt"), "x\n");
  git(repo, "update-index", "--no-skip-worktree", "far/x.txt");
  if (dirty) {
    writeFileSync(join(repo, "far/z.txt"), "the user's edit\n");
    git(repo, "update-index", "--no-skip-worktree", "far/z.txt");
  }
  git(repo, "update-index", "-q", "--refresh");
}

/** What must not move: the bytes and marks of every path outside near/. */
function unrelated(repo: string) {
  return {
    files: ["far/x.txt", "far/y.txt", "far/z.txt"].map((path) => [path, read(repo, path)]),
    marks: git(repo, "ls-files", "-t", "--", "far"),
  };
}

for (const [mode, patterns] of Object.entries(PATTERNS))
  describe(`a ${mode} sparse checkout with a clean unmarked file outside the patterns`, () => {
    for (const dirty of [false, true])
      it(`apply/check, apply and revert leave it${dirty ? ", and a dirty one," : ""} as it was`, async () => {
        const f = await fixture(patterns);
        restoreUnrelated(f.repo, dirty);
        const before = unrelated(f.repo);
        expect(before.marks).toContain("H far/x.txt");

        const checked = await checkResultOnTarget(f.repo, f.delivery.result, f.repo);
        expect(checked).toMatchObject({ ok: true });
        expect(unrelated(f.repo)).toEqual(before);

        const applied = await verifyAndDeliver(
          f.repo,
          f.delivery,
          { mode: "apply", projectRoot: f.repo, owner: f.run },
          [],
        );
        expect(applied).toMatchObject({ applied: true });
        expect(read(f.repo, "near/n.txt")).toBe("n delivered\n");
        expect(unrelated(f.repo)).toEqual(before);

        const anchor = await createPairRevertAnchor(f.repo, applied.deliveryPair!, f.repo);
        expect(await revertInPlaceFromAnchor(f.repo, anchor, f.repo)).toMatchObject({
          reverted: true,
        });
        expect(read(f.repo, "near/n.txt")).toBe("n\n");
        expect(unrelated(f.repo)).toEqual(before);
      });

    it("a revert leaves a file restored after the apply as it was", async () => {
      const f = await fixture(patterns);
      const applied = await verifyAndDeliver(
        f.repo,
        f.delivery,
        { mode: "apply", projectRoot: f.repo, owner: f.run },
        [],
      );
      expect(applied).toMatchObject({ applied: true });
      restoreUnrelated(f.repo);
      const before = unrelated(f.repo);

      const anchor = await createPairRevertAnchor(f.repo, applied.deliveryPair!, f.repo);
      expect(await revertInPlaceFromAnchor(f.repo, anchor, f.repo)).toMatchObject({
        reverted: true,
      });
      expect(read(f.repo, "near/n.txt")).toBe("n\n");
      expect(unrelated(f.repo)).toEqual(before);
    });

    it("a take-back leaves it as it was and says the target is unchanged", async () => {
      const f = await fixture(patterns, true);
      // A checkout filter that does not round-trip: near/new.weird fails its content proof.
      git(f.repo, "config", "filter.up.smudge", "tr a-z A-Z");
      git(f.repo, "config", "filter.up.clean", "cat");
      writeFileSync(join(f.repo, ".git/info/attributes"), "*.weird filter=up\n");
      restoreUnrelated(f.repo);
      const before = unrelated(f.repo);

      const delivered = await verifyAndDeliver(
        f.repo,
        f.delivery,
        { mode: "apply", projectRoot: f.repo, owner: f.run },
        [],
      );
      expect({
        applied: delivered.applied,
        treeMutated: delivered.treeMutated,
        code: delivered.refusal?.code,
        detail: delivered.detail,
      }).toMatchObject({
        applied: false,
        treeMutated: false,
        code: "delivery_content_mismatch",
        detail: expect.stringContaining("so the target is unchanged"),
      });
      expect(read(f.repo, "near/n.txt")).toBe("n\n");
      expect(read(f.repo, "near/new.weird")).toBeNull();
      expect(unrelated(f.repo)).toEqual(before);
    });

    for (const delivery of ["branch", "commit"] as const)
      it(`${delivery} commits the result and leaves it as it was`, async () => {
        const f = await fixture(patterns);
        restoreUnrelated(f.repo);
        const before = unrelated(f.repo);

        const delivered = await verifyAndDeliver(
          f.repo,
          f.delivery,
          { mode: delivery, message: "deliver", projectRoot: f.repo, owner: f.run },
          [],
        );
        expect(delivered).toMatchObject({ applied: true });
        expect(git(f.repo, "show", `${delivered.commit}:near/n.txt`)).toBe("n delivered");
        expect(git(f.repo, "show", `${delivered.commit}:far/x.txt`)).toBe("x");
        expect(read(f.repo, "near/n.txt")).toBe("n delivered\n");
        expect(unrelated(f.repo)).toEqual(before);
        expect(git(f.repo, "status", "--porcelain")).toBe("");
      });

    it("a commit's take-back leaves it, and every mark of the live index, as they were", async () => {
      const f = await fixture(patterns, true);
      git(f.repo, "config", "filter.up.smudge", "tr a-z A-Z");
      git(f.repo, "config", "filter.up.clean", "cat");
      writeFileSync(join(f.repo, ".git/info/attributes"), "*.weird filter=up\n");
      restoreUnrelated(f.repo);
      const before = unrelated(f.repo);
      const head = git(f.repo, "rev-parse", "HEAD");

      const delivered = await verifyAndDeliver(
        f.repo,
        f.delivery,
        { mode: "commit", message: "deliver", projectRoot: f.repo, owner: f.run },
        [],
      );
      expect({
        applied: delivered.applied,
        treeMutated: delivered.treeMutated,
        code: delivered.refusal?.code,
        detail: delivered.detail,
      }).toMatchObject({
        applied: false,
        treeMutated: false,
        code: "delivery_content_mismatch",
        detail: expect.stringContaining("so the target is unchanged"),
      });
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(head);
      expect(read(f.repo, "near/n.txt")).toBe("n\n");
      expect(read(f.repo, "near/new.weird")).toBeNull();
      expect(unrelated(f.repo)).toEqual(before);
      expect(git(f.repo, "status", "--porcelain")).toBe("");
    });

    // `pr` only past a clean publication scan (#555): the pinned scanner and a local
    // origin that refuses the push, so nothing leaves the machine.
    it.runIf(locateScanner({ env: process.env, configDir: null }).ok)(
      "pr through its push and the way back leaves it as it was",
      async () => {
        const f = await fixture(patterns);
        const remote = mkdtempSync(join(tmpdir(), "cx-sparse-unrelated-origin-"));
        dirs.push(remote);
        git(remote, "init", "-q", "--bare");
        git(f.repo, "remote", "add", "origin", remote);
        git(f.repo, "push", "-q", "origin", "main");
        writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n");
        chmodSync(join(remote, "hooks", "pre-receive"), 0o755);
        restoreUnrelated(f.repo);
        const before = unrelated(f.repo);

        const delivered = await verifyAndDeliver(
          f.repo,
          f.delivery,
          { mode: "pr", message: "deliver", projectRoot: f.repo, owner: f.run },
          [],
        );
        expect(delivered).toMatchObject({ applied: false, treeMutated: false });
        expect(delivered.detail).toContain("push failed");
        expect(git(f.repo, "show", `${delivered.commit}:near/n.txt`)).toBe("n delivered");
        expect(git(f.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
        expect(read(f.repo, "near/n.txt")).toBe("n\n");
        expect(unrelated(f.repo)).toEqual(before);
      },
    );
  });
