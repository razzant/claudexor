import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  runCliHarness,
  type CliRunLoopOptions,
  type HarnessAdapter,
  type spawnProcess,
} from "@claudexor/core";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  AcpClosedHandoffs,
  acpToolCallId,
  acpToolOwner,
  toolResultUpdate,
} from "../../acp-server/src/tool-update.js";
import { readRunEventsWithIntegrity, timelineEvents } from "../../control-api/src/run-timeline.js";
import { createCursorAdapter } from "../../harness-cursor/src/index.js";
import { createAttemptTelemetry, observeAttemptTelemetry } from "./attemptTelemetry.js";
import { buildEvidenceIndex } from "./continuation-evidence.js";
import { collectEvidenceIndexInput } from "./continuation-evidence-io.js";
import { Orchestrator } from "./orchestrator.js";

/**
 * #546 end to end: the NATIVE-SHAPED Cursor frames of a timeout handoff, a
 * requested background command and one later `system/task_notification` per
 * shell go through the real Cursor adapter and the real CLI run loop (only the
 * process I/O is replaced) into the durable events.jsonl. Every consumer then
 * reads the same stored rows back: the Control timeline, telemetry, the
 * continuation packet, the ACP updates and the macOS transcript fixture. The
 * frame shape stays a hypothesis until a sanitized recording exists
 * (fixtures/manifest.yaml); the negative fixture has weaker provenance still.
 */
const COMPLETION = "background-completion";
const FAILURES = "background-completion-failures";
const linesOf = (fixture: string): string[] =>
  readFileSync(
    fileURLToPath(new URL(`../../harness-cursor/fixtures/shell/${fixture}.jsonl`, import.meta.url)),
    "utf8",
  )
    .split("\n")
    .filter(Boolean);
const notification = (fixture: string, task: string): unknown =>
  linesOf(fixture)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((frame) => frame["subtype"] === "task_notification" && frame["task_id"] === task);

const temporaryDirectories: string[] = [];
function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}
afterAll(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** The vendor process, replaced: the fixture's stdout lines, then a clean exit. */
const fixtureProcess = (lines: string[]) =>
  async function* () {
    for (const line of lines) yield { type: "stdout" as const, line };
    yield { type: "exit" as const, code: 0, signal: null };
  } as unknown as typeof spawnProcess;

type FixtureRun = { lines?: string[]; mode?: "agent" | "ask" };

async function runFixture(fixture: string, { lines, mode = "agent" }: FixtureRun = {}) {
  const repo = temporaryDirectory("claudexor-cursor-completion-");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  const configDir = temporaryDirectory("claudexor-cursor-completion-config-");
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
    runCliHarness: (opts: CliRunLoopOptions) =>
      runCliHarness({ ...opts, spawn: fixtureProcess(lines ?? linesOf(fixture)) }),
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
      prompt: "Run both sleeps.",
      mode,
      harnesses: ["cursor"],
      credentialProfileId: "work",
      review: false,
    });
  } finally {
    if (previousConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previousConfig;
  }
}

const fixtureRuns = new Map<string, ReturnType<typeof runFixture>>();
async function storedRun(fixture = COMPLETION) {
  const run = fixtureRuns.get(fixture) ?? runFixture(fixture);
  fixtureRuns.set(fixture, run);
  const result = await run;
  const read = readRunEventsWithIntegrity({ runDir: result.runDir });
  const harness = read.events
    .filter((row) => row["type"] === "harness.event")
    .map((row) => row["payload"] as Record<string, any>);
  return { result, read, harness };
}

/** The attempt record the run itself wrote to its telemetry artifact. */
const telemetryArtifact = (runDir: string): Record<string, any> =>
  new ArtifactStore(runDir).readYaml<{ attempts: Array<Record<string, any>> }>(
    join(runDir, "final", "telemetry.yaml"),
  )!.attempts[0]!;

