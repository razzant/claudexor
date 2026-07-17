import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialProfile, HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import type { CliRunLoopOptions } from "@claudexor/core";
import { createCodexAdapter } from "./index.js";
import { canonicalCodexProfileHome } from "./profile.js";
import { defaultNativeCodexHome, probeLogin } from "./auth.js";

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
    profile_id: "acc2",
    harness_id: "codex",
    display_name: "Second",
    credential_kind: "config_dir_login",
    isolation_locator: "/tmp/claudexor-test-codex-home",
    secret_ref: null,
    enabled: true,
    created_at: null,
    ...over,
  } as CredentialProfile;
}

// Under the vitest CLAUDEXOR_CONFIG_DIR sandbox the override IS the
// confinement root (round-18 #4).
const ownedTmp = join(process.env.CLAUDEXOR_CONFIG_DIR as string, "test-tmp");
mkdirSync(ownedTmp, { recursive: true });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("canonicalCodexProfileHome (INV-135)", () => {
  it("refuses relative paths, out-of-tree paths, and the default native home", () => {
    expect(() => canonicalCodexProfileHome("relative/home")).toThrow(/absolute/);
    expect(() => canonicalCodexProfileHome("/tmp/anywhere")).toThrow(/must live under/);
    // Under the vitest temp CLAUDEXOR_CONFIG_DIR the default home sits outside
    // ~/.claudexor, so the confinement is what refuses it; the must-not-be-
    // default arm fires when the default lives inside the owned tree.
    expect(() => canonicalCodexProfileHome(defaultNativeCodexHome())).toThrow(
      /must live under|must not be the default/,
    );
  });
});

describe("the REAL login probe inspects the profile's own store (round-17 BLOCK)", () => {
  // Integration through the PRODUCTION probeLogin (runCapture seam): the
  // probe re-normalizes its env, so only the CHILD env proves which CODEX_HOME
  // was actually inspected — a stubbed probe cannot.
  const childEnvs: Array<Record<string, string | null | undefined>> = [];
  const realProbe: typeof probeLogin = (bin, options) =>
    probeLogin(bin, {
      ...options,
      runCapture: async (_cmd, _args, opts) => {
        childEnvs.push((opts?.env ?? {}) as Record<string, string | null | undefined>);
        return { code: 0, signal: null, stdout: "Logged in using ChatGPT\n", stderr: "" };
      },
    });

  it("a config_dir_login profile probe reaches the child with the PROFILE home, not the default", async () => {
    const home = mkdtempSync(join(ownedTmp, "claudexor-codex-profile-"));
    dirs.push(home);
    childEnvs.length = 0;
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex 0.1-test",
      probeLogin: realProbe,
      resolveProfileSecret: () => null,
    });
    const status = await adapter.probeCredentialProfile!(profile({ isolation_locator: home }));
    expect(status).toMatchObject({ availability: "available", verification: "passed" });
    expect(childEnvs).toHaveLength(1);
    expect(childEnvs[0]?.CODEX_HOME).toBe(canonicalCodexProfileHome(home));
  });

  it("without an explicit codexHome the probe still normalizes to the DEFAULT native home", async () => {
    childEnvs.length = 0;
    await realProbe("codex-test-bin", { env: { SOME_VAR: "x" } });
    expect(childEnvs).toHaveLength(1);
    expect(childEnvs[0]?.CODEX_HOME).toBe(defaultNativeCodexHome());
  });
});

