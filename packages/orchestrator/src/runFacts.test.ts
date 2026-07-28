import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import {
  CouncilProjection,
  DecisionRecord,
  ReviewFinding,
  RunTelemetry,
  SCHEMA_VERSION,
  TaskContract,
  WorkProduct,
  makeOutcomeFacts,
  type RunEvent,
  type TestCommand,
} from "@claudexor/schema";
import { sha256 } from "@claudexor/util";
import { buildRunFacts } from "./runFacts.js";
import { guardAnnouncedRun, type AnnouncedRunContext } from "./runTerminals.js";

const timestamp = "2026-07-26T12:00:00.000Z";
const fixtures: Array<{ root: string; log: EventLog }> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.log.dispose();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function gate(id: string): TestCommand {
  return {
    id,
    program: process.execPath,
    args: ["-e", "process.exit(0)"],
    envAllowlist: [],
    required: true,
    trust_required: false,
    trust_grant: null,
  };
}

function runFixture(
  commands: TestCommand[],
  mode: "agent" | "plan" = "agent",
  onEmit?: (event: RunEvent) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "claudexor-run-facts-"));
  const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
  const paths = store.createRun("run-facts");
  const log = new EventLog(paths.eventsPath, "run-facts", "task-facts", onEmit);
  const ctx: AnnouncedRunContext = {
    log,
    store,
    paths,
    runId: "run-facts",
    taskId: "task-facts",
    mode,
    phase: "test",
  };
  const contract = TaskContract.parse({
    schema_version: SCHEMA_VERSION,
    task_id: "task-facts",
    created_at: timestamp,
    repo: { root, base_ref: "main" },
    mode: { kind: mode },
    user_intent: { raw: "exercise terminal facts" },
    tests: { commands },
  });
  store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
  const telemetry = RunTelemetry.parse({
    schema_version: SCHEMA_VERSION,
    run_id: "run-facts",
    task_id: "task-facts",
    mode,
    requested_access: "workspace_write",
    effective_access: "workspace_write",
    external_context_policy: "off",
    effective_web_mode: "off",
    final_attempt_id: "a01",
    web: {},
    attempts: [
      {
        attempt_id: "a01",
        harness_id: "fake-success",
        web: {},
        outcome: {
          deliverable_present: false,
          gates_passed: commands.length > 0 ? true : null,
          status: "success",
        },
      },
    ],
    generated_at: timestamp,
  });
  store.writeYaml(join(paths.finalDir, "telemetry.yaml"), telemetry);
  fixtures.push({ root, log });
  return { root, store, paths, log, ctx };
}

