import { readFileSync, realpathSync } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { runCapture, type CliRunLoopOptions } from "@claudexor/core";
import {
  cleanupCursorSmokeBase,
  createCursorAdapter,
  cursorApiSmokeFinalText,
  cursorApiSmokePassed,
  cursorStatusAuthenticated,
  cursorStatusLoggedOut,
  parseCursorModelList,
  selectCursorAuthRoute,
  shouldDiscloseCursorAutoApiRoute,
  smokeIsolatedApiKey,
} from "./index.js";
import { probeCursorNativeAuth } from "./auth.js";

const PROFILE_ENV = {
  AGENT_CLI_CREDENTIAL_STORE: "file",
  CURSOR_CONFIG_DIR: "/tmp/profile/.cursor",
};

/** A capture that never answers until its abort signal fires (the probe's own
 * budget or a caller's cancel), then reports the kill the way runCapture does. */
const untilAborted =
  (killed: () => { code: number | null; signal: string | null }) =>
  (_bin: string, _argv: string[], opts: { abortSignal?: AbortSignal }) =>
    new Promise((resolve) => {
      const done = () => resolve({ ...killed(), stdout: "", stderr: "" });
      if (opts.abortSignal?.aborted) done();
      else opts.abortSignal?.addEventListener("abort", done, { once: true });
    });

const nativeProbe = (authed: boolean, probeError: string | null = null) =>
  authed
    ? ({ kind: "authenticated" } as const)
    : probeError
      ? ({ kind: "unknown", error: probeError } as const)
      : ({ kind: "loggedOut" } as const);

