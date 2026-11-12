import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HarnessUnavailableError,
  composeSpawnEnv,
  validateTypedStream,
  type CliRunLoopOptions,
} from "@claudexor/core";
import { HarnessRunSpec, type CredentialProfile, type HarnessEvent } from "@claudexor/schema";
import { userConfigDir } from "@claudexor/util";
import { createGrokAdapter } from "./index.js";
import { grokProfileEnv, grokRouteEnv } from "./profile.js";
import { parseGrokModels } from "./models.js";
import { resolveGrokBin } from "./bin.js";

const profile: CredentialProfile = {
  profile_id: "grok-test",
  harness_id: "grok",
  display_name: "test",
  credential_kind: "config_dir_login",
  isolation_locator: join(userConfigDir(), "profiles", "grok-test"),
  secret_ref: null,
  enabled: true,
  created_at: null,
};
const ready = async () => ({ authenticated: true, models: [], detail: "vendor confirmed" });
const spec = (extra = {}) =>
  HarnessRunSpec.parse({
    session_id: "s",
    intent: "implement",
    cwd: process.cwd(),
    prompt: "hello",
    credential_profile: profile,
    ...extra,
  });
const collect = async (events: AsyncIterable<HarnessEvent>) => {
  const out = [];
  for await (const event of events) out.push(event);
  return out;
};

