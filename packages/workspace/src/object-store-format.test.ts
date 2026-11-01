import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureWorkingTreeTransient } from "./git.js";
import { GitOperationError } from "./git-observed.js";
import { WorkspaceManager } from "./manager.js";
import {
  importIntoRepository,
  objectStorePath,
  retainInObjectStore,
  storeEnv,
} from "./object-store.js";

// #535 round 9: one object store serves all of a project's execution roots, so
// one project keeps one Git object format. A repository of the other format is
// refused, typed and naming both formats, before its objects or a store of its
// format are made, and no foreign-format store is ever read or mounted.
let alternatesSeen: string[] | null = null;
vi.mock("@claudexor/core", async (original) => {
  const core = await original<typeof import("@claudexor/core")>();
  return {
    ...core,
    runCaptureRaw: (...args: Parameters<typeof core.runCaptureRaw>) => {
      const alternates = args[2]?.env?.["GIT_ALTERNATE_OBJECT_DIRECTORIES"];
      if (alternatesSeen && typeof alternates === "string") alternatesSeen.push(alternates);
      return core.runCaptureRaw(...args);
    },
  };
});

const dirs: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = temp("cx-format-config-");
});
afterEach(() => {
  alternatesSeen = null;
  if (configDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
});
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
/** Auto-maintenance a command starts here finishes before it returns: since Git 2.55 a
 * detached one keeps `objects/maintenance.lock` after `git commit`, which the object
 * inventory would read as a write. */
const git = (repo: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", ["-C", repo, "-c", "maintenance.autoDetach=false", ...args], {
    env: { ...ENV, ...env },
  })
    .toString("utf8")
    .trim();

