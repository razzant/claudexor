import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeArgsForSpec,
  claudeAuthSourceReadiness,
  createClaudeAdapter,
  defaultNativeClaudeConfigDir,
  probeAuthStatus,
  selectClaudeRunAuthRoute,
} from "./index.js";
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import type { CliRunLoopOptions } from "@claudexor/core";

const readonlySupported = async () => ({
  supported: true,
  missingFlags: [],
  detail: "test readonly profile supported",
});

const readonlyUnsupported = async () => ({
  supported: false,
  missingFlags: ["--tools"],
  detail: "test readonly profile unavailable",
});

describe("Claude strict runtime auth routing", () => {
  it("does not fall back for explicit routes and keeps auto subscription-first", () => {
    const attempts: string[] = [];
    const sub = () => {
      attempts.push("subscription");
      return false;
    };
    const key = () => {
      attempts.push("api_key");
      return true;
    };
    expect(selectClaudeRunAuthRoute("subscription", sub, key)).toBeNull();
    expect(attempts).toEqual(["subscription"]);
    attempts.length = 0;
    expect(selectClaudeRunAuthRoute("auto", sub, key)).toBe("api_key");
    expect(attempts).toEqual(["subscription", "api_key"]);
    attempts.length = 0;
    expect(
      selectClaudeRunAuthRoute(
        "api_key",
        () => {
          attempts.push("subscription");
          return true;
        },
        () => {
          attempts.push("api_key");
          return false;
        },
      ),
    ).toBeNull();
    expect(attempts).toEqual(["api_key"]);
  });
});

describe("Claude setup-token readiness", () => {
  it("never impersonates an official native-session proof when the CLI is logged out", () => {
    const sources = claudeAuthSourceReadiness({
      native: { loggedIn: false, authed: false, authMethod: "none", probeError: null },
      oauthAvailable: true,
      oauthVerification: "passed",
      oauthDetail: "isolated setup-token smoke passed",
      apiKeyAvailable: false,
      apiKeyVerification: "not_run",
      apiKeyDetail: "no key",
    });
    expect(sources.find((source) => source.source === "native_session")).toMatchObject({
      availability: "unavailable",
      verification: "not_run",
    });
    expect(sources.find((source) => source.source === "oauth_token_env")).toMatchObject({
      availability: "available",
      verification: "passed",
    });
  });
});

function spec(over: Partial<HarnessRunSpec> = {}): HarnessRunSpec {
  return {
    session_id: "s1",
    intent: "implement",
    prompt: "do it",
    cwd: "/repo",
    access: "workspace_write",
    external_context_policy: "auto",
    tool_permission_policy: { web: "auto", allow: [], deny: [] },
    model_hint: null,
    effort_hint: null,
    max_turns: null,
    auth_preference: "auto",
    resume_session_id: null,
    env: {},
    extra: {},
    ...over,
  } as HarnessRunSpec;
}

describe("claudeArgsForSpec --bare guard", () => {
  it("passes --bare normally but suppresses it on the subscription route (--bare disables OAuth)", () => {
    const s = spec({ extra: { bare: true } });
    expect(claudeArgsForSpec(s, false, false)).toContain("--bare");
    expect(claudeArgsForSpec(s, false, true)).not.toContain("--bare");
  });

  it("adds --resume <id> when resuming a native session", () => {
    const args = claudeArgsForSpec(spec({ resume_session_id: "sess-1" }));
    const i = args.indexOf("--resume");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("sess-1");
  });
});

