import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionRecord, makeOutcomeFacts, WorkProduct } from "@claudexor/schema";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  createRevertAnchorFromPatchOrNull,
  gitResultDigest,
  isolatedCloneAdd,
  objectStorePath,
  readRevertPair,
} from "@claudexor/workspace";
import {
  checkResultOnTarget,
  locateScanner,
  revertInPlaceFromAnchor,
  validateApplyGate,
  verifyAndDeliver,
} from "./index.js";

// The commit each publication scan passed, as the delivery received it.
const scanned: string[] = [];
vi.mock("./publication-gate.js", async (original) => {
  const actual = await original<typeof import("./publication-gate.js")>();
  return {
    ...actual,
    gatePublication: async (...args: Parameters<typeof actual.gatePublication>) => {
      const gate = await actual.gatePublication(...args);
      if (gate.ok) scanned.push(gate.commit);
      return gate;
    },
  };
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-object-delivery-config-"));
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
  execFileSync("git", ["-C", repo, ...args], { env: ENV, maxBuffer: 1 << 26 })
    .toString("utf8")
    .trim();
const lines = (n: number, edit: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => `${edit[i + 1] ?? `line ${i + 1}`}\n`).join("");

/** A user repo plus an isolated candidate captured as an object result (#535). */
async function fixture(write: (tree: string) => void, viewLimitBytes?: number) {
  const repo = mkdtempSync(join(tmpdir(), "cx-object-delivery-"));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), lines(60));
  writeFileSync(join(repo, "keep.txt"), "keep\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  const clone = join(mkdtempSync(join(tmpdir(), "cx-object-delivery-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, ["rev-parse", "HEAD"]));
  write(clone);
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: repo,
    ...(viewLimitBytes !== undefined ? { viewLimitBytes } : {}),
  });
  expect(captured.captureIncomplete).toBe(false);
  rmSync(join(clone, ".."), { recursive: true, force: true });
  return {
    repo,
    result: captured.result!,
    renderedPatch: captured.patchViewUnavailable ? null : captured.patch,
  };
}

