import { redactSecrets } from "@claudexor/util";

/** Bounds for the request-validation projection (QA-053). Redact-first, then
 *  truncate; never split a redaction marker; disclose omitted counts. */
const ZOD_MAX_ISSUES = 25;
const ZOD_MAX_PER_FIELD = 3;
const ZOD_MAX_PATH_BYTES = 256;
const ZOD_MAX_MESSAGE_BYTES = 512;

interface StructuralZodIssue {
  path: (string | number)[];
  message: string;
  code?: string;
  expected?: unknown;
  received?: unknown;
  options?: unknown;
  keys?: unknown;
}

/** Structural ZodError detection — deliberately NOT `instanceof`, which is
 *  unreliable across duplicated `zod` package copies. A request-boundary
 *  validation failure carries an `issues` array of `{path,message}`. */
function structuralZodIssues(error: unknown): StructuralZodIssue[] | null {
  if (!error || typeof error !== "object") return null;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const out: StructuralZodIssue[] = [];
  for (const raw of issues) {
    if (!raw || typeof raw !== "object") return null;
    const issue = raw as Record<string, unknown>;
    if (!Array.isArray(issue["path"]) || typeof issue["message"] !== "string") return null;
    out.push(issue as unknown as StructuralZodIssue);
  }
  return out;
}

function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // Truncate on a whole UTF-16 code point boundary, then trim to the byte cap.
  let sliced = text;
  while (Buffer.byteLength(sliced, "utf8") > maxBytes && sliced.length > 0) {
    sliced = sliced.slice(0, -1);
  }
  return sliced;
}

/** JSON Pointer (RFC 9457-style) for one issue path, without echoing an
 *  unrecognized key verbatim when it is unsafe. */
function issuePointer(path: (string | number)[]): string {
  if (path.length === 0) return "/";
  const parts = path.map((seg) =>
    typeof seg === "number"
      ? String(seg)
      : redactSecrets(seg).replaceAll("~", "~0").replaceAll("/", "~1"),
  );
  return truncateBytes("/" + parts.join("/"), ZOD_MAX_PATH_BYTES);
}

/** A concise, safe per-issue message that never echoes a raw RECEIVED value
 *  (type names and schema-declared enums/literals are safe; the actual input
 *  value and attacker-supplied keys are not). */
function safeIssueMessage(issue: StructuralZodIssue): string {
  const code = issue.code;
  let text: string;
  switch (code) {
    case "invalid_type":
      // `expected`/`received` are TYPE names here (e.g. "object"), not values.
      text = `Expected ${String(issue.expected)}, received ${String(issue.received)}.`;
      break;
    case "invalid_enum_value":
    case "invalid_literal": {
      const options = Array.isArray(issue.options)
        ? issue.options.map((o) => JSON.stringify(o)).join(", ")
        : issue.expected !== undefined
          ? JSON.stringify(issue.expected)
          : "";
      text = options ? `Expected one of: ${options}.` : "Value is not an accepted option.";
      break;
    }
    case "unrecognized_keys":
      text = "Unrecognized key(s) in object.";
      break;
    case "invalid_union":
      text = "Value does not match any accepted shape.";
      break;
    default:
      // Other Zod codes (too_small/too_big/invalid_string/custom) carry
      // schema-derived messages that do not echo the input value.
      text = issue.message;
  }
  return truncateBytes(redactSecrets(text), ZOD_MAX_MESSAGE_BYTES);
}

/**
 * QA-053: turn a request-boundary ZodError into a machine-readable problem —
 * structured `fieldErrors` (JSON Pointer -> messages), a short single-line human
 * `message`, and bounded `context` counts — instead of copying Zod's multiline
 * issue-array serialization into `message` with an empty `fieldErrors`.
 *
 * Returns a normalized typed error the shared `problemBody` projection already
 * knows how to serialize (code/message/fieldErrors/context). A non-ZodError, or
 * a typed error that already owns `code`/`fieldErrors` (idempotency_key_required,
 * inline_secret_rejected, invalid JSON body, 413), is returned UNCHANGED — this
 * only normalizes structural validation exceptions at the request boundary and
 * never reinterprets a service-output or internal error as a user field error.
 */
