import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeArgsForSpec, ensureClaudeNativeAuth } from "./index.js";
import type { HarnessRunSpec } from "@claudexor/schema";

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
    max_usd: null,
    max_turns: null,
    auth_preference: "auto",
    resume_session_id: null,
    env: {},
    extra: {},
    ...over,
  } as HarnessRunSpec;
}

describe("ensureClaudeNativeAuth", () => {
  it("seeds the native .credentials.json into an isolated CLAUDE_CONFIG_DIR (subscription pass-through)", () => {
    const nativeDir = mkdtempSync(join(tmpdir(), "claude-native-"));
    const scoped = mkdtempSync(join(tmpdir(), "claude-scoped-"));
    try {
      writeFileSync(join(nativeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "native" } }));
      const ok = ensureClaudeNativeAuth({ CLAUDE_CONFIG_DIR: scoped }, nativeDir);
      expect(ok).toBe(true);
      expect(JSON.parse(readFileSync(join(scoped, ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe("native");
    } finally {
      rmSync(nativeDir, { recursive: true, force: true });
      rmSync(scoped, { recursive: true, force: true });
    }
  });

  it("is a no-op without a native session and never overwrites scoped creds", () => {
    const nativeDir = mkdtempSync(join(tmpdir(), "claude-native-empty-"));
    const scoped = mkdtempSync(join(tmpdir(), "claude-scoped-"));
    try {
      expect(ensureClaudeNativeAuth({ CLAUDE_CONFIG_DIR: scoped }, nativeDir)).toBe(false);
      expect(existsSync(join(scoped, ".credentials.json"))).toBe(false);
      writeFileSync(join(scoped, ".credentials.json"), JSON.stringify({ existing: true }));
      writeFileSync(join(nativeDir, ".credentials.json"), JSON.stringify({ native: true }));
      expect(ensureClaudeNativeAuth({ CLAUDE_CONFIG_DIR: scoped }, nativeDir)).toBe(true);
      expect(JSON.parse(readFileSync(join(scoped, ".credentials.json"), "utf8")).existing).toBe(true);
    } finally {
      rmSync(nativeDir, { recursive: true, force: true });
      rmSync(scoped, { recursive: true, force: true });
    }
  });
});

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
