import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AnswerAssembly,
  runCliHarness,
  streamExpectationViolations,
  validateTypedStream,
  type CliRunLoopOptions,
  type FixtureStreamExpectations,
  type LiveMessageResult,
} from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { parse as parseYaml } from "yaml";
import { createClaudeAdapter } from "./index.js";
import { LIVE_INPUT_DELIVERED } from "./live-input.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const manifest = parseYaml(readFileSync(join(FIXTURES, "manifest.yaml"), "utf8")) as {
  fixtures: Record<string, { expectations?: FixtureStreamExpectations }>;
};

interface WireRecord {
  direction: "client->cli" | "cli->client";
  frame: Record<string, any>;
}

/**
 * A fake Claude CLI that replays a DIRECTIONAL recording 1:1: every
 * `cli->client` frame is printed in order, and every `client->cli` frame is a
 * barrier released only once a stdin frame of the recorded type arrived (the
 * initialize handshake, the initial prompt, the live message) — so the wire
 * the adapter drives is exactly the recorded one. It exits 0 once the adapter
 * closes stdin (the cooperative end), after flushing stdout.
 */
const FAKE_REPLAY_CLI = `
const fs = require('node:fs');
const records = fs.readFileSync(process.argv.at(-1), 'utf8').split('\\n').filter(Boolean).map(JSON.parse);
const rl = require('node:readline').createInterface({ input: process.stdin });
const inbox = []; let waiting = null; let closed = false;
const wake = () => { if (waiting) { const w = waiting; waiting = null; w(); } };
rl.on('line', (line) => { inbox.push(JSON.parse(line)); wake(); });
rl.on('close', () => { closed = true; wake(); });
(async () => {
  for (const record of records) {
    if (record.direction === 'cli->client') { process.stdout.write(JSON.stringify(record.frame) + '\\n'); continue; }
    for (;;) {
      const idx = inbox.findIndex((m) => m.type === record.frame.type);
      if (idx >= 0) { inbox.splice(idx, 1); break; }
      if (closed) process.exit(3);
      await new Promise((resolve) => { waiting = resolve; });
    }
  }
  while (!closed) await new Promise((resolve) => { waiting = resolve; });
  process.stdout.write('', () => process.exit(0));
})();
`;

function readRecording(name: string): WireRecord[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WireRecord);
}

/** The recorded prompt and live message (uuid = the message id the replay must reuse). */
function recordedInputs(records: WireRecord[]): {
  prompt: string;
  liveMessageId: string;
  liveText: string;
} {
  const users = records.filter((r) => r.direction === "client->cli" && r.frame["type"] === "user");
  expect(users).toHaveLength(2);
  return {
    prompt: users[0]!.frame["message"]["content"][0]["text"] as string,
    liveMessageId: users[1]!.frame["uuid"] as string,
    liveText: users[1]!.frame["message"]["content"][0]["text"] as string,
  };
}

async function replay(
  name: string,
  triggerOn: HarnessEvent["type"],
): Promise<{
  events: HarnessEvent[];
  receipt: LiveMessageResult;
  liveMessageId: string;
  args: string[];
  expectations: FixtureStreamExpectations;
}> {
  const records = readRecording(name);
  const { prompt, liveMessageId, liveText } = recordedInputs(records);
  const expectations = manifest.fixtures[name]?.expectations;
  expect(expectations, `manifest expectations missing for ${name}`).toBeTruthy();
  let args: string[] = [];
  // The REAL adapter path (runClaude -> runCliHarness with the adapter's own
  // argv, session hooks and live-input owner); only the binary is the replay.
  const adapter = createClaudeAdapter({
    detectVersion: async () => "2.1.283",
    probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
    probeAuthStatus: async () => ({
      loggedIn: true,
      authed: true,
      authMethod: "claude.ai",
      probeError: null,
    }),
    anthropicApiKey: () => null,
    claudeOAuthToken: () => null,
    probeEffortLevels: async () => ({ levels: [], live: true }),
    runCliHarness: (options: CliRunLoopOptions) => {
      args = options.args;
      return runCliHarness({
        ...options,
        bin: process.execPath,
        args: ["-e", FAKE_REPLAY_CLI, join(FIXTURES, name)],
      });
    },
  });
  const spec = HarnessRunSpec.parse({
    session_id: `ses-${name.replace(/[^a-z0-9]+/gi, "-")}`,
    intent: "implement",
    prompt,
    cwd: process.cwd(),
    access: "full",
    model_hint: "sonnet",
    auth_preference: "subscription",
    extra: { interactionChannel: { request: async () => null } },
  });
  const events: HarnessEvent[] = [];
  let receipt: Promise<LiveMessageResult> | undefined;
  for await (const event of adapter.run(spec)) {
    events.push(event);
    if (!receipt && event.type === triggerOn)
      receipt = adapter.message!(spec.session_id, { messageId: liveMessageId, text: liveText });
  }
  expect(receipt, "the trigger event never arrived").toBeTruthy();
  return { events, receipt: await receipt!, liveMessageId, args, expectations: expectations! };
}

