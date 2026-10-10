import { controlApiAddress, type ControlApiAddress } from "./control-api-address.js";
export { controlApiAddress, type ControlApiAddress } from "./control-api-address.js";
import { laneOf, truncate } from "./live-format.js";
import { randomUUID } from "node:crypto";
import type { InteractionQuestion } from "@claudexor/schema";
import type { RunOutcomeFacts } from "@claudexor/schema";
import {
  InteractionQuestion as InteractionQuestionSchema,
  RunOutcomeFacts as RunOutcomeFactsSchema,
  continuityLabel,
  laneSwitchedFromPayload,
  outcomeExitCode,
  processExitCode,
  runOutcomeLabel,
} from "@claudexor/schema";
import { CliError, handshakeRefusalError } from "./cli-error.js";
import { consumeHandshakeIdentity, recordEngineSkew, type EngineIdentity } from "./engine-skew.js";
import { promptQuestionsOnTty } from "./interaction-prompt.js";
export { collectInteractionAnswers } from "./interaction-prompt.js";

const print = (s: string): void => {
  process.stdout.write(s + "\n");
};

/** One CLI process-status policy for direct runs and streamed terminals — a
 * thin re-export of the ONE projection owner (D8): the lifecycle IS the exit
 * code (succeeded => 0; a "Done · needs review" run also exits 0). */
export function processExitCodeForRunStatus(state: unknown): number {
  return processExitCode(typeof state === "string" ? state : "failed");
}

/** D-16 outcome-aware exit for a terminal run event: when the terminal carries
 * full outcome `facts`, the exit follows the OUTCOME (a needs_input/incomplete
 * work_state exits non-zero even on a succeeded lifecycle) via the ONE
 * projection owner; otherwise it falls back to the bare-lifecycle policy. */
export function exitCodeForTerminalPayload(payload: Record<string, unknown>): number {
  const parsed = RunOutcomeFactsSchema.safeParse(payload["facts"]);
  if (parsed.success) return outcomeExitCode(parsed.data as RunOutcomeFacts);
  return processExitCodeForRunStatus(payload["lifecycle"]);
}

