import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCapture } from "@claudexor/core";
import { checkPatch, deliver } from "./index.js";

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
});
