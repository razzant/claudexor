/**
 * Joined #453/#454 regression: real spawnProcess pipes -> Codex adapter ->
 * Orchestrator barrier/YAML -> HTTP serialization. No vendor or account calls.
 * Discovery/model replies and the Windows OS proof/census are explicit seams;
 * the daemon facade supplies the run record (no SQL queue/worker is claimed).
 * The native peer's descendant writes only AFTER its root has exited. Its exact
 * stop file owns cleanup; closing our pipe never counts as killing that child.
 * Arrival is causal, never a race with the drain bound: before its root may
 * exit, the descendant writes hold frames this test keeps unconsumed, so the
 * bounded reader is blocked on capacity (a blocked reader is never quiet) until
 * the root has exited AND every late frame is in the pipe. The drain contract
 * is the frames already read at forced closure, not output written after it.
 * Set CLAUDEXOR_TEST_CAPTURE_JOINED_DIR to a NEW absolute directory to retain
 * raw HTTP bytes, native/adapter telemetry, artifacts and fixture identities.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  DaemonControlApiServer,
  type DaemonFacadeClient,
  type DaemonRunRecord,
} from "@claudexor/control-api";
import {
  mintRunScopeMarker,
  reapProcessTree,
  reapScopeMembers,
  spawnProcess,
  WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE,
  type HarnessAdapter,
  type ProcEvent,
} from "@claudexor/core";
import { readRunEvents } from "../../event-log/src/index.js";
import { createFakeHarness } from "@claudexor/harness-fake";
import { Orchestrator, type OrchestratorResult } from "@claudexor/orchestrator";
import {
  CONTROL_PROTOCOL_MAJOR,
  RunProcessScopeOutcome,
  type HarnessEvent,
} from "@claudexor/schema";
import { projectRuntimeDir } from "@claudexor/util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCodexAppServer } from "../../harness-codex/src/app-server-run.js";

const peer = fileURLToPath(
  new URL("../../harness-codex/fixtures/app-server/cleanup-peer.mjs", import.meta.url),
);
const capture = process.env["CLAUDEXOR_TEST_CAPTURE_JOINED_DIR"];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let base = "";
beforeAll(() => {
  if (capture && existsSync(capture) && readdirSync(capture).length)
    throw new Error("CLAUDEXOR_TEST_CAPTURE_JOINED_DIR must be new or empty");
  base = capture ?? mkdtempSync(join(tmpdir(), "cx-joined-drain-"));
  mkdirSync(base, { recursive: true });
});
afterAll(() => {
  if (!capture && !existsSync(join(base, "cleanup-unknown.json")))
    rmSync(base, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

type Frame = { method: string; params: Record<string, unknown> };
const childFrame: Frame = {
  method: "thread/status/changed",
  params: { threadId: "child", status: { type: "systemError" } },
};
const rootFrames: Frame[] = [
  {
    method: "thread/status/changed",
    params: { threadId: "root", status: { type: "systemError" } },
  },
  {
    method: "turn/completed",
    params: { threadId: "root", turn: { id: "turn", status: "interrupted" } },
  },
  {
    method: "turn/completed",
    params: { threadId: "root", turn: { id: "turn", status: "failed" } },
  },
  { method: "turn/started", params: { threadId: "root", turn: { id: "new-root-turn" } } },
];
/** Benign frames the descendant writes in one write before its root may exit. */
const holdFrames: Frame[] = [0, 1, 2].map((hold) => ({
  method: "thread/status/changed",
  params: { threadId: "child", status: { type: "idle" }, hold },
}));
const EXIT_DRAIN_MS = 150;
/** A liveness bound only (the hold orders arrival); it is what cuts continuous output. */
const EXIT_DRAIN_MAX_MS = 10_000;
const childOwned = (frames: Frame[]): Frame[] =>
  frames.map((frame) => ({ ...frame, params: { ...frame.params, threadId: "child" } }));
interface Scenario {
  name: string;
  verdict?: "PASS" | "FAIL";
  mode?: "quiet" | "continuous" | "finite";
  frames?: Frame[];
  cleanup?: "windows" | "confirmed" | "survivor" | "mixed" | "empty";
  buffered?: boolean;
  cancel?: boolean;
  emptyAnswer?: boolean;
  writeFailure?: boolean;
  negative?: boolean;
  /** SIGSTOP the descendant for this long once the root's exit is observed. */
  stallMs?: number;
  /** The descendant writes its late frames only after the forced closure. */
  afterDrain?: boolean;
  /** The production Codex line reader: no capacity hold, hence no late frames. */
  productionReader?: boolean;
}
const verdictOf = (scenario: Scenario) => ({
  verdict: scenario.verdict ?? "PASS",
  findings:
    scenario.verdict === "FAIL"
      ? [
          {
            severity: "critical",
            item: "joined acceptance criterion",
            recommendation: "Repair the fixture defect before acceptance.",
            evidence: "Joined fixture acceptance criterion is violated.",
          },
        ]
      : [],
  summary:
    scenario.verdict === "FAIL" ? "A substantive fixture defect." : "All fixture criteria hold.",
});

