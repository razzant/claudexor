/**
 * The one release decision over a held preparation resource (#694 r17), shared
 * by a thread's record, an envelope base and an object-store staging directory,
 * and the operator's confirmation where neither proof nor a saved ordinary
 * cleanup basis already permits release.
 *
 * A read that proved the end releases (`machine_proven`). Where the read could
 * prove nothing (`unproven`: Windows has no group probe and no census, or a
 * daemon that died midway left no observed exit) the resource stays held after
 * an unconfirmed stop or a crash, until an operator who checked that the old
 * processes and their children ended records that confirmation AT the resource
 * (`operator_release`), bound to the generation of the record it was given for
 * (`operator_confirmed`). A confirmation also covers the one held reason a pid
 * alone cannot settle: the stopped step's own writer, recorded by pid without a
 * birth, whose pid is in use again. It outweighs nothing a read measures alive:
 * a process group with members, a live or unreadable known scope member, a
 * failed census. The preparation's own call after an ordinary failure, whose
 * record names no stop, still releases under the platform's tree-only limit
 * (`platform_limit`): healthy work on Windows is not blocked by what this
 * platform cannot read. A saved ordinary cleanup or handover of that same
 * generation continues as `saved_cleanup`, without a new confirmation or proof.
 *
 * The confirmation is the operator's statement, recorded; it is never a proof
 * and never changes what the stop was (`termination_unconfirmed` stays), its
 * costs or whether anything was dispatched. A new record never carries it: the
 * generation of a thread's record is its `opened_at` and its stop's `at`, of a
 * base its envelope id and its stop's `at`, of a staging directory its creator.
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  WorkspaceError,
  type PreparationQuietVerdict,
  type ProcessIdentity,
} from "@claudexor/core";
import type { PreparationReleaseBasis } from "@claudexor/schema";
import { gitCommonDir, worktreeRepository } from "./git.js";
import { git } from "./git-run.js";
import type { ThreadPreparationRecord } from "./preparation-hold.js";

/** The common Git directory kept before cleanup loses the worktree's .git
 * pointer. Its inode distinguishes a replacement at that path after a restart;
 * null where the filesystem has none. Shared by preparation and purge. */
export interface PurgeRepositoryRecord {
  gitDir: string;
  identity: string | null;
}

export function repositoryRecord(gitDir: string): PurgeRepositoryRecord {
  const { ino } = statSync(gitDir, { bigint: true });
  return { gitDir, identity: ino === 0n ? null : String(ino) };
}

/** The worktree's own pointer wins (including after a move and repair), then
 * the saved identity, then the project for legacy records with no pointer.
 * An unreadable authority refuses before any tree or Git state is removed. */
export async function resolveThreadRepository(
  projectRoot: string,
  tree: string,
  threadId: string,
  repository: PurgeRepositoryRecord | null,
  worktreeRecorded: boolean,
): Promise<PurgeRepositoryRecord | null> {
  const recorded = () => recordedRepository(repository, threadId);
  const owner =
    worktreeRepository(tree, recorded) ??
    recorded() ??
    (await projectRepository(projectRoot, worktreeRecorded));
  return owner === null ? null : repositoryRecord(owner);
}

function recordedRepository(
  repository: PurgeRepositoryRecord | null,
  threadId: string,
): string | null {
  if (repository === null) return null;
  const now = statSync(repository.gitDir, { bigint: true, throwIfNoEntry: false });
  if (
    now &&
    (repository.identity === null || now.ino === 0n || String(now.ino) === repository.identity)
  )
    return repository.gitDir;
  throw new WorkspaceError(
    `repository ${repository.gitDir}, which this cleanup recorded as holding thread ${threadId}'s worktree registration and branch, is gone or another one is there now; returning it there lets the next attempt finish this cleanup`,
  );
}

/** Without the worktree's pointer or saved identity, use the project folder's
 * repository. No repository is not proof of absence for recorded Git state. */
