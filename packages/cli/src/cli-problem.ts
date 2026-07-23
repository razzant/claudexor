import type { ControlProblem } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";

export type CliFailureCategory = "usage" | "validation" | "operational" | "unexpected";

export interface CliFailureEnvelope extends ControlProblem {
  ok: false;
  exitCode: 1 | 2;
  /** Additive compatibility alias for clients that still read `error`. */
  error: string;
  /** HTTP-like status when the failure source supplied one. */
  status?: number;
}

export interface CliFailureOptions {
  category?: CliFailureCategory;
  fallbackCode?: string;
  prefix?: string;
  status?: number;
  context?: Record<string, unknown>;
}

const EXIT_CODE: Readonly<Record<CliFailureCategory, 1 | 2>> = {
  usage: 2,
  validation: 2,
  operational: 1,
  unexpected: 1,
};

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SIMPLE_PATH_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_CONTEXT_DEPTH = 5;
const MAX_CONTEXT_ENTRIES = 50;
const MAX_PUBLIC_ATOM_LENGTH = 256;
const MAX_PUBLIC_TEXT_LENGTH = 1_024;
const MAX_PROJECTION_NODES = 512;
const MAX_PROJECTION_CHARS = 32_768;

interface ProjectionBudget {
  nodes: number;
  chars: number;
}

function projectionBudget(): ProjectionBudget {
  return { nodes: MAX_PROJECTION_NODES, chars: MAX_PROJECTION_CHARS };
}

/** Detect the one-object machine surface even when normal argv parsing itself fails. */
export function argvRequestsJson(argv: readonly string[]): boolean {
  let requested = false;
  for (const arg of argv) {
    if (arg === "--json") requested = true;
    else if (arg.startsWith("--json=")) requested = arg.slice("--json=".length) === "true";
  }
  return requested;
}

function readField(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function arrayOf(value: unknown): readonly unknown[] | null {
  try {
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function boundedArrayValues(value: unknown): readonly unknown[] | null {
  const array = arrayOf(value);
  if (!array) return null;
  let length: number;
  try {
    length = Math.min(array.length, MAX_CONTEXT_ENTRIES);
  } catch {
    return [];
  }
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      values.push(array[index]);
    } catch {
      values.push(undefined);
    }
  }
  return values;
}

function safeText(value: unknown, fallback: string, budget: ProjectionBudget): string {
  let text = fallback;
  try {
    if (typeof value === "string") text = value;
    else if (value instanceof Error) text = value.message;
    else if (value !== undefined) text = String(value);
  } catch {
    /* retain the daemon-free fallback */
  }
  return budgetedPublicText(text, budget, MAX_PUBLIC_TEXT_LENGTH);
}

function finiteStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : undefined;
}

function categoryFrom(source: unknown, options: CliFailureOptions, status?: number) {
  const carried = readField(source, "cliCategory");
  if (
    carried === "usage" ||
    carried === "validation" ||
    carried === "operational" ||
    carried === "unexpected"
  ) {
    return carried;
  }
  if (options.category) return options.category;
  return status === 400 || status === 422 ? "validation" : "unexpected";
}

function stringList(value: unknown, budget: ProjectionBudget): string[] {
  const entries = boundedArrayValues(value);
  if (!entries) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" && entry.length > 0) {
      out.push(budgetedPublicText(entry, budget));
    }
  }
  return out;
}

function redactPublicText(value: string, maxLength = MAX_PUBLIC_ATOM_LENGTH): string {
  const truncationSuffix = "…[Truncated]";
  const sanitized = redactSecrets(value);
  const scanLimit = Math.min(sanitized.length, maxLength);
  for (let offset = 0; offset < scanLimit; offset += 1) {
    const fragment = ` ${sanitized.slice(offset, offset + maxLength)} `;
    if (redactSecrets(fragment) !== fragment) return "[redacted]";
  }
  const bounded =
    sanitized.length > maxLength
      ? `${sanitized.slice(0, Math.max(0, maxLength - truncationSuffix.length))}${truncationSuffix}`
      : sanitized;
  return bounded;
}

function budgetedPublicText(
  value: string,
  budget: ProjectionBudget,
  maxLength = MAX_PUBLIC_ATOM_LENGTH,
): string {
  if (budget.chars <= 0) return "[Truncated]";
  const safe = redactPublicText(value, maxLength);
  const bounded =
    safe.length <= budget.chars
      ? safe
      : budget.chars > 1
        ? `${safe.slice(0, budget.chars - 1)}…`
        : "…";
  budget.chars = Math.max(0, budget.chars - bounded.length);
  return bounded;
}

