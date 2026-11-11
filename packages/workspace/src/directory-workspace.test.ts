import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "./manager.js";
import { applyWorkspaceFiles, readWorkspaceFilesManifest } from "./files-apply.js";
import { readWorkspaceFile } from "./files-io.js";
import { git } from "./git.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claudexor-directory-test-"));
  roots.push(root);
  const source = join(root, "source"),
    run = join(root, "run"),
    runtime = join(root, "runtime");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "a.txt"), "before\r\n");
  await writeFile(join(source, "unselected.txt"), "not copied");
  return {
    root,
    source,
    run,
    runtime,
    manager: new WorkspaceManager(source, { runtimeRoot: runtime }),
  };
}

describe("ordinary directory workspaces", () => {
  it("runs directly without a full baseline copy and retains observed large binary bytes after disposal", async () => {
    const f = await fixture();
    const env = await f.manager.create({
      taskId: "t",
      attemptId: "a",
      workspaceKind: "directory",
      inPlace: true,
    });
    expect(env).toMatchObject({
      worktree_path: f.source,
      base_sha: null,
      base_ref: null,
      branch_name: null,
    });
    const base = join(f.runtime, "workspaces/t/a");
    expect(await readdir(base)).not.toContain("baseline");
    const output = await open(join(f.source, "large.bin"), "w");
    await output.truncate(34 * 1024 * 1024);
    await output.close();
    const captured = await f.manager.captureFiles(env, f.run, { observedPaths: ["large.bin"] });
    expect(captured.changedPaths).toEqual(["large.bin"]);
    expect(captured.manifest.entries[0]?.before).toBe("unknown");
    expect(captured.manifest.scopePaths).toEqual([]);
    const bytes = captured.manifest.entries[0]!.after;
    expect(bytes?.kind).toBe("file");
    if (bytes?.kind !== "file") throw new Error("expected bytes");
    expect((await stat(join(f.run, bytes.artifactPath!))).size).toBe(34 * 1024 * 1024);
    await expect(f.manager.diff(env)).rejects.toThrow("captureFiles");
    await f.manager.dispose(env);
    expect(
      await readWorkspaceFilesManifest(f.run, captured.manifestPath, captured.manifestSha256),
    ).toEqual(captured.manifest);
    expect((await stat(join(f.source, "large.bin"))).size).toBe(34 * 1024 * 1024);
    expect(await readdir(f.source)).not.toContain(".git");
    expect(await applyWorkspaceFiles(f.source, captured.manifest, f.run)).toMatchObject({
      applied: false,
      treeMutated: false,
    });
  });

  it("copies the full selected footprint, captures new outputs, and applies complete files without Git", async () => {
    const f = await fixture();
    await mkdir(join(f.source, "src/empty"));
    await symlink("a.txt", join(f.source, "src/link"));
    const env = await f.manager.create({
      taskId: "t",
      attemptId: "a",
      workspaceKind: "directory",
      scopePaths: ["src/a.txt", "src"],
    });
    expect(await readdir(env.worktree_path)).toEqual(["src"]);
    await writeFile(join(env.worktree_path, "src/a.txt"), "after\r\n");
    await writeFile(join(env.worktree_path, "new.bin"), Buffer.from([0, 255, 13, 10]));
    const captured = await f.manager.captureFiles(env, f.run);
    expect(captured.manifest.entries.map((entry) => entry.path)).toContain("src/empty");
    expect(captured.changedPaths).toEqual(["new.bin", "src/a.txt"]);
    expect(await readFile(join(f.source, "src/a.txt"), "utf8")).toBe("before\r\n");
    await f.manager.dispose(env);
    expect(await applyWorkspaceFiles(f.source, captured.manifest, f.run)).toMatchObject({
      applied: true,
      treeMutated: true,
    });
    expect(await readFile(join(f.source, "src/a.txt"), "utf8")).toBe("after\r\n");
    expect(await readFile(join(f.source, "new.bin"))).toEqual(Buffer.from([0, 255, 13, 10]));
    expect(await readFile(join(f.source, "unselected.txt"), "utf8")).toBe("not copied");
    expect(await applyWorkspaceFiles(f.source, captured.manifest, f.run)).toMatchObject({
      applied: true,
      alreadyApplied: true,
      treeMutated: false,
    });
    expect(await readdir(f.source)).not.toContain(".git");
  });

  it("refuses a concurrent edit or corrupt artifact before altering any selected file", async () => {
    const f = await fixture();
    const env = await f.manager.create({
      taskId: "t",
      attemptId: "a",
      workspaceKind: "directory",
      scopePaths: ["src"],
    });
    await writeFile(join(env.worktree_path, "src/a.txt"), "prepared");
    await writeFile(join(env.worktree_path, "new.txt"), "new");
    const captured = await f.manager.captureFiles(env, f.run);
    await writeFile(join(f.source, "src/a.txt"), "concurrent");
    expect(await applyWorkspaceFiles(f.source, captured.manifest, f.run)).toMatchObject({
      applied: false,
      treeMutated: false,
    });
    expect(await readFile(join(f.source, "src/a.txt"), "utf8")).toBe("concurrent");
    expect(await readdir(f.source)).not.toContain("new.txt");
    await writeFile(join(f.source, "src/a.txt"), "before\r\n");
    const item = captured.manifest.entries.find((entry) => entry.path === "new.txt")!.after;
    if (item?.kind !== "file") throw new Error("expected bytes");
    await writeFile(join(f.run, item.artifactPath!), "corrupt");
    expect(await applyWorkspaceFiles(f.source, captured.manifest, f.run)).toMatchObject({
      applied: false,
      treeMutated: false,
    });
  });

  it("preserves deletions and file/directory replacements using exact preimages", async () => {
    const f = await fixture();
    const env = await f.manager.create({
      taskId: "t",
      attemptId: "a",
      workspaceKind: "directory",
      scopePaths: ["src"],
    });
    await rm(join(env.worktree_path, "src/a.txt"));
    await mkdir(join(env.worktree_path, "src/a.txt"));
    await writeFile(join(env.worktree_path, "src/a.txt/nested"), "replacement");
    const first = await f.manager.captureFiles(env, f.run);
    expect(await applyWorkspaceFiles(f.source, first.manifest, f.run)).toMatchObject({
      applied: true,
    });
    const next = await f.manager.create({
      taskId: "t",
      attemptId: "b",
      workspaceKind: "directory",
      scopePaths: ["src"],
    });
    await rm(join(next.worktree_path, "src"), { recursive: true });
    await writeFile(join(next.worktree_path, "src"), "file now");
    const second = await f.manager.captureFiles(next, join(f.root, "run2"));
    expect(
      await applyWorkspaceFiles(f.source, second.manifest, join(f.root, "run2")),
    ).toMatchObject({ applied: true });
    expect(await readFile(join(f.source, "src"), "utf8")).toBe("file now");
  });

  it("keeps direct changes and owned cleanup separate after orphan recovery", async () => {
    const f = await fixture();
    const env = await f.manager.create({
      taskId: "t",
      attemptId: "a",
      workspaceKind: "directory",
      inPlace: true,
      scopePaths: ["src"],
    });
    await writeFile(join(f.source, "src/a.txt"), "live result");
    await f.manager.captureFiles(env, f.run);
    await new WorkspaceManager(f.source, { runtimeRoot: f.runtime }).disposeOrphan("t", "a");
    expect(await readWorkspaceFile(join(f.source, "src/a.txt"))).toMatchObject({ kind: "file" });
    expect(await readFile(join(f.source, "src/a.txt"), "utf8")).toBe("live result");
  });

  it("retains an output colliding with an unselected source without fabricating its baseline", async () => {
    const f = await fixture();
    const env = await f.manager.create({
      taskId: "t",
      attemptId: "a",
      workspaceKind: "directory",
      scopePaths: ["src"],
    });
    await writeFile(join(env.worktree_path, "unselected.txt"), "candidate output");
    await writeFile(join(env.worktree_path, "new.txt"), "safe new output");
    const captured = await f.manager.captureFiles(env, f.run);
    expect(captured.manifest.entries.find((entry) => entry.path === "unselected.txt")?.before).toBe(
      "unknown",
    );
    expect(await applyWorkspaceFiles(f.source, captured.manifest, f.run)).toMatchObject({
      applied: true,
      treeMutated: true,
      appliedPaths: ["new.txt"],
    });
    expect(await readFile(join(f.source, "new.txt"), "utf8")).toBe("safe new output");
    expect(
      await applyWorkspaceFiles(f.source, captured.manifest, f.run, ["new.txt"]),
    ).toMatchObject({ applied: true });
    expect(await readFile(join(f.source, "unselected.txt"), "utf8")).toBe("not copied");
  });

  it("keeps an unobserved direct effect unknown and records an observed deletion", async () => {
    const f = await fixture();
    const env = await f.manager.create({
      taskId: "t",
      attemptId: "a",
      workspaceKind: "directory",
      inPlace: true,
    });
    const empty = await f.manager.captureFiles(env, f.run);
    expect(empty.noChanges).toBeNull();
    await rm(join(f.source, "unselected.txt"));
    const captured = await f.manager.captureFiles(env, join(f.root, "run2"), {
      observedPaths: ["unselected.txt"],
    });
    expect(captured.noChanges).toBeNull();
    expect(captured.manifest.entries).toEqual([
      { path: "unselected.txt", before: "unknown", after: null },
    ]);
  });
});

