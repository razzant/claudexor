import { realpathSync } from "node:fs";
import { parse, resolve } from "node:path";
import { WorkspaceError } from "@claudexor/core";
import { userHomeDir } from "@claudexor/util";
import { probeGitCapability, requireGitCapability } from "./git-capability.js";
import {
  PreparationStopped,
  terminationDisclosure,
  throwIfCancelled,
  userLockStep,
  unconfirmedTerminationOf,
  type TerminationDisclosure,
  type UnconfirmedTermination,
} from "./git-run.js";

export interface GitCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type GitRunner = (
  repo: string,
  args: string[],
  input?: string,
  signal?: AbortSignal,
) => Promise<GitCommandResult>;

export interface EnsureGitRepositoryResult {
  /** True when `git init` ran (the folder was not a repository). */
  initialized: boolean;
  /** True when a baseline commit was created (fresh repo or unborn HEAD). */
  baselineCommitted: boolean;
  /** Always false in v2: Claudexor never changes a project's `.gitignore`. */
  gitignoreSeeded: boolean;
  /** HEAD sha after the call. */
  headSha: string;
}

export interface GitInitializationProgress {
  initialized: boolean;
  baselineCommitted: boolean;
  gitignoreSeeded: false;
  headSha: string | null;
  failedStage: "init" | "add" | "commit" | "head";
}

/** A Git-boundary setup failed after it may already have changed repository
 * metadata. Callers must disclose this progress before terminal failure. */
export class GitInitializationError extends WorkspaceError {
  /** The same progress as typed problem context: a refusal recorded before any
   * run exists (a thread turn's `enqueue_error`) keeps it, not only a message. */
  readonly context: {
    project_git_initialization: Record<string, unknown>;
    termination_unconfirmed?: TerminationDisclosure;
  };

  constructor(
    message: string,
    readonly progress: GitInitializationProgress,
    /** A stop or time bound inside the step whose end was not proven: it survives this wrapper. */
    readonly termination?: UnconfirmedTermination,
  ) {
    super(message);
    this.name = "GitInitializationError";
    this.context = {
      ...(termination ? { termination_unconfirmed: terminationDisclosure(termination) } : {}),
      project_git_initialization: {
        partial: true,
        initialized: progress.initialized,
        baseline_committed: progress.baselineCommitted,
        gitignore_seeded: progress.gitignoreSeeded,
        head_sha: progress.headSha,
        failed_stage: progress.failedStage,
      },
    };
  }

  /** The same partial progress once what the stopped step left was proven ended
   * (its scope settled): no unconfirmed termination is disclosed any more. */
  withEndProven(): GitInitializationError {
    return this.termination
      ? new GitInitializationError(
          `${this.message}; what the stopped step started has since ended`,
          this.progress,
        )
      : this;
  }
}

/** Why a root was refused as a Git-boundary initialization target. */
export type GitBoundaryRootRefusalCause =
  "user_home" | "filesystem_root" | "unresolvable_home" | "unresolvable_root";

/**
 * The Git boundary REFUSED to initialize this root, BEFORE any mutation —
 * contrast GitInitializationError above, which is a partial-mutation receipt;
 * the two must never be merged. Auto-initialization is for plausible project
 * folders only: the user home directory and filesystem roots are refused, and
 * a root that cannot be classified (no safe home resolves, or the root itself
 * cannot be physically resolved) is refused FAIL-CLOSED. The field contract
 * {code, status, retryable, requiredActions, context} mirrors the
 * run-preflight throw shape so daemon job settlement lifts it into a typed
 * ThreadTurn.enqueue_error with no extra plumbing.
 */
export class GitBoundaryRootRefusedError extends WorkspaceError {
  readonly code = "git_boundary_root_refused";
  readonly status = 400;
  /** An exact retry can succeed after the named user actions. */
  readonly retryable = true;
  readonly requiredActions: string[];
  readonly context: { root: string; cause: GitBoundaryRootRefusalCause };

  constructor(
    message: string,
    root: string,
    cause: GitBoundaryRootRefusalCause,
    requiredActions: string[],
  ) {
    super(message);
    this.name = "GitBoundaryRootRefusedError";
    this.requiredActions = requiredActions;
    this.context = { root, cause };
  }
}

/** Test seams for the boundary-root guard (home + path resolution). */
export interface GitBoundaryRootPolicy {
  userHomeDir?: () => string;
  /** PHYSICAL resolver for BOTH operands (defaults to realpathSync.native on
   * the RAW spellings — symlinks resolved BEFORE `..`, the way git resolves
   * `-C`). Never a lexical canonicalizer: see boundaryRootRefusal. */
  realpath?: (path: string) => string;
}

