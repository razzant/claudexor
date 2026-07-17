import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialProfile, HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import type { CliRunLoopOptions } from "@claudexor/core";
import { createClaudeAdapter } from "./index.js";
import { canonicalProfileConfigDir } from "./profile.js";

const readonlySupported = async () => ({
  supported: true,
  missingFlags: [],
  detail: "test readonly profile supported",
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

function profile(over: Partial<CredentialProfile> = {}): CredentialProfile {
  return {
    profile_id: "work",
    harness_id: "claude",
    display_name: "Work",
    credential_kind: "config_dir_login",
    isolation_locator: "/tmp/claudexor-test-profile-dir",
    secret_ref: null,
    enabled: true,
    created_at: null,
    ...over,
  } as CredentialProfile;
}

// The round-11 confinement requires locators under ~/.claudexor — tests
// exercise the REAL discipline, not a bypass.
const ownedTmp = join(homedir(), ".claudexor", "test-tmp");
mkdirSync(ownedTmp, { recursive: true });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("canonicalProfileConfigDir (INV-135)", () => {
  it("refuses relative paths", () => {
    expect(() => canonicalProfileConfigDir("relative/dir")).toThrow(/absolute/);
  });

  it("refuses the default native Claude dir and any dir outside ~/.claudexor", () => {
    // ~/.claude is outside the Claudexor-owned tree: the confinement fires
    // first (also covering arbitrary user/repo dirs).
    expect(() => canonicalProfileConfigDir(join(homedir(), ".claude"))).toThrow(/must live under/);
    expect(() => canonicalProfileConfigDir("/tmp/anywhere")).toThrow(/must live under/);
  });

  it("resolves symlinked existing dirs to one canonical path", () => {
    const dir = mkdtempSync(join(ownedTmp, "claudexor-profile-"));
    dirs.push(dir);
    expect(canonicalProfileConfigDir(`${dir}/`)).toBe(canonicalProfileConfigDir(dir));
  });
});

describe("Claude strict profile routing (INV-135)", () => {
  it("config_dir_login runs with CLAUDE_CONFIG_DIR = the profile dir and stamps the profile on events", async () => {
    const dir = mkdtempSync(join(ownedTmp, "claudexor-profile-"));
    dirs.push(dir);
    let probedEnv: Record<string, string | null | undefined> | undefined;
    let runEnv: Record<string, string | null | undefined> | undefined;
    let stamped: HarnessEvent | undefined;
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.165",
      probeReadonlyProfile: readonlySupported,
      probeAuthStatus: async (_bin, options) => {
        probedEnv = options?.env;
        return { loggedIn: true, authed: true, authMethod: "claude.ai", probeError: null };
      },
      anthropicApiKey: () => {
        throw new Error("default key ladder must not run under a profile");
      },
      claudeOAuthToken: () => {
        throw new Error("default token ladder must not run under a profile");
      },
      resolveProfileSecret: () => null,
      runCliHarness: async function* (options: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        runEnv = options.env;
        const out = options.parseEvent?.(
          { type: "system", subtype: "init", session_id: "n1" },
          "s1",
        );
        for (const ev of out ?? []) {
          stamped = ev;
          yield ev;
        }
        yield { type: "completed", session_id: "s1", ts: new Date().toISOString() };
      },
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({ credential_profile: profile({ isolation_locator: dir }) }),
    ))
      events.push(ev);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(probedEnv?.CLAUDE_CONFIG_DIR).toBe(canonicalProfileConfigDir(dir));
    expect(runEnv?.CLAUDE_CONFIG_DIR).toBe(canonicalProfileConfigDir(dir));
    expect(stamped?.credential_profile_id).toBe("work");
    expect(stamped?.credential_route).toBe("vendor_native");
  });

  it("config_dir_login with no verified login refuses typed — no fallback to the default ladder", async () => {
    const dir = mkdtempSync(join(ownedTmp, "claudexor-profile-"));
    dirs.push(dir);
    let launches = 0;
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.165",
      probeReadonlyProfile: readonlySupported,
      probeAuthStatus: async () => ({
        loggedIn: false,
        authed: false,
        authMethod: null,
        probeError: null,
      }),
      anthropicApiKey: () => {
        throw new Error("default key ladder must not run under a profile");
      },
      claudeOAuthToken: () => {
        throw new Error("default token ladder must not run under a profile");
      },
      resolveProfileSecret: () => null,
      runCliHarness: async function* (): AsyncGenerator<HarnessEvent> {
        launches += 1;
      },
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({ credential_profile: profile({ isolation_locator: dir }) }),
    ))
      events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["error", "completed"]);
    expect((events[0] as { error?: string }).error).toContain('credential profile "work"');
    expect(launches).toBe(0);
  });

  it("oauth_token profile injects the namespaced secret and NEVER passes --bare", async () => {
    let runArgs: string[] | undefined;
    let runEnv: Record<string, string | null | undefined> | undefined;
    const reads: string[] = [];
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.165",
      probeReadonlyProfile: readonlySupported,
      probeAuthStatus: async () => {
        throw new Error("no native probe for a token profile");
      },
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
      resolveProfileSecret: (ref) => {
        reads.push(ref);
        return ref === "claude_oauth:work" ? "sk-token-value" : null;
      },
      runCliHarness: async function* (options: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        runArgs = options.args;
        runEnv = options.env;
        yield { type: "completed", session_id: "s1", ts: new Date().toISOString() };
      },
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({
        credential_profile: profile({
          credential_kind: "oauth_token",
          isolation_locator: null,
          secret_ref: "claude_oauth:work",
        }),
        // W5.2 sol #24 conformance: a token profile is non-bare ONLY — even a
        // caller-requested bare must not disable OAuth for this route.
        extra: { bare: true },
      }),
    ))
      events.push(ev);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(reads).toEqual(["claude_oauth:work"]);
    expect(runEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-token-value");
    expect(runArgs).not.toContain("--bare");
  });

  it("secret refs are provider-BOUND — a claude profile cannot read another vendor's slot", async () => {
    const reads: string[] = [];
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.165",
      probeReadonlyProfile: readonlySupported,
      probeAuthStatus: async () => {
        throw new Error("no native probe for a secret-ref profile");
      },
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
      resolveProfileSecret: (ref) => {
        reads.push(ref);
        return "leaked-key";
      },
      runCliHarness: async function* (): AsyncGenerator<HarnessEvent> {},
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({
        credential_profile: profile({
          credential_kind: "api_key",
          isolation_locator: null,
          secret_ref: "openai:work",
        }),
      }),
    ))
      events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["error", "completed"]);
    expect((events[0] as { error?: string }).error).toContain("anthropic slot");
    // The foreign slot is never even read.
    expect(reads).toEqual([]);
  });

  it("api_key profile with an unstored secret refuses typed", async () => {
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.165",
      probeReadonlyProfile: readonlySupported,
      probeAuthStatus: async () => {
        throw new Error("no native probe for a key profile");
      },
      anthropicApiKey: () => {
        throw new Error("default key ladder must not run under a profile");
      },
      claudeOAuthToken: () => null,
      resolveProfileSecret: () => null,
      runCliHarness: async function* (): AsyncGenerator<HarnessEvent> {},
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({
        credential_profile: profile({
          credential_kind: "api_key",
          isolation_locator: null,
          secret_ref: "anthropic:work",
        }),
      }),
    ))
      events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["error", "completed"]);
    expect((events[0] as { error?: string }).error).toContain('"anthropic:work"');
  });
});