// A vendor state root (auth, config, sessions) inside a selected project folder
// is ordinary project content (INV-146): it is copied, captured and published
// like any other folder. The credential-store path class only guards imports
// of arbitrary host files.
describe("vendor state directories in a selected folder", () => {
  it.each([".grok", ".claude"])(
    "copies and captures a selected %s directory like any other project folder (INV-146)",
    async (dir) => {
      const f = await fixture();
      await mkdir(join(f.source, dir, "sessions"), { recursive: true });
      await writeFile(join(f.source, dir, "config.toml"), "[cli]\n");
      await writeFile(join(f.source, dir, "sessions", "s.jsonl"), '{"role":"user"}\n');
      const copied = await f.manager.create({
        taskId: "t",
        attemptId: "copy",
        workspaceKind: "directory",
        scopePaths: ["."],
      });
      expect(await readFile(join(copied.worktree_path, dir, "config.toml"), "utf8")).toBe(
        "[cli]\n",
      );
      await writeFile(join(copied.worktree_path, dir, "config.toml"), "[cli]\nx = 1\n");
      const captured = await f.manager.captureFiles(copied, join(f.root, "run-copy"));
      expect(captured.changedPaths).toEqual([`${dir}/config.toml`]);
      const live = await f.manager.create({
        taskId: "t",
        attemptId: "live",
        workspaceKind: "directory",
        inPlace: true,
        scopePaths: ["."],
      });
      await writeFile(join(f.source, "src", "a.txt"), "live\r\n");
      const direct = await f.manager.captureFiles(live, join(f.root, "run-live"));
      expect(direct.changedPaths).toContain("src/a.txt");
      expect(direct.manifest.entries.some((entry) => entry.path.startsWith(dir))).toBe(true);
    },
  );

  it("copies an ordinary dot-directory in the same whole-folder scope (control)", async () => {
    const f = await fixture();
    await mkdir(join(f.source, ".github"));
    await writeFile(join(f.source, ".github", "config.toml"), "[cli]\n");
    const env = await f.manager.create({
      taskId: "t",
      attemptId: "a",
      workspaceKind: "directory",
      scopePaths: ["."],
    });
    expect(await readFile(join(env.worktree_path, ".github", "config.toml"), "utf8")).toBe(
      "[cli]\n",
    );
    expect((await f.manager.captureFiles(env, f.run)).noChanges).toBe(true);
  });

  it("does not refuse a Git-backed run over a tracked .grok directory (control)", async () => {
    const f = await fixture();
    await mkdir(join(f.source, ".grok"));
    await writeFile(join(f.source, ".grok", "config.toml"), "[cli]\n");
    for (const args of [
      ["init", "-b", "main"],
      ["add", "-A"],
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"],
    ])
      await git(f.source, args);
    const manager = new WorkspaceManager(f.source, { runtimeRoot: f.runtime });
    const env = await manager.create({ taskId: "t", attemptId: "git", baseRef: "HEAD" });
    await writeFile(join(env.worktree_path, "src", "a.txt"), "after\n");
    expect(await manager.diff(env)).toContain("src/a.txt");
    await manager.dispose(env);
  });
});
