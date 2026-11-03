import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { HarnessAdapter, spawnProcess } from "@claudexor/core";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  ConformanceReport,
  HarnessManifest,
  RunTelemetry,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { readRunEventsWithIntegrity, timelineEvents } from "../../control-api/src/run-timeline.js";
import { runCodexAppServer } from "../../harness-codex/src/app-server-run.js";
import { Orchestrator } from "./orchestrator.js";

/**
 * #337 end to end: Codex's native `configWarning` / `warning` notifications
 * (the SYNTHETIC 0.162.1-shaped fixture the adapter conformance test replays)
 * through the real app-server run loop and orchestrator into the durable
 * events.jsonl, then read back by the Control timeline exactly as it reads
 * them from disk. The warnings are evidence only: the same stream without
 * them ends with the same lifecycle, facts, answer and telemetry.
 */
type Frame = Record<string, any>;
const FIXTURE = fileURLToPath(
  new URL(
    "../../harness-codex/fixtures/app-server/synthetic-native-warnings-0.162.1.jsonl",
    import.meta.url,
  ),
);
const fixture: Frame[] = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Frame);
const isWarning = (frame: Frame) =>
  frame["method"] === "configWarning" || frame["method"] === "warning";
const withoutWarnings = (frames: Frame[]) => frames.filter((frame) => !isWarning(frame));

/** The fixture with one failed native command and a needs_input report, as in #337's verifier. */
function commandFailure(token: string): Frame[] {
  const report = JSON.stringify({
    work_report: {
      state: "needs_input",
      required_inputs: [
        {
          kind: "permission",
          locator: "research/input.txt",
          description: "The native sandbox failed before the read ran.",
        },
      ],
    },
    output: "I could not read research/input.txt.",
  });
  const command = {
    type: "commandExecution",
    id: "cmd-read",
    command: "/bin/bash -lc 'cat research/input.txt'",
    cwd: "/fixture/project",
    processId: null,
    source: "unifiedExecStartup",
    commandActions: [],
  };
  const turn = { threadId: "thread-warnings", turnId: "turn-warnings" };
  return fixture.flatMap((frame): Frame[] => {
    const params = frame["params"];
    if (frame["method"] === "warning" && params["threadId"] === null)
      return [{ ...frame, params: { ...params, message: `${params["message"]} ${token}` } }];
    if (frame["method"] === "item/started" && params["item"]["type"] === "agentMessage")
      return [
        {
          method: "item/started",
          params: { ...turn, item: { ...command, status: "inProgress" } },
        },
        {
          method: "item/completed",
          params: {
            ...turn,
            item: {
              ...command,
              status: "failed",
              aggregatedOutput: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n",
              exitCode: 1,
              durationMs: 3,
            },
          },
        },
        frame,
      ];
    if (frame["method"] === "item/completed" && params["item"]["type"] === "agentMessage")
      return [{ ...frame, params: { ...params, item: { ...params["item"], text: report } } }];
    if (frame["method"] === "turn/completed")
      return [
        {
          ...frame,
          params: {
            ...params,
            turn: { ...params["turn"], items: [{ ...params["turn"]["items"][0], text: report }] },
          },
        },
      ];
    return [frame];
  });
}

/**
 * The vendor process is the only fake: each reply waits for the adapter's own
 * request id, and `closing` frames follow the adapter's stdin close.
 */
function replay(frames: Frame[], closing: Frame[] = []): typeof spawnProcess {
  return async function* (_bin, _args, options = {}) {
    const written = new Set<number>();
    let wake: (() => void) | undefined;
    let ended = false;
    const signal = (): void => {
      wake?.();
      wake = undefined;
    };
    options.onSpawn?.({
      write(line) {
        const id = (JSON.parse(line) as { id?: unknown }).id;
        if (typeof id === "number") written.add(id);
        signal();
      },
      end() {
        ended = true;
        signal();
      },
      closed: Promise.resolve(),
    });
    for (const frame of frames) {
      while (typeof frame["id"] === "number" && !written.has(frame["id"]) && !ended)
        await new Promise<void>((resolve) => (wake = resolve));
      if (ended) break;
      yield { type: "stdout", line: JSON.stringify(frame) };
    }
    while (!ended) await new Promise<void>((resolve) => (wake = resolve));
    for (const frame of closing) yield { type: "stdout", line: JSON.stringify(frame) };
    yield { type: "exit", code: 0, signal: null, durationMs: 0 };
  };
}

