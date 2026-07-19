/**
 * Bounded inline continuation summariser (INV-137, V9c).
 *
 * When a continuation packet must collapse an older prefix and no fresh cached
 * summary covers it, the orchestrator runs ONE bounded read-only summarisation
 * pass over the collapsed turns — ask-mode intent, the thread's primary harness,
 * the lane's own credential route + scoped home, a hard timeout, and a single
 * turn. Success replaces the mechanical one-liner collapse with real prose;
 * failure/timeout/unavailable falls back to the one-liners (which always work).
 *
 * This is deliberately NOT a run: it opens no run dir, records no native
 * session, and emits no run events — it must never masquerade as a user turn.
 * It reuses the same credential-profile + scoped-home + env-inheritance route a
 * real read-only thread turn uses, so it authenticates identically and consumes
 * quota honestly (the disclosure's `summarized` flag already tells the user the
 * prefix was condensed).
 */
import {
  HarnessRunSpec,
  type CredentialProfile,
  type HarnessEvent as HarnessEventType,
} from "@claudexor/schema";
import { AnswerAssembly, type HarnessAdapter } from "@claudexor/core";
import type { ContinuityTurn } from "./continuity.js";

/** Default wall-clock ceiling for one inline summary pass. */
export const SUMMARY_TIMEOUT_MS = 60_000;
/** Bytes of each collapsed turn fed to the summariser (prompt + output halves). */
const PER_TURN_INPUT_BYTES = 4 * 1024;
/** Bytes retained from the summary answer. */
const MAX_SUMMARY_BYTES = 8 * 1024;

export interface SummaryRunParams {
  adapter: HarnessAdapter;
  /** The collapsed older-prefix turns to summarise (oldest → newest). */
  turns: ContinuityTurn[];
  /** Read-only working directory (the thread's execution root). */
  cwd: string;
  /** Scoped lane-home env so the pass authenticates on the lane's own account. */
  env: Record<string, string>;
  /** Resolved credential profile for the lane (null = engine default ladder). */
  credentialProfile: CredentialProfile | null;
  authPreference: "subscription" | "api_key" | "auto";
  envInheritance: "mirror_native" | "clean";
  /** Upper bound on the pass; the caller's run signal aborts it too. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

function boundBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return `${buf.subarray(0, maxBytes).toString("utf8")}…`;
}

/** Render the collapsed prefix as the summariser's input transcript. */
function transcript(turns: ContinuityTurn[]): string {
  return turns
    .map((t, i) => {
      const prompt = boundBytes(t.prompt.trim(), PER_TURN_INPUT_BYTES / 2);
      const output = t.outputText.trim()
        ? boundBytes(t.outputText.trim(), PER_TURN_INPUT_BYTES / 2)
        : "(no recorded answer)";
      return `Turn ${i + 1}\nUser: ${prompt}\nAssistant: ${output}`;
    })
    .join("\n\n");
}

const SUMMARY_INSTRUCTION =
  "You are handing this conversation off to a successor agent that has NOT seen it. " +
  "Summarize the earlier turns below for that agent: the decisions reached, the current " +
  "state of the work, and the open items still to do. Be concise and factual — no preamble, " +
  "no questions, no tool calls. Output only the summary.";

/**
 * Run one bounded summary pass. Returns the summary text, or null on any
 * failure/timeout/empty answer (the caller then keeps the mechanical collapse).
 * Never throws.
 */
export async function summarizeThreadPrefix(params: SummaryRunParams): Promise<string | null> {
  if (params.turns.length === 0) return null;
  const timeoutMs = params.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const abort = new AbortController();
  const onOuterAbort = (): void => abort.abort();
  if (params.signal) {
    if (params.signal.aborted) return null;
    params.signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  timer.unref?.();
  const answer = new AnswerAssembly();
  try {
    const spec = HarnessRunSpec.parse({
      session_id: `continuity-summary-${Date.now()}`,
      intent: "explain",
      prompt: `${SUMMARY_INSTRUCTION}\n\n---\n\n${transcript(params.turns)}`,
      cwd: params.cwd,
      access: "readonly",
      external_context_policy: "off",
      tool_permission_policy: { web: "off", allow: [], deny: [] },
      model_hint: null,
      effort_hint: null,
      max_turns: 1,
      auth_preference: params.authPreference === "auto" ? undefined : params.authPreference,
      credential_profile: params.credentialProfile,
      // A fresh pass: never resume — this is a side computation, not a lane turn.
      resume_session_id: null,
      env_inheritance: params.envInheritance,
      evidence_policy: "stream_only",
      env: params.env,
      attachments: [],
      browser: null,
      stream_deltas: false,
      extra: { abortSignal: abort.signal },
    });
    for await (const raw of params.adapter.run(spec)) {
      if (abort.signal.aborted) return null;
      const event = raw as HarnessEventType;
      if (event.type === "error") return null;
      if (event.type === "message") answer.observe(event);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", onOuterAbort);
  }
  if (abort.signal.aborted) return null;
  const text = answer.text().trim();
  return text ? boundBytes(text, MAX_SUMMARY_BYTES) : null;
}
