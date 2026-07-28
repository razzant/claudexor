import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { BudgetLedger, routeCostEvidence } from "@claudexor/budget";
import { EventLog } from "@claudexor/event-log";
import { SCHEMA_VERSION, TaskContract, makeOutcomeFacts } from "@claudexor/schema";
import { DelegationBudgetAuthority } from "./delegationBudgetAuthority.js";
import { failTerminally, guardAnnouncedRun } from "./runTerminals.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(runId: string) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "cx-term-")));
  dirs.push(repo);
  const store = new ArtifactStore(repo);
  const paths = store.createRun(runId);
  const log = new EventLog(paths.eventsPath, runId, "task-parent");
  return { store, paths, log };
}

function seedPassingGateEvidence({
  store,
  paths,
  log,
}: Pick<ReturnType<typeof fixture>, "store" | "paths" | "log">): void {
  store.writeYaml(
    join(paths.contextDir, "task.yaml"),
    TaskContract.parse({
      schema_version: SCHEMA_VERSION,
      task_id: "task-parent",
      created_at: "2026-07-26T12:00:00.000Z",
      repo: { root: store.repoRoot, base_ref: "main" },
      mode: { kind: "agent" },
      user_intent: { raw: "exercise terminal reconciliation" },
      tests: {
        commands: [
          {
            id: "gate-1",
            program: process.execPath,
            args: ["-e", "process.exit(0)"],
            envAllowlist: [],
            required: true,
            trust_required: false,
            trust_grant: null,
          },
        ],
      },
    }),
  );
  log.emit("gate.completed", {
    attempt_id: "a01",
    gates: [{ id: "gate-1", status: "passed" }],
    passed: true,
  });
}

