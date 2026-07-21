import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userConfigDir } from "@claudexor/util";
import { nativeLoginDisplayCommand, nativeLoginEnv, nativeLoginSpec } from "./native-login.js";
import { defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import { CODEX_FILE_AUTH_OVERRIDE, defaultNativeCodexHome } from "@claudexor/harness-codex";

describe("native login specs", () => {
  const resolver = (binary: string): string => `/normalized/bin/${binary}`;
  let previousNativeHome: string | undefined;
  let nativeHome: string;

  beforeEach(() => {
    previousNativeHome = process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    // The override must stay inside the Claudexor config root (A4 containment),
    // so seed the disposable native home under the (hermetic) config dir.
    mkdirSync(join(userConfigDir(), "native"), { recursive: true });
    nativeHome = mkdtempSync(join(userConfigDir(), "native", "codex-login-"));
    process.env.CLAUDEXOR_CODEX_NATIVE_HOME = nativeHome;
  });

  afterEach(() => {
    if (previousNativeHome === undefined) delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    else process.env.CLAUDEXOR_CODEX_NATIVE_HOME = previousNativeHome;
    rmSync(nativeHome, { recursive: true, force: true });
  });

  it("uses the exact allowlisted vendor commands and absolute resolved binaries", () => {
    const names = ["CLAUDEXOR_CODEX_BIN", "CLAUDEXOR_CLAUDE_BIN", "CLAUDEXOR_CURSOR_BIN"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    try {
      expect(nativeLoginSpec("codex", resolver)).toEqual({
        binary: "/normalized/bin/codex",
        args: ["-c", CODEX_FILE_AUTH_OVERRIDE, "login", "--device-auth"],
        displayCommand: "codex login --device-auth (isolated Claudexor profile)",
      });
      // Explicit opt-in localhost-redirect flow (codex only).
      expect(nativeLoginSpec("codex", resolver, "browser_redirect")).toEqual({
        binary: "/normalized/bin/codex",
        args: ["-c", CODEX_FILE_AUTH_OVERRIDE, "login"],
        displayCommand: "codex login (browser redirect, isolated Claudexor profile)",
      });
      // A flow hint never changes non-codex harnesses.
      expect(nativeLoginSpec("claude", resolver, "browser_redirect")?.args).toEqual([
        "auth",
        "login",
      ]);
      expect(nativeLoginSpec("claude", resolver)).toEqual({
        binary: "/normalized/bin/claude",
        args: ["auth", "login"],
        displayCommand: "claude auth login",
      });
      expect(nativeLoginSpec("cursor", resolver)).toEqual({
        binary: "/normalized/bin/cursor-agent",
        args: ["login"],
        displayCommand: "cursor-agent login",
      });
      for (const harness of ["codex", "claude", "cursor"]) {
        expect(isAbsolute(nativeLoginSpec(harness, resolver)?.binary ?? "")).toBe(true);
      }
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("refuses unresolved or non-absolute binaries and leaves OpenCode out", () => {
    expect(nativeLoginSpec("codex", () => null)).toBeNull();
    expect(nativeLoginSpec("codex", () => "codex")).toBeNull();
    expect(nativeLoginSpec("opencode", resolver)).toBeNull();
    expect(nativeLoginDisplayCommand("codex")).toBe(
      "codex login --device-auth (isolated Claudexor profile)",
    );
  });

  it("resolves the same explicit binary override used by the adapter", () => {
    const previous = process.env.CLAUDEXOR_CODEX_BIN;
    process.env.CLAUDEXOR_CODEX_BIN = "/custom/codex";
    try {
      const requested: string[] = [];
      const spec = nativeLoginSpec("codex", (binary) => {
        requested.push(binary);
        return binary;
      });
      expect(requested).toEqual(["/custom/codex"]);
      expect(spec?.binary).toBe("/custom/codex");
    } finally {
      if (previous === undefined) delete process.env.CLAUDEXOR_CODEX_BIN;
      else process.env.CLAUDEXOR_CODEX_BIN = previous;
    }
  });

  it("scrubs all provider credentials and redirects while retaining runtime network context", () => {
    const env = nativeLoginEnv("codex", {
      HOME: "/home/user",
      PATH: "/custom/bin",
      HTTPS_PROXY: "http://proxy.example",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      OPENAI_API_KEY: "secret-openai",
      CODEX_ACCESS_TOKEN: "secret-codex-token",
      ANTHROPIC_API_KEY: "secret-anthropic",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_API_KEY: "secret-foundry",
      ANTHROPIC_FOUNDRY_AUTH_TOKEN: "secret-foundry-token",
      ANTHROPIC_FOUNDRY_RESOURCE: "resource-name",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.invalid",
      AZURE_CLIENT_SECRET: "secret-azure",
      AZURE_FEDERATED_TOKEN_FILE: "/tmp/token",
      CURSOR_API_KEY: "secret-cursor",
      OPENAI_BASE_URL: "https://redirect.invalid",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(env.ANTHROPIC_FOUNDRY_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_FOUNDRY_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_FOUNDRY_RESOURCE).toBeUndefined();
    expect(env.ANTHROPIC_FOUNDRY_BASE_URL).toBeUndefined();
    expect(env.AZURE_CLIENT_SECRET).toBeUndefined();
    expect(env.AZURE_FEDERATED_TOKEN_FILE).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://proxy.example");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/ca.pem");
    expect(env.PATH).toContain("/custom/bin");
    expect(env.CODEX_HOME).toBe(defaultNativeCodexHome());
  });

  it("pins each vendor login to the same native store its verifier probes", () => {
    const source = {
      HOME: "/daemon/home",
      CODEX_HOME: "/stale/scoped/codex",
      CLAUDE_CONFIG_DIR: "/stale/scoped/claude",
      CURSOR_API_KEY: "must-be-scrubbed",
    };
    expect(nativeLoginEnv("codex", source).CODEX_HOME).toBe(defaultNativeCodexHome());
    expect(nativeLoginEnv("claude", source).CLAUDE_CONFIG_DIR).toBe(defaultNativeClaudeConfigDir());
    expect(nativeLoginEnv("cursor", source).HOME).toBe("/daemon/home");
    expect(nativeLoginEnv("cursor", source).CURSOR_API_KEY).toBeUndefined();
  });
});