describe("verifyAndDeliver of an object result (rev 14 A, C, D, G)", () => {
  it("applies onto a changed target, keeps the unrelated change, and reverts on the pair", async () => {
    const f = await fixture((tree) => {
      writeFileSync(join(tree, "a.txt"), lines(60, { 55: "candidate" }));
      writeFileSync(join(tree, "new.txt"), "new\n");
    });
    writeFileSync(join(f.repo, "a.txt"), lines(60, { 3: "user" }));
    writeFileSync(join(f.repo, "keep.txt"), "user keep\n");
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.repo });
    expect(delivered).toMatchObject({ applied: true, treeMutated: true });
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(
      lines(60, { 3: "user", 55: "candidate" }),
    );
    expect(readFileSync(join(f.repo, "keep.txt"), "utf8")).toBe("user keep\n");
    expect(readFileSync(join(f.repo, "new.txt"), "utf8")).toBe("new\n");
    // Apply-only leaves the user's index alone (the files are unstaged changes).
    expect(git(f.repo, ["diff", "--cached", "--name-only"])).toBe("");
    const anchor = await createPairRevertAnchor(f.repo, delivered.deliveryPair!);
    expect(readRevertPair(f.repo, anchor)).toEqual(delivered.deliveryPair);
    writeFileSync(join(f.repo, "later.txt"), "later\n");
    git(f.repo, ["reflog", "expire", "--expire=now", "--all"]);
    git(f.repo, ["gc", "-q", "--prune=now"]);
    expect((await revertInPlaceFromAnchor(f.repo, anchor)).reverted).toBe(true);
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(lines(60, { 3: "user" }));
    expect(existsSync(join(f.repo, "new.txt"))).toBe(false);
    expect(readFileSync(join(f.repo, "later.txt"), "utf8")).toBe("later\n");
  });

  it("commits and branches with today's admission; refs point at self-contained objects", async () => {
    for (const mode of ["commit", "branch"] as const) {
      const f = await fixture((tree) => writeFileSync(join(tree, "c.txt"), `${mode}\n`));
      const base = git(f.repo, ["rev-parse", "HEAD"]);
      const delivered = await verifyAndDeliver(f.repo, f, { mode, owner: f.repo });
      expect(delivered.applied).toBe(true);
      expect(git(f.repo, ["show", `${delivered.commit}:c.txt`])).toBe(mode);
      // The ref moved to that commit: HEAD stays on `main` for a commit, and a new
      // branch holds it for a branch while `main` stays where it was.
      const onBranch = mode === "branch" ? delivered.branch! : "main";
      expect(git(f.repo, ["symbolic-ref", "HEAD"])).toBe(`refs/heads/${onBranch}`);
      expect(git(f.repo, ["rev-parse", `refs/heads/${onBranch}`])).toBe(delivered.commit);
      expect(git(f.repo, ["rev-parse", `${delivered.commit}^`])).toBe(base);
      if (mode === "branch") expect(git(f.repo, ["rev-parse", "refs/heads/main"])).toBe(base);
      expect(git(f.repo, ["status", "--porcelain"])).toBe("");
      rmSync(objectStorePath(f.repo), { recursive: true, force: true });
      git(f.repo, ["gc", "-q", "--prune=now"]);
      expect(
        spawnSync("git", ["-C", f.repo, "fsck", "--connectivity-only"], { env: ENV }).status,
      ).toBe(0);
    }
  });

  it("refuses a dirty tree for commit-class delivery and a conflict with its paths", async () => {
    const f = await fixture((tree) =>
      writeFileSync(join(tree, "a.txt"), lines(60, { 10: "candidate" })),
    );
    writeFileSync(join(f.repo, "a.txt"), lines(60, { 10: "user" }));
    const dirty = await verifyAndDeliver(f.repo, f, { mode: "commit", owner: f.repo });
    expect(dirty.applied).toBe(false);
    const conflict = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.repo });
    expect(conflict).toMatchObject({ applied: false, refused: true, treeMutated: false });
    expect(conflict.refusal).toMatchObject({ code: "delivery_conflict", paths: ["a.txt"] });
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(lines(60, { 10: "user" }));
  });

  it("a dry-run check under core.splitIndex=true writes no shared index into the user's Git directory", async () => {
    const f = await fixture((tree) => writeFileSync(join(tree, "n.txt"), "n\n"));
    git(f.repo, ["config", "core.splitIndex", "true"]);
    git(f.repo, ["update-index", "--split-index"]);
    const shared = () =>
      readdirSync(join(f.repo, ".git"))
        .filter((name) => name.startsWith("sharedindex."))
        .sort();
    const before = shared();
    expect(before).toHaveLength(1);

    expect(await checkResultOnTarget(f.repo, f.result)).toMatchObject({ ok: true });

    expect(shared()).toEqual(before);
  });

  it("a dry-run check of a dirty target writes no object into the user's repository", async () => {
    const f = await fixture((tree) => writeFileSync(join(tree, "n.txt"), "n\n"));
    writeFileSync(join(f.repo, "a.txt"), lines(60, { 3: "the user's unsaved edit" }));
    writeFileSync(join(f.repo, "untracked.txt"), "the user's new file\n");
    const objects = join(f.repo, ".git", "objects");
    const listing = () => readdirSync(objects, { recursive: true }).map(String).sort();
    const before = listing();
    const index = readFileSync(join(f.repo, ".git", "index"));

    expect(await checkResultOnTarget(f.repo, f.result)).toMatchObject({ ok: true });

    expect(listing()).toEqual(before);
    expect(readFileSync(join(f.repo, ".git", "index")).equals(index)).toBe(true);
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(
      lines(60, { 3: "the user's unsaved edit" }),
    );
  });

  it("answers an idempotent replay and a dry-run check without writing", async () => {
    const f = await fixture((tree) => writeFileSync(join(tree, "n.txt"), "n\n"));
    expect(await checkResultOnTarget(f.repo, f.result)).toMatchObject({ ok: true });
    expect(existsSync(join(f.repo, "n.txt"))).toBe(false);
    expect((await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.repo })).applied).toBe(
      true,
    );
    expect(await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.repo })).toMatchObject({
      applied: true,
      alreadyApplied: true,
      treeMutated: false,
    });
    expect(await checkResultOnTarget(f.repo, f.result)).toMatchObject({
      ok: true,
      alreadyApplied: true,
    });
  });

  it("applies and reverts an unrendered result (no patch view) through the same entry (F14)", async () => {
    const f = await fixture((tree) => {
      writeFileSync(join(tree, "big.txt"), lines(500));
      writeFileSync(join(tree, "a.txt"), lines(60, { 7: "candidate" }));
    }, 1024);
    expect(f.renderedPatch).toBeNull();
    writeFileSync(join(f.repo, "keep.txt"), "user keep\n");
    expect(await checkResultOnTarget(f.repo, f.result)).toMatchObject({ ok: true });
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.repo });
    expect(delivered).toMatchObject({ applied: true, treeMutated: true });
    expect(readFileSync(join(f.repo, "big.txt"), "utf8")).toBe(lines(500));
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(lines(60, { 7: "candidate" }));
    const anchor = await createPairRevertAnchor(f.repo, delivered.deliveryPair!);
    expect((await revertInPlaceFromAnchor(f.repo, anchor)).reverted).toBe(true);
    expect(existsSync(join(f.repo, "big.txt"))).toBe(false);
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(lines(60));
    expect(readFileSync(join(f.repo, "keep.txt"), "utf8")).toBe("user keep\n");
  });

  it("refuses pr of an unrendered result (G) before any scan or mutation", async () => {
    const unrendered = await fixture(
      (tree) => writeFileSync(join(tree, "big.txt"), lines(500)),
      1024,
    );
    expect(unrendered.renderedPatch).toBeNull();
    const refused = await verifyAndDeliver(unrendered.repo, unrendered, {
      mode: "pr",
      owner: unrendered.repo,
    });
    expect(refused).toMatchObject({
      applied: false,
      refused: true,
      refusal: { code: "pr_unrendered_result" },
    });
    expect(refused.publicationRefusal).toBeUndefined();
    expect(refused.detail).toContain("nothing was scanned or sent");
    expect(git(unrendered.repo, ["branch", "--list"])).toBe("* main");
  });

  /** Every object of the repository: a refusal "before any write" leaves none behind. */
  const objectCount = (repo: string) =>
    git(repo, ["cat-file", "--batch-all-objects", "--batch-check"]).split("\n").length;

  it("refuses pr of an unrendered result on a dirty target without writing one object", async () => {
    const f = await fixture((tree) => writeFileSync(join(tree, "big.txt"), lines(500)), 1024);
    writeFileSync(join(f.repo, "keep.txt"), "user keep\n");
    writeFileSync(join(f.repo, "untracked.txt"), "user's new file\n");
    const objects = objectCount(f.repo);
    const status = git(f.repo, ["status", "--porcelain"]);
    const refused = await verifyAndDeliver(f.repo, f, { mode: "pr", owner: f.repo });
    expect(refused).toMatchObject({
      applied: false,
      refused: true,
      treeMutated: false,
      refusal: { code: "pr_unrendered_result" },
    });
    expect(refused.targetPreimageSha).toBe(git(f.repo, ["rev-parse", "HEAD"]));
    expect(objectCount(f.repo)).toBe(objects);
    expect(git(f.repo, ["status", "--porcelain"])).toBe(status);
    expect(git(f.repo, ["branch", "--list"])).toBe("* main");
  });

  describe("an empty result (base tree = candidate tree) is refused in every mode", () => {
    const empty = async () => {
      const f = await fixture(() => undefined);
      expect(f.result.base_tree).toBe(f.result.candidate_tree);
      const remote = mkdtempSync(join(tmpdir(), "cx-object-delivery-origin-"));
      dirs.push(remote);
      execFileSync("git", ["init", "-q", "--bare", remote]);
      git(f.repo, ["remote", "add", "origin", remote]);
      git(f.repo, ["push", "-q", "origin", "main"]);
      const state = () => ({
        refs: git(f.repo, ["for-each-ref"]),
        head: git(f.repo, ["symbolic-ref", "HEAD"]),
        status: git(f.repo, ["status", "--porcelain"]),
        objects: objectCount(f.repo),
        remote: execFileSync("git", ["--git-dir", remote, "for-each-ref"], { encoding: "utf8" }),
      });
      return { ...f, state };
    };

    it.each([
      ["apply", {}],
      ["apply", { protectedApply: true }],
      ["commit", {}],
      ["branch", { branch: "claudexor/empty" }],
      ["pr", { branch: "claudexor/empty" }],
    ] as const)("%s %j", async (mode, extra) => {
      const f = await empty();
      const before = f.state();
      const delivered = await verifyAndDeliver(f.repo, f, { mode, owner: f.repo, ...extra });
      expect(delivered).toMatchObject({ applied: false, refused: true, treeMutated: false });
      expect(delivered.detail).toContain("empty result");
      expect(delivered.detail).toContain("no commit created");
      expect(delivered.commit).toBeUndefined();
      expect(delivered.deliveryPair).toBeUndefined();
      expect(delivered.finalVerify?.attempted).toBe(false);
      expect(f.state()).toEqual(before);
    });

    it("on a dirty target too, without a snapshot object", async () => {
      const f = await empty();
      writeFileSync(join(f.repo, "keep.txt"), "user keep\n");
      const before = f.state();
      const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.repo });
      expect(delivered).toMatchObject({ applied: false, refused: true, treeMutated: false });
      expect(f.state()).toEqual(before);
    });

    it("the dry run answers the same, instead of a clean check apply then refuses", async () => {
      const f = await empty();
      const check = await checkResultOnTarget(f.repo, f.result);
      expect(check).toMatchObject({ ok: false, code: 1 });
      expect(check.stderr).toContain("empty result");
    });
  });

  it("refuses typed when neither the repository nor the store holds a result object", async () => {
    const f = await fixture((tree) => writeFileSync(join(tree, "gone.txt"), "gone\n"));
    rmSync(objectStorePath(f.repo), { recursive: true, force: true });
    const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.repo });
    expect(delivered).toMatchObject({
      applied: false,
      refused: true,
      refusal: { code: "result_objects_missing" },
    });
    expect(existsSync(join(f.repo, "gone.txt"))).toBe(false);
  });
});

