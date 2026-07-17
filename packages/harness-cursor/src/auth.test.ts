import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import type { CliRunLoopOptions } from "@claudexor/core";
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

const nativeProbe = (authed: boolean, probeError: string | null = null) => ({ authed, probeError });

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
      authed: false,
      probeError: "cursor-agent status returned unrecognized output (0)",
    });
    expect(result.probeError).not.toContain("private@example.com");
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

  it("bridges Keychain for Cursor's macOS Security dependency but requires env API-key proof", async () => {
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
      expect(existsSync(join(base, "home", "Library", "Keychains"))).toBe(
        process.platform === "darwin",
      );
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
    let probedEnv: Record<string, string | null | undefined> | undefined;
    let cliOpts: CliRunLoopOptions | undefined;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async (env) => {
        probedEnv = env;
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

    expect(probedEnv?.["CUSTOM_CA_BUNDLE"]).toBe("/ca.pem");
    expect(probedEnv?.["OPENAI_API_KEY"]).toBeNull();
    expect(probedEnv?.["CLAUDEXOR_CURSOR_API_KEY"]).toBeNull();
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

  it("keeps non-scoped auto on the native session without spending the API key", async () => {
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

  it("advertises native session as the static preferred source when both sources exist", async () => {
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => nativeProbe(true),
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
      capability_profile: { auth: { preferred_source: "native_session" } },
      auth_modes: ["local_session", "api_key"],
    });
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

    expect(probedEnvs).toHaveLength(2);
    expect(probedEnvs.every((env) => env?.["CURSOR_API_KEY"] === null)).toBe(true);
    expect(probedEnvs.every((env) => env?.["CLAUDEXOR_CURSOR_API_KEY"] === null)).toBe(true);
  });

  it("uses scoped doctor env for auth probing and Cursor API key readiness", async () => {
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
      expect(report.enabled_intents).not.toContain("orchestrate");
      expect(report.disabled_intents).toContain("orchestrate");
      expect(smokedKeys).toEqual(["scoped-key"]);
      expect(probedEnvs[0]?.["HOME"]).toBe("/tmp/scoped-home");
      expect(probedEnvs[0]?.["CURSOR_API_KEY"]).toBeNull();
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
      env: { HOME: "/tmp/scoped-home", CURSOR_API_KEY: "available-but-forbidden-key" },
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
    expect(report.disabled_intents).toContain("orchestrate");
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

  it("prefers native model inventory over an available key string", async () => {
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

    await expect(adapter.models?.({ cwd: "/repo" })).resolves.toEqual([
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
      adapter.models?.({ cwd: "/repo", env: { HOME: "/tmp/scoped-home" }, authPreference: "auto" }),
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
        env: { HOME: "/tmp/scoped-home", CURSOR_API_KEY: "available-but-forbidden-key" },
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
      adapter.models?.({ cwd: "/repo", env: { HOME: "/tmp/scoped-home" }, authPreference: "auto" }),
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
    const unsupported = await adapter.probeCredentialProfile!(
      profile({ credential_kind: "config_dir_login", secret_ref: null, isolation_locator: "/x" }),
    );
    expect(unsupported).toMatchObject({ availability: "unavailable", verification: "failed" });
  });
});