const LATE_ANSWER = "Late answer after Stop.";

/**
 * A vendor for an explicit Stop: each reply answers the adapter's own request
 * by method, the turn stays active until `turn/interrupt`, which reports a late
 * failed command, a late answer and the interrupted turn, and `closing` frames
 * follow stdin close.
 */
function stopping(closing: Frame[]): typeof spawnProcess {
  const reply = (id: number) => fixture.find((frame) => frame["id"] === id)!["result"];
  const turnStarted = fixture.find((frame) => frame["method"] === "turn/started")!;
  return async function* (_bin, _args, options = {}) {
    const queue: Frame[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let active = true;
    const push = (...frames: Frame[]): void => {
      queue.push(...frames);
      wake?.();
      wake = undefined;
    };
    options.onSpawn?.({
      write(line) {
        const { id, method } = JSON.parse(line) as { id?: unknown; method?: unknown };
        const result = (value: Frame): Frame => ({ id, result: value });
        if (method === "initialize") push(result(reply(1)));
        else if (method === "thread/start") push(result(reply(2)));
        else if (method === "turn/start") push(result(reply(3)), turnStarted);
        else if (method === "thread/goal/get") push(result({ goal: null }));
        else if (method === "thread/read")
          push(result({ thread: { status: { type: active ? "active" : "idle" } } }));
        else if (method === "thread/backgroundTerminals/list")
          push(result({ data: [], nextCursor: null }));
        else if (method === "turn/interrupt") {
          active = false;
          const turn = { threadId: "thread-warnings", turnId: "turn-warnings" };
          const command = {
            type: "commandExecution",
            id: "cmd-late",
            command: "/bin/bash -lc 'cat research/input.txt'",
            cwd: "/fixture/project",
            processId: null,
            source: "unifiedExecStartup",
            commandActions: [],
            status: "failed",
            aggregatedOutput: "late failure\n",
            exitCode: 1,
            durationMs: 1,
          };
          const item = { type: "agentMessage", id: "message-late", text: LATE_ANSWER };
          push(
            result({}),
            { method: "item/completed", params: { ...turn, item: command } },
            { method: "item/completed", params: { ...turn, item } },
            {
              method: "turn/completed",
              params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "interrupted" } },
            },
          );
        }
      },
      end() {
        if (!ended) push(...closing);
        ended = true;
      },
      closed: Promise.resolve(),
    });
    while (!ended || queue.length) {
      const frame = queue.shift();
      if (frame) yield { type: "stdout", line: JSON.stringify(frame) };
      else await new Promise<void>((resolve) => (wake = resolve));
    }
    yield { type: "exit", code: 0, signal: null, durationMs: 0 };
  };
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

