import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { WorkspaceManager, retainedInspectionEnvelopes } from "@claudexor/workspace";
import {
  RunFailure,
  type HarnessEvent,
  type HarnessRunSpec,
  type PoolAttemptFailure,
} from "@claudexor/schema";
import { Orchestrator } from "./orchestrator.js";
import { run } from "./inrun-continuity.test-support.js";

// Joint consumer evidence for two independent contracts on one failure record:
// the per-try account list (every PHYSICAL try's own refusal, in order) and the
// typed capture facts of an incomplete capture (kept source, inspection
// actions). A terminal that carries both keeps both — on failure.yaml, the
// terminal event and every summary — and a cancellation that replaces such a
// verdict keeps the capture-bearing record under its own statement.

const OUT_OF_USAGE = "You're out of usage. Switch to Auto.";
const SECRET = ["sk", "x".repeat(24)].join("-");
type Emit = (ev: Partial<HarnessEvent>) => HarnessEvent;
type Outcome = Awaited<ReturnType<typeof run>>;

afterEach(() => vi.restoreAllMocks());

/** The account's vendor session starts and refuses before any progress. */
function* refuse(emit: Emit): Generator<HarnessEvent> {
  yield emit({ type: "started" });
  yield emit({ type: "error", error: OUT_OF_USAGE });
  yield emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
}

/** A refuses; B edits the workspace and delivers an answer. */
function* fallbackEdits(
  profile: string,
  emit: Emit,
  spec: HarnessRunSpec,
): Generator<HarnessEvent> {
  if (profile === "a") return yield* refuse(emit);
  yield emit({ type: "started" });
  writeFileSync(join(spec.cwd, "edited.txt"), "candidate from b\n");
  yield emit({ type: "file_change", payload: { path: "edited.txt" } });
  yield emit({ type: "message", text: "edited", final: true });
  yield emit({ type: "completed" });
}

/** Every capture of a tree the fallback edited fails, with a failed scratch
 * cleanup; the refused try's own (empty) capture stays real, so rotation runs. */
function failEditedCaptures() {
  const actual = WorkspaceManager.prototype.captureDiff;
  return vi.spyOn(WorkspaceManager.prototype, "captureDiff").mockImplementation(async function (
    this: WorkspaceManager,
    env,
  ) {
    if (!existsSync(join(env.worktree_path, "edited.txt"))) return actual.call(this, env);
    throw Object.assign(new Error(`capture failed ${SECRET}`), {
      code: "EIO",
      cleanupError: Object.assign(new Error("scratch cleanup failed"), { code: "EACCES" }),
    });
  });
}

/** A Delegate parent's child-drain owner; `drain` decides how its drain ends. */
function drainAuthority(drain: () => Promise<void>) {
  return {
    hasParent: () => true,
    beginParentClose: () => {},
    waitForChildren: drain,
    releaseRun: () => {},
    registerParent: () => {},
  } as unknown as NonNullable<
    ConstructorParameters<typeof Orchestrator>[0]["delegationBudgetAuthority"]
  >;
}

/** Abort the run when the strategy first writes its run telemetry: after its
 * last abort checkpoint, before its own terminal. */
function cancelAtTelemetry(cancel: AbortController) {
  const proto = Orchestrator.prototype as unknown as {
    writeRunTelemetry: (...args: unknown[]) => void;
  };
  const original = proto.writeRunTelemetry;
  let calls = 0;
  return vi.spyOn(proto, "writeRunTelemetry").mockImplementation(function (
    this: Orchestrator,
    ...args: unknown[]
  ) {
    if ((calls += 1) === 1) cancel.abort("user_cancelled");
    return original.apply(this, args);
  });
}

const rows = (list: readonly PoolAttemptFailure[] | undefined) =>
  list?.map((row) => [row.profileId, row.attemptId, row.tryIndex, row.phase]);

function terminal(o: Outcome) {
  const store = new ArtifactStore(o.root);
  const failure = RunFailure.parse(store.readYaml(join(o.result.runDir, "final", "failure.yaml")));
  const attempt = store.readYaml(join(o.result.runDir, "attempts", "a01", "attempt.yaml")) as {
    capture_refusal?: { disposition: string; sourceRoot?: string };
  };
  return {
    failure,
    attempt,
    event: o.events.find((e) => ["run.failed", "run.blocked", "run.completed"].includes(e.type)),
    summaryMd: readFileSync(join(o.result.runDir, "final", "summary.md"), "utf8"),
    answerMd: readFileSync(join(o.result.runDir, "attempts", "a01", "answer.md"), "utf8").trim(),
  };
}

describe("one failure record carries the account list and the capture facts", () => {
  it("isolated race: the account refused before the fallback is named beside its failed capture", async () => {
    failEditedCaptures();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      input: { inPlace: false },
      script: function* ({ profile, emit, spec }) {
        yield* fallbackEdits(profile, emit, spec);
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.result.facts).toMatchObject({
      lifecycle: "failed",
      reason: "capture_refused",
      noChanges: null,
    });
    const t = terminal(o);
    expect(t.failure).toMatchObject({
      phase: "workspace",
      category: "project",
      code: null,
      captureFailure: { code: "capture_failed", causeCode: "EIO", cleanup: { code: "EACCES" } },
    });
    expect(rows(t.failure.poolAttempts)).toEqual([["a", "a01", 0, "pre_progress"]]);
    expect(t.failure.poolAttempts[0]?.error).toBe(OUT_OF_USAGE);
    expect(t.event?.type).toBe("run.failed");
    expect(t.event?.payload["pool_attempts"]).toEqual(t.failure.poolAttempts);
    // The capture's inspection actions lead (no patch exists to inspect).
    expect(t.attempt.capture_refusal).toMatchObject({ disposition: "retained" });
    expect(t.failure.nextActions).toEqual([
      `Inspect the changed files at ${t.attempt.capture_refusal?.sourceRoot}`,
      "Inspect Claudexor temporary state: private scratch cleanup failed",
      "Decide on those changes yourself: Claudexor kept no exact result to apply or revert",
    ]);
    for (const text of [t.failure.safeMessage, t.summaryMd, o.result.summary]) {
      expect(text).toContain("Account attempts:\n- fake/a · m1 · a01 try 1");
      expect(text).toContain(OUT_OF_USAGE);
      expect(text).not.toContain(SECRET);
    }
    expect(t.answerMd).toBe("edited");
    expect(existsSync(join(o.result.runDir, "final", "patch.diff"))).toBe(false);
    expect(retainedInspectionEnvelopes(o.result.runDir, o.result.runId)).toHaveLength(1);
  });
});

