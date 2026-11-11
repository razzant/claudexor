/**
 * Codex rollout-transcript readers: the CLI's own session record
 * (`$CODEX_HOME/sessions/<Y>/<M>/<D>/rollout-*-<threadId>.jsonl`) is the
 * native machine-readable source for the observed model (route proof),
 * the rate-window quota, and the vendor's own typed failure for a turn it
 * ended with an error. One owner for rollout facts; every byte comes through
 * the bounded, link-refusing boundary in `rollout-file.ts`.
 */
import { closeSync } from "node:fs";
import type { HarnessEvent, VendorFailureEvidence } from "@claudexor/schema";
import { codexQuotaRequestKind } from "./quota.js";
import {
  findCodexRollout,
  openCodexRolloutPart,
  scanRolloutLines,
  type MarkedLine,
  type RolloutFile,
} from "./rollout-file.js";

const TURN_CONTEXT = "turn_context";
const RATE_LIMITS = "rate_limits";
const TASK_STARTED = "task_started";
const TASK_COMPLETE = "task_complete";

type CodexQuota = NonNullable<HarnessEvent["quota"]>;
/** A `turn_context`: its model (null when absent or unreadable) and its turn id. */
type TurnModel = { model: string | null; turn: unknown };
/** A marker line that might be a `turn_context` but cannot be read: any turn's, model unknown. */
const UNREADABLE: TurnModel = { model: null, turn: null };
type RolloutFacts = {
  model: TurnModel | null;
  turnModel: string | null;
  latest: CodexQuota | null;
};

/**
 * Where a run's rollout reading left off: the located file, its identity, the
 * byte offset just past the last complete line consumed, and the facts of
 * those lines. One cursor per run; the model and the quota share its pass.
 */
export interface CodexRolloutCursor {
  home: string | null;
  threadId: string | null;
  rollout: string | null;
  dev: number | null;
  ino: number | null;
  offset: number;
  /** The turn the stream started, whose own model the run reports; null when none was named. */
  turnId: string | null;
  /** The last `turn_context` of any turn. */
  model: TurnModel | null;
  /** `turnId`'s model from its own latest record; null until seen or after an unreadable one. */
  turnModel: string | null;
  latest: CodexQuota | null;
}

export function codexRolloutCursor(): CodexRolloutCursor {
  return {
    home: null,
    threadId: null,
    rollout: null,
    dev: null,
    ino: null,
    offset: 0,
    turnId: null,
    model: null,
    turnModel: null,
    latest: null,
  };
}

/**
 * Route proof: recover the model codex ACTUALLY ran from its own session
 * rollout file (`turn_context.payload.model`). This is the codex CLI's OWN
 * record — a real observation, not an argv echo — so it honestly upgrades the
 * cross-family route proof to `verified` (CLAUDEXOR_BIBLE §5) for a CLI whose
 * `--json` stream never carries the model. Best-effort: any missing/ambiguous/
 * unreadable state returns null and the proof stays unobserved (safe
 * degradation, never throws).
 *
 * The LAST `turn_context` speaks: a RESUMED session (`exec resume`,
 * `thread/resume`) accumulates turns in one rollout, so the model must reflect
 * the most recent turn, not a stale earlier one; a newer candidate line that
 * cannot be parsed leaves the model unknown rather than reviving the older
 * one. Codex records a turn's `turn_context` seconds after the turn starts, so
 * a reader that may run first passes the turn the stream started (`turnId`):
 * only that turn's own record counts, also when later turns of the same run
 * (goal continuations) are recorded before the next read, and a rollout
 * without turn ids cannot prove it. Without `turnId` (the exec stream carries
 * none) the last record is taken as is. A cursor makes the read incremental.
 */
export function codexTranscriptModel(
  codexHome: string | null | undefined,
  threadId: string | undefined,
  cursor: CodexRolloutCursor = codexRolloutCursor(),
  turnId?: string,
): string | null {
  const facts = readRolloutFacts(codexHome, threadId, cursor, turnId);
  if (!facts) return null;
  return turnId === undefined ? (facts.model?.model ?? null) : facts.turnModel;
}

/**
 * Quota headroom: recover codex's OWN rate-window record from the rollout
 * (`event_msg.payload.token_count.rate_limits.{primary,secondary}`), the same
 * native machine-readable source route proof uses. Returns every window in the
 * LAST record independently. Best-effort: null on anything missing.
 *
 * Incremental: a cursor kept across a run's events reads only the bytes
 * appended since its last call (codex appends whole lines). An unterminated
 * last line is evaluated but not consumed, a replaced or truncated rollout
 * starts over, and the answer always equals reading the whole file.
 */
export function codexTranscriptRateLimits(
  codexHome: string | null | undefined,
  threadId: string | undefined,
  cursor: CodexRolloutCursor = codexRolloutCursor(),
): CodexQuota | null {
  return readRolloutFacts(codexHome, threadId, cursor)?.latest ?? null;
}

