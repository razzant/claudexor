/**
 * Preparation custody (#694): worktree, registration, new branch, envelope
 * base and staging directory carry their owner's record before mutation.
 * Unconfirmed stops hold them until `preparationQuiet` proves the end or the
 * operator confirms it (`claudexor gc release-preparation`). A measured process
 * always holds; a new generation never inherits a confirmation.
 *
 * `threads/<id>/preparation.json` precedes the first Git step. Its `early`
 * phase owns nothing of the thread during initialization, snapshot and lookups;
 * the record names ownership before thread mutation and is deleted last.
 * While it exists, every reader considers the tree unready. Ordinary cleanup
 * and successful handover retain their particular decision across removal
 * failure; without such a basis, an unproven end after a crash stays held.
 */
import {
  existsSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  preparationQuiet,
  WorkspaceError,
  type PreparationHoldFacts,
  type PreparationQuietVerdict,
} from "@claudexor/core";
import { readFile } from "node:fs/promises";
import {
  boundOperatorRelease,
  confirmPreparationRelease,
  hasPreparationChild,
  holdPreparationChild,
  releaseDecision,
  removeOwnBranch,
  resolveThreadRepository,
  threadGeneration,
  type ConfirmationInput,
  type ConfirmationOutcome,
  type OperatorReleaseBasis,
  type PurgeRepositoryRecord,
  type ReleaseDecision,
} from "./preparation-release.js";
import { removeTree, writeTextAsync } from "@claudexor/util";
import { git, terminationDisclosure } from "./git-run.js";
import type { TerminationDisclosure, UnconfirmedTermination } from "./git-run.js";
import { worktreeRegistered } from "./git.js";

export const PREPARATION_RECORD = "preparation.json";

/** The read-only release criterion; the daemon passes one that also reads the scope's index row. */
export type PreparationQuietRead = (
  facts: PreparationHoldFacts,
) => Promise<PreparationQuietVerdict>;

export interface PreparationHeldFacts {
  reason: string;
  groups: number[];
  direct_exit_observed_at?: number;
  /** The stopped step's own process, recorded when the stop left it running and
   * no process group names it (Windows has none): a read holds while that pid is
   * in use. Replaced by `direct_exit_observed_at` once its exit is seen. */
  direct_writer_pid?: number;
  at: string;
}

export interface ThreadPreparationRecord {
  schema: 1;
  thread_id: string;
  tree: string;
  /** The process scope the preparation's Git children joined (null: none). */
  scope: { marker: string } | null;
  opened_at: string;
  /** Written before the preparation's first Git step, while nothing of the thread
   * is its own yet: its release frees the record alone, and a tree, registration
   * or branch that is there was there before it and stays. Absent from the record
   * of the steps that change the thread. */
  early?: true;
  /** Whether the tree's registration is this preparation's own; null until known (then: not). */
  own_registration: boolean | null;
  /** A branch this preparation created, removable only while still at `tip`. */
  own_branch: { name: string; tip: string } | null;
  /** Original Git authority, kept before thread mutation and refreshed from its
   * repaired .git pointer before cleanup. Absent on older preparations. */
  repository?: PurgeRepositoryRecord;
  /** The checkout completed; only its scope's end was not proven yet. Its release
   * then frees the record alone and the tree is handed over as made. */
  complete?: boolean;
  held?: PreparationHeldFacts;
  cleanup_error?: string;
  /** An operator's confirmation that this generation's processes ended (r17). */
  operator_release?: OperatorReleaseBasis;
  /** An ordinary release or successful handover already authorized for this
   * generation. Neither is a machine proof; a fresh hold or live child wins. */
  cleanup_basis?: { generation: string; basis: "platform_limit" | "handover" };
}

/**
 * A stopped preparation's resources are held until their end is proven:
 * retryable later. Its context discloses the hold in the shape every
 * preparation stop uses: `termination_unconfirmed` (why, and which process
 * groups), `held` (the addresses kept) and `preparation` (the record's facts).
 */