const runToolWarningsTotal = (runDir: string): unknown =>
  new ArtifactStore(runDir).readYaml<{ tool_warnings_total: unknown }>(
    join(runDir, "final", "telemetry.yaml"),
  )!.tool_warnings_total;

/** The stored run events folded the way a client folds ACP partial updates,
 * by native id. Each ACP call id names the run and try that issued the call. */
async function acpCalls(events: ReadonlyArray<Record<string, any>>) {
  const closed = new AcpClosedHandoffs();
  const calls = new Map<string, Record<string, any>>();
  for (const event of events.filter((row) => row["type"] === "harness.event")) {
    const tool = event["payload"]?.["tool"];
    if (event["payload"]?.["type"] === "tool_result") {
      const id = acpToolCallId(acpToolOwner(event), tool["use_id"]);
      closed.closed("session", id, tool);
      calls.set(tool["use_id"], toolResultUpdate(id, tool));
    }
    const update = closed.refinement("session", event);
    if (update) calls.set(tool["use_id"], { ...calls.get(tool["use_id"]), ...update });
  }
  return calls;
}
const acpText = (call: Record<string, any> | undefined): string =>
  call?.["content"]?.[0]?.["content"]?.["text"];

const swiftRows = (fixture: string, target: string) => {
  const stored = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          `../../../apps/macos/ClaudexorApp/Tests/ClaudexorAppTests/Fixtures/${target}.json`,
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ) as { source: string; rows: Array<{ payload: Record<string, any> }> };
  expect(stored.source).toBe(`packages/harness-cursor/fixtures/shell/${fixture}.jsonl`);
  return stored.rows.map((row) => row.payload);
};
const toolRows = (payloads: Array<Record<string, any>>) =>
  payloads
    .filter((p) => p["type"] === "tool_call" || p["type"] === "tool_result" || isRefinement(p))
    .map((p) => ({ type: p["type"], text: p["text"], tool: p["tool"], payload: p["payload"] }));

const isRefinement = (payload: Record<string, any>): boolean =>
  payload["type"] === "status" && payload["payload"]?.["code"] === "command_outcome_refined";