function sensitiveKey(key: string): boolean {
  const compact = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (
    compact === "credentialprofile" ||
    compact === "credentialprofileid" ||
    compact === "credentialprofileref" ||
    compact === "credentialprofilename" ||
    compact === "tokencount" ||
    compact === "publickey" ||
    compact === "monkey"
  ) {
    return false;
  }
  return (
    compact.includes("credential") ||
    compact.includes("password") ||
    compact.includes("passwd") ||
    compact === "pwd" ||
    compact.endsWith("pwd") ||
    compact.includes("authorization") ||
    compact.includes("apikey") ||
    compact.includes("privatekey") ||
    compact.endsWith("secret") ||
    compact.endsWith("secretref") ||
    compact === "token" ||
    compact.startsWith("token") ||
    compact.endsWith("token") ||
    compact.includes("cookie")
  );
}

function normalizedObjectKey(key: string): string {
  const redacted = redactPublicText(key) || "[empty]";
  return UNSAFE_KEYS.has(redacted) ? `[${JSON.stringify(redacted)}]` : redacted;
}

function collisionSafeKey(target: object, key: string): string {
  const base = normalizedObjectKey(key);
  let candidate = base;
  let suffix = 2;
  while (Object.hasOwn(target, candidate)) {
    const suffixText = `#${suffix}`;
    candidate = `${base.slice(0, MAX_PUBLIC_ATOM_LENGTH - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

interface ProjectedCliIssue {
  path: string;
  message: string;
}

function issuePath(value: unknown): { path: string; sensitive: boolean } {
  const segments = boundedArrayValues(value);
  if (!segments || segments.length === 0) return { path: "$", sensitive: false };
  let path = "";
  for (const segment of segments) {
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      path += `[${segment}]`;
      continue;
    }
    if (typeof segment !== "string") return { path: "$", sensitive: false };
    const safeSegment = redactPublicText(segment);
    if (sensitiveKey(segment) || safeSegment !== segment) {
      return { path: "[redacted]", sensitive: true };
    }
    if (SIMPLE_PATH_SEGMENT.test(safeSegment) && !UNSAFE_KEYS.has(safeSegment)) {
      path += path ? `.${safeSegment}` : safeSegment;
    } else {
      path += `[${JSON.stringify(safeSegment)}]`;
    }
  }
  return {
    path:
      path.length > MAX_PUBLIC_ATOM_LENGTH
        ? redactPublicText(path, MAX_PUBLIC_ATOM_LENGTH)
        : path || "$",
    sensitive: false,
  };
}

function projectedIssues(source: unknown, budget: ProjectionBudget): ProjectedCliIssue[] {
  const candidates = boundedArrayValues(readField(source, "issues"));
  if (!candidates) return [];
  const issues: ProjectedCliIssue[] = [];
  for (const candidate of candidates) {
    const message = readField(candidate, "message");
    if (typeof message !== "string" || message.length === 0) continue;
    const projectedPath = issuePath(readField(candidate, "path"));
    issues.push({
      path: projectedPath.path,
      message: projectedPath.sensitive
        ? "[redacted]"
        : budgetedPublicText(message, budget, MAX_PUBLIC_TEXT_LENGTH),
    });
  }
  return issues;
}

function addFieldError(out: Record<string, string[]>, field: string, message: string): void {
  const existing = out[field];
  if (existing) {
    if (!existing.includes(message)) existing.push(message);
    return;
  }
  out[collisionSafeKey(out, field)] = [message];
}

function fieldErrors(
  value: unknown,
  issues: readonly ProjectedCliIssue[],
  budget: ProjectionBudget,
): Record<string, string[]> {
  const out = Object.create(null) as Record<string, string[]>;
  let keys: string[] = [];
  if (value && typeof value === "object" && !arrayOf(value)) {
    try {
      keys = Object.keys(value);
    } catch {
      keys = [];
    }
  }
  for (const key of keys.slice(0, MAX_CONTEXT_ENTRIES)) {
    const messages = sensitiveKey(key) ? undefined : readField(value, key);
    const safe = sensitiveKey(key) ? ["[redacted]"] : stringList(messages, budget);
    if (safe.length > 0) out[collisionSafeKey(out, key)] = safe;
  }
  for (const issue of issues) addFieldError(out, issue.path, issue.message);
  return out;
}

function jsonSafe(
  value: unknown,
  seen: WeakSet<object>,
  budget: ProjectionBudget,
  depth = 0,
): string | number | boolean | null | unknown[] | Record<string, unknown> {
  if (budget.nodes <= 0) return "[Truncated]";
  budget.nodes -= 1;
  if (value === null) return null;
  if (typeof value === "string") return budgetedPublicText(value, budget);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return budgetedPublicText(value.toString(), budget);
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol")
    return null;
  if (depth >= MAX_CONTEXT_DEPTH) return "[Truncated]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    const array = boundedArrayValues(value);
    if (array) {
      return array.map((entry) => jsonSafe(entry, seen, budget, depth + 1));
    }
    const out = Object.create(null) as Record<string, unknown>;
    let keys: string[] = [];
    try {
      keys = Object.keys(value);
    } catch {
      return { value: "[Unserializable]" };
    }
    for (const key of keys.slice(0, MAX_CONTEXT_ENTRIES)) {
      out[collisionSafeKey(out, key)] = sensitiveKey(key)
        ? "[redacted]"
        : jsonSafe(readField(value, key), seen, budget, depth + 1);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function safeContext(value: unknown, budget: ProjectionBudget): Record<string, unknown> {
  const safe = jsonSafe(value, new WeakSet(), budget);
  return safe && typeof safe === "object" && !arrayOf(safe)
    ? (safe as Record<string, unknown>)
    : {};
}

function mergeSafeContexts(
  budget: ProjectionBudget,
  ...values: unknown[]
): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const value of values) {
    for (const [key, child] of Object.entries(safeContext(value, budget))) {
      result[collisionSafeKey(result, key)] = child;
    }
  }
  return result;
}

function hasTypedProblemFields(source: unknown, status?: number): boolean {
  return (
    status !== undefined ||
    typeof readField(source, "retryable") === "boolean" ||
    readField(source, "fieldErrors") !== undefined ||
    readField(source, "requiredActions") !== undefined ||
    readField(source, "evidenceRefs") !== undefined ||
    readField(source, "context") !== undefined ||
    readField(source, "cliCategory") !== undefined
  );
}

function systemContext(source: unknown): Record<string, unknown> {
  const code = readField(source, "code");
  const syscall = readField(source, "syscall");
  const path = readField(source, "path");
  return {
    ...(typeof code === "string" ? { systemCode: code } : {}),
    ...(typeof syscall === "string" ? { syscall } : {}),
    ...(typeof path === "string" ? { path } : {}),
  };
}

function categoryFallbackCode(category: CliFailureCategory): string {
  return category === "usage" || category === "validation"
    ? "invalid_argument"
    : category === "operational"
      ? "operational_failure"
      : "unexpected_error";
}

function publicCode(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return redactPublicText(value) === value ? value : fallback;
}

function isRawSystemCode(source: unknown, code: unknown): boolean {
  if (
    typeof readField(source, "syscall") === "string" ||
    readField(source, "errno") !== undefined
  ) {
    return true;
  }
  return typeof code === "string" && (/^E[A-Z0-9]+$/.test(code) || /^ERR_[A-Z0-9_]+$/.test(code));
}

/** Pure, daemon-free projection used by every CLI failure output path. */
export function projectCliFailure(
  source: unknown,
  options: CliFailureOptions = {},
): CliFailureEnvelope {
  const budget = projectionBudget();
  const sourceStatus = finiteStatus(readField(source, "status"));
  const status = sourceStatus ?? finiteStatus(options.status);
  const category = categoryFrom(source, options, status);
  const issues = projectedIssues(source, budget);
  const rawMessage =
    issues[0]?.message ??
    safeText(readField(source, "message") ?? source, "unexpected CLI failure", budget);
  const message =
    options.prefix && !rawMessage.startsWith(options.prefix)
      ? `${options.prefix}${rawMessage}`
      : rawMessage;
  const sourceCode = readField(source, "code");
  const rawSystemCode = isRawSystemCode(source, sourceCode);
  const typedProblem = hasTypedProblemFields(source, sourceStatus);
  const categoryFallback = categoryFallbackCode(category);
  const fallbackCode = publicCode(options.fallbackCode, categoryFallback);
  const code =
    typedProblem && !rawSystemCode && typeof sourceCode === "string" && sourceCode.length > 0
      ? publicCode(sourceCode, fallbackCode)
      : fallbackCode;
  const context = mergeSafeContexts(
    budget,
    typedProblem && !rawSystemCode ? {} : systemContext(source),
    readField(source, "context"),
    options.context,
  );
  return {
    ok: false,
    exitCode: EXIT_CODE[category],
    code,
    message,
    error: message,
    retryable: readField(source, "retryable") === true,
    fieldErrors: fieldErrors(readField(source, "fieldErrors"), issues, budget),
    requiredActions: stringList(readField(source, "requiredActions"), budget),
    evidenceRefs: stringList(readField(source, "evidenceRefs"), budget),
    context,
    ...(status !== undefined ? { status } : {}),
  };
}

/** Carry a projected problem across an async boundary without losing its category or safe fields. */
export function cliFailureError(source: unknown, options: CliFailureOptions): Error {
  const failure = projectCliFailure(source, options);
  return Object.assign(new Error(failure.message), {
    code: failure.code,
    retryable: failure.retryable,
    fieldErrors: failure.fieldErrors,
    requiredActions: failure.requiredActions,
    evidenceRefs: failure.evidenceRefs,
    context: failure.context,
    cliCategory:
      options.category ??
      (failure.exitCode === 2 ? ("validation" as const) : ("operational" as const)),
    ...(failure.status !== undefined ? { status: failure.status } : {}),
  });
}
