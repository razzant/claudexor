import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "./manager.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cx-ro-"));
  roots.push(root);
  const source = join(root, "source"),
    runtime = join(root, "runtime");
  await mkdir(source);
  await writeFile(join(source, "input.txt"), "original source\n");
  return { source, runtime, manager: new WorkspaceManager(source, { runtimeRoot: runtime }) };
}

describe("readonly live directory preparation", () => {
  it("keeps the source and scoped home without creating a file baseline", async () => {
    const f = await fixture();
    const env = await f.manager.create({
      taskId: "task",
      attemptId: "a01",
      workspaceKind: "directory",
      inPlace: true,
      scopePaths: ["."],
      accessProfile: "readonly",
    });
    expect(env).toMatchObject({
      worktree_path: f.source,
      repo_root: f.source,
      policy_profile: "readonly",
      workspace_kind: "directory",
      scope_paths: ["."],
      base_sha: null,
    });
    expect((await stat(env.home_dir)).isDirectory()).toBe(true);
    const entries = await readdir(join(f.runtime, "workspaces/task/a01"));
    expect(entries).not.toContain("directory-baseline.json");
    expect(entries).not.toContain("baseline");
    expect(await readdir(f.source)).toEqual(["input.txt"]);
  });

  it("still materializes the selected inputs for an isolated readonly directory", async () => {
    const f = await fixture();
    const env = await f.manager.create({
      taskId: "task",
      attemptId: "a01",
      workspaceKind: "directory",
      inPlace: false,
      scopePaths: ["input.txt"],
      accessProfile: "readonly",
    });
    expect(env.worktree_path).not.toBe(f.source);
    expect(await readFile(join(env.worktree_path, "input.txt"), "utf8")).toBe("original source\n");
    expect(await readdir(join(f.runtime, "workspaces/task/a01"))).toContain(
      "directory-baseline.json",
    );
  });

  it.skipIf(process.platform === "win32")(
    "does not traverse a socket for readonly, but preserves writable refusal",
    async () => {
      const f = await fixture();
      const socket = createServer();
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(join(f.source, "s"), resolve);
      });
      try {
        await expect(
          f.manager.create({
            taskId: "task",
            attemptId: "reader",
            workspaceKind: "directory",
            inPlace: true,
            scopePaths: ["."],
            accessProfile: "readonly",
          }),
        ).resolves.toMatchObject({ worktree_path: f.source, policy_profile: "readonly" });
        await expect(
          f.manager.create({
            taskId: "task",
            attemptId: "writer",
            workspaceKind: "directory",
            inPlace: true,
            scopePaths: ["."],
            accessProfile: "workspace_write",
          }),
        ).rejects.toThrow("Unsupported filesystem entry:");
      } finally {
        await new Promise<void>((resolve, reject) =>
          socket.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