describe("Claude credential-profile doctor probe (INV-135)", () => {
  it("reports a verified config-dir login as available/passed against the profile env", async () => {
    const dir = mkdtempSync(join(ownedTmp, "claudexor-profile-"));
    dirs.push(dir);
    let probedEnv: Record<string, string | null | undefined> | undefined;
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.165",
      probeReadonlyProfile: readonlySupported,
      probeAuthStatus: async (_bin, options) => {
        probedEnv = options?.env;
        return { loggedIn: true, authed: true, authMethod: "claude.ai", probeError: null };
      },
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
      resolveProfileSecret: () => null,
    });
    const status = await adapter.probeCredentialProfile!(profile({ isolation_locator: dir }));
    expect(status).toMatchObject({
      profile_id: "work",
      harness_id: "claude",
      availability: "available",
      verification: "passed",
    });
    expect(status.last_verified_at).not.toBeNull();
    expect(probedEnv?.CLAUDE_CONFIG_DIR).toBe(canonicalProfileConfigDir(dir));
  });

  it("a foreign or bare slot is unavailable at PROBE time — never admitted then refused at run (round-15 #4)", async () => {
    const reads: string[] = [];
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.165",
      probeReadonlyProfile: readonlySupported,
      probeAuthStatus: async () => {
        throw new Error("no native probe for a secret-ref profile");
      },
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
      resolveProfileSecret: (ref) => {
        reads.push(ref);
        return "stored-anyway";
      },
    });
    for (const secret_ref of ["openai:work", "anthropic", "claude_oauth:work"]) {
      const status = await adapter.probeCredentialProfile!(
        profile({ credential_kind: "api_key", isolation_locator: null, secret_ref }),
      );
      expect(status).toMatchObject({ availability: "unavailable", verification: "failed" });
      expect(status.detail).toContain("anthropic slot");
    }
    // The mis-bound slots are never even read.
    expect(reads).toEqual([]);
  });

  it("reports secret-ref presence without claiming liveness", async () => {
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.165",
      probeReadonlyProfile: readonlySupported,
      probeAuthStatus: async () => {
        throw new Error("no native probe for a secret-ref profile");
      },
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
      resolveProfileSecret: (ref) => (ref === "anthropic:work" ? "sk" : null),
    });
    const stored = await adapter.probeCredentialProfile!(
      profile({
        credential_kind: "api_key",
        isolation_locator: null,
        secret_ref: "anthropic:work",
      }),
    );
    expect(stored).toMatchObject({ availability: "available", verification: "not_run" });
    const missing = await adapter.probeCredentialProfile!(
      profile({
        credential_kind: "api_key",
        isolation_locator: null,
        secret_ref: "anthropic:gone",
      }),
    );
    expect(missing).toMatchObject({ availability: "unavailable", verification: "not_run" });
  });
});
