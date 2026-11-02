/**
 * Continuation-packet builder (INV-137, V9b) — PURE.
 *
 * A lane is a (thread, harness, profile) triple. When a turn runs on a lane
 * whose checkpoint lags the thread head — a lane switch (A→B→A) or a gap — the
 * new lane has no native memory of the missed turns, so the engine hydrates it
 * with a bounded MECHANICAL continuation packet: recent delta turns verbatim,
 * older ones collapsed to one-line entries when the budget is exceeded, plus
 * the active plan pointer and a workspace anchor.
 *
 * When the budget forces a collapse, a cached LLM summary (V9c) can REPLACE the
 * collapsed one-liners with real prose: the caller runs `planContinuation` to
 * learn which older turns would collapse (and their boundary turn id — the
 * summary cache key), resolves a summary for that prefix (cache hit or a bounded
 * inline summarization pass), and passes it back as `cachedSummary`. A collapsed
 * turn without a final answer keeps its one-liner beside the summary, whatever
 * the prose says (#405). The mechanical one-liner collapse is ALWAYS the
 * fallback, so a missing/failed summary never loses information. Either way
 * `summarized` stays true (the verbatim prefix was condensed); the packet text
 * itself discloses which form was used.
 *
 * This module takes fully-resolved structured data (the daemon supplies thread
 * facts; the orchestrator reads prior outputs + git anchor) and returns the
 * disclosure + the packet body. No I/O, no clock — trivially unit-testable.
 */

/** Per delta turn: verbatim budget (user prompt + primary output). */
export const PER_TURN_BUDGET_BYTES = 8 * 1024;
/** Whole-packet verbatim budget; older turns collapse past this. */
export const TOTAL_BUDGET_BYTES = 24 * 1024;
/**
 * One-line collapsed entry keeps up to this many UTF-16 code units of each
 * field; a cut ends on a whole character and adds "…" outside the allowance.
 */
export const COLLAPSE_PREFIX_CHARS = 200;

export interface ContinuityTurn {
  /** Turn id (checkpoint math keys off this). */
  id: string;
  /** The user's message for the turn, exactly as sent (INV-146). */
  prompt: string;
  /** The turn's primary output text (final/answer.md), "" when none, and ""
   * for a turn the lane's native session already holds: no packet renders it. */
  outputText: string;
  /** #405: no final answer was recorded, and `outputText` is the turn's retained
   * output, never an answer. `ended`: its run did not succeed; `unknown`: its
   * outcome could not be read, so nothing is claimed about how it ended. */
  noFinalAnswer?: "ended" | "unknown";
  /** The file `outputText` is read exactly from, or rendered from (its run's
   * event log). Where the packet cuts the output, it names this file. */
  outputSource?: string;
}

const NO_FINAL_ANSWER = {
  ended: { lead: "The turn ended without a final answer.", note: "ended without a final answer" },
  unknown: {
    lead: "No final answer is recorded for this turn, and its outcome could not be read.",
    note: "no final answer recorded; outcome could not be read",
  },
} as const;

/** How a turn without a final answer is described (`lead` sentence, short `note`);
 * null for an answered turn. */
export function noFinalAnswerText(
  turn: Pick<ContinuityTurn, "noFinalAnswer">,
): { lead: string; note: string } | null {
  return turn.noFinalAnswer ? NO_FINAL_ANSWER[turn.noFinalAnswer] : null;
}

export interface ContinuityLane {
  harness: string;
  profileId: string | null;
}

export interface ContinuityPlanPointer {
  /** Absolute path to the approved plan.md the packet points at. */
  path: string;
  /** derivePlanReadiness state: ready | needs_answers | unverified. */
  readiness: string;
  planRunId: string;
}

export interface ContinuityAnchor {
  headSha: string | null;
  dirtyCount: number;
}

export interface ContinuityRequest {
  /** This turn's resolved lane. */
  lane: ContinuityLane;
  /** All prior turns of the thread, in order (EXCLUDES the current turn). */
  priorTurns: ContinuityTurn[];
  /** The last turn id this lane has seen, or null when the lane never ran. */
  laneCheckpointTurnId: string | null;
  /** True when the lane can resume its OWN native vendor session in place. */
  nativeResumeAvailable: boolean;
  /** The lane that produced the prior head turn, when known (for laneSwitchedFrom). */
  priorHeadLane: ContinuityLane | null;
  /** Active plan pointer to append, when any. */
  activePlan: ContinuityPlanPointer | null;
  /** Workspace anchor to append, when available. */
  anchor: ContinuityAnchor | null;
  /**
   * A resolved LLM summary of the collapsed older prefix (V9c). Applied ONLY
   * when the packet actually collapses AND `upToTurnId` equals the plan's
   * `summaryUpToTurnId` (the collapse boundary) — otherwise ignored and the
   * mechanical one-liner collapse renders. Absent = mechanical fallback.
   */
  cachedSummary?: ResolvedSummary | null;
}

