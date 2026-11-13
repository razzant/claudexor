import { mkdtempSync, promises, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultHighWaterMark } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import { BudgetLedger, routeCostEvidence } from "@claudexor/budget";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { nowIso, orderedAppender } from "@claudexor/util";
import type { HarnessAdapter } from "@claudexor/core";
import {
  DEEP_SCAN_REDUCER_ATTEMPT_ID,
  runDeepScanReducer,
  type DeepScanReducerDeps,
} from "./deepScanReducer.js";
import type { WorkReportEnvelopeMode } from "./workReportEnvelope.js";
import type { RoutedAdapter } from "./orchestrator.js";

/**
 * D-16 wave-1 parity: the deep-scan bounded reducer must unwrap + finalize its
 * output through the SAME WorkReport contract as every other attempt. A capable
 * reducer route that breaks the contract (malformed) or attests
 * needs_input/incomplete is a typed reducer FAILURE — never a laundered
 * synthesis — so the caller degrades to the honest raw scout bundle.
 */

const __dirs: string[] = [];
afterAll(() => {
  for (const d of __dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

/** An adapter that emits a single final message (the reducer's raw output). */
function reducerAdapter(finalText: string): HarnessAdapter {
  async function* run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
    const s = spec.session_id;
    yield { type: "started", session_id: s, ts: nowIso() };
    yield {
      type: "message",
      session_id: s,
      ts: nowIso(),
      text: finalText,
      final: true,
      payload: { final_source: "test" },
    };
    yield {
      type: "usage",
      session_id: s,
      ts: nowIso(),
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001 },
    };
    yield { type: "completed", session_id: s, ts: nowIso() };
  }
  return {
    id: "fake-reducer",
    discover: () => Promise.reject(new Error("unused")),
    doctor: () => Promise.reject(new Error("unused")),
    run,
    review: run,
    cancel: () => Promise.resolve(),
  } as unknown as HarnessAdapter;
}

/** A CONSTRAINED WorkReport transport mode (the `{work_report, output}` envelope
 * a capable reducer route would ride). */
const constrainedMode: WorkReportEnvelopeMode = {
  active: true,
  source: "constrained",
  hasCallerSchema: false,
  channel: "constrained_json",
  instruction: null,
};

/** A schema-free (inactive-transport) reducer route — the report passes through
 * untouched, so a plain final message would OTHERWISE be a clean success. */
const inactiveMode: WorkReportEnvelopeMode = {
  active: false,
  source: "absent",
  hasCallerSchema: false,
  channel: "constrained_json",
  instruction: null,
};

/** An adapter that emits a clean final message and then aborts `outer` mid-stream
 * (after the message, before completion) — the cancel-during-reducer race. */
function abortingReducerAdapter(finalText: string, outer: AbortController): HarnessAdapter {
  async function* run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
    const s = spec.session_id;
    yield { type: "started", session_id: s, ts: nowIso() };
    yield {
      type: "message",
      session_id: s,
      ts: nowIso(),
      text: finalText,
      final: true,
      payload: { final_source: "test" },
    };
    outer.abort(); // the run was cancelled WHILE the synthesis streamed
    yield { type: "completed", session_id: s, ts: nowIso() };
  }
  return {
    id: "fake-reducer",
    discover: () => Promise.reject(new Error("unused")),
    doctor: () => Promise.reject(new Error("unused")),
    run,
    review: run,
    cancel: () => Promise.resolve(),
  } as unknown as HarnessAdapter;
}

/** A reducer that has already produced a valid report when the inactivity
 * watchdog fires. The adapter reacts to the watchdog's INTERNAL abort by
 * emitting its terminal drain event, mirroring the native process-reap path. */