export class PreparationHeld extends WorkspaceError {
  readonly code = "termination_unconfirmed";
  readonly status = 409;
  readonly retryable = true;
  readonly requiredActions = [
    "Wait for the stopped preparation's processes to end (or end them), then retry: the thread's next turn that changes files, or its purge, releases the held resources. Apply, a read-only turn and file reads release nothing and are refused until then.",
    "Where no read can prove that end (release_requires: operator_confirmation), `claudexor gc preparations` shows what is held; once you have checked that those processes ended, `claudexor gc release-preparation` releases it on your confirmation.",
  ];
  readonly context: {
    termination_unconfirmed: TerminationDisclosure;
    held: string[];
    preparation: Record<string, unknown>;
    /** Set when only an operator's confirmation can release it (no read can prove the end). */
    release_requires?: "operator_confirmation";
    /** The project's partial initialization, when the held stop was inside it. */
    project_git_initialization?: Record<string, unknown>;
  };
  constructor(
    message: string,
    facts: Record<string, unknown> & { tree?: string },
    cause: { reason: string; groups: readonly number[] },
    operatorMayConfirm = false,
  ) {
    super(message);
    this.context = {
      termination_unconfirmed: terminationDisclosure(cause),
      held: facts.tree ? [facts.tree] : [],
      preparation: facts,
      ...(operatorMayConfirm ? { release_requires: "operator_confirmation" as const } : {}),
    };
  }
}

/**
 * An end or successful handover was accepted, but cleanup failed. The record
 * keeps the tree unready: this is a removal fault, not a new process claim.
 * The next changing turn or purge reads again and retries. Apply, read-only
 * turns and file reads release nothing: `cleanup_error` is the last saved
 * fault, not a fresh process read.
 */
export class PreparationCleanupFailed extends WorkspaceError {
  readonly code = "preparation_cleanup_failed";
  readonly status = 409;
  readonly retryable = true;
  readonly requiredActions = [
    "Clear what prevents the cleanup (see cleanup_error: a permission, a lock or a read-only directory), then retry: the thread's next turn that changes files, or its purge, finishes the release. Apply, a read-only turn and file reads finish nothing and are refused until then.",
  ];
  readonly context: {
    held: string[];
    preparation: Record<string, unknown>;
    /** The project's partial initialization, when the failed step was inside it. */
    project_git_initialization?: Record<string, unknown>;
  };
  constructor(tree: string, record: ThreadPreparationRecord | null, fault: string) {
    super(`the thread worktree ${tree} could not be released: ${fault}`);
    // Stop facts are history here; this refusal is the accepted cleanup's fault.
    const { held: _held, ...facts } = heldFacts(tree, record);
    this.context = { held: [tree], preparation: { ...facts, cleanup_error: fault } };
  }
}

/** An accepted cleanup step failed: the fault is kept at the record
 * once (rewritten only when its text changes; the same fault may refuse that write
 * too, and the refusal still names it), and the typed refusal is returned to throw. */
function cleanupFailed(
  tree: string,
  record: ThreadPreparationRecord | null,
  fault: unknown,
): PreparationCleanupFailed {
  const text = fault instanceof Error ? fault.message : String(fault);
  if (record && record.cleanup_error !== text && existsSync(threadPreparationRecordPath(tree))) {
    try {
      writeThreadPreparation({ ...record, cleanup_error: text });
    } catch {
      /* not recordable now: the next attempt's release finds the fault itself */
    }
  }
  return new PreparationCleanupFailed(tree, record, text);
}

/** The creator calls after success and settlement. Save that handover decision
 * before unlink, so a refusal cannot turn healthy Windows work into a crash. */
export function removeThreadPreparationRecord(tree: string): void {
  const record = readThreadPreparation(tree);
  if (!record || record.held || hasPreparationChild(tree))
    throw new PreparationHeld(
      `the thread worktree ${tree} cannot be handed over while its preparation is held`,
      heldFacts(tree, record),
      holdCause(record),
    );
  try {
    writeThreadPreparation({
      ...record,
      cleanup_basis: { generation: threadGeneration(record), basis: "handover" },
    });
    unlinkSync(threadPreparationRecordPath(tree));
  } catch (fault) {
    throw cleanupFailed(tree, readThreadPreparation(tree), fault);
  }
}