export interface EnsureGitRepositoryDependencies {
  probeCapability?: typeof probeGitCapability;
  runGit?: GitRunner;
  rootPolicy?: GitBoundaryRootPolicy;
  /** The run's stop: the running Git child gets the ordinary escalation (never a
   * removal of the user's lock files); a stop after a mutation began keeps the
   * partial-progress receipt. */
  signal?: AbortSignal;
  /** Called once, before the first step that changes the repository: the stop it
   * returns (carrying that preparation's process scope) is the one those steps get.
   * Reads of a healthy repository never call it. */
  beforeMutation?: () => Promise<AbortSignal | undefined>;
  /** Test seam: the platform whose step-boundary rule applies (`userLockStep`). */
  platform?: NodeJS.Platform;
}

const SUBFOLDER_REMEDIATION = "Choose a project subfolder as the project root instead.";
const SELF_INIT_REMEDIATION =
  "If you really mean this folder, initialize it yourself: run `git init` and create a first commit — Claudexor respects an existing healthy repository.";

/**
 * Refusal (or null) for creating a Git boundary at `repo`. The user home
 * directory and filesystem roots are never auto-initialized: `git add -A`
 * over such a tree fails on protected paths, hashes unrelated secrets into
 * Git objects, and mutates state the user never framed as a project. A root
 * that cannot be classified — no safe home resolves, or the root itself does
 * not physically resolve — is refused FAIL-CLOSED with its own cause: unknown
 * is never treated as ordinary. BOTH operands are resolved PHYSICALLY from
 * their raw spellings (realpath: symlinks BEFORE `..`), exactly the way
 * `git -C` resolves a path — a lexical canonicalizer is unsuitable on either
 * side: its resolve() collapses `..` before following symlinks, so a root
 * spelled `<symlink-into-home>/..` would canonicalize OUTSIDE home while git
 * operates INSIDE it (and the mirror spelling would over-fire the guard), and
 * a canonicalizer that swallows realpath failures would silently degrade the
 * home side to a lexical comparison — a home whose physical resolution fails
 * refuses fail-closed as `unresolvable_home` instead. A home that
 * is already a HEALTHY repository never reaches this guard — the early return
 * above respects it (dotfiles users), which is also why the self-init
 * remediation must name a FIRST COMMIT: a bare `git init` leaves an unborn
 * HEAD, and the whole-transaction guard still refuses that.
 */
function boundaryRootRefusal(
  repo: string,
  policy: GitBoundaryRootPolicy,
): GitBoundaryRootRefusedError | null {
  const realpath = policy.realpath ?? realpathSync.native;
  // The directory exists by the time initialization is attempted, so a failed
  // physical resolution is itself disqualifying (dangling link, denied
  // traversal): refuse with the cause rather than guessing from a lexical
  // collapse that git will not honor.
  let root: string;
  try {
    root = realpath(repo);
  } catch (error) {
    const shown = resolve(repo);
    return new GitBoundaryRootRefusedError(
      `refusing to initialize a git repository at ${shown}: the root could not be physically resolved (${error instanceof Error ? error.message : String(error)}), so it cannot be proven distinct from the user home directory or a filesystem root`,
      shown,
      "unresolvable_root",
      ["Verify the project root exists and is accessible, then retry.", SELF_INIT_REMEDIATION],
    );
  }
  if (parse(root).root === root) {
    return new GitBoundaryRootRefusedError(
      `refusing to initialize a git repository over the filesystem root ${root}; Claudexor auto-initializes only plausible project folders`,
      root,
      "filesystem_root",
      [SUBFOLDER_REMEDIATION, SELF_INIT_REMEDIATION],
    );
  }
  // The home operand goes through the SAME strict physical resolver as the
  // root side — never a canonicalizer that swallows realpath failures into a
  // lexical fallback. Either throw here (no safe home resolves, or the home
  // does not physically resolve) refuses fail-closed with the same cause.
  let home: string;
  try {
    home = realpath((policy.userHomeDir ?? userHomeDir)());
  } catch (error) {
    return new GitBoundaryRootRefusedError(
      `refusing to initialize a git repository at ${root}: the user home directory could not be resolved (${error instanceof Error ? error.message : String(error)}), so this root cannot be proven distinct from it`,
      root,
      "unresolvable_home",
      [
        "Set HOME (or USERPROFILE on Windows) to your user home directory so the root can be classified, then retry.",
        SELF_INIT_REMEDIATION,
      ],
    );
  }
  if (root === home) {
    return new GitBoundaryRootRefusedError(
      `refusing to initialize a git repository over the user home directory ${root}; Claudexor auto-initializes only plausible project folders`,
      root,
      "user_home",
      [SUBFOLDER_REMEDIATION, SELF_INIT_REMEDIATION],
    );
  }
  return null;
}

/**
 * Establish the write-mode Git boundary. The caller supplies the canonical Git
 * runner so command execution remains owned by git.ts while this module owns
 * only the initialization transaction and its partial-progress receipt.
 */
