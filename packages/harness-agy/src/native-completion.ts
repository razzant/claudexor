import type { HarnessEvent, HarnessRequestRefusal } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";

const AGY_ERROR = "AGY_ERROR: ";

/** The vendor's machine record of a headless turn that failed (one stderr line
 * `AGY_ERROR: {json}`, printed before agy exits 3): the record when the rest of
 * a line with the marker is a JSON object, `null` when it is not (that record
 * is unreadable), `undefined` for a line without the marker. */
function agyErrorRecord(line: string): Record<string, unknown> | null | undefined {
  if (!line.startsWith(AGY_ERROR)) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(AGY_ERROR.length));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The vendor's headless diagnostic, observed independently of model stdout.
 * Keep only the native permission fact, before the diagnostic tail can evict it,
 * and the last `AGY_ERROR` record (read live, then again from the replayed tail,
 * where the last marker line is the same one or absent). Generic empty output
 * and permission-looking model prose are not evidence.
 *
 * The same wrap closes the try's terminal facts on the run loop's ONE
 * `completed`: the vendor failure the try voiced rides its payload (evidence,
 * never a retry input), and a stream that ended without the terminal `result`
 * frame, without an error, is an honest failure rather than a typed final or
 * an empty success. A try that voiced its failure and whose `AGY_ERROR` record
 * says exactly `retryable: false` is the vendor's refusal of that request
 * (`vendor_not_retryable`): the engine then neither retries, continues nor
 * rotates it. Every other record, field or value decides nothing. */
export function createAgyNativeCompletion() {
  let permission: string | undefined;
  let agyError: Record<string, unknown> | undefined;
  let settingsRejected = false;
  const observeStderr = (text: string): void => {
    permission ??=
      /^jetski: no output produced — a tool required the "([a-z_]+)" permission that headless mode cannot prompt for, so it was auto-denied\./m.exec(
        text,
      )?.[1];
    // A CLI without `--settings` rejects it while parsing arguments, before any
    // model or account access: official 1.1.13, 1.3.4 and 1.4.9 print exactly
    // this line, then usage text that evicts it from the exit detail. Another
    // wording keeps the run loop's generic exit error.
    settingsRejected ||= /^flags? provided but not defined: --?settings\b/m.test(text);
    // The last line with the marker decides, and an unreadable one leaves the
    // verdict unknown; a line without the marker changes nothing.
    for (const line of text.split("\n")) {
      const record = agyErrorRecord(line.trimEnd());
      if (record !== undefined) agyError = record ?? undefined;
    }
  };
  async function* wrap(stream: AsyncIterable<HarnessEvent>): AsyncGenerator<HarnessEvent> {
    let hasAnswer = false;
    let terminal = false;
    let vendorFailure: unknown;
    for await (const event of stream) {
      if (event.type === "message" && event.final === true && event.text?.trim()) hasAnswer = true;
      if (event.type === "message" && event.final === true) {
        terminal = true;
        vendorFailure = undefined; // a later typed final supersedes an earlier failure
      }
      if (event.type === "error") {
        terminal = true;
        vendorFailure = event.payload?.["vendor_failure"];
      }
      if (event.type === "completed") {
        // Retained normalized recordings can replay the historical diagnostic.
        const tail = event.payload?.["stderr_tail"];
        if (typeof tail === "string") observeStderr(tail);
        if (permission)
          yield {
            type: hasAnswer ? "status" : "error",
            session_id: event.session_id,
            ts: event.ts,
            ...(hasAnswer
              ? {
                  text: `agy headless tool permission refused: ${permission}; retained answer is not proof of that tool's success`,
                }
              : { error: `agy headless tool permission refused: ${permission}` }),
            permission_denial: { permission, source: "agy_native_stderr" },
            payload: { code: "permission_denied" },
          };
        const aborted = event.aborted === true || event.payload?.["aborted"] === true;
        if (!terminal && !aborted && !(permission && !hasAnswer))
          yield {
            type: "error",
            session_id: event.session_id,
            ts: event.ts,
            error:
              "agy ended without its terminal result (no typed final or vendor status); any streamed text is retained evidence only, and the cause is unknown",
          };
        const failed =
          !aborted &&
          !event.payload?.["exit_signal"] &&
          event.payload?.["harness_reported_error"] === true;
        if (failed && agyError?.["retryable"] === false) {
          const words = typeof agyError["short_error"] === "string" ? agyError["short_error"] : "";
          const id = agyError["error_id"];
          const refusal: HarnessRequestRefusal = {
            kind: "vendor_not_retryable",
            source: "agy_stderr",
            error_id: typeof id === "string" && id && id.length <= 128 ? id : null,
          };
          yield {
            type: "error",
            session_id: event.session_id,
            ts: event.ts,
            error: `agy marked the failed request not retryable${words.trim() ? `: ${redactSecrets(words.trim()).slice(0, 1000)}` : ""}`,
            request_refusal: refusal,
          };
        }
        yield failed && vendorFailure !== undefined
          ? { ...event, payload: { ...event.payload, vendor_failure: vendorFailure } }
          : event;
        continue;
      }
      yield event;
    }
  }
  /** The run loop's translation of a stderr-only nonzero exit. */
  const parseStderrFailure = (_tail: string, sessionId: string): HarnessEvent | null =>
    settingsRejected
      ? {
          type: "error",
          session_id: sessionId,
          ts: new Date().toISOString(),
          error:
            "agy rejected --settings before starting: readonly runs need agy 1.4.10 or newer, whose session-only settings deny commands and writes; update agy. Full and workspace_write runs do not need it.",
          payload: { code: "agy_session_settings_unsupported" },
        }
      : null;
  return { observeStderr, parseStderrFailure, wrap };
}
