import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCapture } from "@claudexor/core";
import { sha256 } from "@claudexor/util";
import { DecisionRecord, makeOutcomeFacts } from "@claudexor/schema";
import {
  blockedDecisionOverride,
  checkPatch,
  checkPatchReverse,
  deliver,
  deriveApplyEligibility,
  validateApplyGate,
  verifyAndDeliver,
} from "./index.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

async function git(repo: string, args: string[]) {
  return runCapture("git", ["-C", repo, ...args], { timeoutMs: 30_000 });
}

async function makePatchRepo(): Promise<{ repo: string; patch: string }> {
  const repo = reapMk(join(tmpdir(), "claudexor-deliver-"));
  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-m", "init"]);
  writeFileSync(join(repo, "a.txt"), "two\n");
  const diff = (await git(repo, ["diff"])).stdout;
  await git(repo, ["checkout", "--", "a.txt"]); // revert; keep the patch
  return { repo, patch: diff };
}

async function makeModifyDeletePatchRepo(): Promise<{ repo: string; patch: string }> {
  const repo = reapMk(join(tmpdir(), "claudexor-deliver-"));
  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "b.txt"), "delete me\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-m", "init"]);
  writeFileSync(join(repo, "a.txt"), "two\n");
  unlinkSync(join(repo, "b.txt"));
  const diff = (await git(repo, ["diff"])).stdout;
  await git(repo, ["checkout", "--", "a.txt", "b.txt"]);
  return { repo, patch: diff };
}