export async function initializeGitRepository(
  repo: string,
  runGit: GitRunner,
  probeCapability: typeof probeGitCapability = probeGitCapability,
  rootPolicy: GitBoundaryRootPolicy = {},
  signal?: AbortSignal,
  beforeMutation?: () => Promise<AbortSignal | undefined>,
  platform?: NodeJS.Platform,
): Promise<EnsureGitRepositoryResult> {
  requireGitCapability(await probeCapability());
  // Reads change nothing and a filter cannot hold them: a stop is honoured from the
  // first mutation on, and a healthy repository leaves it to the run's next step.
  const read = (args: string[]) => runGit(repo, args);
  const inside = await read(["rev-parse", "--is-inside-work-tree"]);
  const isRepo = inside.code === 0 && inside.stdout.trim() === "true";
  const hasHead = isRepo && (await read(["rev-parse", "--verify", "HEAD"])).code === 0;
  if (isRepo && hasHead) {
    const head = await read(["rev-parse", "HEAD"]);
    if (head.code !== 0)
      throw new WorkspaceError(`git rev-parse HEAD failed: ${head.stderr.trim()}`);
    return {
      initialized: false,
      baselineCommitted: false,
      gitignoreSeeded: false,
      headSha: head.stdout.trim(),
    };
  }

  // INV-075 exception: the auto-init transaction (fresh `git init` AND the
  // unborn-HEAD `add -A`/commit below) refuses implausible roots before any
  // mutation. Placed AFTER the healthy-repo return so a deliberately
  // user-initialized home (init + first commit) is respected untouched.
  const refusal = boundaryRootRefusal(repo, rootPolicy);
  if (refusal) throw refusal;

  let initialized = false;
  const partial = (
    failedStage: GitInitializationProgress["failedStage"],
    baselineCommitted = false,
    headSha: string | null = null,
  ): GitInitializationProgress => ({
    initialized,
    baselineCommitted,
    gitignoreSeeded: false,
    headSha,
    failedStage,
  });
  // A stop before the first mutation leaves nothing to disclose; once a step
  // has started, it is reported like any other partial initialization.
  let touched = false;
  let stop = signal;
  const step = async (
    stage: GitInitializationProgress["failedStage"],
    args: string[],
    baselineCommitted = false,
  ): Promise<GitCommandResult> => {
    try {
      throwIfCancelled(stop);
      if (!touched && beforeMutation) {
        stop = await beforeMutation();
        // A Stop during that wait starts no step: nothing was changed yet.
        throwIfCancelled(stop);
      }
      touched = true;
      // The user's own repository and index: on Windows the step is not
      // interrupted; the stop is taken at the next step's boundary.
      return await runGit(repo, args, undefined, userLockStep(stop, platform));
    } catch (error) {
      // A stop, or the time bound that cut the step with its end unproven (no
      // aborted caller: `gitEnv` keeps that fact on a plain error). Once a step
      // began, either leaves partial metadata; the termination rides along.
      const termination = unconfirmedTerminationOf(error);
      const stopped = error instanceof PreparationStopped;
      if (!touched || !(stopped || termination)) throw error;
      const why = error instanceof Error ? error.message : String(error);
      throw new GitInitializationError(
        stopped
          ? `Git repository initialization was stopped during ${stage}; partial Git metadata may remain (${why})`
          : `Git repository initialization was cut at its time bound during ${stage}; partial Git metadata may remain (${why})`,
        partial(stage, baselineCommitted),
        termination,
      );
    }
  };
  if (!isRepo) {
    const init = await step("init", ["init"]);
    if (init.code !== 0) {
      // `git init` is not transactional: it can leave config/hooks/refs before
      // rejecting a later step. Disclose possible partial metadata even though
      // initialization did not complete.
      throw new GitInitializationError(`git init failed: ${init.stderr.trim()}`, partial("init"));
    }
    initialized = true;
  }

  const add = await step("add", ["add", "-A"]);
  if (add.code !== 0)
    throw new GitInitializationError(
      `git add failed during repository initialization: ${add.stderr.trim()}`,
      partial("add"),
    );
  const commit = await step("commit", [
    "-c",
    "user.name=Claudexor",
    "-c",
    "user.email=noreply@claudexor.local",
    "commit",
    "--allow-empty",
    "--no-verify",
    "-m",
    "claudexor: initialize repository baseline",
  ]);
  if (commit.code !== 0)
    throw new GitInitializationError(
      `baseline commit failed during repository initialization: ${commit.stderr.trim()}`,
      partial("commit"),
    );
  const head = await step("head", ["rev-parse", "HEAD"], true);
  if (head.code !== 0) {
    throw new GitInitializationError(
      `git rev-parse HEAD failed after repository initialization: ${head.stderr.trim()}`,
      partial("head", true),
    );
  }
  return {
    initialized,
    baselineCommitted: true,
    gitignoreSeeded: false,
    headSha: head.stdout.trim(),
  };
}