/** Why a record's resources are held: its stop's facts, else an unfinished (or unreadable) record. */
function holdCause(record: ThreadPreparationRecord | null): { reason: string; groups: number[] } {
  if (!record) return { reason: "record_unreadable", groups: [] };
  return record.held ?? { reason: "preparation_unfinished", groups: [] };
}

/** The thread directory's record path for the tree at `tree`. */
export function threadPreparationRecordPath(tree: string): string {
  return join(dirname(tree), PREPARATION_RECORD);
}

/**
 * One readiness rule for every reader of a thread's recorded tree path
 * (execution, read-only execution, Apply and delivery, purge, the control API's
 * file reads): `ready` when its `.git` exists and no preparation record does;
 * `held` while a record exists (a preparation is running, was stopped without a
 * proven end, or died midway); `absent` otherwise.
 */
export function threadTreeState(tree: string): "ready" | "held" | "absent" {
  if (existsSync(threadPreparationRecordPath(tree))) return "held";
  return existsSync(join(tree, ".git")) ? "ready" : "absent";
}

/** Refuse to use a thread tree whose preparation is not complete, with the
 * refusal its record states: a release that proved the end and then could not
 * finish wrote `cleanup_error`, and that is a cleanup fault to clear
 * (`PreparationCleanupFailed`), not processes to wait for. Any other record,
 * an unreadable one included, is a hold (`PreparationHeld`): a later release
 * whose read no longer proves the end takes `cleanup_error` off the record. */
export function assertThreadTreeReady(tree: string): void {
  if (threadTreeState(tree) !== "held") return;
  const record = readThreadPreparation(tree);
  if (record?.cleanup_error) throw new PreparationCleanupFailed(tree, record, record.cleanup_error);
  throw new PreparationHeld(
    `the thread worktree ${tree} is held: its preparation did not complete${
      record?.held ? ` (${record.held.reason})` : ""
    }`,
    heldFacts(tree, record),
    holdCause(record),
  );
}

export function readThreadPreparation(tree: string): ThreadPreparationRecord | null {
  try {
    return parseThreadPreparation(readFileSync(threadPreparationRecordPath(tree), "utf8"), tree);
  } catch {
    return null;
  }
}

/** The one reading of a thread record, for every release and its inspection. */
export function parseThreadPreparation(bytes: string, tree: string): ThreadPreparationRecord {
  const record = JSON.parse(bytes) as ThreadPreparationRecord;
  if (record?.schema !== 1 || record.tree !== tree) throw new Error("not this tree's record");
  return record;
}

/** Durable before the next Git step: a failed write refuses the step (nothing spawned). */
export function writeThreadPreparation(record: ThreadPreparationRecord): void {
  writeAtomic(threadPreparationRecordPath(record.tree), record);
}

/** Why a preparation's resources are held: an unconfirmed stop's facts, or a
 * successful preparation whose scope did not settle (`scope_unsettled`). */
export type PreparationHoldCause =
  | (Pick<UnconfirmedTermination, "reason" | "groups" | "directExitObservedAt"> &
      Partial<Pick<UnconfirmedTermination, "rootPid" | "directExited" | "directExit">>)
  | { reason: "scope_unsettled"; groups: number[]; directExitObservedAt?: undefined };

/** Add the hold's cause to the record; its other facts stay as written. The tree
 * owns the stop's current child first, in memory: a record that cannot be read
 * or rewritten just then still leaves a running child every release refuses for.
 * False: a record stands that could not be read, so it did not take the stop. */
export function holdThreadPreparation(tree: string, termination: PreparationHoldCause): boolean {
  const held = heldFrom(termination);
  afterDirectExit(tree, termination, held, () => {
    const now = readThreadPreparation(tree);
    if (now?.held && sameHold(now.held, held))
      writeThreadPreparation({ ...now, held: directExitObserved(now.held) });
  });
  const record = readThreadPreparation(tree);
  if (!record) return !existsSync(threadPreparationRecordPath(tree));
  writeThreadPreparation({ ...record, held });
  return true;
}