// #555 composed onto a Git result (#535): `pr` publishes only what the pinned
// publication scanner passes, through the same gate as a legacy patch, before
// any branch, commit or push; the commit pushed is the one that was scanned.
describe("a Git result's pr goes through the publication scanner (INV-146)", () => {
  // Synthetic, assembled at runtime; high-entropy so the scanner's own rules fire.
  const token = `ghp_${"q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2Ae9U"}`;
  const pinned = locateScanner({ env: process.env, configDir: null });

  /** The fixture's repository with a local bare origin that already has its base. */
  async function withOrigin(write: (tree: string) => void) {
    const f = await fixture(write);
    const remote = mkdtempSync(join(tmpdir(), "cx-object-delivery-origin-"));
    dirs.push(remote);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(f.repo, ["remote", "add", "origin", remote]);
    git(f.repo, ["push", "-q", "origin", "main"]);
    const refs = () =>
      execFileSync("git", ["--git-dir", remote, "for-each-ref"], { encoding: "utf8" });
    const local = () => ({
      head: git(f.repo, ["rev-parse", "HEAD"]),
      branches: git(f.repo, ["branch", "--list"]),
      status: git(f.repo, ["status", "--porcelain"]),
    });
    return { ...f, remote, refs, local };
  }

  it("refuses publication_scan_unavailable and touches nothing without the pinned scanner", async () => {
    const f = await withOrigin((tree) =>
      writeFileSync(join(tree, "a.txt"), lines(60, { 2: "pr" })),
    );
    const before = f.local();
    const remoteBefore = f.refs();
    const saved = process.env.CLAUDEXOR_BETTERLEAKS_PATH;
    delete process.env.CLAUDEXOR_BETTERLEAKS_PATH;
    try {
      const res = await verifyAndDeliver(f.repo, f, {
        mode: "pr",
        owner: f.repo,
        scannerConfigDir: mkdtempSync(join(tmpdir(), "cx-no-scanner-")),
      });
      expect(res).toMatchObject({ mode: "pr", applied: false, refused: true, treeMutated: false });
      expect(res.publicationRefusal?.code).toBe("publication_scan_unavailable");
      expect(res.refusal).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.CLAUDEXOR_BETTERLEAKS_PATH;
      else process.env.CLAUDEXOR_BETTERLEAKS_PATH = saved;
    }
    expect(f.local()).toEqual(before);
    expect(f.refs()).toBe(remoteBefore);
  });

  it.runIf(pinned.ok)(
    "refuses a finding in the result's outgoing commit before any branch, commit or push",
    async () => {
      const f = await withOrigin((tree) =>
        writeFileSync(join(tree, "NEW.txt"), `token = "${token}"\n`),
      );
      const before = f.local();
      const remoteBefore = f.refs();
      const res = await verifyAndDeliver(f.repo, f, { mode: "pr", owner: f.repo });
      expect(res).toMatchObject({ mode: "pr", applied: false, refused: true, treeMutated: false });
      expect(res.publicationRefusal?.code).toBe("publication_scan_findings");
      expect(res.detail).toMatch(/github-pat in NEW\.txt:1/);
      expect(JSON.stringify(res)).not.toContain(token);
      expect(f.local()).toEqual(before);
      expect(f.refs()).toBe(remoteBefore);
    },
  );

  it.runIf(pinned.ok)("pushes exactly the scanned commit of M and opens the PR", async () => {
    const f = await withOrigin((tree) => writeFileSync(join(tree, "NEW.txt"), "ordinary line\n"));
    // A fake `gh` in a temporary HOME's `.local/bin`: no real `gh` can be reached.
    const home = mkdtempSync(join(tmpdir(), "cx-fake-gh-home-"));
    dirs.push(home);
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(
      join(home, ".local", "bin", "gh"),
      `#!${process.execPath}\nconst fs=require("fs");const a=process.argv.slice(2);const i=a.indexOf("--body-file");` +
        `fs.writeFileSync(${JSON.stringify(join(home, "gh-record.json"))},JSON.stringify({args:a,body:i>=0?fs.readFileSync(a[i+1],"utf8"):null}));` +
        `console.log("https://example.invalid/pr/1");\n`,
    );
    chmodSync(join(home, ".local", "bin", "gh"), 0o755);
    const body = join(home, "body.md");
    writeFileSync(body, "the scanned body\n");
    scanned.length = 0;
    const previous = process.env.HOME;
    process.env.HOME = home;
    let res: Awaited<ReturnType<typeof verifyAndDeliver>>;
    try {
      res = await verifyAndDeliver(f.repo, f, {
        mode: "pr",
        owner: f.repo,
        branch: "claudexor/pr-m",
        message: "open the pr",
        prBodyFile: body,
      });
    } finally {
      process.env.HOME = previous;
    }
    expect(res).toMatchObject({ applied: true, prUrl: "https://example.invalid/pr/1" });
    const pushed = execFileSync(
      "git",
      ["--git-dir", f.remote, "rev-parse", "refs/heads/claudexor/pr-m"],
      { encoding: "utf8" },
    ).trim();
    expect(pushed).toBe(res.commit);
    // The object pushed is the object the gate scanned, not a rebuilt twin.
    expect(scanned).toEqual([pushed]);
    const gh = JSON.parse(readFileSync(join(home, "gh-record.json"), "utf8")) as {
      args: string[];
      body: string | null;
    };
    expect(gh.args.slice(0, 6)).toEqual([
      "pr",
      "create",
      "--head",
      "claudexor/pr-m",
      "--title",
      "open the pr",
    ]);
    expect(gh.body).toBe("the scanned body\n");
    expect(git(f.repo, ["log", "-1", "--format=%s", pushed])).toBe("open the pr");
    expect(git(f.repo, ["rev-parse", `${res.commit}^{tree}`])).toBe(res.deliveryPair?.post_tree);
    expect(git(f.repo, ["config", "branch.claudexor/pr-m.remote"])).toBe("origin");
  });
});