describe("delivery", () => {
  it("fresh-verifies immediately before a protected mutation", async () => {
    const { repo, patch } = await makePatchRepo();
    const result = await verifyAndDeliver(repo, patch, { mode: "apply", protectedApply: true });
    expect(result.applied).toBe(true);
    expect(result.finalVerify).toMatchObject({ attempted: true, applied_cleanly: true });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
  });

  it("refuses mutation when a fresh deterministic gate fails", async () => {
    const { repo, patch } = await makePatchRepo();
    const result = await verifyAndDeliver(repo, patch, { mode: "apply", protectedApply: true }, [
      { id: "fresh-fail", program: process.execPath, args: ["-e", "process.exit(9)"] },
    ]);
    expect(result).toMatchObject({ applied: false, refused: true, treeMutated: false });
    expect(result.finalVerify).toMatchObject({ attempted: true, gates_passed: false });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
  });

  it("honors an explicit semantic risk authorization after mechanical verification passes", async () => {
    const { repo, patch } = await makePatchRepo();
    const result = await verifyAndDeliver(
      repo,
      patch,
      { mode: "apply", protectedApply: true },
      [{ id: "accepted-risk", program: process.execPath, args: ["-e", "process.exit(9)"] }],
      () => null,
    );
    expect(result).toMatchObject({ applied: true, treeMutated: true });
    expect(result.finalVerify).toMatchObject({ applied_cleanly: true, gates_passed: false });
    expect(result.refused).not.toBe(true);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
  });

  it("refuses when the target changes between fresh verification and mutation", async () => {
    const { repo, patch } = await makePatchRepo();
    const result = await verifyAndDeliver(
      repo,
      patch,
      { mode: "apply", protectedApply: true },
      [],
      () => {
        writeFileSync(join(repo, "concurrent.txt"), "user edit\n");
        return null;
      },
    );
    expect(result).toMatchObject({ applied: false, refused: true, treeMutated: false });
    expect(result.detail).toContain("target changed");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(repo, "concurrent.txt"), "utf8")).toBe("user edit\n");
  });

  it("serializes fresh verification and mutation for independent deliveries to one repository", async () => {
    const repo = reapMk(join(tmpdir(), "claudexor-delivery-lease-"));
    await git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    writeFileSync(join(repo, "b.txt"), "one\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-m", "init"]);
    writeFileSync(join(repo, "a.txt"), "two\n");
    const patchA = (await git(repo, ["diff", "--", "a.txt"])).stdout;
    await git(repo, ["checkout", "--", "a.txt"]);
    writeFileSync(join(repo, "b.txt"), "two\n");
    const patchB = (await git(repo, ["diff", "--", "b.txt"])).stdout;
    await git(repo, ["checkout", "--", "b.txt"]);

    const markerDir = reapMk(join(tmpdir(), "claudexor-delivery-lease-marker-"));
    const started = join(markerDir, "started");
    const release = join(markerDir, "release");
    const waitGate = [
      "const fs=require('fs')",
      `fs.writeFileSync(${JSON.stringify(started)},'started')`,
      `while(!fs.existsSync(${JSON.stringify(release)})){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}`,
    ].join(";");
    const first = verifyAndDeliver(repo, patchA, { mode: "apply", protectedApply: true }, [
      { id: "hold-first", program: process.execPath, args: ["-e", waitGate] },
    ]);
    for (let attempt = 0; attempt < 200 && !existsSync(started); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(started)).toBe(true);
    const second = verifyAndDeliver(repo, patchB, { mode: "apply", protectedApply: true }, [
      {
        id: "observe-first",
        program: process.execPath,
        args: [
          "-e",
          "const fs=require('fs');process.exit(fs.readFileSync('a.txt','utf8')==='two\\n'?0:9)",
        ],
      },
    ]);
    writeFileSync(release, "release\n");
    await expect(first).resolves.toMatchObject({ applied: true });
    await expect(second).resolves.toMatchObject({ applied: true });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("two\n");
  });

  it("checkPatch validates a clean patch and commit mode applies + commits", async () => {
    const { repo, patch } = await makePatchRepo();
    expect((await checkPatch(repo, patch)).ok).toBe(true);

    const res = await deliver(repo, patch, { mode: "commit", message: "apply two" });
    expect(res.applied).toBe(true);
    expect(res.commit).toBeTruthy();
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
  });

  it("branch mode creates a branch with the commit", async () => {
    const { repo, patch } = await makePatchRepo();
    const res = await deliver(repo, patch, { mode: "branch", message: "x" });
    expect(res.branch).toMatch(/^claudexor\//);
    expect(res.commit).toBeTruthy();
    const branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    expect(branch).toBe(res.branch);
  });

  it("commit delivery stages modified files and deletions from the patch", async () => {
    const { repo, patch } = await makeModifyDeletePatchRepo();
    const res = await deliver(repo, patch, { mode: "commit", message: "modify and delete" });
    expect(res.applied).toBe(true);
    expect(res.commit).toBeTruthy();
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    const committed = (await git(repo, ["show", "--name-status", "--format=", "HEAD"])).stdout;
    expect(committed).toContain("M\ta.txt");
    expect(committed).toContain("D\tb.txt");
    expect((await git(repo, ["status", "--short"])).stdout.trim()).toBe("");
  });

  it("refuses commit delivery when unrelated worktree changes are present", async () => {
    const { repo, patch } = await makePatchRepo();
    writeFileSync(join(repo, "unrelated.txt"), "secret local work\n");
    const res = await deliver(repo, patch, { mode: "commit", message: "apply two" });
    expect(res.applied).toBe(false);
    expect(res.detail).toContain("working tree is dirty");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
  });

  it("never captures a path staged concurrently after preflight", async () => {
    const { repo, patch } = await makePatchRepo();
    const wrapperDir = reapMk(join(tmpdir(), "claudexor-git-wrapper-"));
    const marker = join(wrapperDir, "inject-on-live-write-tree");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const testHome = join(wrapperDir, "home");
    const wrapperBin = join(testHome, ".claudexor", "node", "bin");
    mkdirSync(wrapperBin, { recursive: true });
    const wrapper = join(wrapperBin, "git");
    writeFileSync(marker, "armed\n");
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        `REAL_GIT=${JSON.stringify(realGit)}`,
        `MARKER=${JSON.stringify(marker)}`,
        'if [ "$1" = "-C" ] && [ "$3" = "write-tree" ] && [ -z "$GIT_INDEX_FILE" ] && [ -f "$MARKER" ]; then',
        '  rm -f "$MARKER"',
        '  printf "concurrent user state\\n" > "$2/concurrent.txt"',
        '  "$REAL_GIT" -C "$2" add -- concurrent.txt',
        "fi",
        'exec "$REAL_GIT" "$@"',
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    chmodSync(wrapper, 0o700);
    const oldPath = process.env.PATH;
    const oldHome = process.env.HOME;
    process.env.HOME = testHome;
    process.env.PATH = `${wrapperBin}:${oldPath ?? ""}`;
    try {
      const res = await deliver(repo, patch, { mode: "commit", message: "must stay scoped" });
      expect(res.applied).toBe(false);
      expect(res.treeMutated).toBe(false);
      expect(res.detail).toContain("outside the exact candidate tree");
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
      expect(readFileSync(join(repo, "concurrent.txt"), "utf8")).toBe("concurrent user state\n");
      expect((await git(repo, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe(
        "concurrent.txt",
      );
      expect((await git(repo, ["rev-parse", "HEAD"])).stdout.trim()).not.toBe(res.commit);
    } finally {
      process.env.PATH = oldPath;
      process.env.HOME = oldHome;
    }
  });

  it("pr delivery reports failure when the terminal push step fails", async () => {
    const { repo, patch } = await makePatchRepo();
    const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
    expect(res.applied).toBe(false);
    expect(res.commit).toBeTruthy();
    expect(res.detail).toContain("push failed");
  });

  it("reports a pushed branch as applied when PR creation fails", async () => {
    const { repo, patch } = await makePatchRepo();
    const remote = reapMk(join(tmpdir(), "claudexor-delivery-remote-"));
    execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
    await git(repo, ["remote", "add", "origin", remote]);
    const res = await deliver(repo, patch, {
      mode: "pr",
      branch: "claudexor/pr-failure-receipt",
      message: "open pr",
    });
    expect(res).toMatchObject({
      applied: true,
      branch: "claudexor/pr-failure-receipt",
      prUrl: undefined,
    });
    expect(res.detail).toContain("branch pushed; PR was not opened");
    const remoteTip = execFileSync(
      "git",
      ["--git-dir", remote, "rev-parse", "refs/heads/claudexor/pr-failure-receipt"],
      { encoding: "utf8" },
    ).trim();
    expect(remoteTip).toBe(res.commit);
  });

  // CLI/daemon parity: the artifact-only CLI apply feeds work_product.meta.status
  // into this gate, so a recorded non-succeeded terminal state is refused even
  // when decision.status=success — the convergence stale-diff + required-review case
  // where decision is success but the run terminal stayed not_converged.
  it("refuses apply for a non-succeeded recorded lifecycle despite an applyable decision", () => {
    const decision = DecisionRecord.parse({
      winner: "a01",
      facts: makeOutcomeFacts("succeeded", { review: "approved" }),
    });
    const err = validateApplyGate({
      state: "failed",
      decision,
      workProduct: null,
      patch: "diff --git a/x b/x\n",
      originalRepoRoot: "/x",
      targetRepoRoot: "/x",
    });
    expect(err).toContain("the run is still failed");
  });

  it("a succeeded lifecycle with an approved decision is NOT refused by the lifecycle/decision checks", () => {
    const decision = DecisionRecord.parse({
      winner: "a01",
      facts: makeOutcomeFacts("succeeded", { review: "approved" }),
    });
    // workProduct null trips a LATER check, not the state/decision gates — proving
    // those two gates pass for a succeeded+success run (parity with the daemon).
    const err = validateApplyGate({
      state: "succeeded",
      decision,
      workProduct: null,
      patch: "diff --git a/x b/x\n",
      originalRepoRoot: "/x",
      targetRepoRoot: "/x",
    });
    expect(err).toBe("This change needs a fresh final check before it can be applied.");
  });
});

const gitq = (repo: string, args: string[]): void => {
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: "pipe",
  });
};