export function heldFrom(termination: PreparationHoldCause): PreparationHeldFacts {
  // The step's own process is named only where nothing else is: with a recorded
  // group (POSIX) that group's probe already answers for it.
  const writer =
    "directExited" in termination &&
    termination.directExited === false &&
    termination.groups.length === 0
      ? termination.rootPid
      : undefined;
  return {
    reason: termination.reason,
    groups: [...termination.groups],
    ...(termination.directExitObservedAt !== undefined
      ? { direct_exit_observed_at: termination.directExitObservedAt }
      : {}),
    ...(typeof writer === "number" ? { direct_writer_pid: writer } : {}),
    at: new Date().toISOString(),
  };
}

/** What a record's stop left for the release criterion to read. */
export function holdFactsOf(
  marker: string | null | undefined,
  held: PreparationHeldFacts | undefined,
): PreparationHoldFacts {
  return {
    ...(marker ? { marker } : {}),
    groups: held?.groups ?? [],
    ...(held?.direct_exit_observed_at !== undefined
      ? { directExitObservedAt: held.direct_exit_observed_at }
      : {}),
    ...(held?.direct_writer_pid !== undefined ? { directWriterPid: held.direct_writer_pid } : {}),
  };
}

export const sameHold = (a: PreparationHeldFacts, b: PreparationHeldFacts): boolean =>
  a.at === b.at &&
  a.direct_writer_pid === b.direct_writer_pid &&
  a.reason === b.reason &&
  a.groups.length === b.groups.length &&
  a.groups.every((group, index) => group === b.groups[index]);

/** The hold once its step's own process was seen to exit: no pid to wait on. */
export function directExitObserved(held: PreparationHeldFacts): PreparationHeldFacts {
  const { direct_writer_pid: _exited, ...rest } = held;
  return { ...rest, direct_exit_observed_at: Date.now() };
}

/**
 * The resource owns its current child until observed exit. Stamp that exit for
 * both PID-only and POSIX group holds: later reads can distinguish reuse.
 * Failure keeps the previous facts; a hold's timestamp never substitutes for
 * an observed exit, and a rejected observation proves nothing.
 */
export function afterDirectExit(
  path: string,
  termination: PreparationHoldCause,
  held: PreparationHeldFacts,
  stamp: () => void | Promise<void>,
): void {
  if (!("directExit" in termination) || !termination.directExit) return;
  if (termination.directExited === false) holdPreparationChild(path, termination.directExit);
  if (held.direct_exit_observed_at !== undefined) return;
  const later = async (): Promise<void> => {
    try {
      await stamp();
    } catch {
      /* the record keeps its previous facts: later reads remain conservative */
    }
  };
  void termination.directExit.then(later, () => {});
}

/**
 * One release for creator, Retry, next turn and purge. A fresh read or current
 * child can hold it; without proof, only a bound operator confirmation or saved
 * ordinary cleanup/handover decision authorizes retry. `complete` or the absence
 * of a hold alone never authorizes it. A new generation cannot inherit a basis.
 * Complete/early records go alone. Otherwise: own registration, tree, branch
 * still at its recorded tip, record last. Before losing .git, save its resolved
 * owner in preparation and purge. Failures after an established end or handover
 * are `PreparationCleanupFailed`; a platform-limit cleanup failure stays held,
 * retaining its basis but never claiming a proven end. `none`: no record.
 */
