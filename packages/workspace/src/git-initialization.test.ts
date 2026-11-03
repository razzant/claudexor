import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GitCommandResult } from "./git-initialization.js";
import { ensureGitRepository, GitBoundaryRootRefusedError, GitInitializationError } from "./git.js";

const availableGit = async () => ({
  status: "available" as const,
  version: "git version test",
  detail: null,
  remediation: null,
});

describe("Git initialization progress", () => {
  it.each(["init", "add", "commit"] as const)(
    "discloses a partial repository mutation when %s fails",
    async (failedStage) => {
      const calls: string[][] = [];
      const runGit = async (_repo: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "rev-parse") {
          return { code: 1, stdout: "", stderr: "not a repository" };
        }
        if (args[0] === "init") {
          return failedStage === "init"
            ? { code: 128, stdout: "", stderr: "invalid initial branch name" }
            : { code: 0, stdout: "initialized", stderr: "" };
        }
        if (args[0] === "add") {
          return failedStage === "add"
            ? { code: 1, stdout: "", stderr: "permission denied" }
            : { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "commit refused" };
      };

      await expect(
        ensureGitRepository("/project", {
          probeCapability: availableGit,
          runGit,
          rootPolicy: {
            userHomeDir: () => "/home/tester",
            realpath: (path) => path,
          },
        }),
      ).rejects.toMatchObject({
        name: "GitInitializationError",
        progress: {
          initialized: failedStage !== "init",
          baselineCommitted: false,
          failedStage,
        },
      });
      expect(calls.some((args) => args[0] === "init")).toBe(true);
    },
  );

  it("uses a typed error class for partial-mutation consumers", () => {
    const error = new GitInitializationError("failed", {
      initialized: true,
      baselineCommitted: false,
      gitignoreSeeded: false,
      headSha: null,
      failedStage: "add",
    });
    expect(error).toBeInstanceOf(Error);
  });
});

