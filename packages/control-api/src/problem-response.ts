import { ControlProblem, type ControlProblem as ControlProblemBody } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";

const RESERVED_FIELDS = new Set([
  "error",
  "message",
  "name",
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
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SENSITIVE_KEY_PARTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "apikey",
  "credential",
  "cookie",
] as const;
const SIMPLE_PATH_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_PUBLIC_ATOM_LENGTH = 256;
const MAX_COLLECTION_ENTRIES = 50;
const MAX_CONTEXT_DEPTH = 20;
const MAX_CONTEXT_NODES = 250;
const MAX_CONTEXT_OUTPUT_CHARS = 16 * 1024;
const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";
const CIRCULAR = "[circular]";
const OMIT = Symbol("omit");

export type ControlProblemError = Error & {
  status: number;
  code: string;
  retryable: boolean;
  fieldErrors: Record<string, string[]>;
  requiredActions: string[];
  evidenceRefs: string[];
  context: Record<string, unknown>;
};

export interface ControlProblemDefaults {
  status: number;
  code: string | ((status: number) => string);
  retryable: boolean;
  message?: string;
}

export interface ProjectedControlProblem {
  status: number;
  body: ControlProblemBody;
}

interface ProblemIssue {
  path: string;
  message: string;
  sensitive: boolean;
}

interface PublicAtom {
  text: string;
  secret: boolean;
  truncated: boolean;
}

interface JsonTraversalState {
  ancestors: WeakSet<object>;
  nodesRemaining: number;
  outputCharsRemaining: number;
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
    length = Math.min(array.length, MAX_COLLECTION_ENTRIES);
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

function propertyOf(source: Record<string, unknown> | null, key: string): unknown {
  if (!source) return undefined;
  try {
    return source[key];
  } catch {
    return undefined;
  }
}

function keysOf(source: Record<string, unknown> | null): string[] {
  if (!source) return [];
  try {
    return Object.keys(source);
  } catch {
    return [];
  }
}

/**
 * The shared redactor deliberately uses token boundaries to avoid false
 * positives in prose. Public machine atoms need a stronger fence: a token can
 * otherwise be hidden by prepending identifier characters. Test every suffix
 * with artificial boundaries after applying the normal, minimally destructive
 * redaction.
 */
function inspectPublicAtom(value: string): PublicAtom {
  const sanitized = redactSecrets(value);
  const scanLimit = Math.min(sanitized.length, MAX_PUBLIC_ATOM_LENGTH);
  for (let offset = 0; offset < scanLimit; offset += 1) {
    const fragment = ` ${sanitized.slice(offset, offset + MAX_PUBLIC_ATOM_LENGTH)} `;
    if (redactSecrets(fragment) !== fragment) {
      return { text: REDACTED, secret: true, truncated: false };
    }
  }
  const truncated = sanitized.length > MAX_PUBLIC_ATOM_LENGTH;
  const truncationSuffix = "…[truncated]";
  const bounded = truncated
    ? `${sanitized.slice(0, MAX_PUBLIC_ATOM_LENGTH - truncationSuffix.length)}${truncationSuffix}`
    : sanitized;
  return { text: bounded, secret: sanitized !== value, truncated };
}

function safeText(value: string): string {
  return inspectPublicAtom(value).text;
}

function isSensitiveKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "");
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
    SENSITIVE_KEY_PARTS.some((part) => compact.includes(part)) ||
    compact === "pwd" ||
    compact.endsWith("pwd") ||
    compact.includes("privatekey")
  );
}

function httpStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : null;
}

function safeObjectKey(key: string): string {
  const redacted = safeText(key);
  return UNSAFE_OBJECT_KEYS.has(redacted) ? `[${JSON.stringify(redacted)}]` : redacted;
}