async function initRepo(): Promise<string> {
  const repo = reapMk(join(tmpdir(), "claudexor-deliver-prot-"));
  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  gitq(repo, ["add", "-A"]);
  gitq(repo, ["commit", "-qm", "init"]);
  return repo;
}

describe("protected apply path", () => {
  it("a conflicting 3way apply refuses cleanly with the tree RESTORED (adopted:false means unchanged)", async () => {
    const repo = await initRepo();
    // Patch built against content the tree no longer has -> --check refuses.
    writeFileSync(join(repo, "f.txt"), "original\n");
    gitq(repo, ["add", "-A"]);
    gitq(repo, ["commit", "-qm", "seed"]);
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "index 000..111 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1 +1 @@",
      "-DIFFERENT base content",
      "+patched",
      "",
    ].join("\n");
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    const res = await deliver(repo, patch, { mode: "apply" });
    expect(res.applied).toBe(false);
    expect(res.treeMutated).toBe(false); // the INV-114 guarantee
    const after = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(after).toBe(before);
    expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("original\n");
  });

  it("branch delivery on a FAILED apply returns to the original branch and deletes the scratch branch", async () => {
    const repo = await initRepo();
    writeFileSync(join(repo, "f.txt"), "original\n");
    gitq(repo, ["add", "-A"]);
    gitq(repo, ["commit", "-qm", "seed"]);
    const badPatch = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1 +1 @@",
      "-NOPE",
      "+patched",
      "",
    ].join("\n");
    const res = await deliver(repo, badPatch, { mode: "branch", branch: "claudexor/scratch-x" });
    expect(res.applied).toBe(false);
    expect(res.treeMutated).toBe(false);
    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(head).not.toBe("claudexor/scratch-x");
    const branches = execFileSync("git", ["branch", "--list", "claudexor/scratch-x"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(branches.trim()).toBe("");
  });

  it("treats repo-local .claudexor-review-evidence as user state and refuses to absorb it", async () => {
    const repo = await initRepo();
    // Runtime/review packets are external in v2. A similarly named repo path is
    // not silently deleted or excluded: it is ordinary user state.
    writeFileSync(join(repo, ".gitignore"), ".claudexor/\n");
    gitq(repo, ["add", "-A"]);
    gitq(repo, ["commit", "-qm", "ignore"]);
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    writeFileSync(join(repo, ".claudexor", "scratch.txt"), "runtime\n");
    mkdirSync(join(repo, ".claudexor-review-evidence"), { recursive: true });
    writeFileSync(join(repo, ".claudexor-review-evidence", "GOAL.md"), "packet\n");
    const patch = [
      "diff --git a/added.txt b/added.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/added.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n");
    const res = await deliver(repo, patch, { mode: "commit", message: "test: protected staging" });
    expect(res.applied).toBe(false);
    expect(res.detail).toContain("working tree is dirty");
    expect(existsSync(join(repo, ".claudexor-review-evidence", "GOAL.md"))).toBe(true);
    expect(existsSync(join(repo, "added.txt"))).toBe(false);
  });
});