/** A summary of the collapsed older prefix, keyed by its boundary turn id. */
export interface ResolvedSummary {
  /** The id of the LAST turn the summary covers (the collapse boundary). */
  upToTurnId: string;
  /** The summary prose to render in place of the collapsed one-liners (an
   * unfinished turn's line stays beside it). */
  text: string;
}

/**
 * The mechanical collapse plan for a request — WHICH delta turns are carried and
 * which would collapse under the budget — computed WITHOUT rendering so the
 * caller can resolve a summary for the collapsed prefix before building the
 * packet. Pure and cheap (the same math `buildContinuation` uses internally).
 */
export interface ContinuityPlan {
  kind: "native_resume" | "packet" | "fresh";
  /** All delta turns this lane must be told about (after its checkpoint). */
  delta: ContinuityTurn[];
  /** The oldest delta turns that collapse under the budget (empty = none). */
  collapsedPrefix: ContinuityTurn[];
  /** Boundary turn id — the summary cache key; null when nothing collapses. */
  summaryUpToTurnId: string | null;
}

export interface ContinuityDisclosureResult {
  kind: "native_resume" | "packet" | "fresh";
  packetTurns: number;
  summarized: boolean;
  laneSwitchedFrom: ContinuityLane | null;
}

export interface ContinuityResult {
  disclosure: ContinuityDisclosureResult;
  /** The THREAD.md packet body, or null when no packet is delivered. */
  packetMarkdown: string | null;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Truncate to at most `maxBytes` UTF-8 bytes on a safe char boundary; a cut ends with `mark`. */
function boundBytes(text: string, maxBytes: number, mark = "\n…[truncated]"): string {
  if (bytes(text) <= maxBytes) return text;
  // Buffer slice can split a multi-byte scalar; back off a few bytes until valid.
  const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
  for (let trim = 0; trim <= 3 && trim <= buf.length; trim += 1) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        trim === 0 ? buf : buf.subarray(0, buf.length - trim),
      );
      return `${decoded}${mark}`;
    } catch {
      /* prefix ended inside a scalar; back off */
    }
  }
  return `${buf.toString("utf8")}${mark}`;
}

/** The longest end of `text` within `maxBytes` UTF-8 bytes, starting on a whole character. */
export function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  let start = Math.max(0, buf.length - maxBytes);
  // A continuation byte (10xxxxxx) lies inside a character: start after it.
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

/**
 * A verbatim entry's output within `maxBytes` (#405). An answer keeps its
 * start. A turn without a final answer keeps its end, where its newest
 * recorded output is (its retained file opens with a fixed preamble). The cut
 * mark sits outside the allowance and names the file holding the whole output.
 */
function boundOutput(turn: ContinuityTurn, maxBytes: number): string {
  const text = turn.outputText.trim();
  const whole = turn.outputSource
    ? `; the whole output is ${bytes(text)} bytes, complete in ${turn.outputSource}`
    : "";
  if (!turn.noFinalAnswer) return boundBytes(text, maxBytes, `\n…[truncated${whole}]`);
  if (bytes(text) <= maxBytes) return text;
  return `[earlier output truncated${whole}]\n…${tailBytes(text, maxBytes)}`;
}

/** One line of at most COLLAPSE_PREFIX_CHARS UTF-16 units: the start of `text`,
 * or its end when `keepEnd`. A cut is marked "…" outside the allowance and
 * names `source`, the file holding the whole text, when given. */
function oneLine(text: string, keepEnd = false, source?: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= COLLAPSE_PREFIX_CHARS) return flat;
  const whole = source ? ` (whole output: ${source})` : "";
  // A cut between a surrogate pair's halves would leave a lone surrogate, which
  // becomes U+FFFD in THREAD.md; drop that character whole instead (#577).
  if (keepEnd) {
    const tail = flat.slice(-COLLAPSE_PREFIX_CHARS);
    return `…${/^\p{Surrogate}/u.test(tail) ? tail.slice(1) : tail}${whole}`;
  }
  const head = flat.slice(0, COLLAPSE_PREFIX_CHARS);
  return `${/\p{Surrogate}$/u.test(head) ? head.slice(0, -1) : head}…${whole}`;
}

