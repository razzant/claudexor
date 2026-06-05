import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Generate a short unique id, optionally prefixed (e.g. "run-3f2a...."). */
export function newId(prefix = ""): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return prefix ? `${prefix}-${id}` : id;
}

/** Current time as an ISO-8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** sha256 of a string, returned as "sha256:<hex>". */
export function sha256(data: string): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

/** Deterministic hash of a JSON-serializable value (stable key ordering). */
export function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

/** JSON.stringify with sorted object keys for stable hashing. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeText(path: string, text: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, text, "utf8");
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2) + "\n");
}

export function appendLine(path: string, line: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, line.endsWith("\n") ? line : line + "\n", { flag: "a" });
}

export function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function readJsonSafe<T = unknown>(path: string): T | null {
  const text = readTextSafe(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

export function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

/**
 * Best-effort redaction of obvious secret tokens from text destined for logs or
 * artifacts. This is defense-in-depth, never the primary control: secrets must
 * not reach this layer in the first place.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}
