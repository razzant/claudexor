import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureCodexApiAuth } from "./index.js";

const KEY_VARS = ["CLAUDEX_CODEX_API_KEY", "CODEX_API_KEY", "OPENAI_API_KEY"] as const;

describe("ensureCodexApiAuth", () => {
  let home: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codex-home-"));
    saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
    for (const k of KEY_VARS) delete process.env[k];
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

  it("prefers CLAUDEX_CODEX_API_KEY over OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = "sk-generic";
    process.env.CLAUDEX_CODEX_API_KEY = "sk-scoped";
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
});