describe("Cursor background completions through the durable event log (#546)", () => {
  it("stores one refinement per shell beside the unchanged handoff results", async () => {
    const { result, read, harness } = await storedRun();
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(read.integrity.malformedLines).toBe(0);
    // The handoff results stay in the history exactly as they were.
    const results = harness.filter((p) => p["type"] === "tool_result");
    expect(
      results.map((p) => [p["tool"]["use_id"], p["tool"]["command_outcome"]["state"]]),
    ).toEqual([
      ["call-foreground-sleep", "backgrounded"],
      ["call-background-sleep", "backgrounded"],
    ]);
    const refined = harness.filter(isRefinement);
    expect(
      refined.map((p) => [
        p["tool"]["use_id"],
        p["tool"]["command_outcome"]["state"],
        p["tool"]["command_outcome"]["completion_status"],
        p["tool"]["status"],
        p["tool"]["exit_code"],
      ]),
    ).toEqual([
      ["call-background-sleep", "completion_reported", "success", undefined, undefined],
      ["call-foreground-sleep", "completion_reported", "success", undefined, undefined],
    ]);
    expect(refined.map((p) => p["payload"]["native_notification"])).toEqual([
      notification(COMPLETION, "148490"),
      notification(COMPLETION, "148478"),
    ]);
    // The run loop no longer counts the notifications as unrecognized frames.
    const completed = harness.find((p) => p["type"] === "completed");
    expect(completed?.["payload"]?.["dropped_unrecognized_events"]).toBeUndefined();
  });

  it("replays the same facts on the Control timeline: warnings named by the engine's label", async () => {
    const { result, read } = await storedRun();
    const rows = timelineEvents({ runDir: result.runDir }, read.events, read.integrity).filter(
      (row) => row.toolName === "shell" && row.title !== "shell",
    );
    expect(rows.map((row) => [row.title, row.severity, row.target])).toEqual([
      [
        "tool_result: Handed off to background after its 30s timeout; completion not observed · shell 148478 · pid 148480",
        "warning",
        "sleep 45",
      ],
      [
        "tool_result: Handed off to background; completion not observed · shell 148490 · pid 148492",
        "warning",
        "sleep 5",
      ],
      [
        "Completion reported; exit code unknown · handed off to background · shell 148490 · pid 148492",
        "warning",
        "sleep 5",
      ],
      [
        "Completion reported; exit code unknown · handed off to background after its 30s timeout · shell 148478 · pid 148480",
        "warning",
        "sleep 45",
      ],
    ]);
  });

  it("keeps telemetry on the results: no error, no recovery, no dropped frame", async () => {
    const { result, harness } = await storedRun();
    const t = createAttemptTelemetry("auto", false);
    for (const payload of harness) observeAttemptTelemetry(t, payload as never);
    expect(t.toolErrors).toEqual([]);
    expect(t.statuslessResults).toBe(0);
    expect(t.droppedEvents).toBe(0);
    const attempt = telemetryArtifact(result.runDir);
    expect(attempt["tool_errors"]).toEqual([]);
    expect(attempt["dropped_events"]).toBe(0);
    expect(attempt["outcome"]["status"]).toBe("success");
    expect(
      attempt["reported_command_outcomes"]["recent"].map((row: Record<string, any>) => [
        row["tool_use_id"],
        row["command_outcome"]["completion_status"],
      ]),
    ).toEqual([
      ["call-background-sleep", "success"],
      ["call-foreground-sleep", "success"],
    ]);
  });

  it("updates the closed ACP calls from the stored rows and keeps them failed", async () => {
    const { result, read, harness } = await storedRun();
    const calls = await acpCalls(read.events);
    // The stored rows name their run and try, so the ACP call does too.
    const owner = [result.runId, harness[0]?.["attempt_id"], harness[0]?.["session_id"]]
      .map((part) => encodeURIComponent(String(part)))
      .join("/");
    expect(calls.get("call-foreground-sleep")?.["toolCallId"]).toBe(
      `${owner}/call-foreground-sleep`,
    );
    expect(calls.get("call-foreground-sleep")?.["status"]).toBe("failed");
    expect(acpText(calls.get("call-foreground-sleep"))).toBe(
      "Completion reported; exit code unknown · handed off to background after its 30s timeout · shell 148478 · pid 148480",
    );
    expect(calls.get("call-background-sleep")?.["status"]).toBe("failed");
    expect(acpText(calls.get("call-background-sleep"))).toBe(
      "Completion reported; exit code unknown · handed off to background · shell 148490 · pid 148492",
    );
  });

  it("gives the continuation packet the refined outcome of each command", async () => {
    const { result, harness } = await storedRun();
    const attemptId = String(harness[0]?.["attempt_id"]);
    const packet = buildEvidenceIndex(
      collectEvidenceIndexInput(
        { runDir: result.runDir, attemptId, workOrder: "Run both sleeps.", steering: [] },
        { cause: "transport", retainedOutput: "", diffStat: null },
      ),
    ).markdown;
    expect(packet).toContain(
      "- shell — sleep 45 (unconfirmed: Completion reported; exit code unknown · handed off to background after its 30s timeout · shell 148478 · pid 148480)",
    );
    expect(packet).toContain(
      "- shell — sleep 5 (unconfirmed: Completion reported; exit code unknown · handed off to background · shell 148490 · pid 148492)",
    );
    expect(packet).not.toContain("completion not observed");
    expect(packet).toContain("Tool calls: 2; unresolved: 0.");
  });

  it("gives the macOS transcript fixture exactly the tool and refinement rows the run stored", async () => {
    const { harness } = await storedRun();
    const fixture = swiftRows(COMPLETION, "cursor-background-completion-transcript");
    expect(toolRows(fixture)).toEqual(toolRows(harness));
    expect(toolRows(harness)).toHaveLength(6);
  });
});

