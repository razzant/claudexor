import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { BudgetLedger } from "@claudexor/budget";
import { EventLog } from "@claudexor/event-log";
import { WorkspaceManager } from "@claudexor/workspace";
import {
  ConformanceReport,
  HarnessManifest,
  RunFailure,
  makeOutcomeFacts,
  type HarnessEvent,
  type HarnessRunSpec,
  type PoolAttemptFailure,
  type ProviderFamily,
} from "@claudexor/schema";
import type { ReviewerSpec } from "@claudexor/review";
import { Orchestrator, type RunInput } from "./orchestrator.js";
import { OrchestratorCredentials } from "./orchestrator-credentials.js";
import { InRunContinuity } from "./inrun-continuity.js";
import { run } from "./inrun-continuity.test-support.js";
import type { PreProgressRefusalMemory } from "./pre-progress-refusal.js";
import { guardAnnouncedRun } from "./runTerminals.js";
import { inProcessRunScopeCustodian, type RunScopeCustodian } from "./runScope.js";

// Consumer regressions for the per-try account list: the real Orchestrator over
// a scripted two-account fake. A failure terminal names every PHYSICAL try's
// own refusal in attempt order — through failure.yaml, run.failed and both
// summaries — and nothing that never reached its adapter.

const OUT_OF_USAGE = "You're out of usage. Switch to Auto.";
const PARTIAL = "PARTIAL-REPORT-31c9: the first half of the answer";
type Emit = (ev: Partial<HarnessEvent>) => HarnessEvent;
type Outcome = Awaited<ReturnType<typeof run>>;
type Script = Parameters<typeof run>[0]["script"];

/** The account's vendor session starts and refuses before any progress. */
function* refuse(emit: Emit): Generator<HarnessEvent> {
  yield emit({ type: "started" });
  yield emit({ type: "error", error: OUT_OF_USAGE });
  yield emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
}

/** The account edits the workspace and delivers a candidate. */
function* edit(emit: Emit, spec: HarnessRunSpec, content: string): Generator<HarnessEvent> {
  yield emit({ type: "started" });
  writeFileSync(join(spec.cwd, "edited.txt"), `${content}\n`);
  yield emit({ type: "file_change", payload: { path: "edited.txt" } });
  yield emit({ type: "message", text: "edited", final: true });
  yield emit({ type: "completed" });
}

/** Terminal context exhaustion with no vendor detail (the cause decides eligibility). */
const exhausted = {
  kind: "capacity_exhausted",
  native_code: null,
  trigger: null,
  pre_tokens: null,
} as const;

const inventory = async (profile: string | null) => {
  if (profile === "b") throw new Error("account model inventory unavailable");
  return [{ id: "m1", label: null, context_window: null, routes: null }];
};

function terminal(o: Outcome) {
  const failure = RunFailure.parse(
    new ArtifactStore(o.root).readYaml(join(o.result.runDir, "final", "failure.yaml")),
  );
  return {
    failure,
    rows: failure.poolAttempts.map((row) => [
      row.profileId,
      row.attemptId,
      row.tryIndex,
      row.phase,
    ]),
    errors: failure.poolAttempts.map((row) => row.error),
    event: terminalEvent(o)?.payload["pool_attempts"],
    summaryMd: readFileSync(join(o.result.runDir, "final", "summary.md"), "utf8"),
  };
}

/** The run's one terminal event (failed, blocked or completed). */
function terminalEvent(o: Outcome) {
  return o.events.find((e) => ["run.failed", "run.blocked", "run.completed"].includes(e.type));
}

/** A healthy paid-route reviewer that finds nothing. */
function cleanReviewer(id: string, providerFamily: ProviderFamily): ReviewerSpec {
  return {
    providerFamily,
    adapter: {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: providerFamily,
          capabilities: { review: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const base = { session_id: spec.session_id, ts: new Date().toISOString() };
        yield { ...base, type: "started", credential_route: "managed_api_key" };
        yield { ...base, type: "message", text: "[]" };
        yield { ...base, type: "completed" };
      },
    },
  };
}

/** A reviewer whose clean verdict is verified (observed model and paid route). */
function approvingReviewer(id: string, providerFamily: ProviderFamily): ReviewerSpec {
  const model = `${id}-model`;
  return {
    providerFamily,
    requestedModel: model,
    adapter: {
      ...cleanReviewer(id, providerFamily).adapter,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: providerFamily,
          access_profiles_supported: ["readonly"],
          capabilities: { review: true, known_models: [model] },
        });
      },
      async *run(spec) {
        const base = { session_id: spec.session_id, ts: new Date().toISOString() };
        const route = { credential_route: "managed_api_key" as const };
        yield { ...base, ...route, type: "started", observed_model: model };
        yield { ...base, type: "message", text: "```json\n[]\n```" };
        yield { ...base, ...route, type: "usage", usage: { cost_usd: 0.001 } };
        yield { ...base, type: "completed" };
      },
    },
  };
}

/** Make the Nth reviewer-evidence preparation throw (review preflight failure). */
function failReviewEvidenceOnCall(n: number) {
  const proto = Orchestrator.prototype as unknown as {
    prepareReviewEvidenceDir(source: string, cwd: string): string;
  };
  const original = proto.prepareReviewEvidenceDir;
  let calls = 0;
  return vi.spyOn(proto, "prepareReviewEvidenceDir").mockImplementation(function (
    this: unknown,
    source: string,
    cwd: string,
  ) {
    calls += 1;
    if (calls === n) throw new Error("fixture evidence unavailable");
    return original.call(this, source, cwd);
  });
}

