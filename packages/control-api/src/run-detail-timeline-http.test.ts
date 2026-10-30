import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { ControlRunDetail } from "@claudexor/schema";
import { afterAll, describe, expect, it } from "vitest";
import { BulkExecutor } from "./bulk-executor.js";
import { BULK_WORKER_ROLE } from "./bulk-protocol.js";
import { DaemonControlApiServer } from "./daemon-server.js";
import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";

const token = "timeline-window-http";
const SECRET = `sk-ant-${"b".repeat(40)}`;
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const text = (i: number) => `display ${i} · ранний 🌿\n`;

/** Appends canonical event lines with the writer's monotonic `seq`. */
function eventLog(path: string) {
  let seq = 0;
  const line = (type: string, payload: Record<string, unknown>) =>
    `${JSON.stringify({ seq: ++seq, ts: "2026-10-27T00:00:00.000Z", run_id: "run-w", task_id: "task-w", type, payload })}\n`;
  const rows = (from: number, to: number) => {
    let out = "";
    for (let i = from; i < to; i++) {
      out += line("harness.event", {
        harness_id: "codex",
        attempt_id: "a01",
        type: i % 2 ? "message" : "thinking",
        text: text(i),
        payload: { delta: i % 3 === 0 },
      });
      if (i % 4 === 3) out += buffered(i);
    }
    return out;
  };
  // Cursor's per-call flush: retained evidence, never a timeline row.
  const buffered = (i: number) =>
    line("harness.event", {
      harness_id: "cursor",
      attempt_id: "a01",
      type: "message",
      text: `buffered ${i}`,
      payload: { buffered: true, model_call_id: `call-${i}` },
    });
  return {
    line,
    rows,
    buffered,
    append: (content: string) => appendFileSync(path, content),
    lastSeq: () => seq,
  };
}

function runFixture(): { record: DaemonRunRecord; path: string } {
  const runDir = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-timeline-http-")));
  dirs.push(runDir);
  const path = join(runDir, "events.jsonl");
  writeFileSync(path, "");
  const params = { prompt: "window", mode: "agent" };
  return { record: { id: "job-w", runId: "run-w", state: "running", runDir, params }, path };
}

function readOnlyDaemon(record: DaemonRunRecord): DaemonFacadeClient {
  return {
    async enqueue() {
      throw new Error("detail read tried to enqueue");
    },
    async status() {
      return record;
    },
    async list(query) {
      return "id" in query && (query.id === record.id || query.id === record.runId) ? [record] : [];
    },
    async cancel() {
      throw new Error("detail read tried to cancel");
    },
  };
}

interface DetailWork {
  validations: number;
  fileParses: number;
}

/** One real HTTP/worker detail read. The worker sends its counts before the
 * result on the same port, so these measure the projection's actual owner. */
async function detail(base: string, work: DetailWork[]) {
  const before = work.length;
  const res = await globalThis.fetch(`${base}/v2/runs/run-w`, {
    headers: { authorization: `Bearer ${token}`, "X-Claudexor-Protocol-Major": "3" },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as ControlRunDetail;
  expect(work).toHaveLength(before + 1);
  return { body, ...work[before]! };
}

describe("GET /v2/runs/:id bounded timeline over a long event log", () => {
  it("projects the displayed window only; budget, plan and cursor still read the whole log", async () => {
    const { record, path } = runFixture();
    const log = eventLog(path);
    const plan = [
      { id: "p1", title: "Ранний план 🌱", status: "in_progress" },
      { id: "p2", title: "Ship", status: "completed" },
    ];
    // The earliest facts are display-omitted below; the other projections must still see them.
    log.append(
      log.line("plan.progress", { attempt_id: "a01", items: plan }) +
        log.line("budget.cash", {
          cash_spend_usd: 1.25,
          cash_knowledge: "exact",
          estimated: false,
          valuation_usd: 3.5,
          valuation_knowledge: "estimated",
        }) +
        log.line("harness.event", { harness_id: "codex", type: "message", text: `${SECRET}` }) +
        "{torn line\n" +
        log.rows(0, 1_500) +
        log.line("route.fallback.started", { reason: "rate_limited", text: `to ${SECRET}` }),
    );

    const server = new DaemonControlApiServer({ token, daemon: readOnlyDaemon(record), pollMs: 5 });
    const work: DetailWork[] = [];
    const bulk = new BulkExecutor(() => {
      const worker = new Worker(
        new URL("./test-support/timeline-work-counter.mjs", import.meta.url),
        {
          workerData: { role: BULK_WORKER_ROLE },
        },
      );
      worker.on("message", (message: { type?: string; work: DetailWork }) => {
        if (message.type === "test:detail-work") work.push(message.work);
      });
      return worker;
    });
    // Test-only worker instrumentation; production construction is unchanged.
    (server as unknown as { bulk: BulkExecutor }).bulk = bulk;
    const { host, port } = await server.start();
    const base = `http://${host}:${port}`;
    try {
      const first = await detail(base, work);
      // 3 early facts + 1,500 rows + 1 warning are displayable; buffered rows never count.
      expect(first.fileParses).toBe(1);
      expect(first.body.lastSeq).toBe(log.lastSeq());
      expect(first.body.timeline).toHaveLength(502);
      expect(first.body.timeline.slice(0, 2).map((row) => [row.type, row.title])).toEqual([
        [
          "timeline.evidence_incomplete",
          "1 malformed run event line(s) omitted from this projection",
        ],
        ["timeline.truncated", "1004 earlier event(s) omitted from this projection"],
      ]);
      expect(first.body.timeline[2]).toMatchObject({ detail: text(1001), textKind: "message" });
      expect(first.body.timeline.at(-1)).toMatchObject({
        type: "route.fallback.started",
        title: `to ${SECRET}`,
        severity: "warning",
      });
      // The projection shows the journaled event text exactly (INV-146).
      expect(JSON.stringify(first.body)).toContain(SECRET);
      expect(first.body.budget).toMatchObject({
        spendUsd: 1.25,
        source: "events",
        cashKnowledge: "exact",
        valuationUsd: 3.5,
        evidence: "incomplete",
      });
      expect(first.body.planProgress).toEqual({ items: plan, evidence: "incomplete" });
      // One validation per returned row (500 + two markers), not one per event.
      expect(first.validations).toBe(502);

      log.append(log.rows(1_500, 2_500));
      const longer = await detail(base, work);
      expect(longer.body.lastSeq).toBe(log.lastSeq());
      expect(longer.body.timeline[1]?.title).toBe(
        "2004 earlier event(s) omitted from this projection",
      );
      expect(longer.body.timeline.at(-1)).toMatchObject({ detail: text(2_499) });
      expect(longer.validations).toBe(first.validations);
      expect(longer.body.budget).toEqual(first.body.budget);
      expect(longer.body.planProgress).toEqual(first.body.planProgress);

      // A buffered row advances the cursor without becoming or displacing a row.
      log.append(log.buffered(9_999));
      const fenced = await detail(base, work);
      expect(fenced.body.lastSeq).toBe(longer.body.lastSeq + 1);
      expect(fenced.body.timeline).toEqual(longer.body.timeline);
    } finally {
      await server.stop();
    }
  });
});
