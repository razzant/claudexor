import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexAuthModeAt, codexExecArgs, ensureCodexApiAuth, ensureCodexNativeAuth, probeLogin } from "./index.js";

/** Fake `codex` binary printing a canned login-status verdict. */
function fakeCodexBin(dir: string, script: string): string {
  const bin = join(dir, "codex-fake");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const KEY_VARS = ["CLAUDEXOR_CODEX_API_KEY", "CODEX_API_KEY", "OPENAI_API_KEY", "CLAUDEXOR_DISABLE_STORED_SECRETS"] as const;

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
    writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { id: "preexisting" } }));
    process.env.OPENAI_API_KEY = "sk-test-123";
    ensureCodexApiAuth({ CODEX_HOME: home });
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    expect(parsed.auth_mode).toBe("chatgpt");
  });

  it("seeds the NATIVE session auth.json into an isolated CODEX_HOME (subscription pass-through)", () => {
    const nativeHome = mkdtempSync(join(tmpdir(), "codex-native-"));
    const scoped = mkdtempSync(join(tmpdir(), "codex-scoped-"));
    try {
      writeFileSync(join(nativeHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id: "native" } }));
      const ok = ensureCodexNativeAuth({ CODEX_HOME: scoped }, nativeHome);
      expect(ok).toBe(true);
      const parsed = JSON.parse(readFileSync(join(scoped, "auth.json"), "utf8"));
      expect(parsed.auth_mode).toBe("chatgpt");
    } finally {
      rmSync(nativeHome, { recursive: true, force: true });
      rmSync(scoped, { recursive: true, force: true });
    }
  });

  it("native seed is a no-op without a native session and never overwrites scoped auth", () => {
    const nativeHome = mkdtempSync(join(tmpdir(), "codex-native-empty-"));
    const scoped = mkdtempSync(join(tmpdir(), "codex-scoped-"));
    try {
      // No native auth.json -> cannot seed.
      expect(ensureCodexNativeAuth({ CODEX_HOME: scoped }, nativeHome)).toBe(false);
      expect(existsSync(join(scoped, "auth.json"))).toBe(false);
      // Existing scoped auth (e.g. api-key already seeded) is preserved.
      writeFileSync(join(scoped, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }));
      writeFileSync(join(nativeHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
      expect(ensureCodexNativeAuth({ CODEX_HOME: scoped }, nativeHome)).toBe(true);
      expect(JSON.parse(readFileSync(join(scoped, "auth.json"), "utf8")).auth_mode).toBe("apikey");
    } finally {
      rmSync(nativeHome, { recursive: true, force: true });
      rmSync(scoped, { recursive: true, force: true });
    }
  });

  it("emits `exec resume <id>` args when resuming a native session", () => {
    const args = codexExecArgs({ access: "workspace_write", model_hint: null, effort_hint: null, external_context_policy: "auto", attachments: [], browser: null, prompt: "follow up", resume_session_id: "th-123" });
    expect(args.slice(0, 4)).toEqual(["exec", "resume", "th-123", "--json"]);
    expect(args[args.length - 1]).toBe("follow up");
  });

  it("forwards model and reasoning effort as separate Codex config", () => {
    expect(codexExecArgs({ access: "readonly", model_hint: "gpt-5.5", effort_hint: "xhigh", external_context_policy: "cached", attachments: [], browser: null, prompt: "review" })).toEqual([
      "exec",
      "--json",
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
      writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }));
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-probe-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exit 0 means logged in", async () => {
    const bin = fakeCodexBin(dir, 'echo "Logged in using ChatGPT"; exit 0');
    expect(await probeLogin(bin)).toEqual({ authed: true, probeError: null });
  });

  it("'Not logged in' on a failing exit is a clean logged-out verdict, not a probe error", async () => {
    const bin = fakeCodexBin(dir, 'echo "Not logged in" >&2; exit 1');
    expect(await probeLogin(bin)).toEqual({ authed: false, probeError: null });
  });

  it("a config-load failure is a PROBE ERROR, never silently 'not logged in'", async () => {
    // The live regression: a stale pinned codex 0.137 shim + a config.toml
    // written for 0.142 ("unknown variant `ultra`") reported the logged-in
    // subscription as logged out.
    const bin = fakeCodexBin(dir, 'echo "Error loading configuration: config.toml:3:26: unknown variant \\`ultra\\`" >&2; exit 1');
    const r = await probeLogin(bin);
    expect(r.authed).toBe(false);
    expect(r.probeError).toContain("unknown variant");
  });

  it("a missing binary is a probe error", async () => {
    const r = await probeLogin(join(dir, "does-not-exist"));
    expect(r.authed).toBe(false);
    expect(r.probeError).toBeTruthy();
  });
});