describe("cursor auth status parsing", () => {
  it("does not treat exit 0 Not logged in as authenticated", () => {
    expect(cursorStatusAuthenticated(0, "Not logged in\n")).toBe(false);
  });

  it("recognizes authenticated status text", () => {
    expect(cursorStatusAuthenticated(0, "Logged in as user@example.com\n")).toBe(true);
    expect(cursorStatusAuthenticated(0, "✓ Logged in as user@example.com\n")).toBe(true);
    expect(cursorStatusAuthenticated(0, "Authenticated\n")).toBe(true);
    expect(cursorStatusAuthenticated(0, "Account: user@example.com\n")).toBe(true);
  });

  it("rejects bare or explicitly empty account text and unknown exit-0 output", () => {
    expect(cursorStatusAuthenticated(0, "No account configured\n")).toBe(false);
    expect(cursorStatusAuthenticated(0, "Account: none\n")).toBe(false);
    expect(cursorStatusAuthenticated(0, "Unauthenticated account\n")).toBe(false);
    expect(cursorStatusAuthenticated(0, "Authenticated: false\n")).toBe(false);
    expect(cursorStatusAuthenticated(0, "Authenticated: no\n")).toBe(false);
    expect(cursorStatusAuthenticated(0, "Logged in: false\n")).toBe(false);
    expect(cursorStatusAuthenticated(0, "Account settings are available\n")).toBe(false);
    expect(cursorStatusAuthenticated(0, "Status OK\n")).toBe(false);
    expect(cursorStatusLoggedOut("No account configured\n")).toBe(true);
    expect(cursorStatusLoggedOut("Account: none\n")).toBe(true);
    expect(cursorStatusLoggedOut("Status OK\n")).toBe(false);
  });

  it("fails closed on non-zero status probes", () => {
    expect(cursorStatusAuthenticated(1, "Logged in as user@example.com\n")).toBe(false);
  });

  it("does not persist an account principal from unrecognized status output", async () => {
    const result = await probeCursorNativeAuth(undefined, undefined, async () => ({
      code: 0,
      signal: null,
      stdout: "Account owner private@example.com is connected\n",
      stderr: "",
    }));
    expect(result).toEqual({
      kind: "unknown",
      error: "cursor-agent status returned unrecognized output (0)",
    });
    expect(result.kind === "unknown" ? result.error : null).not.toContain("private@example.com");
  });

  it("extracts only an anchored bounded email while keeping plan absent", async () => {
    for (const stdout of [
      "Logged in as user@example.com\n",
      "✓ Logged in as user@example.com\n",
      "Account: user@example.com\n",
    ]) {
      const result = await probeCursorNativeAuth(undefined, undefined, async () => ({
        code: 0,
        signal: null,
        stdout,
        stderr: "unrelated diagnostics",
      }));
      expect(result).toEqual({ kind: "authenticated", email: "user@example.com" });
      expect(result).not.toHaveProperty("plan");
    }

    const oversized = `${"a".repeat(321)}@example.com`;
    const result = await probeCursorNativeAuth(undefined, undefined, async () => ({
      code: 0,
      signal: null,
      stdout: `Logged in as ${oversized}\n`,
      stderr: "",
    }));
    expect(result).toEqual({ kind: "authenticated" });
    expect(JSON.stringify(result)).not.toContain(oversized);
  });

  it("treats a non-zero status as unknown even when stderr says logged out", async () => {
    const result = await probeCursorNativeAuth(undefined, undefined, async () => ({
      code: 1,
      signal: null,
      stdout: "",
      stderr: "Not logged in for private@example.com",
    }));
    expect(result).toEqual({ kind: "unknown", error: "cursor-agent status failed (1)" });
    expect(JSON.stringify(result)).not.toContain("private@example.com");
  });

  it("uses the profile-scoped JSON status shape, including an explicit logged-out verdict", async () => {
    const calls: string[][] = [];
    const capture = async (_bin: string, argv: string[]) => {
      calls.push(argv);
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify({ authenticated: true, account: { email: "profile@example.com" } }),
        stderr: "",
      };
    };
    await expect(
      probeCursorNativeAuth(
        { AGENT_CLI_CREDENTIAL_STORE: "file", CURSOR_CONFIG_DIR: "/tmp/profile/.cursor" },
        undefined,
        capture as never,
      ),
    ).resolves.toEqual({ kind: "authenticated", email: "profile@example.com" });
    expect(calls).toEqual([["--disable-auto-update", "status", "--format", "json"]]);

    await expect(
      probeCursorNativeAuth(
        { AGENT_CLI_CREDENTIAL_STORE: "file", CURSOR_CONFIG_DIR: "/tmp/profile/.cursor" },
        undefined,
        async () => ({
          code: 0,
          signal: null,
          stdout: JSON.stringify({ authenticated: false }),
          stderr: "",
        }),
      ),
    ).resolves.toEqual({ kind: "loggedOut" });
  });

  it("falls back once to text status when a profile-scoped binary rejects JSON output", async () => {
    const calls: string[][] = [];
    const result = await probeCursorNativeAuth(
      { AGENT_CLI_CREDENTIAL_STORE: "file", CURSOR_CONFIG_DIR: "/tmp/profile/.cursor" },
      undefined,
      (async (_bin: string, argv: string[]) => {
        calls.push(argv);
        return argv.includes("--format")
          ? { code: 2, signal: null, stdout: "", stderr: "unknown option --format" }
          : { code: 0, signal: null, stdout: "Logged in as fallback@example.com\n", stderr: "" };
      }) as never,
    );
    expect(result).toEqual({ kind: "authenticated", email: "fallback@example.com" });
    expect(calls).toEqual([
      ["--disable-auto-update", "status", "--format", "json"],
      ["--disable-auto-update", "status"],
    ]);
  });

  it("does not turn a signalled JSON probe into authenticated text fallback", async () => {
    const calls: string[][] = [];
    const result = await probeCursorNativeAuth(
      { AGENT_CLI_CREDENTIAL_STORE: "file", CURSOR_CONFIG_DIR: "/tmp/profile/.cursor" },
      undefined,
      (async (_bin: string, argv: string[]) => {
        calls.push(argv);
        return argv.includes("--format")
          ? { code: null, signal: "SIGTERM", stdout: "", stderr: "unknown option --format" }
          : { code: 0, signal: null, stdout: "Logged in as fallback@example.com\n", stderr: "" };
      }) as never,
    );
    expect(result).toEqual({ kind: "unknown", error: "cursor-agent status failed (SIGTERM)" });
    expect(calls).toEqual([["--disable-auto-update", "status", "--format", "json"]]);
  });

  it("reports a probe killed by its OWN budget timer as an unanswered, unknown login state (#363)", async () => {
    const result = await probeCursorNativeAuth(
      PROFILE_ENV,
      undefined,
      untilAborted(() => ({ code: null, signal: "SIGKILL" })) as never,
      20,
    );
    expect(result).toEqual({
      kind: "unknown",
      error: "cursor-agent status did not answer within 0.02s (SIGKILL); login state unknown",
      timedOut: true,
    });
    // Never the logged-out verdict, which alone may carry login advice.
    expect(result.kind).not.toBe("loggedOut");
  });

  it("never reports a caller's cancellation as an unanswered probe, however long it ran (#363)", async () => {
    const caller = new AbortController();
    const pending = probeCursorNativeAuth(
      PROFILE_ENV,
      caller.signal,
      untilAborted(() => ({ code: null, signal: "SIGTERM" })) as never,
      60_000,
    );
    caller.abort();
    const result = await pending;
    expect(result).toEqual({ kind: "unknown", error: "cursor-agent status failed (SIGTERM)" });
    expect(result).not.toHaveProperty("timedOut");
  });

  it("never infers a timeout from elapsed wall time: a clock step or an outside kill is not one (#363)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const result = await probeCursorNativeAuth(PROFILE_ENV, undefined, (async () => {
        // The wall clock jumps an hour and an outside actor kills the child,
        // all long before the probe's own budget could fire.
        vi.setSystemTime(Date.now() + 60 * 60_000);
        return { code: null, signal: "SIGKILL", stdout: "", stderr: "" };
      }) as never);
      expect(result).toEqual({ kind: "unknown", error: "cursor-agent status failed (SIGKILL)" });
      expect(result).not.toHaveProperty("timedOut");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives an unsupported-JSON text fallback its own budget: only ITS timer makes a timeout (#363)", async () => {
    const run = async (fallback: "budget" | "outside") => {
      const calls: string[][] = [];
      const result = await probeCursorNativeAuth(
        PROFILE_ENV,
        undefined,
        (async (_bin: string, argv: string[], opts: { abortSignal?: AbortSignal }) => {
          calls.push(argv);
          if (argv.includes("--format")) {
            await new Promise((resolve) => setTimeout(resolve, 15)); // most of ITS budget
            return { code: 2, signal: null, stdout: "", stderr: "unknown option --format" };
          }
          if (fallback === "outside")
            return { code: null, signal: "SIGKILL", stdout: "", stderr: "" };
          return untilAborted(() => ({ code: null, signal: "SIGKILL" }))(_bin, argv, opts);
        }) as never,
        20,
      );
      expect(calls).toEqual([
        ["--disable-auto-update", "status", "--format", "json"],
        ["--disable-auto-update", "status"],
      ]);
      return result;
    };
    expect(await run("budget")).toEqual({
      kind: "unknown",
      error: "cursor-agent status did not answer within 0.02s (SIGKILL); login state unknown",
      timedOut: true,
    });
    // A retry killed from outside is no timeout, even though both children
    // together outlasted one budget.
    const outside = await run("outside");
    expect(outside).toEqual({ kind: "unknown", error: "cursor-agent status failed (2)" });
    expect(outside).not.toHaveProperty("timedOut");
  });

  it("tells the owned timeout, a caller cancel and an outside SIGKILL apart on a real child (#363)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-cursor-status-child-"));
    let childIndex = 0;
    const withReadyChild = async (
      check: (capture: typeof runCapture, pid: number) => Promise<void>,
    ) => {
      const pidFile = join(dir, `pid-${childIndex++}`);
      const cleanup = new AbortController();
      let onExit: NonNullable<Parameters<typeof runCapture>[2]>["onExit"];
      // Deliberately slower than the tested 80ms budget. Start the real child
      // first: process startup and host load are not the probe cause under test.
      const script = [
        "const fs = require('node:fs')",
        `const file = ${JSON.stringify(pidFile)}`,
        "setTimeout(() => { fs.writeFileSync(file + '.tmp', String(process.pid)); fs.renameSync(file + '.tmp', file); }, 200)",
        "setInterval(() => {}, 1000)",
      ].join(";");
      const captured = runCapture(process.execPath, ["-e", script], {
        abortSignal: cleanup.signal,
        cancelSignal: "SIGTERM",
        cancelKillDelayMs: 0,
        onExit: (code, signal) => onExit?.(code, signal),
      });
      const capture: typeof runCapture = (_bin, _args, opts) => {
        onExit = opts?.onExit;
        const abort = () => cleanup.abort();
        if (opts?.abortSignal?.aborted) abort();
        else opts?.abortSignal?.addEventListener("abort", abort, { once: true });
        return captured.finally(() => opts?.abortSignal?.removeEventListener("abort", abort));
      };
      const ready = async () => {
        // Directory notifications are hints and can be missed/coalesced. Read
        // the atomic receipt itself with a fixture-only bound before arming
        // the probe budget; expiry still enters owned-child cleanup below.
        const deadline = Date.now() + 10_000;
        while (!cleanup.signal.aborted && Date.now() < deadline) {
          const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
          if (Number.isSafeInteger(pid) && pid > 1) return pid;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("fixture child did not publish a valid PID before readiness deadline");
      };
      try {
        const pid = await Promise.race([
          ready(),
          captured.then(() => {
            throw new Error("fixture child exited before readiness");
          }),
        ]);
        await check(capture, pid);
      } finally {
        cleanup.abort();
        await captured;
      }
    };
    try {
      await withReadyChild(async (capture) => {
        expect(await probeCursorNativeAuth(PROFILE_ENV, undefined, capture, 80)).toMatchObject({
          kind: "unknown",
          timedOut: true,
        });
      });
      await withReadyChild(async (capture) => {
        const caller = new AbortController();
        const cancelled = probeCursorNativeAuth(PROFILE_ENV, caller.signal, capture, 30_000);
        caller.abort();
        const cancelledResult = await cancelled;
        expect(cancelledResult.kind).toBe("unknown");
        expect(cancelledResult).not.toHaveProperty("timedOut");
      });
      await withReadyChild(async (capture, pid) => {
        const killed = probeCursorNativeAuth(PROFILE_ENV, undefined, capture, 30_000);
        process.kill(pid, "SIGKILL");
        expect(await killed).toEqual({
          kind: "unknown",
          error: "cursor-agent status failed (SIGKILL)",
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not retry an ordinary non-zero probe without explicit JSON-option evidence", async () => {
    const calls: string[][] = [];
    const result = await probeCursorNativeAuth(
      { AGENT_CLI_CREDENTIAL_STORE: "file", CURSOR_CONFIG_DIR: "/tmp/profile/.cursor" },
      undefined,
      (async (_bin: string, argv: string[]) => {
        calls.push(argv);
        return {
          code: 2,
          signal: null,
          stdout: "",
          stderr: "status failed: temporary vendor transport error",
        };
      }) as never,
    );
    expect(result).toEqual({ kind: "unknown", error: "cursor-agent status failed (2)" });
    expect(calls).toEqual([["--disable-auto-update", "status", "--format", "json"]]);
  });

  it("keeps successful unrecognized profile JSON and diagnostics unknown", async () => {
    for (const result of [
      {
        code: 0,
        signal: null,
        stdout: JSON.stringify({ unexpected: "shape" }),
        stderr: "Logged in as unrelated@example.com",
      },
      { code: 0, signal: null, stdout: "not-json\nLogged in as unrelated@example.com", stderr: "" },
    ]) {
      await expect(
        probeCursorNativeAuth(
          { AGENT_CLI_CREDENTIAL_STORE: "file", CURSOR_CONFIG_DIR: "/tmp/profile/.cursor" },
          undefined,
          async () => result,
        ),
      ).resolves.toEqual({
        kind: "unknown",
        error: "cursor-agent status returned unrecognized JSON output (0)",
      });
    }
  });

  it("bounds and redacts thrown probe errors before returning typed unknown evidence", async () => {
    const secret = `sk-${"x".repeat(80)}`;
    const result = await probeCursorNativeAuth(undefined, undefined, async () => {
      throw new Error(`${secret}${"y".repeat(800)}`);
    });
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("expected unknown observation");
    expect(result.error?.length).toBeLessThanOrEqual(500);
    expect(result.error).not.toContain(secret);
  });
});

describe("cursor model inventory parsing", () => {
  it("parses cursor-agent model list output into typed model ids", () => {
    expect(
      parseCursorModelList(
        "Available models\n\nWarning: API route - reconnecting\ngpt-5.5-extra-high - GPT-5.5 1M Extra High\ngpt-5.5-xhigh-1M - GPT-5.5 1M XHigh\nmeta-llama/llama_3.1-70b - Llama 3.1 70B\norg:model:v2 - Vendor Model V2\ngemini-3.1-pro - Gemini 3.1 Pro\n2026-06-29T17:00:00Z - log line\n\nTip: use --model <id>\n",
      ),
    ).toEqual([
      {
        id: "gpt-5.5-extra-high",
        label: "GPT-5.5 1M Extra High",
        context_window: null,
        routes: null,
      },
      { id: "gpt-5.5-xhigh-1M", label: "GPT-5.5 1M XHigh", context_window: null, routes: null },
      {
        id: "meta-llama/llama_3.1-70b",
        label: "Llama 3.1 70B",
        context_window: null,
        routes: null,
      },
      { id: "org:model:v2", label: "Vendor Model V2", context_window: null, routes: null },
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", context_window: null, routes: null },
    ]);
  });

  it("accepts uppercase and numeric Cursor model ids without accepting timestamp logs", () => {
    expect(
      parseCursorModelList(
        ["GPT-4 - GPT 4", "O1 - O1", "1234 - Numeric", "2026-06-29T17:00:00Z - log line"].join(
          "\n",
        ),
      ),
    ).toEqual([
      { id: "GPT-4", label: "GPT 4", context_window: null, routes: null },
      { id: "O1", label: "O1", context_window: null, routes: null },
      { id: "1234", label: "Numeric", context_window: null, routes: null },
    ]);
  });
});

describe("cursor API-key smoke parsing", () => {
  it("requires the final stream-json assistant/result reply to equal exactly OK", () => {
    expect(
      cursorApiSmokePassed(
        0,
        [
          JSON.stringify({ type: "system", apiKeySource: "env" }),
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "thinking OK is required" }] },
          }),
          JSON.stringify({ type: "result", result: "OK" }),
        ].join("\n"),
      ),
    ).toBe(true);
    expect(
      cursorApiSmokePassed(
        0,
        [
          JSON.stringify({ type: "system", apiKeySource: "env" }),
          JSON.stringify({ type: "result", result: "NOT OK" }),
        ].join("\n"),
      ),
    ).toBe(false);
    expect(cursorApiSmokePassed(0, "log: OK\n")).toBe(false);
    expect(
      cursorApiSmokePassed(
        1,
        [
          JSON.stringify({ type: "system", apiKeySource: "env" }),
          JSON.stringify({ type: "result", result: "OK" }),
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it("extracts the last assistant text before falling back to result text", () => {
    expect(
      cursorApiSmokeFinalText(
        [
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "NOT OK" }] },
          }),
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: " OK \n" }] },
          }),
        ].join("\n"),
      ),
    ).toBe("OK");
  });

  it("keeps API-key smoke cleanup failures best-effort", async () => {
    let attempts = 0;
    await expect(
      cleanupCursorSmokeBase("/tmp/claudexor-cursor-smoke-test", {
        retries: 1,
        sleepMs: async () => {},
        remove: () => {
          attempts += 1;
          if (attempts === 1)
            throw Object.assign(new Error("Directory not empty"), { code: "ENOTEMPTY" });
        },
      }),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(2);

    await expect(
      cleanupCursorSmokeBase("/tmp/claudexor-cursor-smoke-test", {
        retries: 1,
        sleepMs: async () => {},
        remove: () => {
          throw Object.assign(new Error("Directory not empty"), { code: "ENOTEMPTY" });
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("never bridges the host Keychain into the smoke home (D-U3) and requires env API-key proof", async () => {
    const base = mkdtempSync(join(tmpdir(), "claudexor-cursor-smoke-test-"));
    const realHome = mkdtempSync(join(tmpdir(), "claudexor-cursor-real-home-"));
    const previousHome = process.env.HOME;
    let smokeEnv: Record<string, string | null | undefined> | undefined;

    try {
      mkdirSync(join(realHome, "Library", "Keychains"), { recursive: true });
      process.env.HOME = realHome;

      const result = await smokeIsolatedApiKey("cursor-key", {
        makeBaseDir: () => base,
        cleanupBase: async () => {},
        runCapture: async (_cmd, _args, opts) => {
          smokeEnv = opts?.env;
          return {
            code: 0,
            signal: null,
            stdout:
              `${JSON.stringify({ type: "system", apiKeySource: "env" })}\n` +
              `${JSON.stringify({ type: "result", result: "OK" })}\n`,
            stderr: "",
          };
        },
      });

      expect(result.ok).toBe(true);
      expect(smokeEnv?.["HOME"]).toBe(join(base, "home"));
      expect(smokeEnv?.["CURSOR_API_KEY"]).toBe("cursor-key");
      // Unified account model: the host Keychain (where the retired host CLI
      // login lives) is never linked into a Claudexor env — a bridged smoke
      // could silently authenticate with the HOST login instead of the key.
      expect(existsSync(join(base, "home", "Library", "Keychains"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(base, { recursive: true, force: true });
      rmSync(realHome, { recursive: true, force: true });
    }
  });

  it("does not accept a Cursor API-key smoke that lacks env-key route proof", async () => {
    const result = await smokeIsolatedApiKey("cursor-key", {
      cleanupBase: async () => {},
      runCapture: async () => ({
        code: 0,
        signal: null,
        stdout: `${JSON.stringify({ type: "result", result: "OK" })}\n`,
        stderr: "",
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("isolated cursor-agent API-key smoke failed");
  });
});

describe("selectCursorAuthRoute", () => {
  it("keeps non-scoped auto on the native route when both auth sources exist", () => {
    expect(
      selectCursorAuthRoute({
        authPreference: "auto",
        hasKey: true,
        apiKeyReady: true,
        nativeAuthed: true,
        scopedHome: false,
      }),
    ).toBe("local_session");
  });

  it("keeps scoped auto native-first when both auth sources exist", () => {
    expect(
      selectCursorAuthRoute({
        authPreference: "auto",
        hasKey: true,
        apiKeyReady: true,
        nativeAuthed: true,
        scopedHome: true,
      }),
    ).toBe("local_session");
  });

  it("does not route through a key string that was not smoke-proven", () => {
    expect(
      selectCursorAuthRoute({
        authPreference: "auto",
        hasKey: true,
        apiKeyReady: false,
        nativeAuthed: true,
        scopedHome: true,
      }),
    ).toBe("local_session");
    expect(
      selectCursorAuthRoute({
        authPreference: "auto",
        hasKey: true,
        apiKeyReady: false,
        nativeAuthed: false,
        scopedHome: true,
      }),
    ).toBe("unavailable");
  });

  it("honors explicit subscription when native auth is available", () => {
    expect(
      selectCursorAuthRoute({
        authPreference: "subscription",
        hasKey: true,
        apiKeyReady: true,
        nativeAuthed: true,
        scopedHome: true,
      }),
    ).toBe("local_session");
  });

  it("does not silently fall back from explicit subscription to api_key", () => {
    expect(
      selectCursorAuthRoute({
        authPreference: "subscription",
        hasKey: true,
        apiKeyReady: true,
        nativeAuthed: false,
        scopedHome: true,
      }),
    ).toBe("unavailable");
  });

  it("fails closed for explicit api_key when only native auth is available", () => {
    expect(
      selectCursorAuthRoute({
        authPreference: "api_key",
        hasKey: false,
        apiKeyReady: false,
        nativeAuthed: true,
        scopedHome: true,
      }),
    ).toBe("unavailable");
  });

  it("fails closed when no auth source exists", () => {
    expect(
      selectCursorAuthRoute({
        authPreference: "auto",
        hasKey: false,
        apiKeyReady: false,
        nativeAuthed: false,
        scopedHome: false,
      }),
    ).toBe("unavailable");
  });

  it("discloses every auto API-key fallback", () => {
    expect(
      shouldDiscloseCursorAutoApiRoute({
        authPreference: "auto",
        route: "api_key",
        nativeAuthed: true,
      }),
    ).toBe(true);
    expect(
      shouldDiscloseCursorAutoApiRoute({
        authPreference: "api_key",
        route: "api_key",
        nativeAuthed: true,
      }),
    ).toBe(false);
    expect(
      shouldDiscloseCursorAutoApiRoute({
        authPreference: "auto",
        route: "api_key",
        nativeAuthed: false,
      }),
    ).toBe(true);
  });
});

describe("cursor adapter auth route wiring", () => {
  const spec = (overrides: Partial<HarnessRunSpec> = {}): HarnessRunSpec =>
    HarnessRunSpec.parse({
      session_id: "s-cursor",
      intent: "review",
      prompt: "review this",
      cwd: "/repo",
      ...overrides,
    });

  it("emits fallback disclosure and runs with the prepared API-key env when native is unavailable", async () => {
    let nativeProbes = 0;
    let cliOpts: CliRunLoopOptions | undefined;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => {
        nativeProbes += 1;
        return nativeProbe(false);
      },
      cursorApiKey: () => "cursor-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => ({ ok: true, detail: "ok" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        cliOpts = opts;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({
        env: {
          HOME: "/tmp/scoped-home",
          CUSTOM_CA_BUNDLE: "/ca.pem",
          OPENAI_API_KEY: "must-be-scrubbed",
          CLAUDEXOR_CURSOR_API_KEY: "must-be-scrubbed",
        },
      }),
    )) {
      events.push(ev);
    }

    // D-U3: a scoped-but-not-file-store env has no native session to probe —
    // probing it would read the HOST Keychain login, which is retired.
    expect(nativeProbes).toBe(0);
    expect(cliOpts?.env?.["CUSTOM_CA_BUNDLE"]).toBe("/ca.pem");
    expect(cliOpts?.env?.["OPENAI_API_KEY"]).toBeNull();
    expect(cliOpts?.env?.["CLAUDEXOR_CURSOR_API_KEY"]).toBeNull();
    expect(cliOpts?.env?.["CURSOR_API_KEY"]).toBe("cursor-key");
    expect(events[0]).toMatchObject({
      type: "message",
      payload: {
        auth_switched: true,
        from_auth_mode: "local_session",
        to_auth_mode: "api_key",
        reason: "readiness_preferred",
      },
    });
    expect(events[0]?.text).toBeUndefined();
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("keeps a FILE-STORE env on its native session without spending the API key (D-U3)", async () => {
    let smokeCalled = false;
    let cliOpts: CliRunLoopOptions | undefined;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(true),
      cursorApiKey: () => "cursor-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => {
        smokeCalled = true;
        return { ok: true, detail: "ok" };
      },
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        cliOpts = opts;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({
        env: {
          HOME: "/tmp/row-home",
          AGENT_CLI_CREDENTIAL_STORE: "file",
          CURSOR_API_KEY: "must-be-scrubbed",
          CLAUDEXOR_CURSOR_API_KEY: "must-be-scrubbed",
        },
      }),
    ))
      events.push(ev);

    expect(smokeCalled).toBe(false);
    expect(cliOpts?.env?.["CURSOR_API_KEY"]).toBeNull();
    expect(cliOpts?.env?.["CLAUDEXOR_CURSOR_API_KEY"]).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("completed");
  });

  it("discover never probes the host login: the key is the only default source (D-U3)", async () => {
    let nativeProbes = 0;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => {
        nativeProbes += 1;
        return nativeProbe(true);
      },
      cursorApiKey: () => "cursor-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => ({ ok: true, detail: "ok" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    await expect(adapter.discover()).resolves.toMatchObject({
      capability_profile: { auth: { preferred_source: "api_key_env" } },
      auth_modes: ["api_key"],
    });
    expect(nativeProbes).toBe(0);
  });

  it("declares its model list advisory: --list-models proves presence, never absence (INV-104)", async () => {
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(false),
      cursorApiKey: () => "cursor-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => ({ ok: true, detail: "ok" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });
    const manifest = await adapter.discover();
    expect(manifest.capabilities.model_inventory_absence).toBe("advisory");
    // Every route: the fail-soft menu answers for API-key and native alike.
    expect(manifest.capabilities.model_inventory_routes).toBeUndefined();
    expect(typeof adapter.models).toBe("function");
  });

  it("reuses a successful API-key smoke across repeated scoped runs", async () => {
    let smokeCalls = 0;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(false),
      cursorApiKey: () => "cursor-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => {
        smokeCalls += 1;
        return { ok: true, detail: "ok" };
      },
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    const collect = async (session_id: string): Promise<HarnessEvent[]> => {
      const events: HarnessEvent[] = [];
      for await (const ev of adapter.run(spec({ session_id, env: { HOME: "/tmp/scoped-home" } })))
        events.push(ev);
      return events;
    };
    const hasReadinessDisclosure = (events: HarnessEvent[]): boolean =>
      events.some((ev) => {
        const payload =
          typeof ev.payload === "object" && ev.payload !== null
            ? (ev.payload as Record<string, unknown>)
            : {};
        return ev.type === "message" && payload.reason === "readiness_preferred";
      });

    expect(hasReadinessDisclosure(await collect("s-one"))).toBe(true);
    expect(hasReadinessDisclosure(await collect("s-two"))).toBe(true);
    expect(smokeCalls).toBe(1);
  });

  it("keeps a smoke-proven API-key route stable across a long sequential panel", async () => {
    let now = 1_000;
    let smokeCalls = 0;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(false),
      cursorApiKey: () => "cursor-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => {
        smokeCalls += 1;
        return { ok: true, detail: "ok" };
      },
      nowMs: () => now,
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    const collect = async (session_id: string): Promise<void> => {
      for await (const _ev of adapter.run(
        spec({ session_id, env: { HOME: "/tmp/scoped-home" } }),
      )) {
        // drain
      }
    };

    await collect("s-one");
    now += 45 * 60_000;
    await collect("s-two");

    expect(smokeCalls).toBe(1);
  });

  it("re-smokes a cached API key after the smoke cache TTL expires", async () => {
    let now = 1_000;
    let smokeCalls = 0;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(false),
      cursorApiKey: () => "cursor-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => {
        smokeCalls += 1;
        return { ok: true, detail: "ok" };
      },
      apiSmokeCacheTtlMs: 100,
      nowMs: () => now,
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    const collect = async (session_id: string): Promise<void> => {
      for await (const _ev of adapter.run(
        spec({ session_id, env: { HOME: "/tmp/scoped-home" } }),
      )) {
        // drain
      }
    };

    await collect("s-one");
    now = 1_099;
    await collect("s-two");
    now = 1_101;
    await collect("s-three");

    expect(smokeCalls).toBe(2);
  });

  it("caches failed API-key smoke briefly to avoid repeated stale-key probes", async () => {
    let now = 1_000;
    let smokeCalls = 0;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(false),
      cursorApiKey: () => "stale-cursor-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => {
        smokeCalls += 1;
        return { ok: false, detail: "stale key" };
      },
      apiSmokeCacheTtlMs: 10_000,
      apiSmokeFailureCacheTtlMs: 100,
      nowMs: () => now,
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    await adapter.doctor({ cwd: "/repo" });
    now = 1_099;
    await adapter.doctor({ cwd: "/repo" });
    now = 1_101;
    await adapter.doctor({ cwd: "/repo" });

    expect(smokeCalls).toBe(2);
  });

  it("fresh doctor bypasses the inner API smoke cache without replacing it", async () => {
    let smokeCalls = 0;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(false),
      cursorApiKey: () => "cursor-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => {
        smokeCalls += 1;
        return { ok: smokeCalls !== 2, detail: `smoke-${smokeCalls}` };
      },
      apiSmokeCacheTtlMs: 60_000,
      apiSmokeFailureCacheTtlMs: 60_000,
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    const cached = await adapter.doctor({ cwd: "/repo", authPreference: "api_key" });
    const fresh = await adapter.doctor({ cwd: "/repo", authPreference: "api_key", fresh: true });
    const cachedAgain = await adapter.doctor({ cwd: "/repo", authPreference: "api_key" });

    expect(cached.status).toBe("ok");
    expect(fresh.status).toBe("degraded");
    expect(cachedAgain.status).toBe("ok");
    expect(smokeCalls).toBe(2);
  });

  it("scrubs Cursor API-key env from discover and doctor native auth probes", async () => {
    const probedEnvs: Array<Record<string, string | null | undefined> | undefined> = [];
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async (env) => {
        probedEnvs.push(env);
        return nativeProbe(false);
      },
      cursorApiKey: () => "cursor-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => ({ ok: false, detail: "stale key" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    await adapter.discover();
    await adapter.doctor({ cwd: "/repo" });

    // D-U3: neither discover nor a default doctor probes the host login at
    // all — there is nothing for a probe env to leak.
    expect(probedEnvs).toHaveLength(0);

    const fileStoreEnv = { HOME: "/tmp/row-home", AGENT_CLI_CREDENTIAL_STORE: "file" };
    await adapter.doctor({ cwd: "/repo", env: fileStoreEnv });
    expect(probedEnvs).toHaveLength(1);
    expect(probedEnvs.every((env) => env?.["CURSOR_API_KEY"] === null)).toBe(true);
    expect(probedEnvs.every((env) => env?.["CLAUDEXOR_CURSOR_API_KEY"] === null)).toBe(true);
  });

  it("the default Accounts receipt has NO host identity; a file-store env carries its row's identity (D-U3)", async () => {
    let nativeStatusCalls = 0;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => {
        nativeStatusCalls += 1;
        return { kind: "authenticated", email: "row-cursor@example.test" };
      },
      cursorApiKey: () => null,
      listCursorModels: async () => [],
    });

    await adapter.discover();
    const receipt = await adapter.doctorForAccounts!({ cwd: "/repo", fresh: true });
    // The host Keychain login is never probed: no identity, no native source.
    expect(nativeStatusCalls).toBe(0);
    expect(receipt.identity).toBeNull();
    expect(
      receipt.report.auth_sources.find((source) => source.source === "native_session"),
    ).toMatchObject({ availability: "unavailable", verification: "not_run" });

    // A row's file-store env proves ITS identity through the same receipt.
    const rowReceipt = await adapter.doctorForAccounts!({
      cwd: "/repo",
      fresh: true,
      env: { HOME: "/tmp/row-home", AGENT_CLI_CREDENTIAL_STORE: "file" },
    });
    expect(nativeStatusCalls).toBe(1);
    expect(rowReceipt.identity).toEqual({ email: "row-cursor@example.test" });
    expect(rowReceipt.report).toMatchObject({ harness_id: "cursor", status: "ok" });
  });

  it("uses scoped doctor env for Cursor API key readiness without probing a non-file-store native session", async () => {
    const previousHostKey = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "host-key-must-not-be-used";
    const probedEnvs: Array<Record<string, string | null | undefined> | undefined> = [];
    const smokedKeys: string[] = [];
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async (env) => {
        probedEnvs.push(env);
        return nativeProbe(false);
      },
      cursorApiKey: (env) => env?.["CURSOR_API_KEY"] ?? null,
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async (key) => {
        smokedKeys.push(key ?? "");
        return { ok: key === "scoped-key", detail: "ok" };
      },
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    try {
      const report = await adapter.doctor({
        cwd: "/repo",
        authPreference: "api_key",
        env: { HOME: "/tmp/scoped-home", CURSOR_API_KEY: "scoped-key" },
      });

      expect(report.status).toBe("ok");
      expect(report.enabled_intents).toContain("implement");
      expect(smokedKeys).toEqual(["scoped-key"]);
      expect(probedEnvs).toHaveLength(0);
    } finally {
      if (previousHostKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previousHostKey;
    }
  });

  it("honors subscription auth preference in doctor readiness without API-key smoke", async () => {
    let smokeCalls = 0;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(true),
      cursorApiKey: () => "available-but-forbidden-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => {
        smokeCalls += 1;
        return { ok: true, detail: "would spend" };
      },
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    const report = await adapter.doctor({
      cwd: "/repo",
      authPreference: "subscription",
      env: {
        HOME: "/tmp/scoped-home",
        AGENT_CLI_CREDENTIAL_STORE: "file",
        CURSOR_API_KEY: "available-but-forbidden-key",
      },
    });

    expect(smokeCalls).toBe(0);
    expect(report.status).toBe("ok");
    expect(report.enabled_intents).toEqual([
      "plan",
      "spec",
      "implement",
      "repair",
      "create_from_scratch",
      "review",
      "verify",
      "synthesize",
      "explain",
      "audit",
    ]);
  });

  it.each([
    {
      name: "authenticated",
      probe: nativeProbe(true),
      availability: "available",
      verification: "passed",
      status: "ok",
    },
    {
      name: "logged out",
      probe: nativeProbe(false),
      availability: "unavailable",
      verification: "not_run",
      status: "unavailable",
    },
    {
      name: "probe error",
      probe: nativeProbe(false, "status transport failed"),
      availability: "unknown",
      verification: "not_run",
      status: "degraded",
    },
  ])(
    "normalizes native readiness for $name",
    async ({ probe, availability, verification, status }) => {
      let keyReads = 0;
      let observedSignal: AbortSignal | undefined;
      const adapter = createCursorAdapter({
        detectVersion: async () => "cursor-test",
        nativeAuthOk: async (_env, signal) => {
          observedSignal = signal;
          return probe;
        },
        cursorApiKey: () => {
          keyReads += 1;
          return "must-not-read";
        },
        listCursorModels: async () => [],
        smokeIsolatedApiKey: async () => ({ ok: true, detail: "must not run" }),
        runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
          yield {
            type: "completed",
            session_id: opts.spec.session_id,
            ts: "2026-01-01T00:00:00.000Z",
          };
        },
      });
      const controller = new AbortController();
      const report = await adapter.doctor({
        cwd: "/repo",
        authPreference: "subscription",
        authSource: "native_session",
        // D-U3: only a file-store env may probe a native session.
        env: { HOME: "/tmp/row-home", AGENT_CLI_CREDENTIAL_STORE: "file" },
        abortSignal: controller.signal,
      });
      expect(keyReads).toBe(0);
      expect(observedSignal).toBe(controller.signal);
      expect(report.status).toBe(status);
      expect(report.auth_sources).toEqual([
        expect.objectContaining({ source: "native_session", availability, verification }),
      ]);
    },
  );

  it("does not spawn cursor-agent when only an unproven API key route exists", async () => {
    let spawned = false;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(false),
      cursorApiKey: () => "stale-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => ({ ok: false, detail: "smoke failed" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        spawned = true;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(spec({ env: { HOME: "/tmp/scoped-home" } })))
      events.push(ev);

    expect(spawned).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toContain("smoke-proven Cursor API key fallback");
    expect(events[1]?.type).toBe("completed");
  });

  it("fails closed without spawning cursor-agent when no auth route is available", async () => {
    let spawned = false;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(false),
      cursorApiKey: () => null,
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => ({ ok: false, detail: "no key" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        spawned = true;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(spec())) events.push(ev);

    expect(spawned).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toContain(
      "Cursor requires either a native session or a smoke-proven Cursor API key fallback",
    );
    expect(events[1]?.type).toBe("completed");
  });

  it("exposes the cursor model inventory producer", async () => {
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(true),
      cursorApiKey: () => "cursor-key",
      listCursorModels: async () => [
        {
          id: "gpt-5.5-extra-high",
          label: "GPT-5.5 1M Extra High",
          context_window: null,
          routes: null,
        },
      ],
      smokeIsolatedApiKey: async () => ({ ok: true, detail: "ok" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    await expect(adapter.models?.({ cwd: "/repo" })).resolves.toEqual([
      {
        id: "gpt-5.5-extra-high",
        label: "GPT-5.5 1M Extra High",
        context_window: null,
        routes: null,
      },
    ]);
  });

  it("prefers a file-store env's native model inventory over an available key string (D-U3)", async () => {
    let smokeCalls = 0;
    const modelEnvs: Array<Record<string, string | null | undefined> | undefined> = [];
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(true),
      cursorApiKey: () => "stale-key",
      listCursorModels: async (env) => {
        modelEnvs.push(env);
        return [{ id: "native-model", label: "Native Model", context_window: null, routes: null }];
      },
      smokeIsolatedApiKey: async () => {
        smokeCalls += 1;
        return { ok: true, detail: "ok" };
      },
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    await expect(
      adapter.models?.({
        cwd: "/repo",
        env: { HOME: "/tmp/row-home", AGENT_CLI_CREDENTIAL_STORE: "file" },
        authPreference: "auto",
      }),
    ).resolves.toEqual([
      { id: "native-model", label: "Native Model", context_window: null, routes: null },
    ]);
    expect(modelEnvs).toHaveLength(1);
    expect(modelEnvs[0]?.["CURSOR_API_KEY"]).toBeNull();
    expect(smokeCalls).toBe(0);
  });

  it("uses API-key model inventory only after the key route is smoke-proven", async () => {
    const modelEnvs: Array<Record<string, string | null | undefined> | undefined> = [];
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(false),
      cursorApiKey: () => "cursor-key",
      listCursorModels: async (env) => {
        modelEnvs.push(env);
        return [{ id: "api-model", label: "API Model", context_window: null, routes: null }];
      },
      smokeIsolatedApiKey: async () => ({ ok: true, detail: "ok" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    await expect(adapter.models?.({ cwd: "/repo" })).resolves.toEqual([
      { id: "api-model", label: "API Model", context_window: null, routes: null },
    ]);
    expect(modelEnvs).toHaveLength(1);
    expect(modelEnvs[0]?.["CURSOR_API_KEY"]).toBe("cursor-key");
  });

  it("still exposes Cursor model inventory when auth readiness is unavailable", async () => {
    const modelEnvs: Array<Record<string, string | null | undefined> | undefined> = [];
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(false),
      cursorApiKey: () => "stale-key",
      listCursorModels: async (env) => {
        modelEnvs.push(env);
        return env?.["CURSOR_API_KEY"] === "stale-key"
          ? [{ id: "catalog-model", label: "Catalog Model", context_window: null, routes: null }]
          : [];
      },
      smokeIsolatedApiKey: async () => ({ ok: false, detail: "smoke failed" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    await expect(adapter.models?.({ cwd: "/repo" })).resolves.toEqual([
      { id: "catalog-model", label: "Catalog Model", context_window: null, routes: null },
    ]);
    expect(modelEnvs).toHaveLength(1);
    expect(modelEnvs[0]?.["CURSOR_API_KEY"]).toBe("stale-key");
  });

  it("does not use clean catalog fallback for scoped route model validation", async () => {
    const modelEnvs: Array<Record<string, string | null | undefined> | undefined> = [];
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(true),
      cursorApiKey: () => "cursor-key",
      listCursorModels: async (env) => {
        modelEnvs.push(env);
        if (env?.["CURSOR_API_KEY"] === "cursor-key" && !env?.["HOME"])
          return [
            { id: "catalog-model", label: "Catalog Model", context_window: null, routes: null },
          ];
        return [];
      },
      smokeIsolatedApiKey: async () => ({ ok: false, detail: "smoke failed" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    await expect(
      adapter.models?.({
        cwd: "/repo",
        env: { HOME: "/tmp/scoped-home", AGENT_CLI_CREDENTIAL_STORE: "file" },
        authPreference: "auto",
      }),
    ).resolves.toEqual([]);
    expect(modelEnvs).toHaveLength(1);
    expect(modelEnvs[0]?.["HOME"]).toBe("/tmp/scoped-home");
    expect(modelEnvs[0]?.["CURSOR_API_KEY"]).toBeNull();
  });

  it("does not use API-key catalog fallback for explicit subscription model inventory", async () => {
    const modelEnvs: Array<Record<string, string | null | undefined> | undefined> = [];
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(true),
      cursorApiKey: () => "available-but-forbidden-key",
      listCursorModels: async (env) => {
        modelEnvs.push(env);
        return [];
      },
      smokeIsolatedApiKey: async () => ({ ok: true, detail: "ok" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    await expect(
      adapter.models?.({
        cwd: "/repo",
        env: {
          HOME: "/tmp/scoped-home",
          AGENT_CLI_CREDENTIAL_STORE: "file",
          CURSOR_API_KEY: "available-but-forbidden-key",
        },
        authPreference: "subscription",
      }),
    ).resolves.toEqual([]);
    expect(modelEnvs).toHaveLength(1);
    expect(modelEnvs[0]?.["HOME"]).toBe("/tmp/scoped-home");
    expect(modelEnvs[0]?.["CURSOR_API_KEY"]).toBeNull();
  });

  it("uses scoped native model inventory before an available API key", async () => {
    let smokeCalls = 0;
    const modelEnvs: Array<Record<string, string | null | undefined> | undefined> = [];
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(true),
      cursorApiKey: () => "cursor-key",
      listCursorModels: async (env) => {
        modelEnvs.push(env);
        return env?.["CURSOR_API_KEY"] === "cursor-key"
          ? [
              {
                id: "api-review-model",
                label: "API Review Model",
                context_window: null,
                routes: null,
              },
            ]
          : [
              {
                id: "native-review-model",
                label: "Native Review Model",
                context_window: null,
                routes: null,
              },
            ];
      },
      smokeIsolatedApiKey: async () => {
        smokeCalls += 1;
        return { ok: true, detail: "ok" };
      },
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    await expect(
      adapter.models?.({
        cwd: "/repo",
        env: { HOME: "/tmp/scoped-home", AGENT_CLI_CREDENTIAL_STORE: "file" },
        authPreference: "auto",
      }),
    ).resolves.toEqual([
      {
        id: "native-review-model",
        label: "Native Review Model",
        context_window: null,
        routes: null,
      },
    ]);
    expect(smokeCalls).toBe(0);
    expect(modelEnvs).toHaveLength(1);
    expect(modelEnvs[0]?.["CURSOR_API_KEY"]).toBeNull();
  });
});

// Release wave round-15 #1/#4: a valid cursor profile must be probe-admissible
// past a logged-out default store, and a mis-bound ref must be unavailable at
// PROBE time (never admitted then refused at run). One owner: the probe maps
// the SAME cursorProfileKeyOrRefusal resolution the run route uses.
describe("cursor credential-profile doctor probe (INV-135)", () => {
  const profile = (over: Record<string, unknown> = {}) =>
    ({
      profile_id: "acc2",
      harness_id: "cursor",
      display_name: "Second",
      credential_kind: "api_key",
      isolation_locator: null,
      secret_ref: "cursor:acc2",
      enabled: true,
      created_at: null,
      ...over,
    }) as never;

  it("a stored namespaced cursor slot is available (presence, not liveness)", async () => {
    const adapter = createCursorAdapter({
      resolveProfileSecret: (ref) => (ref === "cursor:acc2" ? "sk-cursor" : null),
    });
    const status = await adapter.probeCredentialProfile!(profile());
    expect(status).toMatchObject({
      profile_id: "acc2",
      harness_id: "cursor",
      availability: "available",
      verification: "not_run",
    });
  });

  it("a foreign or bare slot is unavailable and never read; a missing secret is unavailable", async () => {
    const reads: string[] = [];
    const adapter = createCursorAdapter({
      resolveProfileSecret: (ref) => {
        reads.push(ref);
        return null;
      },
    });
    for (const secret_ref of ["openai:acc2", "cursor"]) {
      const status = await adapter.probeCredentialProfile!(profile({ secret_ref }));
      expect(status).toMatchObject({ availability: "unavailable", verification: "failed" });
      expect(status.detail).toContain("cursor slot");
    }
    expect(reads).toEqual([]);
    const missing = await adapter.probeCredentialProfile!(profile());
    expect(missing).toMatchObject({ availability: "unavailable", verification: "not_run" });
    expect(reads).toEqual(["cursor:acc2"]);
    // config_dir_login IS a supported transport (valentine); this probe fails
    // because "/x" is an out-of-tree isolation locator, which the profile
    // route owner rejects before any vendor probe (see profile.test.ts for
    // the valid config-dir routes).
    const outOfTree = await adapter.probeCredentialProfile!(
      profile({ credential_kind: "config_dir_login", secret_ref: null, isolation_locator: "/x" }),
    );
    expect(outOfTree).toMatchObject({ availability: "unavailable", verification: "failed" });
    expect(outOfTree.detail).toContain("must live under");
  });
});

describe("doctor remedies never name a bare vendor login (INV-067, v3.0.3 wave 3)", () => {
  it("the source carries no bare cursor-agent login remedy string", () => {
    // The doctor reason strings are static: pin the INV-067 rule at the
    // source level so a future edit cannot reintroduce the bare vendor
    // command an agent would copy into the wrong store.
    const source = ["index.ts", "doctor.ts"]
      .map((file) => readFileSync(join(import.meta.dirname, file), "utf8"))
      .join("\n");
    const remedies = source
      .split("\n")
      .filter((line) => /not authenticated|not ready|not logged in/.test(line));
    expect(remedies.length).toBeGreaterThan(0);
    for (const line of remedies) {
      expect(line).not.toMatch(/\(cursor-agent login/);
      expect(line).not.toMatch(/run `cursor-agent login`/);
    }
  });
});

describe("models() under a pinned credential profile (INV-135 x INV-104)", () => {
  // A real directory UNDER a Claudexor-owned root: the locator is canonicalized
  // and containment-checked, so a synthetic path would refuse for the wrong
  // reason and hide the regression this pins.
  const configRoot = mkdtempSync(join(tmpdir(), "cursor-pinned-root-"));
  const profileHome = join(configRoot, "profiles", "cursor-valentine");
  mkdirSync(profileHome, { recursive: true });
  const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
  beforeAll(() => {
    process.env.CLAUDEXOR_CONFIG_DIR = configRoot;
  });
  afterAll(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    rmSync(configRoot, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
  const fileStoreProfile = {
    profile_id: "valentine",
    harness_id: "cursor",
    display_name: "Valentine",
    credential_kind: "config_dir_login" as const,
    isolation_locator: profileHome,
    secret_ref: null,
    enabled: true,
    created_at: "2026-01-01T00:00:00.000Z",
  };

  it("enumerates through the profile's own route, not the engine-default ladder", async () => {
    // The counterexample this pins: without the profile arm, `models()` fell to
    // the default ladder, which under D-U3 can only find the API-key route.
    // With no key it returned [] and the strict model gate then refused a model
    // the pinned account really offers — preflight and spawn disagreeing about
    // WHICH account they are talking about.
    const seen: Array<Record<string, unknown>> = [];
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(true),
      cursorApiKey: () => null,
      listCursorModels: async (env, cwd) => {
        seen.push({ env: env as Record<string, unknown>, cwd });
        return [
          {
            id: "gpt-5.6-sol-xhigh",
            label: "GPT-5.6 Sol Extra High",
            context_window: null,
            routes: null,
          },
        ];
      },
      smokeIsolatedApiKey: async () => ({ ok: false, detail: "no key" }),
    });

    const models = await adapter.models?.({
      cwd: "/repo/attempt",
      env: {},
      authPreference: "auto",
      credentialProfile: fileStoreProfile,
    });

    expect(models).toEqual([
      {
        id: "gpt-5.6-sol-xhigh",
        label: "GPT-5.6 Sol Extra High",
        context_window: null,
        routes: null,
      },
    ]);
    expect(seen).toHaveLength(1);
    // The account's own HOME answered, the API key was explicitly cleared, and
    // the inventory ran in the run's cwd.
    expect(seen[0]?.cwd).toBe("/repo/attempt");
    const env = seen[0]?.env as Record<string, unknown>;
    expect(env["HOME"]).toBe(realpathSync(profileHome));
    expect(env["CURSOR_API_KEY"]).toBeNull();
  });

  it("returns an empty list rather than another account's when the profile refuses", async () => {
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(false),
      cursorApiKey: () => "default-account-key",
      listCursorModels: async () => [
        { id: "leaked-from-default", label: "Leaked", context_window: null, routes: null },
      ],
      smokeIsolatedApiKey: async () => ({ ok: true, detail: "ok" }),
    });

    const models = await adapter.models?.({
      cwd: "/repo",
      env: {},
      authPreference: "auto",
      credentialProfile: fileStoreProfile,
    });

    expect(models).toEqual([]);
  });
});

describe("API smoke observation identity", () => {
  it("uses an opaque binding and invalidates on credential change without hashing secret bytes", async () => {
    const { smokeCursorApiKey } = await import("./smoke.js");
    const cache = new Map();
    const smoke = vi.fn(async (_key: string | null) => ({ ok: true, detail: "fixture" }));
    const deps = {
      smokeIsolatedApiKey: smoke,
      apiSmokeCache: cache,
      apiSmokeCacheTtlMs: 1000,
      apiSmokeFailureCacheTtlMs: 1000,
      nowMs: () => 0,
    };
    await smokeCursorApiKey(deps, "synthetic-key-a");
    const first = [...cache.keys()][0]!;
    expect(JSON.parse(first)[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first).not.toContain("synthetic-key");
    await smokeCursorApiKey(deps, "synthetic-key-a");
    expect(smoke).toHaveBeenCalledTimes(1);
    await smokeCursorApiKey(deps, "synthetic-key-b");
    expect(smoke).toHaveBeenCalledTimes(2);
    expect(cache.has(first)).toBe(false);
    expect(cache.size).toBe(1);
  });
  it("a late smoke for a retired credential cannot repopulate its cache", async () => {
    const { smokeCursorApiKey } = await import("./smoke.js");
    let release!: (result: { ok: boolean; detail: string }) => void;
    const smoke = vi.fn(async (_key: string | null) => ({ ok: true, detail: "new" }));
    smoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const cache = new Map();
    const deps = {
      smokeIsolatedApiKey: smoke,
      apiSmokeCache: cache,
      apiSmokeCacheTtlMs: 1000,
      apiSmokeFailureCacheTtlMs: 1000,
      nowMs: () => 0,
    };
    const old = smokeCursorApiKey(deps, "synthetic-old");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await smokeCursorApiKey(deps, "synthetic-new");
    release({ ok: true, detail: "old" });
    await old;
    expect(cache.size).toBe(1);
    expect(await smokeCursorApiKey(deps, "synthetic-new")).toEqual({ ok: true, detail: "new" });
    expect(smoke).toHaveBeenCalledTimes(2);
  });
});
