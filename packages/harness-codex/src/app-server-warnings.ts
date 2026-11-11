import type { HarnessEvent } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import type { JsonObject } from "./app-server-protocol.js";

type CodexNativeWarningMethod = "configWarning" | "warning";

export const isCodexNativeWarningMethod = (method: unknown): method is CodexNativeWarningMethod =>
  method === "configWarning" || method === "warning";

/** Masks a native params object through its JSON text; the masked text itself when it no longer parses. */
function maskNativeParams(params: JsonObject): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(params);
  } catch {
    return "[unserializable diagnostic]";
  }
  const masked = redactSecrets(serialized);
  if (masked === serialized) return params;
  try {
    return JSON.parse(masked) as unknown;
  } catch {
    return masked;
  }
}

/**
 * Codex's non-fatal native warnings (the app-server "Warning events"):
 * `configWarning` {summary, details?, path?, range?} reports a recoverable
 * configuration or initialization problem, among them the Linux bubblewrap
 * prerequisite check sent right after `initialize` (so it waits in the run's
 * queue until `thread/start` names the root); `warning` {threadId?, message}
 * reports a runtime one. Each frame becomes one nonterminal `status` event:
 * the vendor's own text (`summary: details`, as Codex's TUI composes it) and
 * the native method and params, verbatim except for diagnostic masking: Codex
 * may quote configuration, so the text and params pass `redactSecrets` here at
 * the producer, and a secret-free warning stays byte-identical. Evidence only:
 * never an error, a verdict, a host diagnosis or a deduplicated message. A
 * frame without its required text stays unrecognized (`null`): the run loop
 * counts it as dropped when it reads it. Frames still queued when the run
 * stops are taken through this same mapping by `CodexSubagentThreads.takeWarnings`.
 */
export function codexNativeWarningEvents(
  method: CodexNativeWarningMethod,
  params: JsonObject,
  sessionId: string,
): HarnessEvent[] | null {
  const text = params[method === "configWarning" ? "summary" : "message"];
  if (typeof text !== "string") return null;
  const details = method === "configWarning" ? params["details"] : null;
  return [
    {
      type: "status",
      session_id: sessionId,
      ts: nowIso(),
      text: redactSecrets(typeof details === "string" && details ? `${text}: ${details}` : text),
      payload: {
        code: "codex_native_warning",
        native_method: method,
        native_params: maskNativeParams(params),
      },
    },
  ];
}
