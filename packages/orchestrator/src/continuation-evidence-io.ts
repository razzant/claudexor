/**
 * Evidence-index collector — the I/O half of `continuation-evidence.ts`.
 *
 * Reads the predecessor's durable record (the run's `events.jsonl` and, for
 * read-only attempts, the attempt's own `events.jsonl`) into the pure
 * builder's input: tool calls paired by try/session and typed use id (legacy
 * results without an id close the oldest open call) per attempt, admitted
 * steering messages once per run with their delivery status
 * (`message.delivered` by an applicable attempt = confirmed; an `accepted` row
 * with no closing = uncertain; refused = not sent), and the absolute artifact
 * paths. Never throws: unreadable evidence yields an empty index section,
 * never a failed continuation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { retainedOutput } from "@claudexor/event-log";
import type { ResumableCause, RunEvent } from "@claudexor/schema";
import {
  wholeCharPrefix,
  type EvidenceIndexInput,
  type EvidenceIndexSources,
  type EvidenceSteering,
  type EvidenceToolCall,
  type UncoveredWork,
} from "./continuation-evidence.js";

type Row = Record<string, unknown>;

function readRows(path: string): Row[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return parsed && typeof parsed === "object" ? [parsed as Row] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function asRow(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}

/** The attempt's harness events: attempt-local log first, else the run log filtered by attempt. */
function attemptHarnessEvents(runDir: string, attemptId: string): Row[] {
  const own = readRows(join(runDir, "attempts", attemptId, "events.jsonl"));
  if (own.length > 0) return own;
  return readRows(join(runDir, "events.jsonl")).flatMap((row) => {
    const payload = asRow(row["payload"]);
    return row["type"] === "harness.event" && payload && payload["attempt_id"] === attemptId
      ? [payload]
      : [];
  });
}

interface ToolEntry {
  call: EvidenceToolCall;
  session: unknown;
  id: string | null;
  /** The complete edited path when the frame records one (`payload.path`), else
   * the display target: identity never depends on the display bound. */
  key: string | null;
  closedByResult: boolean;
}

const NON_OK = new Set(["error", "cancelled", "denied"]);

/** Close a call by the frame that ends it: a non-ok status is its outcome, and
 * its command facts (#450) travel with it at every closing point. */
function close(entry: ToolEntry, tool: Row | null): void {
  entry.call.resolved = true;
  delete entry.call.unconfirmed;
  const status = tool?.["status"];
  if (typeof status === "string" && NON_OK.has(status))
    entry.call.outcome = status as NonNullable<EvidenceToolCall["outcome"]>;
  if (tool?.["command_outcome"] !== undefined) entry.call.commandOutcome = tool["command_outcome"];
}

/**
 * Pair typed use ids within a native try; ambiguous ids remain unresolved.
 * An edit's lifecycle is proved by its frame, never by a repeat: a tool
 * result closes its call; a result that names its tool and an id no earlier
 * call carries stands as its own completed row with its target and outcome
 * (an ambiguous, repeated or nameless result adds nothing); a typed
 * `completed` edit closes the open start of the same id and path, or stands
 * as its own completed row (a missing id is no reason to drop it); a typed
 * `started` never closes anything; repeats add no row. A null target never
 * closes a named start. The untyped companion of a call its result already
 * closed adds nothing; any other untyped edit frame proves neither completion
 * nor its absence ("completion not confirmed").
 */
export function toolCallIndex(events: readonly Row[]): EvidenceToolCall[] {
  const entries: ToolEntry[] = [];
  const open = (call: EvidenceToolCall, session: unknown, id: string | null, key: string | null) =>
    entries.push({ call, session, id, key, closedByResult: false });
  for (const ev of events) {
    const tool = asRow(ev["tool"]);
    const id = typeof tool?.["use_id"] === "string" ? tool["use_id"] : null;
    const target = typeof tool?.["target"] === "string" ? tool["target"] : null;
    const path = asRow(ev["payload"])?.["path"];
    const key = typeof path === "string" && path ? path : target;
    const session = ev["session_id"];
    const name =
      typeof tool?.["name"] === "string" && tool["name"].trim()
        ? tool["name"]
        : typeof ev["text"] === "string" && ev["text"].trim()
          ? wholeCharPrefix(ev["text"].split("\n")[0]!, 80)
          : "tool";
    if (ev["type"] === "tool_call") {
      open({ name, target, resolved: false }, session, id, target);
    } else if (ev["type"] === "tool_result") {
      const candidates = entries.filter(
        (entry) => !entry.call.resolved && entry.session === session,
      );
      const matched =
        id === null ? candidates.slice(0, 1) : candidates.filter((entry) => entry.id === id);
      // A result that names its tool but no earlier call is its own completed row;
      // a nameless one names nothing to record.
      const named = typeof tool?.["name"] === "string" && tool["name"].trim() !== "";
      const known = entries.some((entry) => entry.id === id && entry.session === session);
      if (matched.length === 1 || (id !== null && named && !known)) {
        if (matched.length === 0) open({ name, target, resolved: false }, session, id, target);
        const entry = matched[0] ?? entries.at(-1)!;
        close(entry, tool);
        entry.closedByResult = true;
      }
    } else if (ev["type"] === "file_change" && tool) {
      const sameId =
        id === null ? [] : entries.filter((entry) => entry.id === id && entry.session === session);
      const samePath = sameId.filter((entry) => entry.key === key);
      if (tool["phase"] === "completed") {
        const started = samePath.find((entry) => !entry.call.resolved);
        if (started) close(started, tool);
        else if (samePath.length === 0) {
          open({ name, target, resolved: false }, session, id, key);
          close(entries.at(-1)!, tool);
        }
      } else if (tool["phase"] === "started") {
        if (samePath.length === 0) open({ name, target, resolved: false }, session, id, key);
      } else if ((target === null ? sameId : samePath).length === 0) {
        open({ name, target, resolved: false, unconfirmed: true }, session, id, key);
      }
    }
  }
  return entries.map((entry) => entry.call);
}

