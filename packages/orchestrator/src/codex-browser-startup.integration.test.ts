import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { spawnProcess } from "@claudexor/core";
import { ArtifactStore } from "@claudexor/artifact-store";
import { repoHash } from "@claudexor/config";
import {
  ControlRunSummary,
  RunTelemetry,
  type HarnessEvent,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { summarizeRun } from "../../control-api/src/run-projection.js";
import { runCodexAppServer } from "../../harness-codex/src/app-server-run.js";
import { readModelListEfforts } from "../../harness-codex/src/effort-probe.js";
import {
  clearCodexEffortCache,
  CODEX_VENDOR_CLI_VERSION,
  createCodexAdapter,
} from "../../harness-codex/src/index.js";
import { Orchestrator } from "./orchestrator.js";

/**
 * #215 through the real consumer. While Codex holds `turn/start` for the selected
 * Browser the adapter yields nothing, and the watchdog does not wake a read already
 * pending at Stop, so only the orchestrator's own Stop wiring can end the wait:
 * `adapter.cancel(activeSessionId)` reaching the real adapter's per-session
 * controller, and the try's composed abort signal. When the wait ends, its one
 * receipt must reach the run's route facts as reported. The vendor process is the
 * only fake; adapter, run loop, orchestrator and projection are real.
 */
const THREAD = "thread-browser-start";
type Frame = Record<string, unknown>;
type Outcome = { status: "ready" | "failed"; error?: string; afterMs: number };

const REPORT = JSON.stringify({
  work_report: { state: "completed", required_inputs: [] },
  output: "Opened the fixture page.",
});

/** A Codex app-server whose Browser reports `starting`, then `outcome` if any. */
function codexWithBrowser(outcome?: Outcome) {
  const methods: string[] = [];
  let spawns = 0;
  const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
    spawns += 1;
    const queue: Frame[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    const push = (...frames: Frame[]): void => {
      queue.push(...frames);
      wake?.();
      wake = undefined;
    };
    const browser = (status: string, error: string | null = null): Frame => ({
      method: "mcpServer/startupStatus/updated",
      params: { threadId: THREAD, name: "browser", status, error },
    });
    options.onSpawn?.({
      write(line) {
        const { id, method } = JSON.parse(line) as { id?: number; method: string };
        methods.push(method);
        const reply = (result: Frame): Frame => ({ id, result });
        const turn = { threadId: THREAD, turnId: "turn-1" };
        if (method === "initialize") push(reply({}));
        else if (method === "thread/start") {
          push(reply({ thread: { id: THREAD } }), browser("starting"));
          if (outcome)
            setTimeout(() => push(browser(outcome.status, outcome.error)), outcome.afterMs);
        } else if (method === "thread/goal/get") push(reply({ goal: null }));
        else if (method === "thread/read")
          push(reply({ thread: { id: THREAD, status: { type: "idle" } } }));
        else if (method === "thread/backgroundTerminals/list")
          push(reply({ data: [], nextCursor: null }));
        else if (method === "turn/start")
          push(
            reply({ turn: { id: "turn-1" } }),
            { method: "turn/started", params: { threadId: THREAD, turn: { id: "turn-1" } } },
            {
              method: "item/completed",
              params: { ...turn, item: { type: "agentMessage", id: "m1", text: REPORT } },
            },
            {
              method: "turn/completed",
              params: { threadId: THREAD, turn: { id: "turn-1", status: "completed" } },
            },
          );
      },
      end() {
        ended = true;
        wake?.();
        wake = undefined;
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
  return { spawn, methods, spawns: () => spawns };
}

/** Which of the orchestrator's two Stop channels reach the app-server run loop. */
type Channels = "both" | "adapter_cancel" | "abort_signal" | "none";

const roots: string[] = [];
afterEach(() => {
  clearCodexEffortCache();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

async function browserRun(opts: {
  outcome?: Outcome;
  stop?: boolean;
  channels?: Channels;
  browserStartupDeadlineMs?: number;
}) {
  const channels = opts.channels ?? "both";
  const root = mkdtempSync(join(tmpdir(), "codex-browser-start-"));
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
    isolation_locator: join(config, "profiles", `browser-start-${roots.length}`),
  };
  mkdirSync(profile.isolation_locator, { recursive: true });
  writeFileSync(join(config, "config.yaml"), JSON.stringify({ credential_profiles: [profile] }));
  // Codex receives Browser only on full access, which needs the existing grant.
  mkdirSync(join(config, "trust"), { recursive: true });
  writeFileSync(join(config, "trust", `${repoHash(root)}.yaml`), "allow_full_access: true\n");

  const peer = codexWithBrowser(opts.outcome);
  const adapter = createCodexAdapter({
    detectVersion: async () => CODEX_VENDOR_CLI_VERSION,
    brokenInstallAdvisory: () => null,
    hasApiKey: () => false,
    codexApiKey: () => undefined,
    resolveProfileSecret: () => null,
    probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
    probeEfforts: async () =>
      readModelListEfforts([
        {
          id: "fixture-model",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        },
      ]),
    // The adapter's own controller and spec; a test only removes channels.
    runAppServer: (input) =>
      runCodexAppServer({
        ...input,
        spawn: peer.spawn,
        pollIntervalMs: 5,
        ...(opts.browserStartupDeadlineMs === undefined
          ? {}
          : { browserStartupDeadlineMs: opts.browserStartupDeadlineMs }),
        ...(channels === "both" || channels === "adapter_cancel" ? {} : { controller: undefined }),
        ...(channels === "both" || channels === "abort_signal"
          ? {}
          : { spec: { ...input.spec, extra: { ...input.spec.extra, abortSignal: undefined } } }),
      }),
  });
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
  const stop = new AbortController();
  const seen: HarnessEvent[] = [];
  let stoppedAt = 0;
  const pressStop = opts.stop
    ? (async () => {
        // thread/start answered with Browser `starting`: the adapter holds turn/start.
        while (!peer.methods.includes("thread/start")) await new Promise((r) => setTimeout(r, 2));
        await new Promise((r) => setTimeout(r, 50));
        stoppedAt = performance.now();
        stop.abort();
      })()
    : null;
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
    quotaSnapshots: () => snapshots,
  }).run({
    repoRoot: root,
    signal: stop.signal,
    onHarnessEvent: (event) => seen.push(event),
    mode: "agent",
    access: "full",
    prompt: "Open the fixture page.",
    harnesses: ["codex"],
    models: { codex: "fixture-model" },
    authPreference: "subscription",
    review: false,
    web: "auto",
    browser: true,
  });
  const resolvedMs = performance.now() - stoppedAt;
  await pressStop;
  const telemetry = RunTelemetry.nullable().parse(
    new ArtifactStore(root).readYaml(join(result.runDir, "final/telemetry.yaml")),
  );
  const summary = ControlRunSummary.parse(
    summarizeRun({
      id: "job-browser-start",
      runId: result.runId,
      taskId: result.taskId,
      state: result.lifecycle,
      runDir: result.runDir,
      params: { mode: "agent", prompt: "Open the fixture page.", access: "full" },
    }),
  );
  return { result, peer, seen, resolvedMs, attempt: telemetry?.attempts[0], summary };
}

describe("Stop during the selected Browser's startup, through the real orchestrator (#215)", () => {
  it.each<Channels>(["both", "adapter_cancel", "abort_signal"])(
    "ends the run promptly without starting the turn (Stop channels: %s)",
    async (channels) => {
      // The real hold stays in force (Codex's 90 s limit plus the adapter's 5 s
      // grace for its status): only Stop may end this wait.
      const out = await browserRun({ stop: true, channels });
      expect(out.result.lifecycle, out.result.summary).toBe("cancelled");
      expect(out.resolvedMs).toBeLessThan(5_000);
      expect(out.peer.methods).not.toContain("turn/start");
      // The live app-server was asked to settle, not merely killed.
      expect(out.peer.methods).toContain("thread/goal/get");
      expect(out.peer.spawns()).toBe(1);
      // Prepared Browser settings are not a connection: nothing reported a start or an outcome.
      expect(out.seen.some((event) => event.type === "started")).toBe(false);
      expect(out.seen.some((event) => event.payload?.["code"] === "codex_browser_startup")).toBe(
        false,
      );
      expect(out.attempt?.route_controls).toMatchObject({ access: "full" });
      expect(out.attempt?.native_session_started).toBe(false);
      expect(out.attempt?.browser).toMatchObject({ requested: true });
      expect(out.attempt?.browser?.startup).toBeUndefined();
      expect(out.summary.routeControls).toMatchObject([
        { harnessId: "codex", browser: true, nativeSessionStarted: false, browserStartup: null },
      ]);
    },
  );

  it("negative control: with neither channel the wait outlives Stop and the turn starts late", async () => {
    // The same run with the orchestrator's Stop severed from the run loop: the
    // wait ends only at its (here shortened) backstop, after Stop, and then
    // starts the turn. The assertions above would all fail on this boundary.
    const out = await browserRun({ stop: true, channels: "none", browserStartupDeadlineMs: 1_500 });
    expect(out.resolvedMs).toBeGreaterThanOrEqual(1_400);
    expect(out.peer.methods).toContain("turn/start");
  });
});

describe("the selected Browser's startup outcome reaches the run's route facts (#215)", () => {
  it.each([
    { outcome: { status: "ready", afterMs: 30 } as Outcome, expected: { status: "ready" } },
    {
      outcome: { status: "failed", error: "browser launcher exited", afterMs: 30 } as Outcome,
      expected: { status: "failed", error: "browser launcher exited" },
    },
  ])("$outcome.status", async ({ outcome, expected }) => {
    const out = await browserRun({ outcome });
    // The turn starts only after the outcome, and Browser stays optional either way.
    expect(out.peer.methods.indexOf("turn/start")).toBeGreaterThan(
      out.peer.methods.indexOf("thread/start"),
    );
    expect(out.attempt?.native_session_started).toBe(true);
    expect(out.attempt?.browser?.startup).toMatchObject({ ...expected });
    expect(out.attempt?.browser?.startup?.waited_ms).toBeGreaterThanOrEqual(0);
    expect(out.summary.routeControls).toMatchObject([
      {
        harnessId: "codex",
        browser: true,
        browserStartup: { ...expected, error: expected.error ?? null },
      },
    ]);
    // A startup verdict is not Browser use or web retrieval.
    expect(out.attempt?.browser).toMatchObject({ attempted: false, satisfied: false });
    expect(out.summary.webEvidence).toMatchObject({ attempted: false, verification: "none" });
  });

  it("a Browser still starting at the deadline is reported as still starting", async () => {
    const out = await browserRun({ browserStartupDeadlineMs: 300 });
    expect(out.peer.methods).toContain("turn/start");
    expect(out.attempt?.browser?.startup).toMatchObject({ status: "starting" });
    expect(out.attempt?.browser?.startup?.waited_ms).toBeGreaterThanOrEqual(300);
    expect(out.summary.routeControls[0]?.browserStartup).toMatchObject({ status: "starting" });
  });
});
