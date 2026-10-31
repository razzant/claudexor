import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureWorkingTreeTransient, isolatedCloneAdd } from "@claudexor/workspace";
import { deliver, locateScanner, revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// INV-114: `not_applied` means the tree is unchanged. A delivery that wrote the
// target and then failed takes the write back from its retained pair, under the
// revert's own law (a later user edit is kept, an overlap refuses), and only a
// write it could not take back stays, reported honestly. Every fault here is
// real: a filter that does not round-trip, a directory Git cannot write to, a
// remote that does not exist. `afterWrite` lands a user's edit right after the
// write, the one moment a test cannot reach from outside.
let afterWrite: { repo: string; edit: () => void } | null = null;
// The same moment on the legacy path, right before or after its apply.
let aroundLegacyApply: { before?: () => void; after?: () => void } | null = null;
vi.mock("@claudexor/workspace", async (original) => {
  const actual = await original<typeof import("@claudexor/workspace")>();
  return {
    ...actual,
    materializeTree: async (...args: Parameters<typeof actual.materializeTree>) => {
      const written = await actual.materializeTree(...args);
      // Final verification writes its private clone through the same owner.
      if (afterWrite && realpathSync(args[0].worktree) === realpathSync(afterWrite.repo)) {
        const { edit } = afterWrite;
        afterWrite = null;
        edit();
      }
      return written;
    },
    applyPatchAndIndexProtected: async (
      ...args: Parameters<typeof actual.applyPatchAndIndexProtected>
    ) => {
      const hook = aroundLegacyApply;
      aroundLegacyApply = null;
      hook?.before?.();
      const applied = await actual.applyPatchAndIndexProtected(...args);
      hook?.after?.();
      return applied;
    },
  };
});

const dirs: string[] = [];
const locked: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  afterWrite = null;
  aroundLegacyApply = null;
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-restore-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
});
afterEach(() => {
  if (configDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
  for (const path of locked.splice(0)) if (existsSync(path)) chmodSync(path, 0o755);
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
const lines = (edit: Record<number, string> = {}) =>
  Array.from({ length: 30 }, (_, i) => `${edit[i + 1] ?? `line ${i + 1}`}\n`).join("");

/** A repository, a run directory, and a result captured from a clone without the
 * target's config; `base` adds files to the base commit. */
async function fixture(
  write: (tree: string) => void,
  setup?: (repo: string) => void,
  base?: (repo: string) => void,
) {
  const repo = mkdtempSync(join(tmpdir(), "cx-restore-"));
  const run = mkdtempSync(join(tmpdir(), "cx-restore-run-"));
  dirs.push(repo, run);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), lines());
  writeFileSync(join(repo, "keep.txt"), "keep\n");
  mkdirSync(join(repo, "z"));
  writeFileSync(join(repo, "z", "old.txt"), "old\n");
  writeFileSync(join(repo, ".gitattributes"), "*.weird filter=up\n");
  base?.(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const clone = join(mkdtempSync(join(tmpdir(), "cx-restore-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
  write(clone);
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  expect(captured.captureIncomplete).toBe(false);
  setup?.(repo);
  return { repo, run, result: captured.result!, renderedPatch: captured.patch };
}

/** The target's own filter does not round-trip: checkout writes bytes whose clean hash is not the blob. */
function nonRoundTripFilter(repo: string) {
  git(repo, "config", "filter.up.clean", "tr a-z A-Z");
  git(repo, "config", "filter.up.smudge", "cat");
}

const candidate = (tree: string) => {
  writeFileSync(join(tree, "a.txt"), lines({ 10: "candidate" }));
  writeFileSync(join(tree, "new.weird"), "lower bytes\n");
};

const TAKEN_BACK = "the write was taken back, so the target is unchanged";
const executable = (path: string) => (statSync(path).mode & 0o111) !== 0;
/** A base file as a long-lived checkout holds it: its index stat is not racy, so
 * `git status` trusts it instead of re-hashing it through today's filters. */
const settled = (repo: string, path: string, bytes: string) => {
  writeFileSync(join(repo, path), bytes);
  utimesSync(join(repo, path), new Date("2020-01-01"), new Date("2020-01-01"));
};

const preimage = (repo: string) => ({
  a: readFileSync(join(repo, "a.txt"), "utf8"),
  keep: readFileSync(join(repo, "keep.txt"), "utf8"),
  status: git(repo, "status", "--porcelain"),
  staged: git(repo, "diff", "--cached", "--name-only"),
  head: git(repo, "rev-parse", "HEAD"),
  branches: git(repo, "branch", "--list"),
  current: git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
});

describe("a delivery that fails after writing leaves the tree unchanged (INV-114)", () => {
  it.each(["apply", "commit", "branch"] as const)(
    "%s: a failed content proof restores the preimage, byte-identical, and says so",
    async (mode) => {
      const f = await fixture(candidate, nonRoundTripFilter);
      const before = preimage(f.repo);
      const delivered = await verifyAndDeliver(f.repo, f, { mode, owner: f.run });
      expect(delivered).toMatchObject({
        applied: false,
        refused: true,
        treeMutated: false,
        refusal: { code: "delivery_content_mismatch" },
      });
      expect(delivered.deliveryPair).toBeUndefined();
      expect(delivered.refusal?.paths).toEqual(["new.weird"]);
      expect(delivered.detail).toContain(TAKEN_BACK);
      expect(preimage(f.repo)).toEqual(before);
      expect(existsSync(join(f.repo, "new.weird"))).toBe(false);
    },
  );

  it("a user's later edit outside the delivery is kept while the write is taken back", async () => {
    const f = await fixture(candidate, nonRoundTripFilter);
    const a = readFileSync(join(f.repo, "a.txt"), "utf8");
    afterWrite = {
      repo: f.repo,
      edit: () => writeFileSync(join(f.repo, "keep.txt"), "user edit\n"),
    };
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
    expect(delivered).toMatchObject({ applied: false, treeMutated: false });
    expect(delivered.deliveryPair).toBeUndefined();
    expect(delivered.detail).toContain(TAKEN_BACK);
    expect(readFileSync(join(f.repo, "keep.txt"), "utf8")).toBe("user edit\n");
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(a);
    expect(existsSync(join(f.repo, "new.weird"))).toBe(false);
  });

  it("a user's later edit overlapping the delivery stops the restore: honest treeMutated, nothing overwritten", async () => {
    const f = await fixture(candidate, nonRoundTripFilter);
    const userBytes = lines({ 10: "the user wrote this line" });
    afterWrite = { repo: f.repo, edit: () => writeFileSync(join(f.repo, "a.txt"), userBytes) };
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
    expect(delivered).toMatchObject({
      applied: false,
      refused: true,
      treeMutated: true,
      refusal: { code: "delivery_content_mismatch" },
    });
    expect(delivered.detail).toContain("revert refused");
    expect(delivered.detail).toContain("RECOVERY REQUIRED");
    // The revert handle stays available for the write that remains.
    expect(delivered.deliveryPair).toBeDefined();
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(userBytes);
  });

  it("a user's edit of the very path that failed its proof is never taken for the delivery's write", async () => {
    const f = await fixture(candidate, nonRoundTripFilter);
    afterWrite = {
      repo: f.repo,
      edit: () => writeFileSync(join(f.repo, "new.weird"), "user rewrote this\n"),
    };
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
    expect(delivered).toMatchObject({ applied: false, refused: true, treeMutated: true });
    // The restore ran and refused the overlap (a restore that never ran says neither).
    expect(delivered.detail).toContain("revert refused");
    expect(delivered.detail).toContain("RECOVERY REQUIRED");
    expect(delivered.deliveryPair).toBeDefined();
    expect(readFileSync(join(f.repo, "new.weird"), "utf8")).toBe("user rewrote this\n");
  });

  it.skipIf(process.platform === "win32")(
    "a user's chmod of the very path that failed its proof is never taken for the delivery's write",
    async () => {
      const f = await fixture(candidate, nonRoundTripFilter);
      afterWrite = { repo: f.repo, edit: () => chmodSync(join(f.repo, "new.weird"), 0o755) };
      const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
      expect(delivered).toMatchObject({ applied: false, refused: true, treeMutated: true });
      expect(delivered.detail).toContain("revert refused");
      expect(delivered.deliveryPair).toBeDefined();
      expect(executable(join(f.repo, "new.weird"))).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "a user's chmod of an existing file whose write failed its proof is kept, not reverted away",
    async () => {
      // T's bytes are clean-stable under the filter; the candidate's are not.
      const f = await fixture(
        (tree) => writeFileSync(join(tree, "old.weird"), "lower now\n"),
        nonRoundTripFilter,
        (repo) => writeFileSync(join(repo, "old.weird"), "UPPER\n"),
      );
      afterWrite = { repo: f.repo, edit: () => chmodSync(join(f.repo, "old.weird"), 0o755) };
      const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
      expect(delivered).toMatchObject({ applied: false, refused: true, treeMutated: true });
      expect(delivered.detail).toContain("RECOVERY REQUIRED");
      expect(executable(join(f.repo, "old.weird"))).toBe(true);
      expect(readFileSync(join(f.repo, "old.weird"), "utf8")).toBe("lower now\n");
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a checkout that stops partway is not called unchanged: it is taken back and typed",
    async () => {
      const f = await fixture((tree) => {
        writeFileSync(join(tree, "a.txt"), lines({ 10: "candidate" }));
        writeFileSync(join(tree, "z", "new.txt"), "cannot land\n");
      });
      const before = preimage(f.repo);
      // Git writes a.txt first, then cannot create z/new.txt.
      chmodSync(join(f.repo, "z"), 0o555);
      locked.push(join(f.repo, "z"));
      const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
      expect(delivered).toMatchObject({
        applied: false,
        refused: true,
        treeMutated: false,
        refusal: { code: "git_failed" },
      });
      expect(delivered.detail).toContain("the checkout stopped partway");
      expect(delivered.detail).toContain(TAKEN_BACK);
      expect(delivered.deliveryPair).toBeUndefined();
      expect(preimage(f.repo)).toEqual(before);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a partial checkout whose failing path is named like a refusal is still measured as written",
    async () => {
      const f = await fixture((tree) => {
        writeFileSync(join(tree, "a.txt"), lines({ 10: "candidate" }));
        writeFileSync(join(tree, "z", "index.lock.txt"), "cannot land\n");
      });
      const before = preimage(f.repo);
      // Git writes a.txt, then cannot create z/index.lock.txt: its message names index.lock.
      chmodSync(join(f.repo, "z"), 0o555);
      locked.push(join(f.repo, "z"));
      const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
      expect(preimage(f.repo)).toEqual(before);
      expect(delivered).toMatchObject({
        applied: false,
        refused: true,
        treeMutated: false,
        refusal: { code: "git_failed" },
      });
      expect(delivered.detail).toContain("index.lock.txt");
      expect(delivered.detail).toContain("the checkout stopped partway");
      expect(delivered.detail).toContain(TAKEN_BACK);
    },
  );

  it("a proof that cannot run is a typed result, never an escaped throw over a changed tree", async () => {
    const f = await fixture(candidate, (repo) => {
      git(repo, "config", "filter.up.clean", "exit 1");
      git(repo, "config", "filter.up.smudge", "cat");
      git(repo, "config", "filter.up.required", "true");
    });
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
    // The same filter also stops the restore's snapshot: the write stays, said honestly.
    expect(delivered).toMatchObject({
      applied: false,
      refused: true,
      treeMutated: true,
      refusal: { code: "git_failed" },
    });
    expect(delivered.detail).toContain("the written paths could not be proven");
    expect(delivered.detail).toContain("RECOVERY REQUIRED");
    expect(delivered.deliveryPair).toBeDefined();
  });

  it("a proof that could not run is taken back on every path it left unproven", async () => {
    // The filter fails once, during the proof, then works but does not round-trip:
    // the take-back reaches the revert, which needs the unproven paths as written.
    const f = await fixture(candidate, (repo) => {
      const clean = join(mkdtempSync(join(tmpdir(), "cx-restore-filter-")), "clean.sh");
      dirs.push(join(clean, ".."));
      writeFileSync(
        clean,
        `#!/bin/sh\nif [ -e "${clean}.ran" ]; then exec tr a-z A-Z; fi\n: > "${clean}.ran"\nexit 1\n`,
      );
      chmodSync(clean, 0o755);
      git(repo, "config", "filter.up.clean", clean);
      git(repo, "config", "filter.up.smudge", "cat");
      git(repo, "config", "filter.up.required", "true");
    });
    const before = preimage(f.repo);
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
    expect(delivered).toMatchObject({
      applied: false,
      refused: true,
      treeMutated: false,
      refusal: { code: "git_failed" },
    });
    expect(delivered.detail).toContain("the written paths could not be proven");
    expect(delivered.detail).toContain(TAKEN_BACK);
    expect(preimage(f.repo)).toEqual(before);
    expect(existsSync(join(f.repo, "new.weird"))).toBe(false);
  });

  it("commit: an overlap keeps the user's bytes and reports the mutation", async () => {
    const f = await fixture(candidate, nonRoundTripFilter);
    const head = git(f.repo, "rev-parse", "HEAD");
    const userBytes = lines({ 10: "the user wrote this line" });
    afterWrite = { repo: f.repo, edit: () => writeFileSync(join(f.repo, "a.txt"), userBytes) };
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "commit", owner: f.run });
    expect(delivered).toMatchObject({
      applied: false,
      refused: true,
      treeMutated: true,
      refusal: { code: "delivery_content_mismatch" },
    });
    expect(delivered.detail).toContain("RECOVERY REQUIRED");
    expect(delivered.deliveryPair).toBeDefined();
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(userBytes);
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(head);
  });

  // `pr` reaches its push only after a clean publication scan (#555): these use
  // the pinned scanner and an origin that has the base but refuses the push.
  const pinned = locateScanner({ env: process.env, configDir: null });
  const refusingOrigin = (repo: string) => {
    const remote = mkdtempSync(join(tmpdir(), "cx-restore-origin-"));
    dirs.push(remote);
    git(remote, "init", "-q", "--bare");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "main");
    writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(remote, "hooks", "pre-receive"), 0o755);
  };

  it.runIf(pinned.ok)(
    "pr: a failed push returns the tree to its branch and keeps the commit on the local branch",
    async () => {
      const f = await fixture((tree) => writeFileSync(join(tree, "a.txt"), lines({ 10: "pr" })));
      refusingOrigin(f.repo);
      const a = readFileSync(join(f.repo, "a.txt"), "utf8");
      const delivered = await verifyAndDeliver(f.repo, f, { mode: "pr", owner: f.run });
      expect(delivered).toMatchObject({ applied: false, treeMutated: false });
      expect(delivered.deliveryPair).toBeUndefined();
      expect(delivered.detail).toContain("push failed");
      expect(git(f.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(a);
      expect(git(f.repo, "status", "--porcelain")).toBe("");
      // Nothing is lost: the branch still holds the commit for a later push.
      expect(git(f.repo, "rev-parse", delivered.branch!)).toBe(delivered.commit);
      expect(git(f.repo, "show", `${delivered.commit}:a.txt`)).toContain("pr");
    },
  );

  it.runIf(pinned.ok)(
    "pr: a failed push from a detached HEAD returns the tree to that commit, still detached",
    async () => {
      const f = await fixture((tree) => writeFileSync(join(tree, "a.txt"), lines({ 10: "pr" })));
      refusingOrigin(f.repo);
      const head = git(f.repo, "rev-parse", "HEAD");
      git(f.repo, "checkout", "-q", "--detach", head);
      const delivered = await verifyAndDeliver(f.repo, f, { mode: "pr", owner: f.run });
      expect(delivered).toMatchObject({ applied: false, treeMutated: false });
      expect(delivered.detail).toContain("push failed");
      expect(git(f.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(head);
    },
  );

  it("a write that stays can still be reverted on its pair once the fault is gone", async () => {
    const f = await fixture(candidate, (repo) => {
      git(repo, "config", "filter.up.clean", "exit 1");
      git(repo, "config", "filter.up.smudge", "cat");
      git(repo, "config", "filter.up.required", "true");
    });
    const a = readFileSync(join(f.repo, "a.txt"), "utf8");
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
    expect(delivered.treeMutated).toBe(true);
    const { createPairRevertAnchor } = await import("@claudexor/workspace");
    git(f.repo, "config", "--unset", "filter.up.required");
    git(f.repo, "config", "--unset", "filter.up.clean");
    const anchor = await createPairRevertAnchor(f.repo, delivered.deliveryPair!);
    expect(await revertInPlaceFromAnchor(f.repo, anchor)).toMatchObject({ reverted: true });
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(a);
    expect(existsSync(join(f.repo, "new.weird"))).toBe(false);
    expect(
      spawnSync("git", ["-C", f.repo, "fsck", "--connectivity-only"], { env: ENV }).status,
    ).toBe(0);
  });
});

// The branch HEAD was on is gone when a delivery tries to return to it, and
// `origin/<branch>` holds other content: every restore names that branch exactly,
// never a namesake Git would recreate from the remote, and says how to get back.
describe("a restore never recreates a deleted branch from its remote namesake", () => {
  const REMOTE_ONLY = "remote-only.txt";
  /** `origin/main` at a commit only the remote has: the base plus a file the target lacks. */
  function originNamesake(repo: string) {
    git(repo, "remote", "add", "origin", "https://example.invalid/none.git");
    const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], {
      env: ENV,
      input: "from the remote\n",
    })
      .toString()
      .trim();
    const tree = execFileSync("git", ["-C", repo, "mktree"], {
      env: ENV,
      input: `${git(repo, "ls-tree", "HEAD")}\n100644 blob ${blob}\t${REMOTE_ONLY}\n`,
    })
      .toString()
      .trim();
    const commit = git(repo, "commit-tree", tree, "-p", "HEAD", "-m", "only on the remote");
    git(repo, "update-ref", "refs/remotes/origin/main", commit);
  }
  const deleteMain = (repo: string) => git(repo, "update-ref", "-d", "refs/heads/main");
  /** The user's concurrent staging: the index no longer holds the exact delivered tree. */
  const stageStray = (repo: string) => {
    writeFileSync(join(repo, "stray.txt"), "stray\n");
    git(repo, "add", "stray.txt");
  };
  const mainExists = (repo: string) =>
    spawnSync("git", ["-C", repo, "show-ref", "--verify", "-q", "refs/heads/main"], { env: ENV })
      .status === 0;

  function strandedHonestly(
    repo: string,
    delivered: { treeMutated?: boolean; detail?: string },
    head: string,
    branch: string,
  ) {
    // Not switched onto a branch made from the remote: HEAD stays where the failure left it.
    expect(existsSync(join(repo, REMOTE_ONLY))).toBe(false);
    expect(mainExists(repo)).toBe(false);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(delivered.treeMutated).toBe(true);
    expect(delivered.detail).not.toContain(TAKEN_BACK);
    expect(delivered.detail).toContain("RECOVERY REQUIRED");
    // The named way back works although `main` does not exist.
    expect(delivered.detail).toContain(`git checkout --detach ${head}`);
  }

  it("object delivery: a write taken back whose return to the branch fails says so", async () => {
    const f = await fixture(candidate, (repo) => {
      nonRoundTripFilter(repo);
      originNamesake(repo);
    });
    const head = git(f.repo, "rev-parse", "HEAD");
    const a = readFileSync(join(f.repo, "a.txt"), "utf8");
    afterWrite = { repo: f.repo, edit: () => deleteMain(f.repo) };
    const delivered = await verifyAndDeliver(f.repo, f, {
      mode: "branch",
      branch: "claudexor/gone",
      owner: f.run,
    });
    expect(delivered).toMatchObject({
      applied: false,
      refused: true,
      refusal: { code: "delivery_content_mismatch" },
    });
    strandedHonestly(f.repo, delivered, head, "claudexor/gone");
    expect(delivered.headStranded).toBe(true);
    expect(delivered.refusal?.message).toContain("the write was taken back");
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(a);
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(head);
    git(f.repo, "checkout", "-q", "--detach", head);
    expect(git(f.repo, "status", "--porcelain")).toBe("");
  });

  it("object delivery: a restore outside the exact tree whose return to the branch fails says so", async () => {
    const f = await fixture(
      (tree) => writeFileSync(join(tree, "a.txt"), lines({ 10: "candidate" })),
      originNamesake,
    );
    const head = git(f.repo, "rev-parse", "HEAD");
    afterWrite = {
      repo: f.repo,
      edit: () => {
        stageStray(f.repo);
        deleteMain(f.repo);
      },
    };
    const delivered = await verifyAndDeliver(f.repo, f, {
      mode: "branch",
      branch: "claudexor/gone",
      owner: f.run,
    });
    expect(delivered).toMatchObject({ applied: false, refused: true });
    expect(delivered.detail).toContain("live index contains state outside");
    strandedHonestly(f.repo, delivered, head, "claudexor/gone");
    expect(delivered.headStranded).toBe(true);
    expect(delivered.detail?.match(/RECOVERY REQUIRED/g)).toHaveLength(1);
  });

  it("legacy delivery: a failed apply whose return to the branch fails says so", async () => {
    const f = await fixture(
      (tree) => writeFileSync(join(tree, "a.txt"), lines({ 10: "candidate" })),
      originNamesake,
    );
    const head = git(f.repo, "rev-parse", "HEAD");
    aroundLegacyApply = {
      before: () => {
        // The user's edit overlaps the patch after its preflight: the apply really fails.
        writeFileSync(join(f.repo, "a.txt"), lines({ 10: "the user wrote this line" }));
        deleteMain(f.repo);
      },
    };
    const delivered = await deliver(f.repo, f.renderedPatch, {
      mode: "branch",
      branch: "claudexor/gone",
    });
    expect(delivered.applied).toBe(false);
    strandedHonestly(f.repo, delivered, head, "claudexor/gone");
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(
      lines({ 10: "the user wrote this line" }),
    );
  });

  it("legacy delivery: a restore outside the exact tree whose return to the branch fails says so", async () => {
    const f = await fixture(
      (tree) => writeFileSync(join(tree, "a.txt"), lines({ 10: "candidate" })),
      originNamesake,
    );
    const head = git(f.repo, "rev-parse", "HEAD");
    aroundLegacyApply = {
      after: () => {
        stageStray(f.repo);
        deleteMain(f.repo);
      },
    };
    const delivered = await deliver(f.repo, f.renderedPatch, {
      mode: "branch",
      branch: "claudexor/gone",
    });
    expect(delivered.applied).toBe(false);
    expect(delivered.detail).toContain("live index contains state outside");
    strandedHonestly(f.repo, delivered, head, "claudexor/gone");
    expect(delivered.detail?.match(/RECOVERY REQUIRED/g)).toHaveLength(1);
  });

  // `pr` reaches its push only after a clean publication scan (#555).
  const pinned = locateScanner({ env: process.env, configDir: null });
  /** An origin that has the base, and whose refusing hook also deletes `main`
   * (the user, meanwhile); the branch name stays free of a remote namesake check. */
  function strandingOrigin(repo: string, remoteMain: boolean) {
    const remote = mkdtempSync(join(tmpdir(), "cx-restore-origin-"));
    dirs.push(remote);
    git(remote, "init", "-q", "--bare");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "main");
    if (!remoteMain) git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    writeFileSync(
      join(remote, "hooks", "pre-receive"),
      `#!/bin/sh\nenv -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES git -C "${repo}" update-ref -d refs/heads/main\nexit 1\n`,
    );
    chmodSync(join(remote, "hooks", "pre-receive"), 0o755);
  }
  const edit = (tree: string) => writeFileSync(join(tree, "a.txt"), lines({ 10: "pr" }));
  const fileNamedMain = (repo: string) => writeFileSync(join(repo, "main"), "a file\n");

  it.runIf(pinned.ok)(
    "pr, both paths: a failed push whose return fails names the commit HEAD was on",
    async () => {
      for (const legacy of [false, true]) {
        const f = await fixture(edit, (repo) => strandingOrigin(repo, true));
        const head = git(f.repo, "rev-parse", "HEAD");
        const delivered = legacy
          ? await deliver(f.repo, f.renderedPatch, { mode: "pr", branch: "claudexor/gone" })
          : await verifyAndDeliver(f.repo, f, {
              mode: "pr",
              branch: "claudexor/gone",
              owner: f.run,
            });
        expect(delivered).toMatchObject({ applied: false, treeMutated: true });
        expect(mainExists(f.repo)).toBe(false);
        expect(git(f.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("claudexor/gone");
        expect(delivered.detail).toContain("RECOVERY REQUIRED");
        expect(delivered.detail).toContain(`git checkout --detach ${head}`);
        git(f.repo, "checkout", "-q", "--detach", head);
        expect(git(f.repo, "status", "--porcelain")).toBe("");
      }
    },
  );

  it.runIf(pinned.ok)(
    "pr, both paths: a tracked file named like the deleted branch is never what the return checks out",
    async () => {
      for (const legacy of [false, true]) {
        const f = await fixture(edit, (repo) => strandingOrigin(repo, false), fileNamedMain);
        const delivered = legacy
          ? await deliver(f.repo, f.renderedPatch, { mode: "pr", branch: "claudexor/gone" })
          : await verifyAndDeliver(f.repo, f, {
              mode: "pr",
              branch: "claudexor/gone",
              owner: f.run,
            });
        // `git checkout main` here would restore the FILE, exit 0, and leave HEAD on the branch.
        expect(git(f.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("claudexor/gone");
        expect(delivered).toMatchObject({ applied: false, treeMutated: true });
        expect(delivered.detail).toContain("RECOVERY REQUIRED");
      }
    },
  );
});

// HEAD returned and the tree and index are as before; only the delivery's own
// branch could not be deleted. That ref is named with its removal, and nothing
// says HEAD is stranded or that the target needs restoring.
describe("a delivery's branch whose deletion fails after HEAD returned", () => {
  /** Another process holds the branch's ref lock: `git branch -D` fails. */
  const lockBranch = (repo: string, branch: string) => {
    const lock = `${join(repo, ".git", "refs", "heads", ...branch.split("/"))}.lock`;
    writeFileSync(lock, "");
    return lock;
  };
  const leftBehind = (
    repo: string,
    delivered: { treeMutated?: boolean; headStranded?: boolean; detail?: string },
    head: string,
    lock: string,
  ) => {
    expect(delivered.treeMutated).toBe(false);
    expect(delivered.headStranded).toBeUndefined();
    expect(delivered).not.toHaveProperty("deliveryPair");
    expect(delivered.detail).toContain("git branch -D claudexor/kept");
    expect(delivered.detail).not.toContain("RECOVERY REQUIRED");
    expect(delivered.detail).not.toContain("git checkout");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "rev-parse", "claudexor/kept")).toBe(head);
    // The named removal works once the lock is gone.
    rmSync(lock);
    git(repo, "branch", "-D", "claudexor/kept");
  };

  it("object delivery: a write taken back", async () => {
    const f = await fixture(candidate, nonRoundTripFilter);
    const head = git(f.repo, "rev-parse", "HEAD");
    const a = readFileSync(join(f.repo, "a.txt"), "utf8");
    let lock = "";
    afterWrite = { repo: f.repo, edit: () => (lock = lockBranch(f.repo, "claudexor/kept")) };
    const delivered = await verifyAndDeliver(f.repo, f, {
      mode: "branch",
      branch: "claudexor/kept",
      owner: f.run,
    });
    expect(delivered).toMatchObject({
      applied: false,
      refused: true,
      refusal: { code: "delivery_content_mismatch" },
    });
    expect(delivered.refusal?.message).toContain("the write was taken back");
    leftBehind(f.repo, delivered, head, lock);
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(a);
    expect(existsSync(join(f.repo, "new.weird"))).toBe(false);
    expect(git(f.repo, "status", "--porcelain")).toBe("");
  });

  it("object delivery: a restore outside the exact tree", async () => {
    const f = await fixture((tree) =>
      writeFileSync(join(tree, "a.txt"), lines({ 10: "candidate" })),
    );
    const head = git(f.repo, "rev-parse", "HEAD");
    let lock = "";
    afterWrite = {
      repo: f.repo,
      edit: () => {
        writeFileSync(join(f.repo, "stray.txt"), "stray\n");
        git(f.repo, "add", "stray.txt");
        lock = lockBranch(f.repo, "claudexor/kept");
      },
    };
    const delivered = await verifyAndDeliver(f.repo, f, {
      mode: "branch",
      branch: "claudexor/kept",
      owner: f.run,
    });
    expect(delivered).toMatchObject({ applied: false, refused: true });
    expect(delivered.detail).toContain("live index contains state outside");
    expect(delivered.detail).toContain("delivered tree removed");
    leftBehind(f.repo, delivered, head, lock);
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(lines());
    // The user's own staging stays theirs.
    expect(git(f.repo, "diff", "--cached", "--name-only")).toBe("stray.txt");
  });
});

// The take-back's honest limits, pinned as they are (code unchanged).
describe("known limits of taking a write back", () => {
  it.each(["commit", "branch"] as const)(
    "%s of a file whose T blob does not round-trip: a take-back that cannot prove itself still returns the live index",
    async (mode) => {
      // The checkout of a real index trusts the stat cache and writes; the take-back
      // restores the bytes but its proof cannot hold under this filter, so the write
      // is reported as staying. The index it moved must not stay on the delivered tree.
      const f = await fixture(
        (tree) => writeFileSync(join(tree, "old.weird"), "lower changed\n"),
        nonRoundTripFilter,
        (repo) => settled(repo, "old.weird", "lower\n"),
      );
      expect(git(f.repo, "status", "--porcelain")).toBe("");
      const head = git(f.repo, "rev-parse", "HEAD");
      const delivered = await verifyAndDeliver(f.repo, f, { mode, owner: f.run });
      expect(delivered).toMatchObject({
        applied: false,
        refused: true,
        treeMutated: true,
        refusal: { code: "delivery_content_mismatch" },
      });
      expect(delivered.detail).toContain("the write could not be taken back");
      expect(git(f.repo, "diff", "--cached", "--name-only")).toBe("");
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(head);
      expect(git(f.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(git(f.repo, "branch", "--list")).toBe("* main");
      expect(readFileSync(join(f.repo, "old.weird"), "utf8")).toBe("lower\n");
    },
  );

  it("a commit whose take-back cannot prove itself leaves the user's own staging alone", async () => {
    const f = await fixture(
      (tree) => writeFileSync(join(tree, "old.weird"), "lower changed\n"),
      nonRoundTripFilter,
      (repo) => settled(repo, "old.weird", "lower\n"),
    );
    // The user stages a file right after the write: the index no longer holds exactly M.
    afterWrite = {
      repo: f.repo,
      edit: () => {
        writeFileSync(join(f.repo, "stray.txt"), "stray\n");
        git(f.repo, "add", "stray.txt");
      },
    };
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "commit", owner: f.run });
    expect(delivered).toMatchObject({ applied: false, refused: true, treeMutated: true });
    expect(git(f.repo, "diff", "--cached", "--name-only")).toContain("stray.txt");
  });

  it("a commit whose take-back and live-index return both fail names both", async () => {
    const f = await fixture(
      (tree) => writeFileSync(join(tree, "old.weird"), "lower changed\n"),
      nonRoundTripFilter,
      (repo) => settled(repo, "old.weird", "lower\n"),
    );
    // The take-back cannot prove itself under this filter, and the user's staging
    // keeps the live index from returning to HEAD's tree.
    afterWrite = {
      repo: f.repo,
      edit: () => {
        writeFileSync(join(f.repo, "stray.txt"), "stray\n");
        git(f.repo, "add", "stray.txt");
      },
    };
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "commit", owner: f.run });
    expect(delivered).toMatchObject({ applied: false, refused: true, treeMutated: true });
    for (const said of [delivered.refusal?.message, delivered.detail]) {
      expect(said).toContain("the write could not be taken back (");
      expect(said).toContain("written paths do not hold the delivered content");
      expect(said).toContain("the live index holds state outside the delivered tree");
      expect(said).toContain("RECOVERY REQUIRED");
    }
  });

  it("KNOWN LIMIT (Gemini F-3), not as described: a tracked file whose T blob does not round-trip under its filter refuses before any write", async () => {
    // Gemini F-3 expected the take-back to restore such a file and its proof to
    // false-alarm. Observed instead: the file is read through its filter by content
    // before anything is written, found not to be T's blob, and refused. Since
    // #535 R14 A1 that read is apply's own snapshot (it reads the paths the result
    // changes by content, never by the user's stat cache), so the composition
    // refuses it as a conflict before the checkout's up-to-date check is reached.
    const f = await fixture(
      (tree) => writeFileSync(join(tree, "old.weird"), "changed\n"),
      nonRoundTripFilter,
      (repo) => settled(repo, "old.weird", "lower\n"),
    );
    expect(git(f.repo, "status", "--porcelain")).toBe("");
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
    expect(delivered).toMatchObject({
      applied: false,
      refused: true,
      treeMutated: false,
      refusal: { code: "delivery_conflict", paths: ["old.weird"] },
    });
    expect(delivered.detail).toContain("old.weird: patch does not apply");
    expect(readFileSync(join(f.repo, "old.weird"), "utf8")).toBe("lower\n");
    expect(git(f.repo, "status", "--porcelain")).toBe("");
  });

  it("KNOWN LIMIT (Astra A1): a taken-back file is unchanged as Git holds it, not byte for byte", async () => {
    // With core.autocrlf=true the user's LF file is clean in Git's view, and the
    // take-back checks T out, which converts it: the file comes back as CRLF.
    const userBytes = "one\ntwo\n";
    const f = await fixture(
      (tree) => {
        candidate(tree);
        writeFileSync(join(tree, "eol.txt"), "one\nthree\n");
      },
      (repo) => {
        nonRoundTripFilter(repo);
        git(repo, "config", "core.autocrlf", "true");
      },
      (repo) => settled(repo, "eol.txt", userBytes),
    );
    expect(git(f.repo, "status", "--porcelain")).toBe("");
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
    expect(delivered).toMatchObject({ applied: false, refused: true, treeMutated: false });
    expect(delivered.detail).toContain(TAKEN_BACK);
    // As Git holds it the file is T again; on disk it is T checked out, not the user's bytes.
    expect(git(f.repo, "diff", "--stat")).toBe("");
    expect(JSON.stringify(readFileSync(join(f.repo, "eol.txt"), "utf8"))).toBe(
      JSON.stringify("one\r\ntwo\r\n"),
    );
    // Git's status lists a file whose size changed without re-hashing it, so the
    // converted files show as modified until the index next compares content.
    expect(
      execFileSync("git", ["-C", f.repo, "status", "--porcelain"], { env: ENV }).toString(),
    ).toBe(" M a.txt\n M eol.txt\n");
  });
});
