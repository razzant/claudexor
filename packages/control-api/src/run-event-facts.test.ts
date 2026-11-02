import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  ControlRunDetail,
  DecisionRecord,
  RunTelemetry,
  SCHEMA_VERSION,
  TaskContract,
  makeOutcomeFacts,
  requiredActionsFor,
  validateRunFactsInvariants,
} from "@claudexor/schema";
import { projectBulkJob } from "./bulk-worker.js";
import { retainedRunEventFactsForTests } from "./run-event-facts.js";
import { detailFor } from "./run-projection.js";
import type { DaemonRunRecord } from "./run-record.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const at = "2026-10-29T00:00:00.000Z";
const receipt = {
  tryIndex: 0,
  attemptId: "a01",
  carrier: "native",
  cause: "pool_exhausted",
  from: { runId: "run-p", attemptId: "a01", profileId: "claude-a" },
  to: { profileId: "claude-a" },
  workspace: "same_root",
  memory: "full",
  instructions: "as_sent",
  reingestedTokens: 1200,
  observedModel: "claude-opus-5-5",
  modelMismatch: false,
  identityCheck: "matched_before_effects",
  inputDelivery: "confirmed",
};

function run(id: string) {
  const runDir = mkdtempSync(join(tmpdir(), "claudexor-event-facts-"));
  roots.push(runDir);
  for (const dir of ["context", "final", "arbitration", "reviews"]) mkdirSync(join(runDir, dir));
  const record: DaemonRunRecord = {
    id: `job-${id}`,
    runId: `run-${id}`,
    taskId: `task-${id}`,
    state: "succeeded",
    runDir,
    params: { mode: "ask", scope: { kind: "project", root: runDir }, prompt: "facts" },
  };
  const write = (rel: string, value: unknown) =>
    writeFileSync(join(runDir, rel), typeof value === "string" ? value : stringifyYaml(value));
  const task = (maxUsd: number) =>
    write(
      "context/task.yaml",
      TaskContract.parse({
        schema_version: SCHEMA_VERSION,
        task_id: record.taskId,
        created_at: at,
        repo: { root: runDir, base_ref: "HEAD" },
        mode: { kind: "ask" },
        user_intent: { raw: "facts" },
        tests: { commands: [] },
        budget: { paid_budget: { kind: "finite", maxUsd } },
      }),
    );
  const telemetry = (input_tokens: number) =>
    write(
      "final/telemetry.yaml",
      RunTelemetry.parse({
        schema_version: SCHEMA_VERSION,
        run_id: record.runId,
        task_id: record.taskId,
        mode: "ask",
        requested_access: "external_sandbox_full",
        effective_access: "external_sandbox_full",
        external_context_policy: "auto",
        effective_web_mode: "auto",
        web: {
          required: false,
          policy: "auto",
          effective_mode: "auto",
          attempted: false,
          satisfied: false,
          status: "none",
          tool: null,
          target: null,
          error_summary: null,
        },
        usage_totals: { input_tokens, output_tokens: 5 },
        generated_at: at,
      }),
    );
  const winner = (attempt: string) =>
    write(
      "arbitration/decision.yaml",
      DecisionRecord.parse({ winner: attempt, facts: makeOutcomeFacts("succeeded") }),
    );
  const outcome = {
    lifecycle: "succeeded" as const,
    noChanges: true,
    checks: "not_configured" as const,
    review: "not_run" as const,
    review_requested: false,
    reason: null,
  };
  write(
    "final/run_facts.yaml",
    validateRunFactsInvariants({
      schema_version: SCHEMA_VERSION,
      run_id: record.runId,
      task_id: record.taskId,
      mode: "ask",
      outcome,
      deliverable: {
        present: true,
        kind: "answer",
        path: "final/answer.md",
        producer_attempt_id: "a01",
      },
      presentation: { state: "ready", primary: { kind: "answer", path: "final/answer.md" } },
      participants: {
        planners: 0,
        attempts: [
          {
            attempt_id: "a01",
            harness_id: "codex",
            role: "candidate",
            deliverable_present: true,
            status: "success",
          },
        ],
      },
      gates: { configured: false, required: 0, total: 0, executed: false, state: "not_configured" },
      review: { state: "not_run", blockers: 0, blocker_ids: [] },
      apply: { eligibility: null, operator_decision_present: false },
      required_actions: requiredActionsFor(outcome, false),
      generated_at: at,
    }),
  );
  task(10);
  telemetry(100);
  winner("a01");
  write("final/answer.md", "Answer one.\n");
  let seq = 0;
  const line = (type: string, payload: Record<string, unknown>, end = "\n") =>
    `${JSON.stringify({ seq: ++seq, ts: at, run_id: record.runId, type, payload })}${end}`;
  const deltas = (count: number) =>
    Array.from({ length: count }, () =>
      line("harness.event", {
        harness_id: "codex",
        attempt_id: "a01",
        type: "message",
        text: `d${seq}`,
        payload: { delta: true },
      }),
    ).join("");
  const plan = (attempt: string, title: string, end?: string) =>
    line(
      "plan.progress",
      { attempt_id: attempt, items: [{ id: "p", title, status: "in_progress" }] },
      end,
    );
  const path = join(runDir, "events.jsonl");
  return {
    record,
    runDir,
    path,
    write,
    task,
    telemetry,
    winner,
    line,
    deltas,
    plan,
    reset: () => (seq = 0),
  };
}