describe("only a successor that reached its adapter is an account attempt", () => {
  it.each(["agent", "ask"] as const)(
    "%s: a successor whose model inventory fails before dispatch adds no row; an adapter failing at entry does",
    async (mode) => {
      const unavailable = await run({
        mode,
        profiles: ["a", "b"],
        maxRetries: 0,
        models: inventory,
        script: function* ({ profile, emit }) {
          if (profile === "a") yield* refuse(emit);
        },
      });
      // Rotation selected `b`, but its account-scoped model read failed before
      // the send was admitted: its adapter never ran.
      expect(unavailable.spawns.map((s) => s.profile)).toEqual(["a"]);
      const t = terminal(unavailable);
      expect(t.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
      expect(t.errors).toEqual([OUT_OF_USAGE]);
      expect(t.event).toEqual(t.failure.poolAttempts);
      // The preparation failure still speaks as the terminal's own error.
      expect(t.failure.safeMessage).toContain("account model inventory unavailable");

      const entry = await run({
        mode,
        profiles: ["a", "b"],
        maxRetries: 0,
        script: function* ({ profile, emit }) {
          if (profile === "a") return yield* refuse(emit);
          throw new Error("spawn ENOENT");
        },
      });
      expect(entry.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
      const e = terminal(entry);
      // A real adapter failure before its typed start is still that account's try.
      expect(e.rows).toEqual([
        ["a", "a01", 0, "pre_progress"],
        ["b", "a01", 1, "pre_start"],
      ]);
      expect(e.errors[1]).toContain("spawn ENOENT");
    },
  );
});

describe("downstream failure terminals keep every earlier account refusal", () => {
  it("a review preflight failure after a fallback candidate names the refusal before it", async () => {
    const preflight = failReviewEvidenceOnCall(1);
    try {
      const o = await run({
        mode: "agent",
        profiles: ["a", "b"],
        input: { review: true },
        script: function* ({ profile, emit, spec }) {
          if (profile === "a") return yield* refuse(emit);
          yield* edit(emit, spec, "candidate from b");
        },
      });
      expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
      expect(o.result.lifecycle).toBe("failed");
      const t = terminal(o);
      // The terminal's own classification and remedies are unchanged.
      expect(t.failure).toMatchObject({
        phase: "review",
        category: "internal",
        nextActions: ["Open diagnostics", "Retry the run"],
      });
      expect(t.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
      expect(t.event).toEqual(t.failure.poolAttempts);
      for (const text of [t.failure.safeMessage, t.summaryMd, o.result.summary]) {
        expect(text).toContain("fixture evidence unavailable");
        expect(text).toContain(`Account attempts:\n- fake/a · m1 · a01 try 1`);
        expect(text).toContain(OUT_OF_USAGE);
      }
      expect(o.result.spendUsd).toEqual(expect.any(Number));
      expect(o.resumable).toMatchObject({ cause: "other" });
    } finally {
      preflight.mockRestore();
    }
  });

  it("a convergence review that fails on a later attempt names every attempt's refusal", async () => {
    const preflight = failReviewEvidenceOnCall(2);
    try {
      const o = await run({
        mode: "agent",
        profiles: ["a", "b"],
        maxRetries: 0,
        // Convergence review needs two healthy reviewer families.
        reviewers: [cleanReviewer("rev-o", "openai"), cleanReviewer("rev-g", "google")],
        input: {
          attempts: 2,
          review: true,
          paidBudget: { kind: "finite", maxUsd: 10 },
          tests: [{ program: "sh", args: ["-c", "exit 3"], envAllowlist: [] }],
        },
        script: function* ({ profile, emit, spec, tryOfProfile }) {
          if (profile === "a") return yield* refuse(emit);
          yield* edit(emit, spec, `candidate ${tryOfProfile} from b`);
        },
      });
      // Attempt 2's refusal cannot rotate: the shared envelope already holds
      // attempt 1's edit. Its review then fails.
      expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b", "a"]);
      expect(o.result.lifecycle).toBe("failed");
      const t = terminal(o);
      expect(t.failure).toMatchObject({ phase: "review", category: "internal" });
      // Both attempts' refusals, in attempt order — not only the failing attempt's.
      expect(t.rows).toEqual([
        ["a", "a01", 0, "pre_progress"],
        ["a", "a02", 0, "pre_progress"],
      ]);
      expect(t.event).toEqual(t.failure.poolAttempts);
      for (const text of [t.failure.safeMessage, t.summaryMd, o.result.summary])
        expect(text).toContain("- fake/a · m1 · a02 try 1 · pre progress");
      // The failing attempt's own declared continuation still speaks for the run.
      expect(o.resumable).toMatchObject({ cause: "transport" });
    } finally {
      preflight.mockRestore();
    }
  });

  it("a deep scan whose every explorer failed names each account's refusal", async () => {
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      maxRetries: 0,
      input: { deepScan: true, n: 1 },
      script: function* ({ emit }) {
        yield* refuse(emit);
      },
    });
    expect(o.result.lifecycle).toBe("failed");
    const t = terminal(o);
    expect(t.rows).toEqual([
      ["a", "a01", 0, "pre_progress"],
      ["b", "a01", 1, "pre_progress"],
    ]);
    expect(t.event).toEqual(t.failure.poolAttempts);
    expect(t.summaryMd).toContain("Account attempts:");
  });
});

describe("an attempt rebuilt or superseded after its tries keeps their accounts", () => {
  it.each([
    ["race", {}],
    ["convergence", { attempts: 1 }],
  ] as const)(
    "%s: a post-stream failure after a fallback keeps the refusal before it",
    async (_lane, input) => {
      // The tries settled; finishing the attempt (capsule relocation) then threw.
      const finish = vi
        .spyOn(InRunContinuity.prototype, "finish")
        .mockRejectedValueOnce(new Error("fixture capsule relocation failed"));
      try {
        const o = await run({
          mode: "agent",
          profiles: ["a", "b"],
          input,
          script: function* ({ profile, emit, spec }) {
            if (profile === "a") return yield* refuse(emit);
            yield* edit(emit, spec, "candidate from b");
          },
        });
        expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
        expect(o.result.lifecycle).toBe("failed");
        const t = terminal(o);
        expect(t.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
        expect(t.event).toEqual(t.failure.poolAttempts);
        expect(t.failure.safeMessage).toContain(OUT_OF_USAGE);
      } finally {
        finish.mockRestore();
      }
    },
  );

  it("a winner whose harness failed after its work names every account before it", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      script: function* ({ profile, emit, spec }) {
        if (profile === "a") return yield* refuse(emit);
        yield emit({ type: "started" });
        writeFileSync(join(spec.cwd, "edited.txt"), "half done\n");
        yield emit({ type: "file_change", payload: { path: "edited.txt" } });
        yield emit({ type: "error", error: "stream broke" });
        yield emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.result.lifecycle).toBe("failed");
    const t = terminal(o);
    // Arbitration's own failure classification is unchanged.
    expect(t.failure).toMatchObject({ phase: "arbitration", category: "harness_error" });
    expect(t.rows).toEqual([
      ["a", "a01", 0, "pre_progress"],
      ["b", "a01", 1, "after_progress"],
    ]);
    expect(t.errors).toEqual([OUT_OF_USAGE, "stream broke"]);
    expect(t.event).toEqual(t.failure.poolAttempts);
    expect(o.result.summary).toContain("Account attempts:");
  });

  it("a failed one-shot continuation keeps both its own and the original attempt's accounts", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      input: { inPlace: false },
      script: function* ({ profile, emit, spec, tryOfProfile }) {
        if (profile === "a") return yield* refuse(emit);
        yield emit({ type: "started" });
        if (tryOfProfile === 1) {
          // The original attempt runs out of context with partial work.
          writeFileSync(join(spec.cwd, "edited.txt"), "partial\n");
          yield emit({ type: "file_change", payload: { path: "edited.txt" } });
          yield emit({
            type: "context",
            context: { ...exhausted, cause: "repeated_refill" },
          });
          yield emit({ type: "completed" });
          return;
        }
        yield emit({ type: "message", text: "never reached" });
        yield emit({ type: "completed" });
      },
    });
    // The continuation's first account refuses; the envelope already holds the
    // original's edit, so it cannot rotate and the continuation fails.
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b", "a"]);
    expect(o.events.map((e) => e.type)).toContain("run.continuation");
    // The exhausted original still speaks for the run (never the failed continuation).
    expect(o.result.lifecycle).toBe("interrupted");
    const t = terminal(o);
    expect(t.rows).toEqual([
      ["a", "a01", 0, "pre_progress"],
      ["a", "a01c", 0, "pre_progress"],
    ]);
    expect(t.errors).toEqual([OUT_OF_USAGE, OUT_OF_USAGE]);
  });
});