/** `stop` presses Stop on `started` and serves the run from {@link stopping}. */
async function run(
  frames: Frame[],
  closing: Frame[] = [],
  opts: { mode?: "ask" | "agent" | "plan"; stop?: boolean } = {},
) {
  const stop = new AbortController();
  // Live deliveries made after Stop: run events published to observers and
  // harness events handed to the caller's callback.
  const lateLive: Frame[] = [];
  const root = mkdtempSync(join(tmpdir(), "codex-native-warnings-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"],
    { cwd: root, stdio: "pipe" },
  );
  const config = process.env.CLAUDEXOR_CONFIG_DIR!;
  const profile = {
    profile_id: "a",
    harness_id: "codex",
    display_name: "a",
    credential_kind: "config_dir_login",
    isolation_locator: join(config, "profiles", "a"),
  };
  mkdirSync(profile.isolation_locator, { recursive: true });
  writeFileSync(
    join(config, "config.yaml"),
    JSON.stringify({
      credential_profiles: [profile],
      harnesses: { codex: { default_model: "fixture-model" } },
    }),
  );
  const adapter: HarnessAdapter = {
    id: "codex",
    // The real app-server translation, fed the orchestrator's own spec.
    async *run(spec) {
      for await (const event of runCodexAppServer({
        bin: "codex",
        args: [],
        spec,
        env: {},
        spawn: opts.stop ? stopping(closing) : replay(frames, closing),
        pollIntervalMs: 0,
      }))
        yield {
          ...event,
          credential_route: "vendor_native",
          credential_profile_id: spec.credential_profile?.profile_id,
        };
    },
    discover: async () =>
      HarnessManifest.parse({
        id: "codex",
        display_name: "fixture codex",
        kind: "local_cli",
        provider_family: "local",
        capabilities: {
          implement: true,
          explain: true,
          plan: true,
          read_files: true,
          json_schema_output: true,
          work_report_transport: "constrained",
          structured_output_channel: "final_message",
          known_models: ["fixture-model"],
        },
        auth_modes: ["local_session"],
        access_profiles_supported: ["readonly", "workspace_write", "full"],
      }),
    doctor: async () =>
      ConformanceReport.parse({
        harness_id: "codex",
        status: "ok",
        enabled_intents: ["implement", "explain", "plan"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      }),
    probeCredentialProfile: async (p) => ({
      profile_id: p.profile_id,
      harness_id: "codex",
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      last_verified_at: new Date().toISOString(),
    }),
  };
  const snapshots: QuotaSnapshot[] = [
    {
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "a",
      },
      constraints: [],
      source: "codex_app_server",
      observed_at: new Date().toISOString(),
      freshness: "fresh",
    },
  ];
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
    quotaSnapshots: () => snapshots,
  }).run({
    repoRoot: root,
    ...(opts.stop
      ? {
          signal: stop.signal,
          onEvent: (event: { type: string; payload: Frame }) => {
            if (stop.signal.aborted && event.type === "harness.event") lateLive.push(event.payload);
          },
          onHarnessEvent: (event: { type: string }) => {
            if (stop.signal.aborted) lateLive.push(event);
            if (event.type === "started") stop.abort();
          },
        }
      : {}),
    mode: opts.mode ?? "ask",
    prompt: "Explain the fixture.",
    harnesses: ["codex"],
    models: { codex: "fixture-model" },
    authPreference: "subscription",
    review: false,
    web: "off",
  });
  // A cancelled plan run writes no telemetry receipt.
  const telemetry = RunTelemetry.nullable().parse(
    new ArtifactStore(root).readYaml(join(result.runDir, "final/telemetry.yaml")),
  );
  const answerPath = join(result.runDir, "final", "answer.md");
  const read = readRunEventsWithIntegrity({ runDir: result.runDir });
  const stored = read.events
    .filter((row) => row["type"] === "harness.event")
    .map((row) => row["payload"] as Frame);
  return {
    result,
    attempt: telemetry?.attempts[0]!,
    answer: existsSync(answerPath) ? readFileSync(answerPath, "utf8").trim() : null,
    read,
    stored,
    lateLive,
    warnings: stored.filter((row) => row["payload"]?.["code"] === "codex_native_warning"),
  };
}

/** What a warning must not change: the run's outcome axes and its non-warning trail. */
function outcome(out: Awaited<ReturnType<typeof run>>) {
  return {
    lifecycle: out.result.lifecycle,
    facts: out.result.facts,
    answer: out.answer,
    attempt: out.attempt && {
      outcome: out.attempt.outcome,
      tool_errors_total: out.attempt.tool_errors_total,
      unrecovered_tool_errors: out.attempt.unrecovered_tool_errors,
      tool_errors: out.attempt.tool_errors,
      dropped_events: out.attempt.dropped_events,
    },
    trail: out.stored
      .filter((row) => row["payload"]?.["code"] !== "codex_native_warning")
      .map((row) => [row["type"], row["text"]]),
  };
}

