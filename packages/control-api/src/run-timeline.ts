/**
 * Timeline projection over a run's canonical events.jsonl: severity
 * classification (typed event kinds + typed tool status — no prose parsing),
 * bounded output with an EXPLICIT truncation marker, and the shared
 * event-reading helpers the budget snapshot reuses.
 */
import { closeSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import {
  ControlTimelineEvent,
  ControlWebEvidence,
  FallbackReason,
  type RunTelemetry,
  type TaskContract,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { safeArtifactPath } from "./artifact-paths.js";

const TIMELINE_EVENTS_MAX = 500;

/**
 * Anti-OOM read cap for a run's events.jsonl (D15 "bounded tails for large
 * logs"): files at or under the cap are read whole (every projection stays
 * exact); a pathologically large log is read from its TAIL only — the last
 * partial line is dropped so JSON.parse never sees a torn record. 24 MiB holds
 * far more than any realistic run, so normal correctness is never affected.
 */
const EVENTS_READ_TAIL_BYTES = 24 * 1024 * 1024;

/**
 * Observability counter: how many times a run's events.jsonl was actually read
 * + parsed from disk. Detail requests thread ONE parsed snapshot through every
 * projection (D15 RunDetail perf), so this must stay at 1 per detail GET no
 * matter how many fields consume events — the single-parse test asserts it.
 */
let eventsParseCount = 0;
export function eventsParseCountForTests(): number {
  return eventsParseCount;
}
export function resetEventsParseCountForTests(): void {
  eventsParseCount = 0;
}

/** Structural dependency: anything carrying an optional runDir works. */
export interface RunDirCarrier {
  runDir?: string;
}

export function readRunEvents(rec: RunDirCarrier): Record<string, unknown>[] {
  if (!rec.runDir) return [];
  const path = safeArtifactPath(rec.runDir, "events.jsonl");
  if (!path) return [];
  let raw: string;
  let tailed = false;
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || st.isDirectory()) return [];
    if (st.size > EVENTS_READ_TAIL_BYTES) {
      // Bounded tail: read only the final window; drop the first (partial) line.
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.allocUnsafe(EVENTS_READ_TAIL_BYTES);
        const read = readSync(fd, buf, 0, EVENTS_READ_TAIL_BYTES, st.size - EVENTS_READ_TAIL_BYTES);
        raw = buf.toString("utf8", 0, read);
      } finally {
        closeSync(fd);
      }
      tailed = true;
    } else {
      raw = readFileSync(path, "utf8");
    }
  } catch {
    return [];
  }
  eventsParseCount++;
  const out: Record<string, unknown>[] = [];
  const lines = raw.split(/\r?\n/);
  // A tailed read almost certainly starts mid-record; drop that torn first line.
  for (let i = tailed ? 1 : 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && !Array.isArray(obj))
        out.push(obj as Record<string, unknown>);
    } catch {
      /* malformed line remains in events.jsonl; omit from projections */
    }
  }
  return out;
}

export function eventPayload(ev: Record<string, unknown>): Record<string, unknown> {
  return ev["payload"] && typeof ev["payload"] === "object" && !Array.isArray(ev["payload"])
    ? (ev["payload"] as Record<string, unknown>)
    : {};
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? redactSecrets(value) : null;
}

/** Project the orchestrator-owned telemetry artifact without reconstructing evidence. */
export function controlWebEvidence(
  telemetry: RunTelemetry | null,
  task: TaskContract | null,
): ControlWebEvidence {
  if (!telemetry) {
    return ControlWebEvidence.parse({
      required: task?.external_context.web_required ?? false,
      mode: task?.external_context.policy ?? "auto",
      effectiveMode:
        task?.external_context.effective_mode ?? task?.external_context.policy ?? "auto",
      available: false,
    });
  }
  return ControlWebEvidence.parse({
    required: telemetry.web.required,
    mode: telemetry.web.policy,
    effectiveMode: telemetry.web.effective_mode,
    attempted: telemetry.web.attempted,
    satisfied: telemetry.web.satisfied,
    status: telemetry.web.status,
    tool: telemetry.web.tool,
    target: telemetry.web.target,
    errorSummary: telemetry.web.error_summary,
    rawDetailRef: "final/telemetry.yaml",
    available: true,
  });
}

function prettyEventType(type: string): string {
  return type.replace(/\./g, " · ").replace(/_/g, " ");
}

const WARNING_EVENT_TYPES = new Set([
  "route.fallback.started",
  "route.fallback.auth_switched",
  "route.fallback.exhausted",
  "route.primary.diverged",
  "route.profile.headroom_exceeded",
  "route.profile.rotation_exhausted",
  "policy.web.upgraded",
  "run.blocked",
]);
const ERROR_EVENT_TYPES = new Set(["run.failed", "reviewer.failed", "reviewer.timed_out"]);

