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
import { checkPatch, deliver, validateApplyGate, verifyAndDeliver } from "./index.js";

async function git(repo: string, args: string[]) {
  return runCapture("git", ["-C", repo, ...args], { timeoutMs: 30_000 });
}

async function makePatchRepo(): Promise<{ repo: string; patch: string }> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-deliver-"));
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
  const repo = mkdtempSync(join(tmpdir(), "claudexor-deliver-"));
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
    const repo = mkdtempSync(join(tmpdir(), "claudexor-delivery-lease-"));
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

    const markerDir = mkdtempSync(join(tmpdir(), "claudexor-delivery-lease-marker-"));
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
    const wrapperDir = mkdtempSync(join(tmpdir(), "claudexor-git-wrapper-"));
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
    const remote = mkdtempSync(join(tmpdir(), "claudexor-delivery-remote-"));
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
    expect(err).toContain("not applyable while lifecycle is failed");
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
    expect(err).toBe("fresh final verify is required before apply");
  });
});

const gitq = (repo: string, args: string[]): void => {
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: "pipe",
  });
};

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-deliver-prot-"));
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
    expect(err).toContain("did not apply onto a fresh tree");
  });

  it("refuses apply when verify gates failed (override path exists for blocked runs)", () => {
    const err = gateWith({ attempted: true, applied_cleanly: true, gates_passed: false });
    expect(err).toContain("deterministic gates failed");
  });

  it("passes only when final verify is green; missing or unattempted verification fails closed", () => {
    expect(gateWith({ attempted: true, applied_cleanly: true, gates_passed: true })).toBeNull();
    expect(gateWith({ attempted: false, reason: "no base sha" })).toContain("fresh final verify");
    expect(gateWith(null)).toContain("fresh final verify");
  });

  it("FAILS CLOSED when the verifier ERRORED (applied_cleanly=null): refuses without an override, allows with accept_risk on the BLOCKED run", () => {
    const errored = { attempted: true, applied_cleanly: null, reason: "worktree add failed" };
    const refusal = gateWith(errored);
    expect(refusal).toContain("verifier errored");
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
