import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { daemonDir, readToken } from "@claudexor/daemon";
import type { InteractionAnswerSet, InteractionQuestion } from "@claudexor/schema";
import { InteractionQuestion as InteractionQuestionSchema } from "@claudexor/schema";

/* eslint-disable @typescript-eslint/no-explicit-any */

const print = (s: string): void => {
  process.stdout.write(s + "\n");
};

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
      return `[${who}] started (web=${String(p["external_context_policy"] ?? "auto")})`;
    case "harness.event": {
      const sub = String(p["type"] ?? "");
      if (sub === "message" && typeof p["title"] === "string") return `[${who}] ${truncate(String(p["title"]), 160)}`;
      if (sub === "tool_call" && p["tool"] && typeof p["tool"] === "object") {
        const tool = p["tool"] as Record<string, unknown>;
        return `[${who}] tool ${String(tool["name"] ?? "?")}${tool["target"] ? ` — ${truncate(String(tool["target"]), 100)}` : ""}`;
      }
      if (sub === "interaction_requested") return `[${who}] waiting on your answer…`;
      return null;
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
    case "reviewer.completed":
      return `reviewer completed (${String(p["harness_id"] ?? "?")})`;
    case "synthesis.started":
      return p["synthesize"] ? "synthesis started" : null;
    case "arbitration.completed":
      return `arbitration: winner=${String(p["winner"] ?? "none")} status=${String(p["status"] ?? "?")}`;
    case "output.ready":
      return `output ready: ${String(p["path"] ?? "?")}${p["state"] ? ` (${String(p["state"])})` : ""}`;
    case "budget.observation":
      return typeof p["usd"] === "number" ? `spend +$${(p["usd"] as number).toFixed(4)}` : null;
    case "run.completed":
      return `run completed: ${String(p["status"] ?? "success")}`;
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
  const signal = deadlineMs && deadlineMs > 0 ? AbortSignal.timeout(deadlineMs) : undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answers: InteractionAnswerSet["answers"] = [];
    for (const q of questions) {
      print("");
      print(`? ${q.header ? `[${q.header}] ` : ""}${q.question}`);
      q.options.forEach((o, idx) => print(`   ${idx + 1}) ${o.label}${o.description ? ` — ${o.description}` : ""}`));
      const hint = q.options.length > 0
        ? q.multi_select
          ? "numbers separated by commas, or free text"
          : "a number, or free text"
        : "free text";
      const raw = (signal
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

interface ControlApiAddress {
  baseUrl: string;
  token: string;
}

function controlApiAddress(): ControlApiAddress {
  const info = JSON.parse(readFileSync(join(daemonDir(), "control-api.json"), "utf8")) as { host?: string; port?: number };
  const token = readToken();
  if (!info.host || !info.port || !token) throw new Error("daemon control API is not available (run: claudexor daemon start)");
  return { baseUrl: `http://${info.host}:${info.port}`, token };
}

/**
 * `claudexor follow <run_id>`: live SSE tail of a daemon-backed run with full
 * replay (persisted seq) and interactive TTY answering of harness questions.
 */
export async function followRun(runId: string, json: boolean): Promise<number> {
  let addr: ControlApiAddress;
  try {
    addr = controlApiAddress();
  } catch (err) {
    process.stderr.write(`claudexor follow: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const headers = { Authorization: `Bearer ${addr.token}` };
  const res = await fetch(`${addr.baseUrl}/runs/${encodeURIComponent(runId)}/events`, {
    headers: { ...headers, Accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) {
    process.stderr.write(`claudexor follow: events stream failed (${res.status})\n`);
    return 1;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let eventName = "message";
  let exitCode = 0;

  const handleFrame = async (name: string, data: string): Promise<"continue" | "end"> => {
    if (name === "end") return "end";
    if (!data) return "continue";
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return "continue";
    }
    if (json) {
      print(JSON.stringify(ev));
    } else {
      const line = formatRunEventLine(ev);
      if (line) print(line);
    }
    const type = String(ev["type"] ?? "");
    if (type === "run.failed" || type === "run.blocked") exitCode = 1;
    if (type === "interaction.requested" && !json) {
      await answerInteractionFromTty(addr, runId, ev);
    }
    return "continue";
  };

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
        if (outcome === "end") return exitCode;
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
  }
  return exitCode;
}

async function answerInteractionFromTty(addr: ControlApiAddress, runId: string, ev: Record<string, unknown>): Promise<void> {
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
  const answers = await promptQuestionsOnTty(interactionId, questions, typeof p["timeout_at"] === "string" ? p["timeout_at"] : undefined);
  if (!answers) return;
  const body = {
    answers: answers.answers.map((a) => ({ questionId: a.question_id, selectedLabels: a.selected_labels, freeText: a.free_text })),
  };
  const res = await fetch(`${addr.baseUrl}/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(interactionId)}/answer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${addr.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    print(`(answer not delivered: ${res.status}${detail ? ` ${truncate(detail, 120)}` : ""})`);
  }
}