function timelineSeverity(
  type: string,
  payload: Record<string, unknown>,
  tool: Record<string, unknown>,
): "info" | "warning" | "error" {
  if (payload["error"] || tool["status"] === "error" || ERROR_EVENT_TYPES.has(type)) return "error";
  const reason = FallbackReason.safeParse(payload["reason"]);
  if (
    type === "route.fallback.auth_switched" &&
    reason.success &&
    reason.data === "readiness_preferred"
  )
    return "info";
  if (WARNING_EVENT_TYPES.has(type)) return "warning";
  return "info";
}

export function timelineEvents(
  rec: RunDirCarrier,
  events?: Record<string, unknown>[],
): ControlTimelineEvent[] {
  const out: ControlTimelineEvent[] = [];
  for (const ev of events ?? readRunEvents(rec)) {
    const payload = eventPayload(ev);
    const type = String(ev["type"] ?? "event");
    // Typed tool info travels on the normalized HarnessEvent `tool` field.
    const tool =
      payload["tool"] && typeof payload["tool"] === "object" && !Array.isArray(payload["tool"])
        ? (payload["tool"] as Record<string, unknown>)
        : {};
    const harnessId = stringOrNull(payload["harness_id"] ?? payload["harness"]);
    const attemptId = stringOrNull(payload["attempt_id"] ?? payload["attemptId"]);
    const title =
      stringOrNull(
        payload["title"] ??
          payload["message"] ??
          payload["summary"] ??
          payload["text"] ??
          payload["error"],
      ) ?? prettyEventType(type);
    const errorSummary = stringOrNull(tool["error_summary"] ?? payload["error"]);
    const detail =
      stringOrNull(payload["detail"] ?? payload["text"] ?? payload["error"]) ??
      stringOrNull(tool["content_summary"]) ??
      errorSummary;
    const toolName = stringOrNull(tool["name"]);
    const target = stringOrNull(tool["target"]);
    const severity = timelineSeverity(type, payload, tool);
    out.push(
      ControlTimelineEvent.parse({
        type,
        ts: typeof ev["ts"] === "string" ? ev["ts"] : undefined,
        harnessId,
        attemptId,
        title,
        detail,
        severity,
        toolName,
        target,
        errorSummary,
        rawRef: "events.jsonl",
      }),
    );
  }
  // Bounded projection with an EXPLICIT truncation marker — no silent truncation.
  if (out.length > TIMELINE_EVENTS_MAX) {
    const omitted = out.length - TIMELINE_EVENTS_MAX;
    const tail = out.slice(-TIMELINE_EVENTS_MAX);
    tail.unshift(
      ControlTimelineEvent.parse({
        type: "timeline.truncated",
        title: `${omitted} earlier event(s) omitted from this projection`,
        detail: "Full history remains in events.jsonl.",
        severity: "info",
        rawRef: "events.jsonl",
      }),
    );
    return tail;
  }
  return out;
}

/** The LAST plan.progress event's typed items (the live plan checklist), or
 * null when the run never emitted one. Last-wins by construction: plan tools
 * re-emit the whole list on every revision. On RACES the candidates' lists
 * interleave — prefer the WINNER's attempt (decision.yaml) so the Plan tab
 * shows the shipped candidate's checklist, not whichever emitted last. */
export function latestPlanProgress(
  rec: RunDirCarrier,
  winnerAttemptId?: string | null,
  eventsSnapshot?: Record<string, unknown>[],
): {
  items: Array<{ id: string; title: string; status: "pending" | "in_progress" | "completed" }>;
} | null {
  const events = eventsSnapshot ?? readRunEvents(rec);
  const pick = (matchWinner: boolean): Record<string, unknown> | null => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev?.["type"] !== "plan.progress") continue;
      if (matchWinner && eventPayload(ev)["attempt_id"] !== winnerAttemptId) continue;
      return ev;
    }
    return null;
  };
  const chosen = (winnerAttemptId ? pick(true) : null) ?? pick(false);
  {
    const ev = chosen;
    if (!ev) return null;
    const payload = eventPayload(ev);
    const rawItems = Array.isArray(payload["items"]) ? (payload["items"] as unknown[]) : [];
    const items = rawItems
      .map((raw) => {
        const r = raw as { id?: unknown; title?: unknown; status?: unknown };
        if (typeof r.id !== "string" || typeof r.title !== "string") return null;
        const status =
          r.status === "completed"
            ? "completed"
            : r.status === "in_progress"
              ? "in_progress"
              : "pending";
        return {
          id: r.id,
          title: r.title,
          status: status as "pending" | "in_progress" | "completed",
        };
      })
      .filter(
        (x): x is { id: string; title: string; status: "pending" | "in_progress" | "completed" } =>
          x !== null,
      );
    return { items };
  }
}
