import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { CliRunLoopOptions, HarnessAdapter } from "@claudexor/core";
import type { HarnessEvent } from "@claudexor/schema";
import { createCursorAdapter } from "../../harness-cursor/src/index.js";
import { readRunEventsWithIntegrity, timelineEvents } from "../../control-api/src/run-timeline.js";
import { buildEvidenceIndex } from "./continuation-evidence.js";
import { collectEvidenceIndexInput } from "./continuation-evidence-io.js";
import { Orchestrator } from "./orchestrator.js";

/**
 * #450 end to end: native Cursor shell frames (the SYNTHETIC fixture shared
 * with the adapter tests) through the real Cursor adapter and orchestrator
 * into the durable events.jsonl, then replayed by the Control timeline, the
 * ACP tool-update mapping and the continuation evidence packet exactly as
 * those consumers read it back from disk.
 */
const FIXTURE = fileURLToPath(
  new URL("../../harness-cursor/fixtures/shell/command-outcomes.jsonl", import.meta.url),
);
const frames = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, any>);
const nativeResult = (callId: string): unknown =>
  frames.find((f) => f.type === "tool_call" && f.subtype === "completed" && f.call_id === callId)
    ?.tool_call?.shellToolCall?.result;

const temporaryDirectories: string[] = [];
function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}
afterAll(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function runFixture(input: Array<Record<string, any>> = frames) {
  const repo = temporaryDirectory("claudexor-cursor-outcome-");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  const configDir = temporaryDirectory("claudexor-cursor-outcome-config-");
  const profileHome = join(configDir, "profiles", "cursor-work");
  mkdirSync(profileHome, { recursive: true });
  writeFileSync(
    join(configDir, "config.yaml"),
    [
      "credential_profiles:",
      "  - profile_id: work",
      "    harness_id: cursor",
      "    display_name: Work",
      "    credential_kind: config_dir_login",
      `    isolation_locator: '${profileHome}'`,
      "",
    ].join("\n"),
  );
  const adapter = createCursorAdapter({
    detectVersion: async () => "cursor-test",
    nativeAuthOk: async () => ({ kind: "authenticated" }),
    cursorApiKey: () => null,
    listCursorModels: async () => [],
    smokeIsolatedApiKey: async () => ({ ok: false, detail: "not needed" }),
    runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
      for (const frame of input)
        for (const event of opts.parseEvent?.(frame, opts.spec.session_id) ?? []) yield event;
      yield { type: "completed", session_id: opts.spec.session_id, ts: new Date().toISOString() };
    },
  });
  const previousConfig = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  try {
    return await new Orchestrator({
      registry: new Map<string, HarnessAdapter>([["cursor", adapter]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      workspaceKind: "directory",
      inPlace: true,
      prompt: "Run the checks.",
      mode: "agent",
      harnesses: ["cursor"],
      credentialProfileId: "work",
      review: false,
    });
  } finally {
    if (previousConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previousConfig;
  }
}

/** One real run shared by every case below; each reads the stored log anew. */
let fixtureRun: ReturnType<typeof runFixture> | undefined;
async function storedRun() {
  const result = await (fixtureRun ??= runFixture());
  const read = readRunEventsWithIntegrity({ runDir: result.runDir });
  const stored = new Map<string, Record<string, any>>();
  for (const row of read.events) {
    const payload = row["payload"] as Record<string, any> | undefined;
    if (row["type"] === "harness.event" && payload?.["type"] === "tool_result")
      stored.set(String(payload["tool"]?.["use_id"]), payload);
  }
  return { result, read, stored };
}

describe("Cursor command outcomes through the durable event log (#450)", () => {
  it("persists typed facts and native evidence and replays them honestly", async () => {
    const { result, read, stored } = await storedRun();
    // Unconfirmed commands never discard the delivered answer.
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(read.integrity.malformedLines).toBe(0);
    const handoff = stored.get("c-bg-timeout");
    expect(handoff?.["tool"]).toMatchObject({
      status: "ok",
      command_outcome: {
        state: "backgrounded",
        background_reason: "timeout",
        timeout_ms: 30000,
        shell_id: "3",
        pid: 4242,
      },
    });
    expect(handoff?.["tool"]?.["exit_code"]).toBeUndefined();
    // The complete native result survives persistence exactly.
    for (const id of ["c-bg-timeout", "c-bg-request", "c-timeout", "c-abort"])
      expect(stored.get(id)?.["payload"]?.["native_result"], id).toEqual(nativeResult(id));
    expect(stored.get("c-exit0")?.["tool"]).toMatchObject({
      status: "ok",
      exit_code: 0,
      command_outcome: { state: "exited" },
    });
    expect(stored.get("c-exit0")?.["payload"]).toBeUndefined();

    // Control timeline replay from disk: severity follows the typed facts.
    const rows = timelineEvents({ runDir: result.runDir }, read.events, read.integrity).filter(
      (row) => row.toolName === "shell" && row.title.startsWith("tool_result"),
    );
    expect(rows.map((row) => row.severity)).toEqual([
      "info",
      "error",
      "warning",
      "warning",
      "warning",
      "error",
      "error",
    ]);
    expect(rows[2]?.title).toBe(
      "tool_result: Moved to background after 30s · still running · shell 3 · pid 4242",
    );

    // ACP replay of the same stored rows: never `completed` for an unconfirmed command.
    const { toolResultUpdate } = await import("../../acp-server/src/tool-update.js");
    const statuses = Object.fromEntries(
      [...stored].map(([id, payload]) => [id, toolResultUpdate(id, payload["tool"]).status]),
    );
    expect(statuses).toEqual({
      "c-exit0": "completed",
      "c-exit1": "failed",
      "c-bg-timeout": "failed",
      "c-bg-request": "failed",
      "c-timeout": "failed",
      "c-abort": "failed",
      "c-spawn": "failed",
    });
  });

  // INV-146: a completed command carries no native payload, so its bounded
  // summary is the only copy of its output Claudexor keeps; it stays exact.
  it("keeps a completed command's output exact in the durable journal", async () => {
    const token = ["ghp", "E".repeat(36)].join("_");
    const withOutput = structuredClone(frames);
    const completed = withOutput.find(
      (f) => f.type === "tool_call" && f.subtype === "completed" && f.call_id === "c-exit0",
    );
    completed!.tool_call.shellToolCall.result.success.stdout = `token=${token}\n`;
    const result = await runFixture(withOutput);
    const row = readRunEventsWithIntegrity({ runDir: result.runDir }).events.find(
      (event) =>
        event["type"] === "harness.event" &&
        (event["payload"] as Record<string, any>)?.["tool"]?.["use_id"] === "c-exit0" &&
        (event["payload"] as Record<string, any>)?.["type"] === "tool_result",
    );
    const tool = (row?.["payload"] as Record<string, any>)?.["tool"];
    expect(tool?.["status"]).toBe("ok");
    expect(String(tool?.["content_summary"])).toContain(`token=${token}`);
  });

  it("builds the continuation packet without calling an unconfirmed command completed", async () => {
    const { result, stored } = await storedRun();
    const attemptId = String(stored.get("c-bg-timeout")?.["attempt_id"]);
    const packet = buildEvidenceIndex(
      collectEvidenceIndexInput(
        { runDir: result.runDir, attemptId, workOrder: "Run the checks.", steering: [] },
        { cause: "transport", retainedOutput: "", diffStat: null },
      ),
    ).markdown;
    // Positive: each unconfirmed command names its state.
    expect(packet).toContain(
      "- shell — find /repo -name '*.log' (unconfirmed: Moved to background after 30s · still running · shell 3 · pid 4242)",
    );
    expect(packet).toContain(
      "- shell — pnpm dev (unconfirmed: Running in background · shell 4 · pid 4343)",
    );
    expect(packet).toContain(
      "- shell — sleep 120 (unconfirmed: Timed out after 30s · exit status unknown)",
    );
    expect(packet).toContain("- shell — pnpm build (unconfirmed: Timed out · exit status unknown)");
    // Negative: observed exits and results without command facts read as before;
    // a failed result keeps its ordinary error status beside completion (#410).
    expect(packet).toContain("- shell — ls (completed)");
    expect(packet).toContain("- shell — pnpm test (completed: error)");
    expect(packet).toContain("- shell — missing-tool --version (completed: error)");
    expect(packet).not.toContain("pnpm test (unconfirmed");
    expect(packet).not.toContain("find /repo -name '*.log' (completed)");
    expect(packet).toContain("Tool calls: 7; unresolved: 0.");
  });

  it("gives the macOS transcript fixture exactly the tool rows the run stored", async () => {
    const { read } = await storedRun();
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../apps/macos/ClaudexorApp/Tests/ClaudexorAppTests/Fixtures/cursor-command-outcome-transcript.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ) as { rows: Array<{ payload: Record<string, unknown> }> };
    const toolRows = (payloads: Array<Record<string, unknown>>) =>
      payloads
        .filter((p) => p["type"] === "tool_call" || p["type"] === "tool_result")
        .map((p) => ({ type: p["type"], text: p["text"], tool: p["tool"], payload: p["payload"] }));
    const stored = read.events
      .filter((row) => row["type"] === "harness.event")
      .map((row) => row["payload"] as Record<string, unknown>);
    expect(toolRows(fixture.rows.map((row) => row.payload))).toEqual(toolRows(stored));
    expect(toolRows(stored)).toHaveLength(14);
  });
});