function collisionSafeKey(target: object, key: string): string {
  const base = safeObjectKey(key) || "$";
  let candidate = base;
  let suffix = 2;
  while (Object.hasOwn(target, candidate)) {
    const suffixText = `#${suffix}`;
    candidate = `${base.slice(0, MAX_PUBLIC_ATOM_LENGTH - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

function issuePath(value: unknown): { path: string; sensitive: boolean } {
  const segments = boundedArrayValues(value);
  if (!segments || segments.length === 0) return { path: "$", sensitive: false };
  let path = "";
  let sensitive = false;
  for (const segment of segments) {
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      path += `[${segment}]`;
      continue;
    }
    if (typeof segment !== "string") return { path: "$", sensitive: false };
    const safeSegment = safeText(segment);
    sensitive ||= isSensitiveKey(segment) || safeSegment !== segment;
    if (SIMPLE_PATH_SEGMENT.test(safeSegment) && !UNSAFE_OBJECT_KEYS.has(safeSegment)) {
      path += path.length === 0 ? safeSegment : `.${safeSegment}`;
    } else {
      path += `[${JSON.stringify(safeSegment)}]`;
    }
  }
  return {
    path: path.length > MAX_PUBLIC_ATOM_LENGTH ? TRUNCATED : path || "$",
    sensitive,
  };
}

function problemIssues(source: Record<string, unknown> | null): ProblemIssue[] {
  const value = propertyOf(source, "issues");
  const candidates = boundedArrayValues(value);
  if (!candidates) return [];
  const issues: ProblemIssue[] = [];
  for (const candidate of candidates) {
    const issue = recordOf(candidate);
    const message = propertyOf(issue, "message");
    if (typeof message !== "string" || message.length === 0) continue;
    const projectedPath = issuePath(propertyOf(issue, "path"));
    issues.push({
      path: projectedPath.path,
      message: projectedPath.sensitive ? REDACTED : safeText(message),
      sensitive: projectedPath.sensitive,
    });
  }
  return issues;
}

function addFieldError(result: Record<string, string[]>, field: string, message: string): void {
  const messages = result[field] ?? [];
  if (!messages.includes(message)) messages.push(message);
  result[field] = messages;
}

function safeFieldErrors(value: unknown, issues: ProblemIssue[]): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const source = recordOf(value);
  for (const field of keysOf(source).slice(0, MAX_COLLECTION_ENTRIES)) {
    const safeField = collisionSafeKey(result, field);
    const fieldInspection = inspectPublicAtom(field);
    if (isSensitiveKey(field) || fieldInspection.secret) {
      addFieldError(result, safeField, REDACTED);
      continue;
    }
    const messages = propertyOf(source, field);
    const messageArray = boundedArrayValues(messages);
    if (!messageArray) continue;
    for (const message of messageArray) {
      if (typeof message === "string") addFieldError(result, safeField, safeText(message));
    }
  }
  for (const issue of issues) addFieldError(result, issue.path, issue.message);
  return result;
}

function safeStringArray(value: unknown): string[] {
  const array = boundedArrayValues(value);
  if (!array) return [];
  return array
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .map(safeText);
}

function traversalState(): JsonTraversalState {
  return {
    ancestors: new WeakSet(),
    nodesRemaining: MAX_CONTEXT_NODES,
    outputCharsRemaining: MAX_CONTEXT_OUTPUT_CHARS,
  };
}

function consumeOutput(state: JsonTraversalState, value: string): boolean {
  if (value.length > state.outputCharsRemaining) {
    state.outputCharsRemaining = 0;
    return false;
  }
  state.outputCharsRemaining -= value.length;
  return true;
}

function budgetedText(state: JsonTraversalState, value: string): string {
  const safe = safeText(value);
  return consumeOutput(state, safe) ? safe : TRUNCATED;
}

function safeJsonValue(
  value: unknown,
  state: JsonTraversalState,
  depth: number,
): unknown | typeof OMIT {
  if (state.nodesRemaining <= 0 || state.outputCharsRemaining <= 0) return TRUNCATED;
  state.nodesRemaining -= 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return budgetedText(state, value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return budgetedText(state, value.toString());
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol")
    return OMIT;
  if (depth >= MAX_CONTEXT_DEPTH) return TRUNCATED;
  if (state.ancestors.has(value)) return CIRCULAR;

  state.ancestors.add(value);
  try {
    const array = boundedArrayValues(value);
    if (array) {
      const result: unknown[] = [];
      for (const item of array) {
        const safe = safeJsonValue(item, state, depth + 1);
        result.push(safe === OMIT ? null : safe);
        if (state.nodesRemaining <= 0 || state.outputCharsRemaining <= 0) break;
      }
      return result;
    }
    let isDate = false;
    try {
      isDate = value instanceof Date;
    } catch {
      return TRUNCATED;
    }
    if (isDate) {
      try {
        return budgetedText(state, (value as Date).toISOString());
      } catch {
        return "[invalid date]";
      }
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const source = recordOf(value);
    for (const key of keysOf(source).slice(0, MAX_COLLECTION_ENTRIES)) {
      const keyInspection = inspectPublicAtom(key);
      const safeKey = collisionSafeKey(result, key);
      if (!consumeOutput(state, safeKey)) break;
      if (isSensitiveKey(key) || keyInspection.secret) {
        result[safeKey] = REDACTED;
        consumeOutput(state, REDACTED);
        continue;
      }
      const safe = safeJsonValue(propertyOf(source, key), state, depth + 1);
      if (safe !== OMIT) result[safeKey] = safe;
      if (state.nodesRemaining <= 0 || state.outputCharsRemaining <= 0) break;
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function safeContext(
  source: Record<string, unknown> | null,
  systemCode?: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const state = traversalState();
  if (systemCode) {
    result["systemCode"] = budgetedText(state, systemCode);
  }
  const explicit = safeJsonValue(propertyOf(source, "context"), state, 0);
  const explicitRecord = recordOf(explicit);
  for (const key of keysOf(explicitRecord)) {
    result[key] = propertyOf(explicitRecord, key);
  }

  for (const key of keysOf(source).slice(0, MAX_COLLECTION_ENTRIES)) {
    if (RESERVED_FIELDS.has(key)) continue;
    if (key === "status" && httpStatus(propertyOf(source, key)) !== null) continue;
    const keyInspection = inspectPublicAtom(key);
    // Explicit context is caller-selected and receives placeholders. Arbitrary
    // enumerable error properties are only promoted when their key is safe.
    if (isSensitiveKey(key) || keyInspection.secret) continue;
    const safe = safeJsonValue(propertyOf(source, key), state, 0);
    if (safe !== OMIT) {
      const baseKey = safeObjectKey(key) || "$";
      let duplicate = Object.hasOwn(result, baseKey) && Object.is(result[baseKey], safe);
      if (!duplicate && Object.hasOwn(result, baseKey)) {
        try {
          duplicate = JSON.stringify(result[baseKey]) === JSON.stringify(safe);
        } catch {
          duplicate = false;
        }
      }
      if (duplicate) continue;
      const safeKey = collisionSafeKey(result, key);
      if (!consumeOutput(state, safeKey)) break;
      result[safeKey] = safe;
    }
    if (state.nodesRemaining <= 0 || state.outputCharsRemaining <= 0) break;
  }
  return result;
}

function problemMessage(
  source: Record<string, unknown> | null,
  issues: ProblemIssue[],
  fallback: string,
): string {
  if (issues[0]) return issues[0].message;
  const message = propertyOf(source, "message");
  if (typeof message === "string") return safeText(message);
  const legacyError = propertyOf(source, "error");
  return typeof legacyError === "string" ? safeText(legacyError) : safeText(fallback);
}

function safeCodeCandidate(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const inspected = inspectPublicAtom(value);
  return inspected.secret || inspected.truncated || inspected.text.length === 0
    ? null
    : inspected.text;
}

function isRawSystemCode(source: Record<string, unknown> | null, code: unknown): boolean {
  if (
    typeof propertyOf(source, "syscall") === "string" ||
    propertyOf(source, "errno") !== undefined
  ) {
    return true;
  }
  return typeof code === "string" && (/^E[A-Z0-9]+$/.test(code) || /^ERR_[A-Z0-9_]+$/.test(code));
}

function fallbackCode(
  status: number,
  defaults: Omit<ControlProblemDefaults, "status">,
  hasIssues: boolean,
): string {
  const finalFallback = hasIssues ? "invalid_request" : `http_${status}`;
  if (hasIssues) return finalFallback;
  let candidate: unknown;
  try {
    candidate = typeof defaults.code === "function" ? defaults.code(status) : defaults.code;
  } catch {
    return finalFallback;
  }
  return safeCodeCandidate(candidate) ?? finalFallback;
}

function normalizeProblemError(
  status: number,
  value: unknown,
  defaults: Omit<ControlProblemDefaults, "status">,
): ControlProblemError {
  const source = recordOf(value);
  const issues = problemIssues(source);
  const fallbackMessage =
    typeof value === "string" && value.length > 0
      ? safeText(value)
      : (defaults.message ?? `request failed with status ${status}`);
  const sourceCode = propertyOf(source, "code");
  const rawSystemCode = isRawSystemCode(source, sourceCode);
  const code =
    (rawSystemCode ? null : safeCodeCandidate(sourceCode)) ??
    fallbackCode(status, defaults, issues.length > 0);
  const sourceRetryable = propertyOf(source, "retryable");
  return Object.assign(new Error(problemMessage(source, issues, fallbackMessage)), {
    status,
    code,
    retryable:
      typeof sourceRetryable === "boolean"
        ? sourceRetryable
        : issues.length > 0
          ? false
          : defaults.retryable,
    fieldErrors: safeFieldErrors(propertyOf(source, "fieldErrors"), issues),
    requiredActions: safeStringArray(propertyOf(source, "requiredActions")),
    evidenceRefs: safeStringArray(propertyOf(source, "evidenceRefs")),
    context: safeContext(
      source,
      rawSystemCode && typeof sourceCode === "string" ? sourceCode : undefined,
    ),
  });
}

/**
 * Turn an HTTP problem body into a throwable error without losing transport
 * status or typed recovery details.
 */
export function controlProblemError(status: number, body: unknown): ControlProblemError {
  const safeStatus = httpStatus(status) ?? 500;
  return normalizeProblemError(safeStatus, body, {
    code: `http_${safeStatus}`,
    retryable: false,
  });
}

/**
 * The single error-to-wire projection used by the control API and CLI. Typed
 * status wins; structurally Zod-like validation errors default to HTTP 400.
 */
export function projectControlProblem(
  error: unknown,
  defaults: ControlProblemDefaults,
): ProjectedControlProblem {
  const source = recordOf(error);
  const issues = problemIssues(source);
  const status =
    httpStatus(propertyOf(source, "status")) ??
    (issues.length > 0 ? 400 : (httpStatus(defaults.status) ?? 500));
  const normalized = normalizeProblemError(status, error, {
    code: defaults.code,
    retryable: defaults.retryable,
    message: defaults.message,
  });
  return {
    status,
    body: ControlProblem.parse({
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      fieldErrors: normalized.fieldErrors,
      requiredActions: normalized.requiredActions,
      evidenceRefs: normalized.evidenceRefs,
      context: normalized.context,
    }),
  };
}
