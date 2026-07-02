import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCapture } from "@claudexor/core";
import { DecisionRecord } from "@claudexor/schema";
import { checkPatch, deliver, validateApplyGate } from "./index.js";

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

  it("artifact_only never mutates the tree", async () => {
    const { repo, patch } = await makePatchRepo();
    const res = await deliver(repo, patch, { mode: "artifact_only" });
    expect(res.applied).toBe(false);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
  });

  it("refuses commit delivery when unrelated worktree changes are present", async () => {
    const { repo, patch } = await makePatchRepo();
    writeFileSync(join(repo, "unrelated.txt"), "secret local work\n");
    const res = await deliver(repo, patch, { mode: "commit", message: "apply two" });
    expect(res.applied).toBe(false);
    expect(res.detail).toContain("working tree is dirty");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
  });

  it("pr delivery reports failure when the terminal push step fails", async () => {
    const { repo, patch } = await makePatchRepo();
    const res = await deliver(repo, patch, { mode: "pr", message: "open pr" });
    expect(res.applied).toBe(false);
    expect(res.commit).toBeTruthy();
    expect(res.detail).toContain("push failed");
  });

  // CLI/daemon parity: the artifact-only CLI apply feeds work_product.meta.status
  // into this gate, so a recorded non-succeeded terminal state is refused even
  // when decision.status=success — the v0.12 convergence stale-diff + D2 case
  // where decision is success but the run terminal stayed not_converged.
  it("refuses apply for a non-succeeded recorded terminal state despite a success decision", () => {
    const decision = DecisionRecord.parse({ winner: "a01", status: "success", outcome: "ready" });
    const err = validateApplyGate({
      state: "not_converged",
      decision,
      workProduct: null,
      patch: "diff --git a/x b/x\n",
      originalRepoRoot: "/x",
      targetRepoRoot: "/x",
    });
    expect(err).toContain("not applyable while state is not_converged");
  });

  it("a succeeded state with a success decision is NOT refused by the state/decision checks", () => {
    const decision = DecisionRecord.parse({ winner: "a01", status: "success", outcome: "ready" });
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
    expect(err).toBe("work product is required before apply");
  });
});

const gitq = (repo: string, args: string[]): void => {
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });
};

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-deliver-prot-"));
  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  gitq(repo, ["add", "-A"]);
  gitq(repo, ["commit", "-qm", "init"]);
  return repo;
}

describe("protected apply path (T3.2#3/#6)", () => {
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
    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    expect(head).not.toBe("claudexor/scratch-x");
    const branches = execFileSync("git", ["branch", "--list", "claudexor/scratch-x"], { cwd: repo, encoding: "utf8" });
    expect(branches.trim()).toBe("");
  });

  it("commit delivery stages successfully when the project gitignores .claudexor and a stray evidence dir exists", async () => {
    const repo = await initRepo();
    // The seeded-gitignore case: Claudexor-initialized repos ignore .claudexor;
    // the old :(exclude) pathspec HARD-ERRORED here and delivery refused on a
    // stray evidence dir. Both must be non-issues now.
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
    expect(res.detail ?? "").toBe("");
    expect(res.applied).toBe(true);
    const show = execFileSync("git", ["show", "--stat", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" });
    expect(show).toContain("added.txt");
    expect(show).not.toContain(".claudexor-review-evidence");
  });
});