/**
 * The reported `error` and `aborted` are vendor reports about the command: the
 * tool call stays `ok`, nothing recovers or fails, and the word reaches the
 * telemetry artifact as a command fact, the packet, the timeline, ACP and the
 * app. `paused` is an invented word, so its shell stays a handoff and the frame
 * stays counted. Synthetic frames: no native run showed these
 * (fixtures/manifest.yaml).
 */
describe("Cursor negative reports through the durable event log (#546)", () => {
  const FAILING =
    "Completion reported (error); exit code unknown · handed off to background after its 30s timeout · shell 148500 · pid 148502";
  const ABORTED =
    "Completion reported (aborted); exit code unknown · handed off to background · shell 148510 · pid 148512";
  const UNREAD = "Handed off to background; completion not observed · shell 148520 · pid 148522";

  it("stores the two reports, keeps the results ok and counts what it could not read", async () => {
    const { result, harness } = await storedRun(FAILURES);
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(
      harness.filter((p) => p["type"] === "tool_result").map((p) => p["tool"]["status"]),
    ).toEqual(["ok", "ok", "ok"]);
    const refined = harness.filter(isRefinement);
    expect(
      refined.map((p) => [p["tool"]["use_id"], p["tool"]["status"], p["tool"]["exit_code"]]),
    ).toEqual([
      ["call-failing-tests", undefined, undefined],
      ["call-dev-server", undefined, undefined],
    ]);
    // The prose detail stays evidence; nothing parsed an exit code out of it.
    expect(refined[0]?.["payload"]["native_notification"]).toEqual(
      notification(FAILURES, "148500"),
    );
    const completed = harness.find((p) => p["type"] === "completed");
    expect(completed?.["payload"]?.["dropped_unrecognized_events"]).toBe(3);
  });

  it("writes the reports into the run's own telemetry artifact as command facts, never warnings", async () => {
    const { result } = await storedRun(FAILURES);
    const attempt = telemetryArtifact(result.runDir);
    expect(attempt["reported_command_outcomes"]).toEqual({
      total: 2,
      recent: [
        {
          tool: "shell",
          target: "pnpm test",
          tool_use_id: "call-failing-tests",
          command_outcome: {
            state: "completion_reported",
            completion_status: "error",
            background_reason: "timeout",
            timeout_ms: 30000,
            shell_id: "148500",
            pid: 148502,
          },
        },
        {
          tool: "shell",
          target: "pnpm dev",
          tool_use_id: "call-dev-server",
          command_outcome: {
            state: "completion_reported",
            completion_status: "aborted",
            background_reason: "requested",
            shell_id: "148510",
            pid: 148512,
          },
        },
      ],
    });
    // The vendor's prose detail stays evidence; nothing parsed an exit code out of it.
    expect(JSON.stringify(attempt["reported_command_outcomes"])).not.toContain("exit");
    expect(attempt["tool_errors"]).toEqual([]);
    expect(attempt["tool_errors_total"]).toBe(0);
    expect(attempt["unrecovered_tool_errors"]).toBe(0);
    expect(attempt["dropped_events"]).toBe(3);
    expect(attempt["outcome"]["status"]).toBe("success");
    expect(attempt["outcome"]["tool_warnings_count"]).toBe(0);
    expect(attempt["outcome"]["harness_errored"]).toBe(false);
    expect(runToolWarningsTotal(result.runDir)).toBe(0);
  });

  it("names each report on the timeline, in the packet and over ACP", async () => {
    const { result, read, harness } = await storedRun(FAILURES);
    const titles = timelineEvents({ runDir: result.runDir }, read.events, read.integrity)
      .filter((row) => row.toolName === "shell" && row.title.startsWith("Completion"))
      .map((row) => [row.title, row.severity, row.errorSummary]);
    expect(titles).toEqual([
      [FAILING, "warning", null],
      [ABORTED, "warning", null],
    ]);
    const attemptId = String(harness[0]?.["attempt_id"]);
    const packet = buildEvidenceIndex(
      collectEvidenceIndexInput(
        { runDir: result.runDir, attemptId, workOrder: "Run them.", steering: [] },
        { cause: "transport", retainedOutput: "", diffStat: null },
      ),
    ).markdown;
    expect(packet).toContain(`- shell — pnpm test (unconfirmed: ${FAILING})`);
    expect(packet).toContain(`- shell — pnpm dev (unconfirmed: ${ABORTED})`);
    expect(packet).toContain(`- shell — sleep 600 (unconfirmed: ${UNREAD})`);
    const calls = await acpCalls(read.events);
    expect([...calls.values()].map((call) => [call["status"], acpText(call)])).toEqual([
      ["failed", FAILING],
      ["failed", ABORTED],
      ["failed", UNREAD],
    ]);
  });

  it("gives the macOS transcript fixture exactly the rows the run stored", async () => {
    const { harness } = await storedRun(FAILURES);
    const fixture = swiftRows(FAILURES, "cursor-background-completion-failures-transcript");
    expect(toolRows(fixture)).toEqual(toolRows(harness));
    expect(toolRows(harness)).toHaveLength(8);
  });
});