describe("Codex strict profile routing (INV-135)", () => {
  it("config_dir_login runs with CODEX_HOME = the profile home and stamps the profile on events", async () => {
    const home = mkdtempSync(join(ownedTmp, "claudexor-codex-profile-"));
    dirs.push(home);
    let probedEnv: Record<string, string | null | undefined> | undefined;
    let runEnv: Record<string, string | null | undefined> | undefined;
    let stamped: HarnessEvent | undefined;
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex 0.1-test",
      probeLogin: async (_bin, options) => {
        probedEnv = options?.env;
        return { authed: true, method: "chatgpt", probeError: null };
      },
      codexApiKey: () => {
        throw new Error("default key ladder must not run under a profile");
      },
      resolveProfileSecret: () => null,
      runCliHarness: async function* (options: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        runEnv = options.env;
        const out = options.parseEvent?.({ type: "thread.started", thread_id: "t1" }, "s1");
        for (const ev of out ?? []) {
          stamped = ev;
          yield ev;
        }
        yield { type: "completed", session_id: "s1", ts: new Date().toISOString() };
      },
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({ credential_profile: profile({ isolation_locator: home }) }),
    ))
      events.push(ev);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(probedEnv?.CODEX_HOME).toBe(canonicalCodexProfileHome(home));
    expect(runEnv?.CODEX_HOME).toBe(canonicalCodexProfileHome(home));
    expect(stamped?.credential_profile_id).toBe("acc2");
    expect(stamped?.credential_route).toBe("vendor_native");
  });

  it("a profiled run's quota windows are stamped with THE PROFILE subject (round-17 #2)", async () => {
    const home = mkdtempSync(join(ownedTmp, "claudexor-codex-profile-"));
    dirs.push(home);
    // Rollout fixture in the PROFILE home: the vendor record carries no
    // subject of its own, so an unstamped attach would register the windows
    // under the engine-default subject.
    const threadId = "0199aaaa-bbbb-cccc-dddd-eeeeffff0001";
    const day = join(home, "sessions", "2026", "07", "17");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, `rollout-2026-07-17T00-00-00-${threadId}.jsonl`),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 55, window_minutes: 300, resets_at: 1782368577 },
          },
        },
      }) + "\n",
    );
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex 0.1-test",
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      resolveProfileSecret: () => null,
      runCliHarness: async function* (options: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        for (const raw of [
          { type: "thread.started", thread_id: threadId },
          { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
        ]) {
          for (const ev of options.parseEvent?.(raw, "s1") ?? []) yield ev;
        }
        yield { type: "completed", session_id: "s1", ts: new Date().toISOString() };
      },
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({ credential_profile: profile({ isolation_locator: home }) }),
    ))
      events.push(ev);
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.quota?.source).toBe("codex_rollout");
    expect(usage?.quota?.subject_id).toBe("acc2");
  });

  it("config_dir_login without a ChatGPT login refuses typed — no fallback", async () => {
    const home = mkdtempSync(join(ownedTmp, "claudexor-codex-profile-"));
    dirs.push(home);
    let launches = 0;
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex 0.1-test",
      probeLogin: async () => ({ authed: false, method: "logged_out", probeError: null }),
      codexApiKey: () => {
        throw new Error("default key ladder must not run under a profile");
      },
      resolveProfileSecret: () => null,
      runCliHarness: async function* (): AsyncGenerator<HarnessEvent> {
        launches += 1;
      },
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({ credential_profile: profile({ isolation_locator: home }) }),
    ))
      events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["error", "completed"]);
    expect((events[0] as { error?: string }).error).toContain('credential profile "acc2"');
    expect(launches).toBe(0);
  });

  it("oauth_token profiles are a typed refusal — codex has no such transport", async () => {
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex 0.1-test",
      probeLogin: async () => {
        throw new Error("no login probe for an unsupported transport");
      },
      resolveProfileSecret: () => "never-used",
      runCliHarness: async function* (): AsyncGenerator<HarnessEvent> {},
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({
        credential_profile: profile({
          credential_kind: "oauth_token",
          isolation_locator: null,
          secret_ref: "openai:acc2",
        }),
      }),
    ))
      events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["error", "completed"]);
    expect((events[0] as { error?: string }).error).toContain("does not support the oauth_token");
  });

  it("a foreign or bare slot is unavailable at PROBE time — never admitted then refused at run (round-15 #4)", async () => {
    const reads: string[] = [];
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex 0.1-test",
      probeLogin: async () => {
        throw new Error("no native probe for a key profile");
      },
      resolveProfileSecret: (ref) => {
        reads.push(ref);
        return "stored-anyway";
      },
    });
    for (const secret_ref of ["anthropic:acc2", "openai"]) {
      const status = await adapter.probeCredentialProfile!(
        profile({ credential_kind: "api_key", isolation_locator: null, secret_ref }),
      );
      expect(status).toMatchObject({ availability: "unavailable", verification: "failed" });
      expect(status.detail).toContain("openai slot");
    }
    // The mis-bound slots are never even read.
    expect(reads).toEqual([]);
  });

  it("api_key profile seeds a scoped auth.json from exactly the namespaced secret", async () => {
    let runEnv: Record<string, string | null | undefined> | undefined;
    const reads: string[] = [];
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex 0.1-test",
      probeLogin: async () => {
        throw new Error("no native probe for a key profile");
      },
      codexApiKey: () => {
        throw new Error("default key ladder must not run under a profile");
      },
      resolveProfileSecret: (ref) => {
        reads.push(ref);
        return ref === "openai:acc2" ? "sk-profile-key" : null;
      },
      runCliHarness: async function* (options: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        runEnv = options.env;
        yield { type: "completed", session_id: "s1", ts: new Date().toISOString() };
      },
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({
        credential_profile: profile({
          credential_kind: "api_key",
          isolation_locator: null,
          secret_ref: "openai:acc2",
        }),
      }),
    ))
      events.push(ev);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(reads).toEqual(["openai:acc2"]);
    const home = runEnv?.CODEX_HOME;
    expect(typeof home).toBe("string");
    if (typeof home === "string") {
      expect(home).not.toBe(defaultNativeCodexHome());
      dirs.push(home);
    }
  });
});