describe("a delivered read-only report that still ends unsuccessfully", () => {
  it.each([
    [
      "context exhaustion",
      {},
      "interrupted",
      (emit: Emit) =>
        emit({
          type: "context",
          context: { ...exhausted, cause: "prompt_too_long" },
        }),
    ],
    [
      "a budget terminal",
      { paidBudget: { kind: "finite", maxUsd: 0.05 } } satisfies Partial<RunInput>,
      "failed",
      (emit: Emit) =>
        emit({ type: "usage", usage: { cost_usd: 2, cost_basis: { kind: "cash", source: "x" } } }),
    ],
  ] as const)(
    "after %s keeps its report and names the refusal before it",
    async (_label, input, lifecycle, ending) => {
      const o = await run({
        mode: "ask",
        profiles: ["a", "b"],
        maxRetries: 0,
        input,
        script: function* ({ profile, emit }) {
          if (profile === "a") return yield* refuse(emit);
          yield emit({ type: "started" });
          yield emit({ type: "message", text: PARTIAL });
          yield ending(emit);
          yield emit({ type: "completed" });
        },
      });
      expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
      expect(o.result.lifecycle).toBe(lifecycle);
      const t = terminal(o);
      expect(t.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
      expect(t.event).toEqual(t.failure.poolAttempts);
      expect(t.failure.safeMessage).toContain("read-only report ended");
      expect(t.failure.safeMessage).toContain(OUT_OF_USAGE);
      // The partial report is preserved ahead of the account list.
      for (const text of [t.summaryMd, o.result.summary]) {
        expect(text).toContain(PARTIAL);
        expect(text.indexOf("Account attempts:")).toBeGreaterThan(text.indexOf(PARTIAL));
      }
    },
  );
});

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
const drainTimeout = () =>
  Promise.reject(
    Object.assign(new Error("delegated children did not settle"), {
      code: "delegation_child_drain_timeout",
    }),
  );

/** A refuses; B serves (an edit in Agent, an answer in Ask). */
function* fallbackServes(mode: "agent" | "ask", profile: string, emit: Emit, spec: HarnessRunSpec) {
  if (profile === "a") return yield* refuse(emit);
  if (mode === "agent") return yield* edit(emit, spec, "candidate from b");
  yield emit({ type: "started" });
  yield emit({ type: "message", text: "answer from b", final: true });
  yield emit({ type: "completed" });
}

describe("the run's own terminal after its strategy keeps every account refusal", () => {
  it.each(["agent", "ask"] as const)(
    "%s: a Delegate child-drain failure after a fallback that served",
    async (mode) => {
      const o = await run({
        mode,
        profiles: ["a", "b"],
        maxRetries: 0,
        deps: { delegationBudgetAuthority: drainAuthority(drainTimeout) },
        script: function* ({ profile, emit, spec }) {
          yield* fallbackServes(mode, profile, emit, spec);
        },
      });
      expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
      expect(o.result.lifecycle).toBe("failed");
      const t = terminal(o);
      expect(t.failure.phase).toBe("delegation_drain");
      expect(t.failure.safeMessage).toContain("delegated children did not settle");
      expect(t.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
      expect(t.event).toEqual(t.failure.poolAttempts);
    },
  );

  it("a Delegate child-drain failure after the run already failed keeps that list", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      deps: { delegationBudgetAuthority: drainAuthority(drainTimeout) },
      script: function* ({ emit }) {
        yield* refuse(emit);
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    const t = terminal(o);
    expect(t.failure.phase).toBe("delegation_drain");
    expect(t.rows).toEqual([
      ["a", "a01", 0, "pre_progress"],
      ["b", "a01", 1, "pre_progress"],
    ]);
  });

  it("a post-drain budget failure after a fallback that served", async () => {
    let drained = false;
    const settled = BudgetLedger.prototype.terminal;
    const overshoot = vi.spyOn(BudgetLedger.prototype, "terminal").mockImplementation(function (
      this: BudgetLedger,
    ) {
      return drained ? "budget_overshoot" : settled.call(this);
    });
    try {
      const o = await run({
        mode: "agent",
        profiles: ["a", "b"],
        maxRetries: 0,
        deps: {
          delegationBudgetAuthority: drainAuthority(async () => {
            drained = true; // a child's settlement overshoots the family budget
          }),
        },
        script: function* ({ profile, emit, spec }) {
          yield* fallbackServes("agent", profile, emit, spec);
        },
      });
      expect(o.result.facts).toMatchObject({ lifecycle: "failed", reason: "budget_overshoot" });
      const t = terminal(o);
      expect(t.failure).toMatchObject({ phase: "budget", category: "budget" });
      expect(t.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
      expect(t.event).toEqual(t.failure.poolAttempts);
      for (const text of [t.failure.safeMessage, t.summaryMd, o.result.summary])
        expect(text).toContain(OUT_OF_USAGE);
    } finally {
      overshoot.mockRestore();
    }
  });
});

describe("an incomplete capture after a try keeps only what that try observed", () => {
  it.each([
    ["race", {}],
    ["convergence", { attempts: 1 }],
  ] as const)("%s: a capture failure right after a refusal", async (_lane, input) => {
    const diff = vi
      .spyOn(WorkspaceManager.prototype, "captureDiff")
      .mockRejectedValueOnce(new Error("fixture git diff failed"));
    try {
      // One try only: an incomplete capture fences rotation (unknown changes)
      // but not a same-account transient retry, which would be its own row.
      const o = await run({
        mode: "agent",
        profiles: ["a", "b"],
        maxRetries: 0,
        input,
        script: function* ({ profile, emit, spec }) {
          yield* fallbackServes("agent", profile, emit, spec);
        },
      });
      expect(o.spawns.map((s) => s.profile)).toEqual(["a"]);
      expect(o.result.lifecycle).toBe("failed");
      const t = terminal(o);
      // The capture failure is the terminal's own typed evidence (an incomplete
      // capture keeps the source for inspection), never an account row.
      expect(t.failure).toMatchObject({
        phase: "workspace",
        captureFailure: {
          code: "capture_failed",
          message: expect.stringContaining("fixture git diff failed"),
        },
      });
      expect(t.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
      expect(t.errors).toEqual([OUT_OF_USAGE]);
    } finally {
      diff.mockRestore();
    }
  });

  it("a capture failure after a try that served adds no row", async () => {
    const diff = vi
      .spyOn(WorkspaceManager.prototype, "captureDiff")
      .mockRejectedValueOnce(new Error("fixture git diff failed"));
    try {
      const o = await run({
        mode: "agent",
        profiles: ["a"],
        script: function* ({ emit, spec }) {
          yield* edit(emit, spec, "served");
        },
      });
      expect(o.result.lifecycle).toBe("failed");
      expect(terminal(o).rows).toEqual([]);
    } finally {
      diff.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Every collection -> terminal consumer once more, through the actual outcome:
// a synthesis attempt joins the run's one attempt collection whether it
// returned or threw; a cancellation and a D8 block keep the earlier refusals
// beside their own cause, which itself never becomes an account row.

const synthRefusal = (profile: string) => `SYNTHESIS-REFUSAL-${profile}`;
const failingGate = { program: "sh", args: ["-c", "exit 3"], envAllowlist: [] };

/** The synthesis' account starts and refuses before any progress. */
function* synthRefuses(profile: string, emit: Emit): Generator<HarnessEvent> {
  yield emit({ type: "started" });
  yield emit({ type: "error", error: synthRefusal(profile) });
  yield emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
}

/** A reviewed best-of-2 race that always synthesizes: candidates serve; `synth`
 * scripts the synthesis' own tries per account (recorded in order). */
async function synthesisRace(
  synth: (profile: string, emit: Emit, spec: HarnessRunSpec) => Generator<HarnessEvent>,
  over: { input?: Partial<RunInput>; deps?: Parameters<typeof run>[0]["deps"] } = {},
) {
  const synthesized: string[] = [];
  const o = await run({
    mode: "agent",
    profiles: ["a", "b"],
    maxRetries: 0,
    reviewers: [cleanReviewer("rev-o", "openai"), cleanReviewer("rev-g", "google")],
    ...(over.deps ? { deps: over.deps } : {}),
    input: {
      n: 2,
      review: true,
      synthesis: "always",
      inPlace: false,
      ...over.input,
    },
    script: function* ({ profile, emit, spec }) {
      if (spec.intent !== "synthesize") return yield* edit(emit, spec, `candidate on ${profile}`);
      synthesized.push(profile);
      yield* synth(profile, emit, spec);
    },
  });
  return { ...o, synthesized };
}

/** The synthesis envelope's capture fails (every capture of the `synth` attempt). */
function synthesisCaptureFails() {
  const original = WorkspaceManager.prototype.captureDiff;
  return vi.spyOn(WorkspaceManager.prototype, "captureDiff").mockImplementation(async function (
    this: WorkspaceManager,
    ...args
  ) {
    const [envelope] = args as Parameters<typeof original>;
    if (envelope.attempt_id === "synth") throw new Error("fixture synthesis capture failed");
    return original.apply(this, args as Parameters<typeof original>);
  });
}

describe("a synthesis attempt's accounts join the run's one attempt collection", () => {
  it("a completed synthesis whose accounts refused, then a Delegate drain failure", async () => {
    const o = await synthesisRace(synthRefuses, {
      deps: { delegationBudgetAuthority: drainAuthority(drainTimeout) },
    });
    expect(o.synthesized).toEqual(["a", "b"]);
    const t = terminal(o);
    expect(t.failure.phase).toBe("delegation_drain");
    expect(t.rows).toEqual([
      ["a", "synth", 0, "pre_progress"],
      ["b", "synth", 1, "pre_progress"],
    ]);
    expect(t.errors).toEqual([synthRefusal("a"), synthRefusal("b")]);
    expect(t.event).toEqual(t.failure.poolAttempts);
    for (const text of [t.failure.safeMessage, t.summaryMd, o.result.summary])
      expect(text).toContain(synthRefusal("b"));
  });

  it("a completed synthesis whose accounts refused, then a post-drain budget failure", async () => {
    let drained = false;
    const settled = BudgetLedger.prototype.terminal;
    const overshoot = vi.spyOn(BudgetLedger.prototype, "terminal").mockImplementation(function (
      this: BudgetLedger,
    ) {
      return drained ? "budget_overshoot" : settled.call(this);
    });
    try {
      const o = await synthesisRace(synthRefuses, {
        deps: {
          delegationBudgetAuthority: drainAuthority(async () => {
            drained = true;
          }),
        },
      });
      expect(o.result.facts).toMatchObject({ lifecycle: "failed", reason: "budget_overshoot" });
      const t = terminal(o);
      expect(t.failure).toMatchObject({ phase: "budget", category: "budget" });
      expect(t.rows).toEqual([
        ["a", "synth", 0, "pre_progress"],
        ["b", "synth", 1, "pre_progress"],
      ]);
      expect(t.event).toEqual(t.failure.poolAttempts);
    } finally {
      overshoot.mockRestore();
    }
  });

  it.each<[string, string, Parameters<typeof synthesisRace>[1]]>([
    ["the race's own check block", "verification", { input: { tests: [failingGate] } }],
    [
      "a Delegate drain failure",
      "delegation_drain",
      { deps: { delegationBudgetAuthority: drainAuthority(drainTimeout) } },
    ],
  ])(
    "a synthesis whose capture failed after a refusal keeps it through %s",
    async (_label, phase, over) => {
      const capture = synthesisCaptureFails();
      try {
        const o = await synthesisRace(function* (profile, emit, spec) {
          if (profile === "a") return yield* synthRefuses(profile, emit);
          yield* edit(emit, spec, "never reached");
        }, over);
        // The capture right after a's refusal failed (an incomplete capture): no
        // successor ran, the run went on, and the synthesis keeps that typed
        // capture evidence beside its refused try.
        expect(o.synthesized).toEqual(["a"]);
        const synthAttempt = new ArtifactStore(o.root).readYaml(
          join(o.result.runDir, "attempts", "synth", "attempt.yaml"),
        ) as { capture_refusal?: { failure?: { message?: string } } };
        expect(synthAttempt.capture_refusal?.failure?.message).toContain(
          "fixture synthesis capture failed",
        );
        const t = terminal(o);
        expect(t.failure.phase).toBe(phase);
        expect(t.rows).toEqual([["a", "synth", 0, "pre_progress"]]);
        expect(t.event).toEqual(t.failure.poolAttempts);
        for (const text of [t.failure.safeMessage, t.summaryMd, o.result.summary])
          expect(text).toContain(synthRefusal("a"));
        // The capture failure is never itself an account row.
        expect(t.errors).toEqual([synthRefusal("a")]);
      } finally {
        capture.mockRestore();
      }
    },
  );

  it("a cancellation during the synthesis keeps its earlier refusal beside it", async () => {
    const cancel = new AbortController();
    const o = await synthesisRace(
      function* (profile, emit) {
        if (profile === "a") return yield* synthRefuses(profile, emit);
        yield emit({ type: "started" });
        cancel.abort("user_cancelled");
        yield emit({ type: "completed" });
      },
      { input: { signal: cancel.signal } },
    );
    expect(o.synthesized).toEqual(["a", "b"]);
    expect(o.result.facts).toMatchObject({ lifecycle: "cancelled", reason: "user_cancelled" });
    const c = cancelledTerminal(o);
    // a's refusal of the synthesis only: b's cancelled try adds no row.
    expect(c.rows).toEqual([["a", "synth", 0, "pre_progress"]]);
    expect(c.failureWritten).toBe(false);
    for (const text of [c.summaryMd, o.result.summary]) expect(text).toContain(synthRefusal("a"));
  });

  it("a synthesis that served adds no row to a later failure terminal", async () => {
    const o = await synthesisRace(
      function* (profile, emit, spec) {
        yield* edit(emit, spec, `synthesis on ${profile}`);
      },
      { deps: { delegationBudgetAuthority: drainAuthority(drainTimeout) } },
    );
    expect(o.synthesized).toHaveLength(1);
    const t = terminal(o);
    expect(t.failure.phase).toBe("delegation_drain");
    expect(t.rows).toEqual([]);
    expect(t.summaryMd).not.toContain("Account attempts:");
  });
});

/** The cancelled terminal: its event list, its summaries, and no failure record. */
function cancelledTerminal(o: Outcome) {
  const event = terminalEvent(o);
  const rows = (event?.payload["pool_attempts"] as PoolAttemptFailure[] | undefined)?.map((row) => [
    row.profileId,
    row.attemptId,
    row.tryIndex,
    row.phase,
  ]);
  return {
    event,
    rows,
    failureWritten: existsSync(join(o.result.runDir, "final", "failure.yaml")),
    summaryMd: readFileSync(join(o.result.runDir, "final", "summary.md"), "utf8"),
  };
}

describe("a cancellation keeps the earlier refusals beside it and mints no failure record", () => {
  it.each(["agent", "ask"] as const)("%s: a refused, then b's try is cancelled", async (mode) => {
    const cancel = new AbortController();
    const o = await run({
      mode,
      profiles: ["a", "b"],
      maxRetries: 0,
      input: { signal: cancel.signal },
      script: function* ({ profile, emit }) {
        if (profile === "a") return yield* refuse(emit);
        yield emit({ type: "started" });
        cancel.abort("user_cancelled");
        yield emit({ type: "completed" });
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.result.facts).toMatchObject({ lifecycle: "cancelled", reason: "user_cancelled" });
    const c = cancelledTerminal(o);
    expect(c.event?.type).toBe("run.failed");
    // a's real refusal only: the cancelled try of b adds no row.
    expect(c.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
    expect(c.failureWritten).toBe(false);
    for (const text of [c.summaryMd, o.result.summary]) expect(text).toContain(OUT_OF_USAGE);
    // The cancellation stays the primary statement.
    expect(o.result.summary.startsWith("run cancelled")).toBe(true);
  });

  it.each([
    [
      "the drain observes the cancel",
      async (cancel: AbortController) => cancel.abort("user_cancelled"),
    ],
    [
      "the drain fails after the cancel",
      async (cancel: AbortController) => {
        cancel.abort("user_cancelled");
        throw new Error("fixture drain failed after the cancel");
      },
    ],
  ] as const)("the run's own Delegate cancellation terminal when %s", async (_label, drain) => {
    const cancel = new AbortController();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      input: { signal: cancel.signal },
      deps: { delegationBudgetAuthority: drainAuthority(() => drain(cancel)) },
      script: function* ({ profile, emit, spec }) {
        yield* fallbackServes("agent", profile, emit, spec);
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.result.lifecycle).toBe("cancelled");
    const c = cancelledTerminal(o);
    expect(c.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
    expect(c.failureWritten).toBe(false);
    for (const text of [c.summaryMd, o.result.summary]) {
      expect(text).toContain("run cancelled");
      expect(text).toContain(OUT_OF_USAGE);
    }
  });
});

/** A real gate that holds only inside the fresh final-verify tree: it marks
 * that it runs there, then waits until the test releases it. */
function heldVerifyGate(dir: string) {
  const started = join(dir, "verify.started");
  const release = join(dir, "verify.release");
  const script = [
    'const fs = require("node:fs");',
    'if (process.cwd().includes("claudexor-verify-")) {',
    `  fs.writeFileSync(${JSON.stringify(started)}, "running");`,
    "  const end = Date.now() + 5000;",
    `  const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(wait); else if (Date.now() > end) process.exit(2); }, 10);`,
    "}",
  ].join("\n");
  return {
    started,
    release,
    gate: { program: process.execPath, args: ["-e", script], envAllowlist: [] },
  };
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

describe("a cancel that lands after the strategy's verdict is the terminal's statement", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it.each([
    ["race", "user_cancelled"],
    ["race", "wall_clock_exceeded"],
    ["convergence", "user_cancelled"],
    ["convergence", "wall_clock_exceeded"],
  ] as const)("%s: %s while the final verification gate runs", async (lane, reason) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cx-held-verify-")));
    dirs.push(dir);
    const held = heldVerifyGate(dir);
    const cancel = new AbortController();
    const pending = run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      input: {
        inPlace: false,
        signal: cancel.signal,
        tests: [held.gate],
        ...(lane === "convergence" ? { attempts: 1 } : {}),
      },
      script: function* ({ profile, emit, spec }) {
        yield* fallbackServes("agent", profile, emit, spec);
      },
    });
    const deadline = Date.now() + 8000;
    while (!existsSync(held.started) && Date.now() < deadline) await delay(10);
    const gateHeld = existsSync(held.started);
    cancel.abort(reason);
    writeFileSync(held.release, "released after the cancel\n");
    const o = await pending;
    expect(gateHeld).toBe(true);
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.result.facts).toMatchObject({ lifecycle: "cancelled", reason });
    const c = cancelledTerminal(o);
    expect(c.event?.type).toBe("run.failed");
    expect(c.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
    expect(c.event?.payload["cancel_reason"]).toBe(reason);
    expect(c.failureWritten).toBe(false);
    // The cancel is the statement, never the passing verdict it replaced.
    expect(c.summaryMd).toContain("- Lifecycle: cancelled");
    expect(c.summaryMd).not.toContain("Lifecycle: succeeded");
    expect(o.result.summary.startsWith("run cancelled")).toBe(true);
    for (const text of [c.summaryMd, o.result.summary]) expect(text).toContain(OUT_OF_USAGE);
    expect(c.event?.payload["run_facts"]).toMatchObject({
      apply: { eligibility: { eligible: false } },
    });
  });

  it("ask: a cancel after the report is the statement, with the earlier refusal", async () => {
    const cancel = new AbortController();
    const spy = cancelAtTelemetry(cancel);
    try {
      const o = await run({
        mode: "ask",
        profiles: ["a", "b"],
        maxRetries: 0,
        input: { signal: cancel.signal },
        script: function* ({ profile, emit, spec }) {
          yield* fallbackServes("ask", profile, emit, spec);
        },
      });
      expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
      expect(o.result.facts).toMatchObject({ lifecycle: "cancelled", reason: "user_cancelled" });
      const c = cancelledTerminal(o);
      expect(c.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
      expect(c.failureWritten).toBe(false);
      expect(o.result.summary.startsWith("run cancelled")).toBe(true);
      for (const text of [c.summaryMd, o.result.summary]) expect(text).toContain(OUT_OF_USAGE);
    } finally {
      spy.mockRestore();
    }
  });

  it("race: a cancel after a check block replaces the block and its failure record", async () => {
    const cancel = new AbortController();
    const spy = cancelAtTelemetry(cancel);
    try {
      const o = await run({
        mode: "agent",
        profiles: ["a", "b"],
        maxRetries: 0,
        input: { signal: cancel.signal, tests: [failingGate] },
        script: function* ({ profile, emit, spec }) {
          yield* fallbackServes("agent", profile, emit, spec);
        },
      });
      expect(o.result.facts).toMatchObject({
        lifecycle: "cancelled",
        checks: "failed",
        reason: "user_cancelled",
      });
      const c = cancelledTerminal(o);
      expect(c.event?.type).toBe("run.failed");
      expect(c.event?.payload).not.toHaveProperty("failure_ref");
      expect(c.event?.payload).not.toHaveProperty("phase");
      expect(c.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
      expect(c.failureWritten).toBe(false);
      expect(c.summaryMd).toContain("- Lifecycle: cancelled");
      for (const text of [c.summaryMd, o.result.summary]) expect(text).toContain(OUT_OF_USAGE);
    } finally {
      spy.mockRestore();
    }
  });

  it("control: a cancel after the success terminal durably committed changes nothing", async () => {
    const cancel = new AbortController();
    const original = EventLog.prototype.emit;
    // Abort only once the canonical terminal is durable (receipt and event
    // committed), never on the strategy's mere success verdict.
    const committed = vi.spyOn(EventLog.prototype, "emit").mockImplementation(function (
      this: EventLog,
      ...args: Parameters<EventLog["emit"]>
    ) {
      const event = original.apply(this, args);
      if (this.terminalCommitted() && !cancel.signal.aborted) cancel.abort("user_cancelled");
      return event;
    });
    try {
      const o = await run({
        mode: "agent",
        profiles: ["a", "b"],
        maxRetries: 0,
        input: { signal: cancel.signal },
        script: function* ({ profile, emit, spec }) {
          yield* fallbackServes("agent", profile, emit, spec);
        },
      });
      expect(cancel.signal.aborted).toBe(true);
      expect(o.result.lifecycle).toBe("succeeded");
      expect(o.result.cancelReason).toBeUndefined();
      const event = terminalEvent(o);
      expect(event?.type).toBe("run.completed");
      expect(event?.payload).not.toHaveProperty("pool_attempts");
      const receipt = new ArtifactStore(o.root).readYaml(
        join(o.result.runDir, "final", "run_facts.yaml"),
      ) as { outcome: { lifecycle: string } };
      expect(receipt.outcome.lifecycle).toBe("succeeded");
      expect(existsSync(join(o.result.runDir, "final", "failure.yaml"))).toBe(false);
      const summaryMd = readFileSync(join(o.result.runDir, "final", "summary.md"), "utf8");
      for (const text of [summaryMd, o.result.summary]) {
        expect(text).not.toContain("run cancelled");
        expect(text).not.toContain("Account attempts:");
      }
    } finally {
      committed.mockRestore();
    }
  });

  it("control: a cancel during the run's barrier, after the verdict, leaves the success", async () => {
    const cancel = new AbortController();
    // The scope settlement runs inside the whole-run barrier, after the
    // strategy returned and before its terminal is published: the decision
    // was frozen with the verdict.
    const runScopes: RunScopeCustodian = {
      open: (runId) => inProcessRunScopeCustodian.open(runId),
      settle: (runId, marker) => {
        cancel.abort("user_cancelled");
        return inProcessRunScopeCustodian.settle(runId, marker);
      },
    };
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      input: { signal: cancel.signal },
      deps: { runScopes },
      script: function* ({ profile, emit, spec }) {
        yield* fallbackServes("agent", profile, emit, spec);
      },
    });
    expect(cancel.signal.aborted).toBe(true);
    expect(o.result.lifecycle).toBe("succeeded");
    expect(o.result.cancelReason).toBeUndefined();
    const event = terminalEvent(o);
    expect(event?.type).toBe("run.completed");
    expect(event?.payload).not.toHaveProperty("pool_attempts");
    const summaryMd = readFileSync(join(o.result.runDir, "final", "summary.md"), "utf8");
    for (const text of [summaryMd, o.result.summary]) {
      expect(text).not.toContain("run cancelled");
      expect(text).not.toContain("Account attempts:");
    }
  });
});

/** The live repository of a verify tree (its main worktree). */
const liveTouchGate = {
  program: "sh",
  // Only the fresh verify tree touches the live tree: delivery then sees the
  // target change after a passing verify and refuses (not a verify failure).
  // The verify tree of an object result is a private clone (#535); its first
  // alternate is the live repository's object directory.
  args: [
    "-c",
    'case "$PWD" in *claudexor-verify-*) live="$(dirname "$(dirname "$(sed -n 1p "$(git rev-parse --git-common-dir)/objects/info/alternates")")")"; echo touched >> "$live/live-touch.txt";; esac',
  ],
  envAllowlist: [],
};
const verifyTreeFails = {
  program: "sh",
  args: ["-c", 'case "$PWD" in *claudexor-verify-*) exit 3;; esac'],
  envAllowlist: [],
};

describe("a succeeded lifecycle that still blocks keeps the earlier refusals", () => {
  it.each<[string, string, Partial<RunInput>]>([
    ["race: a required gate fails", "review", { tests: [failingGate] }],
    [
      "race: the fresh verify tree fails",
      "verification",
      { inPlace: false, tests: [verifyTreeFails] },
    ],
    ["convergence: a required gate fails", "review", { attempts: 1, tests: [failingGate] }],
  ])("%s", async (_label, phase, input) => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      input,
      script: function* ({ profile, emit, spec }) {
        yield* fallbackServes("agent", profile, emit, spec);
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.result.facts).toMatchObject({ lifecycle: "succeeded", checks: "failed" });
    expect(terminalEvent(o)?.type).toBe("run.blocked");
    const t = terminal(o);
    expect(t.failure.phase).toBe(phase);
    // a's refusal; b's check failure is not an account failure.
    expect(t.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
    expect(t.event).toEqual(t.failure.poolAttempts);
    for (const text of [t.failure.safeMessage, t.summaryMd, o.result.summary])
      expect(text).toContain(OUT_OF_USAGE);
  });

  it("race: delivery refuses a target that changed after a passing verify", async () => {
    let refused = 0;
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      // A verified clean review makes the winner applyable, so delivery runs.
      reviewers: [approvingReviewer("rev-o", "openai"), approvingReviewer("rev-g", "google")],
      input: { n: 2, review: true, synthesis: "never", tests: [liveTouchGate] },
      script: function* ({ profile, emit, spec }) {
        // Exactly one refusal in the whole run, whichever candidate meets it.
        if (profile === "a" && refused++ === 0) return yield* refuse(emit);
        yield* edit(emit, spec, `candidate on ${profile}`);
      },
    });
    expect(o.result.facts).toMatchObject({ lifecycle: "succeeded", checks: "failed" });
    expect(terminalEvent(o)?.type).toBe("run.blocked");
    const t = terminal(o);
    expect(t.failure.phase).toBe("delivery");
    expect(t.failure.safeMessage).toContain("refusing stale delivery");
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]?.[0]).toBe("a");
    expect(t.event).toEqual(t.failure.poolAttempts);
    for (const text of [t.failure.safeMessage, t.summaryMd, o.result.summary])
      expect(text).toContain(OUT_OF_USAGE);
  });

  const needsInput = [
    "```json",
    JSON.stringify({
      work_report: {
        state: "needs_input",
        required_inputs: [{ kind: "decision", locator: "db", description: "Which database?" }],
      },
    }),
    "```",
  ].join("\n");

  it.each([
    ["race", "agent", {}],
    ["convergence", "agent", { attempts: 1 }],
    ["ask", "ask", {}],
  ] as const)(
    "%s: a work-state veto (needs input) is a block with the earlier refusal",
    async (_lane, mode, input) => {
      const o = await run({
        mode,
        profiles: ["a", "b"],
        maxRetries: 0,
        input,
        capabilities: { work_report_transport: "validated", json_schema_output: false },
        script: function* ({ profile, emit, spec }) {
          if (profile === "a") return yield* refuse(emit);
          yield emit({ type: "started" });
          if (mode === "agent") writeFileSync(join(spec.cwd, "edited.txt"), "partial\n");
          yield emit({
            type: "message",
            text: `I need a decision first.\n${needsInput}`,
            final: true,
          });
          yield emit({ type: "completed" });
        },
      });
      expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
      expect(o.result.facts).toMatchObject({ lifecycle: "succeeded", reason: "input_required" });
      const event = terminalEvent(o);
      expect(event?.type).toBe("run.blocked");
      // The veto is not an account failure: only a's refusal is named.
      expect(event?.payload["pool_attempts"]).toEqual([
        expect.objectContaining({ profileId: "a", attemptId: "a01", error: OUT_OF_USAGE }),
      ]);
      const summaryMd = readFileSync(join(o.result.runDir, "final", "summary.md"), "utf8");
      for (const text of [summaryMd, o.result.summary]) expect(text).toContain(OUT_OF_USAGE);
    },
  );

  it("control: a clean completion after a fallback that served names no list", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      script: function* ({ profile, emit, spec }) {
        yield* fallbackServes("agent", profile, emit, spec);
      },
    });
    expect(o.result.lifecycle).toBe("succeeded");
    const event = terminalEvent(o);
    expect(event?.type).toBe("run.completed");
    expect(event?.payload).not.toHaveProperty("pool_attempts");
    expect(existsSync(join(o.result.runDir, "final", "failure.yaml"))).toBe(false);
    expect(o.result.summary).not.toContain("Account attempts:");
  });
});

/** Cancel the run while the first post-try capture (git diff) runs. */
function cancelDuringFirstCapture(cancel: AbortController, reason: string) {
  const original = WorkspaceManager.prototype.captureDiff;
  let calls = 0;
  return vi.spyOn(WorkspaceManager.prototype, "captureDiff").mockImplementation(async function (
    this: WorkspaceManager,
    ...args
  ) {
    if ((calls += 1) === 1) cancel.abort(reason);
    return original.apply(this, args as Parameters<typeof original>);
  });
}

describe("a cancel or deadline that lands during the post-try capture stops the attempt", () => {
  it.each(["user_cancelled", "wall_clock_exceeded"] as const)(
    "%s: no rotation after it, and the refusal before it stays a row",
    async (reason) => {
      const cancel = new AbortController();
      const capture = cancelDuringFirstCapture(cancel, reason);
      try {
        const o = await run({
          mode: "agent",
          profiles: ["a", "b"],
          maxRetries: 0,
          input: { signal: cancel.signal },
          script: function* ({ profile, emit, spec }) {
            yield* fallbackServes("agent", profile, emit, spec);
          },
        });
        expect(o.result.facts).toMatchObject({ lifecycle: "cancelled", reason });
        expect(o.spawns.map((s) => s.profile)).toEqual(["a"]);
        expect(o.rotated).toEqual([]);
        const attempt = new ArtifactStore(o.root).readYaml(
          join(o.result.runDir, "attempts", "a01", "attempt.yaml"),
        ) as Record<string, unknown>;
        // The receipt names the account that ran and keeps its own error.
        expect(attempt["credential_profile_applied"]).toBe("a");
        expect(attempt["errors"]).toEqual([OUT_OF_USAGE]);
        const c = cancelledTerminal(o);
        expect(c.rows).toEqual([["a", "a01", 0, "pre_progress"]]);
        expect(c.failureWritten).toBe(false);
      } finally {
        capture.mockRestore();
      }
    },
  );

  it("schedules no transient retry for a try whose capture saw the cancel", async () => {
    const cancel = new AbortController();
    const capture = cancelDuringFirstCapture(cancel, "user_cancelled");
    try {
      const o = await run({
        mode: "agent",
        profiles: ["a"],
        maxRetries: 2,
        input: { signal: cancel.signal },
        script: function* ({ emit, tryOfProfile }) {
          yield emit({ type: "started" });
          if (tryOfProfile === 1) {
            yield emit({
              type: "error",
              error: "upstream connection reset",
              transient: { kind: "network", retry_delay_ms: 3000 },
            });
            yield emit({
              type: "completed",
              payload: { exit_code: 1, harness_reported_error: true },
            });
            return;
          }
          yield emit({ type: "message", text: "never reached", final: true });
          yield emit({ type: "completed" });
        },
      });
      expect(o.result.lifecycle).toBe("cancelled");
      expect(o.spawns).toHaveLength(1);
      expect(o.events.map((e) => e.type)).not.toContain("route.transient.retry_scheduled");
      // A cancelled attempt exhausted no transient retries.
      expect(o.events.map((e) => e.type)).not.toContain("route.transient.exhausted");
    } finally {
      capture.mockRestore();
    }
  });

  it("claims no exhausted transient retries for a try cancelled in its stream", async () => {
    const cancel = new AbortController();
    const o = await run({
      mode: "agent",
      profiles: ["a"],
      maxRetries: 2,
      input: { signal: cancel.signal },
      script: function* ({ emit }) {
        yield emit({ type: "started" });
        yield emit({
          type: "error",
          error: "upstream connection reset",
          transient: { kind: "network", retry_delay_ms: 3000 },
        });
        cancel.abort("user_cancelled");
        yield emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
      },
    });
    expect(o.result.lifecycle).toBe("cancelled");
    expect(o.spawns).toHaveLength(1);
    expect(o.events.map((e) => e.type)).not.toContain("route.transient.exhausted");
  });
});

/** The #363 memory's writes during one run (the daemon ledger's stand-in). */
function refusalMemory() {
  const recorded: string[] = [];
  const memory: PreProgressRefusalMemory = {
    live: () => [],
    generation: () => 0,
    record: (value) => void recorded.push(value.profile_id),
    clear: () => {},
    services: null,
  };
  return { memory, recorded };
}

describe("a stop during the post-try capture keeps the try's own refusal note (#363)", () => {
  it.each([false, true])(
    "stopped during capture: %s — a's started-then-refused try is noted once",
    async (stopped) => {
      const cancel = new AbortController();
      const capture = stopped ? cancelDuringFirstCapture(cancel, "user_cancelled") : null;
      // The rotation step's probe and A7 wiring: never built after a stop.
      const rotation = vi.spyOn(OrchestratorCredentials.prototype, "rotationObservations");
      const { memory, recorded } = refusalMemory();
      try {
        const o = await run({
          mode: "agent",
          profiles: ["a", "b"],
          maxRetries: 0,
          input: { signal: cancel.signal },
          deps: { preProgressRefusals: memory },
          script: function* ({ profile, emit, spec }) {
            yield* fallbackServes("agent", profile, emit, spec);
          },
        });
        expect(recorded).toEqual(["a"]);
        if (stopped) {
          expect(o.result.lifecycle).toBe("cancelled");
          expect(o.spawns.map((s) => s.profile)).toEqual(["a"]);
          expect(o.rotated).toEqual([]);
          expect(rotation).not.toHaveBeenCalled();
          expect(o.events.map((e) => e.type)).not.toContain("route.transient.retry_scheduled");
          expect(cancelledTerminal(o).rows).toEqual([["a", "a01", 0, "pre_progress"]]);
        } else {
          expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
          expect(rotation).toHaveBeenCalledTimes(1);
        }
      } finally {
        capture?.mockRestore();
        rotation.mockRestore();
      }
    },
  );

  it.each<[string, Partial<Parameters<typeof run>[0]>, (cancel: AbortController) => Script]>([
    ["a pinned account", { pinned: "a" }, () => (ctx) => refuse(ctx.emit)],
    [
      "a try whose session never started",
      {},
      () =>
        function* ({ emit }) {
          yield emit({ type: "error", error: OUT_OF_USAGE });
          yield emit({
            type: "completed",
            payload: { exit_code: 1, harness_reported_error: true },
          });
        },
    ],
    [
      "a refusal that left a workspace change",
      {},
      () =>
        function* ({ emit, spec }) {
          yield emit({ type: "started" });
          writeFileSync(join(spec.cwd, "edited.txt"), "partial\n");
          yield emit({ type: "error", error: OUT_OF_USAGE });
          yield emit({
            type: "completed",
            payload: { exit_code: 1, harness_reported_error: true },
          });
        },
    ],
    [
      "a try the cancel reached before its refusal",
      {},
      (cancel) =>
        function* ({ emit }) {
          yield emit({ type: "started" });
          cancel.abort("user_cancelled");
          yield emit({ type: "error", error: OUT_OF_USAGE });
          yield emit({
            type: "completed",
            payload: { exit_code: 1, harness_reported_error: true },
          });
        },
    ],
  ])("control: %s is not noted, and nothing runs after the stop", async (_label, over, tryOfA) => {
    const cancel = new AbortController();
    const capture = cancelDuringFirstCapture(cancel, "user_cancelled");
    const { memory, recorded } = refusalMemory();
    try {
      const o = await run({
        mode: "agent",
        profiles: ["a", "b"],
        maxRetries: 0,
        ...over,
        input: { signal: cancel.signal },
        deps: { preProgressRefusals: memory },
        script: tryOfA(cancel),
      });
      expect(o.result.lifecycle).toBe("cancelled");
      expect(o.spawns.map((s) => s.profile)).toEqual(["a"]);
      expect(o.rotated).toEqual([]);
      expect(recorded).toEqual([]);
    } finally {
      capture.mockRestore();
    }
  });
});

describe("the terminal-facts failure terminal names the run's list too", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("keeps the announced attempts' rows when the terminal projection is unreadable", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "cx-pool-facts-")));
    dirs.push(repo);
    const store = new ArtifactStore(repo);
    const paths = store.createRun("run-facts");
    const log = new EventLog(paths.eventsPath, "run-facts", "task-facts");
    // decision.yaml present but unreadable: the projection fails closed.
    store.writeText(join(paths.arbitrationDir, "decision.yaml"), "winner: [malformed\n");
    const row: PoolAttemptFailure = {
      harnessId: "fake",
      profileId: "a",
      profileDisplayName: "a",
      requestedModel: "m1",
      attemptId: "a01",
      tryIndex: 0,
      observedAt: "2026-10-15T00:00:00.000Z",
      phase: "pre_progress",
      category: "unknown_harness_error",
      error: OUT_OF_USAGE,
      vendorFailure: null,
    };
    const result = await guardAnnouncedRun(undefined, async (announce) => {
      log.emit("run.created", { mode: "agent", prompt: "x" });
      announce({
        log,
        store,
        paths,
        runId: "run-facts",
        taskId: "task-facts",
        mode: "agent",
        phase: "race",
        spend: () => 0,
        recheckBudgetAfterBarrier: () => false,
        attempts: () => [{ poolAttempts: [row] }],
      });
      log.emit("run.completed", { lifecycle: "succeeded" });
      return {
        runId: "run-facts",
        taskId: "task-facts",
        mode: "agent",
        lifecycle: "succeeded",
        facts: makeOutcomeFacts("succeeded"),
        winner: null,
        runDir: paths.root,
        summary: "done",
        candidates: [],
      };
    });
    expect(result.lifecycle).toBe("failed");
    const failure = RunFailure.parse(store.readYaml(join(paths.finalDir, "failure.yaml")));
    expect(failure.phase).toBe("terminal_facts");
    expect(failure.poolAttempts).toEqual([row]);
    const events = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    expect(events.at(-1)?.payload["pool_attempts"]).toEqual([row]);
    for (const text of [failure.safeMessage, result.summary])
      expect(text).toContain(`Account attempts:\n- fake/a · m1 · a01 try 1`);
  });
});