describe("RunFacts canonical artifact projection (GH #29)", () => {
  it("fails closed when a requested multi-gate set only has a partial passing receipt", () => {
    const { log, ctx } = runFixture([gate("gate-1"), gate("gate-2")]);
    log.emit("gate.completed", {
      attempt_id: "a01",
      gates: [{ id: "gate-1", status: "passed" }],
      // This aggregate used to be vacuously true despite missing gate-2.
      passed: true,
    });

    const facts = buildRunFacts(ctx, makeOutcomeFacts("succeeded", { checks: "passed" }));
    expect(facts.gates).toEqual({
      configured: true,
      required: 2,
      total: 2,
      executed: true,
      state: "skipped",
      receipt_attempt_id: "a01",
    });
    expect(facts.outcome).toMatchObject({ checks: "failed", reason: "checks_failed" });
    expect(facts.required_actions.map((action) => action.id)).toEqual([
      "fix_failed_checks",
      "record_operator_decision",
    ]);
  });

  it("commits canonicalized facts to the receipt, terminal event, and returned result together", async () => {
    const { store, paths, log, ctx } = runFixture([gate("gate-1")]);
    const optimistic = makeOutcomeFacts("succeeded", { checks: "passed" });

    const result = await guardAnnouncedRun(undefined, async (announce) => {
      announce(ctx);
      log.emit("run.completed", {
        lifecycle: optimistic.lifecycle,
        facts: optimistic,
        reason: optimistic.reason,
      });
      return {
        runId: ctx.runId,
        taskId: ctx.taskId,
        mode: ctx.mode,
        lifecycle: optimistic.lifecycle,
        facts: optimistic,
        winner: null,
        runDir: paths.root,
        summary: "optimistic result",
        candidates: [],
      };
    });

    const terminal = log.readAll().events.at(-1);
    const stored = store.readYaml<{ outcome: unknown }>(join(paths.finalDir, "run_facts.yaml"));
    expect(result.facts).toMatchObject({
      lifecycle: "succeeded",
      checks: "failed",
      reason: "checks_failed",
    });
    expect(terminal).toMatchObject({
      type: "run.blocked",
      payload: {
        lifecycle: "succeeded",
        facts: result.facts,
        reason: "checks_failed",
      },
    });
    expect(stored?.outcome).toEqual(result.facts);
  });

  it("normalizes an unexplained clean-axis run.blocked to the canonical completed type", async () => {
    const { paths, log, ctx } = runFixture([]);
    const partial = makeOutcomeFacts("succeeded");

    const result = await guardAnnouncedRun(undefined, async (announce) => {
      announce(ctx);
      log.emit("run.blocked", {
        lifecycle: partial.lifecycle,
        facts: partial,
        reason: "partial external evidence",
      });
      return {
        runId: ctx.runId,
        taskId: ctx.taskId,
        mode: ctx.mode,
        lifecycle: partial.lifecycle,
        facts: partial,
        winner: null,
        runDir: paths.root,
        summary: "partial answer",
        candidates: [],
      };
    });

    expect(result.facts).toEqual(partial);
    expect(log.readAll().events.at(-1)).toMatchObject({
      type: "run.completed",
      payload: { lifecycle: "succeeded", facts: partial, reason: null },
    });
  });

  it("emits a terminal when an announced strategy returns without one", async () => {
    const { store, paths, log, ctx } = runFixture([]);
    const succeeded = makeOutcomeFacts("succeeded");

    const result = await guardAnnouncedRun(undefined, async (announce) => {
      announce(ctx);
      return {
        runId: ctx.runId,
        taskId: ctx.taskId,
        mode: ctx.mode,
        lifecycle: succeeded.lifecycle,
        facts: succeeded,
        winner: null,
        runDir: paths.root,
        summary: "returned without emitting",
        candidates: [],
      };
    });

    const events = log.readAll().events;
    expect(events.map((event) => event.type)).toEqual(["output.ready", "run.completed"]);
    expect(log.terminalCommitted()).toBe(true);
    expect(
      store.readYaml<{ outcome: { lifecycle: string } }>(join(paths.finalDir, "run_facts.yaml"))
        ?.outcome.lifecycle,
    ).toBe("succeeded");
    expect(result.lifecycle).toBe("succeeded");
  });

  it("turns a deterministic RunFacts contradiction into one canonical failed terminal", async () => {
    const { store, paths, log, ctx } = runFixture([]);
    const patch = "diff --git a/a.txt b/a.txt\n";
    store.writeText(join(paths.finalDir, "patch.diff"), patch);
    store.writeYaml(
      join(paths.finalDir, "work_product.yaml"),
      WorkProduct.parse({
        id: "wp-contradiction",
        kind: "patch",
        source_task_id: ctx.taskId,
        producer_attempt_id: "a01",
        meta: { patch_sha256: sha256(patch), result_kind: "patch" },
      }),
    );
    store.writeYaml(
      join(paths.arbitrationDir, "decision.yaml"),
      DecisionRecord.parse({
        winner: "a01",
        facts: makeOutcomeFacts("succeeded", { review: "approved" }),
      }),
    );

    const optimistic = makeOutcomeFacts("succeeded", { review: "approved" });
    const result = await guardAnnouncedRun(undefined, async (announce) => {
      announce(ctx);
      log.emit("run.completed", {
        lifecycle: optimistic.lifecycle,
        facts: optimistic,
      });
      return {
        runId: ctx.runId,
        taskId: ctx.taskId,
        mode: ctx.mode,
        lifecycle: optimistic.lifecycle,
        facts: optimistic,
        winner: "a01",
        runDir: paths.root,
        summary: "optimistic",
        candidates: [],
      };
    });

    const terminals = log
      .readAll()
      .events.filter(
        (event) =>
          event.type === "run.completed" ||
          event.type === "run.blocked" ||
          event.type === "run.failed",
      );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      type: "run.failed",
      payload: { lifecycle: "failed", phase: "terminal_facts" },
    });
    expect(result).toMatchObject({ lifecycle: "failed", winner: null });
    expect(result.summary).toContain("terminal facts preparation failed");
    expect(
      store.readYaml<{ outcome: { lifecycle: string } }>(join(paths.finalDir, "run_facts.yaml"))
        ?.outcome.lifecycle,
    ).toBe("failed");
    expect(readFileSync(join(paths.finalDir, "failure.yaml"), "utf8")).toContain("terminal_facts");
  });

  it("keeps a committed terminal authoritative when producer code throws afterwards", async () => {
    const { paths, log, ctx } = runFixture([]);
    const succeeded = makeOutcomeFacts("succeeded");

    const result = await guardAnnouncedRun(undefined, async (announce) => {
      announce(ctx);
      log.emit("run.completed", {
        lifecycle: succeeded.lifecycle,
        facts: succeeded,
      });
      throw new Error("post-terminal producer bug");
    });

    expect(result.lifecycle).toBe("succeeded");
    expect(
      log
        .readAll()
        .events.filter(
          (event) =>
            event.type === "run.completed" ||
            event.type === "run.blocked" ||
            event.type === "run.failed",
        ),
    ).toHaveLength(1);
    expect(existsSync(join(paths.finalDir, "failure.yaml"))).toBe(false);
  });

  it("folds an abort present at terminal commit into event, receipt, and result", async () => {
    const { store, paths, log, ctx } = runFixture([]);
    const controller = new AbortController();
    const optimistic = makeOutcomeFacts("succeeded", {
      noChanges: true,
      review: "approved",
      reason: "work_incomplete",
      work_state: {
        state: "incomplete",
        source: "constrained",
      },
    });

    const result = await guardAnnouncedRun(controller.signal, async (announce) => {
      announce(ctx);
      controller.abort();
      log.emit("run.completed", {
        lifecycle: optimistic.lifecycle,
        facts: optimistic,
      });
      return {
        runId: ctx.runId,
        taskId: ctx.taskId,
        mode: ctx.mode,
        lifecycle: optimistic.lifecycle,
        facts: optimistic,
        winner: null,
        runDir: paths.root,
        summary: "optimistic",
        candidates: [],
      };
    });

    expect(result.lifecycle).toBe("cancelled");
    expect(result.facts).toMatchObject({
      lifecycle: "cancelled",
      reason: "user_cancelled",
      noChanges: true,
      checks: "not_configured",
      review: "approved",
      work_state: {
        state: "incomplete",
        source: "constrained",
      },
    });
    expect(log.readAll().events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: {
        lifecycle: "cancelled",
        facts: {
          lifecycle: "cancelled",
          reason: "user_cancelled",
          noChanges: true,
          checks: "not_configured",
          review: "approved",
          work_state: {
            state: "incomplete",
            source: "constrained",
          },
        },
      },
    });
    expect(
      store.readYaml<{ outcome: Record<string, unknown> }>(join(paths.finalDir, "run_facts.yaml"))
        ?.outcome,
    ).toMatchObject({
      lifecycle: "cancelled",
      reason: "user_cancelled",
      noChanges: true,
      checks: "not_configured",
      review: "approved",
      work_state: {
        state: "incomplete",
        source: "constrained",
      },
    });
  });

  it("rolls back an optimistic receipt when terminal sink commit fails, then records one failure", async () => {
    let rejectFirstTerminal = true;
    const { store, paths, log, ctx } = runFixture([], "agent", (event) => {
      if (
        rejectFirstTerminal &&
        (event.type === "run.completed" ||
          event.type === "run.blocked" ||
          event.type === "run.failed")
      ) {
        rejectFirstTerminal = false;
        throw new Error("journal terminal append failed");
      }
    });
    const optimistic = makeOutcomeFacts("succeeded");

    const result = await guardAnnouncedRun(undefined, async (announce) => {
      announce(ctx);
      log.emit("run.completed", {
        lifecycle: optimistic.lifecycle,
        facts: optimistic,
      });
      return {
        runId: ctx.runId,
        taskId: ctx.taskId,
        mode: ctx.mode,
        lifecycle: optimistic.lifecycle,
        facts: optimistic,
        winner: null,
        runDir: paths.root,
        summary: "optimistic",
        candidates: [],
      };
    });

    const terminals = log
      .readAll()
      .events.filter(
        (event) =>
          event.type === "run.completed" ||
          event.type === "run.blocked" ||
          event.type === "run.failed",
      );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe("run.failed");
    expect(result.lifecycle).toBe("failed");
    expect(
      store.readYaml<{ outcome: { lifecycle: string } }>(join(paths.finalDir, "run_facts.yaml"))
        ?.outcome.lifecycle,
    ).toBe("failed");
  });

  it("preserves the typed recovery signal after durable terminal acceptance", async () => {
    const durable: RunEvent[] = [];
    const { store, paths, log, ctx } = runFixture([], "agent", (event) => {
      durable.push(event);
    });
    const originalWriteYaml = store.writeYaml.bind(store);
    store.writeYaml = (path, value) => {
      if (path.includes(".run-facts-")) throw new Error("forced local receipt failure");
      originalWriteYaml(path, value);
    };
    const succeeded = makeOutcomeFacts("succeeded");

    let thrown: unknown;
    try {
      await guardAnnouncedRun(undefined, async (announce) => {
        announce(ctx);
        log.emit("run.completed", {
          lifecycle: succeeded.lifecycle,
          facts: succeeded,
        });
        return {
          runId: ctx.runId,
          taskId: ctx.taskId,
          mode: ctx.mode,
          lifecycle: succeeded.lifecycle,
          facts: succeeded,
          winner: null,
          runDir: paths.root,
          summary: "done",
          candidates: [],
        };
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "terminal_recovery_required", status: 503 });
    expect(durable.at(-1)).toMatchObject({
      type: "run.completed",
      payload: {
        lifecycle: "succeeded",
        run_facts: {
          run_id: ctx.runId,
          task_id: ctx.taskId,
          outcome: { lifecycle: "succeeded" },
        },
      },
    });
    expect(log.terminalCommitted()).toBe(false);
  });

  it("prefers the fresh final-verify gate receipt over an earlier passing attempt", () => {
    const { store, paths, log, ctx } = runFixture([gate("gate-1")]);
    log.emit("gate.completed", {
      attempt_id: "a01",
      gates: [{ id: "gate-1", status: "passed" }],
      passed: true,
    });
    log.emit("gate.completed", {
      attempt_id: "final-verify",
      gates: [{ id: "gate-1", status: "failed" }],
      passed: false,
    });
    const outcome = makeOutcomeFacts("succeeded", {
      checks: "failed",
      review: "approved",
      reason: "checks_failed",
    });
    store.writeYaml(
      join(paths.arbitrationDir, "decision.yaml"),
      DecisionRecord.parse({
        winner: "a01",
        facts: outcome,
        final_verify: {
          attempted: true,
          applied_cleanly: true,
          gates_passed: false,
          gates: [{ id: "gate-1", status: "failed" }],
        },
      }),
    );

    const facts = buildRunFacts(ctx, outcome);
    expect(facts.gates).toMatchObject({
      receipt_attempt_id: "final-verify",
      executed: true,
      state: "failed",
    });
    expect(facts.outcome.checks).toBe("failed");
  });

  it("prefers the arbitration winner's gate receipt over telemetry's last attempted loser", () => {
    const { store, paths, log, ctx } = runFixture([gate("gate-1")]);
    const telemetry = RunTelemetry.parse(store.readYaml(join(paths.finalDir, "telemetry.yaml")));
    const baseAttempt = telemetry.attempts[0]!;
    store.writeYaml(
      join(paths.finalDir, "telemetry.yaml"),
      RunTelemetry.parse({
        ...telemetry,
        final_attempt_id: "a02",
        attempts: [
          {
            ...baseAttempt,
            attempt_id: "a01",
            outcome: { ...baseAttempt.outcome, deliverable_present: true },
          },
          {
            ...baseAttempt,
            attempt_id: "a02",
            harness_id: "loser",
            outcome: { ...baseAttempt.outcome, deliverable_present: true },
          },
        ],
      }),
    );
    log.emit("gate.completed", {
      attempt_id: "a01",
      gates: [{ id: "gate-1", status: "passed" }],
      passed: true,
    });
    log.emit("gate.completed", {
      attempt_id: "a02",
      gates: [{ id: "gate-1", status: "failed" }],
      passed: false,
    });
    const outcome = makeOutcomeFacts("succeeded", { checks: "passed" });
    store.writeYaml(
      join(paths.arbitrationDir, "decision.yaml"),
      DecisionRecord.parse({ winner: "a01", facts: outcome }),
    );

    const facts = buildRunFacts(ctx, outcome);
    expect(facts.gates).toMatchObject({
      receipt_attempt_id: "a01",
      state: "passed",
    });
    expect(facts.outcome).toMatchObject({ checks: "passed", reason: null });
  });

  it("fails closed instead of adopting a loser's gates when the winner receipt is missing", () => {
    const { store, paths, log, ctx } = runFixture([gate("gate-1")]);
    log.emit("gate.completed", {
      attempt_id: "a02",
      gates: [{ id: "gate-1", status: "passed" }],
      passed: true,
    });
    const outcome = makeOutcomeFacts("succeeded", { checks: "passed" });
    store.writeYaml(
      join(paths.arbitrationDir, "decision.yaml"),
      DecisionRecord.parse({ winner: "a01", facts: outcome }),
    );

    const facts = buildRunFacts(ctx, outcome);
    expect(facts.gates).toEqual({
      configured: true,
      required: 1,
      total: 1,
      executed: false,
      state: "skipped",
      receipt_attempt_id: null,
    });
    expect(facts.outcome).toMatchObject({ checks: "failed", reason: "checks_failed" });
  });

  it("fails closed when an attempted final verify has no gate receipt or results", () => {
    const { store, paths, log, ctx } = runFixture([gate("gate-1")]);
    log.emit("gate.completed", {
      attempt_id: "a01",
      gates: [{ id: "gate-1", status: "passed" }],
      passed: true,
    });
    const outcome = makeOutcomeFacts("succeeded", {
      checks: "passed",
      review: "approved",
    });
    store.writeYaml(
      join(paths.arbitrationDir, "decision.yaml"),
      DecisionRecord.parse({
        winner: "a01",
        facts: outcome,
        final_verify: {
          attempted: true,
          applied_cleanly: true,
          gates_passed: null,
          gates: [],
          reason: "gate receipt missing",
        },
      }),
    );

    const facts = buildRunFacts(ctx, outcome);
    expect(facts.gates).toEqual({
      configured: true,
      required: 1,
      total: 1,
      executed: false,
      state: "skipped",
      receipt_attempt_id: null,
    });
    expect(facts.outcome).toMatchObject({ checks: "failed", reason: "checks_failed" });
  });

  it("does not let a passed verify receipt greenwash a later blocked delivery", () => {
    const { store, paths, log, ctx } = runFixture([gate("gate-1")]);
    log.emit("gate.completed", {
      attempt_id: "final-verify",
      gates: [{ id: "gate-1", status: "passed" }],
      passed: true,
    });
    const outcome = makeOutcomeFacts("succeeded", {
      checks: "failed",
      review: "approved",
      reason: "checks_failed",
    });
    store.writeYaml(
      join(paths.arbitrationDir, "decision.yaml"),
      DecisionRecord.parse({
        winner: "a01",
        facts: outcome,
        final_verify: {
          attempted: true,
          applied_cleanly: true,
          gates_passed: true,
          gates: [{ id: "gate-1", status: "passed" }],
        },
      }),
    );

    const facts = buildRunFacts(ctx, outcome);
    expect(facts.gates).toMatchObject({
      receipt_attempt_id: "final-verify",
      executed: true,
      state: "skipped",
    });
    expect(facts.outcome).toMatchObject({
      lifecycle: "succeeded",
      checks: "failed",
      reason: "checks_failed",
    });
  });

  // FinalVerifier and the protected live apply are deterministic checks that
  // run even when the contract configures no gates: the fail-closed terminal
  // CHECKS axis must survive the zero-gate projection (gates.* stays honestly
  // not_configured) instead of being greenwashed into a completed, eligible run.
  function zeroGateBlockedFixture(finalVerify: {
    attempted: boolean;
    applied_cleanly: boolean | null;
    gates_passed: boolean | null;
  }) {
    const fixture = runFixture([]);
    const outcome = makeOutcomeFacts("succeeded", {
      checks: "failed",
      review: "approved",
      reason: "checks_failed",
    });
    fixture.store.writeText(
      join(fixture.paths.finalDir, "patch.diff"),
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
    );
    fixture.store.writeYaml(
      join(fixture.paths.finalDir, "telemetry.yaml"),
      RunTelemetry.parse({
        schema_version: SCHEMA_VERSION,
        run_id: "run-facts",
        task_id: "task-facts",
        mode: "agent",
        requested_access: "workspace_write",
        effective_access: "workspace_write",
        external_context_policy: "off",
        effective_web_mode: "off",
        final_attempt_id: "a01",
        web: {},
        attempts: [
          {
            attempt_id: "a01",
            harness_id: "fake-success",
            web: {},
            outcome: { deliverable_present: true, gates_passed: null, status: "success" },
          },
        ],
        generated_at: timestamp,
      }),
    );
    fixture.store.writeYaml(
      join(fixture.paths.arbitrationDir, "decision.yaml"),
      DecisionRecord.parse({
        winner: "a01",
        facts: outcome,
        final_verify: { ...finalVerify, gates: [] },
      }),
    );
    return { ...fixture, outcome };
  }

  async function zeroGateBlockedTerminal(fixture: ReturnType<typeof zeroGateBlockedFixture>) {
    const { paths, log, ctx, outcome } = fixture;
    const result = await guardAnnouncedRun(undefined, async (announce) => {
      announce(ctx);
      log.emit("run.blocked", {
        lifecycle: outcome.lifecycle,
        facts: outcome,
        reason: outcome.reason,
      });
      return {
        runId: ctx.runId,
        taskId: ctx.taskId,
        mode: ctx.mode,
        lifecycle: outcome.lifecycle,
        facts: outcome,
        winner: "a01",
        runDir: paths.root,
        summary: "zero-gate needs-decision terminal",
        candidates: [],
      };
    });
    const receipt = fixture.store.readYaml<{
      outcome: unknown;
      gates: unknown;
      apply: { eligibility: { eligible: boolean; state: string } | null };
      required_actions: Array<{ id: string }>;
    }>(join(paths.finalDir, "run_facts.yaml"));
    return { result, receipt, terminal: log.readAll().events.at(-1) };
  }

  it("keeps a zero-gate delivery refusal a blocked, non-eligible needs-decision terminal", async () => {
    // Race adoption refused the live apply AFTER a passed fresh verify
    // (deliveryRefusalDecisionFields): verify green, delivery refused.
    const fixture = zeroGateBlockedFixture({
      attempted: true,
      applied_cleanly: true,
      gates_passed: true,
    });
    const { result, receipt, terminal } = await zeroGateBlockedTerminal(fixture);

    expect(result.facts).toMatchObject({
      lifecycle: "succeeded",
      checks: "failed",
      reason: "checks_failed",
    });
    expect(terminal).toMatchObject({
      type: "run.blocked",
      payload: { lifecycle: "succeeded", facts: result.facts, reason: "checks_failed" },
    });
    expect(receipt?.outcome).toEqual(result.facts);
    expect(receipt?.gates).toEqual({
      configured: false,
      required: 0,
      total: 0,
      executed: false,
      state: "not_configured",
      receipt_attempt_id: null,
    });
    expect(receipt?.required_actions.map((action) => action.id)).toEqual([
      "fix_failed_checks",
      "record_operator_decision",
    ]);
    expect(receipt?.apply.eligibility).toMatchObject({ eligible: false, state: "needs_review" });
  });

  it("keeps a zero-gate final-verify failure a blocked, non-eligible needs-decision terminal", async () => {
    for (const appliedCleanly of [false, null]) {
      const fixture = zeroGateBlockedFixture({
        attempted: true,
        applied_cleanly: appliedCleanly,
        gates_passed: null,
      });
      const { result, receipt, terminal } = await zeroGateBlockedTerminal(fixture);

      expect(result.facts).toMatchObject({
        lifecycle: "succeeded",
        checks: "failed",
        reason: "checks_failed",
      });
      expect(terminal).toMatchObject({ type: "run.blocked" });
      expect(receipt?.outcome).toEqual(result.facts);
      expect(receipt?.gates).toMatchObject({ configured: false, state: "not_configured" });
      expect(receipt?.required_actions.length).toBeGreaterThan(0);
      expect(receipt?.apply.eligibility).toMatchObject({ eligible: false, state: "needs_review" });
    }
  });

  it("terminalizes a blocked winner carrying needs_input as a blocked receipt, not an engine failure", async () => {
    // Arbitration precedence: review_blocked OUTRANKS the work_state veto, so
    // the winner's facts legitimately pair reason=review_blocked with a
    // disclosed needs_input work_state. The receipt invariant must accept the
    // combination (it used to demand reason=input_required iff needs_input and
    // rewrote this terminal into run.failed/terminal_facts).
    const fixture = runFixture([]);
    const outcome = makeOutcomeFacts("succeeded", {
      review: "blocked",
      reason: "review_blocked",
      work_state: { state: "needs_input", source: "validated" },
    });
    fixture.store.writeYaml(
      join(fixture.paths.arbitrationDir, "decision.yaml"),
      DecisionRecord.parse({ winner: "a01", facts: outcome }),
    );
    fixture.store.writeYaml(join(fixture.paths.reviewsDir, "a01.yaml"), {
      attempt_id: "a01",
      findings: [
        ReviewFinding.parse({
          id: "blocker-1",
          severity: "BLOCK",
          category: "correctness",
          claim: "The winner needs more context before this can land.",
          evidence: { files: [{ path: "README.md", lines: null }] },
          reviewer: { harness_id: "reviewer-x" },
          status: "accepted",
        }),
      ],
    });

    const result = await guardAnnouncedRun(undefined, async (announce) => {
      announce(fixture.ctx);
      fixture.log.emit("run.blocked", {
        lifecycle: outcome.lifecycle,
        facts: outcome,
        reason: outcome.reason,
      });
      return {
        runId: fixture.ctx.runId,
        taskId: fixture.ctx.taskId,
        mode: fixture.ctx.mode,
        lifecycle: outcome.lifecycle,
        facts: outcome,
        winner: "a01",
        runDir: fixture.paths.root,
        summary: "blocked winner that also needs input",
        candidates: [],
      };
    });

    expect(result.facts).toMatchObject({
      lifecycle: "succeeded",
      review: "blocked",
      reason: "review_blocked",
      work_state: { state: "needs_input" },
    });
    expect(fixture.log.readAll().events.at(-1)).toMatchObject({
      type: "run.blocked",
      payload: { lifecycle: "succeeded", facts: result.facts, reason: "review_blocked" },
    });
    const receipt = fixture.store.readYaml<{
      outcome: unknown;
      review: unknown;
      required_actions: Array<{ id: string }>;
    }>(join(fixture.paths.finalDir, "run_facts.yaml"));
    expect(receipt?.outcome).toEqual(result.facts);
    expect(receipt?.review).toEqual({
      state: "blocked",
      blocker_ids: ["blocker-1"],
      blockers: 1,
    });
    // The work_state veto is non-overridable, so it owns the required action.
    expect(receipt?.required_actions.map((action) => action.id)).toEqual([
      "provide_required_input",
    ]);
  });

  it("refuses a zero-byte deliverable of any kind (the issue #29 false green)", () => {
    // A succeeded plan whose plan.md is empty has NO canonical deliverable —
    // present:false trips the succeeded-plan invariant loudly instead of
    // shipping an empty receipt as green.
    const plan = runFixture([], "plan");
    plan.store.writeText(join(plan.paths.finalDir, "plan.md"), "   \n");
    expect(() =>
      buildRunFacts(plan.ctx, makeOutcomeFacts("succeeded", { review: "approved" })),
    ).toThrow(/succeeded plan must have a canonical deliverable/);

    // Same rule for non-plan kinds: an empty answer.md is not a deliverable.
    const agent = runFixture([]);
    agent.store.writeText(join(agent.paths.finalDir, "answer.md"), "");
    const facts = buildRunFacts(agent.ctx, makeOutcomeFacts("succeeded"));
    expect(facts.deliverable).toEqual({
      present: false,
      kind: null,
      path: null,
      producer_attempt_id: null,
    });
  });

  it("refuses a symlinked deliverable (lstat symmetry with the receipt fences)", () => {
    const agent = runFixture([]);
    const external = join(agent.root, "external-answer.md");
    writeFileSync(external, "# real content\n");
    symlinkSync(external, join(agent.paths.finalDir, "answer.md"));
    const facts = buildRunFacts(agent.ctx, makeOutcomeFacts("succeeded"));
    expect(facts.deliverable.present).toBe(false);
  });

  it("fails loudly on a corrupted task.yaml instead of projecting silent not_configured", () => {
    const { store, paths, ctx } = runFixture([gate("gate-1")]);
    // Schema-invalid contract: parses as YAML but violates TaskContract.
    store.writeYaml(join(paths.contextDir, "task.yaml"), { tests: "corrupted" });
    expect(() => buildRunFacts(ctx, makeOutcomeFacts("succeeded"))).toThrow(
      /canonical run artifact is invalid: .*task\.yaml/,
    );
    // Unreadable YAML bytes are equally loud: present is never a silent null.
    store.writeText(join(paths.contextDir, "task.yaml"), "{ not: [valid\n");
    expect(() => buildRunFacts(ctx, makeOutcomeFacts("succeeded"))).toThrow(
      /not readable YAML: .*task\.yaml/,
    );
  });

  it("fails loudly when a review artifact carries a malformed finding", () => {
    const { store, paths, ctx } = runFixture([]);
    // review.blockers is contract: a malformed finding could hide an accepted
    // blocker, so it must never be silently skipped.
    store.writeYaml(join(paths.reviewsDir, "r01.yaml"), {
      attempt_id: "a01",
      findings: [{ id: "f1" }],
    });
    expect(() => buildRunFacts(ctx, makeOutcomeFacts("succeeded"))).toThrow(
      /invalid finding: r01\.yaml/,
    );
  });

  it("keeps budget-denied council members in the planner roster without counting merge or review", () => {
    const { store, paths, log, ctx } = runFixture([], "plan");
    store.writeText(join(paths.finalDir, "plan.md"), "# Unified plan\n");
    store.writeYaml(
      join(paths.finalDir, "telemetry.yaml"),
      RunTelemetry.parse({
        schema_version: SCHEMA_VERSION,
        run_id: "run-facts",
        task_id: "task-facts",
        mode: "plan",
        requested_access: "readonly",
        effective_access: "readonly",
        external_context_policy: "off",
        effective_web_mode: "off",
        final_attempt_id: "p03",
        web: {},
        attempts: [
          {
            attempt_id: "p02",
            harness_id: "planner-b",
            web: {},
            outcome: {
              deliverable_present: true,
              gates_passed: null,
              status: "success",
            },
          },
          {
            attempt_id: "p03",
            harness_id: "planner-b",
            web: {},
            outcome: {
              deliverable_present: true,
              gates_passed: null,
              status: "success",
            },
          },
        ],
        generated_at: timestamp,
      }),
    );
    store.writeYaml(
      join(paths.root, "council", "membership.yaml"),
      CouncilProjection.parse({
        requested: 2,
        drafted: 1,
        degraded: true,
        mergedBy: "planner-b",
        members: [
          {
            harnessId: "planner-a",
            role: "member",
            status: "failed",
            error: "budget denied before spawn",
          },
          {
            harnessId: "planner-b",
            role: "primary",
            status: "merged",
            error: null,
          },
        ],
      }),
    );
    store.writeYaml(join(paths.reviewsDir, "panel.yaml"), {
      reviewer_requests: [{ harness_id: "reviewer-c" }],
    });
    log.emit("council.started", {
      requested: 2,
      members: ["planner-a", "planner-b"],
    });
    log.emit("budget.lease.created", {
      granted: false,
      attempt_id: "p01",
      harness_id: "planner-a",
      reason: "budget denied before spawn",
    });
    log.emit("council.member.failed", {
      attempt_id: "p01",
      harness_id: "planner-a",
      error: "budget denied before spawn",
    });
    log.emit("council.draft", {
      harness_id: "planner-b",
      path: "council/draft-planner-b.md",
    });
    log.emit("harness.started", { attempt_id: "p02", harness_id: "planner-b" });
    log.emit("harness.started", { attempt_id: "p03", harness_id: "planner-b" });
    log.emit("council.merged", {
      merged_by: "planner-b",
      drafted: 1,
      requested: 2,
      degraded: true,
    });

    const facts = buildRunFacts(ctx, makeOutcomeFacts("succeeded", { checks: "not_configured" }));
    expect(facts.participants.planners).toBe(2);
    expect(
      facts.participants.attempts.map(({ attempt_id, harness_id, role, status }) => ({
        attempt_id,
        harness_id,
        role,
        status,
      })),
    ).toEqual([
      {
        attempt_id: "p01",
        harness_id: "planner-a",
        role: "planner",
        status: "failed",
      },
      {
        attempt_id: "p02",
        harness_id: "planner-b",
        role: "planner",
        status: "success",
      },
      {
        attempt_id: "p03",
        harness_id: "planner-b",
        role: "merge",
        status: "success",
      },
      {
        attempt_id: null,
        harness_id: "reviewer-c",
        role: "reviewer",
        status: null,
      },
    ]);
  });

  it("takes blocker ids only from the terminal winner while retaining the run-wide reviewer roster", () => {
    const { store, paths, ctx } = runFixture([]);
    const outcome = makeOutcomeFacts("succeeded", { review: "approved" });
    store.writeYaml(
      join(paths.finalDir, "telemetry.yaml"),
      RunTelemetry.parse({
        schema_version: SCHEMA_VERSION,
        run_id: "run-facts",
        task_id: "task-facts",
        mode: "agent",
        requested_access: "workspace_write",
        effective_access: "workspace_write",
        external_context_policy: "off",
        effective_web_mode: "off",
        // The last attempted candidate lost; the decision winner is the
        // terminal deliverable whose review decides blocker identity.
        final_attempt_id: "a02",
        web: {},
        attempts: [
          {
            attempt_id: "a01",
            harness_id: "winner",
            web: {},
            outcome: {
              deliverable_present: true,
              gates_passed: null,
              status: "success",
            },
          },
          {
            attempt_id: "a02",
            harness_id: "loser",
            web: {},
            outcome: {
              deliverable_present: true,
              gates_passed: null,
              status: "success",
            },
          },
        ],
        generated_at: timestamp,
      }),
    );
    store.writeYaml(
      join(paths.arbitrationDir, "decision.yaml"),
      DecisionRecord.parse({ winner: "a01", facts: outcome }),
    );
    store.writeYaml(join(paths.reviewsDir, "a01.yaml"), {
      attempt_id: "a01",
      reviewer_requests: [{ harness_id: "reviewer-winner" }],
      findings: [],
    });
    store.writeYaml(join(paths.reviewsDir, "a02.yaml"), {
      attempt_id: "a02",
      reviewer_requests: [{ harness_id: "reviewer-loser" }],
      findings: [
        ReviewFinding.parse({
          id: "loser-blocker",
          severity: "BLOCK",
          category: "correctness",
          claim: "This finding belongs only to the losing candidate.",
          evidence: { files: [{ path: "README.md", lines: null }] },
          reviewer: { harness_id: "reviewer-loser" },
          status: "accepted",
        }),
      ],
    });

    const facts = buildRunFacts(ctx, outcome);
    expect(facts.review).toEqual({
      state: "approved",
      blocker_ids: [],
      blockers: 0,
    });
    expect(
      facts.participants.attempts
        .filter((participant) => participant.role === "reviewer")
        .map((participant) => participant.harness_id),
    ).toEqual(["reviewer-loser", "reviewer-winner"]);
  });

  it("keeps patch canonical when a successful agent also produced structured output", () => {
    const { store, paths, ctx } = runFixture([]);
    const patch = "diff --git a/a.txt b/a.txt\n";
    store.writeText(join(paths.finalDir, "patch.diff"), patch);
    store.writeText(join(paths.finalDir, "output.json"), '{"status":"ok"}\n');
    store.writeYaml(
      join(paths.finalDir, "work_product.yaml"),
      WorkProduct.parse({
        id: "wp-dual-output",
        kind: "patch",
        source_task_id: ctx.taskId,
        producer_attempt_id: "a01",
        meta: { patch_sha256: sha256(patch), result_kind: "patch" },
      }),
    );
    const telemetry = RunTelemetry.parse(store.readYaml(join(paths.finalDir, "telemetry.yaml")));
    store.writeYaml(
      join(paths.finalDir, "telemetry.yaml"),
      RunTelemetry.parse({
        ...telemetry,
        attempts: telemetry.attempts.map((attempt) => ({
          ...attempt,
          outcome: { ...attempt.outcome, deliverable_present: true },
        })),
      }),
    );
    const outcome = makeOutcomeFacts("succeeded", { review: "approved" });
    store.writeYaml(
      join(paths.arbitrationDir, "decision.yaml"),
      DecisionRecord.parse({ winner: "a01", facts: outcome }),
    );

    expect(buildRunFacts(ctx, outcome).deliverable).toMatchObject({
      present: true,
      kind: "patch",
      path: "final/patch.diff",
      producer_attempt_id: "a01",
    });
  });

  it("recognizes only a hash-bound risk decision on a needs-decision outcome", () => {
    const { store, paths, ctx } = runFixture([]);
    const patch = "diff --git a/a.txt b/a.txt\n";
    store.writeText(join(paths.finalDir, "patch.diff"), patch);
    store.writeYaml(
      join(paths.finalDir, "work_product.yaml"),
      WorkProduct.parse({
        id: "wp-facts",
        kind: "patch",
        source_task_id: "task-facts",
        producer_attempt_id: "a01",
        meta: { patch_sha256: sha256(patch), apply_state: "not_applied" },
      }),
    );
    const telemetry = RunTelemetry.parse(store.readYaml(join(paths.finalDir, "telemetry.yaml")));
    store.writeYaml(
      join(paths.finalDir, "telemetry.yaml"),
      RunTelemetry.parse({
        ...telemetry,
        attempts: telemetry.attempts.map((attempt) => ({
          ...attempt,
          outcome: { ...attempt.outcome, deliverable_present: true },
        })),
      }),
    );
    const blocked = makeOutcomeFacts("succeeded", {
      review: "blocked",
      reason: "review_blocked",
    });
    store.writeYaml(
      join(paths.arbitrationDir, "decision.yaml"),
      DecisionRecord.parse({ winner: "a01", facts: blocked }),
    );
    store.writeYaml(join(paths.arbitrationDir, "operator_decision.yaml"), {
      action: "accept_risk",
      patch_sha256: sha256("different patch"),
    });

    const stale = buildRunFacts(ctx, blocked);
    expect(stale.apply.operator_decision_present).toBe(false);
    expect(stale.required_actions.map((action) => action.id)).toEqual([
      "resolve_review_block",
      "record_operator_decision",
    ]);

    store.writeYaml(join(paths.arbitrationDir, "operator_decision.yaml"), {
      action: "accept_risk",
      patch_sha256: sha256(patch),
    });
    const matching = buildRunFacts(ctx, blocked);
    expect(matching.apply.operator_decision_present).toBe(true);
    expect(matching.required_actions).toEqual([]);

    const clean = buildRunFacts(ctx, makeOutcomeFacts("succeeded", { review: "approved" }));
    expect(clean.apply.operator_decision_present).toBe(false);
  });
});