function timeoutDrainingReducerAdapter(finalText: string): HarnessAdapter {
  async function* run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
    const s = spec.session_id;
    const abortSignal = spec.extra["abortSignal"] as AbortSignal;
    yield { type: "started", session_id: s, ts: nowIso() };
    yield {
      type: "message",
      session_id: s,
      ts: nowIso(),
      text: finalText,
      final: true,
      payload: { final_source: "test" },
    };
    await new Promise<void>((resolve) => {
      if (abortSignal.aborted) resolve();
      else abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    yield { type: "completed", session_id: s, ts: nowIso() };
  }
  return {
    id: "fake-reducer",
    discover: () => Promise.reject(new Error("unused")),
    doctor: () => Promise.reject(new Error("unused")),
    run,
    review: run,
    cancel: () => Promise.resolve(),
  } as unknown as HarnessAdapter;
}

function makeDeps(mode: WorkReportEnvelopeMode): DeepScanReducerDeps {
  return {
    newReadOnlyHome: () => ({ env: {}, dispose: async () => {} }),
    costEvidence: () =>
      routeCostEvidence({
        billing: "metered",
        knowledge: "estimated",
        source: "test-pricing",
        provenance: ["fixture:deepscan"],
        estimatedUsd: 0.01,
      }),
    buildSpec: (_routed, homeEnv, prompt) => ({
      spec: HarnessRunSpec.parse({
        session_id: "ses_reducer",
        intent: "synthesize",
        prompt,
        cwd: tmpdir(),
        access: "readonly",
        env: homeEnv,
      }),
      webPolicy: "off",
      effectiveWeb: "off",
      model: null,
      workReportMode: mode,
    }),
    hardTimeoutMs: 5_000,
    inactivityTimeoutMs: 5_000,
    webRequired: false,
  };
}

function makeFiniteFixture(onPersist?: ConstructorParameters<typeof EventLog>[3]) {
  const root = mkdtempSync(join(tmpdir(), "claudexor-deepscan-"));
  __dirs.push(root);
  const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
  const paths = store.createRun("run-reducer");
  return {
    root,
    paths,
    log: new EventLog(paths.eventsPath, "run-reducer", "task-reducer", onPersist),
    ledger: new BudgetLedger({ kind: "finite", maxUsd: 1 }),
  };
}

function runFiniteReducer(
  fixture: ReturnType<typeof makeFiniteFixture>,
  adapter: HarnessAdapter,
  options: {
    deps?: Partial<DeepScanReducerDeps>;
    args?: Partial<Parameters<typeof runDeepScanReducer>[1]>;
  } = {},
) {
  return runDeepScanReducer(
    { ...makeDeps(inactiveMode), ...options.deps },
    {
      taskId: "task-reducer",
      goal: "merge the scout reports",
      routed: { adapter } as unknown as RoutedAdapter,
      scoutReports: [],
      ledger: fixture.ledger,
      log: fixture.log,
      paths: fixture.paths,
      attemptTelemetries: [],
      ...options.args,
    },
  );
}

async function runWith(mode: WorkReportEnvelopeMode, finalText: string) {
  const root = mkdtempSync(join(tmpdir(), "claudexor-deepscan-"));
  __dirs.push(root);
  const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
  const paths = store.createRun("run-reducer");
  const log = new EventLog(paths.eventsPath, "run-reducer", "task-reducer");
  const ledger = new BudgetLedger({ kind: "unlimited" });
  const routed = { adapter: reducerAdapter(finalText) } as unknown as RoutedAdapter;
  try {
    return await runDeepScanReducer(makeDeps(mode), {
      taskId: "task-reducer",
      goal: "merge the scout reports",
      routed,
      scoutReports: [],
      ledger,
      log,
      paths,
      attemptTelemetries: [],
    });
  } finally {
    log.dispose();
  }
}

describe("runDeepScanReducer WorkReport contract parity (D-16)", () => {
  it("a completed envelope on a constrained route succeeds with the UNWRAPPED output (never the envelope)", async () => {
    const finalText = JSON.stringify({
      work_report: { state: "completed", required_inputs: [] },
      output: "Merged synthesis: deduplicated the scout findings.",
    });
    const result = await runWith(constrainedMode, finalText);
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.report).toContain("Merged synthesis");
      expect(result.report).not.toContain("work_report");
    }
  });

  it("a MALFORMED report on a constrained route is a typed reducer failure, never a prose success", async () => {
    const result = await runWith(constrainedMode, "just prose, no envelope");
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toMatch(/work_report contract/i);
    }
  });

  it("a needs_input report on a constrained route is a typed reducer failure (degrade to the raw bundle)", async () => {
    const finalText = JSON.stringify({
      work_report: {
        state: "needs_input",
        required_inputs: [{ kind: "decision", locator: null, description: "which merge order?" }],
      },
      output: "partial",
    });
    const result = await runWith(constrainedMode, finalText);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toMatch(/needs_input/);
    }
  });

  it("an INACTIVE transport passes the report through untouched (schema-free reducer route)", async () => {
    const result = await runWith(inactiveMode, "Plain merged synthesis with no envelope.");
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.report).toContain("Plain merged synthesis");
    }
  });

  it("an INSTRUCTED footer that is missing keeps the whole synthesis; a valid needs_input footer still fails the reducer", async () => {
    const instructedMode: WorkReportEnvelopeMode = {
      active: true,
      source: "validated",
      hasCallerSchema: false,
      channel: "instructed_fence",
      instruction: "…",
    };
    const synthesis = 'Merged synthesis.\n\n```json\n[{"id":"f1"}]\n```';
    const accepted = await runWith(instructedMode, synthesis);
    expect(accepted.status).toBe("success");
    if (accepted.status === "success") expect(accepted.report).toBe(synthesis);

    const footer = JSON.stringify({
      work_report: {
        state: "needs_input",
        required_inputs: [{ kind: "decision", locator: null, description: "which merge order?" }],
      },
    });
    const vetoed = await runWith(instructedMode, `Partial.\n\n\`\`\`json\n${footer}\n\`\`\``);
    expect(vetoed.status).toBe("failed");
    if (vetoed.status === "failed") expect(vetoed.error).toMatch(/needs_input/);
  });

  it("an errored reducer with fragments and no accepted final is a failure with no footer verdict", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-deepscan-"));
    __dirs.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-reducer");
    const log = new EventLog(paths.eventsPath, "run-reducer", "task-reducer");
    async function* run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      const s = spec.session_id;
      yield { type: "started", session_id: s, ts: nowIso() };
      for (const text of [
        "Merged ",
        "synthesis.\n\n```json\n",
        '{"work_report":{"state":"completed","required_inputs":[]}}',
        "\n```",
      ])
        yield { type: "message", session_id: s, ts: nowIso(), text, payload: { delta: true } };
      yield { type: "error", session_id: s, ts: nowIso(), error: "terminal failure after text" };
      yield { type: "completed", session_id: s, ts: nowIso() };
    }
    const adapter = { id: "fake-reducer", run, review: run, cancel: () => Promise.resolve() };
    const attemptTelemetries: Parameters<typeof runDeepScanReducer>[1]["attemptTelemetries"] = [];
    try {
      const result = await runDeepScanReducer(
        makeDeps({
          active: true,
          source: "validated",
          hasCallerSchema: false,
          channel: "instructed_fence",
          instruction: "…",
        }),
        {
          taskId: "task-reducer",
          goal: "merge the scout reports",
          routed: { adapter } as unknown as RoutedAdapter,
          scoutReports: [],
          ledger: new BudgetLedger({ kind: "unlimited" }),
          log,
          paths,
          attemptTelemetries,
        },
      );
      expect(result.status).toBe("failed");
      expect(attemptTelemetries[0]?.telemetry.outcome?.workState).toEqual({
        state: "unverified",
        source: "validated",
      });
    } finally {
      log.dispose();
    }
  });

  it("does not infer required web from a live reducer policy", async () => {
    const fixture = makeFiniteFixture();
    const attemptTelemetries: Parameters<typeof runDeepScanReducer>[1]["attemptTelemetries"] = [];
    try {
      const result = await runFiniteReducer(fixture, reducerAdapter("Plain merged synthesis."), {
        deps: {
          webRequired: false,
          buildSpec: (...args) => ({
            ...makeDeps(inactiveMode).buildSpec(...args),
            webPolicy: "live",
            effectiveWeb: "live",
          }),
        },
        args: { attemptTelemetries },
      });
      expect(result.status).toBe("success");
      expect(attemptTelemetries).toHaveLength(1);
      expect(attemptTelemetries[0]?.telemetry.web.required).toBe(false);
    } finally {
      fixture.log.dispose();
    }
  });

  it("a cancel on the OUTER run signal mid-reducer is a typed cancellation, never a laundered success (INV-116)", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-deepscan-"));
    __dirs.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-reducer");
    const log = new EventLog(paths.eventsPath, "run-reducer", "task-reducer");
    const ledger = new BudgetLedger({ kind: "unlimited" });
    const outer = new AbortController();
    // A CLEAN merged synthesis that would otherwise succeed on the inactive route
    // — the mid-stream cancel must win over it, and the report must be discarded.
    const routed = {
      adapter: abortingReducerAdapter("Plain merged synthesis with no envelope.", outer),
    } as unknown as RoutedAdapter;
    try {
      const result = await runDeepScanReducer(makeDeps(inactiveMode), {
        taskId: "task-reducer",
        goal: "merge the scout reports",
        routed,
        scoutReports: [],
        ledger,
        log,
        paths,
        signal: outer.signal,
        attemptTelemetries: [],
      });
      expect(result.status).toBe("cancelled");
      // The (partial) synthesis output is discarded — never surfaced as a report.
      expect(result).not.toHaveProperty("report");
    } finally {
      log.dispose();
    }
  });

  it("an INTERNAL inactivity timeout wins over a valid buffered report after the adapter drains", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-deepscan-"));
    __dirs.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-reducer");
    const log = new EventLog(paths.eventsPath, "run-reducer", "task-reducer");
    const ledger = new BudgetLedger({ kind: "unlimited" });
    const routed = {
      adapter: timeoutDrainingReducerAdapter("Valid merged synthesis before the stall."),
    } as unknown as RoutedAdapter;
    const drained: HarnessEvent[] = [];
    try {
      const result = await runDeepScanReducer(
        { ...makeDeps(inactiveMode), inactivityTimeoutMs: 20 },
        {
          taskId: "task-reducer",
          goal: "merge the scout reports",
          routed,
          scoutReports: [],
          ledger,
          log,
          paths,
          onHarnessEvent: (event) => drained.push(event),
          attemptTelemetries: [],
        },
      );

      expect(drained.some((event) => event.type === "completed")).toBe(true);
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toMatch(/inactivity watchdog/i);
      }
      expect(result).not.toHaveProperty("report");
    } finally {
      log.dispose();
    }
  });

  it("settles the lease and disposes the home when async spec preparation rejects", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-deepscan-"));
    __dirs.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-reducer");
    const log = new EventLog(paths.eventsPath, "run-reducer", "task-reducer");
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const dispose = vi.fn();
    const token = `sk-${"a".repeat(48)}`;
    const telemetry: Parameters<typeof runDeepScanReducer>[1]["attemptTelemetries"] = [];
    try {
      const result = await runDeepScanReducer(
        {
          ...makeDeps(inactiveMode),
          newReadOnlyHome: () => ({ env: {}, dispose }),
          buildSpec: async () => {
            throw new Error(`profile preparation rejected ${token}`);
          },
        },
        {
          taskId: "task-reducer",
          goal: "merge the scout reports",
          routed: { adapter: reducerAdapter("unused") } as unknown as RoutedAdapter,
          scoutReports: [],
          ledger,
          log,
          paths,
          attemptTelemetries: telemetry,
        },
      );
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("setup failed");
        expect(result.error).not.toContain(token);
      }
      expect(dispose).toHaveBeenCalledOnce();
      expect(ledger.remainingUsd()).toBe(1);
      expect(telemetry).toHaveLength(1);
    } finally {
      log.dispose();
    }
  });

  it("keeps HOME alive while late spec preparation settles inside the cleanup grace", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-deepscan-"));
    __dirs.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-reducer");
    const log = new EventLog(paths.eventsPath, "run-reducer", "task-reducer");
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    let homeAlive = true;
    let preparationObservedHomeAlive = false;
    const dispose = vi.fn(async () => {
      homeAlive = false;
    });
    try {
      const startedAt = Date.now();
      const result = await runDeepScanReducer(
        {
          ...makeDeps(inactiveMode),
          hardTimeoutMs: 20,
          cleanupGraceMs: 300,
          newReadOnlyHome: () => ({ env: {}, dispose }),
          buildSpec: async (...args) => {
            await new Promise((resolve) => setTimeout(resolve, 60));
            preparationObservedHomeAlive = homeAlive;
            return makeDeps(inactiveMode).buildSpec(...args);
          },
        },
        {
          taskId: "task-reducer",
          goal: "merge the scout reports",
          routed: { adapter: reducerAdapter("unused") } as unknown as RoutedAdapter,
          scoutReports: [],
          ledger,
          log,
          paths,
          attemptTelemetries: [],
        },
      );
      expect(result).toEqual({ status: "failed", error: "deep-scan reducer timed out after 20ms" });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
      expect(Date.now() - startedAt).toBeLessThan(250);
      expect(dispose).toHaveBeenCalledOnce();
      expect(ledger.remainingUsd()).toBe(1);
      expect(preparationObservedHomeAlive).toBe(true);
    } finally {
      log.dispose();
    }
  });

  it("bounds cleanup for never-settling preparation and emits no false harness activity", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-deepscan-"));
    __dirs.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-reducer");
    const log = new EventLog(paths.eventsPath, "run-reducer", "task-reducer");
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const dispose = vi.fn();
    const observed: HarnessEvent[] = [];
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const startedAt = Date.now();
      const result = await runDeepScanReducer(
        {
          ...makeDeps(inactiveMode),
          hardTimeoutMs: 20,
          cleanupGraceMs: 37,
          newReadOnlyHome: () => ({ env: {}, dispose }),
          buildSpec: () => new Promise<never>(() => {}),
        },
        {
          taskId: "task-reducer",
          goal: "merge the scout reports",
          routed: { adapter: reducerAdapter("unused") } as unknown as RoutedAdapter,
          scoutReports: [],
          ledger,
          log,
          paths,
          onHarnessEvent: (event) => observed.push(event),
          attemptTelemetries: [],
        },
      );
      expect(result).toEqual({ status: "failed", error: "deep-scan reducer timed out after 20ms" });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(45);
      expect(elapsed).toBeLessThan(250);
      expect(observed).toEqual([]);
      expect(dispose).toHaveBeenCalledOnce();
      expect(ledger.remainingUsd()).toBe(1);
      const cleanupTimerIndex = timerSpy.mock.calls.findIndex((call) => call[1] === 37);
      const cleanupTimer = timerSpy.mock.results[cleanupTimerIndex]?.value as
        ReturnType<typeof setTimeout> | undefined;
      expect(cleanupTimerIndex).toBeGreaterThanOrEqual(0);
      expect(cleanupTimer && "hasRef" in cleanupTimer ? cleanupTimer.hasRef() : false).toBe(true);
      const events = readFileSync(paths.eventsPath, "utf8");
      expect(events).not.toContain('"type":"harness.started"');
      expect(events).not.toContain('"type":"harness.event"');
    } finally {
      timerSpy.mockRestore();
      log.dispose();
    }
  });

  it("wakes a stalled stream at the deadline and settles cleanup before HOME disposal", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-deepscan-"));
    __dirs.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-reducer");
    const log = new EventLog(paths.eventsPath, "run-reducer", "task-reducer");
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    let homeAlive = true;
    let streamObservedHomeAlive = false;
    const dispose = vi.fn(async () => {
      homeAlive = false;
    });
    const adapter: HarnessAdapter = {
      ...reducerAdapter("unused"),
      async *run(spec) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        streamObservedHomeAlive = homeAlive;
        yield {
          type: "message",
          session_id: spec.session_id,
          ts: nowIso(),
          text: "late output must not be accepted",
          final: true,
        };
      },
    };
    const observed: HarnessEvent[] = [];
    try {
      const startedAt = Date.now();
      const result = await runDeepScanReducer(
        {
          ...makeDeps(inactiveMode),
          hardTimeoutMs: 20,
          cleanupGraceMs: 300,
          inactivityTimeoutMs: 1_000,
          newReadOnlyHome: () => ({ env: {}, dispose }),
        },
        {
          taskId: "task-reducer",
          goal: "merge the scout reports",
          routed: { adapter } as unknown as RoutedAdapter,
          scoutReports: [],
          ledger,
          log,
          paths,
          onHarnessEvent: (event) => observed.push(event),
          attemptTelemetries: [],
        },
      );
      expect(result).toEqual({ status: "failed", error: "deep-scan reducer timed out after 20ms" });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
      expect(Date.now() - startedAt).toBeLessThan(400);
      expect(observed).toEqual([
        expect.objectContaining({
          type: "status",
          effort_resolution: {
            requested: null,
            submitted: null,
            parameter: null,
            resolution: "omitted",
            source: "adapter",
            observed: null,
            observedSource: null,
          },
        }),
      ]);
      expect(observed[0]?.text).toBeUndefined();
      expect(observed[0]?.payload).toBeUndefined();
      expect(dispose).toHaveBeenCalledOnce();
      expect(ledger.remainingUsd()).toBe(1);
      expect(streamObservedHomeAlive).toBe(true);
    } finally {
      log.dispose();
    }
  });

  it("retains post-deadline usage and terminal evidence while rejecting late output", async () => {
    const fixture = makeFiniteFixture();
    const { paths, log, ledger } = fixture;
    const telemetry: Parameters<typeof runDeepScanReducer>[1]["attemptTelemetries"] = [];
    const observed: HarnessEvent[] = [];
    const adapter: HarnessAdapter = {
      ...reducerAdapter("unused"),
      async *run(spec) {
        const ts = nowIso();
        const signal = spec.extra["abortSignal"] as AbortSignal;
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          credential_route: "managed_api_key",
        };
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield {
          type: "message",
          session_id: spec.session_id,
          ts: nowIso(),
          text: "late output must not be accepted",
          final: true,
        };
        yield {
          type: "usage",
          session_id: spec.session_id,
          ts: nowIso(),
          credential_route: "managed_api_key",
          usage: { cost_usd: 0.25 },
        };
        yield {
          type: "error",
          session_id: spec.session_id,
          ts: nowIso(),
          error: "termination unconfirmed",
          payload: { termination_unconfirmed: true },
        };
        yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
      },
    };
    try {
      const result = await runFiniteReducer(fixture, adapter, {
        deps: {
          hardTimeoutMs: 20,
          cleanupGraceMs: 300,
          inactivityTimeoutMs: 1_000,
        },
        args: {
          onHarnessEvent: (event) => observed.push(event),
          attemptTelemetries: telemetry,
        },
      });
      expect(result).toEqual({ status: "failed", error: "deep-scan reducer timed out after 20ms" });
      expect(observed[0]?.effort_resolution).toEqual({
        requested: null,
        submitted: null,
        parameter: null,
        resolution: "omitted",
        source: "adapter",
        observed: null,
        observedSource: null,
      });
      expect(observed[0]?.text).toBeUndefined();
      expect(observed[0]?.payload).toBeUndefined();
      expect(observed.map((event) => event.type)).toEqual([
        "status",
        "started",
        "usage",
        "error",
        "completed",
      ]);
      expect(ledger.remainingUsd()).toBeCloseTo(0.75);
      expect(telemetry[0]?.telemetry.usageCost.cashUsd).toBeCloseTo(0.25);
      const events = readFileSync(paths.eventsPath, "utf8");
      expect(events).toContain("termination unconfirmed");
      expect(events).toContain("late output must not be accepted");
      expect(observed.some((event) => event.type === "message")).toBe(false);
    } finally {
      log.dispose();
    }
  });

  it("settles the admitted attempt when durable harness.started persistence fails", async () => {
    const fixture = makeFiniteFixture((event) => {
      if (event.type === "harness.started") throw new Error("durable journal append failed");
    });
    const { paths, log, ledger } = fixture;
    const dispose = vi.fn();
    const telemetry: Parameters<typeof runDeepScanReducer>[1]["attemptTelemetries"] = [];
    try {
      const result = await runFiniteReducer(fixture, reducerAdapter("unused"), {
        deps: { newReadOnlyHome: () => ({ env: {}, dispose }) },
        args: { attemptTelemetries: telemetry },
      });
      expect(result).toEqual({ status: "failed", error: "durable journal append failed" });
      expect(dispose).toHaveBeenCalledOnce();
      expect(ledger.remainingUsd()).toBe(1);
      expect(telemetry).toHaveLength(1);
      expect(
        readFileSync(paths.eventsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type: string })
          .filter((event) => event.type === "harness.started" || event.type === "harness.completed")
          .map((event) => event.type),
      ).toEqual(["harness.started", "harness.completed"]);
    } finally {
      log.dispose();
    }
  });

  it("discloses the reducer route's ignored knobs on harness.started (INV-105)", async () => {
    const fixture = makeFiniteFixture();
    const { paths, log } = fixture;
    const detail =
      "prompt_cache_ttl=1h (capability_profile.prompt_cache_ttls does not declare it for reducer)";
    try {
      const deps = makeDeps(inactiveMode);
      const buildSpec: DeepScanReducerDeps["buildSpec"] = async (...args) => ({
        ...(await deps.buildSpec(...args)),
        ignored: [detail],
      });
      await runFiniteReducer(fixture, reducerAdapter("merged"), { deps: { buildSpec } });
      const started = readFileSync(paths.eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> })
        .filter((event) => event.type === "harness.started");
      expect(started.map((event) => event.payload?.["ignored_settings"])).toEqual([[detail]]);
    } finally {
      log.dispose();
    }
  });

  it("does not attribute a pre-start cancellation to a harness error", async () => {
    const fixture = makeFiniteFixture();
    const { log, ledger } = fixture;
    const signal = new AbortController();
    signal.abort();
    const buildSpec = vi.fn(makeDeps(inactiveMode).buildSpec);
    const telemetry: Parameters<typeof runDeepScanReducer>[1]["attemptTelemetries"] = [];
    try {
      const result = await runFiniteReducer(fixture, reducerAdapter("unused"), {
        deps: { buildSpec },
        args: { signal: signal.signal, attemptTelemetries: telemetry },
      });
      expect(result).toEqual({ status: "cancelled" });
      expect(buildSpec).not.toHaveBeenCalled();
      expect(telemetry[0]?.telemetry.outcome).toMatchObject({
        harnessErrored: false,
        status: "failed",
      });
      expect(ledger.remainingUsd()).toBe(1);
    } finally {
      log.dispose();
    }
  });

  it("deduplicates inactivity and hard-deadline cancellation", async () => {
    const fixture = makeFiniteFixture();
    const { log, ledger } = fixture;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const dispose = vi.fn();
    const adapter: HarnessAdapter = {
      ...reducerAdapter("unused"),
      async *run(spec) {
        yield { type: "started", session_id: spec.session_id, ts: nowIso() };
        await new Promise<void>(() => {});
      },
      cancel,
    };
    try {
      const result = await runFiniteReducer(fixture, adapter, {
        deps: {
          hardTimeoutMs: 35,
          cleanupGraceMs: 20,
          inactivityTimeoutMs: 10,
          newReadOnlyHome: () => ({ env: {}, dispose }),
        },
      });
      expect(result).toEqual({ status: "failed", error: "deep-scan reducer timed out after 35ms" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      expect(ledger.remainingUsd()).toBe(1);
    } finally {
      log.dispose();
    }
  });
});