async function projectRepository(
  projectRoot: string,
  worktreeRecorded: boolean,
): Promise<string | null> {
  if (existsSync(projectRoot)) {
    for (let current = resolve(projectRoot); ; current = dirname(current)) {
      if (existsSync(join(current, ".git"))) return gitCommonDir(projectRoot);
      if (dirname(current) === current) break;
    }
  }
  if (!worktreeRecorded) return null;
  throw new WorkspaceError(
    `project folder ${projectRoot} is gone or in no Git repository, so the thread's worktree registration and branch cannot be checked; restoring the folder there lets the next attempt finish this cleanup`,
  );
}

/** Delete only the branch this preparation made, by Git's atomic tip compare.
 * A moved branch is kept for the next turn to recover; an unreadable ref or a
 * still-owned branch whose deletion failed keeps the release retryable. */
export async function removeOwnBranch(
  repo: string,
  own: { name: string; tip: string },
): Promise<void> {
  const ref = `refs/heads/${own.name}`;
  const tipNow = async (): Promise<string | null> => {
    const read = await git(repo, ["rev-parse", "--verify", "--quiet", ref]);
    if (read.code === 0) return read.stdout.trim();
    if (read.code === 1) return null;
    throw new WorkspaceError(`git rev-parse ${ref} failed: ${read.stderr.trim()}`);
  };
  if ((await tipNow()) !== own.tip) return;
  const deleted = await git(repo, ["update-ref", "-d", ref, own.tip]);
  if (deleted.code === 0) return;
  // The compare may have lost to a move or a deletion in between: read again.
  if ((await tipNow()) !== own.tip) return;
  throw new WorkspaceError(
    `branch ${own.name} is still at the tip this preparation made it at, but could not be deleted: ${deleted.stderr.trim()}`,
  );
}

export type ReleaseBasis = PreparationReleaseBasis | "platform_limit";

/** What an operator recorded at a held resource before its release. */
export interface OperatorReleaseBasis {
  /** When the confirmation was recorded (ISO). */
  confirmed_at: string;
  /** The generation of the record it was given for (`threadGeneration` &c.). */
  generation: string;
  /** What the machine read showed then: history, not a measurement. */
  observation: {
    reasons: string[];
    unproven?: string;
    writer?: WriterObservation;
  };
}

export type ReleaseDecision =
  | { release: true; basis: ReleaseBasis; unproven: string[] }
  | { release: false; reasons: string[]; operatorMayConfirm: boolean };

/** Only the recorded direct writer's pid in use holds (no other measured reason). */
export function writerOnlyHeld(verdict: PreparationQuietVerdict): boolean {
  return (
    verdict.status === "held" && verdict.writerInUse !== undefined && verdict.reasons.length === 1
  );
}

/**
 * Whether a read's verdict releases the resource, and on what basis.
 * `operator`: the record carries an operator confirmation bound to its own
 * generation. `platformLimit`: the creator's own call after an ordinary failure.
 * `savedCleanup`: this generation may continue its saved ordinary cleanup/handover.
 */
export function releaseDecision(
  verdict: PreparationQuietVerdict,
  grounds: { operator: boolean; platformLimit: boolean; savedCleanup?: boolean },
): ReleaseDecision {
  if (verdict.status === "quiet" && verdict.unproven === undefined)
    return { release: true, basis: "machine_proven", unproven: [] };
  const writerOnly = writerOnlyHeld(verdict);
  if (grounds.operator && (verdict.status === "quiet" || writerOnly))
    return { release: true, basis: "operator_confirmed", unproven: unprovenOf(verdict) };
  if (verdict.status === "quiet" && grounds.savedCleanup)
    return { release: true, basis: "saved_cleanup", unproven: unprovenOf(verdict) };
  if (verdict.status === "quiet" && grounds.platformLimit)
    return { release: true, basis: "platform_limit", unproven: unprovenOf(verdict) };
  if (verdict.status === "quiet")
    return {
      release: false,
      reasons: [`${verdict.unproven}: no read can prove that what it started has ended`],
      operatorMayConfirm: true,
    };
  return { release: false, reasons: verdict.reasons, operatorMayConfirm: writerOnly };
}

function unprovenOf(verdict: PreparationQuietVerdict): string[] {
  return [
    ...(verdict.status === "held" ? verdict.reasons : []),
    ...(verdict.unproven !== undefined ? [verdict.unproven] : []),
  ];
}