export async function releaseThreadPreparation(
  projectRoot: string,
  tree: string,
  quiet: PreparationQuietRead = (facts) => preparationQuiet(facts),
  options: {
    platformLimit?: boolean;
    repository?: PurgeRepositoryRecord | null;
    recordRepository?: (repository: PurgeRepositoryRecord) => Promise<void>;
  } = {},
): Promise<"none" | "released" | "completed"> {
  const recordPath = threadPreparationRecordPath(tree);
  if (!existsSync(recordPath)) return "none";
  let record = readThreadPreparation(tree);
  if (!record) {
    throw new PreparationHeld(
      `the thread worktree ${tree} is held: its preparation record ${recordPath} cannot be read`,
      heldFacts(tree, null),
      holdCause(null),
    );
  }
  const verdict: PreparationQuietVerdict = hasPreparationChild(tree)
    ? { status: "held", reasons: ["this preparation's current child has not exited"] }
    : await quiet(holdFactsOf(record.scope?.marker, record.held));
  const continued =
    record.held === undefined &&
    record.cleanup_basis?.generation === threadGeneration(record) &&
    (record.cleanup_basis.basis === "platform_limit" || record.cleanup_basis.basis === "handover")
      ? record.cleanup_basis.basis
      : undefined;
  const decision = releaseDecision(verdict, {
    operator: boundOperatorRelease(record.operator_release, threadGeneration(record)),
    platformLimit:
      record.held === undefined && (options.platformLimit === true || continued !== undefined),
  });
  if (!decision.release) throw heldRefusal(tree, record, decision);
  try {
    if (decision.basis === "platform_limit" && continued === undefined) {
      record = {
        ...record,
        cleanup_basis: { generation: threadGeneration(record), basis: "platform_limit" },
      };
      writeThreadPreparation(record);
    }
    if (record.complete === true) {
      unlinkSync(recordPath);
      return "completed";
    }
    if (record.early === true) {
      unlinkSync(recordPath);
      removeEmptyDir(dirname(tree));
      return "released";
    }
    const repository = await resolveThreadRepository(
      projectRoot,
      tree,
      record.thread_id,
      record.repository ?? options.repository ?? null,
      record.own_registration === true || !!record.own_branch,
    );
    if (repository !== null) {
      if (
        record.repository?.gitDir !== repository.gitDir ||
        record.repository.identity !== repository.identity
      ) {
        record = { ...record, repository };
        writeThreadPreparation(record);
      }
      await options.recordRepository?.(repository);
    }
    if (record.own_registration === true) {
      const removed = await git(repository!.gitDir, ["worktree", "remove", "-f", "-f", tree]);
      if (removed.code !== 0 && (await worktreeRegistered(repository!.gitDir, tree)))
        throw new WorkspaceError(`git worktree remove -f -f failed: ${removed.stderr.trim()}`);
    }
    // A half checkout can be large: removed off the main thread (#704), and before
    // the record, so a removal cut short or refused leaves the record's facts.
    await removeTree(tree);
    if (record.own_branch) await removeOwnBranch(repository!.gitDir, record.own_branch);
    unlinkSync(recordPath);
    rmSync(dirname(tree), { recursive: true, force: true });
    return "released";
  } catch (fault) {
    if (decision.basis !== "platform_limit" || continued === "handover")
      throw cleanupFailed(tree, record, fault);
    // No read proved an end here (the platform has none), so this is not a
    // cleanup fault after a proven end: the step may have failed on what still
    // runs. The saved basis allows retry; a new hold or measured child still wins.
    const text = fault instanceof Error ? fault.message : String(fault);
    const held = withoutCleanupError(record);
    throw new PreparationHeld(
      `the thread worktree ${tree} could not be released (${text}) and the end of what its unfinished preparation started cannot be read`,
      { ...heldFacts(tree, held), unresolved: [...decision.unproven, text] },
      holdCause(held),
    );
  }
}

/** The refusal of a release whose decision keeps the record: what is held, why. */
function heldRefusal(
  tree: string,
  record: ThreadPreparationRecord,
  decision: Extract<ReleaseDecision, { release: false }>,
): PreparationHeld {
  const held = withoutCleanupError(record);
  return new PreparationHeld(
    `the thread worktree ${tree} is held until what its unfinished preparation started has ended: ${decision.reasons.join("; ")}`,
    { ...heldFacts(tree, held), unresolved: decision.reasons },
    holdCause(held),
    decision.operatorMayConfirm,
  );
}