/** Delta turns for this lane: everything AFTER the checkpoint (all prior when
 * the lane never ran / has no reachable native session to trust). */
export function deltaTurns<T extends { id: string }>(
  req: Pick<ContinuityRequest, "laneCheckpointTurnId" | "nativeResumeAvailable"> & {
    priorTurns: T[];
  },
): T[] {
  // Without a reachable native session the lane starts blank — carry the whole
  // prior conversation regardless of any stale checkpoint.
  if (!req.nativeResumeAvailable) return req.priorTurns;
  if (!req.laneCheckpointTurnId) return req.priorTurns;
  const idx = req.priorTurns.findIndex((t) => t.id === req.laneCheckpointTurnId);
  // Checkpoint not among the retained prior turns → carry everything (safe).
  return idx < 0 ? req.priorTurns : req.priorTurns.slice(idx + 1);
}

function verbatimEntry(turn: ContinuityTurn, index: number): string {
  const prompt = boundBytes(turn.prompt.trim(), PER_TURN_BUDGET_BYTES / 2);
  const output = turn.outputText.trim()
    ? boundOutput(turn, PER_TURN_BUDGET_BYTES / 2)
    : "_(no recorded output)_";
  const missing = noFinalAnswerText(turn);
  const said = missing
    ? `**${missing.lead} The assistant's recorded output (not a completion verdict):**`
    : "**The assistant answered:**";
  return `### Turn ${index + 1}\n\n**User asked:**\n\n${prompt}\n\n${said}\n\n${output}\n`;
}

function collapsedEntry(turn: ContinuityTurn, index: number): string {
  const prompt = oneLine(turn.prompt) || "(empty)";
  const missing = noFinalAnswerText(turn);
  // An unfinished turn's line keeps the end of its output and names the file (#405).
  const output = turn.outputText.trim()
    ? oneLine(turn.outputText, missing !== null, missing ? turn.outputSource : undefined)
    : "(no recorded output)";
  const speaker = missing ? `assistant (${missing.note})` : "assistant";
  return `- Turn ${index + 1} — user: ${prompt} · ${speaker}: ${output}`;
}

/**
 * How many of the OLDEST delta turns collapse to one-liners: grow the collapsed
 * prefix from the oldest until the verbatim total fits the budget. Pure — the
 * single owner of the collapse decision (both `planContinuation` and
 * `renderPacket` read it, so the boundary the caller summarizes is exactly the
 * boundary the packet renders).
 */
function collapseCount(delta: ContinuityTurn[]): number {
  const verbatim = delta.map((t, i) => verbatimEntry(t, i));
  let collapsed = 0;
  const totalBytes = (): number =>
    delta.reduce((sum, t, i) => sum + bytes(i < collapsed ? collapsedEntry(t, i) : verbatim[i]), 0);
  while (collapsed < delta.length && totalBytes() > TOTAL_BUDGET_BYTES) {
    collapsed += 1;
  }
  return collapsed;
}

/**
 * Assemble the packet body from delta turns, collapsing the OLDEST turns while
 * the verbatim total exceeds the budget. When a `summary` covering the collapse
 * boundary is supplied it REPLACES the one-liners with real prose, except those
 * of turns without a final answer: generated or cached prose may omit their
 * output and never names its file, so their lines follow the summary (#405).
 * Otherwise the mechanical one-liner collapse renders (always works). Returns
 * the body and whether any collapse happened (`summarized`).
 */
