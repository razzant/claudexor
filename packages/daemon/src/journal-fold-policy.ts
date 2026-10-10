/**
 * The daemon's journal fold policy: which retained records a partition may
 * forget at replay and at compaction (journal sprint owner decision D1). The
 * journal package stays generic — it applies these verdicts in seq order — and
 * this module decides WHAT is dead, per record type, from the payload alone.
 *
 * Every verdict is a pure function of the record: no state between records,
 * so the one frozen policy serves every partition and every pass (read-only
 * preparation, activation, background compaction). An unknown or malformed
 * record is always kept — the fold forgets superseded history, never evidence
 * it cannot classify.
 *
 * Invariants the projections replay under (the equivalence test pins them):
 *   - a command keeps its `command.accepted` (a group per id, so a duplicate
 *     acceptance survives) and its latest `command.updated`;
 *     `command.pruned` forgets both plus the pruned runs' journaled run events,
 *     and survives itself as the latest tombstone per root set so crash-GC keeps
 *     the pruned commands' project roots (model-operation receipts are never
 *     pruned by retention — INV-064);
 *   - a terminal run keeps its terminal `run.event` (exactly one in a
 *     well-formed journal; duplicate terminals survive until the run's prune
 *     tombstone retires the whole group, so replay validation fails on them
 *     as loudly as on an unfolded journal); a live run keeps `run.created`
 *     plus its journaled progress events;
 *   - a resolved interaction forgets its request AND its resolution as a pair
 *     through the resolution (a resolution follows its request, so retiring
 *     on the resolution can never leave a partial pair — an `interrupted` or
 *     `run_terminal` resolution lands AFTER the run's terminal event); a
 *     pending request is kept per id as a group, so a duplicate request frame
 *     survives for the InteractionStore's own duplicate check until its
 *     resolution retires the whole group. Every `interaction.resolved` frame
 *     is dropped, so an orphan or duplicate resolution the unfolded replay
 *     refuses ("interaction resolution precedes request") is forgotten on the
 *     folded path — inherent in the pair rule, disclosed;
 *   - quota keeps the latest projection marker and, per subject key, two
 *     slots: the latest scoped prepare and the latest upsert. Sequence numbers
 *     are preserved, so the registry's adjacency check (`upsert.seq ===
 *     prepare.seq + 1`) commits exactly the pairs that were adjacent on disk;
 *     a prepare left behind by a later plain upsert is non-adjacent and ignored
 *     on replay like any orphan prepare today (residual: at most one stale
 *     prepare frame per subject). `quota.subject.removed` retires both slots
 *     of that (harness, subject_id) across routes and sources;
 *   - `thread.head.updated` keeps the latest revision per thread;
 *   - `setup.job.saved` is kept whole (the setup reducer validates every
 *     state/phase/evidence transition, so intermediate saves are replay
 *     authority); a terminal save retires the job's `setup.job.log` lines.
 */
import type { FoldRecord, FoldVerdict, JournalFold } from "./store/legacy-journal/journal-fold.js";
import {
  CredentialRoute,
  AccountResourcesObserved,
  AccountResourcesInvalidated,
  QuotaSnapshot as QuotaSnapshotSchema,
  QuotaSource,
  QuotaWindowObservation,
  QuotaWindowSupersession,
  TERMINAL_CONTROL_SETUP_JOB_STATES,
} from "@claudexor/schema";
import { legacyV320Snapshot, snapshotKey } from "./quota-registry-support.js";

const KEEP: FoldVerdict = Object.freeze({});
const TERMINAL_RUN_EVENTS = new Set(["run.completed", "run.failed", "run.blocked"]);
const TERMINAL_SETUP_STATES = new Set<string>(TERMINAL_CONTROL_SETUP_JOB_STATES);

/** The one frozen policy for every partition and every pass. */
export const journalFoldPolicy: JournalFold = Object.freeze({ verdict: journalFoldVerdict });

