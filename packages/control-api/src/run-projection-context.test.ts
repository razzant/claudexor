import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  ControlBudgetSnapshot,
  ControlRunDetail,
  RunFacts,
  RunTelemetry,
  SCHEMA_VERSION,
  TaskContract,
  requiredActionsFor,
  validateRunFactsInvariants,
} from "@claudexor/schema";
import { sha256 } from "@claudexor/util";
import { projectBulkJob } from "./bulk-worker.js";
import { inRunProjection } from "./projection-context.js";
import { readRawTextArtifact, safeReadStructuredArtifact } from "./run-artifact-read.js";
import { runPatchDigest } from "./run-exact-patch.js";
import { runRepoRoot } from "./run-apply-projection.js";
import { readFilesWorkProduct } from "./files-work-product.js";
import { effectiveTerminalFacts, expectedRunFacts } from "./run-facts-projection.js";
import { budgetSnapshot } from "./run-budget-snapshot.js";
import { detailFor, summarizeRun } from "./run-projection.js";
import type { DaemonRunRecord } from "./run-record.js";
import { eventsParseCountForTests, resetEventsParseCountForTests } from "./run-timeline.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), openSync: vi.fn(actual.openSync) };
});

const roots: string[] = [];
const timestamp = "2026-10-27T00:00:00.000Z";
const planItems = [{ id: "p1", title: "An early plan remains visible", status: "completed" }];

function fixture(id: string, spend = 3.25) {
  const runDir = mkdtempSync(join(tmpdir(), "claudexor-projection-context-"));
  roots.push(runDir);
  for (const directory of ["context", "final"]) mkdirSync(join(runDir, directory));
  const record: DaemonRunRecord = {
    id: `job-${id}`,
    runId: `run-${id}`,
    taskId: `task-${id}`,
    state: "succeeded",
    runDir,
    params: {
      mode: "ask",
      scope: { kind: "project", root: runDir },
      prompt: "fixture",
      review: false,
    },
  };
  const task = TaskContract.parse({
    schema_version: SCHEMA_VERSION,
    task_id: record.taskId,
    created_at: timestamp,
    repo: { root: runDir, base_ref: "HEAD" },
    mode: { kind: "ask" },
    user_intent: { raw: "fixture" },
    tests: { commands: [] },
    budget: { paid_budget: { kind: "finite", maxUsd: 10 } },
  });
  const telemetry = RunTelemetry.parse({
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
    usage_totals: { input_tokens: 123, output_tokens: 45 },
    generated_at: timestamp,
  });
  const outcome = {
    lifecycle: "succeeded" as const,
    noChanges: true,
    checks: "not_configured" as const,
    review: "not_run" as const,
    review_requested: false,
    reason: null,
  };
  const facts = validateRunFactsInvariants({
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
          harness_id: "fixture",
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
    generated_at: timestamp,
  });
  writeFileSync(join(runDir, "context/task.yaml"), stringifyYaml(task));
  writeFileSync(join(runDir, "final/telemetry.yaml"), stringifyYaml(telemetry));
  writeFileSync(join(runDir, "final/run_facts.yaml"), stringifyYaml(facts));
  writeFileSync(join(runDir, "final/answer.md"), `Answer for ${id}.\n`);
  const events: Record<string, unknown>[] = [
    {
      type: "budget.cash",
      payload: {
        cash_spend_usd: spend,
        cash_knowledge: "exact",
        valuation_usd: 8.5,
        valuation_knowledge: "estimated",
        estimated: false,
      },
    },
    { type: "plan.progress", payload: { items: planItems } },
    ...Array.from({ length: 750 }, (_, index) => ({
      type: "harness.event",
      payload: { text: `progress ${index}` },
    })),
  ].map((event, index) => ({ ...event, seq: index + 1 }));
  writeEvents(record, events);
  return { record, events, telemetry };
}

