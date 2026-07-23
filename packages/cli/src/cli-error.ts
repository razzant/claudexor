/**
 * The ONE CLI result/error projector (D-7, GH #28). Every failure class —
 * argument/usage validation, pre-daemon bootstrap, typed preflight/daemon
 * problems, transport errors, and unexpected exceptions — is normalized into a
 * single typed problem and rendered as EXACTLY ONE JSON envelope on stdout
 * (`--json` mode) or one human line on stderr (text mode), both derived from
 * the SAME typed object. A central category -> exit-code table owns the codes:
 * usage/validation = 2, operational failure = 1.
 *
 * This projector is intentionally dependency-light: it imports only the CLI IO
 * owner and the typed `ControlProblem`/Zod shapes. It never needs the daemon,
 * writable state, or a schema-generation step that could itself fail — so it is
 * a valid last-resort serializer even when bootstrap failed.
 *
 * The run-verb SUCCESS envelope (`{runId, runDir, status, ...}`) does NOT flow
 * through here: the projector owns FAILURE paths and the non-run commands whose
 * error handling was previously ad-hoc. The failure envelope keeps a legacy
 * `error` alias of `message` so existing consumers/tests that read `error`
 * keep working.
 */
import { ControlProblem } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { printJson, printJsonLine } from "./cli-io.js";

export type CliErrorCategory = "usage" | "operational";

/** The central category -> process exit-code table (the one owner). */
const CATEGORY_EXIT: Record<CliErrorCategory, number> = {
  usage: 2,
  operational: 1,
};

export interface CliProblemFields {
  code?: string;
  retryable?: boolean;
  fieldErrors?: Record<string, string[]>;
  requiredActions?: string[];
  details?: Record<string, unknown>;
  /** Typed route-specific recovery context (bounded). Never a duplicate of message. */
  context?: Record<string, unknown>;
}

/** A typed CLI failure: category picks the exit code, the rest survive projection. */
export class CliError extends Error {
  readonly category: CliErrorCategory;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly fieldErrors?: Record<string, string[]>;
  readonly requiredActions?: string[];
  readonly details?: Record<string, unknown>;
  readonly context?: Record<string, unknown>;

  constructor(category: CliErrorCategory, message: string, fields: CliProblemFields = {}) {
    super(message);
    this.name = "CliError";
    this.category = category;
    this.code = fields.code;
    this.retryable = fields.retryable;
    this.fieldErrors = fields.fieldErrors;
    this.requiredActions = fields.requiredActions;
    this.details = fields.details;
    this.context = fields.context;
  }
}

/** A usage/validation failure (exit 2). An operational failure (exit 1) is
 * `new CliError("operational", ...)` — most operational failures reach the
 * projector as native throwables (Node errors, ControlProblem-derived errors)
 * rather than a hand-built one. */
export function usageError(message: string, fields: CliProblemFields = {}): CliError {
  return new CliError("usage", message, fields);
}

/**
 * A structured minimum-value validation error matching the #28 contract shape:
 * `{code:invalid_argument, message, details:{field, minimum}, fieldErrors}`.
 */
export function minIntError(field: string, minimum: number): CliError {
  const message = `--${field} must be at least ${minimum}`;
  return new CliError("usage", message, {
    code: "invalid_argument",
    fieldErrors: { [field]: [message] },
    details: { field, minimum },
  });
}

/** A Zod-shaped issue, detected structurally so the projector needs no zod dep. */
interface ZodLikeIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** Structural ZodError detection (no `zod` import — the projector stays
 * dependency-light so it is a valid last-resort serializer). */
function asZodIssues(err: unknown): ZodLikeIssue[] | null {
  if (
    err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "ZodError" &&
    Array.isArray((err as { issues?: unknown }).issues)
  ) {
    return (err as { issues: ZodLikeIssue[] }).issues;
  }
  return null;
}

