import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "./manager.js";
import { directoryPreparation } from "./directory-workspace.js";

// #563: what an isolated directory copy held when it was prepared comes from the
// copy's own baseline. A selected path is missing only when it was not there; an
// empty directory or a symbolic link that was copied is present.
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function prepared(scopePaths: string[] | undefined, inPlace = false) {
  const root = await mkdtemp(join(tmpdir(), "claudexor-directory-prep-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "dir", "empty"), { recursive: true });
  await writeFile(join(source, "input.txt"), "selected\n");
  await writeFile(join(source, "unselected.txt"), "not selected\n");
  if (process.platform !== "win32") await symlink("input.txt", join(source, "link"));
  const manager = new WorkspaceManager(source, { runtimeRoot: join(root, "runtime") });
  const env = await manager.create({
    taskId: "t",
    attemptId: "a01",
    workspaceKind: "directory",
    inPlace,
    ...(scopePaths === undefined ? {} : { scopePaths }),
  });
  return { source, env, fact: await directoryPreparation(env), tree: env.worktree_path };
}

describe("directoryPreparation", () => {
  it.each([
    ["omitted", undefined, { files: 0, directories: 0, symlinks: 0 }, []],
    ["empty", [], { files: 0, directories: 0, symlinks: 0 }, []],
    [
      "missing only",
      ["new-output.txt"],
      { files: 0, directories: 0, symlinks: 0 },
      ["new-output.txt"],
    ],
    [
      "partial",
      ["input.txt", "new-output.txt"],
      { files: 1, directories: 0, symlinks: 0 },
      ["new-output.txt"],
    ],
    [
      "missing below an existing directory",
      ["dir/later.txt"],
      { files: 0, directories: 1, symlinks: 0 },
      ["dir/later.txt"],
    ],
    ["existing file", ["input.txt"], { files: 1, directories: 0, symlinks: 0 }, []],
    ["existing empty directory", ["dir/empty"], { files: 0, directories: 2, symlinks: 0 }, []],
  ] as const)("%s", async (_name, scope, copied, missing) => {
    const { source, fact, tree } = await prepared(scope === undefined ? undefined : [...scope]);
    expect(fact).toEqual({
      source_root: source,
      scope_paths: scope ?? [],
      copied,
      missing_paths: missing,
    });
    // The fact matches what the copy actually holds, never the unselected sibling.
    await expect(lstat(join(tree, "unselected.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of missing)
      await expect(lstat(join(tree, path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("'.' copies the whole folder and names nothing missing", async () => {
    const { fact, tree } = await prepared(["."]);
    expect(fact).toMatchObject({
      scope_paths: ["."],
      copied: { files: 2, directories: 2, symlinks: process.platform === "win32" ? 0 : 1 },
      missing_paths: [],
    });
    expect((await readdir(tree)).sort()).toEqual(
      [
        "dir",
        "input.txt",
        "unselected.txt",
        ...(process.platform === "win32" ? [] : ["link"]),
      ].sort(),
    );
  });

  it.skipIf(process.platform === "win32")(
    "a selected symbolic link is present and copied as a link",
    async () => {
      const { fact, tree } = await prepared(["link"]);
      expect(fact).toMatchObject({
        copied: { files: 0, directories: 0, symlinks: 1 },
        missing_paths: [],
      });
      expect((await lstat(join(tree, "link"))).isSymbolicLink()).toBe(true);
      // Its target was not selected, so it was not copied.
      await expect(lstat(join(tree, "input.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("live directory work has no prepared copy", async () => {
    expect((await prepared(["input.txt"], true)).fact).toBeNull();
  });
});
