import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import type { CliRunLoopOptions } from "@claudexor/core";
import {
  CODEX_FILE_AUTH_OVERRIDE,
  codexAuthModeAt,
  codexExecArgs,
  codexNativeEnv,
  createCodexAdapter,
  defaultNativeCodexHome,
  ensureCodexApiAuth,
  probeLogin,
  selectCodexRunAuthRoute,
} from "./index.js";

describe("Codex strict runtime auth routing", () => {
  it("defaults native subscription state under Claudexor, never ordinary ~/.codex", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-config-"));
    const previousConfig = process.env.CLAUDEXOR_CONFIG_DIR;
    const previousNative = process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    try {
      expect(defaultNativeCodexHome()).toBe(join(root, "native", "codex"));
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfig;
      if (previousNative === undefined) delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
      else process.env.CLAUDEXOR_CODEX_NATIVE_HOME = previousNative;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors CLAUDEXOR_CODEX_NATIVE_HOME carried in the RUN env, not only process.env", () => {
    const previous = process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    const prevConfig = process.env.CLAUDEXOR_CONFIG_DIR;
    // The override must stay inside the Claudexor config root (containment
    // guard, symmetry with claude), so seed the root and place it within.
    const root = mkdtempSync(join(tmpdir(), "codex-native-root-"));
    const loggedIn = join(root, "native", "codex", "override");
    mkdirSync(loggedIn, { recursive: true });
    writeFileSync(
      join(loggedIn, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: {} }),
    );
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME; // override lives ONLY in the run env
    try {
      const runEnv = { HOME: "/scoped/home", CLAUDEXOR_CODEX_NATIVE_HOME: loggedIn };
      // The owner reads the override from the authoritative run env.
      expect(defaultNativeCodexHome(runEnv)).toBe(loggedIn);
      // codexNativeEnv (doctor/run probe env builder) routes CODEX_HOME to it.
      expect(codexNativeEnv(runEnv).CODEX_HOME).toBe(loggedIn);
    } finally {
      if (previous === undefined) delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
      else process.env.CLAUDEXOR_CODEX_NATIVE_HOME = previous;
      if (prevConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prevConfig;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("REFUSES a CLAUDEXOR_CODEX_NATIVE_HOME override that escapes the Claudexor config root (A4)", () => {
    const prevConfig = process.env.CLAUDEXOR_CONFIG_DIR;
    const prevNative = process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    const root = mkdtempSync(join(tmpdir(), "codex-guard-root-"));
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    try {
      // A sibling of the config root — the codex child could mutate an arbitrary
      // home. The containment guard must throw, not silently honor it.
      expect(() =>
        defaultNativeCodexHome({ CLAUDEXOR_CODEX_NATIVE_HOME: join(root, "..", ".codex") }),
      ).toThrow(/must stay inside/);
    } finally {
      if (prevConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prevConfig;
      if (prevNative === undefined) delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
      else process.env.CLAUDEXOR_CODEX_NATIVE_HOME = prevNative;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the default native home is unchanged when no override is set anywhere", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-default-home-"));
    const prevConfig = process.env.CLAUDEXOR_CONFIG_DIR;
    const prevNative = process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    try {
      const withoutOverride = { HOME: "/scoped/home" };
      expect(defaultNativeCodexHome(withoutOverride)).toBe(join(root, "native", "codex"));
      expect(defaultNativeCodexHome()).toBe(join(root, "native", "codex"));
    } finally {
      if (prevConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prevConfig;
      if (prevNative === undefined) delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
      else process.env.CLAUDEXOR_CODEX_NATIVE_HOME = prevNative;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the doctor probe inspects the override home when it rides the spec env only", async () => {
    const previous = process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    const prevConfig = process.env.CLAUDEXOR_CONFIG_DIR;
    // The override must stay inside the Claudexor config root (A4 containment).
    const root = mkdtempSync(join(tmpdir(), "codex-doctor-root-"));
    const loggedIn = join(root, "native", "codex", "override");
    mkdirSync(loggedIn, { recursive: true });
    writeFileSync(
      join(loggedIn, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: {} }),
    );
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    try {
      let probeEnv: Record<string, string | null | undefined> | undefined;
      const adapter = createCodexAdapter({
        detectVersion: async () => "codex 0.144.1",
        probeLogin: async (_bin, options) => {
          probeEnv = options?.env;
          return { authed: true, method: "chatgpt", probeError: null };
        },
        hasApiKey: () => false,
        codexApiKey: () => undefined,
        smokeIsolatedApiKey: async () => ({ ok: false, detail: "x" }),
      });
      await adapter.doctor({
        cwd: "/repo",
        env: { HOME: "/scoped/home", CLAUDEXOR_CODEX_NATIVE_HOME: loggedIn },
        authPreference: "subscription",
        authSource: "native_session",
        fresh: true,
      });
      expect(probeEnv?.CODEX_HOME).toBe(loggedIn);
    } finally {
      if (previous === undefined) delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
      else process.env.CLAUDEXOR_CODEX_NATIVE_HOME = previous;
      if (prevConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prevConfig;
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    expect(selectCodexRunAuthRoute("subscription", sub, key)).toBeNull();
    expect(attempts).toEqual(["subscription"]);
    attempts.length = 0;
    expect(selectCodexRunAuthRoute("auto", sub, key)).toBe("api_key");
    expect(attempts).toEqual(["subscription", "api_key"]);
    attempts.length = 0;
    expect(
      selectCodexRunAuthRoute(
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

/** Fake `codex` binary printing a canned login-status verdict. */
function fakeCodexBin(dir: string, script: string): string {
  const bin = join(dir, "codex-fake");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const KEY_VARS = [
  "CLAUDEXOR_CODEX_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "CLAUDEXOR_DISABLE_STORED_SECRETS",
] as const;

describe("ensureCodexApiAuth", () => {
  let home: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codex-home-"));
    saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
    for (const k of KEY_VARS) delete process.env[k];
    process.env.CLAUDEXOR_DISABLE_STORED_SECRETS = "1";
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    for (const k of KEY_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("seeds api_key auth.json into an isolated CODEX_HOME", () => {
    process.env.OPENAI_API_KEY = "sk-test-123";
    ensureCodexApiAuth({ CODEX_HOME: home });
    const authPath = join(home, "auth.json");
    expect(existsSync(authPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    expect(parsed).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test-123" });
  });

  it("prefers CLAUDEXOR_CODEX_API_KEY over OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = "sk-generic";
    process.env.CLAUDEXOR_CODEX_API_KEY = "sk-scoped";
    ensureCodexApiAuth({ CODEX_HOME: home });
    const parsed = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    expect(parsed.OPENAI_API_KEY).toBe("sk-scoped");
  });

  it("is a no-op when CODEX_HOME is not set (use codex native auth)", () => {
    process.env.OPENAI_API_KEY = "sk-test-123";
    expect(() => ensureCodexApiAuth(undefined)).not.toThrow();
    expect(() => ensureCodexApiAuth({})).not.toThrow();
  });

  it("is a no-op when no api key is available", () => {
    ensureCodexApiAuth({ CODEX_HOME: home });
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });

  it("does not overwrite an existing auth.json (respects native login)", () => {
    const authPath = join(home, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({ auth_mode: "chatgpt", tokens: { id: "preexisting" } }),
    );
    process.env.OPENAI_API_KEY = "sk-test-123";
    ensureCodexApiAuth({ CODEX_HOME: home });
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    expect(parsed.auth_mode).toBe("chatgpt");
  });

  it("emits `exec resume <id>` args when resuming a native session", () => {
    const args = codexExecArgs({
      access: "workspace_write",
      model_hint: null,
      effort_hint: null,
      external_context_policy: "auto",
      attachments: [],
      browser: null,
      prompt: "follow up",
      resume_session_id: "th-123",
    });
    expect(args.slice(0, 4)).toEqual(["exec", "resume", "th-123", "--json"]);
    expect(args).toContain(CODEX_FILE_AUTH_OVERRIDE);
    expect(args[args.length - 1]).toBe("follow up");
  });

  it("forwards model and reasoning effort as separate Codex config", () => {
    expect(
      codexExecArgs({
        access: "readonly",
        model_hint: "gpt-5.5",
        effort_hint: "xhigh",
        external_context_policy: "cached",
        attachments: [],
        browser: null,
        prompt: "review",
      }),
    ).toEqual([
      "exec",
      "--json",
      "-c",
      CODEX_FILE_AUTH_OVERRIDE,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      'web_search="cached"',
      "review",
    ]);
  });
});

describe("codexAuthModeAt (route evidence from codex's own auth.json)", () => {
  it("maps the file's typed auth_mode to the engine AuthMode values", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-authmode-"));
    try {
      writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
      expect(codexAuthModeAt(home)).toBe("local_session");
      writeFileSync(
        join(home, "auth.json"),
        JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }),
      );
      expect(codexAuthModeAt(home)).toBe("api_key");
      writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "quantum" }));
      expect(codexAuthModeAt(home)).toBeNull(); // unknown mode: undisclosed, never guessed
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns null when auth.json is absent or unreadable", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-authmode-empty-"));
    try {
      expect(codexAuthModeAt(home)).toBeNull();
      writeFileSync(join(home, "auth.json"), "not-json{");
      expect(codexAuthModeAt(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("probeLogin (native-session probe vs probe failure)", () => {
  let dir: string;
  let previousConfigDir: string | undefined;
  let previousNativeHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-probe-"));
    previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    previousNativeHome = process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    process.env.CLAUDEXOR_CONFIG_DIR = join(dir, "claudexor");
    delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    if (previousNativeHome === undefined) delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    else process.env.CLAUDEXOR_CODEX_NATIVE_HOME = previousNativeHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it("scrubs provider credentials and endpoint redirects from the native login-status probe", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    const previousBase = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = "must-not-reach-probe";
    process.env.OPENAI_BASE_URL = "https://redirect.invalid";
    try {
      const bin = fakeCodexBin(
        dir,
        `[ -z "$OPENAI_API_KEY" ] && [ -z "$OPENAI_BASE_URL" ] || exit 9\necho 'Logged in using ChatGPT'; exit 0`,
      );
      expect(await probeLogin(bin)).toEqual({ authed: true, method: "chatgpt", probeError: null });
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBase;
    }
  });

  it("exit 0 means logged in", async () => {
    const bin = fakeCodexBin(dir, 'echo "Logged in using ChatGPT"; exit 0');
    expect(await probeLogin(bin)).toEqual({ authed: true, method: "chatgpt", probeError: null });
  });

  it("'Not logged in' on a failing exit is a clean logged-out verdict, not a probe error", async () => {
    const bin = fakeCodexBin(dir, 'echo "Not logged in" >&2; exit 1');
    expect(await probeLogin(bin)).toEqual({
      authed: false,
      method: "logged_out",
      probeError: null,
    });
  });

  it("a config-load failure is a PROBE ERROR, never silently 'not logged in'", async () => {
    // The live regression: a stale pinned codex 0.137 shim + a config.toml
    // written for 0.142 ("unknown variant `ultra`") reported the logged-in
    // subscription as logged out.
    const bin = fakeCodexBin(
      dir,
      'echo "Error loading configuration: config.toml:3:26: unknown variant \\`ultra\\`" >&2; exit 1',
    );
    const r = await probeLogin(bin);
    expect(r.authed).toBe(false);
    expect(r.method).toBe("unknown");
    expect(r.probeError).toContain("unknown variant");
  });

  it("a missing binary is a probe error", async () => {
    const r = await probeLogin(join(dir, "does-not-exist"));
    expect(r.authed).toBe(false);
    expect(r.method).toBe("unknown");
    expect(r.probeError).toBeTruthy();
  });

  it("classifies API-key and access-token status without accepting either as native", async () => {
    const api = fakeCodexBin(dir, 'echo "Logged in using an API key"; exit 0');
    expect(await probeLogin(api)).toEqual({ authed: true, method: "api_key", probeError: null });
    const access = fakeCodexBin(dir, 'echo "Logged in using access token"; exit 0');
    expect(await probeLogin(access)).toEqual({
      authed: true,
      method: "access_token",
      probeError: null,
    });
  }, 10_000);

  it("treats exit 0 with an unrecognized status as a probe error", async () => {
    const bin = fakeCodexBin(dir, 'echo "Logged in somehow"; exit 0');
    const result = await probeLogin(bin);
    expect(result).toMatchObject({ authed: false, method: "unknown" });
    expect(result.probeError).toContain("unrecognized login status");
  });

  it("does not accept ChatGPT help or failure prose as a native status verdict", async () => {
    const unavailable = fakeCodexBin(dir, 'echo "ChatGPT authentication unavailable"; exit 0');
    const unavailableResult = await probeLogin(unavailable);
    expect(unavailableResult).toMatchObject({ authed: false, method: "unknown" });
    expect(unavailableResult.probeError).toContain("unrecognized login status");
    const help = fakeCodexBin(dir, 'echo "Use ChatGPT to log in"; exit 0');
    const helpResult = await probeLogin(help);
    expect(helpResult).toMatchObject({ authed: false, method: "unknown" });
    expect(helpResult.probeError).toContain("unrecognized login status");
  });

  it("uses the independent native CODEX_HOME, file storage, and hard-cancel options", async () => {
    const controller = new AbortController();
    let captured: Record<string, unknown> | undefined;
    let capturedArgs: string[] = [];
    const result = await probeLogin("/fake/codex", {
      env: { HOME: "/scoped/home", CODEX_HOME: "/must/not/win", OPENAI_API_KEY: "secret" },
      abortSignal: controller.signal,
      runCapture: async (_cmd, args, options) => {
        capturedArgs = args;
        captured = options as unknown as Record<string, unknown>;
        return { code: 0, signal: null, stdout: "Logged in using ChatGPT\n", stderr: "" };
      },
    });
    expect(result.method).toBe("chatgpt");
    expect((captured?.env as Record<string, unknown>).HOME).toBe("/scoped/home");
    expect((captured?.env as Record<string, unknown>).CODEX_HOME).toBe(defaultNativeCodexHome());
    expect((captured?.env as Record<string, unknown>).OPENAI_API_KEY).toBeNull();
    expect(capturedArgs).toEqual(["-c", CODEX_FILE_AUTH_OVERRIDE, "login", "status"]);
    expect(captured?.abortSignal).toBe(controller.signal);
    expect(captured?.cancelSignal).toBe("SIGTERM");
    expect(captured?.cancelKillDelayMs).toBe(0);
  });
});

describe("Codex transport-aware native doctor", () => {
  it("probes only native_session in the exact host-user context without API smoke", async () => {
    let smokeCalls = 0;
    let probeEnv: Record<string, string | null | undefined> | undefined;
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex 0.144.1",
      probeLogin: async (_bin, options) => {
        probeEnv = options?.env;
        return { authed: true, method: "chatgpt", probeError: null };
      },
      hasApiKey: () => true,
      codexApiKey: () => "api-key",
      smokeIsolatedApiKey: async () => {
        smokeCalls += 1;
        return { ok: true, detail: "must not run" };
      },
    });

    const report = await adapter.doctor({
      cwd: "/repo",
      env: { HOME: "/scoped/home", CODEX_HOME: "/scoped/codex" },
      authPreference: "subscription",
      authSource: "native_session",
      fresh: true,
    });

    expect(smokeCalls).toBe(0);
    expect(probeEnv?.HOME).toBe("/scoped/home");
    expect(probeEnv?.CODEX_HOME).toBe(defaultNativeCodexHome());
    expect(report.auth_sources).toEqual([
      expect.objectContaining({
        source: "native_session",
        availability: "available",
        verification: "passed",
      }),
    ]);
    const manifest = await adapter.discover();
    expect(manifest).toMatchObject({
      capability_profile: {
        auth: {
          supported_sources: ["native_session", "provider_auth_file"],
          credential_transports: expect.arrayContaining([
            { source: "native_session", kind: "config_file", relocatable_by: ["CONFIG_DIR"] },
          ]),
        },
        isolation: { supported_containment: expect.arrayContaining(["host_user_context"]) },
      },
    });
    expect(manifest.capability_profile.auth.credential_transports).not.toContainEqual({
      source: "native_session",
      kind: "os_keychain",
      relocatable_by: [],
    });
  });

  it("runs native Codex against the same vendor-owned home the probe verified", async () => {
    let probeEnv: Record<string, string | null | undefined> | undefined;
    let cliOptions: CliRunLoopOptions | undefined;
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex 0.144.1",
      probeLogin: async (_bin, options) => {
        probeEnv = options?.env;
        return { authed: true, method: "chatgpt", probeError: null };
      },
      hasApiKey: () => true,
      codexApiKey: () => "api-key",
      runCliHarness: async function* (options: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        cliOptions = options;
        yield {
          type: "completed",
          session_id: options.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });
    const spec = HarnessRunSpec.parse({
      session_id: "codex-native-run",
      intent: "review",
      prompt: "review",
      cwd: "/repo",
      env: { HOME: "/scoped/home", CODEX_HOME: "/scoped/codex" },
      auth_preference: "auto",
    });

    for await (const _event of adapter.run(spec)) {
      // drain
    }

    expect(probeEnv?.HOME).toBe("/scoped/home");
    expect(probeEnv?.CODEX_HOME).toBe(defaultNativeCodexHome());
    expect(cliOptions?.env?.HOME).toBe("/scoped/home");
    expect(cliOptions?.env?.CODEX_HOME).toBe(defaultNativeCodexHome());
    expect(cliOptions?.env?.OPENAI_API_KEY).toBeNull();
  });
});

describe("Codex missing-CLI diagnosis", () => {
  const ADVISORY =
    "Homebrew still lists codex as installed (/opt/homebrew/Caskroom/codex) but no runnable binary is on the harness PATH — broken install; run `brew reinstall --cask codex`";

  it("doctor surfaces the broken-install advisory in the installed check and reasons", async () => {
    const adapter = createCodexAdapter({
      detectVersion: async () => null,
      brokenInstallAdvisory: () => ADVISORY,
    });
    const report = await adapter.doctor({ cwd: "/repo", env: {}, fresh: true });
    expect(report.status).toBe("unavailable");
    expect(report.checks).toEqual([
      { id: "installed", status: "fail", detail: `codex not found on PATH — ${ADVISORY}` },
    ]);
    expect(report.reasons).toEqual([
      "codex CLI not found (install Codex or set CLAUDEXOR_CODEX_BIN)",
      ADVISORY,
    ]);
  });

  it("doctor keeps the plain dead-end wording when there is no advisory evidence", async () => {
    const adapter = createCodexAdapter({
      detectVersion: async () => null,
      brokenInstallAdvisory: () => null,
    });
    const report = await adapter.doctor({ cwd: "/repo", env: {}, fresh: true });
    expect(report.checks).toEqual([
      { id: "installed", status: "fail", detail: "codex not found on PATH" },
    ]);
    expect(report.reasons).toEqual([
      "codex CLI not found (install Codex or set CLAUDEXOR_CODEX_BIN)",
    ]);
  });

  it("discover appends the advisory to the unavailable error", async () => {
    const adapter = createCodexAdapter({
      detectVersion: async () => null,
      brokenInstallAdvisory: () => ADVISORY,
    });
    await expect(adapter.discover()).rejects.toThrow(ADVISORY);
  });

  it("doctor probes AND diagnoses in the scoped spec env (INV-067 same-env doctrine)", async () => {
    const probeEnvs: Array<Record<string, string | null | undefined> | undefined> = [];
    const advisoryPaths: Array<string | undefined> = [];
    const adapter = createCodexAdapter({
      detectVersion: async (_signal, env) => {
        probeEnvs.push(env);
        return null;
      },
      brokenInstallAdvisory: (_bin, source) => {
        advisoryPaths.push(source?.PATH);
        return null;
      },
    });
    await adapter.doctor({ cwd: "/repo", env: { PATH: "/scoped/bin" }, fresh: true });
    // The version probe receives the raw spec patch (runCapture merges it);
    // the advisory receives the MERGED effective env — both name the same
    // scoped PATH, so the diagnosis can never describe a different env than
    // the probe that failed.
    expect(probeEnvs).toEqual([{ PATH: "/scoped/bin" }]);
    expect(advisoryPaths).toEqual(["/scoped/bin"]);
  });
});
