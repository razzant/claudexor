export { CLAUDEXOR_VERSION } from "./version.js";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

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
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function writeText(path: string, text: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2) + "\n");
}

export function appendLine(path: string, line: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, line.endsWith("\n") ? line : line + "\n", { flag: "a", mode: 0o600 });
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

function usableAbsoluteDir(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || value === "/" || value === "." || value === "~" || !isAbsolute(value)) return null;
  return value.replace(/\/+$/, "");
}

/**
 * Best-effort per-user home for GUI-launched daemons. macOS launch contexts can
 * have a sparse environment; never let a missing/invalid home collapse storage
 * to `/.claudexor`.
 */
export function userHomeDir(): string {
  const home =
    usableAbsoluteDir(process.env.HOME) ??
    usableAbsoluteDir(process.env.USERPROFILE) ??
    usableAbsoluteDir(homedir());
  if (!home) {
    throw new Error("Unable to resolve a safe user home directory; set HOME or CLAUDEXOR_CONFIG_DIR");
  }
  return home;
}

export function userConfigDir(): string {
  const override = process.env.CLAUDEXOR_CONFIG_DIR?.trim();
  if (override) {
    const safe = usableAbsoluteDir(override);
    if (!safe) throw new Error("CLAUDEXOR_CONFIG_DIR must be a safe absolute path");
    return safe;
  }
  return join(userHomeDir(), ".claudexor");
}

export function noProjectRepoRoot(): string {
  return join(userHomeDir(), ".cache", "claudexor", "no-project");
}

const SECRET_PATTERNS: RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  /\bghs_[A-Za-z0-9]{20,}\b/g,
  /\bghu_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-or-v1-[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\bxai-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Cursor API keys (key_<hex>); OpenRouter keys (sk-or-v1-... handled above).
  /\bkey_[A-Za-z0-9]{20,}\b/g,
  // Bearer tokens (length-gated to avoid redacting prose like "Bearer of news").
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  // JWTs (header.payload.signature) — anthropic/cursor/openai OAuth tokens.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g,
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

export function containsSecretLikeToken(text: string): boolean {
  return redactSecrets(text) !== text;
}

export function assertNoInlineSecretValues(value: unknown, path = "$", context = "run params"): void {
  if (typeof value === "string") {
    if (containsSecretLikeToken(value)) {
      // Prompts get a tailored remediation: they are DURABLE run artifacts
      // (task contracts, transcripts, review packets), so a pasted live
      // credential would outlive the run. There is deliberately NO bypass
      // flag for this fence.
      const inPrompt = /\.prompt(\[|\.|$)/.test(path);
      const remediation = inPrompt
        ? "the prompt contains a secret-like value; prompts are durable run artifacts — remove the credential (store it with `claudexor secrets set` and reference it instead) and retry"
        : "store values via secrets and pass refs/profiles";
      throw Object.assign(new Error(`secret-like value is not accepted in ${context} (${path}); ${remediation}`), {
        status: 400,
        code: "inline_secret_rejected",
      });
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoInlineSecretValues(v, `${path}[${i}]`, context));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "env" || key === "secrets" || /(^|[_-])(secret|token|password|api[_-]?key)($|[_-])/i.test(key)) {
      throw Object.assign(
        new Error(`inline secrets/env are not accepted in ${context} (${path}.${key}); store values via secrets and pass refs/profiles`),
        { status: 400, code: "inline_secret_rejected" },
      );
    }
    assertNoInlineSecretValues(child, `${path}.${key}`, context);
  }
}

/** The machine-readable `code` a typed error carries (e.g. inline_secret_rejected), if any. */
export function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return undefined;
}

/**
 * Invoke an optional observer callback without letting its errors affect the
 * caller. Observers (GUI/service event sinks, run-start hooks) are untrusted:
 * a throwing observer must never change canonical run state or terminal status.
 */
export function safeInvoke<T>(fn: ((arg: T) => void) | undefined, arg: T): void {
  if (!fn) return;
  try {
    fn(arg);
  } catch {
    /* observer errors are isolated from control-plane state */
  }
}
