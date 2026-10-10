import { sensitiveResourcePolicy } from "./sensitive-resource.js";

const MAX_ACTIONS = 16;
const MAX_ACTION_CHARS = 512;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_CONTEXT_KEYS = 32;
const MAX_CONTEXT_ARRAY = 32;
const MAX_CONTEXT_DEPTH = 3;
const MAX_CONTEXT_STRING = 2_000;
const MAX_CONTEXT_KEY = 128;
const MAX_CONTEXT_NODES = 128;
const MAX_CONTEXT_CHARS = 8_192;

function boundedString(value: string, limit: number): string {
  const safe = sensitiveResourcePolicy.redact(value);
  if (safe.length <= limit) return safe;
  let prefixLength = limit;
  let suffix = "";
  for (let round = 0; round < 3; round += 1) {
    suffix = `… (truncated ${safe.length - prefixLength} chars)`;
    prefixLength = Math.max(0, limit - suffix.length);
  }
  return `${safe.slice(0, prefixLength)}${suffix}`.slice(0, limit);
}

/** One safe problem message for both durable state and wire projections. */
export function safeProblemMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return boundedString(message || "unknown error", MAX_MESSAGE_CHARS);
}

/** Redact and bound recovery actions before they enter durable or wire state. */
export function safeProblemRequiredActions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, MAX_ACTIONS)
    .map((item) => boundedString(item, MAX_ACTION_CHARS));
}

interface ContextBudget {
  nodes: number;
  chars: number;
}

function budgetedString(value: string, limit: number, budget: ContextBudget): string {
  if (budget.chars <= 0) return "";
  const bounded = boundedString(value, limit);
  const output = bounded.slice(0, budget.chars);
  budget.chars -= output.length;
  return output;
}

function safeContextValue(value: unknown, depth: number, budget: ContextBudget): unknown {
  if (budget.nodes <= 0) return null;
  budget.nodes -= 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return budgetedString(value, MAX_CONTEXT_STRING, budget);
  if (depth >= MAX_CONTEXT_DEPTH) return budgetedString("[bounded]", 9, budget);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, MAX_CONTEXT_ARRAY)) {
      if (budget.nodes <= 0 || budget.chars <= 0) break;
      out.push(safeContextValue(item, depth + 1, budget));
    }
    return out;
  }
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_CONTEXT_KEYS);
  const out: Record<string, unknown> = {};
  for (const [key, child] of entries) {
    if (budget.nodes <= 0 || budget.chars <= 0) break;
    const safeKey = budgetedString(key, MAX_CONTEXT_KEY, budget);
    if (!safeKey) break;
    out[safeKey] = safeContextValue(child, depth + 1, budget);
  }
  return out;
}

/** Recovery context is typed but still crosses persistence and UI boundaries;
 * keep its shape while bounding size/depth and redacting every string leaf. */
export function safeProblemContext(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return safeContextValue(value, 0, {
    nodes: MAX_CONTEXT_NODES,
    chars: MAX_CONTEXT_CHARS,
  }) as Record<string, unknown>;
}
