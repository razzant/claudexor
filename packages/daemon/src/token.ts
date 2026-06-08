import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userConfigDir } from "@claudex/util";

export function daemonDir(): string {
  return join(userConfigDir(), "daemon");
}

export function defaultSocketPath(): string {
  return process.env.CLAUDEX_DAEMON_SOCK || join(daemonDir(), "claudexd.sock");
}

export function logPath(): string {
  return join(daemonDir(), "claudexd.log");
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