/**
 * Admitted steering messages of a run, once each, with delivery status, in
 * admission order. A message is delivered when any applicable attempt (all of
 * the run's when unspecified) recorded its delivery; rows of other attempts
 * are not this line's input.
 */
export function steeringFromRunLog(
  runDir: string,
  applicable?: ReadonlySet<string>,
): EvidenceSteering[] {
  const byId = new Map<string, EvidenceSteering & { refused: boolean }>();
  for (const row of readRows(join(runDir, "events.jsonl"))) {
    const payload = asRow(row["payload"]);
    const rowAttempt = payload?.["attempt_id"] ?? row["attempt_id"];
    if (applicable !== undefined && typeof rowAttempt === "string" && !applicable.has(rowAttempt))
      continue;
    const id = typeof payload?.["message_id"] === "string" ? payload["message_id"] : null;
    const text = typeof payload?.["text"] === "string" ? payload["text"] : null;
    if (!id || text === null) continue;
    const entry = byId.get(id) ?? { text, delivery: "uncertain" as const, refused: false };
    if (row["type"] === "message.accepted") byId.set(id, entry);
    else if (row["type"] === "message.delivered") byId.set(id, { ...entry, delivery: "confirmed" });
    else if (row["type"] === "message.refused") byId.set(id, { ...entry, refused: true });
  }
  return [...byId.values()]
    .filter((entry) => !entry.refused)
    .map(({ text, delivery }) => ({ text, delivery }));
}

/**
 * What a native resume of `held` adds as labelled evidence: the recorded work
 * of the `uncovered` attempts on its line (their output and tool calls) and
 * the steering delivered to them but to no attempt the session holds. Steering
 * never delivered stays the run-level uncertain input of the notice.
 */
export function uncoveredWork(
  runDir: string,
  uncovered: readonly string[],
  held: readonly string[],
): UncoveredWork {
  const eventsLog = join(runDir, "events.jsonl");
  const rows = readRows(eventsLog);
  const delivered = new Map<string, { text: string; uncovered: boolean; held: boolean }>();
  for (const row of rows) {
    const payload = asRow(row["payload"]);
    const id = payload?.["message_id"];
    const text = payload?.["text"];
    const attempt = String(payload?.["attempt_id"] ?? row["attempt_id"]);
    if (row["type"] !== "message.delivered" || typeof id !== "string" || typeof text !== "string")
      continue;
    const entry = delivered.get(id) ?? { text, uncovered: false, held: false };
    entry.uncovered ||= uncovered.includes(attempt);
    entry.held ||= held.includes(attempt);
    delivered.set(id, entry);
  }
  const output = rows.filter(
    (row) =>
      row["type"] === "harness.event" &&
      uncovered.includes(String(asRow(row["payload"])?.["attempt_id"])),
  ) as unknown as RunEvent[];
  return {
    steering: [...delivered.values()]
      .filter((entry) => entry.uncovered && !entry.held)
      .map((entry) => entry.text),
    retainedOutput: output.length ? (retainedOutput(output)?.trim() ?? "") : "",
    toolCalls: uncovered.flatMap((attemptId) =>
      toolCallIndex(attemptHarnessEvents(runDir, attemptId)).map((call) => ({
        ...call,
        attempt: attemptId,
      })),
    ),
    eventsLog: existsSync(eventsLog) ? eventsLog : null,
  };
}

/** The serial attempts a source carries, in execution order. */
function attemptsOf(source: Pick<EvidenceIndexSources, "attemptId" | "attemptIds">): string[] {
  return source.attemptIds?.length ? [...source.attemptIds] : [source.attemptId];
}

/** Steering is a run fact: each run directory's messages appear once, delivered by
 * any attempt the sources carry from it (explicitly supplied steering stays as is). */
