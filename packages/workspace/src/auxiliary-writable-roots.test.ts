import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admitAuxiliaryWritableRoots,
  assertAuxiliaryWritableRootSpelling,
  auxiliaryWritableRootDirectory,
} from "./auxiliary-writable-roots.js";

function refusal(run: () => unknown): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error("expected a typed refusal");
}

describe("auxiliary writable root admission", () => {
  const savedHome = process.env.HOME;
  let base: string;
  let home: string;
  let project: string;
  let cache: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-aux-roots-")));
    home = join(base, "home");
    project = join(base, "project");
    cache = join(home, ".cache", "uv");
    for (const dir of [home, project, cache, join(project, ".git")])
      mkdirSync(dir, { recursive: true });
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
  });

  const live = () => ({ repoRoot: project, executionRoot: project });

  it("grants nothing for an omitted or empty list", () => {
    expect(admitAuxiliaryWritableRoots(undefined, live())).toEqual([]);
    expect(admitAuxiliaryWritableRoots([], live())).toEqual([]);
  });

  it("canonicalizes HOME-descendant service directories and deduplicates spellings", () => {
    const link = join(base, "cache-link");
    symlinkSync(cache, link);
    expect(admitAuxiliaryWritableRoots([cache, link, `${cache}/`], live())).toEqual([cache]);
  });

  it("refuses relative, missing, non-directory, and unreadable paths without creating anything", () => {
    const relative = refusal(() => admitAuxiliaryWritableRoots(["cache"], live()));
    expect(relative).toMatchObject({ code: "auxiliary_writable_root_invalid", retryable: false });
    const missing = join(base, "absent", "cache");
    expect(refusal(() => admitAuxiliaryWritableRoots([missing], live()))).toMatchObject({
      code: "auxiliary_writable_root_invalid",
      retryable: true,
      status: 400,
    });
    expect(() => realpathSync(dirname(missing))).toThrow();
    expect(refusal(() => admitAuxiliaryWritableRoots([missing], live()))).toMatchObject({
      requiredActions: [expect.stringContaining("claudexor_run_continue inherits execution")],
    });
    const file = join(base, "file");
    writeFileSync(file, "x");
    expect(refusal(() => auxiliaryWritableRootDirectory(file))).toMatchObject({
      code: "auxiliary_writable_root_invalid",
    });
    if (process.getuid?.() !== 0) {
      const locked = join(base, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        expect(refusal(() => auxiliaryWritableRootDirectory(locked))).toMatchObject({
          code: "auxiliary_writable_root_invalid",
        });
      } finally {
        chmodSync(locked, 0o700);
      }
    }
    expect(() => assertAuxiliaryWritableRootSpelling(missing)).not.toThrow();
  });

  it("refuses the filesystem root, HOME itself, and HOME's ancestors", () => {
    for (const [root, reason] of [
      ["/", "filesystem_root"],
      [home, "home"],
      [base, "home"],
    ] as const) {
      expect(refusal(() => admitAuxiliaryWritableRoots([root], live()))).toMatchObject({
        code: "auxiliary_writable_root_unsafe",
        retryable: false,
        context: { reason },
      });
    }
  });

  it("refuses Claudexor's own state and configured credential homes, never a mere name", () => {
    const owned = realpathSync(process.env.CLAUDEXOR_CONFIG_DIR!);
    const inside = join(owned, "projects");
    mkdirSync(inside, { recursive: true });
    for (const root of [owned, inside]) {
      expect(refusal(() => admitAuxiliaryWritableRoots([root], live()))).toMatchObject({
        code: "auxiliary_writable_root_unsafe",
        context: { reason: "engine_state" },
      });
    }
    const profileHome = join(base, "profile-home");
    mkdirSync(profileHome);
    expect(
      refusal(() =>
        admitAuxiliaryWritableRoots([profileHome], { ...live(), credentialHomes: [profileHome] }),
      ),
    ).toMatchObject({ context: { reason: "engine_state" } });
    const named = join(home, "work", ".claudexor");
    mkdirSync(named, { recursive: true });
    expect(admitAuxiliaryWritableRoots([named], live())).toEqual([named]);
  });

  it("refuses execution-tree overlap in either direction, including live project children", () => {
    const workspace = join(base, "workspace");
    mkdirSync(join(workspace, "nested"), { recursive: true });
    const separate = {
      repoRoot: project,
      executionRoot: join(workspace, "nested"),
    };
    expect(refusal(() => admitAuxiliaryWritableRoots([workspace], separate))).toMatchObject({
      context: { reason: "execution_tree" },
    });
    const child = join(project, "scratch");
    mkdirSync(child);
    const nestedChild = join(workspace, "nested", "scratch");
    mkdirSync(nestedChild);
    for (const [root, ctx] of [
      [child, live()],
      [nestedChild, separate],
    ] as const) {
      expect(refusal(() => admitAuxiliaryWritableRoots([root], ctx))).toMatchObject({
        code: "auxiliary_writable_root_unsafe",
        context: { reason: "execution_tree" },
      });
    }
    const childAlias = join(base, "scratch-alias");
    symlinkSync(nestedChild, childAlias);
    expect(refusal(() => admitAuxiliaryWritableRoots([childAlias], separate))).toMatchObject({
      context: { reason: "execution_tree" },
    });
    expect(admitAuxiliaryWritableRoots([cache], separate)).toEqual([cache]);
  });

  it("keeps a separate execution tree away from the source project and its Git metadata", () => {
    const workspace = join(base, "workspace");
    mkdirSync(workspace);
    const delegated = { repoRoot: project, executionRoot: workspace };
    const projectCache = join(project, "cache");
    mkdirSync(projectCache);
    for (const root of [project, projectCache]) {
      expect(refusal(() => admitAuxiliaryWritableRoots([root], delegated))).toMatchObject({
        context: { reason: "source_project" },
      });
    }
    expect(
      refusal(() => admitAuxiliaryWritableRoots([join(project, ".git")], live())),
    ).toMatchObject({
      context: { reason: "execution_tree" },
    });
  });

  it.skipIf(process.platform !== "darwin")(
    "recognizes the same directory through macOS firmlink aliases",
    () => {
      const workspace = join(base, "workspace");
      const child = join(workspace, "scratch");
      const profileHome = join(base, "profile");
      const owned = realpathSync(process.env.CLAUDEXOR_CONFIG_DIR!);
      for (const path of [workspace, child, profileHome]) mkdirSync(path, { recursive: true });
      const alias = (path: string) => `/System/Volumes/Data${path}`;
      // This is a real filesystem identity witness, not a string-mapping mock.
      expect(statSync(alias(child), { bigint: true }).ino).toBe(
        statSync(child, { bigint: true }).ino,
      );
      const ctx = { repoRoot: project, executionRoot: workspace, credentialHomes: [profileHome] };
      for (const [path, reason] of [
        [workspace, "execution_tree"],
        [child, "execution_tree"],
        [project, "source_project"],
        [home, "home"],
        [owned, "engine_state"],
        [profileHome, "engine_state"],
      ]) {
        expect(refusal(() => admitAuxiliaryWritableRoots([alias(path!)], ctx))).toMatchObject({
          code: "auxiliary_writable_root_unsafe",
          context: { reason },
        });
      }
      expect(
        refusal(() =>
          admitAuxiliaryWritableRoots([workspace], { ...ctx, executionRoot: alias(child) }),
        ),
      ).toMatchObject({ context: { reason: "execution_tree" } });
      expect(admitAuxiliaryWritableRoots([cache], ctx)).toEqual([cache]);
    },
  );

  it("follows a worktree's gitdir pointer to its private and common Git directories", () => {
    const common = join(base, "origin.git");
    const gitDir = join(common, "worktrees", "wt");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    const worktree = join(base, "worktree");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    const ctx = { repoRoot: project, executionRoot: worktree };
    for (const root of [gitDir, common]) {
      expect(refusal(() => admitAuxiliaryWritableRoots([root], ctx))).toMatchObject({
        context: { reason: "git_metadata" },
      });
    }
    expect(admitAuxiliaryWritableRoots([cache], ctx)).toEqual([cache]);
  });
});
