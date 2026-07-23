import { ControlProblem, type ControlProblem as ControlProblemBody } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RESERVED_CONTEXT_KEYS = new Set([
  "name",
  "message",
  "stack",
  "cause",
  "code",
  "retryable",
  "issues",
  "fieldErrors",
  "requiredActions",
  "evidenceRefs",
  "context",
]);
const SIMPLE_PATH_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ALWAYS_SENSITIVE_KEY_WORDS = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "authorization",
  "cookie",
]);
const MAX_DEPTH = 5;
const MAX_ENTRIES = 50;
const MAX_PUBLIC_ATOM_LENGTH = 256;
const MAX_TRAVERSAL_NODES = 250;
const MAX_TRAVERSAL_OUTPUT = 16 * 1024;
const REDACTED = "[redacted]";
const TRUNCATED = "[Truncated]";
const CIRCULAR = "[Circular]";

interface ProblemIssue {
  path: string;
  message: string;
}

interface TraversalState {
  nodes: number;
  output: number;
  exhausted: boolean;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  try {
    return Array.isArray(value) ? null : (value as Record<string, unknown>);
  } catch {
    return null;
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
    length = Math.min(array.length, MAX_ENTRIES);
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

function field(source: unknown, key: string): unknown {
  const record = recordOf(source);
  if (!record) return undefined;
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function keysOf(value: unknown): string[] {
  const record = recordOf(value);
  if (!record) return [];
  try {
    return Object.keys(record).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function statusOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : undefined;
}

function strings(value: unknown): string[] {
  const array = boundedArrayValues(value);
  if (!array) return [];
  const result: string[] = [];
  for (const entry of array) {
    if (typeof entry === "string" && entry.length > 0) result.push(redactPublicAtom(entry));
  }
  return result;
}

function redactPublicAtom(value: string): string {
  if (value.length > MAX_PUBLIC_ATOM_LENGTH) return REDACTED;
  const safe = redactSecrets(value);
  for (let offset = 0; offset < safe.length; offset += 1) {
    const fragment = ` ${safe.slice(offset)} `;
    if (redactSecrets(fragment) !== fragment) return REDACTED;
  }
  return safe;
}

function sensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const compact = words.join("");
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
  if (words.some((word) => ALWAYS_SENSITIVE_KEY_WORDS.has(word))) return true;
  if (
    compact.includes("credential") ||
    compact.includes("password") ||
    compact.includes("passwd") ||
    compact.endsWith("pwd") ||
    compact.includes("secret") ||
    compact.includes("token") ||
    compact.includes("authorization") ||
    compact.includes("cookie") ||
    compact.includes("apikey") ||
    compact.includes("privatekey")
  ) {
    return true;
  }
  const last = words.at(-1);
  const previous = words.at(-2);
  return last === "key" && (previous === "api" || previous === "private");
}

function normalizedObjectKey(key: string): string {
  const redacted = redactPublicAtom(key) || "[empty]";
  return UNSAFE_KEYS.has(redacted) ? `[${JSON.stringify(redacted)}]` : redacted;
}

function collisionSafeKey(target: object, key: string): string {
  const base = normalizedObjectKey(key);
  let candidate = base;
  let suffix = 2;
  while (Object.hasOwn(target, candidate)) {
    const ending = `#${suffix}`;
    candidate = `${base.slice(0, MAX_PUBLIC_ATOM_LENGTH - ending.length)}${ending}`;
    suffix += 1;
  }
  return candidate;
}

function issuePath(value: unknown): { path: string; sensitive: boolean } {
  const segments = boundedArrayValues(value);
  if (!segments || segments.length === 0) return { path: "$", sensitive: false };
  let path = "";
  let containsSensitiveKey = false;
  for (const segment of segments) {
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      path += `[${segment}]`;
      continue;
    }
    if (typeof segment !== "string") return { path: "$", sensitive: false };
    containsSensitiveKey ||= sensitiveKey(segment);
    const safeSegment = redactPublicAtom(segment);
    containsSensitiveKey ||= safeSegment !== segment;
    if (SIMPLE_PATH_SEGMENT.test(safeSegment) && !UNSAFE_KEYS.has(safeSegment)) {
      path += path ? `.${safeSegment}` : safeSegment;
    } else {
      path += `[${JSON.stringify(safeSegment)}]`;
    }
  }
  return {
    path: redactPublicAtom(path || "$"),
    sensitive: containsSensitiveKey,
  };
}

function issuesOf(error: unknown): ProblemIssue[] {
  const value = field(error, "issues");
  const candidates = boundedArrayValues(value);
  if (!candidates) return [];
  const result: ProblemIssue[] = [];
  for (const candidate of candidates) {
    const message = field(candidate, "message");
    if (typeof message !== "string" || message.length === 0) continue;
    const issue = issuePath(field(candidate, "path"));
    result.push({
      path: issue.path,
      message: issue.sensitive ? REDACTED : redactPublicAtom(message),
    });
  }
  return result;
}

function appendFieldErrors(
  result: Record<string, string[]>,
  allocated: Map<string, string>,
  fieldName: string,
  messages: readonly string[],
): void {
  if (messages.length === 0) return;
  let outputKey = allocated.get(fieldName);
  if (!outputKey) {
    outputKey = collisionSafeKey(result, fieldName);
    allocated.set(fieldName, outputKey);
  }
  const output = result[outputKey] ?? [];
  for (const message of messages) {
    if (!output.includes(message)) output.push(message);
  }
  result[outputKey] = output;
}

function fieldErrors(value: unknown, issues: ProblemIssue[]): Record<string, string[]> {
  const result = Object.create(null) as Record<string, string[]>;
  const allocated = new Map<string, string>();
  for (const key of keysOf(value)) {
    const sensitive = sensitiveKey(key) || redactPublicAtom(key) !== key;
    appendFieldErrors(result, allocated, key, sensitive ? [REDACTED] : strings(field(value, key)));
  }
  for (const issue of issues) {
    appendFieldErrors(result, allocated, issue.path, [issue.message]);
  }
  return result;
}

function reserve(state: TraversalState, nodes: number, output: number): boolean {
  if (
    state.exhausted ||
    state.nodes + nodes > MAX_TRAVERSAL_NODES ||
    state.output + output > MAX_TRAVERSAL_OUTPUT
  ) {
    state.exhausted = true;
    return false;
  }
  state.nodes += nodes;
  state.output += output;
  return true;
}

function scalar(value: string | number | boolean | null, state: TraversalState): unknown {
  const output = JSON.stringify(value).length;
  return reserve(state, 1, output) ? value : TRUNCATED;
}

function jsonSafe(
  value: unknown,
  ancestors: WeakSet<object>,
  state: TraversalState,
  depth = 0,
): unknown {
  if (value === null || typeof value === "boolean") return scalar(value, state);
  if (typeof value === "string") return scalar(redactPublicAtom(value), state);
  if (typeof value === "number")
    return scalar(Number.isFinite(value) ? value : redactPublicAtom(String(value)), state);
  if (typeof value === "bigint") return scalar(redactPublicAtom(value.toString()), state);
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol")
    return scalar(null, state);
  if (depth >= MAX_DEPTH) return scalar(TRUNCATED, state);
  if (ancestors.has(value)) return scalar(CIRCULAR, state);
  if (!reserve(state, 1, 2)) return TRUNCATED;

  ancestors.add(value);
  try {
    const array = boundedArrayValues(value);
    if (array) {
      const result: unknown[] = [];
      for (const child of array) {
        if (!reserve(state, 0, result.length === 0 ? 0 : 1)) break;
        result.push(jsonSafe(child, ancestors, state, depth + 1));
        if (state.exhausted) break;
      }
      return result;
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keysOf(value)) {
      const outputKey = collisionSafeKey(result, key);
      const keyOutput = JSON.stringify(outputKey).length + (Object.keys(result).length ? 2 : 1);
      if (!reserve(state, 0, keyOutput)) break;
      result[outputKey] =
        sensitiveKey(key) || redactPublicAtom(key) !== key
          ? scalar(REDACTED, state)
          : jsonSafe(field(value, key), ancestors, state, depth + 1);
      if (state.exhausted) break;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function mergeContextValue(
  result: Record<string, unknown>,
  value: unknown,
  state: TraversalState,
): void {
  const context = jsonSafe(value, new WeakSet(), state);
  if (!recordOf(context)) return;
  for (const key of keysOf(context)) {
    result[collisionSafeKey(result, key)] = field(context, key);
  }
}

function contextOf(error: unknown, includeSystemCode: boolean): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  const state: TraversalState = { nodes: 0, output: 0, exhausted: false };
  if (includeSystemCode) {
    const rawCode = field(error, "code");
    if (typeof rawCode === "string" && rawCode.length > 0) {
      result["systemCode"] = redactPublicAtom(rawCode);
    }
  }
  mergeContextValue(result, field(error, "context"), state);
  for (const key of keysOf(error)) {
    if (state.exhausted || RESERVED_CONTEXT_KEYS.has(key)) continue;
    if (key === "status" && statusOf(field(error, key)) !== undefined) continue;
    if (sensitiveKey(key) || redactPublicAtom(key) !== key) continue;
    const outputKey = collisionSafeKey(result, key);
    const keyOutput = JSON.stringify(outputKey).length + (Object.keys(result).length ? 2 : 1);
    if (!reserve(state, 0, keyOutput)) break;
    result[outputKey] = jsonSafe(field(error, key), new WeakSet(), state);
  }
  return result;
}

function messageOf(error: unknown, issues: ProblemIssue[]): string {
  if (issues[0]) return issues[0].message;
  try {
    const message = field(error, "message");
    return redactPublicAtom(
      typeof message === "string"
        ? message
        : error instanceof Error
          ? error.message
          : String(error),
    );
  } catch {
    return "daemon job failed";
  }
}

function codeOf(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "daemon_job_failed";
  return redactPublicAtom(value) === value ? value : "daemon_job_failed";
}

function isRawSystemCode(error: unknown, code: unknown): boolean {
  if (typeof field(error, "syscall") === "string" || field(error, "errno") !== undefined) {
    return true;
  }
  return typeof code === "string" && (/^E[A-Z0-9]+$/.test(code) || /^ERR_[A-Z0-9_]+$/.test(code));
}

/** Preserve a runner's complete typed problem before the durable job boundary. */
export function daemonJobFailure(error: unknown): {
  problem: ControlProblemBody;
  status?: number;
} {
  const issues = issuesOf(error);
  const validationFailure = issues.length > 0;
  const status = statusOf(field(error, "status")) ?? (validationFailure ? 400 : undefined);
  const rawCode = field(error, "code");
  const rawSystemCode = isRawSystemCode(error, rawCode);
  const projectedCode = codeOf(rawCode);
  const typedCode =
    !rawSystemCode && typeof rawCode === "string" && rawCode.length > 0 && projectedCode === rawCode
      ? projectedCode
      : undefined;
  const rawRetryable = field(error, "retryable");
  return {
    problem: ControlProblem.parse({
      code: typedCode ?? (validationFailure ? "invalid_request" : "daemon_job_failed"),
      message: messageOf(error, issues),
      retryable: typeof rawRetryable === "boolean" ? rawRetryable : false,
      fieldErrors: fieldErrors(field(error, "fieldErrors"), issues),
      requiredActions: strings(field(error, "requiredActions")),
      evidenceRefs: strings(field(error, "evidenceRefs")),
      context: contextOf(error, rawSystemCode),
    }),
    ...(status !== undefined ? { status } : {}),
  };
}