describe("final_verify apply-gate consumer (INV-115)", () => {
  const baseDecision = {
    winner: "a01",
    facts: makeOutcomeFacts("succeeded", { review: "approved" }),
  };
  const wp = { kind: "patch", meta: { patch_sha256: "" } };
  const patch = "diff --git a/x b/x\n";

  function gateWith(
    finalVerify: Record<string, unknown> | null,
    decisionOverrides: Record<string, unknown> = {},
  ) {
    return validateApplyGate({
      state: "succeeded",
      decision: DecisionRecord.parse({
        ...baseDecision,
        final_verify: finalVerify,
        ...decisionOverrides,
      }),
      workProduct: { ...wp, meta: { patch_sha256: sha256(patch) } } as never,
      patch,
      originalRepoRoot: process.cwd(),
      targetRepoRoot: process.cwd(),
    });
  }

  it("refuses apply when the patch failed to apply on the verify tree (no override possible)", () => {
    const err = gateWith({ attempted: true, applied_cleanly: false, reason: "conflict vs base" });
    expect(err).toContain("no longer applies onto a fresh copy");
  });

  it("refuses apply when verify gates failed (override path exists for blocked runs)", () => {
    const err = gateWith({ attempted: true, applied_cleanly: true, gates_passed: false });
    expect(err).toContain("checks failed when re-run on a fresh copy");
  });

  it("passes only when final verify is green; missing or unattempted verification fails closed", () => {
    expect(gateWith({ attempted: true, applied_cleanly: true, gates_passed: true })).toBeNull();
    expect(gateWith({ attempted: false, reason: "no base sha" })).toContain("fresh final check");
    expect(gateWith(null)).toContain("fresh final check");
  });

  it("FAILS CLOSED when the verifier ERRORED (applied_cleanly=null): refuses without an override, allows with accept_risk on the BLOCKED run", () => {
    const errored = { attempted: true, applied_cleanly: null, reason: "worktree add failed" };
    const refusal = gateWith(errored);
    expect(refusal).toContain("confirm this change applies onto a fresh copy");
    // A verifier error BLOCKS the run (fail-closed), so the reachable override
    // combination is state=blocked + a typed accept_risk decision (INV-111:
    // risk overrides unblock ONLY blocked runs — succeeded-state overrides
    // are unreachable and the gate refuses them).
    const blockedDecision = DecisionRecord.parse({
      ...baseDecision,
      facts: makeOutcomeFacts("succeeded", { checks: "failed", reason: "checks_failed" }),
      final_verify: errored,
    });
    const overridden = validateApplyGate({
      state: "succeeded",
      decision: blockedDecision,
      workProduct: { ...wp, meta: { patch_sha256: sha256(patch) } } as never,
      patch,
      originalRepoRoot: process.cwd(),
      targetRepoRoot: process.cwd(),
      operatorDecision: { action: "accept_risk", patch_sha256: sha256(patch) },
    });
    expect(overridden).toBeNull();
  });
});