async function detail(result: OrchestratorResult, repo: string): Promise<Buffer> {
  const record: DaemonRunRecord = {
    id: `job-${result.runId}`,
    runId: result.runId,
    taskId: result.taskId,
    state: result.lifecycle,
    runDir: result.runDir,
    params: {
      mode: "ask",
      prompt: "Review the fixture",
      scope: { kind: "project", root: repo },
      harnesses: ["codex"],
      n: 1,
    },
  };
  const daemon: DaemonFacadeClient = {
    async enqueue() {
      throw new Error("read-only fixture");
    },
    async status() {
      return record;
    },
    async list() {
      return [record];
    },
    async cancel() {
      throw new Error("read-only fixture");
    },
  };
  const server = new DaemonControlApiServer({ token: "joined-fixture-token", pollMs: 1, daemon });
  const { host, port } = await server.start();
  try {
    const response = await fetch(`http://${host}:${port}/v2/runs/${result.runId}`, {
      headers: {
        authorization: "Bearer joined-fixture-token",
        "X-Claudexor-Protocol-Major": String(CONTROL_PROTOCOL_MAJOR),
      },
    });
    expect(response.status).toBe(200);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    await server.stop();
  }
}

async function joined(scenario: Scenario): Promise<void> {
  const dir = join(base, scenario.name);
  const repo = join(dir, "project");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Ordinary-directory fixture\n");
  process.env.CLAUDEXOR_CONFIG_DIR = join(dir, "engine-home");
  const identity = join(dir, "holder.json");
  const stop = join(dir, "stop-holder");
  const afterExit = join(dir, "after-exit");
  const plan = join(dir, "plan.json");
  const held = join(dir, "held");
  const written = join(dir, "late-written");
  const afterDrain = join(dir, "after-drain");
  const frames = scenario.frames ?? (scenario.productionReader ? [] : [childFrame]);
  writeFileSync(
    plan,
    JSON.stringify({
      identity,
      stop,
      afterExit,
      frames,
      hold: holdFrames,
      held,
      written,
      ...(scenario.afterDrain ? { afterDrain } : {}),
      mode: scenario.mode ?? "quiet",
      split: scenario.buffered,
      partial: scenario.buffered,
    }),
  );
  const proc: ProcEvent[] = [];
  const adapterEvents: HarnessEvent[] = [];
  const trace: string[] = [];
  const abort = new AbortController();
  let marker = "";
  let directExitAt = 0;
  let drainedAt = 0;
  let aliveAfterDrain = false;
  let atTerminal: unknown;
  let releaseDrain!: () => void;
  const drained = new Promise<void>((resolve) => {
    releaseDrain = resolve;
  });
  let settleCount = 0;
  let paused = false;
  let holding = false;
  let writtenAtRelease: boolean | null = null;
  const holderPid = (): number | undefined =>
    existsSync(identity)
      ? (JSON.parse(readFileSync(identity, "utf8")) as { pid: number }).pid
      : undefined;
  const alive = (): boolean => {
    const pid = holderPid();
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  const stopHolder = async (): Promise<void> => {
    writeFileSync(stop, "stop only this fixture\n");
    const until = Date.now() + 3000;
    while (alive() && Date.now() < until) await sleep(20);
    if (alive()) {
      writeFileSync(join(base, "cleanup-unknown.json"), JSON.stringify({ dir, pid: holderPid() }));
      throw new Error("fixture cleanup unknown; retained for inspection");
    }
  };
  const fake = createFakeHarness("fake-work-complete");
  const adapter: HarnessAdapter = {
    ...fake,
    id: "codex",
    async discover() {
      return { ...(await fake.discover()), id: "codex" };
    },
    async doctor(ctx) {
      return { ...(await fake.doctor(ctx)), harness_id: "codex" };
    },
    async *run(spec) {
      trace.push("launch");
      const events = runCodexAppServer({
        bin: process.execPath,
        args: [peer, ...(scenario.cancel ? ["--wait-for-cancel"] : [])],
        env: {
          ...spec.env,
          CX_FIXTURE_DRAIN_PLAN: plan,
          CX_FIXTURE_ANSWER: scenario.emptyAnswer
            ? ""
            : JSON.stringify({
                work_report: { state: "completed", required_inputs: [] },
                output: verdictOf(scenario),
              }),
        },
        spec,
        pollIntervalMs: 0,
        spawn: async function* (bin, args, options) {
          for await (const event of spawnProcess(bin, args, {
            ...options,
            exitDrainMs: EXIT_DRAIN_MS,
            exitDrainMaxMs: EXIT_DRAIN_MAX_MS,
            cancelKillDelayMs: 10000,
            ...(scenario.productionReader
              ? {}
              : { streamLimits: { stdoutFrameBytes: 65536, queuedFrames: 1, stderrBytes: 4096 } }),
            onExit: () => {
              directExitAt = Date.now();
              trace.push("direct-exit");
              const pid = holderPid();
              if (scenario.stallMs && pid) {
                // A scheduler stall of the descendant longer than the quiet bound.
                process.kill(pid, "SIGSTOP");
                setTimeout(() => process.kill(pid, "SIGCONT"), scenario.stallMs);
              }
            },
            reap: async (opts) => {
              // Synchronization only: let real EOF and post-exit bytes arrive
              // before a real reaper can close the fixture's inherited pipes.
              await drained;
              aliveAfterDrain = alive();
              if (scenario.cleanup === "survivor") {
                expect(aliveAfterDrain).toBe(true);
                return { state: "unconfirmed", survivors: [holderPid()!], unresolved: [] };
              }
              await stopHolder();
              const actual = await reapProcessTree(opts);
              if (actual.state === "unconfirmed" && actual.survivors.length) return actual;
              if (scenario.cleanup === "confirmed") return actual;
              return {
                state: "unconfirmed",
                survivors: [],
                unresolved:
                  scenario.cleanup === "empty"
                    ? []
                    : [
                        { pgid: opts.rootPid, reason: WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE },
                        ...(scenario.cleanup === "mixed"
                          ? [{ pgid: opts.rootPid, reason: "identity_unavailable" }]
                          : []),
                      ],
              };
            },
          })) {
            proc.push(event);
            if (event.type === "exit") {
              drainedAt = Date.now();
              trace.push("drained");
              if (scenario.afterDrain) writeFileSync(afterDrain, "forced closure observed\n");
              releaseDrain();
            }
            if (
              !holding &&
              event.type === "stdout" &&
              event.line === JSON.stringify(holdFrames[0])
            ) {
              holding = true;
              trace.push("held");
              writeFileSync(held, "first hold frame taken\n"); // the descendant may now let its root exit
              if (!scenario.productionReader) {
                // Consume nothing more until the root exited and every late frame is in
                // the pipe (finite: until the descendant closed it too).
                const ready = () =>
                  directExitAt > 0 &&
                  (scenario.afterDrain ||
                    (existsSync(written) && (scenario.mode !== "finite" || !alive())));
                for (const until = Date.now() + 2 * EXIT_DRAIN_MAX_MS; !ready();) {
                  if (Date.now() > until) break;
                  await sleep(5);
                }
                writtenAtRelease = existsSync(written);
                trace.push("release");
              }
            }
            if (
              scenario.buffered &&
              !paused &&
              event.type === "stdout" &&
              event.line === JSON.stringify(frames[0])
            ) {
              paused = true;
              await sleep(800); // force closure while additional split frames are already buffered
            }
            yield event;
          }
        },
      });
      for await (const event of events) {
        adapterEvents.push(event);
        if (scenario.cancel && event.type === "started") abort.abort();
        yield event;
      }
    },
  };
  try {
    const result = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
      runScopes: {
        async open() {
          trace.push("open");
          marker = mintRunScopeMarker();
          return { marker };
        },
        async settle(runId, scopeMarker) {
          settleCount++;
          trace.push("settle");
          await stopHolder();
          if (scenario.writeFailure)
            mkdirSync(join(projectRuntimeDir(repo), "runs", runId, "final", "process_scope.yaml"));
          // The real scope outcome owner, with the Windows census explicitly
          // unavailable. This is OS-proof simulation on a POSIX test host.
          return reapScopeMembers({ marker: scopeMarker, platform: "win32", census: null });
        },
      },
    }).run({
      repoRoot: repo,
      mode: "ask",
      prompt: "Review the fixture",
      harnesses: ["codex"],
      signal: abort.signal,
      outputSchema: {
        type: "object",
        required: ["verdict", "findings", "summary"],
        properties: {
          verdict: { type: "string", enum: ["PASS", "FAIL"] },
          findings: { type: "array", items: { type: "object" } },
          summary: { type: "string" },
        },
      },
      onEvent: (event) => {
        if (!["run.completed", "run.failed", "run.blocked"].includes(event.type)) return;
        trace.push("terminal");
        const path = join(
          projectRuntimeDir(repo),
          "runs",
          event.run_id,
          "final",
          "process_scope.yaml",
        );
        atTerminal = scenario.writeFailure
          ? "write-failed"
          : new ArtifactStore(repo).readYaml(path);
      },
    });
    const runEvents = readRunEvents(join(result.runDir, "events.jsonl")).events;
    const raw = await detail(result, repo);
    writeFileSync(join(dir, "detail.json"), raw);
    writeFileSync(
      join(dir, "telemetry.json"),
      JSON.stringify(
        {
          scenario,
          result,
          trace,
          proc,
          adapterEvents,
          directExitAt,
          drainedAt,
          aliveAfterDrain,
          atTerminal,
          settleCount,
        },
        null,
        2,
      ),
    );
    const body = JSON.parse(raw.toString("utf8"));
    expect(settleCount).toBe(1);
    // The causal order, asserted rather than assumed: held before the root
    // exits; released only after the exit and (except the negative control)
    // after the descendant handed every late frame to the pipe.
    expect(trace.indexOf("held")).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf("held")).toBeLessThan(trace.indexOf("direct-exit"));
    if (!scenario.productionReader) {
      expect(trace.indexOf("direct-exit")).toBeLessThan(trace.indexOf("release"));
      expect(trace.indexOf("release")).toBeLessThan(trace.indexOf("drained"));
      expect(writtenAtRelease).toBe(!scenario.afterDrain);
    }
    expect(trace.indexOf("direct-exit")).toBeLessThan(trace.indexOf("drained"));
    expect(trace.indexOf("drained")).toBeLessThan(trace.indexOf("settle"));
    expect(trace.indexOf("settle")).toBeLessThan(trace.indexOf("terminal"));
    expect(JSON.parse(readFileSync(identity, "utf8")).markers).toContain(marker);
    expect(existsSync(afterExit)).toBe(true);
    const read = (frame: Frame): boolean =>
      proc.some((event) => event.type === "stdout" && event.line === JSON.stringify(frame));
    for (const frame of holdFrames) expect(read(frame)).toBe(true);
    if (scenario.afterDrain) {
      expect(existsSync(written), "the descendant wrote after the forced closure").toBe(true);
      for (const frame of frames) expect(read(frame), "never delivered after closure").toBe(false);
    } else
      for (const frame of frames)
        expect(proc).toContainEqual(
          expect.objectContaining({ type: "stdout", line: JSON.stringify(frame) }),
        );
    const exit = proc.find((event) => event.type === "exit");
    expect(exit).toMatchObject(
      scenario.mode === "finite" ? { type: "exit" } : { drain: "truncated" },
    );
    if (scenario.mode === "finite") expect(exit).not.toHaveProperty("drain");
    else expect(aliveAfterDrain, "closing the reader is not process death").toBe(true);
    // Continuous output cannot renew the absolute bound; everything else ends quietly.
    if (scenario.mode === "continuous")
      expect(drainedAt - directExitAt).toBeGreaterThanOrEqual(EXIT_DRAIN_MAX_MS);
    else expect(drainedAt - directExitAt).toBeLessThan(EXIT_DRAIN_MAX_MS);
    if (scenario.buffered) expect(paused).toBe(true);
    if (!scenario.cancel) {
      const terminal = runEvents.find(
        (event) => event.type === "harness.event" && event.payload["type"] === "completed",
      );
      if (scenario.mode !== "finite")
        expect(terminal?.payload["payload"]).toMatchObject({ output_drain: "truncated" });
      expect(adapterEvents.at(-1)?.payload?.["output_drain"]).toBe(
        scenario.mode === "finite" ? undefined : "truncated",
      );
    }
    expect(Object.hasOwn(body.summary, "processScope")).toBe(true);
    if (scenario.writeFailure) expect(body.summary.processScope).toBeNull();
    else {
      expect(RunProcessScopeOutcome.parse(atTerminal)).toMatchObject({
        settled: false,
        census: "unsupported",
        completeness: "not_provable",
      });
      expect(body.summary.processScope).toEqual({
        settled: false,
        coverage: "tree_only",
        completeness: "not_provable",
        census: "unsupported",
        survivors: 0,
        unreadable: 0,
      });
    }
    if (scenario.negative) {
      expect(adapterEvents.some((event) => event.final)).toBe(false);
      expect(result.lifecycle).not.toBe("succeeded");
      expect(body.summary.state).not.toBe("succeeded");
      expect(body.summary.outputConformance).not.toBe("passed");
      expect(body.primaryOutput?.kind).not.toBe("structured_output");
      if (scenario.cancel) expect(result.lifecycle).toBe("cancelled");
      else expect(adapterEvents.some((event) => event.type === "error")).toBe(true);
    } else {
      expect(result.lifecycle).toBe("succeeded");
      expect(body.summary.outputConformance).toBe("passed");
      expect(body.primaryOutput.kind).toBe("structured_output");
      expect(JSON.parse(body.primaryOutput.text)).toEqual(verdictOf(scenario));
      if (scenario.cleanup !== "confirmed")
        expect(adapterEvents.at(-1)?.payload?.["termination_unconfirmed"]).toMatchObject({
          survivors: [],
          unresolved: [{ reason: WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE }],
        });
    }
  } finally {
    releaseDrain();
    await stopHolder();
  }
}