/**
 * Advance the cursor over the appended bytes; null when the rollout is absent
 * or unreadable. A newly named turn restarts the cursor, since what it kept
 * was another turn's; the decoration names its turn before its first read.
 */
function readRolloutFacts(
  codexHome: string | null | undefined,
  threadId: string | undefined,
  cursor: CodexRolloutCursor,
  turnId?: string,
): RolloutFacts | null {
  if (!threadId) return null;
  // An explicit scoped home is REQUIRED (v3.0.3 S9): falling back to the
  // operator's real ~/.codex would read native state Claudexor does not own.
  // Callers always resolve the run's CODEX_HOME; absent means unobserved.
  const home = codexHome && codexHome.trim() ? codexHome : null;
  if (!home) return null;
  if (
    cursor.home !== home ||
    cursor.threadId !== threadId ||
    (turnId !== undefined && cursor.turnId !== turnId)
  ) {
    Object.assign(cursor, codexRolloutCursor(), { home, threadId, turnId: turnId ?? null });
  }
  cursor.rollout ??= findCodexRollout(home, threadId);
  if (!cursor.rollout) return null;
  return withRollout(home, cursor.rollout, (file) => {
    if (file.dev !== cursor.dev || file.ino !== cursor.ino || file.size < cursor.offset) {
      Object.assign(cursor, {
        dev: file.dev,
        ino: file.ino,
        offset: 0,
        model: null,
        turnModel: null,
        latest: null,
      });
    }
    const { turnId: turn, model, turnModel, latest } = cursor;
    const facts = fold(
      file,
      cursor.offset,
      [TURN_CONTEXT, RATE_LIMITS],
      { model, turnModel, latest },
      (state, line) => reduceFacts(state, line, turn),
    );
    Object.assign(cursor, { offset: facts.consumed }, facts.committed);
    return facts.answer;
  });
}

function reduceFacts(facts: RolloutFacts, line: MarkedLine, turn: string | null): RolloutFacts {
  let { model, turnModel, latest } = facts;
  const context = line.markers.has(TURN_CONTEXT) ? turnContextOf(line.record) : null;
  if (context) {
    model = context;
    // The started turn's own record keeps speaking through later turns of the
    // run; an unreadable record could be that turn's and leaves it unknown.
    if (turn !== null && (context === UNREADABLE || context.turn === turn))
      turnModel = context.model;
  }
  if (line.markers.has(RATE_LIMITS) && line.record !== undefined)
    latest = rateLimitsFromRecord(line.record) ?? latest;
  return { model, turnModel, latest };
}

/** The turn a `turn_context` names; null for another record type (the earlier turn still speaks). */
function turnContextOf(record: unknown): TurnModel | null {
  if (record === undefined) return UNREADABLE;
  const rec = record as { type?: unknown; payload?: { model?: unknown; turn_id?: unknown } } | null;
  if (rec?.type !== TURN_CONTEXT) return null;
  const model = rec.payload?.model;
  return {
    model: typeof model === "string" && model.trim() ? model : null,
    turn: rec.payload?.turn_id,
  };
}

function rateLimitsFromRecord(obj: unknown): CodexQuota | null {
  const rl = (obj as { payload?: { rate_limits?: Record<string, unknown> } })?.payload?.rate_limits;
  if (!rl || typeof rl !== "object") return null;
  const bucketId = typeof rl["limit_id"] === "string" ? rl["limit_id"] : "default";
  const requestKind = codexQuotaRequestKind(bucketId);
  if (requestKind === null) return null;
  const constraints = Object.entries(rl).flatMap(([id, value]) => {
    if (!value || typeof value !== "object") return [];
    const w = value as Record<string, unknown>;
    const rawUsed = w["used_percent"];
    if (typeof rawUsed !== "number" || !Number.isFinite(rawUsed)) return [];
    const rawReset = w["resets_at"];
    const resetsAt =
      typeof rawReset === "number"
        ? new Date(rawReset * 1000).toISOString()
        : typeof rawReset === "string"
          ? rawReset
          : null;
    const minutes = w["window_minutes"];
    return [
      {
        id: requestKind === "image" ? `${bucketId}:${id}` : id,
        label: id,
        applies_to_request_kinds: [requestKind],
        used_ratio: Math.min(1, Math.max(0, rawUsed / 100)),
        window_seconds:
          typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
            ? minutes * 60
            : null,
        resets_at: resetsAt,
        cooldown_until: null,
      },
    ];
  });
  return constraints.length > 0
    ? { source: "codex_rollout", plan_label: null, subject_id: null, constraints }
    : null;
}

