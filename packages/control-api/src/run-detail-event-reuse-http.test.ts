import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { ControlRunDetail } from "@claudexor/schema";
import { afterAll, describe, expect, it } from "vitest";
import { BulkExecutor } from "./bulk-executor.js";
import { BULK_WORKER_ROLE } from "./bulk-protocol.js";
import { DaemonControlApiServer } from "./daemon-server.js";
import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";

const token = "event-reuse-http";
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const plan = [{ id: "p1", title: "Ранний план", status: "in_progress" }];
let seq = 0;
const line = (type: string, payload: Record<string, unknown>) =>
  `${JSON.stringify({ seq: ++seq, ts: "2026-10-29T00:00:00.000Z", run_id: "run-r", type, payload })}\n`;
const rows = (count: number) => {
  let out = "";
  for (let i = 0; i < count; i++)
    out += line("harness.event", {
      harness_id: "codex",
      attempt_id: "a01",
      type: "message",
      text: `delta ${seq} · ещё 🌿 ${"x".repeat(i % 80)}`,
      payload: { delta: true },
    });
  return out;
};

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

describe("GET /v2/runs/:id repeated over an unchanged or appended log", () => {
  it("reads only appended event bytes while artifacts stay fresh and replacement re-reads", async () => {
    const runDir = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-event-reuse-")));
    dirs.push(runDir);
    mkdirSync(join(runDir, "final"));
    const path = join(runDir, "events.jsonl");
    seq = 0;
    writeFileSync(
      path,
      line("plan.progress", { attempt_id: "a01", items: plan }) +
        line("budget.cash", { cash_spend_usd: 1.25, cash_knowledge: "exact" }) +
        rows(6_000),
    );
    writeFileSync(join(runDir, "final/summary.md"), "summary v1\n");
    const record: DaemonRunRecord = {
      id: "job-r",
      runId: "run-r",
      state: "running",
      runDir,
      params: { prompt: "reuse", mode: "agent" },
    };
    const server = new DaemonControlApiServer({ token, daemon: readOnlyDaemon(record) });
    const reads: { bytes: number; opens: number }[] = [];
    // Test-only worker instrumentation; production construction is unchanged.
    (server as unknown as { bulk: BulkExecutor }).bulk = new BulkExecutor(() => {
      const worker = new Worker(new URL("./test-support/event-read-counter.mjs", import.meta.url), {
        workerData: { role: BULK_WORKER_ROLE },
      });
      worker.on("message", (message: { type?: string; reads: (typeof reads)[number] }) => {
        if (message.type === "test:event-reads") reads.push(message.reads);
      });
      return worker;
    });
    const { host, port } = await server.start();
    const detail = async () => {
      const before = reads.length;
      const res = await globalThis.fetch(`http://${host}:${port}/v2/runs/run-r`, {
        headers: { authorization: `Bearer ${token}`, "X-Claudexor-Protocol-Major": "3" },
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(reads).toHaveLength(before + 1);
      return { text, body: JSON.parse(text) as ControlRunDetail, read: reads[before]! };
    };
    try {
      const size = statSync(path).size;
      const cold = await detail();
      expect(cold.read.bytes).toBeGreaterThanOrEqual(size);
      expect(cold.body.budget.spendUsd).toBe(1.25);
      expect(cold.body.planProgress?.items).toEqual(plan);

      // Unchanged log: identical response, without reading the history again.
      const unchanged = await detail();
      expect(unchanged.text).toBe(cold.text);
      expect(unchanged.read.bytes).toBeLessThanOrEqual(16 * 1024);

      // An artifact changed while the log did not: it is read fresh.
      writeFileSync(join(runDir, "final/summary.md"), "summary v2\n");
      const fresh = await detail();
      expect(fresh.body.finalSummary).not.toBe(cold.body.finalSummary);
      expect(fresh.body.finalSummary).toContain("summary v2");
      expect(fresh.read.bytes).toBeLessThanOrEqual(16 * 1024);

      // Appended events: only the suffix is read; early facts persist.
      const appended =
        rows(40) + line("budget.cash", { cash_spend_usd: 2.5, cash_knowledge: "exact" });
      appendFileSync(path, appended);
      const grown = await detail();
      expect(grown.body.lastSeq).toBe(seq);
      expect(grown.body.budget.spendUsd).toBe(2.5);
      expect(grown.body.planProgress?.items).toEqual(plan);
      expect(grown.read.bytes).toBeLessThanOrEqual(Buffer.byteLength(appended) + 16 * 1024);

      // A replaced file is a new source: it is read whole and its facts win.
      seq = 0;
      const replacement =
        line("budget.cash", { cash_spend_usd: 9, cash_knowledge: "exact" }) + rows(10);
      writeFileSync(`${path}.next`, replacement);
      renameSync(`${path}.next`, path);
      const replaced = await detail();
      expect(replaced.read.bytes).toBeGreaterThanOrEqual(Buffer.byteLength(replacement));
      expect(replaced.body.budget.spendUsd).toBe(9);
      expect(replaced.body.planProgress).toBeNull();
      expect(replaced.body.lastSeq).toBe(seq);
    } finally {
      await server.stop();
    }
  });
});