describe("a cancellation that replaces a capture-bearing verdict keeps that record as its own", () => {
  it("Delegate parent: a cancel during the child drain re-labels the record with the cancellation statement", async () => {
    const cancel = new AbortController();
    failEditedCaptures();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      input: { signal: cancel.signal },
      deps: {
        delegationBudgetAuthority: drainAuthority(async () => cancel.abort("user_cancelled")),
      },
      script: function* ({ profile, emit, spec }) {
        yield* fallbackEdits(profile, emit, spec);
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.result.facts).toMatchObject({
      lifecycle: "cancelled",
      reason: "user_cancelled",
      noChanges: null,
    });
    const t = terminal(o);
    // The record keeps the phase of the terminal that wrote it, its capture
    // facts and inspection actions, under the cancellation's own category,
    // no typed code and the same statement every cancelled terminal makes.
    expect(t.failure).toMatchObject({
      phase: "workspace",
      category: "cancelled",
      code: null,
      captureFailure: { code: "capture_failed", cleanup: { code: "EACCES" } },
    });
    expect(rows(t.failure.poolAttempts)).toEqual([["a", "a01", 0, "pre_progress"]]);
    expect(t.failure.safeMessage.startsWith("run cancelled")).toBe(true);
    expect(t.failure.nextActions).toEqual(
      expect.arrayContaining([
        `Inspect the changed files at ${t.attempt.capture_refusal?.sourceRoot}`,
        "Inspect Claudexor temporary state: private scratch cleanup failed",
      ]),
    );
    expect(t.event?.type).toBe("run.failed");
    expect(t.event?.payload).toMatchObject({ lifecycle: "cancelled", reason: "user_cancelled" });
    expect(rows(t.event?.payload["pool_attempts"] as PoolAttemptFailure[])).toEqual([
      ["a", "a01", 0, "pre_progress"],
    ]);
    for (const text of [t.failure.safeMessage, t.summaryMd, o.result.summary]) {
      expect(text).toContain(OUT_OF_USAGE);
      expect(text).not.toContain(SECRET);
    }
    expect(t.summaryMd).toContain("- Lifecycle: cancelled");
    expect(o.result.summary.startsWith("run cancelled")).toBe(true);
    // Live effects keep their capture-refused receipt with the cancel's facts.
    const product = new ArtifactStore(o.root).readYaml(
      join(o.result.runDir, "final", "work_product.yaml"),
    ) as { meta: Record<string, unknown> };
    expect(product.meta).toMatchObject({
      lifecycle: "cancelled",
      capture_refused: true,
      adopted: true,
      apply_state: "applied_review_blocked",
      revert_anchor_id: null,
    });
    expect(existsSync(join(o.result.runDir, "final", "patch.diff"))).toBe(false);
  });

  it("convergence: a cancel after the capture verdict is the terminal commit's statement, with the record kept", async () => {
    const cancel = new AbortController();
    failEditedCaptures();
    cancelAtTelemetry(cancel);
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      input: { signal: cancel.signal, attempts: 1 },
      script: function* ({ profile, emit, spec }) {
        yield* fallbackEdits(profile, emit, spec);
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.result.facts).toMatchObject({ lifecycle: "cancelled", reason: "user_cancelled" });
    const t = terminal(o);
    expect(t.failure).toMatchObject({
      phase: "workspace",
      category: "cancelled",
      code: null,
      captureFailure: { code: "capture_failed", cleanup: { code: "EACCES" } },
    });
    expect(rows(t.failure.poolAttempts)).toEqual([["a", "a01", 0, "pre_progress"]]);
    expect(t.failure.safeMessage.startsWith("run cancelled")).toBe(true);
    expect(t.failure.safeMessage).toContain(OUT_OF_USAGE);
    // The committed cancellation names the kept record and drops the replaced
    // verdict's own cause; its list rides the event like every cancellation.
    expect(t.event?.type).toBe("run.failed");
    expect(t.event?.payload).toMatchObject({
      lifecycle: "cancelled",
      cancel_reason: "user_cancelled",
      failure_ref: "final/failure.yaml",
    });
    expect(t.event?.payload).not.toHaveProperty("phase");
    expect(t.event?.payload).not.toHaveProperty("error");
    expect(rows(t.event?.payload["pool_attempts"] as PoolAttemptFailure[])).toEqual([
      ["a", "a01", 0, "pre_progress"],
    ]);
    expect(t.summaryMd).toContain("- Lifecycle: cancelled");
    expect(t.summaryMd).toContain(OUT_OF_USAGE);
    expect(o.result.summary.startsWith("run cancelled")).toBe(true);
    expect(existsSync(join(o.result.runDir, "final", "patch.diff"))).toBe(false);
  });
});