describe("apply eligibility reflects the effective delivery state (QA-021)", () => {
  const patch = "diff --git a/x b/x\n";
  const approvedDecision = DecisionRecord.parse({
    winner: "a01",
    facts: makeOutcomeFacts("succeeded", { review: "approved" }),
    final_verify: null,
  });
  const baseInput = {
    state: "succeeded" as const,
    decision: approvedDecision,
    workProduct: { kind: "patch", meta: { patch_sha256: sha256(patch) } } as never,
    patch,
    originalRepoRoot: process.cwd(),
    targetRepoRoot: process.cwd(),
  };

  it("an ALREADY-APPLIED run is a terminal disposition, not 'rerun a fresh check'", () => {
    const verdict = deriveApplyEligibility({ ...baseInput, applyState: "applied" });
    expect(verdict).toEqual({
      eligible: false,
      state: "already_applied",
      reason: "This change is already applied.",
      requiredAction: null,
    });
  });

  it("an applied_review_blocked run is already applied (review outcome lives elsewhere)", () => {
    const verdict = deriveApplyEligibility({ ...baseInput, applyState: "applied_review_blocked" });
    expect(verdict.state).toBe("already_applied");
    expect(verdict.eligible).toBe(false);
    expect(verdict.requiredAction).toBeNull();
    // Never the false 'accept risk to apply anyway' guidance on already-applied work.
    expect(verdict.reason).not.toMatch(/apply it anyway|fresh final check|re-?run/i);
  });

  it("a REVERTED run is a terminal disposition with no stale Apply action", () => {
    const verdict = deriveApplyEligibility({ ...baseInput, applyState: "reverted" });
    expect(verdict).toEqual({
      eligible: false,
      state: "reverted",
      reason: "This change was reverted.",
      requiredAction: null,
    });
  });

  it("a not_applied pending patch still runs the normal gate (fresh check missing here)", () => {
    const verdict = deriveApplyEligibility({ ...baseInput, applyState: "not_applied" });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("fresh final check");
  });
});