describe("Grok adapter routes", () => {
  it("transports a large prompt exactly and removes its private file after failure", async () => {
    const prompt = "Unicode: Привет\r\n`$()\n" + "x".repeat(100_000);
    // System-level rules keep their own native channel and exact bytes; the
    // task file carries only the task (Grok documents no rules-file form).
    const instructions = "  Rules: Привет\r\nkeep `$()` literal\n";
    let path = "";
    const adapter = createGrokAdapter({
      probeLogin: ready,
      runCli: async function* (opts) {
        path = opts.args[opts.args.indexOf("--prompt-file") + 1]!;
        expect(readFileSync(path, "utf8")).toBe(prompt);
        expect(opts.args).not.toContain(prompt);
        expect(opts.args[opts.args.indexOf("--rules") + 1]).toBe(instructions);
        throw new Error("native failure");
      },
    });
    await expect(collect(adapter.run(spec({ prompt, instructions })))).rejects.toThrow(
      "native failure",
    );
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a vendor init that exposes tools outside the scoped allowlist", async () => {
    const adapter = createGrokAdapter({
      probeLogin: ready,
      runCli: async function* (opts) {
        const events = opts.parseEvent(
          {
            type: "system",
            subtype: "init",
            tools: ["read_file", "run_terminal_command"],
            permissionMode: "dontAsk",
          },
          opts.spec.session_id,
        )!;
        expect(opts.stopAfterEvent?.(events[0]!)).toBe(true);
        yield* events;
      },
    });
    const events = await collect(adapter.run(spec({ access: "readonly" })));
    expect(events.find((event) => event.type === "error")?.payload?.code).toBe(
      "grok_access_policy_unconfirmed",
    );
  });
  it("honors an unavailable override rather than finding a different install", () => {
    const resolve = vi.fn(() => "/installed/grok");
    expect(resolveGrokBin({ CLAUDEXOR_GROK_BIN: "/missing/grok" }, resolve)).toBe("/missing/grok");
    expect(resolve).not.toHaveBeenCalled();
    expect(resolveGrokBin({}, resolve)).toBe("grok");
    expect(resolve).toHaveBeenCalledWith("grok");
    // Folder expansion belongs to the shared resolver; an unproved alias never replaces grok.
    expect(resolveGrokBin({}, (bin) => (bin === "grok" ? null : bin))).toBe("grok");
  });

  it("lists exact native model ids without duplicates", () => {
    expect(
      parseGrokModels(
        "You are logged in with grok.com.\nDefault model: grok-4.7\n - grok-4.7\n * grok-4.7-build-fast (default)\n - grok-4.7",
      ).map((m) => m.id),
    ).toEqual(["grok-4.7", "grok-4.7-build-fast"]);
  });

  it("isolates both home selectors and removes foreign provider credentials", () => {
    const scrubbed = [
      "XAI_API_KEY",
      "XAI_BASE_URL",
      "XAI_API_BASE_URL",
      "GROK_API_KEY",
      "GROK_API_BASE_URL",
      "GROK_CLI_CHAT_PROXY_BASE_URL",
      "GROK_CODE_XAI_API_KEY",
      "GROK_XAI_API_BASE_URL",
      "GROK_MODELS_BASE_URL",
      "GROK_MODELS_LIST_URL",
      "GROK_AUTH",
      "GROK_AUTH_PATH",
      "GROK_DEPLOYMENT_KEY",
      "GROK_AUTH_PROVIDER_COMMAND",
      "GROK_OIDC_ISSUER",
      "GROK_OIDC_CLIENT_ID",
      "GROK_OIDC_SCOPES",
      "GROK_OAUTH2_TOKEN_URL",
      "OPENAI_API_KEY",
    ];
    const env = grokProfileEnv(profile.isolation_locator!, {
      GROK_HOME: "/host",
      ...Object.fromEntries(scrubbed.map((key) => [key, "forbidden"])),
      GROK_DISABLE_AUTOUPDATER: "0",
      GROK_CONFIG: '{"cli":{"auto_update":true}}',
      GROK_CONFIG_PATH: "/host/config.toml",
    });
    expect(env.HOME).toBe(env.USERPROFILE);
    expect(env.GROK_HOME).toBe(join(env.HOME!, ".grok"));
    const child = composeSpawnEnv("mirror_native", env);
    for (const key of scrubbed) {
      expect(env[key], key).toBeNull();
      expect(child[key], key).toBeUndefined();
    }
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe("1");
    expect(env.GROK_CONFIG).toBeNull();
    expect(env.GROK_CONFIG_PATH).toBeNull();
    expect(() => grokProfileEnv("relative")).toThrow();
  });

  it("removes inherited login selectors from the engine environment too", () => {
    const inherited = ["GROK_AUTH_PATH", "GROK_OIDC_AUDIENCE", "GROK_OAUTH2_CLIENT_ID"];
    const saved = Object.fromEntries(inherited.map((key) => [key, process.env[key]]));
    for (const key of inherited) process.env[key] = "/elsewhere";
    try {
      const child = composeSpawnEnv("mirror_native", grokProfileEnv(profile.isolation_locator!));
      for (const key of inherited) expect(child[key], key).toBeUndefined();
      // Unrelated Grok settings still pass through.
      expect(
        composeSpawnEnv(
          "mirror_native",
          grokProfileEnv(profile.isolation_locator!, {
            GROK_RESPECT_GITIGNORE: "1",
          }),
        ).GROK_RESPECT_GITIGNORE,
      ).toBe("1");
    } finally {
      for (const key of inherited)
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
  });

  it("refuses missing profiles without probing or spawning, even with an ambient Grok home", async () => {
    const probeLogin = vi.fn(ready);
    const runCli = vi.fn();
    const adapter = createGrokAdapter({
      detectVersion: async () => "1.0.67",
      probeLogin,
      runCli,
    });
    for (const value of [undefined, null]) {
      expect(() => grokRouteEnv(value, { GROK_HOME: "/host/.grok" })).toThrow(
        /profiles login grok <id>/,
      );
      await expect(
        collect(
          adapter.run(spec({ credential_profile: value, env: { GROK_HOME: "/host/.grok" } })),
        ),
      ).rejects.toThrow(/profiles login grok <id>/);
    }
    expect(() => grokProfileEnv("")).toThrow(/no default credential store/);
    expect((await adapter.discover()).auth_modes).toEqual(["local_session"]);
    const report = await adapter.doctor({ cwd: process.cwd(), env: { GROK_HOME: "/host/.grok" } });
    expect(report.status).toBe("unavailable");
    expect(report.reasons.join(" ")).toContain("profiles login grok <id>");
    expect(report.auth_sources?.[0]?.verification).toBe("not_run");
    expect(
      await adapter.models?.({ cwd: process.cwd(), env: { GROK_HOME: "/host/.grok" } }),
    ).toEqual([]);
    expect(probeLogin).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
  });

  it("refuses a wrong credential transport before probing or spawning", async () => {
    const probeLogin = vi.fn(ready);
    const adapter = createGrokAdapter({ probeLogin });
    await expect(
      collect(
        adapter.run(
          spec({
            credential_profile: {
              ...profile,
              credential_kind: "api_key",
              isolation_locator: null,
              secret_ref: "openai:test",
            },
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(HarnessUnavailableError);
    expect(probeLogin).not.toHaveBeenCalled();
  });

  it("does not admit an absent login or explicitly requested API key", async () => {
    const adapter = createGrokAdapter({
      detectVersion: async () => "1.0.67",
      probeLogin: async () => ({ authenticated: false, models: [], detail: "logged out" }),
    });
    expect((await adapter.doctor({ cwd: process.cwd() })).status).toBe("unavailable");
    await expect(collect(adapter.run(spec()))).rejects.toBeInstanceOf(HarnessUnavailableError);
    await expect(collect(adapter.run(spec({ auth_preference: "api_key" })))).rejects.toBeInstanceOf(
      HarnessUnavailableError,
    );
  });

  it.each(["readonly", "workspace_write", "full"])(
    "drives %s access and stamps quota failures for rotation",
    async (access) => {
      let invocation: CliRunLoopOptions | undefined;
      const adapter = createGrokAdapter({
        probeLogin: ready,
        runCli: async function* (opts) {
          invocation = opts;
          yield* opts.parseEvent(
            { type: "error", error: { code: "quota_exceeded", message: "limit reached" } },
            opts.spec.session_id,
          )!;
          yield {
            type: "completed",
            session_id: opts.spec.session_id,
            ts: new Date().toISOString(),
          };
        },
      });
      const events = await collect(
        adapter.run(
          spec({
            access,
            effort_hint: "high",
            max_turns: 3,
            model_hint: "grok-4.7",
            resume_session_id: "native-id",
            instructions: "rules",
          }),
        ),
      );
      expect(invocation?.env?.GROK_HOME).toContain("grok-test");
      expect(invocation?.env?.GROK_DISABLE_AUTOUPDATER).toBe("1");
      expect(invocation?.args).toEqual(
        expect.arrayContaining([
          "--no-auto-update",
          "--cwd",
          process.cwd(),
          "-m",
          "grok-4.7",
          "--reasoning-effort",
          "high",
          "--resume",
          "native-id",
          "--rules",
          "rules",
          "--max-turns",
          "3",
        ]),
      );
      if (access === "full") expect(invocation?.args).toContain("--always-approve");
      else {
        expect(invocation?.args).not.toContain("--always-approve");
        expect(invocation?.args).toContain("dontAsk");
        expect(invocation?.args).toContain("search_tool,use_tool");
        if (access === "workspace_write") expect(invocation?.args.join(" ")).toContain("Edit(");
      }
      expect(events.find((event) => event.rate_limit)).toMatchObject({
        credential_profile_id: "grok-test",
        credential_route: "vendor_native",
        status: { error_category: "rate_limit" },
      });
      validateTypedStream(events);
    },
  );
});