/** The worker's detail job keeps folded facts; a projection outside any scope folds afresh. */
async function bothLanes(record: DaemonRunRecord): Promise<ControlRunDetail> {
  const kept = (await projectBulkJob(
    { kind: "detail", input: { record, cursor: 7, pending: [], operator: null, children: [] } },
    async () => null,
  )) as string;
  expect(kept).toBe(JSON.stringify(detailFor(record, [], 7)));
  return ControlRunDetail.parse(JSON.parse(kept));
}

describe("folded run event facts at the detail job", () => {
  it("equals a fresh complete fold across appends, pending/torn lines, winners, artifacts and replacement", async () => {
    const r = run("eq");
    const buffered = () =>
      r.line("harness.event", {
        harness_id: "cursor",
        type: "message",
        text: "b",
        payload: { buffered: true },
      });
    writeFileSync(
      r.path,
      r.plan("a01", "A one") +
        r.plan("a02", "B one") +
        // Legacy ledger: estimated exact zero with a positive valuation.
        r.line("budget.cash", { cash_spend_usd: 0, estimated: true, valuation_usd: 0.5 }) +
        r.line("run.continuity", { harness_id: "claude", receipt }) +
        r.line("budget.observation", { kind: "spend", usd: 0.25, estimated: true }) +
        r.line("harness.event", { harness_id: "codex", type: "usage", usage: { cost_usd: 0.1 } }) +
        r.deltas(600) +
        buffered() +
        buffered(),
    );
    let d = await bothLanes(r.record);
    expect(d.timeline[0]?.title).toBe("106 earlier event(s) omitted from this projection");
    expect(d.budget).toMatchObject({
      spendUsd: 0,
      estimated: false,
      valuationUsd: 0.5,
      valuationKnowledge: "estimated",
      remainingUsd: 10,
      evidence: "complete",
    });
    expect(d.planProgress?.items[0]?.title).toBe("A one");
    expect(d.summary.continuity).toHaveLength(1);
    const runsAfterFirst = retainedRunEventFactsForTests().runs;
    expect(runsAfterFirst).toBeGreaterThan(0);

    // Unchanged log, then a component-aware ledger receipt appended.
    expect(await bothLanes(r.record)).toEqual(d);
    appendFileSync(
      r.path,
      r.line("budget.cash", {
        cash_spend_usd: 1.5,
        estimated: false,
        cash_knowledge: "exact",
        controllable_cash_knowledge: "exact",
        valuation_usd: 2,
        valuation_knowledge: "exact",
      }) + r.deltas(10),
    );
    d = await bothLanes(r.record);
    expect(d.budget).toMatchObject({
      spendUsd: 1.5,
      estimated: false,
      cashKnowledge: "exact",
      valuationUsd: 2,
      valuationKnowledge: "exact",
      remainingUsd: 8.5,
    });

    // A final record without its newline counts now, and exactly once later.
    appendFileSync(r.path, r.plan("a01", "A two", ""));
    d = await bothLanes(r.record);
    expect(d.planProgress?.items[0]?.title).toBe("A two");
    const pendingRows = d.timeline.length;
    appendFileSync(r.path, `\n${r.deltas(1)}`);
    d = await bothLanes(r.record);
    expect(d.planProgress?.items[0]?.title).toBe("A two");
    expect(d.timeline.length).toBe(pendingRows);
    expect(d.timeline[0]?.title).toBe("119 earlier event(s) omitted from this projection");

    // A torn last line is disclosed for this answer only.
    appendFileSync(r.path, '{"seq":');
    d = await bothLanes(r.record);
    expect(d.timeline[0]?.type).toBe("timeline.evidence_incomplete");
    expect(d.budget.evidence).toBe("incomplete");
    appendFileSync(r.path, `${9_999},"type":"harness.event","payload":{}}\n`);
    d = await bothLanes(r.record);
    expect(d.timeline[0]?.type).toBe("timeline.truncated");
    expect(d.budget.evidence).toBe("complete");

    // Corrupt complete lines stay counted.
    appendFileSync(r.path, "{oops\n[1,2]\n" + r.deltas(1));
    d = await bothLanes(r.record);
    expect(d.timeline[0]?.title).toBe("2 malformed run event line(s) omitted from this projection");

    // Unchanged log, changed winner and artifacts: all read fresh.
    r.winner("a02");
    r.telemetry(999);
    r.task(20);
    r.write("final/answer.md", "Answer two.\n");
    r.write("reviews/r1.yaml", {
      findings: [
        {
          id: "f1",
          severity: "FIX_FIRST",
          category: "correctness",
          claim: "c",
          reviewer: { harness_id: "codex" },
        },
      ],
    });
    d = await bothLanes(r.record);
    expect(d.planProgress?.items[0]?.title).toBe("B one");
    expect(d.summary.inputTokens).toBe(999);
    expect(d.budget.remainingUsd).toBe(18.5);
    expect(d.primaryOutput?.text).toBe("Answer two.\n");
    expect(d.reviewFindings.map((f) => f.id)).toEqual(["f1"]);

    // Truncated in place, then rewritten longer in place, then replaced.
    r.reset();
    writeFileSync(r.path, r.plan("a02", "T") + r.line("budget.cash", { cash_spend_usd: 3 }));
    d = await bothLanes(r.record);
    expect(d.budget.spendUsd).toBe(3);
    expect(d.planProgress?.items[0]?.title).toBe("T");
    expect(d.summary.continuity).toEqual([]);
    r.reset();
    writeFileSync(r.path, r.line("budget.cash", { cash_spend_usd: 4 }) + r.deltas(50));
    d = await bothLanes(r.record);
    expect(d.budget.spendUsd).toBe(4);
    expect(d.planProgress).toBeNull();
    r.reset();
    writeFileSync(`${r.path}.next`, r.line("budget.cash", { cash_spend_usd: 5 }) + r.deltas(5));
    renameSync(`${r.path}.next`, r.path);
    d = await bothLanes(r.record);
    expect(d.budget.spendUsd).toBe(5);

    // Absent, then present again.
    unlinkSync(r.path);
    d = await bothLanes(r.record);
    expect(d.timeline).toEqual([]);
    expect(d.budget.spendUsd).toBeNull();
    r.reset();
    writeFileSync(r.path, r.line("budget.cash", { cash_spend_usd: 6 }));
    expect((await bothLanes(r.record)).budget.spendUsd).toBe(6);
  });

  describe("a reported zero is evidence, never an exact total before settlement (#171)", () => {
    type Fixture = ReturnType<typeof run>;
    /** One lane spend row for a reported zero of the given meaning. */
    const zeroRow = (r: Fixture, attempt: string, amountKind: string, estimated = false) =>
      r.line("budget.observation", {
        harness_id: "raw-api",
        attempt_id: attempt,
        kind: "spend",
        usd: 0,
        estimated,
        amount_kind: amountKind,
      });
    /** The usage event the row discloses, journaled just before it. */
    const usageZero = (r: Fixture, attempt: string) =>
      r.line("harness.event", {
        harness_id: "raw-api",
        attempt_id: attempt,
        type: "usage",
        usage: { cost_usd: 0 },
      });
    const settle = (r: Fixture, cash: "exact" | "unknown", valuation: "exact" | "unknown") =>
      r.line("budget.cash", {
        cash_spend_usd: 0,
        valuation_usd: 0,
        estimated: cash !== "exact",
        valuation_knowledge: valuation,
        cash_knowledge: cash,
        controllable_cash_knowledge: cash,
      });
    /** The pre-#171 reading of a zero usage report: an estimate with its derived headroom. */
    const ESTIMATE = {
      spendUsd: 0,
      estimated: true,
      remainingUsd: 10,
      valuationUsd: null,
      valuationKnowledge: "unknown",
    };

    it.each([
      ["a cash zero", [["a01", "cash"]]],
      ["a valuation zero", [["a01", "valuation"]]],
      [
        "an unknown zero, then a valuation zero",
        [
          ["a01", "unknown"],
          ["a01", "valuation"],
        ],
      ],
      [
        "a valuation zero, then an unknown zero",
        [
          ["a01", "valuation"],
          ["a01", "unknown"],
        ],
      ],
      [
        "two attempts' zeros",
        [
          ["a01", "cash"],
          ["a02", "valuation"],
        ],
      ],
    ] as const)("%s reads as the usage estimate after every append", async (name, rows) => {
      const r = run(`estimate-${name.replace(/[^a-z0-9]+/g, "-")}`);
      writeFileSync(r.path, "");
      for (const [attempt, kind] of rows) {
        appendFileSync(r.path, usageZero(r, attempt) + zeroRow(r, attempt, kind));
        const detail = await bothLanes(r.record);
        expect(detail.budget).toMatchObject(ESTIMATE);
        expect(detail.budget.cashKnowledge).toBeUndefined();
      }
    });

    it("then reads a clean settlement's exact $0 cash and valuation, which a later zero leaves alone", async () => {
      const r = run("clean-zero");
      writeFileSync(r.path, usageZero(r, "a01") + zeroRow(r, "a01", "valuation"));
      expect((await bothLanes(r.record)).budget).toMatchObject(ESTIMATE);

      appendFileSync(r.path, settle(r, "exact", "exact"));
      const settled = {
        cashKnowledge: "exact",
        spendUsd: 0,
        estimated: false,
        remainingUsd: 10,
        valuationUsd: 0,
        valuationKnowledge: "exact",
      };
      expect((await bothLanes(r.record)).budget).toMatchObject(settled);

      // After a settlement the ledger's latest disclosure governs, as before #171.
      appendFileSync(r.path, usageZero(r, "a02") + zeroRow(r, "a02", "cash"));
      expect((await bothLanes(r.record)).budget).toMatchObject(settled);
    });

    it("then reads a settlement that found an unpriced try as unknown", async () => {
      const r = run("unknown-zero");
      writeFileSync(r.path, usageZero(r, "a01") + zeroRow(r, "a01", "cash"));
      expect((await bothLanes(r.record)).budget).toMatchObject(ESTIMATE);

      appendFileSync(r.path, settle(r, "unknown", "unknown"));
      expect((await bothLanes(r.record)).budget).toMatchObject({
        cashKnowledge: "unknown",
        spendUsd: null,
        estimated: true,
        remainingUsd: null,
        valuationUsd: null,
        valuationKnowledge: "unknown",
      });
    });

    it("leaves a positive amount's legacy estimate untouched beside zero rows", async () => {
      const r = run("positive-beside-zero");
      writeFileSync(
        r.path,
        zeroRow(r, "a01", "cash") +
          r.line("budget.observation", {
            harness_id: "raw-api",
            attempt_id: "a02",
            kind: "spend",
            usd: 0.25,
            estimated: false,
            amount_kind: "cash",
          }) +
          zeroRow(r, "a03", "valuation"),
      );
      expect((await bothLanes(r.record)).budget).toMatchObject({
        spendUsd: 0.25,
        estimated: true,
        remainingUsd: 9.75,
        valuationUsd: 0.25,
        valuationKnowledge: "estimated",
      });
    });
  });

  it("keeps nothing outside a projection and bounds what the worker keeps", async () => {
    const before = retainedRunEventFactsForTests();
    const outside = run("outside");
    writeFileSync(outside.path, outside.deltas(20));
    detailFor(outside.record, [], 0);
    expect(retainedRunEventFactsForTests()).toEqual(before);

    // A run whose kept rows exceed its share is answered by a full fold each time.
    const big = run("big");
    const text = "x".repeat(20_000);
    writeFileSync(
      big.path,
      Array.from({ length: 520 }, () =>
        big.line("harness.event", { harness_id: "codex", type: "message", text }),
      ).join(""),
    );
    await bothLanes(big.record);
    await bothLanes(big.record);
    expect(retainedRunEventFactsForTests().runs).toBe(before.runs);

    // More runs than the bound: the oldest are retired, answers stay exact.
    for (let i = 0; i < 40; i++) {
      const small = run(`small-${i}`);
      writeFileSync(small.path, small.line("budget.cash", { cash_spend_usd: i }));
      expect((await bothLanes(small.record)).budget.spendUsd).toBe(i);
    }
    const bounded = retainedRunEventFactsForTests();
    expect(bounded.runs).toBe(32);
    expect(bounded.bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
