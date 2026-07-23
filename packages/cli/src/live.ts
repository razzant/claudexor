import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { daemonDir, readToken } from "@claudexor/daemon";
import type { InteractionAnswerSet, InteractionQuestion } from "@claudexor/schema";
import type { RunOutcomeFacts } from "@claudexor/schema";
import {
  InteractionQuestion as InteractionQuestionSchema,
  RunOutcomeFacts as RunOutcomeFactsSchema,
  continuityLabel,
  outcomeExitCode,
  processExitCode,
} from "@claudexor/schema";
import { CLAUDEXOR_VERSION } from "@claudexor/util";

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

/**
 * One concise line per run event for live terminal progress. Returns null for
 * noise (heartbeats, raw harness deltas we do not surface in a TTY).
 */
export function formatRunEventLine(ev: Record<string, unknown>): string | null {
  const type = String(ev["type"] ?? "");
  const p = (ev["payload"] ?? {}) as Record<string, unknown>;
  const who = [p["attempt_id"], p["harness_id"]].filter(Boolean).join("/");
  switch (type) {
    case "run.created":
      return `run created (${String(p["mode"] ?? "?")})`;
    case "project.git.initialized":
      return `initialized git repository at ${String(p["repo_root"] ?? "?")} (baseline commit)`;
    case "harness.started":
      if (p["request_requirement"] && typeof p["request_requirement"] === "object") {
        const requirement = p["request_requirement"] as Record<string, unknown>;
        return `[${who}] started (web=${String(p["external_context_policy"] ?? "auto")}, browser=${requirement["effective"] === true ? "effective" : `unavailable:${String(requirement["reason"] ?? "unknown")}`})`;
      }
      return `[${who}] started (web=${String(p["external_context_policy"] ?? "auto")})`;
    case "harness.event": {
      const sub = String(p["type"] ?? "");
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
        laneSwitchedFrom:
          p["lane_switched_from"] && typeof p["lane_switched_from"] === "object"
            ? {
                harness: String(
                  (p["lane_switched_from"] as Record<string, unknown>)["harness"] ?? "?",
                ),
              }
            : null,
      });
      return line;
    }
    case "interaction.requested":
      return `[${who}] QUESTION pending (interaction ${String(p["interaction_id"] ?? "?")})`;
    case "interaction.answered":
      return `[${who}] answer delivered`;
    case "interaction.timeout":
      return `[${who}] no answer in time — continuing with assumptions`;
    case "harness.completed":
      return `[${who}] completed: ${String(p["status"] ?? "?")}${p["error"] ? ` — ${truncate(String(p["error"]), 160)}` : ""}`;
    case "gate.completed":
      return `[${String(p["attempt_id"] ?? "?")}] gates ${p["passed"] ? "passed" : "failed"}`;
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
    case "output.ready":
      return `output ready: ${String(p["path"] ?? "?")}${p["state"] ? ` (${String(p["state"])})` : ""}`;
    case "budget.observation":
      return typeof p["usd"] === "number" ? `spend +$${(p["usd"] as number).toFixed(4)}` : null;
    case "run.completed":
      return `run completed: ${String(p["lifecycle"] ?? "succeeded")}`;
    case "run.failed":
      return `run failed: ${truncate(String(p["error"] ?? p["status"] ?? "failed"), 200)}`;
    case "run.blocked":
      return `run blocked: ${truncate(String(p["error"] ?? "needs human decision"), 200)}`;
    default:
      return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Lane key for per-attempt dedup state — the same pair the line renders,
 * bounded so a pathological id never bloats the map (confirm review, minor).
 */
function laneOf(p: Record<string, unknown>): string {
  return truncate([p["attempt_id"], p["harness_id"]].filter(Boolean).join("/"), 256);
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

/**
 * Prompt the questions on the controlling TTY. Returns null on a non-TTY
 * stdin or when the deadline passes (the engine then declines benignly).
 */
export async function promptQuestionsOnTty(
  interactionId: string,
  questions: InteractionQuestion[],
  timeoutAt?: string,
): Promise<InteractionAnswerSet | null> {
  if (!process.stdin.isTTY) {
    print("(question received, but stdin is not a TTY — the run continues with assumptions)");
    return null;
  }
  const deadlineMs = timeoutAt ? Date.parse(timeoutAt) - Date.now() : null;
  if (deadlineMs !== null && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) {
    // An already-expired deadline must decline immediately — prompting with
    // no signal would hang the TTY forever on a question the engine already
    // timed out (e.g. a historical event replayed by `follow`).
    print("(question already timed out — the run continues with assumptions)");
    return null;
  }
  const signal = deadlineMs !== null ? AbortSignal.timeout(deadlineMs) : undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answers: InteractionAnswerSet["answers"] = [];
    for (const q of questions) {
      print("");
      print(`? ${q.header ? `[${q.header}] ` : ""}${q.question}`);
      q.options.forEach((o, idx) =>
        print(`   ${idx + 1}) ${o.label}${o.description ? ` — ${o.description}` : ""}`),
      );
      const hint =
        q.options.length > 0
          ? q.multi_select
            ? "numbers separated by commas, or free text"
            : "a number, or free text"
          : "free text";
      const raw = (
        signal
          ? await rl.question(`   answer (${hint}): `, { signal })
          : await rl.question(`   answer (${hint}): `)
      ).trim();
      if (!raw) continue;
      const picks = raw
        .split(",")
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= q.options.length);
      if (picks.length > 0 && picks.length === raw.split(",").length) {
        answers.push({
          question_id: q.id,
          selected_labels: picks.map((n) => q.options[n - 1]?.label ?? "").filter(Boolean),
          free_text: null,
        });
      } else {
        answers.push({ question_id: q.id, selected_labels: [], free_text: raw });
      }
    }
    return answers.length > 0 ? { interaction_id: interactionId, answers } : null;
  } catch {
    print("(answer window closed — the run continues with assumptions)");
    return null;
  } finally {
    rl.close();
  }
}

