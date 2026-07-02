import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userConfigDir } from "@claudexor/util";

export function daemonDir(): string {
  return join(userConfigDir(), "daemon");
}

export function defaultSocketPath(): string {
  return process.env.CLAUDEXOR_DAEMON_SOCK || join(daemonDir(), "claudexord.sock");
}

export function logPath(): string {
  return join(daemonDir(), "claudexord.log");
}

/** Read or generate a per-user local auth token (0600). */
export function ensureToken(): string {
  const dir = daemonDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* generate below */
  }
  const token = randomUUID();
  writeFileSync(path, token + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
  return token;
}

export function readToken(): string | null {
  try {
    const t = readFileSync(join(daemonDir(), "token"), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

/** Rotate the local auth token (T5#23): a fresh random token replaces the
 * old one (0600). Existing daemon sessions keep their in-memory token, so
 * rotation takes effect on the next daemon start — the CLI surface says so. */
export function rotateToken(): string {
  const dir = daemonDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "token");
  const token = randomUUID();
  writeFileSync(path, token + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
  return token;
}
