import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import type { CliRunLoopOptions } from "@claudexor/core";
import { createClaudeAdapter } from "./index.js";
import {
  CLAUDE_PROMPT_CACHE_TTL_ENV,
  claudePromptCacheObserver,
  claudePromptCacheOverrides,
  withClaudePromptCacheTtl,
} from "./prompt-cache.js";

const [MAIN_ENV, HELPER_ENV] = CLAUDE_PROMPT_CACHE_TTL_ENV;

function spec(over: Partial<HarnessRunSpec> = {}): HarnessRunSpec {
  return HarnessRunSpec.parse({
    session_id: "s1",
    intent: "implement",
    prompt: "do it",
    cwd: "/repo",
    access: "workspace_write",
    // `clean` keeps the daemon's own environment out of the disclosure checks.
    env_inheritance: "clean",
    ...over,
  });
}

const init = (version?: unknown) => ({
  type: "system",
  subtype: "init",
  mcp_servers: [],
  ...(version === undefined ? {} : { claude_code_version: version }),
});
const result = (cacheCreation?: unknown) => ({
  type: "result",
  subtype: "success",
  usage: {
    input_tokens: 3,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 10,
    ...(cacheCreation === undefined ? {} : { cache_creation: cacheCreation }),
  },
});
const started = (): HarnessEvent[] => [{ type: "started", session_id: "s1", ts: "t" }];
const usage = (): HarnessEvent[] => [{ type: "usage", session_id: "s1", ts: "t" }];

describe("Claude prompt-cache lifetime translation", () => {
  it("Default adds and removes nothing", () => {
    const original = spec({ env: { FORCE_PROMPT_CACHING_5M: "1", [MAIN_ENV]: "5m" } });
    const translated = withClaudePromptCacheTtl(original);
    expect(translated).toBe(original);
    expect(translated.env).toEqual({ FORCE_PROMPT_CACHING_5M: "1", [MAIN_ENV]: "5m" });
  });

  it("an explicit lifetime governs both buckets and keeps every other variable", () => {
    for (const ttl of ["5m", "1h"] as const) {
      const translated = withClaudePromptCacheTtl(
        spec({ prompt_cache_ttl: ttl, env: { FORCE_PROMPT_CACHING_5M: "1", [MAIN_ENV]: "x" } }),
      );
      expect(translated.env).toEqual({
        FORCE_PROMPT_CACHING_5M: "1",
        [MAIN_ENV]: ttl,
        [HELPER_ENV]: ttl,
      });
    }
  });
});

describe("Claude prompt-cache override evidence uses the CLI's own value semantics", () => {
  it("FORCE_PROMPT_CACHING_5M counts only when truthy and only against 1h", () => {
    for (const value of ["1", "true", "YES", " on "]) {
      expect(claudePromptCacheOverrides("1h", null, { FORCE_PROMPT_CACHING_5M: value })).toEqual([
        "FORCE_PROMPT_CACHING_5M is set, which forces 5m for both buckets",
      ]);
      expect(claudePromptCacheOverrides("5m", null, { FORCE_PROMPT_CACHING_5M: value })).toEqual(
        [],
      );
    }
    for (const value of ["0", "false", "off", "", "2"])
      expect(claudePromptCacheOverrides("1h", null, { FORCE_PROMPT_CACHING_5M: value })).toEqual(
        [],
      );
  });

  it("DISABLE_PROMPT_CACHING covers every model; a family variable only its bare alias", () => {
    expect(
      claudePromptCacheOverrides("5m", "claude-opus-5-5", { DISABLE_PROMPT_CACHING: "1" }),
    ).toEqual(["DISABLE_PROMPT_CACHING is set, which disables prompt caching for every model"]);
    expect(
      claudePromptCacheOverrides("1h", "sonnet", { DISABLE_PROMPT_CACHING_SONNET: "true" }),
    ).toEqual([
      "DISABLE_PROMPT_CACHING_SONNET is set, which disables prompt caching for the sonnet alias model",
    ]);
    // Applicability is unknown for a full id, the vendor default model or Fable.
    for (const model of ["claude-sonnet-5-5", null, "opus"])
      expect(
        claudePromptCacheOverrides("1h", model, { DISABLE_PROMPT_CACHING_SONNET: "1" }),
      ).toEqual([]);
    expect(
      claudePromptCacheOverrides("1h", "fable", { DISABLE_PROMPT_CACHING_FABLE: "1" }),
    ).toEqual([]);
    expect(
      claudePromptCacheOverrides("1h", "haiku", { DISABLE_PROMPT_CACHING_HAIKU: "0" }),
    ).toEqual([]);
  });
});