/** A confirmation applies only to the generation it was given for. */
export function boundOperatorRelease(
  basis: OperatorReleaseBasis | undefined,
  generation: string,
): boolean {
  return basis !== undefined && basis.generation === generation;
}

export function threadGeneration(record: {
  thread_id: string;
  opened_at: string;
  held?: { at: string };
}): string {
  return `thread:${record.thread_id}:${record.opened_at}:${record.held?.at ?? ""}`;
}

/** The saved ordinary release that this generation may continue. It is no
 * process proof: a fresh read, current child or active turn still holds it. */
export function threadCleanupContinuation(
  record: ThreadPreparationRecord,
): { basis: "platform_limit" | "handover"; reason: string } | null {
  const saved = record.cleanup_basis;
  if (
    !saved ||
    record.held !== undefined ||
    saved.generation !== threadGeneration(record) ||
    (saved.basis !== "platform_limit" && saved.basis !== "handover")
  )
    return null;
  return {
    basis: saved.basis,
    reason: `This generation's saved ${saved.basis} cleanup basis permits release after fresh checks, without a new operator confirmation. It is not a machine proof.`,
  };
}

export function envelopeGeneration(
  owner: { envelope_id?: unknown; created_at?: unknown },
  held: { at: string } | undefined,
): string {
  return `envelope:${String(owner.envelope_id ?? "")}:${String(owner.created_at ?? "")}:${held?.at ?? ""}`;
}

export function stagingGeneration(record: {
  creator: { pid: number; identity?: { startToken: string } };
  scope: { marker: string } | null;
}): string {
  return `staging:${record.creator.pid}:${record.creator.identity?.startToken ?? ""}:${record.scope?.marker ?? ""}`;
}

/** The digest an inspection hands out for the record's exact bytes. */
export function recordDigest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * What one read of the recorded writer's pid shows, at the operator's boundary
 * only (Windows, where the opt-in birth reader exists). The record saved no
 * birth for that writer, so nothing here is a matched identity:
 *
 * - `plausible_original`: born inside the record's comparable `opened_at..at`
 *   window — it may still be the stopped writer, and the confirmation is refused;
 * - `born_after_hold`: born after the stop was recorded — this pid is no longer
 *   an authority for that writer (its children's end is still the operator's
 *   statement);
 * - `missing`: the pid is not in use now;
 * - `unknown`: no reader, a failed or timed-out read, a birth before the window,
 *   or a window that cannot be compared. Unknown is never an end.
 */
export interface WriterObservation {
  pid: number;
  outcome: "plausible_original" | "born_after_hold" | "missing" | "unknown";
  /** The reader's opaque birth token, when it read one. */
  birth?: string;
  detail?: string;
}

/** Windows FILETIME (100 ns since 1601) of a `win32:<n>` token, in ms since 1970. */
function win32BirthMs(token: string): number | null {
  const match = /^win32:([1-9][0-9]{0,19})$/.exec(token);
  if (!match) return null;
  const ms = (BigInt(match[1]!) - 116_444_736_000_000_000n) / 10_000n;
  return ms > 0n && ms <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(ms) : null;
}

export function observeWriter(
  pid: number,
  identity: ProcessIdentity | null,
  window: { opened_at?: string; held_at?: string },
): WriterObservation {
  if (identity === null) return { pid, outcome: "unknown", detail: "no birth reader here" };
  if (identity.status === "missing") return { pid, outcome: "missing" };
  if (identity.status === "unknown") return { pid, outcome: "unknown", detail: identity.reason };
  const birth = identity.startToken;
  const born = win32BirthMs(birth);
  const opened = window.opened_at ? Date.parse(window.opened_at) : Number.NaN;
  const held = window.held_at ? Date.parse(window.held_at) : Number.NaN;
  if (born === null || !Number.isFinite(opened) || !Number.isFinite(held) || held < opened)
    return { pid, outcome: "unknown", birth, detail: "no comparable window" };
  if (born > held) return { pid, outcome: "born_after_hold", birth };
  if (born >= opened) return { pid, outcome: "plausible_original", birth };
  return { pid, outcome: "unknown", birth, detail: "born before the record" };
}

