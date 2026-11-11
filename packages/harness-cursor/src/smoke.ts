import { randomUUID } from "node:crypto";
import { CURSOR_PROGRAM } from "./program.js";
/**
 * Isolated Cursor API-key smoke: prove a key actually serves a turn inside a
 * scrubbed throwaway HOME before the route ladder may prefer it. Split from
 * index.ts (the complexity ratchet's smaller-owner rule), mirroring the
 * harness-codex/harness-claude `smoke.ts` siblings.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeHarnessProgram, providerScrubEnv, runCapture } from "@claudexor/core";
import { redactSecrets } from "@claudexor/util";
import { resolveCursorBin } from "./bin.js";

export type CursorApiSmokeResult = { ok: boolean; detail: string };

/** The route did not need (or could not run) the isolated key smoke. */
export const unsmokedApiSmoke = (key: string | null): CursorApiSmokeResult => ({
  ok: false,
  detail: key ? "Cursor API-key smoke not required for selected route" : "no Cursor API key",
});

export type CursorApiSmokeOptions = {
  makeBaseDir?: () => string;
  runCapture?: typeof runCapture;
  cleanupBase?: typeof cleanupCursorSmokeBase;
};

export function cursorApiSmokeFinalText(stdout: string): string | null {
  const replies: string[] = [];
  for (const rawLine of stdout.replaceAll("\r", "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const record = obj as Record<string, unknown>;
    if (record["type"] === "assistant") {
      const message = record["message"];
      const content =
        message && typeof message === "object"
          ? (message as Record<string, unknown>)["content"]
          : undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const text = (block as Record<string, unknown>)["text"];
        if (typeof text === "string" && text.trim()) replies.push(text);
      }
    } else if (record["type"] === "result") {
      const result = record["result"];
      if (typeof result === "string" && result.trim()) replies.push(result);
    }
  }
  return replies.at(-1)?.trim() ?? null;
}

export function cursorApiSmokeUsedEnvKey(stdout: string): boolean {
  for (const rawLine of stdout.replaceAll("\r", "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const record = obj as Record<string, unknown>;
    if (record["type"] === "system" && record["apiKeySource"] === "env") return true;
  }
  return false;
}

export function cursorApiSmokePassed(code: number | null, stdout: string): boolean {
  return code === 0 && cursorApiSmokeUsedEnvKey(stdout) && cursorApiSmokeFinalText(stdout) === "OK";
}

export async function cleanupCursorSmokeBase(
  base: string,
  opts: {
    remove?: (path: string) => void;
    sleepMs?: (ms: number) => Promise<void>;
    retries?: number;
  } = {},
): Promise<void> {
  const remove = opts.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const sleepMs =
    opts.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    try {
      remove(base);
      return;
    } catch {
      if (attempt >= retries) return;
      await sleepMs(25 * (attempt + 1));
    }
  }
}

// (bridgeMacLoginKeychain retired — owner decision D-U3: the host Keychain is
// never read, probed, or bridged; native cursor sessions live only in
// account-row file stores.)

export async function smokeIsolatedApiKey(
  key: string | null,
  options: CursorApiSmokeOptions = {},
): Promise<CursorApiSmokeResult> {
  if (!key) return { ok: false, detail: "no Cursor API key" };
  const base = options.makeBaseDir?.() ?? mkdtempSync(join(tmpdir(), "claudexor-cursor-smoke-"));
  const home = join(base, "home");
  try {
    mkdirSync(join(home, ".config"), { recursive: true, mode: 0o700 });
    // No Keychain bridge (D-U3): the key smoke proves the API route with the
    // key alone — bridging the host Keychain could silently authenticate the
    // smoke with the HOST login instead of the key under test.
    const env: Record<string, string | null> = {
      ...providerScrubEnv(),
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CURSOR_API_KEY: key,
    };
    const r = await (options.runCapture ?? runCapture)(
      resolveCursorBin(),
      [
        ...(CURSOR_PROGRAM.childUpdateArgs ?? []),
        "-p",
        "--output-format",
        "stream-json",
        "--mode",
        "plan",
        "--trust",
        "Reply exactly OK",
      ],
      {
        env,
        timeoutMs: 45_000,
      },
    );
    const text = `${r.stdout}\n${r.stderr}`;
    if (cursorApiSmokePassed(r.code, r.stdout))
      return { ok: true, detail: "isolated cursor-agent API-key smoke passed" };
    return {
      ok: false,
      detail: `isolated cursor-agent API-key smoke failed (exit ${r.code ?? "signal"}): ${redactSecrets(text).trim().split("\n").slice(-3).join(" ").slice(0, 500)}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `isolated cursor-agent API-key smoke failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
    };
  } finally {
    await (options.cleanupBase ?? cleanupCursorSmokeBase)(base);
  }
}

export type CursorApiSmokeDeps = {
  smokeIsolatedApiKey: typeof smokeIsolatedApiKey;
  apiSmokeCache: Map<string, { result: CursorApiSmokeResult; expiresAtMs: number }>;
  apiSmokeCacheTtlMs: number;
  apiSmokeFailureCacheTtlMs: number;
  nowMs: () => number;
};

// Credentials stay private in memory; cache keys contain independent random ids,
// never a digest of secret bytes. Each credential retains its own TTL entry.
const smokeBindings = new WeakMap<CursorApiSmokeDeps["apiSmokeCache"], Map<string, string>>();
function smokeBinding(cache: CursorApiSmokeDeps["apiSmokeCache"], credential: string): string {
  let bindings = smokeBindings.get(cache);
  if (!bindings) smokeBindings.set(cache, (bindings = new Map()));
  let id = bindings.get(credential);
  if (!id) bindings.set(credential, (id = randomUUID()));
  return id;
}

export async function smokeCursorApiKey(
  deps: CursorApiSmokeDeps,
  key: string,
  fresh = false,
): Promise<CursorApiSmokeResult> {
  const binding = smokeBinding(deps.apiSmokeCache, key);
  const program = await observeHarnessProgram(CURSOR_PROGRAM, undefined, undefined, { fresh });
  const cacheKey = JSON.stringify([binding, program.key]);
  const now = deps.nowMs();
  const cached = fresh ? undefined : deps.apiSmokeCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now) return cached.result;
  if (cached) deps.apiSmokeCache.delete(cacheKey);
  const result = await deps.smokeIsolatedApiKey(key);
  const ttlMs = result.ok ? deps.apiSmokeCacheTtlMs : deps.apiSmokeFailureCacheTtlMs;
  if (!fresh && ttlMs > 0) deps.apiSmokeCache.set(cacheKey, { result, expiresAtMs: now + ttlMs });
  return result;
}