/** One concise human progress line; null for heartbeats and raw deltas. */
export function formatRunEventLine(ev: Record<string, unknown>): string | null {
  const type = String(ev["type"] ?? "");
  const p = (ev["payload"] ?? {}) as Record<string, unknown>;
  const who = [p["attempt_id"], p["harness_id"]].filter(Boolean).join("/");
  switch (type) {
    case "run.created":
      return `run created (${String(p["mode"] ?? "?")})`;
    case "project.git.initialized":
      if (p["partial"] === true) {
        return `git repository setup stopped during ${String(p["failed_stage"] ?? "unknown")} at ${String(p["repo_root"] ?? "?")}; partial metadata may remain`;
      }
      return `initialized git repository at ${String(p["repo_root"] ?? "?")} (baseline commit)`;
    case "project.claude_bridge.created":
      return `bridged ${String(p["source"] ?? "AGENTS.md")} → ${String(p["path"] ?? "CLAUDE.md")} for Claude Code`;
    case "harness.started": {
      // INV-105 (QA-070): disclose any unsupported per-harness knob the route
      // could not honor as a visible warning suffix — a silent benign "started"
      // row would hide that a requested cost/safety bound had no effect.
      const ignored = Array.isArray(p["ignored_settings"])
        ? (p["ignored_settings"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      const warn = ignored.length > 0 ? ` — WARNING ignored: ${ignored.join("; ")}` : "";
      if (p["request_requirement"] && typeof p["request_requirement"] === "object") {
        const requirement = p["request_requirement"] as Record<string, unknown>;
        return `[${who}] started (web=${String(p["external_context_policy"] ?? "auto")}, browser=${requirement["effective"] === true ? "effective" : `unavailable:${String(requirement["reason"] ?? "unknown")}`})${warn}`;
      }
      return `[${who}] started (web=${String(p["external_context_policy"] ?? "auto")})${warn}`;
    }
    case "harness.event": {
      const sub = String(p["type"] ?? "");
      const detail = p["payload"] as Record<string, unknown> | undefined;
      if (sub === "message" && detail?.["buffered"] === true) return null;
      if (
        sub === "status" &&
        detail?.["auth_status_stale"] === true &&
        typeof p["title"] === "string"
      )
        return `[${who}] WARNING: ${truncate(p["title"], 300)}`;
      if (sub === "message" && typeof p["title"] === "string")
        return `[${who}] ${truncate(String(p["title"]), 160)}`;
      if (sub === "tool_call" && p["tool"] && typeof p["tool"] === "object") {
        const tool = p["tool"] as Record<string, unknown>;
        return `[${who}] tool ${String(tool["name"] ?? "?")}${tool["target"] ? ` — ${truncate(String(tool["target"]), 100)}` : ""}`;
      }
      if (sub === "interaction_requested") return `[${who}] waiting on your answer…`;
      return null;
    }
    case "session.continuity": {
      // INV-137 disclosure: one line when a lane switch/gap was hydrated with a
      // continuation packet; the projection owner suppresses native_resume/fresh.
      const line = continuityLabel({
        kind: (p["kind"] as "native_resume" | "packet" | "fresh") ?? "fresh",
        packetTurns: typeof p["packet_turns"] === "number" ? p["packet_turns"] : 0,
        summarized: p["summarized"] === true,
        laneSwitchedFrom: laneSwitchedFromPayload(p["lane_switched_from"]),
      });
      return line;
    }
    case "interaction.requested":
      return `[${who}] QUESTION pending (interaction ${String(p["interaction_id"] ?? "?")})`;
    case "interaction.answered":
      return `[${who}] answer delivered`;
    case "interaction.timeout":
      return p["reason"] === "cancelled"
        ? `[${who}] question wait cancelled`
        : `[${who}] no answer in time — continuing with assumptions`;
    case "harness.completed":
      return `[${who}] completed: ${String(p["status"] ?? "?")}${p["error"] ? ` — ${truncate(String(p["error"]), 160)}` : ""}`;
    case "gate.completed": {
      // Zero configured gates: `passed` is vacuously true (gatesPassed([]) ===
      // true), so "gates passed" would paint verification that never ran.
      const gateCount = Array.isArray(p["gates"]) ? (p["gates"] as unknown[]).length : null;
      const label =
        gateCount === 0
          ? "gates n/a (none configured)"
          : `gates ${p["passed"] ? "passed" : "failed"}`;
      return `[${String(p["attempt_id"] ?? "?")}] ${label}`;
    }
    case "review.started":
      return `review started (${String(p["reviewers"] ?? 0)} reviewer(s))`;
    case "review.skipped":
      return p["reason"] === "no_reviewers"
        ? "review skipped (no reviewers configured)"
        : "review skipped (no file changes)";
    case "reviewer.completed":
      return `reviewer completed (${String(p["harness_id"] ?? "?")})`;
    case "synthesis.started":
      return p["synthesize"] ? "synthesis started" : null;
    case "arbitration.completed":
      return `arbitration: winner=${String(p["winner"] ?? "none")} lifecycle=${String(
        p["lifecycle"] ?? "?",
      )}${p["decisive_axis"] ? ` decisive=${String(p["decisive_axis"])}` : ""}`;
    case "plan.brief.materialized": {
      // INV-081 provenance (QA-046): the frozen plan's source run + SHA-256 the
      // engine re-hashed before any harness started — a compact receipt so an
      // Implement follow proves which exact plan bytes ran.
      const sha = typeof p["sha256"] === "string" ? p["sha256"] : "";
      const shortSha = sha ? sha.slice(0, 12) : "unknown";
      return `plan materialized from ${String(p["plan_run_id"] ?? "?")} · sha256 ${shortSha} → ${String(p["path"] ?? "context/PLAN.md")}`;
    }
    case "output.ready":
      return `output ready: ${String(p["path"] ?? "?")}${p["state"] ? ` (${String(p["state"])})` : ""}`;
    case "budget.observation":
      return typeof p["usd"] === "number" ? `spend +$${(p["usd"] as number).toFixed(4)}` : null;
    case "run.completed":
      return `run completed: ${String(p["lifecycle"] ?? "succeeded")}`;
    case "run.failed": {
      const facts = RunOutcomeFactsSchema.safeParse(p["facts"]);
      if (facts.success) return `run ended: ${runOutcomeLabel(facts.data)}`;
      return `run failed: ${truncate(String(p["error"] ?? p["status"] ?? "failed"), 200)}`;
    }
    case "run.blocked":
      return `run blocked: ${truncate(String(p["error"] ?? "needs human decision"), 200)}`;
    case "run.continuation":
      return `[${String(p["from_attempt"] ?? "?")}] continuing in a fresh session (${String(
        p["cause"] ?? "context exhausted",
      )}, continuation ${String(p["continuation_count"] ?? "?")})`;
    case "workspace.retained":
      return `[${String(p["attempt_id"] ?? "?")}] stopped work kept for continueFrom`;
    case "run.continuation.denied":
      return `[${String(p["from_attempt"] ?? "?")}] continuation refused — budget lease denied (${String(
        p["reason"] ?? "budget",
      )})`;
    case "delegation.belt.unavailable":
      return `[${who}] delegation belt unavailable (${String(p["server_name"] ?? "?")}: ${String(
        p["reason"] ?? "unknown",
      )})`;
    case "delegation.belt.degraded":
      return p["effective"] === true
        ? `[${who}] one Delegate lane was unavailable; another effective Delegate lane remains (${String(p["reason"] ?? "unavailable")})`
        : `[${who}] WARNING: continued without Delegate (${String(p["reason"] ?? "unavailable")})`;
    case "route.pool.degraded": {
      const dropped = Array.isArray(p["dropped_lanes"])
        ? (p["dropped_lanes"] as Array<Record<string, unknown>>)
            .map((d) => String(d["harness_id"] ?? "?"))
            .join(", ")
        : "";
      return `route pool degraded: ${String(p["effective_n"] ?? "?")}/${String(
        p["requested_n"] ?? "?",
      )} lanes${dropped ? ` (dropped ${dropped})` : ""}`;
    }
    default:
      return null;
  }
}

/**
 * Stateful live formatter: `formatRunEventLine` plus the typed-final dedup.
 *
 * Codex narrates its answer mid-run (agent_message) and then repeats the SAME
 * text as its typed final message, so a stateless printer prints the answer
 * twice. The app's transcript reducer keys the same dedup on `final`
 * (TranscriptModels) but drops EVERY final — it renders the answer in its own
 * bubble. The CLI has no such bubble: the live stream IS the answer, so a final
 * is suppressed only when it is already on screen. A final that adds new
 * text (claude/cursor, whose result never repeats narration) still prints.
 *
 * The dedup keys on the RENDERED line, not the raw text: the printer's
 * contract is "never print a byte-identical answer line twice", and the
 * 160-char title truncation means distinct texts can render identically
 * (sol review of 00448bd8, major). The line is also bounded, so per-lane
 * state never holds a full message body (ibid., minor).
 *
 * Only the TYPED final flag dedups; a rendered match between two narration
 * messages is the harness genuinely saying the same thing twice, and stays.
 *
 * Text mode only — `--json`/NDJSON stay verbatim machine surfaces.
 */
export function createRunEventLineFormatter(): (ev: Record<string, unknown>) => string | null {
  const lastMessageTitleByLane = new Map<string, string>();
  return (ev) => {
    const line = formatRunEventLine(ev);
    if (line === null || String(ev["type"] ?? "") !== "harness.event") return line;
    const p = (ev["payload"] ?? {}) as Record<string, unknown>;
    if (String(p["type"] ?? "") !== "message" || typeof p["title"] !== "string") return line;
    // The per-lane value is ONLY the truncated rendered title — the lane key
    // already carries the `[who]` prefix, and storing the whole line would
    // retain an unbounded id a second time (confirm review, minor).
    const rendered = truncate(p["title"], 160);
    const lane = laneOf(p);
    if (p["final"] === true && lastMessageTitleByLane.get(lane) === rendered) return null;
    lastMessageTitleByLane.set(lane, rendered);
    return line;
  };
}

// SSOT: the negotiated major lives in the schema; the re-export keeps the
// existing CLI/MCP/ACP import path stable.
import { CONTROL_PROTOCOL_MAJOR } from "@claudexor/schema";
export { CONTROL_PROTOCOL_MAJOR };

/** One control-plane transport boundary for CLI, MCP and ACP projections. */
export function controlApiFetch(
  addr: ControlApiAddress,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const externalPath =
    path === "/healthz"
      ? path
      : path.startsWith("/v2/")
        ? path
        : `/v2${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${addr.token}`);
  if (externalPath !== "/healthz")
    headers.set("X-Claudexor-Protocol-Major", String(CONTROL_PROTOCOL_MAJOR));
  if (
    (init.method ?? "GET").toUpperCase() === "POST" &&
    (externalPath === "/v2/runs" ||
      externalPath === "/v2/uploads" ||
      externalPath === "/v2/projects" ||
      externalPath === "/v2/setup/jobs" ||
      externalPath === "/v2/threads" ||
      /^\/v2\/recovery\/partitions\/[^/]+\/quarantine$/.test(externalPath) ||
      /^\/v2\/runs\/[^/]+\/(?:retry|decision|apply)$/.test(externalPath) ||
      /^\/v2\/threads\/[^/]+\/apply$/.test(externalPath) ||
      /^\/v2\/threads\/[^/]+\/turns(?:\/[^/]+\/retry)?$/.test(externalPath) ||
      /^\/v2\/uploads\/[^/]+\/finalize$/.test(externalPath)) &&
    !headers.has("Idempotency-Key")
  ) {
    headers.set("Idempotency-Key", randomUUID());
  }
  return fetch(`${addr.baseUrl}${externalPath}`, { ...init, headers });
}

export async function handshakeControlApi(
  addr: ControlApiAddress,
  client = "claudexor-cli",
): Promise<EngineIdentity> {
  const response = await controlApiFetch(addr, "/v2/handshake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocolMajor: CONTROL_PROTOCOL_MAJOR, client }),
  });
  if (!response.ok) {
    // A refusing daemon IS running — never flatten this to "not reachable"
    // (issue #93). handshakeRefusalError keeps the server's typed problem
    // intact; only an ACTUAL protocol mismatch gets the stop remedy + human
    // stderr advisory (R1 C-C1, R2). Clear any earlier skew record FIRST: it
    // belonged to a daemon this handshake can no longer see and must not
    // annotate this refusal as stale evidence.
    recordEngineSkew(null);
    throw handshakeRefusalError(response.status, await response.json().catch(() => null));
  }
  // The handshake reports the daemon's build identity precisely so a stale
  // daemon is visible HERE instead of guessed later (QA-033a). The canonical
  // envelope parse, echo hygiene, and the module-scoped skew record (consumed
  // by controlProblemError as typed failure evidence) live in engine-skew.ts.
  // A same-major skew stays ADVISORY — the protocol major gate above is the
  // only hard fence — and is disclosed once per handshake with the remedy.
  const identity = consumeHandshakeIdentity(await response.json().catch(() => null));
  if (identity.skewAdvisory) process.stderr.write(identity.skewAdvisory);
  return identity.engine;
}

