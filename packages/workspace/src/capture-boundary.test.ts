/** INV-074: capture follows the physical execution root, never a path's
 * spelling. A host write outside the root is not captured, yet capture and
 * disposal neither refuse nor remove it; a root under `/tmp` is ordinary. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { WorkspaceManager } from "./manager.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function scratch(parent: string, prefix: string): string {
  const dir = mkdtempSync(join(parent, prefix));
  roots.push(dir);
  return dir;
}

async function gitProject(parent: string): Promise<string> {
  const repo = scratch(parent, "claudexor-capture-root-");
  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# project\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=Test", "commit", "-m", "init"]);
  return repo;
}

/** An absolute host write beside the root, as a harness might make one. */
function hostWrite(parent: string): string {
  const path = join(scratch(parent, "claudexor-host-effect-"), "host-effect.txt");
  writeFileSync(path, "host side effect\n");
  return path;
}

describe("capture follows the physical execution root (INV-074)", () => {
  it("an isolated envelope captures its worktree, never an absolute host write outside it", async () => {
    const repo = await gitProject(tmpdir());
    const manager = new WorkspaceManager(repo);
    const env = await manager.create({ taskId: "t-boundary", attemptId: "a01", baseRef: "HEAD" });
    writeFileSync(join(env.worktree_path, "inside.txt"), "project work\n");
    const outside = hostWrite(tmpdir());
    const diff = await manager.diff(env);
    expect(diff).toContain("+project work");
    expect(diff).not.toContain("host-effect");
    expect(diff).not.toContain("host side effect");
    await manager.dispose(env);
    expect(readFileSync(outside, "utf8")).toBe("host side effect\n");
  });

  it.skipIf(process.platform === "win32")(
    "a project rooted under /tmp is an ordinary in-place execution root",
    async () => {
      const repo = await gitProject("/tmp");
      const manager = new WorkspaceManager(repo);
      const env = await manager.create({ taskId: "t-tmp-root", attemptId: "a01", inPlace: true });
      expect(env.worktree_path).toBe(repo);
      mkdirSync(join(repo, "tmp"));
      writeFileSync(join(repo, "tmp", "report.txt"), "project-local tmp output\n");
      const outside = hostWrite("/tmp");
      const diff = await manager.diff(env);
      expect(diff).toContain("tmp/report.txt");
      expect(diff).toContain("+project-local tmp output");
      expect(diff).not.toContain("host-effect");
      await manager.dispose(env);
      expect(existsSync(join(repo, "tmp", "report.txt"))).toBe(true);
      expect(readFileSync(outside, "utf8")).toBe("host side effect\n");
    },
  );

  it("a copied directory workspace records its own outputs, never an outside write", async () => {
    const root = scratch(tmpdir(), "claudexor-capture-directory-");
    const source = join(root, "source");
    mkdirSync(source);
    writeFileSync(join(source, "input.txt"), "selected input\n");
    const manager = new WorkspaceManager(source, { runtimeRoot: join(root, "runtime") });
    const env = await manager.create({
      taskId: "t-directory",
      attemptId: "a01",
      workspaceKind: "directory",
      scopePaths: ["input.txt"],
    });
    writeFileSync(join(env.worktree_path, "output.txt"), "directory output\n");
    const outside = hostWrite(root);
    const captured = await manager.captureFiles(env, join(root, "run"));
    expect(captured.changedPaths).toEqual(["output.txt"]);
    await manager.dispose(env);
    expect(readFileSync(outside, "utf8")).toBe("host side effect\n");
  });
});