export function normalizeRequestValidationError(error: unknown): unknown {
  // A typed error that already carries a product code is authoritative.
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return error;
  }
  const issues = structuralZodIssues(error);
  if (!issues) return error;

  const fieldErrors: Record<string, string[]> = {};
  let used = 0;
  let omitted = 0;
  const push = (pointer: string, message: string): void => {
    if (used >= ZOD_MAX_ISSUES) {
      omitted += 1;
      return;
    }
    const bucket = (fieldErrors[pointer] ??= []);
    if (bucket.length >= ZOD_MAX_PER_FIELD) {
      omitted += 1;
      return;
    }
    bucket.push(message);
    used += 1;
  };
  for (const issue of issues) {
    // Unrecognized keys: surface WHICH field is unexpected via the pointer
    // (the client's own field name, redacted) — the value is never echoed. This
    // is the RFC 9457 pattern and is more useful than a bare root message.
    if (issue.code === "unrecognized_keys" && Array.isArray(issue.keys) && issue.keys.length > 0) {
      for (const key of issue.keys) {
        if (typeof key !== "string") continue;
        push(issuePointer([...issue.path, key]), "Unexpected field; not part of this request.");
      }
      continue;
    }
    push(issuePointer(issue.path), safeIssueMessage(issue));
  }
  const fieldCount = Object.keys(fieldErrors).length;
  const message = `Request validation failed for ${fieldCount} field${fieldCount === 1 ? "" : "s"}.`;
  return Object.assign(new Error(message), {
    status: 400,
    code: "invalid_request",
    retryable: false,
    fieldErrors,
    context: { issueCount: issues.length, omittedIssueCount: omitted },
  });
}

/** Max bytes of vendor (Git) stderr retained as revert-refusal evidence. */
const REVERT_DETAIL_MAX_BYTES = 2000;

/** The typed revert-refusal classes the workspace PRODUCER emits (git.ts
 *  `RevertRefusalReason`). Kept structurally in sync here (control-api does not
 *  depend on @claudexor/workspace) — the round-trip is asserted by test. */
export type RevertRefusalReason = "postimage_diverged" | "reverse_apply_failed";

/**
 * QA-051 / W3: map a workspace revert refusal to a stable, locale-independent
 * English message + typed reason code, keeping the original (redacted, bounded)
 * vendor stderr as context evidence rather than the semantic message.
 *
 * The class is decided by the PRODUCER: `reasonCode` comes straight from
 * `RevertResult.reasonCode` (which branch failed), NOT from regexing the human
 * `reason`. The English-prefix regex survives only as a conservative fallback
 * for a legacy-shaped result that carries no typed code.
 */
export function revertRefusedProblem(
  rawReason: string | undefined,
  reasonCode?: RevertRefusalReason,
): {
  message: string;
  context: { reason: string; detail: string };
} {
  const raw = rawReason ?? "revert refused";
  // Prefer the producer's typed class; fall back to the English-prefix match
  // only when a legacy caller supplied no code.
  const reason: RevertRefusalReason =
    reasonCode ??
    (/postimage no longer matches/.test(raw) ? "postimage_diverged" : "reverse_apply_failed");
  const message =
    reason === "postimage_diverged"
      ? "Revert is no longer available because the affected files changed after this turn."
      : "Revert could not be applied to the current project tree.";
  let detail = redactSecrets(raw);
  if (Buffer.byteLength(detail, "utf8") > REVERT_DETAIL_MAX_BYTES) {
    while (Buffer.byteLength(detail, "utf8") > REVERT_DETAIL_MAX_BYTES && detail.length > 0) {
      detail = detail.slice(0, -1);
    }
  }
  return { message, context: { reason, detail } };
}

const RESERVED_FIELDS = new Set([
  "error",
  "message",
  "code",
  "retryable",
  "fieldErrors",
  "requiredActions",
  "evidenceRefs",
]);

export type ControlProblemError = Error & {
  code: string;
  retryable: boolean;
  fieldErrors?: unknown;
  requiredActions?: unknown;
  evidenceRefs?: unknown;
  context: Record<string, unknown>;
};

export function controlProblemError(status: number, body: unknown): ControlProblemError {
  const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message =
    typeof source["error"] === "string"
      ? source["error"]
      : typeof source["message"] === "string"
        ? source["message"]
        : `request failed with status ${status}`;
  const code = typeof source["code"] === "string" ? source["code"] : `http_${status}`;
  const context = Object.fromEntries(
    Object.entries(source).filter(([key]) => !RESERVED_FIELDS.has(key)),
  );
  return Object.assign(new Error(message), {
    code,
    retryable: source["retryable"] === true,
    fieldErrors: source["fieldErrors"],
    requiredActions: source["requiredActions"],
    evidenceRefs: source["evidenceRefs"],
    context,
  });
}

/**
 * The problem `code` for a THROWN service error: a typed code the service
 * chose (e.g. settings-service `config_error`) reaches the wire verbatim so
 * clients can key remediation on it; only an untyped throw is the generic
 * `internal_error` (BACKLOG N1 — the catch paths used to stamp every throw
 * `internal_error`, erasing the typed taxonomy the same body carried).
 */
export function thrownProblemCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const value = (error as { code: unknown }).code;
    if (typeof value === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(value)) return value;
  }
  return "internal_error";
}