type Format = "sha1" | "sha256";
/** A repository of `format` with one commit, and a change in its work tree. */
function repo(format: Format): string {
  const dir = temp(`cx-format-${format}-`);
  git(dir, ["init", "-q", "-b", "main", `--object-format=${format}`]);
  writeFileSync(join(dir, "file.txt"), "before\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  writeFileSync(join(dir, "file.txt"), `changed in a ${format} repository\n`);
  return dir;
}
const storeFormat = (project: string) => {
  const store = objectStorePath(project);
  return git(store, ["rev-parse", "--show-object-format"], storeEnv(store));
};
/** Every file under a repository's object directory. */
const objectFiles = (repo: string) => {
  const objects = join(repo, ".git", "objects");
  return readdirSync(objects, { recursive: true })
    .map((entry) => relative(objects, join(objects, String(entry))))
    .sort();
};
const capture = (repo: string, projectRoot: string) =>
  captureWorkingTreeTransient(repo, "HEAD", [], { projectRoot, owner: temp("cx-format-run-") });
const refusedNaming = (failure: Error | undefined, ...formats: Format[]) => {
  expect(failure).toBeInstanceOf(GitOperationError);
  expect((failure as GitOperationError).code).toBe("capture_failed");
  for (const format of formats) expect(failure!.message).toContain(format);
};

describe("one project keeps one Git object format", () => {
  it("a capture whose format differs from its project repository creates no store, and the project's own captures still work", async () => {
    const project = repo("sha1");
    const execution = repo("sha256");

    const foreign = await capture(execution, project);

    expect(foreign.captureIncomplete).toBe(true);
    refusedNaming(foreign.captureFailure, "sha256", "sha1");
    expect(existsSync(objectStorePath(project))).toBe(false);
    const own = await capture(project, project);
    expect(own.captureIncomplete).toBe(false);
    expect(storeFormat(project)).toBe("sha1");
  });

  it("a project that is no Git repository keeps its first format, refuses the other without mounting its store, and keeps capturing the first", async () => {
    const project = temp("cx-format-plain-");
    const first = repo("sha256");
    const second = repo("sha1");
    expect((await capture(first, project)).captureIncomplete).toBe(false);
    const store = objectStorePath(project);
    // As retention leaves it: the store's objects in a pack and its index.
    // (The store has no refs, so its objects are packed as unreachable ones.)
    git(store, ["repack", "-a", "-d", "-q", "--keep-unreachable"], storeEnv(store));
    expect(readdirSync(join(store, "objects", "pack")).some((name) => name.endsWith(".idx"))).toBe(
      true,
    );

    alternatesSeen = [];
    const foreign = await capture(second, project);
    const seen = alternatesSeen;
    alternatesSeen = null;

    expect(foreign.captureIncomplete).toBe(true);
    refusedNaming(foreign.captureFailure, "sha1", "sha256");
    expect(seen.filter((paths) => paths.includes(join(store, "objects")))).toEqual([]);
    expect(storeFormat(project)).toBe("sha256");
    writeFileSync(join(first, "file.txt"), "changed again\n");
    expect((await capture(first, project)).captureIncomplete).toBe(false);
  });

  it("the store itself is never made, nor used, in another format than its project's", async () => {
    const project = repo("sha1");
    const execution = repo("sha256");
    const retain = () =>
      retainInObjectStore({
        projectRoot: project,
        source: { cwd: execution, env: {}, objectsDir: join(execution, ".git", "objects") },
        roots: [git(execution, ["rev-parse", "HEAD"])],
        boundary: null,
        objectFormat: "sha256",
        owner: temp("cx-format-owner-"),
      });

    const created = retain();
    await expect(created).rejects.toBeInstanceOf(GitOperationError);
    await expect(created).rejects.toThrow(/sha256[^]*sha1/);
    expect(existsSync(objectStorePath(project))).toBe(false);
    // Once the project's own store exists, the other format is refused the same way.
    expect((await capture(project, project)).captureIncomplete).toBe(false);
    const used = retain();
    await expect(used).rejects.toBeInstanceOf(GitOperationError);
    await expect(used).rejects.toThrow(/sha256[^]*sha1/);
    expect(storeFormat(project)).toBe("sha1");
  });

  it("an import never reads a store of the other format into a repository", async () => {
    const project = temp("cx-format-plain-");
    const execution = repo("sha256");
    const captured = await capture(execution, project);
    expect(captured.captureIncomplete).toBe(false);
    const target = repo("sha1");
    const before = objectFiles(target);
    const roots = [captured.result!.base_tree, captured.result!.candidate_tree];

    const imported = await importIntoRepository({
      projectRoot: project,
      repo: target,
      roots,
    }).catch((error: Error) => error);

    // Nothing of the other format entered the repository, whatever the answer.
    expect(objectFiles(target)).toEqual(before);
    expect(imported).not.toBeInstanceOf(Error);
    if (imported instanceof Error) return;
    expect(imported.missing).toEqual([...roots].sort());
    expect(imported.formatMismatch).toEqual({ kept: "sha256", repository: "sha1" });
    expect(imported.linkedLoose + imported.linkedPacks + imported.streamedObjects).toBe(0);
  });

  it.each([
    { kind: "isolated", inPlace: false },
    { kind: "in-place", inPlace: true },
  ])("a $kind envelope of the other format is refused before it is made", async ({ inPlace }) => {
    const project = temp("cx-format-plain-");
    expect((await capture(repo("sha256"), project)).captureIncomplete).toBe(false);
    const execution = repo("sha1");
    git(execution, ["add", "-A"]);
    git(execution, ["commit", "-qm", "clean"]);
    const runtimeRoot = temp("cx-format-rt-");
    const manager = new WorkspaceManager(execution, { runtimeRoot, projectRoot: project });

    const created = manager.create({ taskId: "t1", attemptId: "a01", inPlace });

    await expect(created).rejects.toBeInstanceOf(GitOperationError);
    await expect(created).rejects.toMatchObject({ code: "capture_failed" });
    await expect(created).rejects.toThrow(/sha1[^]*sha256|sha256[^]*sha1/);
    expect(existsSync(join(runtimeRoot, "workspaces", "t1", "a01", "tree"))).toBe(false);
  });
});
