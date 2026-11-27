import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceEnvelope, type WorkspaceFilesManifest } from "@claudexor/schema";
import { FileChangedError, FileSpaceError, type WorkspaceManager } from "@claudexor/workspace";

/** Paths whose creation or write reports a full disk, as a test sets them. */
const full = vi.hoisted(() => ({ paths: [] as RegExp[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const refuse = (path: unknown) => {
    if (full.paths.some((pattern) => pattern.test(String(path))))
      throw Object.assign(new Error(`ENOSPC: no space left, '${String(path)}'`), {
        code: "ENOSPC",
      });
  };
  return {
    ...actual,
    mkdir: (async (path: Parameters<typeof actual.mkdir>[0], ...rest: unknown[]) => {
      refuse(path);
      return (actual.mkdir as (...all: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.mkdir,
    writeFile: (async (path: Parameters<typeof actual.writeFile>[0], ...rest: unknown[]) => {
      refuse(path);
      return (actual.writeFile as (...all: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.writeFile,
  };
});
const { directoryCandidateStable, prepareDirectoryReview } =
  await import("./directoryCandidate.js");
const { DirectoryStabilityError } = await import("./captureRefusal.js");

const dirs: string[] = [];
afterEach(() => {
  full.paths.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "cx-dir-candidate-"));
  dirs.push(dir);
  return dir;
};

const manifest: WorkspaceFilesManifest = {
  version: 1,
  sourceRoot: "/project",
  executionRoot: "/copy",
  isolation: "envelope",
  scopePaths: ["."],
  complete: true,
  entries: [{ path: "a.txt", before: null, after: { kind: "directory", mode: 0o755 } }],
};
const candidate = (artifactRoot: string) => ({
  manifest,
  manifestPath: "final/files/manifest.json",
  manifestSha256: "sha",
  changedPaths: ["a.txt"],
  noChanges: false,
  artifactRoot,
});
const envelope = WorkspaceEnvelope.parse({
  id: "env",
  task_id: "t",
  attempt_id: "a01",
  repo_root: "/project",
  worktree_path: "/copy",
  base_ref: null,
  base_sha: null,
  branch_name: null,
  workspace_kind: "directory",
  scope_paths: ["."],
  home_dir: "/home",
  harness_config_dirs: {},
  policy_profile: "workspace_write",
  dirty_policy: "snapshot",
  created_at: new Date().toISOString(),
});
const managerThrowing = (error: Error) =>
  ({
    captureFiles: async () => {
      throw error;
    },
  }) as unknown as WorkspaceManager;

describe("the post-review stability check", () => {
  it("reads a file that changed while it was hashed as a changed result", async () => {
    const stable = await directoryCandidateStable(
      managerThrowing(new FileChangedError("/copy/a.txt")),
      envelope,
      candidate(temp()),
    );
    expect(stable).toBe(false);
  });

  it("refuses, typed, a comparison that could not read the result", async () => {
    const unreadable = Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    const error = await directoryCandidateStable(
      managerThrowing(unreadable),
      envelope,
      candidate(temp()),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DirectoryStabilityError);
    expect((error as InstanceType<typeof DirectoryStabilityError>).refusal.failure).toMatchObject({
      causeCode: "EIO",
    });
  });
});

describe("a directory review preparation that cannot write", () => {
  it.each([
    ["its candidate tree", /directory-review$/],
    ["its evidence manifest", /FILES\.json$/],
  ])("types a full disk at %s and leaves no candidate tree", async (_where, pattern) => {
    const root = temp();
    full.paths.push(pattern);
    const error = await prepareDirectoryReview(candidate(root), join(root, "evidence")).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(FileSpaceError);
    expect((error as Error).message).toContain("review preparation ran out of space");
    full.paths.length = 0;
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(root, "directory-review"))).toBe(false);
  });
});