/**
 * The record's current facts for a release whose read does not prove the end: a
 * cleanup fault an earlier release saved after a proven end is not supported by
 * this read and is taken off. The caller always gets the facts without it. The
 * record is rewritten when it can be (from its latest bytes); when that write is
 * refused the record keeps the old text, so the readers that only read the
 * record (Apply, a read-only turn, file reads) go on reporting the last cleanup
 * fault a release SAVED — still a refusal, not a fresh read — until a release of
 * the next changing turn or of a purge can write.
 */
function withoutCleanupError(record: ThreadPreparationRecord): ThreadPreparationRecord {
  if (record.cleanup_error === undefined) return record;
  const { cleanup_error: _stale, ...current } = record;
  try {
    const latest = readThreadPreparation(record.tree);
    if (latest) {
      const { cleanup_error: _saved, ...rest } = latest;
      writeThreadPreparation(rest);
    }
  } catch {
    /* not writable now: the record keeps the saved fault (see above) */
  }
  return current;
}

/** Remove a directory only when nothing is in it (the thread directory an early
 * record alone was made in); anything else there stays, and so does a directory
 * that cannot be removed: it holds nothing. */
export function removeEmptyDir(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    /* not empty, already gone, or not removable */
  }
}

function heldFacts(tree: string, record: ThreadPreparationRecord | null): Record<string, unknown> {
  return {
    tree,
    record: threadPreparationRecordPath(tree),
    ...(record?.own_branch ? { branch: record.own_branch.name } : {}),
    ...(record?.scope ? { scope_marker: record.scope.marker } : {}),
    ...(record?.early ? { early: true } : {}),
    ...(record?.complete ? { complete: true } : {}),
    ...(record?.held ? { held: record.held } : {}),
    ...(record?.cleanup_error ? { cleanup_error: record.cleanup_error } : {}),
    ...(record?.operator_release ? { operator_release: record.operator_release } : {}),
  };
}

/** `writeAtomic` at lane start, without waiting on the main thread (#704): the same
 * bytes, whole or not at all. */
export async function writeAtomicAsync(path: string, value: unknown): Promise<void> {
  await writeTextAsync(path, `${JSON.stringify(value)}\n`);
}

/** Write a record whole or not at all (a crash leaves the previous one or none). */
export function writeAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true }); // no half-written sibling stays behind
    throw error;
  }
}

/**
 * An operator's confirmation that what this thread's held preparation started
 * has ended (`confirmPreparationRelease`): compared with the inspected digest,
 * recorded in the record, then the thread's own release. The caller holds the
 * thread's mutation chain and has found none of its turns queued or running.
 */
export function confirmThreadRelease(
  projectRoot: string,
  tree: string,
  input: ConfirmationInput & { quiet?: PreparationQuietRead },
): Promise<ConfirmationOutcome> {
  const quiet = input.quiet ?? ((facts) => preparationQuiet(facts));
  return confirmPreparationRelease<ThreadPreparationRecord>(input, {
    read: () => readFile(threadPreparationRecordPath(tree), "utf8"),
    parse: (bytes) => parseThreadPreparation(bytes, tree),
    generation: threadGeneration,
    basis: (record) => record.operator_release,
    stop: (record) => record.held,
    refusal: async () =>
      hasPreparationChild(tree) ? "this preparation's current child has not exited" : null,
    quiet: (record) => quiet(holdFactsOf(record.scope?.marker, record.held)),
    writer: (record) => ({
      opened_at: record.opened_at,
      ...(record.held ? { held_at: record.held.at } : {}),
    }),
    recordBasis: (record, basis) => {
      const { cleanup_error: _old, ...rest } = record;
      writeThreadPreparation({ ...rest, operator_release: basis });
    },
    release: async () => {
      try {
        const done = await releaseThreadPreparation(projectRoot, tree, quiet);
        return done === "none" ? "released" : done;
      } catch (error) {
        if (error instanceof PreparationHeld) return "held";
        throw error;
      }
    },
  });
}