function writeEvents(record: DaemonRunRecord, events: Record<string, unknown>[]): void {
  writeFileSync(
    join(record.runDir!, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
}

function readCount(record: DaemonRunRecord, relativePath: string): number {
  const path = realpathSync(join(record.runDir!, relativePath));
  return vi.mocked(readFileSync).mock.calls.filter(([name]) => name === path).length;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("one request context for complete run projection", () => {
  it.each([true, false])(
    "keeps bounded artifact refusals distinct from complete reads (full first=%s)",
    (fullFirst) => {
      const { record, events } = fixture("read-policies");
      writeFileSync(join(record.runDir!, "final/patch.diff"), "diff --git a/x b/x\n".repeat(10));
      writeFileSync(
        join(record.runDir!, "final/work_product.yaml"),
        JSON.stringify({ id: "wp", source_task_id: record.taskId, kind: "report", meta: {} }),
      );
      const fromTask = { ...record, params: {} };
      const readers = [
        (maxBytes?: number) => readRawTextArtifact(record, "context/task.yaml", maxBytes),
        (maxBytes?: number) =>
          safeReadStructuredArtifact(record, "context/task.yaml", TaskContract, maxBytes),
        (maxBytes?: number) => runRepoRoot(fromTask, maxBytes),
        (maxBytes?: number) => readFilesWorkProduct(record, maxBytes),
        (maxBytes?: number) => runPatchDigest(record, record.runDir!, maxBytes),
        (maxBytes?: number) =>
          effectiveTerminalFacts(record.runDir, null, null, expectedRunFacts(record), maxBytes),
        (maxBytes?: number) => budgetSnapshot(record, null, events, undefined, maxBytes),
      ];
      const expected = readers.map((read) => read());
      inRunProjection(() => {
        for (const [index, read] of readers.entries()) {
          const full = () => expect(read()).toEqual(expected[index]);
          const bounded = () =>
            expect(() => read(16)).toThrow(
              expect.objectContaining({ status: 503, code: "artifact_read_limit" }),
            );
          if (fullFirst) full();
          else bounded();
          full();
          bounded();
          expect(read(1024 * 1024)).toEqual(expected[index]);
        }
      });
    },
  );

  it("parses events, budget, telemetry, task and run facts once and opens the primary output once", () => {
    const { record, events } = fixture("once");
    const task = vi.spyOn(TaskContract, "parse");
    const telemetry = vi.spyOn(RunTelemetry, "parse");
    const facts = vi.spyOn(RunFacts, "parse");
    const budget = vi.spyOn(ControlBudgetSnapshot, "parse");
    resetEventsParseCountForTests();
    const detail = inRunProjection(() => {
      const result = detailFor(record, [], events.length);
      expect(summarizeRun(record).spendUsd).toBe(result.budget.spendUsd);
      return result;
    });
    expect(eventsParseCountForTests()).toBe(1);
    for (const parser of [task, telemetry, facts, budget]) expect(parser).toHaveBeenCalledTimes(1);
    for (const path of ["context/task.yaml", "final/telemetry.yaml", "final/run_facts.yaml"])
      expect(readCount(record, path), path).toBe(1);
    const answerPath = realpathSync(join(record.runDir!, "final/answer.md"));
    expect(vi.mocked(openSync).mock.calls.filter(([path]) => path === answerPath)).toHaveLength(1);
    expect(detail.summary).toMatchObject({
      inputTokens: 123,
      outputTokens: 45,
      outputReadyState: "ready",
    });
    expect(detail.primaryOutput?.text).toBe("Answer for once.\n");
    expect(detail.runFacts?.run_id).toBe(record.runId);
  });

  it("keeps cash, valuation and plan before the display tail; truncating fold input loses them", () => {
    const { record, events } = fixture("prefix");
    const detail = inRunProjection(() => detailFor(record, [], events.length));
    expect(detail.timeline).toHaveLength(501);
    expect(detail.timeline[0]?.title).toBe("252 earlier event(s) omitted from this projection");
    expect(detail.timeline.slice(1).every((row) => row.type === "harness.event")).toBe(true);
    expect(detail.budget).toMatchObject({
      spendUsd: 3.25,
      valuationUsd: 8.5,
      valuationKnowledge: "estimated",
      estimated: false,
      remainingUsd: 6.75,
      evidence: "complete",
    });
    expect(detail.planProgress?.items).toEqual(planItems);
    writeEvents(record, events.slice(-500));
    const wrong = inRunProjection(() => detailFor(record, [], events.length));
    expect(wrong.budget.spendUsd).toBeNull();
    expect(wrong.budget.valuationUsd).toBeNull();
    expect(wrong.planProgress).toBeNull();
  });

  it("keeps one scope stable and reads new evidence in the next request", () => {
    const { record, events, telemetry } = fixture("fresh");
    inRunProjection(() => {
      expect(detailFor(record, [], events.length).summary.inputTokens).toBe(123);
      writeFileSync(
        join(record.runDir!, "final/telemetry.yaml"),
        stringifyYaml({
          ...telemetry,
          usage_totals: { ...telemetry.usage_totals, input_tokens: 999 },
        }),
      );
      appendFileSync(
        join(record.runDir!, "events.jsonl"),
        JSON.stringify({
          seq: events.length + 1,
          type: "budget.cash",
          payload: { cash_spend_usd: 4.5 },
        }) + "\n",
      );
      expect(summarizeRun(record)).toMatchObject({ inputTokens: 123, spendUsd: 3.25 });
    });
    expect(inRunProjection(() => summarizeRun(record))).toMatchObject({
      inputTokens: 999,
      spendUsd: 4.5,
    });
  });

  it("uses distinct child snapshots within the detail job and retains the captured cursor", async () => {
    const parent = fixture("parent", 3.25);
    const child = fixture("child", 1.5);
    const publish = vi.fn(async () => null);
    resetEventsParseCountForTests();
    const result = await projectBulkJob(
      {
        kind: "detail",
        input: {
          record: parent.record,
          cursor: parent.events.length - 1,
          pending: [],
          operator: null,
          children: [{ record: child.record, pending: true }],
        },
      },
      publish,
    );
    const detail = ControlRunDetail.parse(JSON.parse(result as string));
    expect(eventsParseCountForTests()).toBe(2);
    expect(detail.summary.spendUsd).toBe(3.25);
    expect(detail.children).toMatchObject([
      { runId: child.record.runId, spendUsd: 1.5, waitingOnUser: true },
    ]);
    expect(detail.lastSeq).toBe(parent.events.length - 1);
    expect(detail.timeline.at(-1)?.title).toBe("progress 749");
    for (const record of [parent.record, child.record])
      for (const path of ["context/task.yaml", "final/telemetry.yaml", "final/run_facts.yaml"])
        expect(readCount(record, path), `${record.id}:${path}`).toBe(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("shares exact patch bytes with the digest and reads them fresh after the request", () => {
    const { record, events } = fixture("digest");
    const path = join(record.runDir!, "final/patch.diff");
    const patch = "diff --git a/x b/x\n";
    writeFileSync(path, patch);
    inRunProjection(() => {
      expect(runPatchDigest(record, record.runDir!)).toBe(sha256(patch));
      detailFor(record, [], events.length);
      writeFileSync(path, `${patch}changed\n`);
      expect(runPatchDigest(record, record.runDir!)).toBe(sha256(patch));
      expect(readRawTextArtifact(record, "final/patch.diff")).toBe(patch);
      expect(readCount(record, "final/patch.diff")).toBe(1);
    });
    expect(runPatchDigest(record, record.runDir!)).toBe(sha256(`${patch}changed\n`));
  });
});
