import type { HarnessEvent, VendorFailureEvidence } from "@claudexor/schema";
import { VendorFailureEvidence as VendorFailureSchema } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import { claudeTerminalContextEvent } from "./context-signals.js";
import type { ClaudeEventParser } from "./parse.js";

/** Native stdout result evidence, not a search through model prose. Older
 * CLIs retain the API sentence but omit api_error_code; that remains unknown
 * and keeps ordinary account failover. Context/turn-control keep their owners. */
export function withClaudeApiFailureParser(
  parse: ClaudeEventParser,
  binaryPath: string | null,
): ClaudeEventParser {
  let installedVersion: string | null = null;
  return (obj, sessionId) => {
    if (obj?.type === "system" && obj.subtype === "init") {
      installedVersion =
        typeof obj.claude_code_version === "string" && obj.claude_code_version.trim()
          ? obj.claude_code_version
          : null;
    }
    const parsed = parse(obj, sessionId);
    if (isSyntheticApiErrorMessage(obj))
      return (
        parsed?.map((event) =>
          event.type === "message" && typeof event.text === "string"
            ? { ...event, text: redactSecrets(event.text) }
            : event,
        ) ?? parsed
      );
    if (
      obj?.type !== "result" ||
      obj.is_error !== true ||
      obj.subtype === "error_max_turns" ||
      obj.subtype === "error_max_structured_output_retries" ||
      !Number.isInteger(obj.api_error_status) ||
      obj.api_error_status < 400 ||
      obj.api_error_status > 599
    )
      return parsed;
    // A context terminal keeps its owner (the context signal, no added error);
    // its status copy of the API prose is still a diagnostic (INV-146).
    if (claudeTerminalContextEvent(obj.terminal_reason, sessionId, nowIso()) !== null)
      return parsed?.map((event) => maskApiFailureCopy(event, obj.result)) ?? parsed;
    const code =
      typeof obj.api_error_code === "string" && obj.api_error_code.length > 0
        ? obj.api_error_code
        : null;
    const message = typeof obj.result === "string" ? redactSecrets(obj.result) : null;
    const vendor = VendorFailureSchema.safeParse({
      code,
      message: message?.slice(0, 4000) ?? null,
      source: "claude_stdout",
    });
    const refusal =
      code === "claude_code_version_too_old"
        ? {
            kind: "vendor_cli_too_old" as const,
            native_code: "claude_code_version_too_old" as const,
            source: "claude_stdout" as const,
            binary_path: binaryPath,
            installed_version: installedVersion,
          }
        : undefined;
    return [
      // Replace the result parser's generic subtype error with the native
      // API cause; usage and all non-error evidence keep their order. The
      // parser's status copy of this API-failure prose is the same vendor
      // diagnostic, so it is masked like the error (INV-146).
      ...(parsed ?? []).flatMap((event) =>
        event.type === "error" ? [] : [maskApiFailureCopy(event, obj.result)],
      ),
      {
        type: "error",
        session_id: sessionId,
        ts: nowIso(),
        error: message || `Claude API request failed (HTTP ${obj.api_error_status})`,
        ...(refusal ? { request_refusal: refusal } : {}),
        payload: {
          api_error_status: obj.api_error_status,
          ...(vendor.success ? { vendor_failure: vendor.data } : {}),
        },
      },
    ];
  };
}

/** The CLI's own API-error turn: an assistant frame it synthesized (model
 * `<synthetic>`, never a model's output) that names an API error. Its text is
 * the vendor's failure prose, a diagnostic (INV-146). */
function isSyntheticApiErrorMessage(obj: Parameters<ClaudeEventParser>[0]): boolean {
  return (
    obj?.type === "assistant" &&
    obj.message?.model === "<synthetic>" &&
    (obj.is_api_error_message === true || typeof obj.error === "string")
  );
}

/** The result parser keeps a non-success `result` as a status event with
 * `non_success_result`. On an API-failure result that text is the vendor's
 * failure prose, not model output. A structured-output status carries the
 * model's own JSON instead and stays exact. */
function maskApiFailureCopy(event: HarnessEvent, result: unknown): HarnessEvent {
  if (
    event.type !== "status" ||
    event.payload?.["non_success_result"] !== true ||
    event.payload?.["structured_output"] === true ||
    typeof result !== "string" ||
    event.text !== result
  )
    return event;
  return { ...event, text: redactSecrets(result) };
}

/** Attach only this invocation's native failure to its actual failed exit,
 * through the existing terminal provenance channel shared with Codex. */
export async function* withClaudeVendorFailure(
  events: AsyncIterable<HarnessEvent>,
): AsyncGenerator<HarnessEvent> {
  let vendor: VendorFailureEvidence | null = null;
  for await (const event of events) {
    if (event.type === "error") {
      const parsed = VendorFailureSchema.safeParse(event.payload?.["vendor_failure"]);
      vendor = parsed.success ? parsed.data : null;
    }
    if (event.type === "message" && event.final) vendor = null;
    if (
      event.type === "completed" &&
      vendor &&
      !event.aborted &&
      !event.payload?.["aborted"] &&
      !event.payload?.["exit_signal"] &&
      event.payload?.["harness_reported_error"] === true
    ) {
      yield { ...event, payload: { ...event.payload, vendor_failure: vendor } };
    } else yield event;
  }
}