/**
 * `claudexor follow <run_id>`: live SSE tail of a daemon-backed run with full
 * replay (persisted seq), bounded reconnects via Last-Event-ID, and
 * interactive TTY answering of harness questions. Exit honesty: a
 * stream that ends WITHOUT a terminal event is a LOSS (exit 1, "stream
 * lost"), never a silent success — success requires an observed terminal or
 * an `end` frame the server sent after one.
 */
export async function followRun(runId: string, json: boolean): Promise<number> {
  let addr: ControlApiAddress;
  try {
    addr = controlApiAddress();
    await handshakeControlApi(addr);
  } catch (err) {
    // A typed CliError (the 426 refusal, a corrupt pointer) carries code/
    // retryable/requiredActions — rethrow to the top-level projector so
    // `follow --json` gets the canonical envelope (R1 C-C2). Only untyped
    // transport errors keep the bounded message-only fallback.
    if (err instanceof CliError) throw err;
    process.stderr.write(`claudexor follow: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  let exitCode = 0;
  let sawTerminal = false;
  let lastSeq = 0;
  const maxReconnects = 5;
  const promptControllers = new Map<string, AbortController>();
  let promptTail = Promise.resolve();
  const stopPrompts = () => {
    for (const controller of promptControllers.values()) controller.abort();
  };
  const finish = async (code: number): Promise<number> => {
    stopPrompts();
    await promptTail;
    return code;
  };
  const queueInteractionPrompt = (ev: Record<string, unknown>) => {
    const interactionId = eventInteractionId(ev);
    if (!interactionId || promptControllers.has(interactionId)) return;
    const controller = new AbortController();
    promptControllers.set(interactionId, controller);
    const runPrompt = async () => {
      try {
        if (!controller.signal.aborted) {
          await answerInteractionFromTty(addr, runId, ev, controller.signal);
        }
      } catch {
        // Prompt delivery is a best-effort TTY projection. The run stream and
        // its terminal remain authoritative; transport errors are surfaced by
        // the ordinary interaction/readback paths without breaking follow.
      } finally {
        if (promptControllers.get(interactionId) === controller) {
          promptControllers.delete(interactionId);
        }
      }
    };
    promptTail = promptTail.then(runPrompt, runPrompt);
  };
  // One formatter for the whole follow, reconnects included: a resumed stream
  // replays from Last-Event-ID, and the dedup state has to span that seam.
  const formatLine = createRunEventLineFormatter();

  const handleFrame = async (name: string, data: string): Promise<"continue" | "end"> => {
    if (name === "end") return "end";
    if (!data) return "continue";
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return "continue";
    }
    if (typeof ev["seq"] === "number" && Number.isFinite(ev["seq"])) lastSeq = ev["seq"] as number;
    if (json) {
      print(JSON.stringify(ev));
    } else {
      const line = formatLine(ev);
      if (line) print(line);
    }
    const type = String(ev["type"] ?? "");
    if (type === "interaction.answered" || type === "interaction.timeout") {
      const interactionId = eventInteractionId(ev);
      if (interactionId) {
        promptControllers.get(interactionId)?.abort({ kind: "interaction_resolved", event: type });
      }
    }
    if (type === "run.completed" || type === "run.failed" || type === "run.blocked") {
      sawTerminal = true;
      stopPrompts();
      // The lifecycle IS the exit code (D8): run.blocked fires on a SUCCEEDED
      // lifecycle (needs review) and therefore exits 0 — "Done · needs review".
      const payload = (ev["payload"] ?? {}) as Record<string, unknown>;
      exitCode = exitCodeForTerminalPayload(payload);
    }
    if (type === "interaction.requested" && !json) {
      // Keep consuming SSE while the terminal owns stdin. A disabled question
      // has no deadline, so awaiting it inline would prevent this same loop
      // from observing the cancel/terminal event that must close the prompt.
      queueInteractionPrompt(ev);
    }
    return "continue";
  };

  for (let attempt = 0; attempt <= maxReconnects; attempt += 1) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 3_000)));
      if (!json)
        process.stderr.write(
          `claudexor follow: reconnecting (${attempt}/${maxReconnects}, resume from seq ${lastSeq})...\n`,
        );
    }
    let res: Response;
    try {
      res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}/events`, {
        headers: {
          Authorization: `Bearer ${addr.token}`,
          Accept: "text/event-stream",
          ...(lastSeq > 0 ? { "Last-Event-ID": String(lastSeq) } : {}),
        },
      });
    } catch {
      continue; // transport refusal (daemon restarting) — retry with backoff
    }
    if (res.status === 404) {
      process.stderr.write(`claudexor follow: no such run '${runId}'\n`);
      return finish(1);
    }
    if (!res.ok || !res.body) {
      continue;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    let eventName = "message";
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (line === "") {
            const outcome = await handleFrame(eventName, dataLines.join("\n"));
            dataLines = [];
            eventName = "message";
            if (outcome === "end") {
              if (sawTerminal) return finish(exitCode);
              // Server-side end WITHOUT a terminal event (interrupted run,
              // never-materialized job): the run did not finish cleanly.
              process.stderr.write("claudexor follow: stream ended without a terminal event\n");
              return finish(1);
            }
            continue;
          }
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
      }
    } catch {
      /* mid-stream transport drop — fall through to reconnect */
    }
    if (sawTerminal) return finish(exitCode);
  }
  process.stderr.write(
    `claudexor follow: stream lost after ${maxReconnects} reconnects (no terminal event observed)\n`,
  );
  return finish(1);
}