function journalFoldVerdict(record: FoldRecord): FoldVerdict {
  try {
    switch (record.type) {
      case "command.accepted":
        // A group per id, never a slot: a duplicate acceptance (same id,
        // conflicting digest) must survive for the CommandStore's own
        // idempotency-history check, as on an unfolded journal.
        return groupOrKeep(commandId(record.payload), (id) => `c:${id}:a`);
      case "command.updated":
        return slotOrKeep(commandId(record.payload), (id) => `c:${id}:u`);
      case "command.pruned":
        return prunedVerdict(record.payload);
      case "run.event":
        return runEventVerdict(record.payload);
      case "interaction.requested":
        return interactionRequestedVerdict(record.payload);
      case "interaction.resolved":
        return interactionResolvedVerdict(record.payload);
      case "quota.projection.updated":
        return { slot: "q:marker" };
      case "quota.snapshot.scoped_prepared":
        return slotOrKeep(scopedPreparedKey(record.payload), (key) => `q:${key}:p`);
      case "quota.snapshot.upserted":
        return slotOrKeep(upsertedKey(record.payload), (key) => `q:${key}:u`);
      case "quota.resources.invalidated": {
        const parsed = AccountResourcesInvalidated.safeParse(record.payload);
        if (!parsed.success) return KEEP;
        const target = parsed.data.target;
        return {
          slot: `q:resources:cutoff:${JSON.stringify([target.harness, target.profile_id])}`,
        };
      }
      case "quota.resources.observed": {
        const parsed = AccountResourcesObserved.safeParse(record.payload);
        if (!parsed.success) return KEEP;
        const target = parsed.data.observation.target;
        return { slot: `q:resources:${JSON.stringify([target.harness, target.profile_id])}` };
      }
      case "quota.window.observed": {
        const observation = QuotaWindowObservation.safeParse(record.payload);
        if (!observation.success) return KEEP;
        const snapshot = observation.data.snapshot;
        return {
          slot: `q:window:${snapshotKey(snapshot)}`,
          group: quotaWindowGroup(snapshot.subject.harness, snapshot.subject.subject_id),
        };
      }
      case "quota.window.superseded": {
        const supersession = QuotaWindowSupersession.safeParse(record.payload);
        if (!supersession.success) return KEEP;
        const value = supersession.data;
        return {
          slot: `q:window:superseded:${value.snapshot_id}`,
          group: quotaWindowGroup(value.subject.harness, value.subject.subject_id),
          retire: [`q:window:${value.snapshot_id}`],
        };
      }
      case "quota.subject.removed":
        return removedSubjectVerdict(record.payload);
      case "thread.head.updated":
        return slotOrKeep(stringField(record.payload, "thread_id"), (id) => `t:${id}`);
      case "setup.job.saved":
        return setupSavedVerdict(record.payload);
      case "setup.job.log":
        return groupOrKeep(stringField(record.payload, "jobId"), (id) => `s:${id}:log`);
      default:
        return KEEP;
    }
  } catch {
    return KEEP;
  }
}

function slotOrKeep(key: string | null, name: (key: string) => string): FoldVerdict {
  return key === null ? KEEP : { slot: name(key) };
}

