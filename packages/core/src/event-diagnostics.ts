import type { HarnessEvent } from "@claudexor/schema";
import { appendLine, redactSecrets } from "@claudexor/util";

/**
 * Payload keys adapters use for diagnostics on any event type: a vendor
 * failure report, the process stderr tail, a launch advisory, a provider error
 * object and a nested native error.
 */
const DIAGNOSTIC_PAYLOAD_KEYS = [
  "vendor_failure",
  "stderr_tail",
  "stderr",
  "launch_advisory",
  "provider_error",
  "error",
] as const;

/**
 * Model-authored working content an adapter may carry inside an error event's
 * payload: the bounded partial text of a failed completion. It is never masked
 * (INV-146); the rest of that payload stays a masked diagnostic.
 */
const WORKING_PAYLOAD_KEYS: ReadonlySet<string> = new Set(["partial_output"]);

/**
 * Mask one diagnostic value. Structured values are masked through their JSON
 * text; when masking changes that text so it no longer parses, the masked text
 * itself is kept. The unmasked value is never returned for anything that has a
 * JSON text.
 */
function maskValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "[unserializable diagnostic]";
  }
  // undefined, a function or a symbol has no JSON text and is not journaled.
  if (serialized === undefined) return value;
  const masked = redactSecrets(serialized);
  try {
    return JSON.parse(masked) as unknown;
  } catch {
    return masked;
  }
}

/** Mask a record through its JSON text, keys included. If that does not yield a
 * record (an unserializable value, or masking broke the JSON text), each key
 * and value is masked on its own so the payload keeps its record shape. */
function maskRecord(record: Record<string, unknown>): Record<string, unknown> {
  const whole = maskValue(record);
  if (whole && typeof whole === "object" && !Array.isArray(whole))
    return whole as Record<string, unknown>;
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) masked[redactSecrets(key)] = maskValue(value);
  return masked;
}

/**
 * The one typed choke point every journal writer passes a harness event
 * through before persisting it (INV-146). Engine diagnostics are masked: the
 * event's `error` text; for an `error` event its text and its payload (the
 * adapter's native error object, keys included) except the working-content
 * keys above;
 * on any event the payload's diagnostic keys above. Working content is
 * returned unchanged: message and answer text, a failed completion's partial
 * output, tool calls and results the next model reads, interaction payloads,
 * speech, usage and every other field.
 */
export function maskHarnessEventDiagnostics(ev: HarnessEvent): HarnessEvent {
  const masked: HarnessEvent = { ...ev };
  if (ev.error !== undefined) masked.error = redactSecrets(ev.error);
  if (ev.type === "error" && ev.text !== undefined) masked.text = redactSecrets(ev.text);
  if (ev.payload !== undefined) {
    if (ev.type === "error") {
      // Set the working fields aside, mask the rest as one object (its keys
      // included), then restore them.
      const working: Record<string, unknown> = {};
      const rest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(ev.payload))
        (WORKING_PAYLOAD_KEYS.has(key) ? working : rest)[key] = value;
      masked.payload = { ...maskRecord(rest), ...working };
    } else {
      let payload: Record<string, unknown> | undefined;
      for (const key of DIAGNOSTIC_PAYLOAD_KEYS) {
        if (ev.payload[key] === undefined) continue;
        payload ??= { ...ev.payload };
        payload[key] = maskValue(ev.payload[key]);
      }
      if (payload) masked.payload = payload;
    }
  }
  return masked;
}

/**
 * Append one harness event to an attempt or reviewer journal, diagnostics
 * masked, and return the stored view so a caller that derives more records
 * from the event (a reviewer transcript) uses the journal's exact bytes.
 */
export function appendHarnessEvent(path: string, ev: HarnessEvent): HarnessEvent {
  const stored = maskHarnessEventDiagnostics(ev);
  appendLine(path, JSON.stringify(stored));
  return stored;
}