describe("runDeepScanReducer flow control (#688)", () => {
  it("stops reading the reducer's stream at a full journal while its writes are held, then reads it all", async () => {
    const APPLIED_POOL = Symbol.for("claudexor.libuvPoolSize");
    const global = globalThis as Record<symbol, unknown>;
    const savedPool = global[APPLIED_POOL];
    global[APPLIED_POOL] = 8; // six write slots: held writes never starve the others
    const fixture = makeFiniteFixture();
    // The run's own log is queued, as every orchestrated run's is.
    fixture.log.dispose();
    const log = new EventLog(
      fixture.paths.eventsPath,
      "run-reducer",
      "task-reducer",
      undefined,
      undefined,
      undefined,
      { queued: true },
    );
    const half = getDefaultHighWaterMark(false) / 2;
    const progress = { pulled: 0 };
    let holding = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realOpen = promises.open;
    // Every write under the run directory waits for the gate while `holding`.
    const spy = vi.spyOn(promises, "open").mockImplementation((async (
      ...args: Parameters<typeof promises.open>
    ) => {
      const handle = await realOpen(...args);
      if (!String(args[0]).startsWith(fixture.paths.root)) return handle;
      const write = handle.write.bind(handle) as (...writeArgs: unknown[]) => Promise<unknown>;
      handle.write = (async (...writeArgs: unknown[]) => {
        if (holding) await gate;
        return write(...writeArgs);
      }) as unknown as typeof handle.write;
      return handle;
    }) as typeof promises.open);
    const adapter: HarnessAdapter = {
      ...reducerAdapter("unused"),
      async *run(spec) {
        holding = true;
        for (let index = 0; index < 10; index += 1) {
          progress.pulled += 1;
          yield {
            type: "message",
            session_id: spec.session_id,
            ts: nowIso(),
            text: String(index).repeat(half),
          };
        }
        yield {
          type: "message",
          session_id: spec.session_id,
          ts: nowIso(),
          text: "Merged synthesis.",
          final: true,
          payload: { final_source: "test" },
        };
        yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
      },
    };
    const attemptJournal = join(
      fixture.paths.attemptsDir,
      DEEP_SCAN_REDUCER_ATTEMPT_ID,
      "events.jsonl",
    );
    try {
      const reducing = runFiniteReducer({ ...fixture, log }, adapter);
      try {
        await vi.waitFor(() => expect(orderedAppender.full(fixture.paths.eventsPath)).toBe(true));
        for (let turn = 0; turn < 20; turn += 1)
          await new Promise((resolve) => setImmediate(resolve));
        // The second message filled the journal: the reducer asks for no third one.
        expect(progress.pulled).toBe(2);
      } finally {
        holding = false;
        release();
      }
      const result = await reducing;
      expect(result.status).toBe("success");
      expect(progress.pulled).toBe(10);
      await orderedAppender.settledUnder(fixture.paths.root);
      const texts = readFileSync(attemptJournal, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; text?: string })
        .filter((event) => event.type === "message")
        .map((event) => event.text!.slice(0, 1));
      expect(texts).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "M"]);
    } finally {
      spy.mockRestore();
      log.dispose();
      if (savedPool === undefined) delete global[APPLIED_POOL];
      else global[APPLIED_POOL] = savedPool;
    }
  });
});
