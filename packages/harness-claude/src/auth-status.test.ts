import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnOptions } from "@claudexor/core";
import {
  CLAUDE_AUTH_STATUS_CACHE_TTL_MS,
  CLAUDE_AUTH_STATUS_TOTAL_TIMEOUT_MS,
  clearClaudeAuthStatusCache,
  probeClaudeAuthStatus,
} from "./auth-status.js";

function result(
  stdout: string,
  over: Partial<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> = {},
) {
  return {
    code: 0,
    signal: null,
    stdout,
    stderr: "",
    ...over,
  };
}

const options = (runCapture: Parameters<typeof probeClaudeAuthStatus>[1]["runCapture"]) => ({
  env: {},
  configDir: "/owned/profiles/work",
  runCapture,
});

describe("Claude auth-status resilience", () => {
  beforeEach(() => clearClaudeAuthStatusCache());
  afterEach(() => vi.restoreAllMocks());

  it("coalesces concurrent probes for one exact store", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const runCapture = async () => {
      calls += 1;
      await gate;
      return result('{"loggedIn":true,"authMethod":"claude.ai"}');
    };

    const first = probeClaudeAuthStatus("/bin/claude", options(runCapture));
    const second = probeClaudeAuthStatus("/bin/claude", options(runCapture));
    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { loggedIn: true, authed: true, authMethod: "claude.ai", probeError: null },
      { loggedIn: true, authed: true, authMethod: "claude.ai", probeError: null },
    ]);
  });

  it("does not coalesce different exact profile stores", async () => {
    let calls = 0;
    const runCapture = async () => {
      calls += 1;
      return result('{"loggedIn":true,"authMethod":"claude.ai"}');
    };
    const first = probeClaudeAuthStatus("/bin/claude", options(runCapture));
    const second = probeClaudeAuthStatus("/bin/claude", {
      ...options(runCapture),
      configDir: "/owned/profiles/other",
    });
    await Promise.all([first, second]);
    expect(calls).toBe(2);
  });

  it("retries once for a transport failure, then accepts a typed verdict", async () => {
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let calls = 0;
    const timeouts: number[] = [];
    const runCapture = async () => {
      calls += 1;
      clock += 100;
      return calls === 1
        ? result("", { code: null, signal: "SIGKILL" })
        : result('{"loggedIn":true,"authMethod":"claude.ai"}');
    };
    const captureWithTimeout = async (_bin: string, _args: string[], opts?: SpawnOptions) => {
      timeouts.push(opts?.timeoutMs ?? -1);
      return runCapture();
    };
    const probe = await probeClaudeAuthStatus("/bin/claude", options(captureWithTimeout));
    expect(probe).toEqual({
      loggedIn: true,
      authed: true,
      authMethod: "claude.ai",
      probeError: null,
    });
    expect(calls).toBe(2);
    expect(timeouts[0]).toBe(CLAUDE_AUTH_STATUS_TOTAL_TIMEOUT_MS);
    expect(timeouts[1]).toBeGreaterThan(0);
    expect(timeouts[1]).toBeLessThan(CLAUDE_AUTH_STATUS_TOTAL_TIMEOUT_MS);
  });

  it("does not retry or mask a parseable vendor/config error", async () => {
    let calls = 0;
    const runCapture = async () => {
      calls += 1;
      return result("", { code: 1, stderr: "Error: authentication rejected (401)" });
    };
    const probe = await probeClaudeAuthStatus("/bin/claude", options(runCapture));
    expect(calls).toBe(1);
    expect(probe.authed).toBe(false);
    expect(probe.stale).toBeUndefined();
    expect(probe.probeError).toContain("authentication rejected (401)");
  });

  it("does not accept a typed verdict flushed by a signaled child", async () => {
    let calls = 0;
    const runCapture = async () => {
      calls += 1;
      return result('{"loggedIn":true,"authMethod":"claude.ai"}', {
        code: null,
        signal: "SIGKILL",
      });
    };
    const probe = await probeClaudeAuthStatus("/bin/claude", options(runCapture));
    expect(calls).toBe(2);
    expect(probe).toMatchObject({
      loggedIn: false,
      authed: false,
      probeError: expect.stringContaining('"loggedIn":true'),
    });
    expect(probe.stale).toBeUndefined();
  });

  it("uses the bounded last-known-good verdict only after transport retry fails", async () => {
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let calls = 0;
    const runCapture = async () => {
      calls += 1;
      return calls === 1
        ? result('{"loggedIn":true,"authMethod":"claude.ai"}')
        : result("", { code: null, signal: "SIGKILL" });
    };
    await probeClaudeAuthStatus("/bin/claude", options(runCapture));
    const stale = await probeClaudeAuthStatus("/bin/claude", options(runCapture));
    expect(calls).toBe(3);
    expect(stale).toMatchObject({ loggedIn: true, authed: true, stale: true, probeError: null });
    expect(stale.staleAgeMs).toEqual(expect.any(Number));
  });

  it("expires the last-known-good grace window", async () => {
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let calls = 0;
    const runCapture = async () => {
      calls += 1;
      return calls === 1
        ? result('{"loggedIn":true,"authMethod":"claude.ai"}')
        : result("", { code: null, signal: "SIGKILL" });
    };
    await probeClaudeAuthStatus("/bin/claude", options(runCapture));
    clock += CLAUDE_AUTH_STATUS_CACHE_TTL_MS + 1;
    const expired = await probeClaudeAuthStatus("/bin/claude", options(runCapture));
    expect(expired.stale).toBeUndefined();
    expect(expired.probeError).toBeTruthy();
  });

  it("clears LKG on a clean logout, so a later transport error cannot resurrect it", async () => {
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let calls = 0;
    const runCapture = async () => {
      calls += 1;
      if (calls === 1) return result('{"loggedIn":true,"authMethod":"claude.ai"}');
      if (calls === 2) return result('{"loggedIn":false,"authMethod":"none"}', { code: 1 });
      return result("", { code: null, signal: "SIGKILL" });
    };
    await probeClaudeAuthStatus("/bin/claude", options(runCapture));
    const loggedOut = await probeClaudeAuthStatus("/bin/claude", options(runCapture));
    expect(loggedOut).toMatchObject({ loggedIn: false, authed: false, probeError: null });
    const afterLogout = await probeClaudeAuthStatus("/bin/claude", options(runCapture));
    expect(afterLogout.stale).toBeUndefined();
    expect(afterLogout.probeError).toBeTruthy();
  });

  it("does not retry an already-aborted transport probe", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const runCapture = async () => {
      calls += 1;
      return result("", { code: null, signal: "SIGTERM" });
    };
    const probe = await probeClaudeAuthStatus("/bin/claude", {
      ...options(runCapture),
      abortSignal: controller.signal,
    });
    // An already-cancelled caller must not spawn a vendor process at all.
    expect(calls).toBe(0);
    expect(probe.stale).toBeUndefined();
    expect(probe.probeError).toBeTruthy();
  });

  it("does not let the first caller's abort cancel a shared probe", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const runCapture = async () => {
      calls += 1;
      await gate;
      return result('{"loggedIn":true,"authMethod":"claude.ai"}');
    };
    const first = probeClaudeAuthStatus("/bin/claude", {
      ...options(runCapture),
      abortSignal: firstAbort.signal,
    });
    const second = probeClaudeAuthStatus("/bin/claude", {
      ...options(runCapture),
      abortSignal: secondAbort.signal,
    });
    firstAbort.abort();
    await expect(first).resolves.toMatchObject({ probeError: "claude auth status probe aborted" });
    expect(calls).toBe(1);
    release();
    await expect(second).resolves.toMatchObject({ authed: true, probeError: null });
  });

  it("does not return stale LKG to a caller that aborts during transport failure", async () => {
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let calls = 0;
    const runCapture = async () => {
      calls += 1;
      if (calls === 1) return result('{"loggedIn":true,"authMethod":"claude.ai"}');
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return result("", { code: null, signal: "SIGKILL" });
    };
    await probeClaudeAuthStatus("/bin/claude", options(runCapture));
    const controller = new AbortController();
    const aborted = probeClaudeAuthStatus("/bin/claude", {
      ...options(runCapture),
      abortSignal: controller.signal,
    });
    controller.abort();
    const probe = await aborted;
    expect(probe.stale).toBeUndefined();
    expect(probe.probeError).toBe("claude auth status probe aborted");
  });

  it("does not resurrect LKG after an explicit cache invalidation", async () => {
    let calls = 0;
    const runCapture = async () => {
      calls += 1;
      return calls === 1
        ? result('{"loggedIn":true,"authMethod":"claude.ai"}')
        : result("", { code: null, signal: "SIGTERM" });
    };
    await probeClaudeAuthStatus("/bin/claude", options(runCapture));
    clearClaudeAuthStatusCache();
    const probe = await probeClaudeAuthStatus("/bin/claude", options(runCapture));
    expect(probe.stale).toBeUndefined();
    expect(probe.probeError).toBeTruthy();
  });

  it("does not let an invalidated in-flight probe repopulate the LKG", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runCapture = async () => {
      await gate;
      return result('{"loggedIn":true,"authMethod":"claude.ai"}');
    };
    const pending = probeClaudeAuthStatus("/bin/claude", options(runCapture));
    clearClaudeAuthStatusCache();
    release();
    const invalidated = await pending;
    expect(invalidated.stale).toBeUndefined();
    expect(invalidated.probeError).toBeTruthy();
  });
});