describe("claude live-input recordings (2.1.283), replayed through the real adapter", () => {
  it("fold: a message written while a tool runs is queued (accepted) and consumed inside the same turn (one delivered receipt, one result)", async () => {
    const name = "stream-json/recorded-live-fold-2.1.283.jsonl";
    const { events, receipt, liveMessageId, args, expectations } = await replay(name, "tool_call");
    expect(args).toContain("--replay-user-messages");
    expect(receipt).toEqual({ outcome: "accepted" });
    // Exactly ONE consumption receipt, for OUR uuid: the initial prompt's own
    // replay echo (a foreign uuid) and the later started/completed frames and
    // the result's uuid list re-announce nothing.
    expect(events.filter((e) => e.type === "status")).toEqual([
      expect.objectContaining({
        payload: { code: LIVE_INPUT_DELIVERED, message_id: liveMessageId },
        credential_route: "vendor_native",
      }),
    ]);
    expect(streamExpectationViolations(events, expectations)).toEqual([]);
    const stats = validateTypedStream(events);
    expect(stats.started).toBe(1);
    expect(stats.toolCalls).toBe(2);
    expect(stats.toolResults).toBe(2);
    expect(stats.statuslessToolResults).toBe(0);
    // One result → the full cumulative cost, once.
    expect(events.filter((e) => e.type === "usage").map((e) => e.usage?.cost_usd)).toEqual([
      0.20760599999999998,
    ]);
    const answer = new AnswerAssembly();
    for (const e of events) answer.observe(e);
    expect(answer.text()).toContain("MANGO");
    // Every recorded frame is recognized (replay echo, command_lifecycle,
    // task frames, rate-limit heartbeat): nothing dropped, exit 0, no error.
    expect(events.at(-1)).toMatchObject({ type: "completed", payload: { exit_code: 0 } });
    expect(events.at(-1)?.payload).not.toHaveProperty("dropped_unrecognized_events");
    expect(events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
    expect(events.some((e) => e.type === "error")).toBe(false);
  }, 20_000);

  it("final text: a message that arrives after the last tool result runs as the next native turn of the same run (stdin held, one started, cost delta, last final wins)", async () => {
    const name = "stream-json/recorded-live-final-text-2.1.283.jsonl";
    const { events, receipt, liveMessageId, expectations } = await replay(name, "tool_result");
    expect(receipt).toEqual({ outcome: "accepted" });
    const statuses = events.filter((e) => e.type === "status").map((e) => e.payload);
    expect(statuses).toEqual([
      { code: LIVE_INPUT_DELIVERED, message_id: liveMessageId },
      { code: "native_turn_started", turn: 2 },
    ]);
    expect(streamExpectationViolations(events, expectations)).toEqual([]);
    expect(validateTypedStream(events).started).toBe(1);
    // total_cost_usd is cumulative (0.0963518 → 0.114749): the second usage is
    // the DELTA, so the orchestrator's sum equals the CLI's final total.
    const costs = events.filter((e) => e.type === "usage").map((e) => e.usage?.cost_usd ?? 0);
    expect(costs[0]).toBe(0.0963518);
    expect(costs[1]).toBeCloseTo(0.0183972, 10);
    expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(0.114749, 10);
    // Two results → two finals; the run's answer is the LAST one.
    const finals = events.filter((e) => e.type === "message" && e.final === true);
    expect(finals).toHaveLength(2);
    const answer = new AnswerAssembly();
    for (const e of events) answer.observe(e);
    expect(answer.text()).toBe("MANGO");
    // The hold worked end to end: the fake CLI only exits once stdin closes,
    // and the run loop closed it at result#2, not result#1 (the replay would
    // otherwise exit 3 at the barrier or be cut short before the second turn).
    expect(events.at(-1)).toMatchObject({ type: "completed", payload: { exit_code: 0 } });
    expect(events.at(-1)?.payload).not.toHaveProperty("dropped_unrecognized_events");
    expect(events.some((e) => e.type === "error")).toBe(false);
  }, 20_000);
});