describe("authorized override unlocks the JIT final verify at apply (QA-032)", () => {
  const patch = "diff --git a/x b/x\n";
  // A review-blocked run skips FinalVerifier by construction: final_verify is null.
  const blockedDecision = DecisionRecord.parse({
    winner: "a01",
    facts: makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" }),
    final_verify: null,
  });
  const readOnlyInput = {
    state: "succeeded" as const,
    decision: blockedDecision,
    workProduct: { kind: "patch", meta: { patch_sha256: sha256(patch) } } as never,
    patch,
    originalRepoRoot: process.cwd(),
    targetRepoRoot: process.cwd(),
    operatorDecision: { action: "accept_risk", patch_sha256: sha256(patch) },
  };

  it("read-only projection of a hash-bound accept_risk is eligible (verify runs at apply)", () => {
    const verdict = deriveApplyEligibility(readOnlyInput);
    expect(verdict.eligible).toBe(true);
    expect(verdict.state).toBe("verify_pending");
    // Not the dead-end 'fresh final check' refusal, and no loop back to a review.
    expect(verdict.requiredAction).toBeNull();
  });

  it("the read-only apply gate no longer dead-ends after a valid override", () => {
    expect(validateApplyGate(readOnlyInput)).toBeNull();
  });

  it("WITHOUT an override the blocked run stays fail-closed (not eligible)", () => {
    const { operatorDecision: _omit, ...noOverride } = readOnlyInput;
    // No hash-bound override -> the blocked run is refused as not-ready, and the
    // verify-pending unlock does NOT fire.
    expect(validateApplyGate(noOverride)).toContain("isn't ready to apply");
    const verdict = deriveApplyEligibility(noOverride);
    expect(verdict.eligible).toBe(false);
    expect(verdict.state).toBe("needs_review");
  });

  it("at APPLY time a supplied fresh verify is gated normally, not treated as pending", () => {
    // finalVerify explicitly supplied (the apply path) and still unattempted -> refuse.
    expect(
      validateApplyGate({ ...readOnlyInput, finalVerify: { attempted: false } as never }),
    ).toContain("fresh final check");
  });

  it("the blocked-run hint no longer loops back to 'run a review first'", () => {
    const { operatorDecision: _omit, ...noOverride } = readOnlyInput;
    const verdict = deriveApplyEligibility(noOverride);
    expect(verdict.requiredAction).not.toMatch(/run a review/i);
    expect(verdict.requiredAction).toMatch(/accept the risk/i);
  });
});

describe("idempotent replay is a typed no-op, divergence is a conflict (#26)", () => {
  it("reverse-checks the exact postimage the tree already holds", async () => {
    const { repo, patch } = await makePatchRepo();
    // Apply once: the tree becomes the patch's postimage.
    const first = await verifyAndDeliver(repo, patch, { mode: "apply", protectedApply: true });
    expect(first.applied).toBe(true);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
    // Forward no longer applies; reverse applies cleanly -> tree IS the postimage.
    expect((await checkPatch(repo, patch)).ok).toBe(false);
    expect((await checkPatchReverse(repo, patch)).ok).toBe(true);
  });

  it("replaying apply on an already-delivered tree is applied:true with NO mutation", async () => {
    const { repo, patch } = await makePatchRepo();
    const first = await verifyAndDeliver(repo, patch, { mode: "apply", protectedApply: true });
    const replay = await verifyAndDeliver(repo, patch, { mode: "apply", protectedApply: true });
    expect(replay.applied).toBe(true);
    expect(replay.treeMutated).toBe(false);
    expect(replay.refused).not.toBe(true);
    // #26: the idempotent no-op is now typed on the receipt, not just prose.
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.detail).toMatch(/already applied/i);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
    // A fresh apply is NOT flagged already-applied.
    expect(first.alreadyApplied ?? false).toBe(false);
  });

  it("a diverged target (neither pre- nor postimage) still refuses as a typed conflict", async () => {
    const { repo, patch } = await makePatchRepo();
    // Diverge the target so neither the forward nor the reverse patch applies.
    writeFileSync(join(repo, "a.txt"), "three\n");
    const res = await verifyAndDeliver(repo, patch, { mode: "apply", protectedApply: true });
    expect(res.applied).toBe(false);
    expect(res.refused).toBe(true);
    expect(res.treeMutated).toBe(false);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("three\n");
  });
});

describe("blocked decision fact overrides", () => {
  it("preserves passed checks when a review block overrides the review axis", () => {
    const result = blockedDecisionOverride(
      [],
      makeOutcomeFacts("succeeded", { checks: "passed" }),
      null,
    );

    expect(result.facts).toMatchObject({
      checks: "passed",
      review: "blocked",
      reason: "review_blocked",
    });
  });

  it("preserves an approved review when final verify overrides the checks axis", () => {
    const result = blockedDecisionOverride(
      [],
      makeOutcomeFacts("succeeded", { review: "approved" }),
      {
        attempted: true,
        applied_cleanly: true,
        gates_passed: false,
        gates: [],
        base_sha: null,
        duration_ms: null,
        reason: "configured gate failed",
      },
    );

    expect(result.facts).toMatchObject({
      checks: "failed",
      review: "approved",
      reason: "checks_failed",
    });
  });
});