describe("Delegate terminal drain ordering", () => {
  it("settles delayed child cash before the deferred parent terminal and emits no cash afterward", async () => {
    const { store, paths, log } = fixture("run-parent");
    let authority!: DelegationBudgetAuthority;
    const root = new BudgetLedger({ kind: "finite", maxUsd: 1 }, undefined, {
      onCashSettled: (cash, valuation) =>
        log.emit("budget.cash", { cash_spend_usd: cash, valuation_usd: valuation }),
    });
    authority = new DelegationBudgetAuthority({
      cancelAdmission: () => {
        setTimeout(() => {
          child.settle(lease.lease_id, {
            knowledge: "exact",
            source: "child-terminal",
            provenance: ["test"],
            cashUsd: 0.2,
          });
          authority.releaseRun("run-child");
        }, 5);
      },
    });
    authority.registerParent("run-parent", root);
    authority.noteChildAccepted("run-parent", "job-child");
    const child = authority.attachChild("run-parent", "job-child", "run-child", "task-child");
    const lease = child.reserve({
      taskId: "task-child",
      intent: "implement",
      harnessId: "child",
      cost: routeCostEvidence({
        billing: "metered",
        knowledge: "estimated",
        source: "test",
        provenance: ["test"],
        estimatedUsd: 0.3,
      }),
    }).lease!;

    const result = await guardAnnouncedRun(
      undefined,
      async (announce) => {
        log.emit("run.created", { mode: "agent", prompt: "x" });
        announce({
          log,
          store,
          paths,
          runId: "run-parent",
          taskId: "task-parent",
          mode: "agent",
          phase: "race",
          spend: () => root.spend(),
          valuation: () => root.valuation(),
          spendEstimated: () => root.estimated(),
          budgetTerminal: () => root.terminal(),
          recheckBudgetAfterBarrier: () => true,
        });
        store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
          winner: "a01",
          facts: makeOutcomeFacts("succeeded"),
          why_winner: "strategy completed before child drain",
          budget_summary: {
            spend_usd: 0,
            cash_usd: 0,
            valuation_usd: 0,
            estimated: false,
          },
        });
        log.deferTerminal();
        log.emit("output.ready", { path: "final/summary.md", kind: "summary" });
        log.emit("run.completed", { lifecycle: "succeeded" });
        return {
          runId: "run-parent",
          taskId: "task-parent",
          mode: "agent",
          lifecycle: "succeeded",
          facts: makeOutcomeFacts("succeeded"),
          winner: "a01",
          runDir: paths.root,
          summary: "done",
          candidates: [{ attemptId: "a01", harnessId: "claude", status: "success" }],
          decisionPath: join(paths.arbitrationDir, "decision.yaml"),
          reviewVerified: true,
        };
      },
      async () => {
        authority.beginParentClose("run-parent");
        await authority.waitForChildren("run-parent", 1_000);
      },
      () => authority.releaseRun("run-parent"),
    );

    const events = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual([
      "run.created",
      "output.ready",
      "budget.cash",
      "run.completed",
    ]);
    expect(result.spendUsd).toBeCloseTo(0.2);
    expect(
      store.readYaml<{ budget_summary: { spend_usd: number; cash_usd: number } }>(
        join(paths.arbitrationDir, "decision.yaml"),
      ),
    ).toMatchObject({ budget_summary: { spend_usd: 0.2, cash_usd: 0.2 } });
  });

  it("replaces deferred success when delayed child settlement overshoots the family cap", async () => {
    const { store, paths, log } = fixture("run-overshoot");
    let authority!: DelegationBudgetAuthority;
    const root = new BudgetLedger({ kind: "finite", maxUsd: 0.1 }, undefined, {
      onCashSettled: (cash, valuation, estimated) =>
        log.emit("budget.cash", {
          cash_spend_usd: cash,
          valuation_usd: valuation,
          estimated,
        }),
    });
    authority = new DelegationBudgetAuthority({
      cancelAdmission: () => {
        setTimeout(() => {
          child.settle(lease.lease_id, {
            knowledge: "exact",
            source: "child-terminal",
            provenance: ["test"],
            cashUsd: 0.2,
          });
          authority.releaseRun("run-child-overshoot");
        }, 5);
      },
    });
    authority.registerParent("run-overshoot", root);
    authority.noteChildAccepted("run-overshoot", "job-child");
    const child = authority.attachChild(
      "run-overshoot",
      "job-child",
      "run-child-overshoot",
      "task-child",
    );
    const lease = child.reserve({
      taskId: "task-child",
      intent: "implement",
      harnessId: "child",
      cost: routeCostEvidence({
        billing: "metered",
        knowledge: "estimated",
        source: "test",
        provenance: ["test"],
        estimatedUsd: 0.05,
      }),
    }).lease!;
    const preparedFacts = makeOutcomeFacts("succeeded", {
      checks: "passed",
      review: "approved",
    });

    const result = await guardAnnouncedRun(
      undefined,
      async (announce) => {
        log.emit("run.created", { mode: "agent", prompt: "x" });
        announce({
          log,
          store,
          paths,
          runId: "run-overshoot",
          taskId: "task-parent",
          mode: "agent",
          phase: "race",
          spend: () => root.spend(),
          valuation: () => root.valuation(),
          spendEstimated: () => root.estimated(),
          budgetTerminal: () => root.terminal(),
          recheckBudgetAfterBarrier: () => true,
        });
        seedPassingGateEvidence({ store, paths, log });
        store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
          winner: "a01",
          facts: preparedFacts,
          why_winner: "strategy completed before child drain",
          budget_summary: {
            spend_usd: 0,
            cash_usd: 0,
            valuation_usd: 0,
            estimated: false,
          },
        });
        store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
          id: "wp-overshoot",
          kind: "patch",
          source_task_id: "task-parent",
          meta: {
            lifecycle: "succeeded",
            outcome_facts: preparedFacts,
            review_verified: true,
            budget_stopped: false,
            adopted: true,
            apply_state: "applied",
            extension_receipt: "preserved",
          },
        });
        store.writeText(join(paths.finalDir, "summary.md"), "prepared success\n");
        log.deferTerminal();
        log.emit("output.ready", { path: "final/summary.md", kind: "summary" });
        log.emit("run.completed", { lifecycle: "succeeded" });
        return {
          runId: "run-overshoot",
          taskId: "task-parent",
          mode: "agent",
          lifecycle: "succeeded",
          facts: preparedFacts,
          winner: "a01",
          runDir: paths.root,
          summary: "done",
          candidates: [{ attemptId: "a01", harnessId: "claude", status: "success" }],
          decisionPath: join(paths.arbitrationDir, "decision.yaml"),
          reviewVerified: true,
        };
      },
      async () => {
        authority.beginParentClose("run-overshoot");
        await authority.waitForChildren("run-overshoot", 1_000);
      },
      () => authority.releaseRun("run-overshoot"),
    );

    expect(result.lifecycle).toBe("failed");
    expect(result.facts.reason).toBe("budget_overshoot");
    expect(result.facts).toMatchObject({ checks: "passed", review: "approved" });
    expect(result.spendUsd).toBeCloseTo(0.2);
    expect(result.winner).toBe("a01");
    expect(result.candidates).toEqual([
      { attemptId: "a01", harnessId: "claude", status: "success" },
    ]);
    expect(result.reviewVerified).toBe(true);
    expect(readFileSync(join(paths.finalDir, "failure.yaml"), "utf8")).toContain(
      "code: budget_overshoot",
    );
    expect(
      store.readYaml<{
        facts: { lifecycle: string; reason: string; checks: string; review: string };
        budget_summary: { spend_usd: number };
      }>(join(paths.arbitrationDir, "decision.yaml")),
    ).toMatchObject({
      facts: {
        lifecycle: "failed",
        reason: "budget_overshoot",
        checks: "passed",
        review: "approved",
      },
      budget_summary: { spend_usd: 0.2 },
    });
    expect(
      store.readYaml<{
        meta: {
          lifecycle: string;
          outcome_facts: { lifecycle: string; reason: string };
          review_verified: boolean;
          budget_stopped: boolean;
          apply_state: string;
          extension_receipt: string;
        };
      }>(join(paths.finalDir, "work_product.yaml")),
    ).toMatchObject({
      meta: {
        lifecycle: "failed",
        outcome_facts: { lifecycle: "failed", reason: "budget_overshoot" },
        review_verified: true,
        budget_stopped: false,
        apply_state: "applied",
        extension_receipt: "preserved",
      },
    });
    const types = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual([
      "run.created",
      "gate.completed",
      "output.ready",
      "budget.cash",
      "output.ready",
      "run.failed",
    ]);
  });

  it("replaces deferred success with one typed failure when child drain times out", async () => {
    const { store, paths, log } = fixture("run-timeout");
    const root = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const lateLease = root.reserve({
      taskId: "task-child-settled",
      intent: "implement",
      harnessId: "child-settled",
      cost: routeCostEvidence({
        billing: "metered",
        knowledge: "estimated",
        source: "test",
        provenance: ["test"],
        estimatedUsd: 0.3,
      }),
    }).lease!;
    const authority = new DelegationBudgetAuthority({ cancelAdmission: () => {} });
    authority.registerParent("run-timeout", root);
    authority.noteChildAccepted("run-timeout", "job-stuck");

    const result = await guardAnnouncedRun(
      undefined,
      async (announce) => {
        log.emit("run.created", { mode: "agent", prompt: "x" });
        announce({
          log,
          store,
          paths,
          runId: "run-timeout",
          taskId: "task-parent",
          mode: "agent",
          phase: "race",
          spend: () => root.spend(),
          valuation: () => root.valuation(),
          spendEstimated: () => root.estimated(),
          valuationKnowledge: () => root.valuationKnowledge(),
          recheckBudgetAfterBarrier: () => true,
        });
        seedPassingGateEvidence({ store, paths, log });
        store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
          winner: "a01",
          facts: makeOutcomeFacts("succeeded"),
          why_winner: "prepared before drain",
          budget_summary: {
            spend_usd: 0,
            cash_usd: 0,
            valuation_usd: 0,
            estimated: false,
          },
        });
        store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
          id: "wp-timeout",
          kind: "patch",
          source_task_id: "task-parent",
          meta: {
            lifecycle: "succeeded",
            outcome_facts: makeOutcomeFacts("succeeded", {
              checks: "passed",
              review: "approved",
            }),
            review_verified: true,
            apply_state: "applied",
            extension_receipt: "preserved",
          },
        });
        log.deferTerminal();
        log.emit("run.completed", { lifecycle: "succeeded" });
        return {
          runId: "run-timeout",
          taskId: "task-parent",
          mode: "agent",
          lifecycle: "succeeded",
          facts: makeOutcomeFacts("succeeded", { checks: "passed", review: "approved" }),
          winner: "a01",
          runDir: paths.root,
          summary: "done",
          candidates: [{ attemptId: "a01", harnessId: "claude", status: "success" }],
          reviewVerified: true,
        };
      },
      async () => {
        root.settle(lateLease.lease_id, {
          knowledge: "exact",
          cashKnowledge: "exact",
          source: "late-child-terminal",
          provenance: ["test"],
          cashUsd: 0.2,
        });
        authority.beginParentClose("run-timeout");
        await authority.waitForChildren("run-timeout", 5);
      },
      () => authority.releaseRun("run-timeout"),
    );

    expect(result.lifecycle).toBe("failed");
    expect(result.winner).toBe("a01");
    expect(result.candidates).toEqual([
      { attemptId: "a01", harnessId: "claude", status: "success" },
    ]);
    expect(result.reviewVerified).toBe(true);
    const types = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["run.created", "gate.completed", "output.ready", "run.failed"]);
    expect(readFileSync(join(paths.finalDir, "failure.yaml"), "utf8")).toContain(
      "code: delegation_child_drain_timeout",
    );
    expect(readFileSync(join(paths.finalDir, "failure.yaml"), "utf8")).toContain(
      "phase: delegation_drain",
    );
    const failedEvent = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> })
      .find((event) => event.type === "run.failed");
    expect(failedEvent?.payload?.["phase"]).toBe("delegation_drain");
    expect(
      store.readYaml<{
        facts: { lifecycle: string; reason: string };
        budget_summary: { spend_usd: number; cash_usd: number };
      }>(join(paths.arbitrationDir, "decision.yaml")),
    ).toMatchObject({
      facts: { lifecycle: "failed", reason: "harness_failed" },
      budget_summary: { spend_usd: 0.2, cash_usd: 0.2 },
    });
    expect(
      store.readYaml<{ meta: Record<string, unknown> }>(join(paths.finalDir, "work_product.yaml")),
    ).toMatchObject({
      meta: {
        lifecycle: "failed",
        outcome_facts: {
          lifecycle: "failed",
          reason: "harness_failed",
          checks: "passed",
          review: "approved",
        },
        review_verified: true,
        apply_state: "applied",
        extension_receipt: "preserved",
      },
    });
  });

  it.each([
    { drain: "resolves after prepared success", rejects: false, preparedFailure: false },
    { drain: "times out after prepared success", rejects: true, preparedFailure: false },
    { drain: "resolves after prepared failure", rejects: false, preparedFailure: true },
  ])(
    "lets cancellation win when the Delegate drain $drain while preserving produced-work facts",
    async ({ rejects, preparedFailure }) => {
      const { store, paths, log } = fixture("run-cancel-during-drain");
      const controller = new AbortController();
      const root = new BudgetLedger({ kind: "finite", maxUsd: 1 });
      const lateLease = root.reserve({
        taskId: "task-child-late",
        intent: "implement",
        harnessId: "child-late",
        cost: routeCostEvidence({
          billing: "metered",
          knowledge: "estimated",
          source: "test",
          provenance: ["test"],
          estimatedUsd: 0.3,
        }),
      }).lease!;
      const preparedFacts = makeOutcomeFacts("succeeded", {
        checks: "passed",
        review: "approved",
      });
      const result = await guardAnnouncedRun(
        controller.signal,
        async (announce) => {
          log.emit("run.created", { mode: "agent", prompt: "x" });
          announce({
            log,
            store,
            paths,
            runId: "run-cancel-during-drain",
            taskId: "task-parent",
            mode: "agent",
            phase: "race",
            spend: () => root.spend(),
            valuation: () => root.valuation(),
            spendEstimated: () => root.estimated(),
            valuationKnowledge: () => root.valuationKnowledge(),
            recheckBudgetAfterBarrier: () => true,
          });
          seedPassingGateEvidence({ store, paths, log });
          store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
            winner: "a01",
            facts: preparedFacts,
            why_winner: "prepared before drain",
            budget_summary: {
              spend_usd: 0,
              cash_usd: 0,
              valuation_usd: 0,
              estimated: false,
            },
          });
          store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
            id: "wp-cancel-during-drain",
            kind: "patch",
            source_task_id: "task-parent",
            meta: {
              lifecycle: "succeeded",
              outcome_facts: preparedFacts,
              review_verified: true,
              apply_state: "applied",
              extension_receipt: "preserved",
            },
          });
          log.deferTerminal();
          const prepared = {
            runId: "run-cancel-during-drain",
            taskId: "task-parent",
            mode: "agent" as const,
            lifecycle: "succeeded" as const,
            facts: preparedFacts,
            winner: "a01",
            runDir: paths.root,
            summary: "done",
            candidates: [{ attemptId: "a01", harnessId: "claude", status: "success" }],
            reviewVerified: true,
          };
          if (preparedFailure) {
            const failed = failTerminally(
              log,
              store,
              paths,
              prepared.runId,
              prepared.taskId,
              prepared.mode,
              "delegation_runtime",
              new Error("belt failed"),
              undefined,
              { priorFacts: preparedFacts },
            );
            return {
              ...prepared,
              ...failed,
              winner: prepared.winner,
              candidates: prepared.candidates,
            };
          }
          log.emit("run.completed", { lifecycle: "succeeded" });
          return prepared;
        },
        async () => {
          root.settle(lateLease.lease_id, {
            knowledge: "exact",
            cashKnowledge: "exact",
            source: "late-child-terminal",
            provenance: ["test"],
            cashUsd: 0.2,
          });
          controller.abort();
          if (rejects) {
            throw Object.assign(new Error("delegation child drain timed out"), {
              code: "delegation_child_drain_timeout",
            });
          }
        },
      );

      expect(result).toMatchObject({
        lifecycle: "cancelled",
        winner: "a01",
        reviewVerified: true,
        candidates: [{ attemptId: "a01", harnessId: "claude", status: "success" }],
        facts: {
          lifecycle: "cancelled",
          reason: "user_cancelled",
          checks: "passed",
          review: "approved",
        },
      });
      expect(
        store.readYaml<{
          facts: Record<string, unknown>;
          budget_summary: { spend_usd: number; cash_usd: number };
        }>(join(paths.arbitrationDir, "decision.yaml")),
      ).toMatchObject({
        facts: {
          lifecycle: "cancelled",
          reason: "user_cancelled",
          checks: "passed",
          review: "approved",
        },
        budget_summary: { spend_usd: 0.2, cash_usd: 0.2 },
      });
      expect(
        store.readYaml<{ meta: Record<string, unknown> }>(
          join(paths.finalDir, "work_product.yaml"),
        ),
      ).toMatchObject({
        meta: {
          lifecycle: "cancelled",
          outcome_facts: {
            lifecycle: "cancelled",
            reason: "user_cancelled",
            checks: "passed",
            review: "approved",
          },
          review_verified: true,
          apply_state: "applied",
          extension_receipt: "preserved",
        },
      });
      const events = readFileSync(paths.eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> });
      expect(events.map((event) => event.type)).toEqual([
        "run.created",
        "gate.completed",
        ...(preparedFailure ? ["output.ready"] : []),
        "output.ready",
        "run.failed",
      ]);
      expect(events.at(-1)?.payload).toMatchObject({
        lifecycle: "cancelled",
        reason: "user_cancelled",
      });
      expect(existsSync(join(paths.finalDir, "failure.yaml"))).toBe(false);
    },
  );

  it("leaves ordinary terminal ordering unchanged when no Delegate barrier is armed", async () => {
    const { store, paths, log } = fixture("run-ordinary");
    await guardAnnouncedRun(undefined, async (announce) => {
      log.emit("run.created", { mode: "agent", prompt: "x" });
      announce({
        log,
        store,
        paths,
        runId: "run-ordinary",
        taskId: "task-parent",
        mode: "agent",
        phase: "race",
      });
      log.emit("output.ready", { path: "final/summary.md", kind: "summary" });
      log.emit("run.completed", { lifecycle: "succeeded" });
      return {
        runId: "run-ordinary",
        taskId: "task-parent",
        mode: "agent",
        lifecycle: "succeeded",
        facts: makeOutcomeFacts("succeeded"),
        winner: null,
        runDir: paths.root,
        summary: "done",
        candidates: [],
      };
    });
    const types = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["run.created", "output.ready", "run.completed"]);
  });

  it("fails closed on a malformed decision without rewriting it or draining delegates", async () => {
    // decision.yaml is canonical terminal evidence: present-but-unreadable
    // bytes fail the terminal loudly (three-state parseArtifact) instead of
    // being silently ignored. The delegation pins stay intact: the malformed
    // file is never rewritten and no delegate drain is attempted.
    const { store, paths, log } = fixture("run-ordinary-malformed-decision");
    const decisionPath = join(paths.arbitrationDir, "decision.yaml");
    const originalDecision = "winner: [malformed\n";
    store.writeText(decisionPath, originalDecision);

    const result = await guardAnnouncedRun(undefined, async (announce) => {
      log.emit("run.created", { mode: "agent", prompt: "x" });
      announce({
        log,
        store,
        paths,
        runId: "run-ordinary-malformed-decision",
        taskId: "task-parent",
        mode: "agent",
        phase: "race",
        spend: () => 0.2,
        recheckBudgetAfterBarrier: () => false,
      });
      log.emit("run.completed", { lifecycle: "succeeded" });
      return {
        runId: "run-ordinary-malformed-decision",
        taskId: "task-parent",
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
    expect(readFileSync(decisionPath, "utf8")).toBe(originalDecision);
    const types = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["run.created", "run.failed"]);
    const terminal = JSON.parse(readFileSync(paths.eventsPath, "utf8").trim().split("\n").at(-1)!) as {
      payload: Record<string, unknown>;
    };
    expect(terminal.payload["phase"]).toBe("terminal_facts");
    expect(String(terminal.payload["error"])).toMatch(/not readable YAML/);
  });

  it("reconciles only terminal truth when an ordinary run fails after a valid decision", async () => {
    const { store, paths, log } = fixture("run-ordinary-failed-decision");
    const decisionPath = join(paths.arbitrationDir, "decision.yaml");
    store.writeYaml(decisionPath, {
      winner: "a01",
      facts: makeOutcomeFacts("succeeded", { checks: "passed", review: "approved" }),
      why_winner: "owned by the ordinary strategy",
      why_not_others: { a02: "lower score" },
      budget_summary: {
        spend_usd: 0.1,
        cash_usd: 0.1,
        valuation_usd: 0,
        estimated: false,
      },
    });
    const result = await guardAnnouncedRun(undefined, async (announce) => {
      log.emit("run.created", { mode: "agent", prompt: "x" });
      announce({
        log,
        store,
        paths,
        runId: "run-ordinary-failed-decision",
        taskId: "task-parent",
        mode: "agent",
        phase: "harness",
        spend: () => 0.2,
        recheckBudgetAfterBarrier: () => false,
      });
      seedPassingGateEvidence({ store, paths, log });
      throw new Error("ordinary harness failed");
    });

    expect(result).toMatchObject({
      lifecycle: "failed",
      facts: {
        lifecycle: "failed",
        reason: "harness_failed",
        checks: "passed",
        review: "approved",
      },
    });
    expect(store.readYaml<Record<string, unknown>>(decisionPath)).toMatchObject({
      winner: "a01",
      facts: {
        lifecycle: "failed",
        reason: "harness_failed",
        checks: "passed",
        review: "approved",
      },
      why_winner: "ordinary harness failed",
      why_not_others: { a02: "lower score" },
      budget_summary: {
        spend_usd: 0.1,
        cash_usd: 0.1,
        valuation_usd: 0,
        estimated: false,
      },
    });
    const types = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["run.created", "gate.completed", "output.ready", "run.failed"]);
  });

  it("reconciles only terminal truth when an ordinary run is cancelled after a valid decision", async () => {
    const { store, paths, log } = fixture("run-ordinary-cancelled-decision");
    const decisionPath = join(paths.arbitrationDir, "decision.yaml");
    store.writeYaml(decisionPath, {
      winner: "a01",
      facts: makeOutcomeFacts("succeeded", { checks: "passed", review: "approved" }),
      why_winner: "owned by the ordinary strategy",
      budget_summary: {
        spend_usd: 0.1,
        cash_usd: 0.1,
        valuation_usd: 0,
        estimated: false,
      },
    });
    const controller = new AbortController();

    const result = await guardAnnouncedRun(controller.signal, async (announce) => {
      log.emit("run.created", { mode: "agent", prompt: "x" });
      announce({
        log,
        store,
        paths,
        runId: "run-ordinary-cancelled-decision",
        taskId: "task-parent",
        mode: "agent",
        phase: "harness",
        spend: () => 0.2,
        recheckBudgetAfterBarrier: () => false,
      });
      seedPassingGateEvidence({ store, paths, log });
      controller.abort();
      throw new Error("ordinary harness observed cancellation");
    });

    expect(result).toMatchObject({
      lifecycle: "cancelled",
      facts: {
        lifecycle: "cancelled",
        reason: "user_cancelled",
        checks: "passed",
        review: "approved",
      },
    });
    expect(store.readYaml<Record<string, unknown>>(decisionPath)).toMatchObject({
      winner: "a01",
      facts: {
        lifecycle: "cancelled",
        reason: "user_cancelled",
        checks: "passed",
        review: "approved",
      },
      why_winner: "run cancelled",
      budget_summary: {
        spend_usd: 0.1,
        cash_usd: 0.1,
        valuation_usd: 0,
        estimated: false,
      },
    });
    const types = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["run.created", "gate.completed", "output.ready", "run.failed"]);
  });

  it("does not re-terminalize an ordinary non-deferred budget failure", async () => {
    const { store, paths, log } = fixture("run-ordinary-budget");
    const result = await guardAnnouncedRun(undefined, async (announce) => {
      log.emit("run.created", { mode: "agent", prompt: "x" });
      announce({
        log,
        store,
        paths,
        runId: "run-ordinary-budget",
        taskId: "task-parent",
        mode: "agent",
        phase: "budget",
        spend: () => 0.2,
        budgetTerminal: () => "budget_overshoot",
      });
      const facts = makeOutcomeFacts("failed", { reason: "budget_overshoot" });
      log.emit("run.failed", { lifecycle: "failed", facts, reason: facts.reason });
      return {
        runId: "run-ordinary-budget",
        taskId: "task-parent",
        mode: "agent",
        lifecycle: "failed",
        facts,
        winner: null,
        runDir: paths.root,
        summary: "already terminal",
        candidates: [],
        spendUsd: 0.2,
      };
    });
    expect(result.lifecycle).toBe("failed");
    const types = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["run.created", "run.failed"]);
  });

  it("does not mask a deferred Delegate failure with a late budget terminal", async () => {
    const { store, paths, log } = fixture("run-delegate-failed");
    const result = await guardAnnouncedRun(
      undefined,
      async (announce) => {
        log.emit("run.created", { mode: "agent", prompt: "x" });
        announce({
          log,
          store,
          paths,
          runId: "run-delegate-failed",
          taskId: "task-parent",
          mode: "agent",
          phase: "harness",
          spend: () => 0.2,
          budgetTerminal: () => "budget_overshoot",
          recheckBudgetAfterBarrier: () => true,
        });
        log.deferTerminal();
        const facts = makeOutcomeFacts("failed", { reason: "harness_failed" });
        log.emit("run.failed", { lifecycle: "failed", facts, reason: facts.reason });
        return {
          runId: "run-delegate-failed",
          taskId: "task-parent",
          mode: "agent",
          lifecycle: "failed",
          facts,
          winner: "a01",
          runDir: paths.root,
          summary: "harness failed first",
          candidates: [{ attemptId: "a01", harnessId: "claude", status: "failed" }],
        };
      },
      async () => {},
    );
    expect(result.facts.reason).toBe("harness_failed");
    expect(result.winner).toBe("a01");
    const types = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["run.created", "run.failed"]);
  });
});
