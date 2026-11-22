/**
 * A strict subscription spawn of the real Claude adapter carries only the vendor's
 * native session: a fictitious key and setup-token beside it are never sent, and a
 * lost native session ends the spawn typed instead of falling back. The vendor
 * process is a recorder; no binary, no network.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import type { CliRunLoopOptions, runCliHarness } from "@claudexor/core";
import { createClaudeAdapter } from "./index.js";

const nativeReady = {
  loggedIn: true,
  authed: true,
  authMethod: "claude.ai",
  probeError: null,
} as const;
const nativeLost = {
  loggedIn: false,
  authed: false,
  authMethod: null,
  probeError: null,
} as const;

function fixture(native: typeof nativeReady | typeof nativeLost) {
  const sent: CliRunLoopOptions[] = [];
  const send: typeof runCliHarness = (options) => {
    sent.push(options);
    return (async function* () {
      yield {
        type: "completed",
        session_id: options.spec.session_id,
        ts: new Date().toISOString(),
      } as HarnessEvent;
    })();
  };
  const adapter = createClaudeAdapter({
    probeAuthStatus: async () => native,
    anthropicApiKey: () => "fixture-not-a-real-key",
    claudeOAuthToken: () => "fixture-not-a-real-token",
    probeEffortLevels: async () => ({ levels: [], live: true }),
    // Every vendor read a spawn can reach is a stub: no binary is probed or started.
    detectVersion: async () => "2.1.261",
    installation: () => ({ path: null, advisory: null }),
    probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "fixture" }),
    runCliHarness: send,
  });
  return { adapter, sent };
}

const spec = () =>
  HarnessRunSpec.parse({
    session_id: "strict-subscription",
    intent: "explain",
    prompt: "q",
    cwd: process.cwd(),
    access: "readonly",
    auth_preference: "subscription",
  });

async function collect(stream: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Claude strict subscription spawn", () => {
  let root = "";
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "claude-strict-")));
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", root);
    vi.stubEnv("CLAUDEXOR_CLAUDE_NATIVE_DIR", undefined);
    // No host binary can be resolved on PATH by the spawn's own lookup.
    vi.stubEnv("CLAUDEXOR_CLAUDE_BIN", join(root, "absent", "claude"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("rides the native session and sends neither the key nor the setup-token beside it", async () => {
    const { adapter, sent } = fixture(nativeReady);
    await collect(adapter.run(spec()));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.spec.auth_preference).toBe("subscription");
    expect(sent[0]!.env?.["ANTHROPIC_API_KEY"]).toBeFalsy();
    expect(sent[0]!.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBeFalsy();
  });

  it("ends typed, without any spawn, when the native session is lost and a key and token exist", async () => {
    const { adapter, sent } = fixture(nativeLost);
    const events = await collect(adapter.run(spec()));
    expect(sent).toHaveLength(0);
    expect(
      events.some(
        (event) => event.type === "error" && /explicitly requested/.test(String(event.error)),
      ),
    ).toBe(true);
  });
});
