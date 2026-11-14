import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  RunFailure,
  type HarnessEvent,
  type HarnessRunSpec,
  type PoolAttemptFailure,
} from "@claudexor/schema";
import { InRunContinuity } from "./inrun-continuity.js";
import { run } from "./inrun-continuity.test-support.js";

// An Ask attempt (the sequential chain or a deep-scan explorer) owns its tries'
// account rows from launch, as an Agent slot does: a throw after its tries
// settled and before its record joins the run (rotation's next lane home,
// finishing the attempt) still names every actual try on the run's terminal,
// once. A try that was cancelled or never ran still has no row.

const OUT_OF_USAGE = "You're out of usage. Switch to Auto.";
type Emit = (ev: Partial<HarnessEvent>) => HarnessEvent;
type Outcome = Awaited<ReturnType<typeof run>>;
type Row = [string | null, string, number, string];
const A0: Row = ["a", "a01", 0, "pre_progress"];
const B1: Row = ["b", "a01", 1, "pre_progress"];

afterEach(() => vi.restoreAllMocks());

function* refuse(emit: Emit): Generator<HarnessEvent> {
  yield emit({ type: "started" });
  yield emit({ type: "error", error: OUT_OF_USAGE });
  yield emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
}
function* answer(emit: Emit): Generator<HarnessEvent> {
  yield emit({ type: "started" });
  yield emit({ type: "message", text: "answer from b", final: true });
  yield emit({ type: "completed" });
}
function* edit(emit: Emit, spec: HarnessRunSpec): Generator<HarnessEvent> {
  yield emit({ type: "started" });
  writeFileSync(join(spec.cwd, "edited.txt"), "candidate from b\n");
  yield emit({ type: "file_change", payload: { path: "edited.txt" } });
  yield emit({ type: "message", text: "edited", final: true });
  yield emit({ type: "completed" });
}

/** Finishing the first attempt rejects once, after every one of its tries settled. */
function failFinishOnce(): () => boolean {
  const finish = InRunContinuity.prototype.finish;
  let thrown = false;
  vi.spyOn(InRunContinuity.prototype, "finish").mockImplementation(async function (
    this: InRunContinuity,
    ...args
  ) {
    if (thrown) return finish.apply(this, args);
    thrown = true;
    throw Object.assign(new Error("fixture: finishing the attempt failed"), { code: "EIO" });
  });
  return () => thrown;
}

const rows = (list: readonly PoolAttemptFailure[] | undefined): Row[] =>
  (list ?? []).map((row) => [row.profileId, row.attemptId, row.tryIndex, row.phase]);

/** The failure terminal names exactly `expected`, once, beside its own cause on every surface. */
function expectNamed(o: Outcome, expected: Row[], cause: RegExp): void {
  expect(o.result.lifecycle).toBe("failed");
  const failure = RunFailure.parse(
    new ArtifactStore(o.root).readYaml(join(o.result.runDir, "final", "failure.yaml")),
  );
  const event = o.events.find((e) => e.type === "run.failed");
  expect(rows(failure.poolAttempts)).toEqual(expected);
  expect(rows(event?.payload["pool_attempts"] as PoolAttemptFailure[] | undefined)).toEqual(
    expected,
  );
  const summaryMd = readFileSync(join(o.result.runDir, "final", "summary.md"), "utf8");
  for (const text of [failure.safeMessage, summaryMd, o.result.summary]) {
    expect(text).toMatch(cause);
    expect(text.split("\n").filter((line) => line.startsWith("- fake/"))).toHaveLength(
      expected.length,
    );
  }
}

describe("an Ask attempt whose post-try step throws keeps its tries' accounts", () => {
  it("chain: a refused and b answered, then finishing the attempt failed", async () => {
    const thrown = failFinishOnce();
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      maxRetries: 0,
      script: function* ({ profile, emit }) {
        if (profile === "a") yield* refuse(emit);
        else yield* answer(emit);
      },
    });
    expect(thrown()).toBe(true);
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expectNamed(o, [A0], /fixture: finishing the attempt failed/);
  });

  it("chain: a and b refused, then finishing the attempt failed", async () => {
    const thrown = failFinishOnce();
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      maxRetries: 0,
      script: function* ({ emit }) {
        yield* refuse(emit);
      },
    });
    expect(thrown()).toBe(true);
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expectNamed(o, [A0, B1], /fixture: finishing the attempt failed/);
  });

  it("deep scan: the explorer's tries on a and b refused, then finishing it failed", async () => {
    const thrown = failFinishOnce();
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      maxRetries: 0,
      input: { deepScan: true, n: 1 },
      script: function* ({ emit }) {
        yield* refuse(emit);
      },
    });
    expect(thrown()).toBe(true);
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expectNamed(o, [A0, B1], /fixture: finishing the attempt failed/);
  });
});