describe("probeAuthStatus (JSON verdict beats exit code; probe failures are distinct)", () => {
  function fakeClaudeBin(dir: string, script: string): string {
    const bin = join(dir, "claude-fake");
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  it("trusts the typed loggedIn:false verdict even though the CLI exits 1", async () => {
    // Live behavior of claude 2.1.x: `auth status` prints the JSON verdict on
    // stdout and exits 1 when logged out — the exit code alone is not the verdict.
    const dir = mkdtempSync(join(tmpdir(), "claude-probe-"));
    try {
      const bin = fakeClaudeBin(dir, `echo '{"loggedIn": false, "authMethod": "none"}'; exit 1`);
      expect(await probeAuthStatus(bin)).toEqual({
        loggedIn: false,
        authed: false,
        authMethod: "none",
        probeError: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts only the exact claude.ai auth method", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-probe-"));
    try {
      const bin = fakeClaudeBin(
        dir,
        `echo '{"loggedIn": true, "authMethod": "claude.ai"}'; exit 0`,
      );
      expect(await probeAuthStatus(bin)).toEqual({
        loggedIn: true,
        authed: true,
        authMethod: "claude.ai",
        probeError: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a typed wrong auth method distinct from native subscription", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-probe-"));
    try {
      const bin = fakeClaudeBin(dir, `echo '{"loggedIn": true, "authMethod": "api_key"}'; exit 0`);
      expect(await probeAuthStatus(bin)).toEqual({
        loggedIn: true,
        authed: false,
        authMethod: "api_key",
        probeError: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failing probe without a JSON verdict is a PROBE ERROR, never silently logged-out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-probe-"));
    try {
      const bin = fakeClaudeBin(dir, `echo "Error: config corrupted" >&2; exit 1`);
      const r = await probeAuthStatus(bin);
      expect(r.authed).toBe(false);
      expect(r.loggedIn).toBe(false);
      expect(r.probeError).toContain("config corrupted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no typed JSON + exit 0 is a probe error, never native readiness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-probe-"));
    try {
      const bin = fakeClaudeBin(dir, `echo "Logged in"; exit 0`);
      const result = await probeAuthStatus(bin);
      expect(result).toMatchObject({ loggedIn: false, authed: false, authMethod: null });
      expect(result.probeError).toContain("Logged in");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses vendor-owned CLAUDE_CONFIG_DIR, preserves scoped HOME, and forwards hard cancellation", async () => {
    const controller = new AbortController();
    let captured: Record<string, unknown> | undefined;
    const result = await probeAuthStatus("/fake/claude", {
      env: {
        HOME: "/scoped/home",
        CLAUDE_CONFIG_DIR: "/must/not/win",
        ANTHROPIC_API_KEY: "secret",
      },
      abortSignal: controller.signal,
      runCapture: async (_cmd, _args, options) => {
        captured = options as unknown as Record<string, unknown>;
        return {
          code: 0,
          signal: null,
          stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
          stderr: "",
        };
      },
    });
    expect(result.authed).toBe(true);
    const env = captured?.env as Record<string, unknown>;
    expect(env.HOME).toBe("/scoped/home");
    expect(env.CLAUDE_CONFIG_DIR).toBe(defaultNativeClaudeConfigDir());
    expect(env.ANTHROPIC_API_KEY).toBeNull();
    expect(captured?.abortSignal).toBe(controller.signal);
    expect(captured?.cancelSignal).toBe("SIGTERM");
    expect(captured?.cancelKillDelayMs).toBe(0);
  });
});

describe("Claude readonly enforcement capability", () => {
  const nativeProbe = {
    loggedIn: true,
    authed: true,
    authMethod: "claude.ai",
    probeError: null,
  } as const;

  it("does not advertise readonly and degrades doctor when the CLI cannot prove the profile", async () => {
    const adapter = createClaudeAdapter({
      detectVersion: async () => "test-claude",
      probeReadonlyProfile: readonlyUnsupported,
      probeAuthStatus: async () => nativeProbe,
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
    });
    const manifest = await adapter.discover();
    expect(manifest.access_profiles_supported).not.toContain("readonly");
    expect(manifest.capability_profile.access_control.readonly_mechanism).toBe("none");

    const report = await adapter.doctor({
      cwd: "/repo",
      authPreference: "subscription",
      authSource: "native_session",
      fresh: true,
    });
    expect(report.status).toBe("degraded");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "readonly_enforcement",
        status: "fail",
      }),
    );
    expect(report.reasons).toContain("test readonly profile unavailable");
  });

  it("refuses a readonly run before auth resolution or CLI launch", async () => {
    let authReads = 0;
    let launches = 0;
    const adapter = createClaudeAdapter({
      detectVersion: async () => "test-claude",
      probeReadonlyProfile: readonlyUnsupported,
      probeAuthStatus: async () => {
        authReads += 1;
        return nativeProbe;
      },
      anthropicApiKey: () => {
        authReads += 1;
        return "must-not-read";
      },
      claudeOAuthToken: () => {
        authReads += 1;
        return "must-not-read";
      },
      runCliHarness: async function* (): AsyncGenerator<HarnessEvent> {
        launches += 1;
      },
    });
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(spec({ access: "readonly" }))) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["error", "completed"]);
    expect(events[0]).toMatchObject({
      error: expect.stringContaining("readonly enforcement is unavailable"),
      payload: { code: "readonly_enforcement_unavailable" },
    });
    expect(authReads).toBe(0);
    expect(launches).toBe(0);
  });
});

describe("Claude transport-aware source selection", () => {
  const nativeProbe = {
    loggedIn: true,
    authed: true,
    authMethod: "claude.ai",
    probeError: null,
  } as const;

  it("targeted native doctor does not resolve or smoke OAuth/API routes", async () => {
    let apiSecretReads = 0;
    let oauthSecretReads = 0;
    let smokeCalls = 0;
    let probeEnv: Record<string, string | null | undefined> | undefined;
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.165",
      probeReadonlyProfile: readonlySupported,
      probeAuthStatus: async (_bin, options) => {
        probeEnv = options?.env;
        return nativeProbe;
      },
      anthropicApiKey: () => {
        apiSecretReads += 1;
        return "api-key";
      },
      claudeOAuthToken: () => {
        oauthSecretReads += 1;
        return "oauth-token";
      },
      smokeIsolatedApiKey: async () => {
        smokeCalls += 1;
        return { ok: true, detail: "must not run" };
      },
      smokeIsolatedOAuthToken: async () => {
        smokeCalls += 1;
        return { ok: true, detail: "must not run" };
      },
    });

    const report = await adapter.doctor({
      cwd: "/repo",
      env: { HOME: "/scoped/home", CLAUDE_CONFIG_DIR: "/scoped/config" },
      authPreference: "subscription",
      authSource: "native_session",
      fresh: true,
    });

    expect(apiSecretReads).toBe(0);
    expect(oauthSecretReads).toBe(0);
    expect(smokeCalls).toBe(0);
    expect(probeEnv?.HOME).toBe("/scoped/home");
    expect(probeEnv?.CLAUDE_CONFIG_DIR).toBe(defaultNativeClaudeConfigDir());
    expect(report.auth_sources).toEqual([
      expect.objectContaining({
        source: "native_session",
        availability: "available",
        verification: "passed",
      }),
    ]);
  });

  it("declares config-file plus Keychain transport and prefers native source", async () => {
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.165",
      probeReadonlyProfile: readonlySupported,
      probeAuthStatus: async () => nativeProbe,
      anthropicApiKey: () => "api-key",
      claudeOAuthToken: () => "oauth-token",
    });
    await expect(adapter.discover()).resolves.toMatchObject({
      capability_profile: {
        auth: {
          preferred_source: "native_session",
          credential_transports: expect.arrayContaining([
            { source: "native_session", kind: "config_file", relocatable_by: ["CONFIG_DIR"] },
            { source: "native_session", kind: "os_keychain", relocatable_by: [] },
          ]),
        },
        isolation: { supported_containment: expect.arrayContaining(["host_user_context"]) },
      },
    });
  });

  it("never injects an OAuth token when exact native auth was selected", async () => {
    let cliOptions: CliRunLoopOptions | undefined;
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.165",
      probeReadonlyProfile: readonlySupported,
      probeAuthStatus: async () => nativeProbe,
      anthropicApiKey: () => "api-key",
      claudeOAuthToken: () => "oauth-token",
      runCliHarness: async function* (options: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        cliOptions = options;
        yield {
          type: "completed",
          session_id: options.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    for await (const _event of adapter.run(
      spec({
        env: { HOME: "/scoped/home", CLAUDE_CONFIG_DIR: "/scoped/config" },
        auth_preference: "auto",
      }),
    )) {
      // drain
    }

    expect(cliOptions?.env?.HOME).toBe("/scoped/home");
    expect(cliOptions?.env?.CLAUDE_CONFIG_DIR).toBe(defaultNativeClaudeConfigDir());
    expect(cliOptions?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeNull();
    expect(cliOptions?.env?.ANTHROPIC_API_KEY).toBeNull();
    const retry = cliOptions?.parseEvent?.(
      {
        type: "system",
        subtype: "api_retry",
        error: "rate limit",
        retry_delay_ms: 1_000,
      },
      "session-retry",
    );
    expect(retry?.find((event) => event.rate_limit)).toMatchObject({
      credential_route: "vendor_native",
      credential_source: "native_session",
      payload: { api_retry: true },
    });
  });

  it("selects the OAuth-token subscription source only after native is unavailable", async () => {
    let cliOptions: CliRunLoopOptions | undefined;
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.165",
      probeReadonlyProfile: readonlySupported,
      probeAuthStatus: async () => ({
        loggedIn: false,
        authed: false,
        authMethod: "none",
        probeError: null,
      }),
      anthropicApiKey: () => "api-key",
      claudeOAuthToken: () => "oauth-token",
      runCliHarness: async function* (options: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        cliOptions = options;
        yield {
          type: "completed",
          session_id: options.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    for await (const _event of adapter.run(
      spec({
        env: { HOME: "/scoped/home", CLAUDE_CONFIG_DIR: "/scoped/config" },
        auth_preference: "auto",
      }),
    )) {
      // drain
    }

    expect(cliOptions?.env?.CLAUDE_CONFIG_DIR).toBe("/scoped/config");
    expect(cliOptions?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(cliOptions?.env?.ANTHROPIC_API_KEY).toBeNull();
  });

  it("reports a typed wrong native auth method as available but failed", () => {
    const sources = claudeAuthSourceReadiness({
      native: { loggedIn: true, authed: false, authMethod: "api_key", probeError: null },
      oauthAvailable: false,
      oauthVerification: "not_run",
      oauthDetail: "none",
      apiKeyAvailable: false,
      apiKeyVerification: "not_run",
      apiKeyDetail: "none",
    });
    expect(sources[0]).toMatchObject({
      source: "native_session",
      availability: "available",
      verification: "failed",
    });
  });
});