// ---------------------------------------------------------------------------
// This process's own preparations still under way (an envelope base, a staging
// directory): an operator's confirmation never releases one of them.

const underWay = new Map<string, Set<{ child: boolean }>>();

function ownPreparation(path: string, child: boolean): () => void {
  const owners = underWay.get(path) ?? new Set<{ child: boolean }>();
  const owner = { child };
  owners.add(owner);
  underWay.set(path, owners);
  return () => {
    owners.delete(owner);
    if (owners.size === 0 && underWay.get(path) === owners) underWay.delete(path);
  };
}

/** Mark `path` as a preparation this process is making; the disposer ends it. */
export function preparationUnderWay(path: string): () => void {
  return ownPreparation(path, false);
}

/** The call may return before its exact ChildProcess exits. Only that observed
 * exit ends this ownership; a rejected observation proves nothing. No disk fact
 * recreates it after Restart, where the old PID-only recovery remains available. */
export function holdPreparationChild(path: string, directExit: Promise<void>): void {
  const done = ownPreparation(path, true);
  void directExit.then(done, () => {});
}

export function hasPreparationChild(path: string): boolean {
  return [...(underWay.get(path) ?? [])].some((owner) => owner.child);
}

export function isPreparationUnderWay(path: string): boolean {
  return underWay.has(path);
}

// ---------------------------------------------------------------------------
// The explicit release door: one resource, bound to an inspected digest.

export interface ConfirmationInput {
  /** The digest an inspection handed out for the record's exact bytes. */
  digest: string;
  /** The birth reader of the recorded writer's pid at this boundary (Windows); null: none. */
  readWriter: ((pid: number) => Promise<ProcessIdentity>) | null;
}

/**
 * - `released` / `completed`: the resource's own release ran (`completed`: a
 *   finished checkout kept as made, only its record went);
 * - `cleanup_failed`: it ran and a step failed; the record keeps any saved
 *   basis, so a new request or the resource's next release can retry it;
 *   the same idempotency key only reads the retained receipt;
 * - `refused`: what a read measures, an unreadable record, a live creator or a
 *   preparation still under way: nothing changed;
 * - `stale`: the record is not the one inspected: inspect again;
 * - `not_held`: no held preparation is there (this proves nothing about an
 *   earlier request whose answer was lost);
 * - `basis_not_recorded`: the confirmation could not be saved, so nothing was released.
 */
export type ConfirmationOutcome =
  | ({
      outcome: "released" | "completed" | "cleanup_failed";
      basis: PreparationReleaseBasis;
      /** An earlier request's confirmation of this same generation was continued. */
      continued: boolean;
      cleanup_error?: string;
      writer?: WriterObservation;
    } & RecordFacts)
  | ({
      outcome: "refused" | "stale" | "basis_not_recorded";
      reasons: string[];
      writer?: WriterObservation;
    } & Partial<RecordFacts>)
  | { outcome: "not_held" };

/** What the record said when the request read it: kept with the outcome, since a
 * release removes the record. History, never a measurement. */
export interface RecordFacts {
  generation: string;
  /** The stop the record names (null after a crash, or for staging). */
  stop: { reason: string; groups: number[]; at: string } | null;
  /** The operator confirmation the record carries after this request (new or
   * continued); null when none was needed or none could be recorded. */
  confirmed_at: string | null;
}

export interface ConfirmationSteps<R> {
  /** The record's bytes (ENOENT: not held). */
  read(): Promise<string>;
  /** The record, or null when it holds nothing (a finished preparation). */
  parse(bytes: string): R | null;
  generation(record: R): string;
  basis(record: R): OperatorReleaseBasis | undefined;
  /** The stop the record names, if any. */
  stop(record: R): { reason: string; groups: readonly number[]; at: string } | undefined;
  /** A live owner or a preparation still under way refuses (its reason), else null. */
  refusal(record: R): Promise<string | null>;
  quiet(record: R): Promise<PreparationQuietVerdict>;
  /** Whether this generation may continue its saved ordinary cleanup/handover.
   * It permits only an otherwise quiet release, never a new confirmation or proof. */
  savedCleanup?(record: R): boolean;
  /** The record's window for the writer observation. */
  writer(record: R): { opened_at?: string; held_at?: string };
  recordBasis(record: R, basis: OperatorReleaseBasis): Promise<void> | void;
  /** The resource's own release (it honours the recorded confirmation). */
  release(): Promise<"released" | "completed" | "held">;
}