describe("Codex native warnings through the durable event log (#337)", () => {
  it("persists startup and pre-turn warnings beside a successful text-only answer and replays them from disk", async () => {
    const out = await run(fixture);
    expect(out.result.lifecycle, out.result.summary).toBe("succeeded");
    expect(out.result.facts.work_state?.state).toBe("completed");
    expect(out.answer).toBe("# Answer\n\nText-only answer: no tool was needed.");
    expect(out.attempt.tool_errors_total).toBe(0);
    expect(out.attempt.outcome).toMatchObject({ status: "success", harness_errored: false });
    expect(out.read.integrity).toMatchObject({ malformedLines: 0, nonObjectLines: 0 });

    // Each native frame is one stored status row; none quotes a secret, so text and params are as sent.
    const native = fixture.filter(isWarning);
    expect(
      out.warnings.map((row) => [
        row["type"],
        row["harness_id"],
        row["payload"]["native_method"],
        row["payload"]["native_params"],
      ]),
    ).toEqual(native.map((frame) => ["status", "codex", frame["method"], frame["params"]]));
    const texts = [
      native[0]!["params"]["summary"],
      native[1]!["params"]["message"],
      native[2]!["params"]["message"],
    ];
    expect(out.warnings.map((row) => row["text"])).toEqual(texts);
    // Queued before the thread and the turn, they still follow the started row.
    const started = out.stored.findIndex((row) => row["type"] === "started");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(out.stored.indexOf(out.warnings[0]!)).toBeGreaterThan(started);

    // The Control timeline reads the same rows back from events.jsonl.
    const rows = timelineEvents({ runDir: out.result.runDir }, out.read.events, out.read.integrity);
    expect(
      rows
        .filter((row) => texts.includes(row.title))
        .map((row) => [row.title, row.detail, row.severity, row.harnessId, row.errorSummary]),
    ).toEqual(texts.map((text) => [text, text, "info", "codex", null]));
  });

  it("leaves lifecycle, facts, answer and telemetry exactly as the same stream without warnings", async () => {
    const [withWarnings, without] = [await run(fixture), await run(withoutWarnings(fixture))];
    expect(without.warnings).toEqual([]);
    expect(withWarnings.warnings).toHaveLength(3);
    expect(outcome(withWarnings)).toEqual(outcome(without));
  });

  it("masks a secret Codex quotes in its warnings at the producer, in every journaled copy, without changing the outcome", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const quoted = fixture.map((frame): Frame => {
      const params = frame["params"];
      if (frame["method"] === "configWarning")
        return {
          ...frame,
          params: { ...params, details: `rejected value ${token}`, path: "/fixture/config.toml" },
        };
      if (frame["method"] === "warning")
        return { ...frame, params: { ...params, message: `${params["message"]} ${token}` } };
      return frame;
    });
    const [masked, plain] = [await run(quoted), await run(fixture)];
    expect(masked.result.lifecycle, masked.result.summary).toBe("succeeded");
    expect(outcome(masked)).toEqual(outcome(plain));

    const native = quoted.filter(isWarning);
    expect(masked.warnings.map((row) => [row["type"], row["payload"]["native_method"]])).toEqual(
      native.map((frame) => ["status", frame["method"]]),
    );
    // Text and params carry the placeholder; the method, path and thread id are as sent.
    expect(masked.warnings[0]!["text"]).toBe(
      `${native[0]!["params"]["summary"]}: rejected value [redacted]`,
    );
    expect(masked.warnings[0]!["payload"]["native_params"]).toEqual({
      ...native[0]!["params"],
      details: "rejected value [redacted]",
    });
    expect(masked.warnings[1]!["payload"]["native_params"]).toEqual({
      ...native[1]!["params"],
      message: `${plain.warnings[1]!["text"]} [redacted]`,
    });
    // No journaled copy anywhere in the run directory holds the token.
    const files = readdirSync(masked.result.runDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => readFileSync(file, "utf8").includes(token))).toEqual([]);
  });

  it("keeps a failed native command's tool-error telemetry and redacts warning text and params", async () => {
    const token = `sk-ant-${"a".repeat(40)}`;
    const failed = commandFailure(token);
    const [withWarnings, without] = [await run(failed), await run(withoutWarnings(failed))];
    expect(outcome(withWarnings)).toEqual(outcome(without));
    expect(withWarnings.result.facts.work_state?.state).toBe("needs_input");
    expect(withWarnings.attempt.tool_errors_total).toBe(1);
    expect(withWarnings.attempt.unrecovered_tool_errors).toBe(1);
    expect(JSON.stringify(withWarnings.attempt.tool_errors)).toContain("RTM_NEWADDR");
    expect(withWarnings.attempt.outcome.harness_errored).toBe(false);

    const logWrite = withWarnings.warnings[2]!;
    expect(logWrite["text"]).toContain("[redacted]");
    expect(logWrite["payload"]["native_params"]["message"]).toContain("[redacted]");
    expect(logWrite["payload"]["native_params"]["threadId"]).toBeNull();
    expect(JSON.stringify(withWarnings.read.events)).not.toContain(token);
    const rows = timelineEvents({ runDir: withWarnings.result.runDir }, withWarnings.read.events);
    expect(rows.find((row) => row.title === logWrite["text"])?.severity).toBe("info");
  });

  it("keeps the startup warning of a run whose thread/start is refused, ahead of the failure, without changing the failure", async () => {
    // The bubblewrap warning is queued behind `initialize`; the thread never starts.
    const refused: Frame[] = [
      fixture[0]!,
      fixture[1]!,
      { id: 2, error: { code: -32603, message: "thread/start refused" } },
    ];
    const [withWarning, without] = [await run(refused), await run(withoutWarnings(refused))];
    expect(without.warnings).toEqual([]);
    expect(withWarning.result.lifecycle).not.toBe("succeeded");
    expect(withWarning.attempt.outcome.harness_errored).toBe(true);
    expect(outcome(withWarning)).toEqual(outcome(without));

    const text = fixture[1]!["params"]["summary"];
    expect(withWarning.warnings.map((row) => [row["type"], row["text"]])).toEqual([
      ["status", text],
    ]);
    const failure = withWarning.stored.findIndex((row) => row["type"] === "error");
    expect(failure).toBeGreaterThan(withWarning.stored.indexOf(withWarning.warnings[0]!));
    const rows = timelineEvents(
      { runDir: withWarning.result.runDir },
      withWarning.read.events,
      withWarning.read.integrity,
    );
    expect(rows.find((row) => row.title === text)).toMatchObject({
      detail: text,
      severity: "info",
      errorSummary: null,
    });
  });

  it("keeps warnings that arrive while the settled run is read and while its process stops, without changing the outcome", async () => {
    const read = { threadId: "thread-warnings", message: "Late warning while the run settled." };
    const stop = { threadId: null, message: "Late warning while the process stopped." };
    // Right behind `turn/completed`: queued before the settled thread is read.
    const settling = fixture.flatMap((frame): Frame[] =>
      frame["method"] === "turn/completed" ? [frame, { method: "warning", params: read }] : [frame],
    );
    const closing: Frame[] = [{ method: "warning", params: stop }];
    const [withWarnings, without] = [
      await run(settling, closing),
      await run(withoutWarnings(settling)),
    ];
    expect(withWarnings.result.lifecycle, withWarnings.result.summary).toBe("succeeded");
    expect(withWarnings.answer).toBe("# Answer\n\nText-only answer: no tool was needed.");
    expect(outcome(withWarnings)).toEqual(outcome(without));

    const late = [read.message, stop.message];
    expect(withWarnings.warnings.map((row) => row["text"]).slice(-2)).toEqual(late);
    expect(withWarnings.warnings).toHaveLength(5);
    const rows = timelineEvents(
      { runDir: withWarnings.result.runDir },
      withWarnings.read.events,
      withWarnings.read.integrity,
    );
    expect(rows.filter((row) => late.includes(row.title)).map((row) => row.severity)).toEqual([
      "info",
      "info",
    ]);
  });
});