/** Convert Zod issues into path->messages field errors (no serialized Zod dump). */
export function zodFieldErrors(issues: readonly ZodLikeIssue[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.map((p) => String(p)).join(".") : "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/** A human one-liner from Zod issues — the first issue, never the whole object. */
function zodMessage(issues: readonly ZodLikeIssue[]): string {
  const first = issues[0];
  if (!first) return "invalid input";
  const at = first.path.length > 0 ? ` at ${first.path.map((p) => String(p)).join(".")}` : "";
  return `${first.message}${at}`;
}

const ERRNO_RE = /^E[A-Z0-9]+$/;
const MAX_CONTEXT_STRING = 2000;

/** Bound long string values in a typed context so a localized git/tool stderr
 * is demoted to bounded evidence instead of flooding the envelope (QA-051). */
export function boundContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const keys = Object.keys(context);
  if (keys.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === "string" && value.length > MAX_CONTEXT_STRING) {
      out[key] =
        `${value.slice(0, MAX_CONTEXT_STRING)}… (truncated ${value.length - MAX_CONTEXT_STRING} chars)`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

interface NormalizedProblem {
  category: CliErrorCategory;
  message: string;
  code?: string;
  retryable?: boolean;
  fieldErrors?: Record<string, string[]>;
  requiredActions?: string[];
  details?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

function nonEmptyRecord(
  value: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined;
}

function nonEmptyArray(value: string[] | undefined): string[] | undefined {
  return value && value.length > 0 ? value : undefined;
}

/**
 * Normalize ANY thrown value into a typed problem. `defaultCategory` decides the
 * exit code only when the throwable carries no category signal of its own — a
 * flag-parsing context passes "usage", the top-level catch passes "operational".
 */
export function normalizeThrowable(
  err: unknown,
  defaultCategory: CliErrorCategory,
): NormalizedProblem {
  if (err instanceof CliError) {
    return {
      category: err.category,
      message: err.message,
      code: err.code,
      retryable: err.retryable,
      fieldErrors: nonEmptyRecord(err.fieldErrors),
      requiredActions: nonEmptyArray(err.requiredActions),
      details: err.details,
      context: boundContext(err.context),
    };
  }
  const zodIssues = asZodIssues(err);
  if (zodIssues) {
    return {
      category: "usage",
      code: "invalid_argument",
      message: zodMessage(zodIssues),
      fieldErrors: zodFieldErrors(zodIssues),
    };
  }
  if (err instanceof Error) {
    const anyErr = err as Error & Record<string, unknown>;
    const code = typeof anyErr["code"] === "string" ? (anyErr["code"] as string) : undefined;
    const status = typeof anyErr["status"] === "number" ? (anyErr["status"] as number) : undefined;
    const category: CliErrorCategory =
      status === 400 ||
      status === 422 ||
      code === "inline_secret_rejected" ||
      code === "invalid_argument"
        ? "usage"
        : code && ERRNO_RE.test(code)
          ? "operational"
          : defaultCategory;
    const retryable =
      typeof anyErr["retryable"] === "boolean" ? (anyErr["retryable"] as boolean) : undefined;
    const fieldErrors = nonEmptyRecord(
      anyErr["fieldErrors"] as Record<string, string[]> | undefined,
    );
    const requiredActions = nonEmptyArray(anyErr["requiredActions"] as string[] | undefined);
    // A Node system error's syscall/errno are stable machine detail.
    const details =
      typeof anyErr["syscall"] === "string" || typeof anyErr["errno"] === "number"
        ? {
            ...(typeof anyErr["syscall"] === "string" ? { syscall: anyErr["syscall"] } : {}),
            ...(typeof anyErr["errno"] === "number" ? { errno: anyErr["errno"] } : {}),
          }
        : undefined;
    return {
      category,
      message: err.message,
      code,
      retryable,
      fieldErrors,
      requiredActions,
      details,
    };
  }
  return { category: defaultCategory, message: String(err) };
}

/** Recursively redact secret-like tokens from any projected value: strings are
 *  redacted directly; arrays and plain objects are mapped so a token nested in
 *  `details`/`context` (a runtime-assembled git/tool stderr, an errored URL)
 *  never leaks. Non-string leaves pass through untouched. */
function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = redactUnknown(v);
    return out;
  }
  return value;
}

/**
 * The SINGLE redaction owner for the projector (QA — runtime-assembled tokens):
 * every human/machine string a failure envelope renders — message, field-error
 * lines, required actions, and details/context leaves — is passed through
 * `redactSecrets` here, so a token that reached a thrown message or a bounded
 * git/tool context is masked once, at the one place that serializes failures.
 */
function redactProblem(p: NormalizedProblem): NormalizedProblem {
  return {
    ...p,
    message: redactSecrets(p.message),
    fieldErrors: p.fieldErrors
      ? Object.fromEntries(
          Object.entries(p.fieldErrors).map(([k, v]) => [k, v.map((s) => redactSecrets(s))]),
        )
      : undefined,
    requiredActions: p.requiredActions?.map((s) => redactSecrets(s)),
    details: p.details ? (redactUnknown(p.details) as Record<string, unknown>) : undefined,
    context: p.context ? (redactUnknown(p.context) as Record<string, unknown>) : undefined,
  };
}

export interface RenderCliFailureOptions {
  /** Exit category when the throwable carries no signal of its own. */
  defaultCategory?: CliErrorCategory;
  /** Prepended to the human message (e.g. "claudexor decision:"). */
  messagePrefix?: string;
  /**
   * NDJSON run surface (`--json-stream`): emit the failure envelope as ONE
   * COMPACT line via `printJsonLine` instead of the pretty multi-line object, so
   * a line-delimited consumer keeps `for line in stream: json.loads(line)` valid.
   * Implies a JSON surface — pass `json = true` with it.
   */
  stream?: boolean;
}

/**
 * THE projector: render any thrown value as one failure envelope (json) or one
 * stderr line (text), and return the process exit code. Human stderr and the
 * JSON envelope are generated from the SAME normalized problem, and every string
 * they carry is secret-redacted once here (the single owner).
 */
export function renderCliFailure(
  json: boolean,
  err: unknown,
  opts: RenderCliFailureOptions = {},
): number {
  const p = redactProblem(normalizeThrowable(err, opts.defaultCategory ?? "operational"));
  const exitCode = CATEGORY_EXIT[p.category];
  const prefix = opts.messagePrefix;
  const message = prefix && !p.message.startsWith(prefix) ? `${prefix} ${p.message}` : p.message;
  if (json) {
    const envelope = {
      ok: false,
      exitCode,
      ...(p.code ? { code: p.code } : {}),
      message,
      // Legacy alias: earlier CLI envelopes and their consumers read `error`.
      error: message,
      ...(p.retryable !== undefined ? { retryable: p.retryable } : {}),
      ...(p.fieldErrors ? { fieldErrors: p.fieldErrors } : {}),
      ...(p.requiredActions ? { requiredActions: p.requiredActions } : {}),
      ...(p.details ? { details: p.details } : {}),
      ...(p.context ? { context: p.context } : {}),
    };
    if (opts.stream) printJsonLine(envelope);
    else printJson(envelope);
  } else {
    process.stderr.write(`${message}\n`);
  }
  return exitCode;
}

/**
 * Build a typed CliError from a failed control-API response body. A typed
 * `ControlProblem` (code/message/retryable/fieldErrors/requiredActions/context)
 * is preserved intact — never flattened to a bare string. The exit category is
 * derived from the HTTP status: 400/422 are validation (exit 2), everything
 * else is an operational failure (exit 1). Context strings are bounded so a
 * localized git/tool stderr rides as bounded evidence.
 */
export function controlProblemError(
  status: number,
  body: unknown,
  fallbackMessage: string,
): CliError {
  const category: CliErrorCategory = status === 400 || status === 422 ? "usage" : "operational";
  const parsed = ControlProblem.safeParse(body);
  if (parsed.success) {
    const pb = parsed.data;
    return new CliError(category, pb.message || fallbackMessage, {
      code: pb.code,
      retryable: pb.retryable,
      fieldErrors: nonEmptyRecord(pb.fieldErrors),
      requiredActions: nonEmptyArray(pb.requiredActions),
      context: boundContext(pb.context),
      ...(pb.evidenceRefs.length > 0 ? { details: { evidenceRefs: pb.evidenceRefs } } : {}),
    });
  }
  // Not a typed ControlProblem: salvage message/error/code without inventing fields.
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message =
    typeof record["message"] === "string"
      ? (record["message"] as string)
      : typeof record["error"] === "string"
        ? (record["error"] as string)
        : fallbackMessage;
  const code = typeof record["code"] === "string" ? (record["code"] as string) : undefined;
  const retryable =
    typeof record["retryable"] === "boolean" ? (record["retryable"] as boolean) : undefined;
  return new CliError(category, message, { code, retryable });
}