describe("post-exit Codex drain through scope receipt and real GET detail", () => {
  it.each(["PASS", "FAIL"] as const)(
    "keeps substantive %s with held pipe and unsupported scope",
    (verdict) => joined({ name: `quiet-${verdict}`, verdict }),
  );
  it.each(["finite", "continuous"] as const)("finishes %s trailing frames honestly", (mode) =>
    joined({ name: mode, mode }),
  );
  it("rejects a finite late root error without claiming truncation", () =>
    joined({
      name: "finite-root-error",
      mode: "finite",
      cleanup: "confirmed",
      frames: [rootFrames[0]!],
      negative: true,
    }));
  it("keeps complete split frames already buffered at forced closure", () =>
    joined({
      name: "buffered",
      buffered: true,
      frames: [
        childFrame,
        { ...childFrame, params: { threadId: "child", status: { type: "idle" } } },
      ],
    }));
  it("keeps FAIL with explicit null when the single receipt write fails", () =>
    joined({ name: "write-failure", verdict: "FAIL", writeFailure: true }));
  for (const cleanup of ["windows", "confirmed"] as const) {
    it.each(rootFrames.map((frame, i) => ({ frame, i })))(
      `${cleanup}: rejects late root $i`,
      ({ frame, i }) =>
        joined({ name: `${cleanup}-late-${i}`, cleanup, frames: [frame], negative: true }),
    );
    it(`${cleanup}: child control frames never invalidate root finality`, () =>
      joined({ name: `${cleanup}-child`, cleanup, frames: childOwned(rootFrames) }));
  }
  // Controls for the causal hold: a descendant stalled past the quiet bound
  // (the scheduling delay behind the short-gate failure) still has every late
  // frame read, and output written only after the forced closure never is.
  it.runIf(process.platform !== "win32")(
    "keeps every late frame of a descendant stalled past the quiet bound",
    () =>
      joined({
        name: "stalled-child",
        cleanup: "confirmed",
        stallMs: 600,
        frames: childOwned(rootFrames),
      }),
  );
  it.runIf(process.platform !== "win32")(
    "still rejects a late root error from a descendant stalled past the quiet bound",
    () =>
      joined({
        name: "stalled-root",
        cleanup: "confirmed",
        stallMs: 600,
        frames: [rootFrames[0]!],
        negative: true,
      }),
  );
  it("never delivers output written after the forced closure, which stays disclosed", () =>
    joined({
      name: "after-drain",
      cleanup: "confirmed",
      afterDrain: true,
      frames: [rootFrames[0]!],
    }));
  it("keeps substantive PASS with a held pipe on the production line reader", () =>
    joined({ name: "production-quiet", productionReader: true }));
  it("rejects a root failure assembled from already buffered chunks", () =>
    joined({
      name: "buffered-root-error",
      buffered: true,
      frames: [childFrame, rootFrames[0]!],
      negative: true,
    }));
  it.each(["survivor", "mixed", "empty"] as const)("keeps %s cleanup negative", (cleanup) =>
    joined({ name: cleanup, cleanup, negative: true }),
  );
  it("keeps real external cancellation negative", () =>
    joined({ name: "cancel", cancel: true, negative: true }));
  it("does not promote an empty answer", () =>
    joined({ name: "empty-answer", emptyAnswer: true, negative: true }));
});