/**
 * The boundary this rule exists for: a read-only attempt that delivered nothing,
 * where the one tool event is a deliberately stopped command. The existing
 * finalizer of the real read-only lane must leave that clean, and must still fail
 * the same attempt when a real `tool_result:error` is what happened. Frames come
 * from the fixtures above, with an empty final; no native run showed this shape.
 */
describe("a deliverable-less read-only attempt and a reported command (#546)", () => {
  const framesOf = (fixture: string, keep: (frame: Record<string, any>) => boolean): string[] =>
    linesOf(fixture).filter((line) => keep(JSON.parse(line) as Record<string, any>));
  const emptyFinal = (fixture: string): string => {
    const frames = linesOf(fixture).map((line) => JSON.parse(line) as Record<string, any>);
    return JSON.stringify({ ...frames.find((frame) => frame["type"] === "result"), result: "" });
  };

  it("an intentionally aborted command leaves the attempt clean, with the report kept", async () => {
    const result = await runFixture(FAILURES, {
      mode: "ask",
      lines: [
        ...framesOf(
          FAILURES,
          (frame) =>
            frame["subtype"] === "init" ||
            frame["call_id"] === "call-dev-server" ||
            (frame["subtype"] === "task_notification" && frame["task_id"] === "148510"),
        ),
        emptyFinal(FAILURES),
      ],
    });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(existsSync(join(result.runDir, "final", "failure.yaml"))).toBe(false);
    const attempt = telemetryArtifact(result.runDir);
    expect(attempt["outcome"]).toMatchObject({
      deliverable_present: false,
      harness_errored: false,
      tool_warnings_count: 0,
      status: "success",
    });
    expect(attempt["tool_errors"]).toEqual([]);
    expect(attempt["reported_command_outcomes"]["recent"]).toMatchObject([
      {
        tool_use_id: "call-dev-server",
        command_outcome: { state: "completion_reported", completion_status: "aborted" },
      },
    ]);
    expect(runToolWarningsTotal(result.runDir)).toBe(0);
  });

  it("control: a real failed result of the same attempt still fails it without recovery", async () => {
    const OUTCOMES = "command-outcomes";
    const result = await runFixture(OUTCOMES, {
      mode: "ask",
      lines: [
        ...framesOf(
          OUTCOMES,
          (frame) => frame["subtype"] === "init" || frame["call_id"] === "c-exit1",
        ),
        emptyFinal(OUTCOMES),
      ],
    });
    expect(result.lifecycle, result.summary).toBe("failed");
    expect(result.facts.reason).toBe("harness_failed");
    expect(readFileSync(join(result.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "shell failed without recovery",
    );
    const attempt = telemetryArtifact(result.runDir);
    expect(attempt["reported_command_outcomes"]).toBeUndefined();
    expect(attempt["outcome"]["status"]).toBe("failed");
    expect(attempt["outcome"]["tool_warnings_count"]).toBe(1);
  });
});