function eventInteractionId(ev: Record<string, unknown>): string | null {
  const payload = ev["payload"];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const interactionId = (payload as Record<string, unknown>)["interaction_id"];
  return typeof interactionId === "string" && interactionId.length > 0 ? interactionId : null;
}

async function answerInteractionFromTty(
  addr: ControlApiAddress,
  runId: string,
  ev: Record<string, unknown>,
  signal: AbortSignal,
): Promise<void> {
  const p = (ev["payload"] ?? {}) as Record<string, unknown>;
  const interactionId = typeof p["interaction_id"] === "string" ? p["interaction_id"] : null;
  if (!interactionId) return;
  if (signal.aborted) return;
  const questions = Array.isArray(p["questions"])
    ? p["questions"]
        .map((q) => InteractionQuestionSchema.safeParse(q))
        .filter((r): r is { success: true; data: InteractionQuestion } => r.success)
        .map((r) => r.data)
    : [];
  if (questions.length === 0) return;
  // Replay safety: the events stream replays from seq 1, so historical
  // interaction.requested events arrive for questions long answered or timed
  // out. Only prompt when the daemon still reports this interaction pending
  // (the registry is populated before the event reaches any subscriber, so a
  // LIVE question is always visible here). On a detail fetch failure, fall
  // through — the expired-deadline guard in promptQuestionsOnTty still holds.
  try {
    const detailRes = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${addr.token}` },
      signal,
    });
    if (detailRes.ok) {
      const detail = (await detailRes.json()) as {
        summary?: { state?: string };
        pendingInteractions?: { interactionId?: string }[];
      };
      const state = detail.summary?.state ?? "";
      const active = state === "running" || state === "queued";
      const stillPending = (detail.pendingInteractions ?? []).some(
        (pi) => pi.interactionId === interactionId,
      );
      if (!active || !stillPending) return;
    }
  } catch {
    if (signal.aborted) return;
    /* fall through to the deadline guard */
  }
  const answers = await promptQuestionsOnTty(
    interactionId,
    questions,
    typeof p["timeout_at"] === "string" ? p["timeout_at"] : undefined,
    signal,
  );
  if (!answers || signal.aborted) return;
  const body = {
    answers: answers.answers.map((a) => ({
      questionId: a.question_id,
      selectedLabels: a.selected_labels,
      freeText: a.free_text,
    })),
  };
  const res = await controlApiFetch(
    addr,
    `/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(interactionId)}/answer`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${addr.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    print(`(answer not delivered: ${res.status}${detail ? ` ${truncate(detail, 120)}` : ""})`);
  }
}
