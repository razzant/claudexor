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
  EXACT_PATCH_UNAVAILABLE_MESSAGE,
  locateScanner,
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
    const oldExecPath = process.execPath;
    process.env.HOME = testHome;
    process.env.PATH = `${wrapperBin}:${oldPath ?? ""}`;
    // The runtime PATH contract prepends a launchable runner's real directory.
    // Disable that unrelated prefix so this fixture deterministically exercises
    // the managed HOME wrapper even when the host Node lives beside git.
    process.execPath = join(wrapperDir, "no-such-runner-node");
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
      process.execPath = oldExecPath;
      process.env.PATH = oldPath;
      process.env.HOME = oldHome;
    }
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
    inputOverrides: Partial<Parameters<typeof validateApplyGate>[0]> = {},
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
      ...inputOverrides,
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

  it("defers only a missing saved verifier for thread contribution preflight", () => {
    const deferred = { deferFinalVerify: true };
    const unreviewed = makeOutcomeFacts("succeeded", {
      review: "not_run",
      review_requested: false,
    });
    expect(gateWith(null, {}, deferred)).toBeNull();
    expect(gateWith(null, { facts: unreviewed }, deferred)).toBeNull();
    expect(
      gateWith(null, { facts: { ...unreviewed, review_requested: undefined } }, deferred),
    ).toContain("isn't ready to apply");
    expect(gateWith(null, { facts: { ...unreviewed, checks: "failed" } }, deferred)).toContain(
      "isn't ready to apply",
    );
    expect(gateWith({ attempted: false }, {}, deferred)).toContain("fresh final check");
    expect(gateWith(null, {}, { ...deferred, finalVerify: null })).toContain("fresh final check");
    expect(gateWith({ attempted: true, applied_cleanly: false }, {}, deferred)).toContain(
      "no longer applies",
    );
    expect(gateWith(null, {}, { ...deferred, patch: "diff --git a/y b/y\n" })).toContain(
      "hash does not match",
    );
    expect(gateWith(null, {}, { ...deferred, originalRepoRoot: null })).toContain(
      "original project is unknown",
    );
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

describe("D-16 work_state veto refuses apply even on a clean review (INV-116, B-1)", () => {
  const patch = "diff --git a/x b/x\n";
  const workProduct = { kind: "patch", meta: { patch_sha256: sha256(patch) } } as never;
  const needsInputState = {
    state: "needs_input" as const,
    source: "constrained" as const,
    required_inputs: [{ kind: "decision" as const, locator: null, description: "which backend?" }],
  };
  // A CLEAN review (approved) + a passing/clean final verify — the run would be
  // fully applyable if the model had not attested it still needs input.
  const cleanDecision = DecisionRecord.parse({
    winner: "a01",
    facts: makeOutcomeFacts("succeeded", { review: "approved", work_state: needsInputState }),
    final_verify: { attempted: true, applied_cleanly: true, gates_passed: true },
  });
  const vetoInput = {
    state: "succeeded" as const,
    decision: cleanDecision,
    workProduct,
    patch,
    originalRepoRoot: process.cwd(),
    targetRepoRoot: process.cwd(),
    workState: needsInputState,
  };

  it("validateApplyGate refuses a needs_input winner despite an approved review + clean verify", () => {
    const err = validateApplyGate(vetoInput);
    expect(err).not.toBeNull();
    expect(err).toMatch(/needs more input/i);
  });

  it("deriveApplyEligibility reports a typed needs_input disposition, not applyable", () => {
    const verdict = deriveApplyEligibility(vetoInput);
    expect(verdict.eligible).toBe(false);
    expect(verdict.state).toBe("needs_input");
    // Honest guidance: supply the input and re-run — never a review or risk override.
    expect(verdict.requiredAction ?? "").toMatch(/provide the input/i);
    expect(verdict.requiredAction ?? "").not.toMatch(/accept the risk|run a review/i);
  });

  it("the risk override does NOT bypass the work_state veto (a different axis)", () => {
    const withOverride = {
      ...vetoInput,
      operatorDecision: { action: "accept_risk", patch_sha256: sha256(patch) },
    };
    expect(validateApplyGate(withOverride)).toMatch(/needs more input/i);
    expect(deriveApplyEligibility(withOverride).eligible).toBe(false);
  });

  it("an incomplete work_state is a distinct typed disposition, also non-applyable", () => {
    const incompleteState = { state: "incomplete" as const, source: "constrained" as const };
    const incompleteInput = {
      ...vetoInput,
      decision: DecisionRecord.parse({
        winner: "a01",
        facts: makeOutcomeFacts("succeeded", {
          review: "approved",
          work_state: incompleteState,
        }),
        final_verify: { attempted: true, applied_cleanly: true, gates_passed: true },
      }),
      workState: incompleteState,
    };
    expect(validateApplyGate(incompleteInput)).toMatch(/incomplete/i);
    const verdict = deriveApplyEligibility(incompleteInput);
    expect(verdict.eligible).toBe(false);
    expect(verdict.state).toBe("incomplete");
  });

  it("a completed work_state never vetoes (a clean, applyable run stays applyable)", () => {
    const completedState = { state: "completed" as const, source: "constrained" as const };
    const okInput = {
      ...vetoInput,
      decision: DecisionRecord.parse({
        winner: "a01",
        facts: makeOutcomeFacts("succeeded", { review: "approved", work_state: completedState }),
        final_verify: { attempted: true, applied_cleanly: true, gates_passed: true },
      }),
      workState: completedState,
    };
    expect(validateApplyGate(okInput)).toBeNull();
    expect(deriveApplyEligibility(okInput).eligible).toBe(true);
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

describe("a redacted saved copy can never be applied (INV-062, V4C T3)", () => {
  // Assembled at runtime so no secret-shaped literal lives in this file.
  const secret = ["sk", "g".repeat(24)].join("-");
  const exact = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+${secret}\n`;
  const copy = `# Claudexor: saved copy\n${exact.replace(secret, "[redacted]")}`;
  const approved = DecisionRecord.parse({
    winner: "a01",
    facts: makeOutcomeFacts("succeeded", { review: "approved" }),
    final_verify: { attempted: true, applied_cleanly: true, gates_passed: true },
  });
  const blocked = DecisionRecord.parse({
    winner: "a01",
    facts: makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" }),
    final_verify: null,
  });
  // patch_sha256 is ALWAYS the digest of the exact patch.
  const workProduct = {
    kind: "patch",
    meta: { patch_sha256: sha256(exact), persisted_patch: "redacted" },
  } as never;
  const base = {
    state: "succeeded" as const,
    workProduct,
    originalRepoRoot: process.cwd(),
    targetRepoRoot: process.cwd(),
  };

  it("the digest binding passes the exact patch and refuses the redacted copy", () => {
    expect(validateApplyGate({ ...base, decision: approved, patch: exact })).toBeNull();
    expect(validateApplyGate({ ...base, decision: approved, patch: copy })).toBe(
      "patch artifact hash does not match the recorded work product",
    );
  });

  it("checks integrity BEFORE the override-pending permission on a blocked run", () => {
    // A decision that (wrongly) recorded the COPY's digest used to short-circuit
    // to "deliverable" before the work-product digest was ever compared.
    const overrideOnCopy = { action: "accept_risk", patch_sha256: sha256(copy) };
    expect(
      validateApplyGate({
        ...base,
        decision: blocked,
        patch: copy,
        operatorDecision: overrideOnCopy,
      }),
    ).toBe("patch artifact hash does not match the recorded work product");
    expect(
      deriveApplyEligibility({
        ...base,
        decision: blocked,
        patch: copy,
        operatorDecision: overrideOnCopy,
      }).eligible,
    ).toBe(false);
    // The same override bound to the exact patch is still the JIT-verify unlock.
    const overrideOnExact = { action: "accept_risk", patch_sha256: sha256(exact) };
    expect(
      validateApplyGate({
        ...base,
        decision: blocked,
        patch: exact,
        operatorDecision: overrideOnExact,
      }),
    ).toBeNull();
    // Path confinement is part of the integrity checks the override cannot skip.
    const escaping = "diff --git a/../outside b/../outside\n--- a/../outside\n+++ b/../outside\n";
    expect(
      validateApplyGate({
        ...base,
        workProduct: { kind: "patch", meta: { patch_sha256: sha256(escaping) } } as never,
        decision: blocked,
        patch: escaping,
        operatorDecision: { action: "accept_risk", patch_sha256: sha256(escaping) },
      }),
    ).toMatch(/escapes the target repo/);
  });

  it("answers the one typed message when the exact bytes are unavailable", () => {
    const verdict = validateApplyGate({
      ...base,
      decision: approved,
      patch: copy,
      exactPatchUnavailable: true,
    });
    expect(verdict).toBe(EXACT_PATCH_UNAVAILABLE_MESSAGE);
    expect(verdict).toContain("patch_exact_bytes_unavailable");
    expect(
      deriveApplyEligibility({
        ...base,
        decision: approved,
        patch: copy,
        exactPatchUnavailable: true,
      }).eligible,
    ).toBe(false);
  });
});

describe("'pr' publishes only what the pinned publication scanner passes (INV-146)", () => {
  // Synthetic, assembled at runtime; high-entropy so the scanner's own rules fire.
  const token = `ghp_${"q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2Ae9U"}`;
  const pinned = locateScanner({ env: process.env, configDir: null });

  /** Local Git, a local bare remote, and a fake `gh` transport that records
   * what it was asked to publish. Nothing leaves this machine. */
  async function repoWithRemote(newLine: string) {
    const { repo } = await makePatchRepo();
    const remote = reapMk(join(tmpdir(), "claudexor-delivery-pr-remote-"));
    execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "-q", "origin", "main"]);
    await git(repo, ["fetch", "-q", "origin"]);
    const patch = `diff --git a/NEW.txt b/NEW.txt\nnew file mode 100644\n--- /dev/null\n+++ b/NEW.txt\n@@ -0,0 +1 @@\n+${newLine}\n`;
    const refs = () =>
      execFileSync("git", ["--git-dir", remote, "for-each-ref"], { encoding: "utf8" });
    return { repo, patch, refs };
  }

  /** The engine's spawn PATH prefers HOME-relative bins over system ones, so
   * the fake transport lives in a temporary HOME's `.local/bin`: a real `gh`
   * can never be reached from this test. */
  async function withFakeGh<T>(run: (record: string) => Promise<T>, exitCode = 0): Promise<T> {
    const home = reapMk(join(tmpdir(), "claudexor-fake-gh-home-"));
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const record = join(home, "gh-record.json");
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}\nconst fs=require("fs");const a=process.argv.slice(2);const i=a.indexOf("--body-file");` +
        `fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args:a,body:i>=0?fs.readFileSync(a[i+1],"utf8"):null}));` +
        (exitCode === 0
          ? `console.log("https://example.invalid/pr/1");\n`
          : `console.error("fake gh refused");process.exit(${exitCode});\n`),
    );
    chmodSync(join(bin, "gh"), 0o755);
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      return await run(record);
    } finally {
      process.env.HOME = previous;
    }
  }

  async function unchanged(repo: string, refs: () => string) {
    const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const branches = (await git(repo, ["branch", "--list"])).stdout;
    const remote = refs();
    return async () => {
      expect((await git(repo, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
      expect((await git(repo, ["branch", "--list"])).stdout).toBe(branches);
      expect(existsSync(join(repo, "NEW.txt"))).toBe(false);
      expect(refs()).toBe(remote);
    };
  }

  it("refuses typed and touches nothing when the scanner is not provisioned", async () => {
    const { repo, patch, refs } = await repoWithRemote("ordinary line");
    const check = await unchanged(repo, refs);
    const saved = process.env.CLAUDEXOR_BETTERLEAKS_PATH;
    delete process.env.CLAUDEXOR_BETTERLEAKS_PATH;
    try {
      const res = await verifyAndDeliver(repo, patch, {
        mode: "pr",
        branch: "claudexor/never-published",
        message: "open pr",
        scannerConfigDir: reapMk(join(tmpdir(), "claudexor-no-scanner-")),
      });
      expect(res).toMatchObject({ mode: "pr", applied: false, refused: true, treeMutated: false });
      expect(res.publicationRefusal?.code).toBe("publication_scan_unavailable");
    } finally {
      if (saved === undefined) delete process.env.CLAUDEXOR_BETTERLEAKS_PATH;
      else process.env.CLAUDEXOR_BETTERLEAKS_PATH = saved;
    }
    await check();
  });

  it("treats a binary that is not the pinned build as unavailable, never as clean", async () => {
    const { repo, patch, refs } = await repoWithRemote("ordinary line");
    const check = await unchanged(repo, refs);
    const impostor = join(reapMk(join(tmpdir(), "claudexor-impostor-")), "betterleaks");
    writeFileSync(impostor, `#!/bin/sh\necho "[]" > /dev/null\n`);
    chmodSync(impostor, 0o755);
    const saved = process.env.CLAUDEXOR_BETTERLEAKS_PATH;
    process.env.CLAUDEXOR_BETTERLEAKS_PATH = impostor;
    try {
      const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
      expect(res.refused).toBe(true);
      expect(res.publicationRefusal?.code).toBe("publication_scan_unavailable");
      expect(res.detail).toMatch(/not the pinned Betterleaks/);
    } finally {
      if (saved === undefined) delete process.env.CLAUDEXOR_BETTERLEAKS_PATH;
      else process.env.CLAUDEXOR_BETTERLEAKS_PATH = saved;
    }
    await check();
  });

  it.each(["apply", "branch", "commit"] as const)(
    "allows the local '%s' delivery of a credential-shaped patch without any scan",
    async (mode) => {
      const { repo, patch, refs } = await repoWithRemote(`token = "${token}"`);
      const remoteBefore = refs();
      const res = await verifyAndDeliver(repo, patch, {
        mode,
        branch: "claudexor/local-only",
        message: "local",
        scannerConfigDir: reapMk(join(tmpdir(), "claudexor-no-scanner-")),
      });
      expect(res.applied).toBe(true);
      expect(refs()).toBe(remoteBefore);
    },
  );

  describe.runIf(pinned.ok)("with the pinned Betterleaks binary", () => {
    it("refuses a finding before any branch, commit or push, naming rule and path only", async () => {
      const { repo, patch, refs } = await repoWithRemote(`token = "${token}"`);
      const check = await unchanged(repo, refs);
      let authorized = false;
      const res = await verifyAndDeliver(
        repo,
        patch,
        { mode: "pr", branch: "claudexor/never-published", message: "open pr" },
        [],
        () => {
          authorized = true;
          return null;
        },
      );
      expect(res).toMatchObject({ mode: "pr", applied: false, refused: true, treeMutated: false });
      expect(res.publicationRefusal?.code).toBe("publication_scan_findings");
      expect(res.detail).toMatch(/github-pat in NEW\.txt:1/);
      expect(JSON.stringify(res)).not.toContain(token);
      // The scan is the last gate before the first external send.
      expect(authorized).toBe(true);
      await check();
    });

    it("never repeats a detected secret through the refusal's file location", async () => {
      const { repo, refs } = await repoWithRemote("ordinary line");
      const name = `cfg-${token}.txt`;
      const patch = `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+token = "${token}"\n`;
      const check = await unchanged(repo, refs);
      const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
      expect(res.publicationRefusal?.code).toBe("publication_scan_findings");
      expect(res.detail).toMatch(
        /github-pat in withheld location \(sha256 [0-9a-f]{12}\):1 \(commit [0-9a-f]{12}\)/,
      );
      expect(JSON.stringify(res).includes(token), "the refusal repeats the value").toBe(false);
      await check();
    });

    it("scans earlier unpushed commits: a secret added then deleted is still refused", async () => {
      const { repo, patch, refs } = await repoWithRemote("ordinary line");
      writeFileSync(join(repo, "old.txt"), `token = "${token}"\n`);
      await git(repo, ["add", "old.txt"]);
      await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-qm", "add"]);
      await git(repo, ["rm", "-q", "old.txt"]);
      await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-qm", "rm"]);
      const check = await unchanged(repo, refs);
      const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
      expect(res.publicationRefusal?.code).toBe("publication_scan_findings");
      expect(res.detail).toMatch(/github-pat in old\.txt:1 \(commit [0-9a-f]{12}\)/);
      await check();
    });

    it("bounds the outgoing range by what `origin` advertises, not by any other remote", async () => {
      const { repo, patch, refs } = await repoWithRemote("ordinary line");
      // A commit carrying the fixture exists on a SECONDARY remote only; it is
      // still new to origin, so it is outgoing and must be scanned.
      writeFileSync(join(repo, "side.txt"), `token = "${token}"\n`);
      await git(repo, ["add", "side.txt"]);
      await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-qm", "side"]);
      const mirror = reapMk(join(tmpdir(), "claudexor-delivery-mirror-"));
      execFileSync("git", ["init", "--bare", mirror], { stdio: "pipe" });
      await git(repo, ["remote", "add", "mirror", mirror]);
      await git(repo, ["push", "-q", "mirror", "HEAD:refs/heads/side"]);
      await git(repo, ["fetch", "-q", "mirror"]);
      const check = await unchanged(repo, refs);
      const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
      expect(res.publicationRefusal?.code).toBe("publication_scan_findings");
      expect(res.detail).toMatch(/github-pat in side\.txt:1/);
      await check();
    });

    it("scans commit messages `origin` does not have, even when another remote holds the commit", async () => {
      const { repo, patch, refs } = await repoWithRemote("ordinary line");
      // The fixture is only in a commit MESSAGE (history mode never reads
      // messages), on a commit a secondary remote already holds.
      writeFileSync(join(repo, "notes.txt"), "ordinary notes\n");
      await git(repo, ["add", "notes.txt"]);
      await git(repo, [
        "-c",
        "user.email=t@t.dev",
        "-c",
        "user.name=t",
        "commit",
        "-qm",
        `rotate ${token}`,
      ]);
      const mirror = reapMk(join(tmpdir(), "claudexor-delivery-mirror-"));
      execFileSync("git", ["init", "--bare", mirror], { stdio: "pipe" });
      await git(repo, ["remote", "add", "mirror", mirror]);
      await git(repo, ["push", "-q", "mirror", "HEAD:refs/heads/side"]);
      await git(repo, ["fetch", "-q", "mirror"]);
      const check = await unchanged(repo, refs);
      const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
      expect(res.publicationRefusal?.code).toBe("publication_scan_findings");
      expect(res.detail).toMatch(/github-pat in commit message [0-9a-f]{12}/);
      expect(JSON.stringify(res)).not.toContain(token);
      await check();
    });

    it("refuses a credential an unpublished merge introduced, even after a later commit deletes it", async () => {
      await withFakeGh(async () => {
        const { repo, patch, refs } = await repoWithRemote("ordinary line");
        const id = ["-c", "user.email=t@t.dev", "-c", "user.name=t"];
        await git(repo, ["checkout", "-qb", "side"]);
        writeFileSync(join(repo, "side.txt"), "side\n");
        await git(repo, ["add", "side.txt"]);
        await git(repo, [...id, "commit", "-qm", "side"]);
        await git(repo, ["checkout", "-q", "main"]);
        writeFileSync(join(repo, "main.txt"), "main\n");
        await git(repo, ["add", "main.txt"]);
        await git(repo, [...id, "commit", "-qm", "main2"]);
        await git(repo, [...id, "merge", "-q", "--no-ff", "--no-commit", "side"]);
        writeFileSync(join(repo, "evil.txt"), `token = "${token}"\n`);
        await git(repo, ["add", "evil.txt"]);
        await git(repo, [...id, "commit", "-qm", "merge side"]);
        await git(repo, ["rm", "-q", "evil.txt"]);
        await git(repo, [...id, "commit", "-qm", "rm"]);
        const check = await unchanged(repo, refs);
        const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
        expect(res.publicationRefusal?.code).toBe("publication_scan_findings");
        expect(res.detail).toMatch(/github-pat in evil\.txt:1/);
        expect(JSON.stringify(res)).not.toContain(token);
        await check();
      });
    });

    it("refuses typed when the destination's refs cannot be read", async () => {
      const { repo, patch } = await makePatchRepo();
      const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
      expect(res.refused).toBe(true);
      expect(res.publicationRefusal?.code).toBe("publication_scan_failed");
      expect(res.detail).toMatch(/what 'origin' pushes to already has could not be read/);
      // An unreadable push URL refuses the same way and is never echoed.
      const withRemote = await repoWithRemote("ordinary line");
      const missing = join(reapMk(join(tmpdir(), "claudexor-delivery-gone-")), "missing.git");
      await git(withRemote.repo, ["config", "remote.origin.pushurl", missing]);
      const unreadable = await deliver(withRemote.repo, withRemote.patch, {
        mode: "pr",
        message: "open pr",
      });
      expect(unreadable.publicationRefusal?.code).toBe("publication_scan_failed");
      expect(unreadable.detail).toMatch(/push URL 1 of 1/);
      expect(unreadable.detail).not.toContain(missing);
    });

    /** A second bare repository holding only the `main` origin published (never
     * the local branch, which may already carry newer commits), used as a push URL. */
    async function pushOnlyRepo(repo: string) {
      const bare = reapMk(join(tmpdir(), "claudexor-delivery-pushurl-"));
      execFileSync("git", ["init", "--bare", bare], { stdio: "pipe" });
      await git(repo, ["push", "-q", bare, "refs/remotes/origin/main:refs/heads/main"]);
      const refs = () =>
        execFileSync("git", ["--git-dir", bare, "for-each-ref"], { encoding: "utf8" });
      return { bare, refs };
    }

    it("bounds the range by origin's push URL, not its fetch URL", async () => {
      await withFakeGh(async () => {
        const { repo, patch, refs } = await repoWithRemote("ordinary line");
        // The fetch repository already holds a branch whose history added and
        // then deleted the fixture; the push URL never saw that history.
        writeFileSync(join(repo, "old.txt"), `token = "${token}"\n`);
        await git(repo, ["add", "old.txt"]);
        await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-qm", "add"]);
        await git(repo, ["rm", "-q", "old.txt"]);
        await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-qm", "rm"]);
        await git(repo, ["push", "-q", "origin", "HEAD:refs/heads/side"]);
        const push = await pushOnlyRepo(repo);
        await git(repo, ["config", "remote.origin.pushurl", push.bare]);
        const pushBefore = push.refs();
        const check = await unchanged(repo, refs);
        const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
        expect(res.publicationRefusal?.code).toBe("publication_scan_findings");
        expect(res.detail).toMatch(/github-pat in old\.txt:1 \(commit [0-9a-f]{12}\)/);
        expect(push.refs()).toBe(pushBefore);
        await check();
      });
    });

    it("scans for every push URL `origin` sends to", async () => {
      await withFakeGh(async () => {
        const { repo, patch, refs } = await repoWithRemote("ordinary line");
        writeFileSync(join(repo, "side.txt"), `token = "${token}"\n`);
        await git(repo, ["add", "side.txt"]);
        await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-qm", "side"]);
        await git(repo, ["push", "-q", "origin", "HEAD:refs/heads/side"]);
        // The first push URL already holds the commit; the second never saw it.
        const fetchUrl = (await git(repo, ["remote", "get-url", "origin"])).stdout.trim();
        const second = await pushOnlyRepo(repo);
        await git(repo, ["config", "remote.origin.pushurl", fetchUrl]);
        await git(repo, ["config", "--add", "remote.origin.pushurl", second.bare]);
        const secondBefore = second.refs();
        const check = await unchanged(repo, refs);
        const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
        expect(res.publicationRefusal?.code).toBe("publication_scan_findings");
        expect(res.detail).toMatch(/github-pat in side\.txt:1/);
        expect(second.refs()).toBe(secondBefore);
        await check();
      });
    });

    it("publishes exactly the scanned commit object to the push URL", async () => {
      const { repo, patch, refs } = await repoWithRemote("ordinary line");
      const push = await pushOnlyRepo(repo);
      await git(repo, ["config", "remote.origin.pushurl", push.bare]);
      const fetchBefore = refs();
      await withFakeGh(async () => {
        const res = await deliver(repo, patch, {
          mode: "pr",
          branch: "claudexor/pushurl",
          message: "open pr",
        });
        expect(res).toMatchObject({ mode: "pr", applied: true, branch: "claudexor/pushurl" });
        expect(push.refs()).toContain(`${res.commit} commit\trefs/heads/claudexor/pushurl`);
        expect(refs()).toBe(fetchBefore);
        expect((await git(repo, ["config", "branch.claudexor/pushurl.merge"])).stdout.trim()).toBe(
          "refs/heads/claudexor/pushurl",
        );
      });
    });

    it("does not rescan history `origin` already advertises", async () => {
      const { repo, patch } = await repoWithRemote("ordinary line");
      // Already published: the destination advertises this commit, so it is
      // not part of what this delivery sends.
      writeFileSync(join(repo, "public.txt"), `token = "${token}"\n`);
      await git(repo, ["add", "public.txt"]);
      await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-qm", "pub"]);
      await git(repo, ["push", "-q", "origin", "HEAD:main"]);
      await withFakeGh(async () => {
        const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
        expect(res.refused ?? false).toBe(false);
        expect(res).toMatchObject({ mode: "pr", applied: true });
      });
    });

    it("does not let the outgoing worktree's ignore file suppress its own finding", async () => {
      const { repo, patch, refs } = await repoWithRemote("ordinary line");
      writeFileSync(join(repo, "old.txt"), `token = "${token}"\n`);
      await git(repo, ["add", "old.txt"]);
      await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-qm", "add"]);
      const sha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
      // The exact Betterleaks git fingerprint of that finding, at the root.
      for (const name of [".gitleaksignore", ".betterleaksignore"])
        writeFileSync(join(repo, name), `${sha}:old.txt:github-pat:1\n`);
      await git(repo, ["add", ".gitleaksignore", ".betterleaksignore"]);
      await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-qm", "ign"]);
      const check = await unchanged(repo, refs);
      const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
      expect(res.publicationRefusal?.code).toBe("publication_scan_findings");
      expect(res.detail).toMatch(/github-pat in old\.txt:1/);
      await check();
    });

    it("scans the PR body and refuses a finding there", async () => {
      const { repo, patch, refs } = await repoWithRemote("ordinary line");
      const body = join(reapMk(join(tmpdir(), "claudexor-pr-body-src-")), "body.md");
      writeFileSync(body, `Notes\n\ntoken = "${token}"\n`);
      const check = await unchanged(repo, refs);
      const res = await deliver(repo, patch, { mode: "pr", message: "open pr", prBodyFile: body });
      expect(res.detail).toMatch(/github-pat in pull request body/);
      await check();
    });

    it("reports a failed push honestly after a clean scan; the local commit is kept", async () => {
      const { repo, patch, refs } = await repoWithRemote("ordinary line");
      const remote = (await git(repo, ["remote", "get-url", "origin"])).stdout.trim();
      writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(remote, "hooks", "pre-receive"), 0o755);
      const remoteBefore = refs();
      const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
      expect(res.applied).toBe(false);
      expect(res.commit).toBeTruthy();
      expect(res.detail).toContain("push failed");
      expect(refs()).toBe(remoteBefore);
    });

    it("reports a pushed branch as applied when PR creation fails", async () => {
      const { repo, patch, refs } = await repoWithRemote("ordinary line");
      await withFakeGh(async () => {
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
        expect(refs()).toContain(`${res.commit} commit\trefs/heads/claudexor/pr-failure-receipt`);
      }, 1);
    });

    it("publishes a clean change and hands gh the exact scanned body copy", async () => {
      const { repo, patch, refs } = await repoWithRemote("ordinary line");
      const body = join(reapMk(join(tmpdir(), "claudexor-pr-body-src-")), "body.md");
      writeFileSync(body, "A clean description.\n");
      await withFakeGh(async (record) => {
        const res = await deliver(repo, patch, {
          mode: "pr",
          branch: "claudexor/clean",
          message: "open pr",
          prBodyFile: body,
        });
        expect(res).toMatchObject({ mode: "pr", applied: true, branch: "claudexor/clean" });
        expect(res.prUrl).toBe("https://example.invalid/pr/1");
        expect(refs()).toContain("refs/heads/claudexor/clean");
        const gh = JSON.parse(readFileSync(record, "utf8")) as { args: string[]; body: string };
        expect(gh.body).toBe("A clean description.\n");
        expect(gh.args[gh.args.indexOf("--body-file") + 1]).not.toBe(body);
      });
    });
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

  // Round-2 #2: the reverse-clean no-op shortcut is honest ONLY for mode='apply'.
  // A commit/branch/pr requested over an already-applied working tree must NOT
  // report success without creating the commit/branch/PR.
  for (const mode of ["commit", "branch", "pr"] as const) {
    it(`apply then --mode ${mode} on the applied tree is an honest typed refusal, not a false success`, async () => {
      const { repo, patch } = await makePatchRepo();
      // First deliver the patch to the working tree (mode='apply').
      const applied = await verifyAndDeliver(repo, patch, { mode: "apply", protectedApply: true });
      expect(applied.applied).toBe(true);
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");

      // Now request a fenced commit/branch/pr over that already-applied tree.
      // The forward patch no longer applies (tree is the postimage) and reverse
      // is clean — the OLD code returned mode='<mode>' applied:true /
      // alreadyApplied:true while creating NOTHING.
      const res = await verifyAndDeliver(repo, patch, { mode });
      expect(res.applied).toBe(false);
      expect(res.alreadyApplied ?? false).toBe(false);
      expect(res.refused).toBe(true);
      expect(res.treeMutated ?? false).toBe(false);
      expect(res.detail).toMatch(/already present in the working tree/i);
      // No commit was fabricated: HEAD still points at the single init commit.
      const log = (await git(repo, ["log", "--oneline"])).stdout.trim().split("\n");
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(/init$/);
    });
  }
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
