/**
 * Codex rollout-transcript readers: the CLI's own session record
 * (`$CODEX_HOME/sessions/<Y>/<M>/<D>/rollout-*-<threadId>.jsonl`) is the
 * native machine-readable source for the observed model (route proof),
 * the rate-window quota, and the vendor's own typed failure for a turn it
 * ended with an error. One owner for rollout facts.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, VendorFailureEvidence } from "@claudexor/schema";

/**
 * Route proof: recover the model codex ACTUALLY ran from its own session
 * rollout file (`$CODEX_HOME/sessions/<Y>/<M>/<D>/rollout-*-<threadId>.jsonl`,
 * `turn_context.payload.model`). This is the codex CLI's OWN record — a real
 * observation, not an argv echo — so it honestly upgrades the cross-family route
 * proof to `verified` (CLAUDEXOR_BIBLE §5) for a CLI whose `--json` stream never
 * carries the model. Best-effort: any missing/ambiguous/unreadable state returns
 * null and the proof stays unobserved (safe degradation, never throws).
 */
export function codexTranscriptModel(
  codexHome: string | null | undefined,
  threadId: string | undefined,
): string | null {
  if (!threadId) return null;
  // An explicit scoped home is REQUIRED (v3.0.3 S9): falling back to the
  // operator's real ~/.codex would read native state Claudexor does not own.
  // Callers always resolve the run's CODEX_HOME; absent means unobserved.
  const home = codexHome && codexHome.trim() ? codexHome : null;
  if (!home) return null;
  const rollout = findCodexRollout(join(home, "sessions"), threadId);
  if (!rollout) return null;
  let observed: string | null = null;
  try {
    for (const line of readFileSync(rollout, "utf8").split("\n")) {
      if (!line.includes("turn_context")) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const model = (obj as { payload?: { model?: unknown } })?.payload?.model;
      // Keep the LAST turn_context, not the first: a RESUMED codex session
      // (`exec resume <id>`) accumulates multiple turns in one rollout, so the
      // observed model must reflect the most recent turn — the one the usage
      // event this is attached to actually ran — not a stale earlier turn.
      if (typeof model === "string" && model.trim()) observed = model;
    }
  } catch {
    /* unreadable rollout: stay unobserved */
  }
  return observed;
}

type CodexQuota = NonNullable<HarnessEvent["quota"]>;

/**
 * Where a run's rate-limit reading left off in its rollout: the located file,
 * its identity, the byte offset just past the last complete line consumed,
 * and the newest record among those lines. One cursor per run.
 */
export interface CodexRateLimitCursor {
  home: string | null;
  threadId: string | null;
  rollout: string | null;
  ino: number | null;
  offset: number;
  latest: CodexQuota | null;
}

export function codexRateLimitCursor(): CodexRateLimitCursor {
  return { home: null, threadId: null, rollout: null, ino: null, offset: 0, latest: null };
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
  cursor: CodexRateLimitCursor = codexRateLimitCursor(),
): CodexQuota | null {
  if (!threadId) return null;
  // An explicit scoped home is REQUIRED (v3.0.3 S9): falling back to the
  // operator's real ~/.codex would read native state Claudexor does not own.
  // Callers always resolve the run's CODEX_HOME; absent means unobserved.
  const home = codexHome && codexHome.trim() ? codexHome : null;
  if (!home) return null;
  if (cursor.home !== home || cursor.threadId !== threadId) {
    Object.assign(cursor, codexRateLimitCursor(), { home, threadId });
  }
  cursor.rollout ??= findCodexRollout(join(home, "sessions"), threadId);
  if (!cursor.rollout) return null;
  try {
    const fd = openSync(cursor.rollout, "r");
    try {
      const { ino, size } = fstatSync(fd);
      if (ino !== cursor.ino || size < cursor.offset) {
        Object.assign(cursor, { ino, offset: 0, latest: null });
      }
      const appended = Buffer.alloc(size - cursor.offset);
      const length = readSync(fd, appended, 0, appended.length, cursor.offset);
      const complete = length > 0 ? appended.lastIndexOf(0x0a, length - 1) + 1 : 0;
      for (const line of appended.toString("utf8", 0, complete).split("\n")) {
        cursor.latest = rateLimitsFromLine(line) ?? cursor.latest;
      }
      cursor.offset += complete;
      return rateLimitsFromLine(appended.toString("utf8", complete, length)) ?? cursor.latest;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null; /* unreadable rollout: no quota signal */
  }
}

function rateLimitsFromLine(line: string): CodexQuota | null {
  if (!line.includes("rate_limits")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const rl = (obj as { payload?: { rate_limits?: Record<string, unknown> } })?.payload?.rate_limits;
  if (!rl || typeof rl !== "object") return null;
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
        id,
        label: id,
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
 * `includes` below is a cheap prefilter, not a match).
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
  const rollout = findCodexRollout(join(home, "sessions"), threadId);
  if (!rollout) return null;
  let sawStarted = false;
  let lastStartedTurn: unknown = null;
  let last: Record<string, unknown> | null = null;
  try {
    for (const line of readFileSync(rollout, "utf8").split("\n")) {
      if (!line.includes("task_complete") && !line.includes("task_started")) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        // A torn record may be the newest turn marker: what came before it no
        // longer provably speaks for the last turn.
        last = null;
        continue;
      }
      const rec = obj as { type?: unknown; payload?: unknown } | null;
      if (rec?.type !== "event_msg" || !rec.payload || typeof rec.payload !== "object") continue;
      const payload = rec.payload as Record<string, unknown>;
      if (payload["type"] === "task_started") {
        sawStarted = true;
        lastStartedTurn = payload["turn_id"];
      } else if (payload["type"] === "task_complete") {
        last = payload; // LAST turn wins (resumed sessions)
      }
    }
  } catch {
    return null; // unreadable rollout: no vendor failure signal
  }
  if (!last) return null;
  if (sawStarted && (typeof lastStartedTurn !== "string" || last["turn_id"] !== lastStartedTurn))
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

/** Locate the rollout file whose name binds to this run's threadId (the id is unique per session). */
export function findCodexRollout(sessionsDir: string, threadId: string): string | null {
  if (!existsSync(sessionsDir)) return null;
  try {
    for (const y of listDirsDesc(sessionsDir)) {
      for (const m of listDirsDesc(join(sessionsDir, y))) {
        for (const d of listDirsDesc(join(sessionsDir, y, m))) {
          const dayDir = join(sessionsDir, y, m, d);
          const hit = readdirSync(dayDir).find((f) => f.includes(threadId) && f.endsWith(".jsonl"));
          if (hit) return join(dayDir, hit);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Subdirectory names sorted newest-first (date partitions), directories only. */
function listDirsDesc(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => {
        try {
          return statSync(join(dir, n)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  } catch {
    return [];
  }
}