describe("decisions and integrity bind the result digest v1 (rev 11 E)", () => {
  const blocked = DecisionRecord.parse({
    winner: "a01",
    facts: makeOutcomeFacts("succeeded", { checks: "failed", reason: "checks_failed" }),
    final_verify: { attempted: true, applied_cleanly: true, gates_passed: false },
  });
  const result = {
    schema: "git_objects/v1" as const,
    object_format: "sha1" as const,
    base_tree: "1".repeat(40),
    candidate_tree: "2".repeat(40),
    base_commit: null,
    store_boundary_commit: null,
    digest: "",
  };
  result.digest = gitResultDigest(result);
  const input = (patchDigest: string, meta: Record<string, unknown> = { git_result: result }) => ({
    state: "succeeded",
    decision: blocked,
    workProduct: WorkProduct.parse({ id: "wp-1", kind: "patch", source_task_id: "t-1", meta }),
    patch: "",
    gitResult: result,
    originalRepoRoot: process.cwd(),
    targetRepoRoot: process.cwd(),
    operatorDecision: { action: "accept_risk", patch_sha256: patchDigest },
  });

  it("an accept_risk bound to digest v1 unblocks; one bound to a patch digest does not", () => {
    expect(validateApplyGate(input(result.digest))).toBeNull();
    expect(validateApplyGate(input(`sha256:${"0".repeat(64)}`))).toContain("Accept the risk");
  });

  it("a work product whose recorded result differs from the run's result is refused", () => {
    const other = { ...result, candidate_tree: "3".repeat(40) };
    other.digest = gitResultDigest(other);
    expect(validateApplyGate(input(result.digest, { git_result: other }))).toContain(
      "does not match the recorded work product",
    );
  });

  it("a legacy patch anchor still reverts through the same owner", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-legacy-anchor-"));
    dirs.push(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "base"]);
    writeFileSync(join(repo, "a.txt"), "two\n");
    const patch = execFileSync("git", ["-C", repo, "diff", "--binary"], { env: ENV }).toString(
      "utf8",
    );
    const anchor = createRevertAnchorFromPatchOrNull(repo, patch)!;
    expect(readRevertPair(repo, anchor)).toBeNull();
    expect((await revertInPlaceFromAnchor(repo, anchor)).reverted).toBe(true);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
  });
});