describe("Codex native warnings received during an explicit Stop (#337)", () => {
  const closing: Frame[] = [
    { method: "configWarning", params: { summary: "Stopped config warning.", details: "detail" } },
    { method: "warning", params: { threadId: null, message: "Stopped runtime warning." } },
  ];

  it.each(["ask", "agent", "plan"] as const)(
    "%s keeps the warnings its stopped process emits, with the same cancelled outcome and no late answer",
    async (mode) => {
      const [withWarnings, without] = [
        await run([], closing, { mode, stop: true }),
        await run([], [], { mode, stop: true }),
      ];
      expect(withWarnings.result.lifecycle, withWarnings.result.summary).toBe("cancelled");
      expect(withWarnings.warnings.map((row) => row["payload"]["native_params"])).toEqual(
        closing.map((frame) => frame["params"]),
      );
      expect(without.warnings).toEqual([]);
      expect(outcome(withWarnings)).toEqual(outcome(without));
      // Received after Stop: durable evidence only, never the run's answer or
      // the stopped attempt's tool-error verdict.
      expect(withWarnings.stored.some((row) => row["text"] === LATE_ANSWER)).toBe(true);
      expect(withWarnings.answer ?? "").not.toContain(LATE_ANSWER);
      expect(withWarnings.lateLive.filter((row) => row["text"] === LATE_ANSWER)).toEqual([]);
      expect(withWarnings.stored.some((row) => row["type"] === "tool_result")).toBe(true);
      expect(withWarnings.attempt.tool_errors_total).toBe(0);
    },
  );
});
