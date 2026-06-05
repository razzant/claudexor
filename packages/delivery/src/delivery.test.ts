import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCapture } from "@claudex/core";
import { checkPatch, deliver } from "./index.js";

async function git(repo: string, args: string[]) {
  return runCapture("git", ["-C", repo, ...args], { timeoutMs: 30_000 });
}

async function makePatchRepo(): Promise<{ repo: string; patch: string }> {
  const repo = mkdtempSync(join(tmpdir(), "claudex-deliver-"));
  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-m", "init"]);
  writeFileSync(join(repo, "a.txt"), "two\n");
  const diff = (await git(repo, ["diff"])).stdout;
  await git(repo, ["checkout", "--", "a.txt"]); // revert; keep the patch
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
    expect(res.branch).toMatch(/^claudex\//);
    expect(res.commit).toBeTruthy();
    const branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    expect(branch).toBe(res.branch);
  });

  it("artifact_only never mutates the tree", async () => {
    const { repo, patch } = await makePatchRepo();
    const res = await deliver(repo, patch, { mode: "artifact_only" });
    expect(res.applied).toBe(false);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
  });
});