/**
 * Vendor failure: recover codex's OWN typed failure for the turn that just
 * ended (`event_msg.payload.type == "task_complete"` with an `error` object:
 * `{message, codex_error_info}`), which the `--json` stream reduces to a
 * sentence. Read AFTER the process exited. The code is forwarded verbatim and
 * uninterpreted — there is no mapping table, so a code codex ships tomorrow
 * flows through unchanged; a tagged-object variant yields its variant name.
 *
 * STRUCTURAL, never substring: rollouts quote `codex_error_info` as plain text
 * inside prompts and tool output, so only the record shape above counts (the
 * marker lines the scanner hands over are a cheap prefilter, not a match).
 *
 * Bound to THIS run's turn, because `exec resume` appends turns to one rollout
 * and a run killed before writing its own `task_complete` leaves an earlier
 * turn's record last: the error must sit on the LAST `task_complete`; when the
 * file carries `task_started` markers that record's `turn_id` must equal the
 * last started turn; and its `started_at` (whole seconds) must not precede the
 * second this process was spawned (`notBeforeMs`). Best-effort exactly like the
 * quota reader: any miss, torn line, or ambiguity returns null, never throws.
 * Disclosed residual: an earlier turn that failed within the SAME wall-clock
 * second as this spawn, when this run wrote no turn marker of its own, is
 * indistinguishable here.
 */
export function codexTranscriptVendorFailure(
  codexHome: string | null | undefined,
  threadId: string | undefined,
  notBeforeMs: number,
): VendorFailureEvidence | null {
  if (!threadId) return null;
  // An explicit scoped home is REQUIRED (same rule as the readers above).
  const home = codexHome && codexHome.trim() ? codexHome : null;
  if (!home) return null;
  const rollout = findCodexRollout(home, threadId);
  if (!rollout) return null;
  const turns = withRollout(
    home,
    rollout,
    (file) => fold(file, 0, [TASK_COMPLETE, TASK_STARTED], NO_TURNS, reduceTurns).answer,
  );
  const last = turns?.last;
  if (!turns || !last) return null;
  if (
    turns.sawStarted &&
    (typeof turns.lastStartedTurn !== "string" || last["turn_id"] !== turns.lastStartedTurn)
  )
    return null; // the last completion belongs to an EARLIER turn
  const startedAt = last["started_at"];
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  if (startedAt < Math.floor(notBeforeMs / 1000)) return null; // a turn from before this spawn
  const error = last["error"];
  if (!error || typeof error !== "object" || Array.isArray(error)) return null; // no error recorded
  const info = (error as Record<string, unknown>)["codex_error_info"];
  const variants =
    info && typeof info === "object" && !Array.isArray(info) ? Object.keys(info) : [];
  const code = typeof info === "string" ? info : variants.length === 1 ? variants[0] : undefined;
  const message = (error as Record<string, unknown>)["message"];
  if (!code && typeof message !== "string") return null;
  return {
    code: code ? code.slice(0, 128) : null,
    message: typeof message === "string" ? message.slice(0, 2000) : null,
    source: "codex_rollout",
  };
}

type TurnMarkers = {
  sawStarted: boolean;
  lastStartedTurn: unknown;
  last: Record<string, unknown> | null;
};
const NO_TURNS: TurnMarkers = { sawStarted: false, lastStartedTurn: null, last: null };

function reduceTurns(turns: TurnMarkers, line: MarkedLine): TurnMarkers {
  // A torn record may be the newest turn marker: what came before it no
  // longer provably speaks for the last turn.
  if (line.record === undefined) return { ...turns, last: null };
  const rec = line.record as { type?: unknown; payload?: unknown } | null;
  if (rec?.type !== "event_msg" || !rec.payload || typeof rec.payload !== "object") return turns;
  const payload = rec.payload as Record<string, unknown>;
  if (payload["type"] === TASK_STARTED)
    return { ...turns, sawStarted: true, lastStartedTurn: payload["turn_id"] };
  if (payload["type"] === TASK_COMPLETE) return { ...turns, last: payload }; // LAST turn wins
  return turns;
}

/** Run `read` on the checked open of `rollout`; null when it cannot be opened or read. */
function withRollout<T>(home: string, rollout: string, read: (file: RolloutFile) => T): T | null {
  const file = openCodexRolloutPart(home, rollout);
  if (!file) return null;
  try {
    return read(file);
  } catch {
    return null; // unreadable rollout: no signal
  } finally {
    closeSync(file.fd);
  }
}

/**
 * Fold the complete lines of `[from, captured end)` into `state` (committed),
 * and the answer additionally over an unterminated last line, which a later
 * read sees again once codex finishes writing it.
 */
function fold<S>(
  file: RolloutFile,
  from: number,
  markers: readonly string[],
  state: S,
  reduce: (state: S, line: MarkedLine) => S,
): { consumed: number; committed: S; answer: S } {
  let committed = state;
  const { consumed, tail } = scanRolloutLines(file.fd, from, file.size, markers, (line) => {
    committed = reduce(committed, line);
  });
  return { consumed, committed, answer: tail ? reduce(committed, tail) : committed };
}