describe("Git boundary root guard (INV-075 refusal exception)", () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  /** Record every git call; answer "not a repository" to the probes and
   * succeed everything else, so a refusal is provable as PRE-mutation. */
  const recordingGit = (calls: string[][], unbornHead = false) => {
    return async (_repo: string, args: string[]): Promise<GitCommandResult> => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return unbornHead
          ? { code: 0, stdout: "true", stderr: "" }
          : { code: 1, stdout: "", stderr: "not a repository" };
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return { code: 1, stdout: "", stderr: "no HEAD" };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { code: 0, stdout: "abc123\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  };
  const mutations = (calls: string[][]) => calls.filter((args) => args[0] !== "rev-parse");

  it.each([false, true])(
    "refuses the user home directory before any mutation (unborn HEAD: %s)",
    async (unbornHead) => {
      const calls: string[][] = [];
      const error: unknown = await ensureGitRepository("/home/tester", {
        probeCapability: availableGit,
        runGit: recordingGit(calls, unbornHead),
        rootPolicy: {
          userHomeDir: () => "/home/tester",
          realpath: (path) => path,
        },
      }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(GitBoundaryRootRefusedError);
      const refusal = error as GitBoundaryRootRefusedError;
      expect(refusal.code).toBe("git_boundary_root_refused");
      expect(refusal.status).toBe(400);
      expect(refusal.retryable).toBe(true);
      expect(refusal.context).toEqual({ root: "/home/tester", cause: "user_home" });
      expect(refusal.message).toContain("user home directory");
      // Both honest remediations: a subfolder, or a SELF-init with a first
      // commit (a bare `git init` would still be refused on the unborn-HEAD
      // path, so the text must never recommend it alone).
      expect(refusal.requiredActions.join("\n")).toContain("subfolder");
      expect(refusal.requiredActions.join("\n")).toContain("`git init`");
      expect(refusal.requiredActions.join("\n")).toContain("first commit");
      // The refusal happened BEFORE any mutation: probes only, no init/add/commit.
      expect(mutations(calls)).toEqual([]);
    },
  );

  it("refuses a filesystem root before any mutation", async () => {
    const calls: string[][] = [];
    const error: unknown = await ensureGitRepository("/", {
      probeCapability: availableGit,
      runGit: recordingGit(calls),
      rootPolicy: {
        userHomeDir: () => "/home/tester",
        realpath: (path) => path,
      },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitBoundaryRootRefusedError);
    const refusal = error as GitBoundaryRootRefusedError;
    expect(refusal.context).toEqual({ root: "/", cause: "filesystem_root" });
    expect(refusal.message).toContain("filesystem root");
    expect(mutations(calls)).toEqual([]);
  });

  it("fails CLOSED when no safe home resolves, naming that cause distinctly", async () => {
    const calls: string[][] = [];
    const error: unknown = await ensureGitRepository("/some/project", {
      probeCapability: availableGit,
      runGit: recordingGit(calls),
      rootPolicy: {
        userHomeDir: () => {
          throw new Error("Unable to resolve a safe user home directory");
        },
        realpath: (path) => path,
      },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitBoundaryRootRefusedError);
    const refusal = error as GitBoundaryRootRefusedError;
    expect(refusal.context).toEqual({ root: "/some/project", cause: "unresolvable_home" });
    expect(refusal.message).toContain("could not be resolved");
    expect(refusal.requiredActions.join("\n")).toContain("HOME");
    expect(mutations(calls)).toEqual([]);
  });

  it("fails CLOSED when the home itself cannot be PHYSICALLY resolved", async () => {
    // The home operand must go through the same strict physical resolver as
    // the root side. A canonicalizer that swallows realpath failures would
    // silently degrade this case to a lexical comparison against the
    // physically resolved root — the guard must refuse instead.
    const calls: string[][] = [];
    const error: unknown = await ensureGitRepository("/some/project", {
      probeCapability: availableGit,
      runGit: recordingGit(calls),
      rootPolicy: {
        userHomeDir: () => "/home/dangling-link",
        realpath: (path) => {
          if (path === "/home/dangling-link") throw new Error("ENOENT: dangling home");
          return path;
        },
      },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitBoundaryRootRefusedError);
    const refusal = error as GitBoundaryRootRefusedError;
    expect(refusal.context).toEqual({ root: "/some/project", cause: "unresolvable_home" });
    expect(refusal.message).toContain("could not be resolved");
    expect(refusal.requiredActions.join("\n")).toContain("HOME");
    expect(mutations(calls)).toEqual([]);
  });

  it("refuses when the HOME is spelled through a symlink (symmetric-physical pin)", async () => {
    // Mirror of the symlinked-ROOT test below: here the home is REPORTED
    // through a link spelling while the root arrives as the real path. Both
    // operands go through the same physical resolver, so the spellings unify
    // and the refusal is user_home — not a silent pass on unequal strings.
    const base = mkdtempSync(join(tmpdir(), "claudexor-boundary-homespell-"));
    tempDirs.push(base);
    const realHome = join(base, "real-home");
    mkdirSync(realHome);
    const linkedHome = join(base, "home-link");
    symlinkSync(realHome, linkedHome);
    const calls: string[][] = [];
    const error: unknown = await ensureGitRepository(realHome, {
      probeCapability: availableGit,
      runGit: recordingGit(calls),
      rootPolicy: { userHomeDir: () => linkedHome },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitBoundaryRootRefusedError);
    const refusal = error as GitBoundaryRootRefusedError;
    expect(refusal.context.cause).toBe("user_home");
    expect(refusal.context.root).toBe(realpathSync.native(realHome));
    expect(mutations(calls)).toEqual([]);
  });

  it("leaves a home directory that IS a healthy repository untouched (dotfiles users)", async () => {
    const calls: string[][] = [];
    const runGit = async (_repo: string, args: string[]): Promise<GitCommandResult> => {
      calls.push(args);
      if (args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true\n", stderr: "" };
      if (args[1] === "--verify") return { code: 0, stdout: "abc123\n", stderr: "" };
      return { code: 0, stdout: "abc123\n", stderr: "" };
    };
    const result = await ensureGitRepository("/home/tester", {
      probeCapability: availableGit,
      runGit,
      rootPolicy: { userHomeDir: () => "/home/tester" },
    });
    expect(result).toEqual({
      initialized: false,
      baselineCommitted: false,
      gitignoreSeeded: false,
      headSha: "abc123",
    });
    expect(mutations(calls)).toEqual([]);
  });

  it("refuses a symlinked spelling of the home directory (realpath on both sides)", async () => {
    const base = mkdtempSync(join(tmpdir(), "claudexor-boundary-home-"));
    tempDirs.push(base);
    const realHome = join(base, "real-home");
    mkdirSync(realHome);
    const linkedHome = join(base, "home-link");
    symlinkSync(realHome, linkedHome);
    const calls: string[][] = [];
    // Root spelled through the symlink, home reported as the real path; the
    // DEFAULT canonicalizer (realpath) must unify the two spellings.
    const error: unknown = await ensureGitRepository(linkedHome, {
      probeCapability: availableGit,
      runGit: recordingGit(calls),
      rootPolicy: { userHomeDir: () => realHome },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitBoundaryRootRefusedError);
    expect((error as GitBoundaryRootRefusedError).context.cause).toBe("user_home");
    expect(mutations(calls)).toEqual([]);
  });

  it("refuses a root whose symlink-through-`..` spelling physically lands in home", async () => {
    // The adversarial reviewer's exact topology: a symlink OUTSIDE home
    // pointing INSIDE it, root spelled `<link>/..`. A lexical resolve()
    // collapses `..` first and lands on the link's parent (outside home) —
    // but git follows the symlink FIRST, so `git -C <link>/..` operates on
    // home itself. The guard must compare the physical path git will use.
    const base = mkdtempSync(join(tmpdir(), "claudexor-boundary-escape-"));
    tempDirs.push(base);
    const home = join(base, "home");
    mkdirSync(join(home, "inside"), { recursive: true });
    const outside = join(base, "outside");
    mkdirSync(outside);
    const link = join(outside, "link");
    symlinkSync(join(home, "inside"), link);
    const calls: string[][] = [];
    // NOT join(link, ".."): join collapses `..` lexically, which is exactly
    // the resolution bug under test — the raw spelling must keep it.
    const error: unknown = await ensureGitRepository(`${link}/..`, {
      probeCapability: availableGit,
      runGit: recordingGit(calls),
      rootPolicy: { userHomeDir: () => home },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitBoundaryRootRefusedError);
    const refusal = error as GitBoundaryRootRefusedError;
    expect(refusal.context.cause).toBe("user_home");
    expect(refusal.context.root).toBe(realpathSync.native(home));
    expect(mutations(calls)).toEqual([]);
  });

  it("allows the mirror spelling — home symlink whose `..` physically lands outside — and initializes the outside dir", async () => {
    // Mirror topology: a symlink INSIDE home pointing OUTSIDE it, root
    // spelled `<link>/..`. Lexically that collapses to home (a false
    // positive); physically git operates on the outside directory. REAL git
    // proves which directory receives the boundary.
    const base = mkdtempSync(join(tmpdir(), "claudexor-boundary-mirror-"));
    tempDirs.push(base);
    const home = join(base, "home");
    mkdirSync(home, { recursive: true });
    const outside = join(base, "outside");
    mkdirSync(join(outside, "target"), { recursive: true });
    writeFileSync(join(outside, "data.txt"), "hello\n");
    const link = join(home, "link");
    symlinkSync(join(outside, "target"), link);
    // Raw spelling on purpose — join(link, "..") would pre-collapse it.
    const result = await ensureGitRepository(`${link}/..`, {
      rootPolicy: { userHomeDir: () => home },
    });
    expect(result.initialized).toBe(true);
    expect(result.baselineCommitted).toBe(true);
    expect(existsSync(join(outside, ".git"))).toBe(true);
    expect(existsSync(join(home, ".git"))).toBe(false);
  });

  it("fails CLOSED when the root cannot be physically resolved", async () => {
    const base = mkdtempSync(join(tmpdir(), "claudexor-boundary-unresolvable-"));
    tempDirs.push(base);
    const missing = join(base, "missing", "nope");
    const calls: string[][] = [];
    const error: unknown = await ensureGitRepository(missing, {
      probeCapability: availableGit,
      runGit: recordingGit(calls),
      rootPolicy: { userHomeDir: () => "/home/tester" },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitBoundaryRootRefusedError);
    const refusal = error as GitBoundaryRootRefusedError;
    expect(refusal.context).toEqual({ root: missing, cause: "unresolvable_root" });
    expect(refusal.message).toContain("could not be physically resolved");
    expect(refusal.requiredActions.join("\n")).toContain("exists and is accessible");
    expect(mutations(calls)).toEqual([]);
  });

  it("still auto-initializes an ordinary non-git folder (guard passes)", async () => {
    const calls: string[][] = [];
    const result = await ensureGitRepository("/home/tester/project", {
      probeCapability: availableGit,
      runGit: recordingGit(calls),
      rootPolicy: {
        userHomeDir: () => "/home/tester",
        realpath: (path) => path,
      },
    });
    expect(result).toEqual({
      initialized: true,
      baselineCommitted: true,
      gitignoreSeeded: false,
      headSha: "abc123",
    });
    expect(calls.some((args) => args[0] === "init")).toBe(true);
    expect(calls.some((args) => args[0] === "add")).toBe(true);
  });

  it("still gives an ordinary unborn-HEAD repository its baseline commit", async () => {
    const calls: string[][] = [];
    const result = await ensureGitRepository("/home/tester/project", {
      probeCapability: availableGit,
      runGit: recordingGit(calls, true),
      rootPolicy: {
        userHomeDir: () => "/home/tester",
        realpath: (path) => path,
      },
    });
    expect(result).toEqual({
      initialized: false,
      baselineCommitted: true,
      gitignoreSeeded: false,
      headSha: "abc123",
    });
    expect(calls.some((args) => args[0] === "init")).toBe(false);
    expect(calls.some((args) => args[0] === "add")).toBe(true);
  });
});
