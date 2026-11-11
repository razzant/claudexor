import type { ChildStdin } from "@claudexor/core";
import { harnessBinaryIdentity, harnessBinaryIdentityOnPath, spawnProcess } from "@claudexor/core";
import { ensureDir, noProjectRepoRoot } from "@claudexor/util";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveClaudeBin } from "./effort-probe.js";

/** Claude Code refreshes OAuth access tokens inside this five-minute window. */
export const CLAUDE_OAUTH_REFRESH_SKEW_MS = 5 * 60_000;
const REFRESH_WAKE_TIMEOUT_MS = 20_000;
const REFRESH_WAKE_POLL_MS = 250;
const REFRESH_WAKE_SHUTDOWN_GRACE_MS = 500;
export const CLAUDE_AUTH_REFRESH_TERMINATION_UNCONFIRMED =
  "claude_oauth_refresh_termination_unconfirmed";

export function claudeOauthAccessTokenIsFresh(
  expiresAtMs: number | null,
  nowMs: number = Date.now(),
): boolean {
  return (
    expiresAtMs !== null &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > nowMs + CLAUDE_OAUTH_REFRESH_SKEW_MS
  );
}

export interface ClaudeNativeAuthRefreshDeps {
  spawn: typeof spawnProcess;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  bin: string;
  cwd: string;
  timeoutMs: number;
  pollMs: number;
  diagnostic: (record: {
    binary: ReturnType<typeof harnessBinaryIdentity>;
    expiresAtMs: number | null;
    exitCode: number | null;
    signal: string | null;
    terminationUnconfirmed: boolean;
    childFailed: boolean;
  }) => void;
}

/**
 * Wake Claude Code's own OAuth refresher without sending a prompt or making a
 * model request. `mcp serve` is the vendor's documented, long-lived stdio
 * command: holding stdin open gives its startup refresh time to finish under
 * Claude Code's credential lock. Claudexor observes expiry metadata only;
 * Claude Code remains the sole reader/writer of the refresh token and store.
 */
export async function refreshClaudeNativeAuth(
  env: Record<string, string | null | undefined>,
  readExpiresAtMs: () => Promise<number | null>,
  overrides: Partial<ClaudeNativeAuthRefreshDeps> = {},
): Promise<boolean> {
  const spawn = overrides.spawn ?? spawnProcess;
  const nowMs = overrides.nowMs ?? Date.now;
  const wait = overrides.sleep ?? ((ms: number) => sleep(ms));
  const bin = overrides.bin ?? resolveClaudeBin();
  const cwd = overrides.cwd ?? noProjectRepoRoot();
  const timeoutMs = overrides.timeoutMs ?? REFRESH_WAKE_TIMEOUT_MS;
  const pollMs = overrides.pollMs ?? REFRESH_WAKE_POLL_MS;
  ensureDir(cwd);

  const controller = new AbortController();
  let stdin: ChildStdin | null = null;
  let childExited = false;
  let terminationUnconfirmed = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let childFailed = false;
  let expiresAtMs: number | null = null;
  const binary = !overrides.diagnostic
    ? null
    : typeof env.PATH === "string"
      ? harnessBinaryIdentityOnPath(bin, env.PATH)
      : harnessBinaryIdentity(bin);
  const child = (async () => {
    try {
      for await (const event of spawn(bin, ["--setting-sources", "", "mcp", "serve"], {
        cwd,
        env: {
          ...env,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
        },
        keepStdinOpen: true,
        onSpawn: (io) => {
          stdin = io;
        },
        abortSignal: controller.signal,
        timeoutMs,
        cancelSignal: "SIGTERM",
        cancelKillDelayMs: 1_000,
      })) {
        if (event.type === "termination_unconfirmed") terminationUnconfirmed = true;
        if (event.type === "exit") {
          exitCode = event.code;
          exitSignal = event.signal;
        }
        if (event.type === "exit" || event.type === "termination_unconfirmed") childExited = true;
      }
    } catch {
      childExited = true;
      childFailed = true;
    }
  })();

  try {
    const deadline = nowMs() + timeoutMs;
    for (;;) {
      expiresAtMs = await readExpiresAtMs();
      if (claudeOauthAccessTokenIsFresh(expiresAtMs, nowMs())) return true;
      if (childExited || nowMs() >= deadline) return false;
      await wait(pollMs);
    }
  } finally {
    const activeStdin = stdin as ChildStdin | null;
    let closedAfterEof = childExited;
    if (activeStdin && !childExited) {
      activeStdin.end();
      closedAfterEof = await Promise.race([
        activeStdin.closed.then(() => true),
        wait(REFRESH_WAKE_SHUTDOWN_GRACE_MS).then(() => false),
      ]);
    }
    if (!closedAfterEof && !childExited) controller.abort();
    await child;
    try {
      overrides.diagnostic?.({
        binary,
        expiresAtMs,
        exitCode,
        signal: exitSignal,
        terminationUnconfirmed,
        childFailed,
      });
    } catch {
      // Diagnostic I/O cannot change the native helper's result or custody.
    }
    if (terminationUnconfirmed) {
      throw Object.assign(
        new Error("Claude Code OAuth refresh helper termination could not be confirmed"),
        { code: CLAUDE_AUTH_REFRESH_TERMINATION_UNCONFIRMED },
      );
    }
  }
}