export interface ControlApiAddress {
  baseUrl: string;
  token: string;
}

// SSOT: the negotiated major lives in the schema; the re-export keeps the
// existing CLI/MCP/ACP import path stable.
import { CONTROL_PROTOCOL_MAJOR } from "@claudexor/schema";
export { CONTROL_PROTOCOL_MAJOR };

export function controlApiAddress(): ControlApiAddress {
  const info = JSON.parse(readFileSync(join(daemonDir(), "control-api.json"), "utf8")) as {
    host?: string;
    port?: number;
  };
  const token = readToken();
  if (!info.host || !info.port || !token)
    throw new Error("daemon control API is not available (run: claudexor daemon start)");
  return { baseUrl: `http://${info.host}:${info.port}`, token };
}

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
): Promise<void> {
  const response = await controlApiFetch(addr, "/v2/handshake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocolMajor: CONTROL_PROTOCOL_MAJOR, client }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `control API handshake failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  // The handshake already reports the daemon's build identity precisely so a
  // stale daemon is visible HERE instead of guessed later — consume it. A
  // version skew is advisory (the protocol major gate above is the hard
  // fence): disclose with the remedy. A CLI process handshakes once, so no
  // dedup state is needed.
  try {
    const body = (await response.json()) as { engine?: { version?: string } };
    const raw = body.engine?.version;
    // Same echo hygiene as the plugin-skew check: never print an arbitrary
    // response-sourced string into the terminal.
    const daemonVersion = raw && /^[\w.+-]{1,32}$/.test(raw) ? raw : undefined;
    if (daemonVersion && daemonVersion !== CLAUDEXOR_VERSION) {
      process.stderr.write(
        `claudexor: daemon is engine ${daemonVersion} but this CLI is ${CLAUDEXOR_VERSION}; ` +
          `run \`claudexor daemon stop\` and rerun the command so a matching daemon starts\n`,
      );
    }
  } catch {
    // Identity is advisory; a body parse failure never fails the handshake.
  }
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
    process.stderr.write(`claudexor follow: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  let exitCode = 0;
  let sawTerminal = false;
  let lastSeq = 0;
  const maxReconnects = 5;
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
    if (type === "run.completed" || type === "run.failed" || type === "run.blocked") {
      sawTerminal = true;
      // The lifecycle IS the exit code (D8): run.blocked fires on a SUCCEEDED
      // lifecycle (needs review) and therefore exits 0 — "Done · needs review".
      const payload = (ev["payload"] ?? {}) as Record<string, unknown>;
      exitCode = exitCodeForTerminalPayload(payload);
    }
    if (type === "interaction.requested" && !json) {
      await answerInteractionFromTty(addr, runId, ev);
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
      return 1;
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
              if (sawTerminal) return exitCode;
              // Server-side end WITHOUT a terminal event (interrupted run,
              // never-materialized job): the run did not finish cleanly.
              process.stderr.write("claudexor follow: stream ended without a terminal event\n");
              return 1;
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
    if (sawTerminal) return exitCode;
  }
  process.stderr.write(
    `claudexor follow: stream lost after ${maxReconnects} reconnects (no terminal event observed)\n`,
  );
  return 1;
}

async function answerInteractionFromTty(
  addr: ControlApiAddress,
  runId: string,
  ev: Record<string, unknown>,
): Promise<void> {
  const p = (ev["payload"] ?? {}) as Record<string, unknown>;
  const interactionId = typeof p["interaction_id"] === "string" ? p["interaction_id"] : null;
  if (!interactionId) return;
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
    /* fall through to the deadline guard */
  }
  const answers = await promptQuestionsOnTty(
    interactionId,
    questions,
    typeof p["timeout_at"] === "string" ? p["timeout_at"] : undefined,
  );
  if (!answers) return;
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
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    print(`(answer not delivered: ${res.status}${detail ? ` ${truncate(detail, 120)}` : ""})`);
  }
}