function groupOrKeep(key: string | null, name: (key: string) => string): FoldVerdict {
  return key === null ? KEEP : { group: name(key) };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown, key: string): string | null {
  const field = object(value)?.[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((item) => typeof item === "string" && item.length > 0)
    ? (value as string[])
    : null;
}

function commandId(payload: unknown): string | null {
  return stringField(object(payload)?.record, "id");
}

/** Every run event of a run is keyed under its run id; the terminal retires
 * the live group and the created slot, and a prune tombstone retires all three. */
function runEventNames(runId: string): string[] {
  return [`r:${runId}:t`, `r:${runId}:live`, `r:${runId}:c`];
}

/** A prune tombstone retires its commands' records AND every journaled run
 * event of the runs those commands owned (`run_ids`, written since this
 * change; legacy tombstones without it retire the commands only), and is
 * itself kept — the latest per set of project roots it names — because
 * crash-GC reads the roots of pruned commands from it. Ids in a superseded
 * tombstone are dead weight: its retire already ran when it was folded. */
function prunedVerdict(payload: unknown): FoldVerdict {
  const value = object(payload);
  const ids = stringList(value?.ids);
  if (!ids) return KEEP;
  const roots = stringList(value?.roots) ?? [];
  const runIds = stringList(value?.run_ids) ?? [];
  return {
    slot: `c:pruned:${[...roots].sort().join("\0")}`,
    retire: [...ids.flatMap((id) => [`c:${id}:a`, `c:${id}:u`]), ...runIds.flatMap(runEventNames)],
  };
}

/** A terminal run keeps only its terminal: `run.created` and the journaled
 * progress events are forgotten with it (the macOS app auto-attaches on
 * `run.created` only for live runs; durable terminal recovery reads terminals
 * only; the per-run stream replays `events.jsonl`). Terminals are a GROUP per
 * run, never a slot: a second terminal for the same run is corruption the
 * terminal index must still see and refuse, exactly as on an unfolded journal,
 * until the run's prune tombstone retires the whole group. */
function runEventVerdict(payload: unknown): FoldVerdict {
  const runId = stringField(payload, "run_id");
  const type = stringField(payload, "type");
  if (runId === null || type === null) return KEEP;
  if (TERMINAL_RUN_EVENTS.has(type)) {
    return { group: `r:${runId}:t`, retire: [`r:${runId}:live`, `r:${runId}:c`] };
  }
  if (type === "run.created") return { slot: `r:${runId}:c` };
  return { group: `r:${runId}:live` };
}

/** A group per id, never a slot: a duplicate request frame must survive for
 * the InteractionStore's own duplicate check, as on an unfolded journal. */
function interactionRequestedVerdict(payload: unknown): FoldVerdict {
  const runId = stringField(payload, "runId");
  const interactionId = stringField(payload, "interactionId");
  if (runId === null || interactionId === null) return KEEP;
  return { group: `i:${runId}:${interactionId}` };
}

/** The resolution retires exactly the requests it settles and is itself
 * forgotten: the InteractionStore rebuilds only still-pending questions. */
function interactionResolvedVerdict(payload: unknown): FoldVerdict {
  const runId = stringField(payload, "runId");
  const interactionIds = stringList(object(payload)?.interactionIds);
  if (runId === null || !interactionIds) return KEEP;
  return { drop: true, retire: interactionIds.map((id) => `i:${runId}:${id}`) };
}

/** Both quota slots are keyed by the LEGACY base snapshot, which is the key
 * the committing upsert carries on the wire (sources are harness-specific, so
 * the only legacy remap — cursor_rate_limit to claude_api_retry — never
 * collides with a genuine legacy-source snapshot of the same subject). */
function scopedPreparedKey(payload: unknown): string | null {
  const snapshot = QuotaSnapshotSchema.safeParse(object(payload)?.snapshot);
  return snapshot.success ? snapshotKey(legacyV320Snapshot(snapshot.data)) : null;
}

function upsertedKey(payload: unknown): string | null {
  const snapshot = QuotaSnapshotSchema.safeParse(payload);
  return snapshot.success ? snapshotKey(snapshot.data) : null;
}

/** `quota.subject.removed` names only (harness, subject_id); the registry
 * removes every snapshot of that subject across routes and sources, so the
 * retire list enumerates the schema's route and source vocabularies. A journal
 * can only replay sources the schema still knows, so the enumeration is
 * complete for every replayable record. */
function removedSubjectVerdict(payload: unknown): FoldVerdict {
  const value = object(payload);
  const harness = typeof value?.harness === "string" ? value.harness : null;
  const subjectId = value?.subject_id;
  if (harness === null || (typeof subjectId !== "string" && subjectId !== null)) return KEEP;
  const subject = subjectId ?? "";
  const retire: string[] = [
    quotaWindowGroup(harness, subjectId),
    ...(subjectId === null || value?.preserve_resources === true
      ? []
      : [
          `q:resources:${JSON.stringify([harness, subjectId])}`,
          `q:resources:cutoff:${JSON.stringify([harness, subjectId])}`,
        ]),
  ];
  for (const route of CredentialRoute.options) {
    for (const source of QuotaSource.options) {
      const key = [harness, route, subject, source].join("\0");
      retire.push(`q:${key}:p`, `q:${key}:u`);
    }
  }
  return { slot: `q:${harness}\0${subject}:removed`, retire };
}

function quotaWindowGroup(harness: string, subjectId: string | null): string {
  return `q:windows:${JSON.stringify([harness, subjectId])}`;
}

function setupSavedVerdict(payload: unknown): FoldVerdict {
  const job = object(object(payload)?.job);
  const jobId = stringField(job, "jobId");
  const state = stringField(job, "state");
  if (jobId === null || state === null || !TERMINAL_SETUP_STATES.has(state)) return KEEP;
  return { retire: [`s:${jobId}:log`] };
}
