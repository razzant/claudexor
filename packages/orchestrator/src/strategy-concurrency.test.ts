import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { HarnessAdapter } from "@claudexor/core";
import type { HarnessEvent, HarnessRunSpec, RunEvent } from "@claudexor/schema";
import { HarnessManifest, ConformanceReport, RuntimeConcurrencyCaps } from "@claudexor/schema";
import { Orchestrator, type OrchestratorResult, type RunInput } from "./orchestrator.js";
import { runParallelCandidates } from "./strategyConcurrency.js";

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-strategy-concurrency-"));
  tempRoots.push(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# test\n");
  git("add", "-A");
  git("-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-m", "init");
  return repo;
}

const caps = (overrides: Partial<RuntimeConcurrencyCaps> = {}): RuntimeConcurrencyCaps =>
  RuntimeConcurrencyCaps.parse(overrides);

/** The first wave cannot finish until the test inspects it. Later waves run freely. */
function firstWave(expected: number) {
  let signalReady!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { active: 0, peak: 0, started: 0, byIntent: {} as Record<string, number> };
  return {
    state,
    ready,
    release,
    async enter(intent: string) {
      state.started += 1;
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      state.byIntent[intent] = (state.byIntent[intent] ?? 0) + 1;
      if (state.active === expected) signalReady();
      await gate;
    },
    leave() {
      state.active -= 1;
    },
  };
}

type Wave = ReturnType<typeof firstWave>;
function instrumentedFake(id: string, wave: Wave): HarnessAdapter {
  const base = createFakeHarness("fake-success");
  return {
    ...base,
    id,
    async discover() {
      return HarnessManifest.parse({ ...(await base.discover()), id, display_name: id });
    },
    async doctor(spec) {
      return ConformanceReport.parse({ ...(await base.doctor(spec)), harness_id: id });
    },
    async *run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      await wave.enter(spec.intent);
      try {
        yield* base.run(spec);
      } finally {
        wave.leave();
      }
    },
  };
}

async function inspectFirstWave(
  run: Promise<OrchestratorResult>,
  wave: Wave,
  inspect: () => void,
): Promise<OrchestratorResult> {
  let deadline!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      wave.ready,
      run.then(() => {
        throw new Error("run completed without filling its expected first wave");
      }),
      // This bounds a broken smaller cap; elapsed time is never evidence of concurrency.
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("first wave did not fill")), 10_000);
      }),
    ]);
    inspect();
  } finally {
    clearTimeout(deadline);
    wave.release();
    await run;
  }
  return run;
}