describe("a thread Ask whose rotation cannot provision the next account's lane home", () => {
  /** While a's refused try runs, `obstruct` acts on the thread's lanes dir. */
  async function rotateInto(obstruct: (threadLanes: string) => void) {
    let threadLanes: string | null = null;
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      maxRetries: 0,
      input: { threadId: "th-lanes" },
      script: function* ({ profile, emit, spec }) {
        if (profile === "a" && threadLanes === null) {
          threadLanes = dirname(dirname(String(spec.env?.["HOME"])));
          obstruct(threadLanes);
        }
        yield* refuse(emit);
      },
    });
    expect(threadLanes).toMatch(/[\\/]lanes[\\/]th-lanes$/);
    expect(o.spawns.map((s) => s.profile)).toEqual(["a"]);
    return o;
  }

  it("a file where b's lane home goes (EEXIST)", async () => {
    const o = await rotateInto((lanes) => {
      mkdirSync(join(lanes, "fake-b", "home"), { recursive: true });
      writeFileSync(join(lanes, "fake-b", "home", ".codex"), "not a directory\n");
    });
    expectNamed(o, [A0], /EEXIST/);
  });

  // Permission bits bind neither root nor Windows directories: skipped there, never passed.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a lanes dir made read-only (EACCES)",
    async () => {
      let locked: string | null = null;
      try {
        const o = await rotateInto((lanes) => {
          locked = lanes;
          chmodSync(lanes, 0o555);
        });
        expectNamed(o, [A0], /EACCES/);
      } finally {
        if (locked) chmodSync(locked, 0o755);
      }
    },
  );
});

describe("controls", () => {
  it("an explorer whose record joined before its findings write failed is named once", async () => {
    // The findings file is written by the awaited run-end writer (#688).
    const writeTextAsync = ArtifactStore.prototype.writeTextAsync;
    vi.spyOn(ArtifactStore.prototype, "writeTextAsync").mockImplementation(async function (
      this: ArtifactStore,
      path: string,
      text: string,
    ) {
      if (path.endsWith("a01-error.md"))
        throw Object.assign(new Error("fixture: findings write failed"), { code: "EIO" });
      return writeTextAsync.call(this, path, text);
    });
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      maxRetries: 0,
      input: { deepScan: true, n: 1 },
      script: function* ({ emit }) {
        yield* refuse(emit);
      },
    });
    expectNamed(o, [A0, B1], /fixture: findings write failed/);
  });

  it("a cancelled try whose attempt then fails finishing names no row", async () => {
    const thrown = failFinishOnce();
    const controller = new AbortController();
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      maxRetries: 0,
      input: { signal: controller.signal },
      script: function* ({ emit }) {
        yield emit({ type: "started" });
        yield emit({ type: "error", error: OUT_OF_USAGE });
        controller.abort();
        yield emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
      },
    });
    expect(thrown()).toBe(true);
    expect(o.spawns.map((s) => s.profile)).toEqual(["a"]);
    expect(o.result.lifecycle).toBe("cancelled");
    const terminal = o.events.find((e) => e.payload["lifecycle"] === "cancelled");
    expect(terminal?.payload["pool_attempts"]).toEqual([]);
  });

  it("Agent race: a refused and b edited, then finishing the attempt failed", async () => {
    const thrown = failFinishOnce();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      script: function* ({ profile, emit, spec }) {
        if (profile === "a") yield* refuse(emit);
        else yield* edit(emit, spec);
      },
    });
    expect(thrown()).toBe(true);
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expectNamed(o, [A0], /fixture: finishing the attempt failed/);
  });

  it("Agent convergence: a refused and b edited, then finishing the attempt failed", async () => {
    const thrown = failFinishOnce();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      input: { attempts: 1 },
      script: function* ({ profile, emit, spec }) {
        if (profile === "a") yield* refuse(emit);
        else yield* edit(emit, spec);
      },
    });
    expect(thrown()).toBe(true);
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    // This strategy words its own cause per surface; the rows are the control.
    expectNamed(o, [A0], /not_converged|failed after 1 attempt/);
  });
});