describe("Claude prompt-cache receipt", () => {
  it("Default reports the observed split without a request or disclosure", () => {
    const observe = claudePromptCacheObserver(spec());
    const first = observe(init("2.1.305"), started(), "s1")!;
    expect(first).toHaveLength(1);
    expect(first[0]!.prompt_cache_ttl).toEqual({
      requested: null,
      submitted: null,
      reason: null,
      observed: "unknown",
      write_5m_tokens: null,
      write_1h_tokens: null,
    });
    const usageEvent = observe(
      result({ ephemeral_1h_input_tokens: 14560, ephemeral_5m_input_tokens: 0 }),
      usage(),
      "s1",
    )![0]!;
    expect(usageEvent.prompt_cache_ttl).toMatchObject({
      requested: null,
      observed: "1h",
      write_1h_tokens: 14560,
      write_5m_tokens: 0,
    });
  });

  it("discloses a forcing control once, on the first init, as an ignored setting", () => {
    const observe = claudePromptCacheObserver(
      spec({ prompt_cache_ttl: "1h", env: { FORCE_PROMPT_CACHING_5M: "1" } }),
    );
    const events = observe(init("2.1.305"), started(), "s1")!;
    const detail =
      "prompt_cache_ttl=1h (FORCE_PROMPT_CACHING_5M is set, which forces 5m for both buckets)";
    expect(events[1]).toMatchObject({
      type: "status",
      text: `[prompt-cache] ignored: ${detail}`,
      payload: { ignored_settings: [detail] },
    });
    expect(events[0]!.prompt_cache_ttl).toMatchObject({
      requested: "1h",
      submitted: "1h",
      reason: "FORCE_PROMPT_CACHING_5M is set, which forces 5m for both buckets",
    });
    // A later native turn in the same process re-sends init; nothing repeats.
    expect(observe(init("2.1.305"), [], "s1")).toEqual([]);
  });

  it("keeps the disclosure even when the init frame parsed to no events", () => {
    const disclosed = claudePromptCacheObserver(
      spec({ prompt_cache_ttl: "1h", env: { DISABLE_PROMPT_CACHING: "yes" } }),
    )(init("2.1.305"), null, "s1");
    expect(disclosed?.map((event) => event.type)).toEqual(["status"]);
    expect(claudePromptCacheObserver(spec())(init("2.1.305"), null, "s1")).toBeNull();
  });

  it("a forcing 5m control is consistent with a 5m request and stays silent", () => {
    const observe = claudePromptCacheObserver(
      spec({ prompt_cache_ttl: "5m", env: { FORCE_PROMPT_CACHING_5M: "1" } }),
    );
    const events = observe(init("2.1.305"), started(), "s1")!;
    expect(events).toHaveLength(1);
    expect(events[0]!.prompt_cache_ttl?.reason).toBeNull();
  });

  it("a known older CLI is disclosed; an unknown version proves nothing", () => {
    const old = claudePromptCacheObserver(spec({ prompt_cache_ttl: "1h" }));
    const oldEvents = old(init("2.1.200 (Claude Code)"), started(), "s1")!;
    expect(oldEvents[1]?.payload?.["ignored_settings"]).toEqual([
      "prompt_cache_ttl=1h (claude CLI 2.1.200 (Claude Code) predates 2.1.242, the first release that reads CLAUDE_CODE_PROMPT_CACHE_TTL and CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL)",
    ]);
    for (const version of ["2.1.242", "2.2.0", "3.0.1", undefined, "", "dev-build", 42]) {
      const observe = claudePromptCacheObserver(spec({ prompt_cache_ttl: "1h" }));
      const events = observe(init(version), started(), "s1")!;
      expect(events).toHaveLength(1);
      expect(events[0]!.prompt_cache_ttl).toMatchObject({ submitted: "1h", reason: null });
    }
  });

  it("zero writes are none; a missing split is unknown and cannot be revived", () => {
    const observe = claudePromptCacheObserver(spec({ prompt_cache_ttl: "5m" }));
    observe(init("2.1.305"), started(), "s1");
    const none = observe(
      result({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }),
      usage(),
      "s1",
    )![0]!.prompt_cache_ttl;
    expect(none).toMatchObject({ observed: "none", write_5m_tokens: 0, write_1h_tokens: 0 });
    const missing = observe(result(), usage(), "s1")![0]!.prompt_cache_ttl;
    expect(missing).toMatchObject({
      observed: "unknown",
      write_5m_tokens: null,
      write_1h_tokens: null,
    });
    const later = observe(
      result({ ephemeral_1h_input_tokens: 4, ephemeral_5m_input_tokens: 0 }),
      usage(),
      "s1",
    )![0]!.prompt_cache_ttl;
    expect(later?.observed).toBe("unknown");
    expect(
      observe(result({ ephemeral_1h_input_tokens: -1, ephemeral_5m_input_tokens: 0 }), null, "s1"),
    ).toBeNull();
  });

  it("sums results and reports a mixed split", () => {
    const observe = claudePromptCacheObserver(spec({ prompt_cache_ttl: "1h" }));
    observe(result({ ephemeral_1h_input_tokens: 7, ephemeral_5m_input_tokens: 0 }), usage(), "s1");
    const mixed = observe(
      result({ ephemeral_1h_input_tokens: 3, ephemeral_5m_input_tokens: 2 }),
      usage(),
      "s1",
    )![0]!.prompt_cache_ttl;
    expect(mixed).toMatchObject({ observed: "mixed", write_1h_tokens: 10, write_5m_tokens: 2 });
  });
});