function events(result: OrchestratorResult): RunEvent[] {
  return readFileSync(join(result.runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
}

describe("configured ordinary strategy concurrency caps", () => {
  it.each([2, 6])(
    "bounds the shared candidate/scout worker pool at %i with more queued work",
    async (limit) => {
      const wave = firstWave(limit);
      const run = runParallelCandidates(
        Array.from({ length: limit + 2 }, (_, i) => i),
        caps({ max_parallel_candidates: limit }),
        async () => {
          await wave.enter("candidate");
          wave.leave();
        },
      );
      // runBounded admits its first workers synchronously; removing or increasing
      // the bound starts the extra items before this check, with no timer race.
      try {
        expect(wave.state.started).toBe(limit);
        expect(wave.state.active).toBe(limit);
      } finally {
        wave.release();
        await run;
      }
      expect(wave.state.started).toBe(limit + 2);
      expect(wave.state.peak).toBe(limit);
    },
  );

  it.each([2, 6])(
    "runs a best-of first wave of exactly %i candidates and drains the queue",
    async (limit) => {
      const wave = firstWave(limit);
      const registry = new Map([["fake-success", instrumentedFake("fake-success", wave)]]);
      const orch = new Orchestrator({
        registry,
        reviewers: [],
        runtimeConcurrencyCaps: caps({ max_parallel_candidates: limit }),
      });
      let admitted = 0;
      const run = orch.run({
        repoRoot: initRepo(),
        prompt: "run all candidates",
        mode: "agent",
        harnesses: ["fake-success"],
        n: 8,
        onEvent(event) {
          if (event.type === "harness.started") admitted += 1;
        },
      });
      const result = await inspectFirstWave(run, wave, () => {
        expect(wave.state.active).toBe(limit);
        expect(admitted).toBe(limit);
      });
      expect(result.lifecycle).toBe("succeeded");
      expect(wave.state.byIntent.implement).toBe(8);
      expect(wave.state.peak).toBe(limit);
    },
    30_000,
  );

  it.each([
    { injected: undefined, width: 8, parallel: 4, degraded: true },
    {
      injected: caps({ max_parallel_candidates: 6, max_deep_scan_width: 10 }),
      width: 10,
      parallel: 6,
      degraded: false,
    },
  ])(
    "uses deep-scan width $width and parallel cap $parallel, preserving requested/effective truth",
    async ({ injected, width, parallel, degraded }) => {
      const wave = firstWave(parallel);
      const orch = new Orchestrator({
        registry: new Map([["fake-success", instrumentedFake("fake-success", wave)]]),
        reviewers: [],
        runtimeConcurrencyCaps: injected,
      });
      const run = orch.run({
        repoRoot: initRepo(),
        prompt: "inspect broadly",
        mode: "ask",
        harnesses: ["fake-success"],
        deepScan: true,
        n: 10,
      });
      const result = await inspectFirstWave(run, wave, () =>
        expect(wave.state.active).toBe(parallel),
      );
      expect(result.lifecycle).toBe("succeeded");
      expect(wave.state.byIntent.audit).toBe(width);
      expect(wave.state.peak).toBe(parallel);
      const receipts = events(result).filter((event) => event.type === "route.pool.degraded");
      if (degraded)
        expect(receipts).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({ requested_n: 10, effective_n: 8 }),
          }),
        ]);
      else expect(receipts).toEqual([]);
    },
    30_000,
  );

  it.each([2, 5])(
    "runs exactly %i distinct Council members and one merge",
    async (width) => {
      const wave = firstWave(width);
      const ids = Array.from({ length: width }, (_, i) => `planner-${i}`);
      const orch = new Orchestrator({
        registry: new Map(ids.map((id) => [id, instrumentedFake(id, wave)])),
        reviewers: [],
        runtimeConcurrencyCaps: caps({ max_council_members: width }),
      });
      const run = orch.run({
        repoRoot: initRepo(),
        prompt: "draft independent plans",
        mode: "plan",
        harnesses: ids,
        council: true,
        n: width,
      });
      const result = await inspectFirstWave(run, wave, () => expect(wave.state.active).toBe(width));
      expect(result.lifecycle).toBe("succeeded");
      expect(wave.state.byIntent.plan).toBe(width);
      expect(wave.state.byIntent.synthesize).toBe(1);
      expect(wave.state.peak).toBe(width);
      expect(events(result).find((e) => e.type === "council.started")?.payload).toEqual({
        requested: width,
        members: ids,
      });
    },
    30_000,
  );

  it("rejects an explicit Council request above the cap before any adapter runs", async () => {
    const wave = firstWave(1);
    const ids = ["planner-a", "planner-b", "planner-c", "planner-d", "planner-e"];
    const orch = new Orchestrator({
      registry: new Map(ids.map((id) => [id, instrumentedFake(id, wave)])),
      reviewers: [],
    });
    const request: RunInput = {
      repoRoot: initRepo(),
      prompt: "draft plans",
      mode: "plan",
      harnesses: ids,
      council: true,
      n: 5,
    };
    await expect(orch.run(request)).rejects.toMatchObject({
      code: "council_width_exceeded",
      status: 400,
      retryable: false,
    });
    expect(wave.state.started).toBe(0);
  });

  it("discloses unavailable Council members without duplicating the surviving lanes", async () => {
    const wave = firstWave(3);
    const ids = ["planner-a", "planner-b", "planner-c"];
    const orch = new Orchestrator({
      registry: new Map(ids.map((id) => [id, instrumentedFake(id, wave)])),
      reviewers: [],
      runtimeConcurrencyCaps: caps({ max_council_members: 5 }),
    });
    const run = orch.run({
      repoRoot: initRepo(),
      prompt: "draft plans",
      mode: "plan",
      harnesses: ids,
      council: true,
      n: 5,
    });
    const result = await inspectFirstWave(run, wave, () => expect(wave.state.active).toBe(3));
    expect(result.lifecycle).toBe("succeeded");
    expect(wave.state.byIntent.plan).toBe(3);
    expect(wave.state.peak).toBe(3);
    expect(events(result).find((e) => e.type === "council.started")?.payload).toEqual({
      requested: 5,
      members: ids,
    });
    expect(readFileSync(join(result.runDir, "final", "summary.md"), "utf8")).toContain(
      "council degraded to 3 of 5",
    );
  }, 30_000);
});