function renderPacket(
  delta: ContinuityTurn[],
  activePlan: ContinuityPlanPointer | null,
  anchor: ContinuityAnchor | null,
  summary: ResolvedSummary | null,
): { body: string; summarized: boolean } {
  const collapsedCount = collapseCount(delta);
  const summarized = collapsedCount > 0;
  const boundaryTurnId = collapsedCount > 0 ? delta[collapsedCount - 1].id : null;
  // A summary applies only when it covers the EXACT collapse boundary — a stale
  // summary (boundary moved since it was cached) falls back to one-liners.
  const usableSummary =
    summary && boundaryTurnId && summary.upToTurnId === boundaryTurnId ? summary : null;

  const parts: string[] = [
    "# Thread continuation packet",
    "",
    "You are continuing an existing Claudexor conversation on a new lane. The earlier turns below did not run on this lane's native session — read them before answering the new prompt at the end of your instructions.",
    "",
  ];
  if (summarized) {
    parts.push(
      usableSummary
        ? "> The oldest turns are condensed into the cached conversation summary below; the most recent turns are verbatim."
        : "> The older turns are condensed to one-line entries below (a cached conversation summary was unavailable for this turn). The most recent turns are verbatim.",
      "",
    );
  }
  if (usableSummary) {
    parts.push("## Earlier conversation (summary)", "", usableSummary.text.trim(), "");
    const unfinished: string[] = [];
    for (let i = 0; i < collapsedCount; i += 1) {
      if (delta[i].noFinalAnswer) unfinished.push(collapsedEntry(delta[i], i));
    }
    if (unfinished.length > 0) {
      parts.push(
        "Recorded output of the summarized turns that have no final answer (not a completion verdict):",
        "",
        ...unfinished,
        "",
      );
    }
    parts.push("## Recent turns", "");
    for (let i = collapsedCount; i < delta.length; i += 1) {
      parts.push(verbatimEntry(delta[i], i));
    }
  } else {
    parts.push("## Earlier turns", "");
    const collapsedLines: string[] = [];
    for (let i = 0; i < delta.length; i += 1) {
      if (i < collapsedCount) {
        collapsedLines.push(collapsedEntry(delta[i], i));
      } else {
        if (collapsedLines.length > 0) {
          parts.push(...collapsedLines, "");
          collapsedLines.length = 0;
        }
        parts.push(verbatimEntry(delta[i], i));
      }
    }
    if (collapsedLines.length > 0) parts.push(...collapsedLines, "");
  }

  if (activePlan) {
    parts.push(
      "## Active plan",
      "",
      `The thread's approved plan is at: ${activePlan.path} (readiness: ${activePlan.readiness}). Re-read it as needed.`,
      "",
    );
  }
  if (anchor) {
    parts.push(
      "## Workspace anchor",
      "",
      `HEAD ${anchor.headSha ?? "(unborn)"} · ${anchor.dirtyCount} file(s) with uncommitted changes at the start of this turn.`,
      "",
    );
  }
  return {
    body:
      parts
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd() + "\n",
    summarized,
  };
}

/**
 * Compute the mechanical collapse plan for a lane WITHOUT rendering: the caller
 * uses `summaryUpToTurnId` to look up / generate a summary for the collapsed
 * prefix, then feeds it back via `req.cachedSummary` to `buildContinuation`.
 * Pure; matches `buildContinuation`'s own collapse math exactly.
 */
export function planContinuation(req: ContinuityRequest): ContinuityPlan {
  if (req.priorTurns.length === 0) {
    return { kind: "fresh", delta: [], collapsedPrefix: [], summaryUpToTurnId: null };
  }
  const delta = deltaTurns(req);
  if (delta.length === 0) {
    return { kind: "native_resume", delta: [], collapsedPrefix: [], summaryUpToTurnId: null };
  }
  const collapsed = collapseCount(delta);
  const collapsedPrefix = delta.slice(0, collapsed);
  return {
    kind: "packet",
    delta,
    collapsedPrefix,
    summaryUpToTurnId: collapsed > 0 ? delta[collapsed - 1].id : null,
  };
}

/** Compute the continuity disclosure + packet body for a resolved lane. */
export function buildContinuation(req: ContinuityRequest): ContinuityResult {
  const laneSwitchedFrom =
    req.priorHeadLane &&
    (req.priorHeadLane.harness !== req.lane.harness ||
      (req.priorHeadLane.profileId ?? null) !== (req.lane.profileId ?? null))
      ? req.priorHeadLane
      : null;

  // Nothing before this turn → the thread's first move on any lane.
  if (req.priorTurns.length === 0) {
    return {
      disclosure: { kind: "fresh", packetTurns: 0, summarized: false, laneSwitchedFrom: null },
      packetMarkdown: null,
    };
  }

  const delta = deltaTurns(req);
  if (delta.length === 0) {
    // The lane's own native session already holds everything up to the head.
    return {
      disclosure: {
        kind: "native_resume",
        packetTurns: 0,
        summarized: false,
        laneSwitchedFrom: null,
      },
      packetMarkdown: null,
    };
  }

  const { body, summarized } = renderPacket(
    delta,
    req.activePlan,
    req.anchor,
    req.cachedSummary ?? null,
  );
  return {
    disclosure: {
      kind: "packet",
      packetTurns: delta.length,
      summarized,
      laneSwitchedFrom,
    },
    packetMarkdown: body,
  };
}
