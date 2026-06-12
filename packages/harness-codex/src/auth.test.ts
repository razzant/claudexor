import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexExecArgs, ensureCodexApiAuth, ensureCodexNativeAuth } from "./index.js";

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
    const args = codexExecArgs({ access: "workspace_write", model_hint: null, effort_hint: null, prompt: "follow up", resume_session_id: "th-123" });
    expect(args.slice(0, 4)).toEqual(["exec", "resume", "th-123", "--json"]);
    expect(args[args.length - 1]).toBe("follow up");
  });

  it("forwards model and reasoning effort as separate Codex config", () => {
    expect(codexExecArgs({ access: "readonly", model_hint: "gpt-5.5", effort_hint: "xhigh", prompt: "review" })).toEqual([
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