describe("Claude adapter declares the translated lifetimes", () => {
  it("on the static profile and the discovered manifest", async () => {
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.305 (Claude Code)",
      probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
      probeEffortLevels: async () => ({ levels: [], live: true }),
      probeAuthStatus: async () => ({
        loggedIn: true,
        authed: true,
        authMethod: "claude.ai",
        probeError: null,
      }),
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
    });
    expect(adapter.capabilityProfile?.prompt_cache_ttls).toEqual(["5m", "1h"]);
    expect((await adapter.discover()).capability_profile.prompt_cache_ttls).toEqual(["5m", "1h"]);
  });
});

describe("Claude adapter spawn carries the lifetime on every route", () => {
  const nativeProbe = {
    loggedIn: true,
    authed: true,
    authMethod: "claude.ai",
    probeError: null,
  } as const;

  async function launch(over: Partial<HarnessRunSpec>): Promise<CliRunLoopOptions> {
    let captured: CliRunLoopOptions | undefined;
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.305",
      probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
      probeAuthStatus: async () => nativeProbe,
      anthropicApiKey: () => "sk-ant-test-key",
      claudeOAuthToken: () => null,
      probeEffortLevels: async () => ({ levels: [], live: true }),
      runCliHarness: async function* (options: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        captured = options;
        yield { type: "completed", session_id: options.spec.session_id, ts: "t" };
      },
    });
    for await (const _event of adapter.run(spec(over))) {
      // drain
    }
    if (!captured) throw new Error("the adapter did not launch the CLI");
    return captured;
  }

  it("native subscription, API-key and readonly spawns set both variables; Default sets none", async () => {
    for (const over of [
      { auth_preference: "subscription" as const },
      { auth_preference: "api_key" as const },
      { auth_preference: "subscription" as const, access: "readonly" as const },
    ]) {
      const explicit = await launch({ ...over, prompt_cache_ttl: "1h" });
      expect(explicit.env?.[MAIN_ENV]).toBe("1h");
      expect(explicit.env?.[HELPER_ENV]).toBe("1h");
      const defaulted = await launch(over);
      expect(defaulted.env).not.toHaveProperty(MAIN_ENV);
      expect(defaulted.env).not.toHaveProperty(HELPER_ENV);
    }
  });

  it("stamps the observed split of a recorded 2.1.283 stream on its usage events", async () => {
    const options = await launch({ auth_preference: "subscription", prompt_cache_ttl: "1h" });
    const frames = readFileSync(
      new URL("../fixtures/stream-json/recorded-live-final-text-2.1.283.jsonl", import.meta.url),
      "utf8",
    )
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { direction: string; frame: unknown })
      .filter((line) => line.direction === "cli->client")
      .map((line) => line.frame);
    const events = frames.flatMap((frame) => options.parseEvent?.(frame as never, "s1") ?? []);
    const receipts = events
      .filter((event) => event.type === "usage")
      .map((event) => event.prompt_cache_ttl);
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts.at(-1)).toMatchObject({
      requested: "1h",
      submitted: "1h",
      reason: null,
      observed: "1h",
    });
    expect(receipts.at(-1)?.write_1h_tokens).toBeGreaterThan(0);
    expect(receipts.at(-1)?.write_5m_tokens).toBe(0);
    expect(events.find((event) => event.type === "started")?.prompt_cache_ttl).toMatchObject({
      observed: "unknown",
    });
  });
});