/** Run by the resource's own serialization owner (the caller holds it). */
export async function confirmPreparationRelease<R>(
  input: ConfirmationInput,
  steps: ConfirmationSteps<R>,
): Promise<ConfirmationOutcome> {
  let bytes: string;
  try {
    bytes = await steps.read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "not_held" };
    return { outcome: "refused", reasons: [`the record cannot be read: ${message(error)}`] };
  }
  let record: R | null;
  try {
    record = steps.parse(bytes);
  } catch (error) {
    return { outcome: "refused", reasons: [`the record cannot be parsed: ${message(error)}`] };
  }
  if (record === null) return { outcome: "not_held" };
  const recorded = steps.stop(record);
  const existing = steps.basis(record);
  const facts: RecordFacts = {
    generation: steps.generation(record),
    stop: recorded
      ? { reason: recorded.reason, groups: [...recorded.groups], at: recorded.at }
      : null,
    confirmed_at: null,
  };
  const continued = boundOperatorRelease(existing, facts.generation);
  if (continued) facts.confirmed_at = existing!.confirmed_at;
  if (!continued && recordDigest(bytes) !== input.digest)
    return {
      outcome: "stale",
      reasons: ["the record changed since it was inspected: inspect it again"],
      ...facts,
    };
  const owner = await steps.refusal(record);
  if (owner !== null) return { outcome: "refused", reasons: [owner], ...facts };
  const verdict = await steps.quiet(record);
  let writer: WriterObservation | undefined;
  if (verdict.status === "held" && !writerOnlyHeld(verdict))
    return { outcome: "refused", reasons: verdict.reasons, ...facts };
  if (verdict.status === "held") {
    const pid = verdict.writerInUse!;
    writer = observeWriter(
      pid,
      input.readWriter ? await input.readWriter(pid) : null,
      steps.writer(record),
    );
    if (writer.outcome === "plausible_original")
      return {
        outcome: "refused",
        reasons: [
          `the recorded writer's pid ${pid} names a process born while that preparation ran: it may still be the stopped writer`,
        ],
        writer,
        ...facts,
      };
  }
  const extra = writer ? { writer } : {};
  const savedCleanup =
    !continued &&
    verdict.status === "quiet" &&
    verdict.unproven !== undefined &&
    steps.savedCleanup?.(record) === true;
  const operator = !savedCleanup && (verdict.status === "held" || verdict.unproven !== undefined);
  if (operator && !continued) {
    const basis: OperatorReleaseBasis = {
      confirmed_at: new Date().toISOString(),
      generation: facts.generation,
      observation: {
        reasons: verdict.status === "held" ? verdict.reasons : [],
        ...(verdict.unproven !== undefined ? { unproven: verdict.unproven } : {}),
        ...extra,
      },
    };
    try {
      await steps.recordBasis(record, basis);
    } catch (error) {
      return {
        outcome: "basis_not_recorded",
        reasons: [
          `the confirmation could not be recorded, so nothing was released: ${message(error)}`,
        ],
        ...extra,
        ...facts,
      };
    }
    facts.confirmed_at = basis.confirmed_at;
  }
  const basis: PreparationReleaseBasis = savedCleanup
    ? "saved_cleanup"
    : operator
      ? "operator_confirmed"
      : "machine_proven";
  try {
    const done = await steps.release();
    if (done === "held")
      return {
        outcome: "refused",
        reasons: ["a read at the release measured what holds it again"],
        ...extra,
        ...facts,
      };
    return { outcome: done, basis, continued, ...extra, ...facts };
  } catch (error) {
    return {
      outcome: "cleanup_failed",
      basis,
      continued,
      cleanup_error: message(error),
      ...extra,
      ...facts,
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