function steeringOnce(sources: readonly EvidenceIndexSources[]): EvidenceSteering[] {
  const order: (EvidenceSteering[] | string)[] = [];
  const runs = new Map<string, Set<string>>();
  for (const source of sources) {
    if (source.steering.length > 0) order.push(source.steering);
    else if (!runs.has(source.runDir)) order.push(source.runDir);
    runs.set(source.runDir, new Set([...(runs.get(source.runDir) ?? []), ...attemptsOf(source)]));
  }
  return order.flatMap((entry) =>
    typeof entry === "string" ? steeringFromRunLog(entry, runs.get(entry)) : entry,
  );
}

type SourceInput = Omit<EvidenceIndexInput, "steering">;

function sourceInput(
  sources: EvidenceIndexSources,
  extras: { cause: ResumableCause; retainedOutput: string; diffStat: string | null },
): SourceInput {
  const attemptDir = join(sources.runDir, "attempts", sources.attemptId);
  const eventsLog = join(sources.runDir, "events.jsonl");
  const attempts = attemptsOf(sources);
  const attemptPatch = join(attemptDir, "patch.diff");
  const patch = existsSync(attemptPatch)
    ? attemptPatch
    : join(sources.runDir, "final", "patch.diff");
  const retained = join(sources.runDir, "final", "retained-output.md");
  return {
    cause: extras.cause,
    workOrder: sources.workOrder,
    workOrderPath: sources.workOrderPath ?? null,
    ...(sources.workOrderInPrompt ? { workOrderInPrompt: true } : {}),
    retainedOutput: extras.retainedOutput,
    // Each attempt keeps its own pairing boundary and, beside others, its name.
    toolCalls: attempts.flatMap((attemptId) =>
      toolCallIndex(attemptHarnessEvents(sources.runDir, attemptId)).map((call) =>
        attempts.length > 1 ? { ...call, attempt: attemptId } : call,
      ),
    ),
    diffStat: extras.diffStat,
    artifacts: {
      eventsLog: existsSync(eventsLog) ? eventsLog : null,
      attemptDir: existsSync(attemptDir) ? attemptDir : null,
      patch: existsSync(patch) ? patch : null,
      // A finished source's own complete projection (a successor's predecessor).
      retainedOutput: existsSync(retained) ? retained : null,
    },
  };
}

/**
 * Keep the complete retained output the packet section bounds beside the
 * index (`file`), and name it in the index's surviving references. Nothing to
 * keep, or a write that fails, leaves the input as it is: never a failed
 * continuation, never a reference to a file that was not written.
 */
export function keepCompleteRetainedOutput(
  input: EvidenceIndexInput,
  file: string | undefined,
): EvidenceIndexInput {
  if (!file || !input.retainedOutput.trim()) return input;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, input.retainedOutput, { mode: 0o600 });
  } catch {
    return input;
  }
  return { ...input, completeRetainedOutput: file };
}

/** Resolve the pure builder's input from the run dir plus the loop's in-memory facts. */
export function collectEvidenceIndexInput(
  sources: EvidenceIndexSources,
  extras: {
    cause: ResumableCause;
    retainedOutput: string;
    diffStat: string | null;
    completed?: boolean;
  },
): EvidenceIndexInput {
  const current = {
    ...sourceInput(sources, extras),
    ...(extras.completed ? { completed: true } : {}),
    steering: steeringOnce([...(sources.predecessors ?? []), sources]),
  };
  const preceding = (sources.predecessors ?? []).map((source) =>
    sourceInput(source, {
      cause: extras.cause,
      retainedOutput: source.retainedOutput,
      diffStat: source.diffStat,
    }),
  );
  if (preceding.length === 0) return current;
  const all = [...preceding, current];
  return {
    ...current,
    retainedOutput: all
      .map((input) => input.retainedOutput)
      .filter(Boolean)
      .join("\n\n"),
    toolCalls: all.flatMap((input) => input.toolCalls),
    diffStat:
      [...new Set(all.flatMap((input) => input.diffStat?.split("\n") ?? []))].join("\n") || null,
    predecessorArtifacts: preceding.map((input) => input.artifacts),
  };
}

/** `git diff`-style file list from a unified diff: one line per changed path. */
export function diffStatFromPatch(diff: string): string | null {
  if (!diff.trim()) return null;
  const files = diff
    .split("\n")
    .filter((line) => line.startsWith("diff --git "))
    .map((line) => line.slice("diff --git ".length).split(" b/").pop() ?? line)
    .filter((path) => path.trim());
  return files.length ? files.map((path) => `- ${path}`).join("\n") : null;
}

/** The chain's complete work order (`context/work-order.md`), when this run has one. */
export function workOrderFile(runDir: string): string | null {
  const path = join(runDir, "context", "work-order.md");
  return existsSync(path) ? path : null;
}
