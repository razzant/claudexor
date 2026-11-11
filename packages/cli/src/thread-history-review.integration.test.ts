import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@claudexor/util";
import {
  ThreadPromptPart,
  ThreadHistoryPage,
  ControlThreadDetail,
  THREAD_HISTORY_FACT_BYTES,
  THREAD_HISTORY_FAILURE_BYTES,
  validateRunFactsInvariants,
  SCHEMA_VERSION,
  makeOutcomeFacts,
  requiredActionsFor,
} from "@claudexor/schema";
import { DaemonControlApiServer, type DaemonFacadeClient } from "@claudexor/control-api";
import {
  applyEligibilityFor,
  validRunOperatorDecision,
} from "../../control-api/src/run-apply-projection.js";
import { readFailure } from "../../control-api/src/run-card-facts.js";
import { historyReviewFixture } from "./test-support/history-review-fixture.js";

afterEach(() => vi.restoreAllMocks());
const now = Date.parse("2026-10-26T12:00:00.000Z");
const old = "2026-08-01T10:00:00.000Z";
const month = 30 * 24 * 60 * 60 * 1000;

describe("history review regressions", () => {
  it.each([1, 2])(
    "keeps a page, its pruned row %s and head readable after the real default pruner",
    async (index) => {
      const f = await historyReviewFixture(["first", "middle", "last", "runless"]);
      const records = [
        f.command(0),
        f.command(1, "succeeded", index === 1 ? old : undefined),
        f.command(2, "succeeded", index === 2 ? old : undefined),
      ];
      // The real age AND cap policy: 501 terminal commands, just one expired.
      for (let i = 4; i <= 501; i++) f.command(i);
      const target = records[index]!;
      writeFileSync(join(target.runDir, "final/answer.md"), "still on disk");
      const before = f.read();
      expect(before.turns[index]?.primaryOutput?.text).toBe("still on disk");
      const pruner = f.graph.pruner;
      expect(pruner.pruneHistory(500, month, now)).toEqual([target.id]);
      expect(existsSync(join(target.runDir, "final/answer.md"))).toBe(true);
      expect(f.graph.commands.queries.publicList({ ids: [target.runId] })).toEqual([]);
      const page = f.read();
      expect(page.turns).toHaveLength(4);
      expect(page.turns[index]).toMatchObject({
        runId: target.runId,
        run: null,
        runStatus: "not_retained",
        primaryOutput: null,
        primaryOutputStatus: "not_retained",
      });
      expect(page.turns[3]).toMatchObject({
        runId: null,
        run: null,
        runStatus: "unbound",
        primaryOutput: null,
        primaryOutputStatus: "none",
      });
      expect(page.turns[0]).toMatchObject({ runStatus: "available", run: { state: "succeeded" } });
      expect(page.revision.sequence).toBeGreaterThan(before.revision.sequence);
      expect(page.header).toMatchObject(
        index === 2
          ? { headRun: null, headRunStatus: "not_retained", thread: { headRunId: target.runId } }
          : { headRunStatus: "available", headRun: { runId: "run-2" } },
      );
      const daemon: DaemonFacadeClient = {
        enqueue: async () => {
          throw new Error("read-only fixture");
        },
        status: async () => {
          throw new Error("no status mutation");
        },
        cancel: async () => {
          throw new Error("no cancel mutation");
        },
        list: async (filter) => f.graph.commands.queries.publicList(filter),
      };
      const server = new DaemonControlApiServer({
        token: "fixture",
        daemon,
        threadHistoryReads: f.reads,
        services: {
          threadDetail: async (id) => ({
            thread: f.graph.threads.getThread(id)!,
            turns: f.graph.threads.turnsFor(id),
            sessions: f.graph.threads.sessionsForThread(id),
          }),
        },
      });
      try {
        const { host, port } = await server.start();
        const get = (suffix: string) =>
          fetch(`http://${host}:${port}/v2/threads/${f.thread.id}${suffix}`, {
            headers: { authorization: "Bearer fixture", "X-Claudexor-Protocol-Major": "3" },
            signal: AbortSignal.timeout(5000),
          });
        const historyResponse = await get("/history");
        expect(historyResponse.status).toBe(200);
        expect(ThreadHistoryPage.parse(await historyResponse.json()).turns[index]?.runStatus).toBe(
          "not_retained",
        );
        const legacyResponse = await get("");
        expect(legacyResponse.status).toBe(200);
        const legacy = ControlThreadDetail.parse(await legacyResponse.json());
        expect(legacy.turns).toHaveLength(4);
        expect(legacy.turns[index]).toMatchObject({
          id: f.turns[index]!.id,
          runId: target.runId,
          run: null,
          prompt: f.turns[index]!.prompt,
        });
        expect(legacy.turns[index]).not.toHaveProperty("runStatus");
        expect(legacy.thread.runIds).toEqual(["run-0", "run-1", "run-2"]);
      } finally {
        await server.stop();
      }
      let older = f.read({ limit: 1 });
      const backwards = [older.turns[0]!.id];
      while (older.olderCursor) {
        older = f.read({ limit: 1, cursor: older.olderCursor });
        backwards.push(older.turns[0]!.id);
      }
      expect(backwards).toEqual(f.turns.map((t) => t.id).reverse());
      const forwards = [older.turns[0]!.id];
      while (older.newerCursor) {
        older = f.read({ limit: 1, cursor: older.newerCursor });
        forwards.push(older.turns[0]!.id);
      }
      expect(forwards).toEqual(f.turns.map((t) => t.id));
      expect(pruner.pruneHistory(500, month, now)).toEqual([]);
    },
  );

  it("keeps store read errors distinct from pruned run facts", async () => {
    const f = await historyReviewFixture();
    f.command(0);
    vi.spyOn(f.graph.commands.queries, "publicList").mockImplementationOnce(() => {
      throw Object.assign(new Error("store read failed"), {
        status: 503,
        code: "store_unavailable",
      });
    });
    expect(() => f.read()).toThrow(
      expect.objectContaining({ status: 503, code: "store_unavailable" }),
    );
    expect(f.read().turns[0]?.runStatus).toBe("available");
  });

  it.each([
    { label: "leading BOM", prompt: "\ufeffhello" },
    { label: "BOM at part offset", prompt: "abcd\ufeffhello" },
    { label: "file-backed prompt", prompt: "\ufeff" + "😀".repeat(20_000) },
  ])("preserves immutable BOM bytes in previews and parts ($label)", async ({ prompt }) => {
    const f = await historyReviewFixture([prompt]);
    const row = f.read().turns[0]!;
    expect(row.prompt.startsWith(prompt.slice(0, 5))).toBe(true);
    let offset = 0,
      text = "",
      digest = "";
    do {
      const part = ThreadPromptPart.parse(
        f.reads.threadPromptPart({
          threadId: f.thread.id,
          turnId: row.id,
          offset,
          maxBytes: prompt.length > 100 ? 8192 : 4,
        }),
      );
      expect(part.nextOffset - part.offset).toBe(Buffer.byteLength(part.text));
      if (offset === 4 && prompt.startsWith("abcd")) expect(part.text).toBe("\ufeffh");
      text += part.text;
      digest = part.sha256;
      offset = part.nextOffset;
    } while (offset < Buffer.byteLength(prompt));
    expect(text).toBe(prompt);
    expect(sha256(text).slice(7)).toBe(digest);
    expect(offset).toBe(Buffer.byteLength(prompt));
  });

  it("keeps a leading BOM in the answer preview with honest text bytes", async () => {
    const f = await historyReviewFixture();
    const record = f.command(0);
    writeFileSync(join(record.runDir, "final/answer.md"), "\ufeffhello");
    expect(f.read().turns[0]?.primaryOutput).toMatchObject({
      text: "\ufeffhello",
      textBytes: 8,
      totalTextBytes: 8,
      truncated: false,
    });
  });

  it.each([false, true])(
    "emits oversized patch evidence with unavailable apply coverage (decision=%s)",
    async (withDecision) => {
      const f = await historyReviewFixture(["patch", "other"]);
      const record = f.command(0, "succeeded", undefined, "agent");
      const patch = "diff --git a/a b/a\n" + "x".repeat(THREAD_HISTORY_FACT_BYTES);
      writeFileSync(join(record.runDir, "final/patch.diff"), patch);
      const decision = {
        runId: record.runId,
        action: "accept_risk" as const,
        findingIds: [],
        acceptedRisks: [],
        patchSha256: sha256(patch),
        decidedAt: "2026-10-26T11:00:00Z",
      };
      if (withDecision) {
        const outcome = makeOutcomeFacts("succeeded");
        writeFileSync(
          join(record.runDir, "final/run_facts.yaml"),
          JSON.stringify(
            validateRunFactsInvariants({
              schema_version: SCHEMA_VERSION,
              run_id: record.runId,
              task_id: record.taskId,
              mode: "agent",
              outcome,
              deliverable: {
                present: true,
                kind: "patch",
                path: "final/patch.diff",
                producer_attempt_id: "a01",
              },
              presentation: {
                state: "ready",
                primary: { kind: "patch", path: "final/patch.diff" },
              },
              participants: {
                planners: 0,
                attempts: [
                  {
                    attempt_id: "a01",
                    harness_id: "fake",
                    role: "candidate",
                    deliverable_present: true,
                    status: "success",
                  },
                ],
              },
              gates: {
                configured: false,
                required: 0,
                total: 0,
                executed: false,
                state: "not_configured",
                receipt_attempt_id: null,
              },
              review: { state: "not_run", blocker_ids: [], blockers: 0 },
              apply: { eligibility: null, operator_decision_present: false },
              required_actions: requiredActionsFor(outcome, false),
              generated_at: decision.decidedAt,
            }),
          ),
        );
        f.graph.threads.recordOperatorDecision(record.params, decision);
      }
      const page = f.read();
      expect(page.turns).toHaveLength(2);
      expect(page.turns[0]?.primaryOutput).toMatchObject({
        kind: "patch",
        text: null,
        path: "final/patch.diff",
      });
      expect(page.turns[0]?.run).toMatchObject({
        applyEligibility: null,
        applyEligibilityCoverage: "unavailable",
        operatorDecision: null,
        operatorDecisionCoverage: withDecision ? "unavailable" : "complete",
        unverifiedOperatorDecision: withDecision
          ? { action: "accept_risk", decidedAt: decision.decidedAt }
          : null,
      });
      // The addressed owners still refuse oversized exact-patch evidence.
      expect(() => applyEligibilityFor(record, null, THREAD_HISTORY_FACT_BYTES)).toThrow(
        expect.objectContaining({ code: "artifact_read_limit", status: 503 }),
      );
      if (withDecision)
        expect(() => validRunOperatorDecision(record, decision, THREAD_HISTORY_FACT_BYTES)).toThrow(
          expect.objectContaining({ code: "artifact_read_limit", status: 503 }),
        );
      writeFileSync(join(record.runDir, "final/patch.diff"), "diff --git a/a b/a\n");
      const smallDecision = { ...decision, patchSha256: sha256("diff --git a/a b/a\n") };
      if (withDecision) f.graph.threads.recordOperatorDecision(record.params, smallDecision);
      expect(f.read().turns[0]?.run).toMatchObject({
        applyEligibilityCoverage: "complete",
        operatorDecisionCoverage: "complete",
        unverifiedOperatorDecision: null,
        operatorDecision: withDecision ? { action: "accept_risk" } : null,
      });
    },
  );

  it.each([
    { label: "Unicode", safeMessage: "😀".repeat(225_000) },
    { label: "JSON escaping", safeMessage: "\u0001".repeat(150_000) },
  ])(
    "bounds a large failure message ($label) while retaining its raw detail reference",
    async ({ safeMessage }) => {
      const f = await historyReviewFixture(["\u0001".repeat(32_768), "other"]);
      const record = f.command(0, "failed");
      writeFileSync(
        join(record.runDir, "final/failure.yaml"),
        JSON.stringify({ category: "internal", safeMessage, rawDetailRef: "final/failure.yaml" }),
      );
      const page = f.read();
      expect(page.turns).toHaveLength(2);
      const run = page.turns[0]!.run!;
      expect(run.failure?.rawDetailRef).toBe("final/failure.yaml");
      expect(Buffer.byteLength(run.failure!.safeMessage)).toBeLessThanOrEqual(
        THREAD_HISTORY_FAILURE_BYTES,
      );
      expect(run.failureMessageInfo).toMatchObject({
        totalTextBytes: Buffer.byteLength(safeMessage),
        truncated: true,
      });
      expect(run.failureMessageInfo?.textBytes).toBe(Buffer.byteLength(run.failure!.safeMessage));
      expect(page.turns[0]?.primaryOutput?.truncated).toBe(true);
      expect(readFailure(record, THREAD_HISTORY_FACT_BYTES)?.safeMessage).toBe(safeMessage);
      writeFileSync(
        join(record.runDir, "final/failure.yaml"),
        JSON.stringify({ safeMessage: "small" }),
      );
      expect(f.read().turns[0]?.run?.failureMessageInfo).toEqual({
        textBytes: 5,
        totalTextBytes: 5,
        truncated: false,
      });
    },
  );

  it("reports boundary coverage and can navigate back including the selector's edge", async () => {
    const f = await historyReviewFixture(["first", "middle", "last"]);
    const before = f.read({ beforeTurnId: f.turns[0]!.id, limit: 1 });
    expect(before).toMatchObject({
      turns: [],
      hasOlder: false,
      hasNewer: true,
      olderCursor: null,
      replayCursor: null,
    });
    expect(f.read({ cursor: before.newerCursor!, limit: 1 }).turns[0]?.id).toBe(f.turns[0]!.id);
    const after = f.read({ afterTurnId: f.turns[2]!.id, limit: 1 });
    expect(after).toMatchObject({
      turns: [],
      hasOlder: true,
      hasNewer: false,
      newerCursor: null,
      replayCursor: null,
    });
    expect(f.read({ cursor: after.olderCursor!, limit: 1 }).turns[0]?.id).toBe(f.turns[2]!.id);
    const empty = await historyReviewFixture([]);
    expect(empty.read()).toMatchObject({ turns: [], hasOlder: false, hasNewer: false });
  });

  it("serializes the page's row collection only once when packing twenty rows", async () => {
    const f = await historyReviewFixture(Array.from({ length: 20 }, () => "x".repeat(32_768)));
    const stringify = JSON.stringify;
    let serializedRows = 0;
    vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
      if (value && typeof value === "object" && "hasOlder" in value && Array.isArray(value.turns))
        serializedRows += value.turns.length;
      return stringify(value, replacer as never, space);
    });
    const page = f.read();
    expect(page.turns).toHaveLength(20);
    expect(serializedRows).toBe(20);
  });
});
