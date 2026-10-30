import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlRunMessageResponse,
  type LiveMessageDelivery,
  type LiveMessageInput,
} from "@claudexor/schema";
import { sha256 } from "@claudexor/util";
import {
  DaemonControlApiServer,
  type DaemonControlApiOptions,
  type DaemonFacadeClient,
  type DaemonRunRecord,
} from "./daemon-server.js";

const token = "daemon-token-live-message";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Row = { seq: number; type: string; payload: Record<string, unknown> };

function runRecord(state = "running"): DaemonRunRecord {
  const runDir = mkdtempSync(join(tmpdir(), "claudexor-live-message-route-"));
  dirs.push(runDir);
  writeFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(createdRow())}\n`);
  return {
    id: "job-m1",
    state,
    runId: "run-m1",
    taskId: "task-m1",
    runDir,
    params: { prompt: "p", mode: "agent", scope: { kind: "none" } },
  };
}

function createdRow(seq = 1): Row & { ts: string; run_id: string; task_id: string } {
  return {
    seq,
    ts: "2026-09-26T12:00:00.000Z",
    run_id: "run-m1",
    task_id: "task-m1",
    type: "run.created",
    payload: { mode: "agent" },
  };
}

function rows(record: DaemonRunRecord): Row[] {
  return readFileSync(join(record.runDir as string, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Row);
}

function facade(records: DaemonRunRecord[]): DaemonFacadeClient {
  return {
    enqueue: async () => {
      throw new Error("enqueue is not part of this suite");
    },
    status: async (id) => {
      const record = records.find((r) => r.id === id || r.runId === id);
      if (!record) throw new Error(`no such job ${id}`);
      return record;
    },
    list: async (query) => {
      const id = (query as { id?: string } | undefined)?.id;
      return id ? records.filter((r) => r.id === id || r.runId === id) : records;
    },
    cancel: async () => ({}),
  };
}

/** In-memory twin of the daemon delivery ledger: replay, conflict, interrupted. */
function ledger(seed: { key: string; state: string; result?: unknown }[] = []) {
  const byKey = new Map<
    string,
    { id: string; state: string; result?: unknown; error?: string; request: string }
  >();
  for (const entry of seed) {
    byKey.set(`delivery.run.message:${entry.key}`, {
      id: `delivery-seed-${entry.key}`,
      state: entry.state,
      result: entry.result,
      request: "",
    });
  }
  return {
    beginDelivery: async (
      _params: unknown,
      input: { key: string; operation: string; request: unknown },
    ) => {
      const key = `delivery.${input.operation}:${input.key}`;
      const request = JSON.stringify(input.request);
      const prior = byKey.get(key);
      if (prior) {
        if (prior.request && prior.request !== request) {
          throw Object.assign(
            new Error("idempotency key was already used with a different request"),
            {
              status: 409,
              code: "idempotency_conflict",
            },
          );
        }
        return { ...prior, reused: true };
      }
      const record = { id: `delivery-${byKey.size + 1}`, state: "running", request };
      byKey.set(key, record);
      return { ...record, reused: false };
    },
    completeDelivery: async (id: string, result: unknown) => {
      const record = [...byKey.values()].find((candidate) => candidate.id === id);
      if (record) Object.assign(record, { state: "succeeded", result });
    },
    failDelivery: async (id: string, error: unknown) => {
      const record = [...byKey.values()].find((candidate) => candidate.id === id);
      // Mirror the daemon ledger (delivery-command.ts): a failed command keeps
      // its typed status/code so a replay answers the SAME problem.
      const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
      if (record)
        Object.assign(record, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
          errorCode: typeof value["code"] === "string" ? value["code"] : undefined,
          result: {
            status: typeof value["status"] === "number" ? value["status"] : 500,
            code: typeof value["code"] === "string" ? value["code"] : null,
          },
        });
    },
  };
}

async function withServer(
  records: DaemonRunRecord[],
  services: DaemonControlApiOptions["services"] | undefined,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = new DaemonControlApiServer({
    token,
    daemon: facade(records),
    pollMs: 5,
    services,
  });
  const { host, port } = await server.start();
  try {
    await fn(`http://${host}:${port}/v2`);
  } finally {
    await server.stop();
  }
}

function post(
  base: string,
  runId: string,
  body: unknown,
  headers: Record<string, string> = { "Idempotency-Key": `msg-${crypto.randomUUID()}` },
): Promise<Response> {
  return fetch(`${base}/runs/${runId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "X-Claudexor-Protocol-Major": "3",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function sendStub(delivery: LiveMessageDelivery) {
  return vi.fn(async (_input: LiveMessageInput) => delivery);
}

const TEXT = "Switch to MANGO and stop after step 3.";

describe("POST /v2/runs/:id/messages transport facts (HTTP)", () => {
  it("answers 404 for an unknown run and 501 when the engine build has no live-message service", async () => {
    await withServer([runRecord()], { ...ledger() }, async (base) => {
      const missing = await post(base, "run-nope", { text: TEXT });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { message: string }).message).toContain("no such run");
      const unsupported = await post(base, "run-m1", { text: TEXT });
      expect(unsupported.status).toBe(501);
    });
  });

  it("requires the Idempotency-Key (400 idempotency_key_required) before reading the body", async () => {
    const send = sendStub({ outcome: "accepted" });
    await withServer([runRecord()], { ...ledger(), sendRunMessage: send }, async (base) => {
      const response = await post(base, "run-m1", { text: TEXT }, {});
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("idempotency_key_required");
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("answers 400 for an empty, over-long (65,537 UTF-16 units) or unknown-key body and never dispatches", async () => {
    const send = sendStub({ outcome: "accepted" });
    const record = runRecord();
    await withServer([record], { ...ledger(), sendRunMessage: send }, async (base) => {
      const cases: unknown[] = [
        { text: "" },
        { text: "x".repeat(65_537) },
        { text: TEXT, attemptId: "a01" },
        "not json",
      ];
      for (const body of cases) {
        const response = await post(base, "run-m1", body);
        expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      }
      // The 65,536th unit is still accepted: the bound is inclusive.
      const atBound = await post(base, "run-m1", { text: "y".repeat(65_536) });
      expect(atBound.status).toBe(200);
      expect(send).toHaveBeenCalledOnce();
    });
    // No malformed request left a journal row; the one accepted message left two.
    expect(rows(record).map((r) => r.type)).toEqual(["run.created", "message.accepted"]);
  });
});

describe("POST /v2/runs/:id/messages typed outcomes (every one is HTTP 200)", () => {
  const verdicts: LiveMessageDelivery[] = [
    { outcome: "delivered", attemptId: "a01", harnessId: "codex", liveInput: "mid_turn" },
    {
      outcome: "accepted",
      attemptId: "a01",
      harnessId: "codex",
      liveInput: "mid_turn",
      nativeTurnId: "turn-7",
    },
    { outcome: "rejected", reason: "multi_attempt", message: "pass expectedAttemptId" },
    { outcome: "not_active", reason: "interaction_pending", attemptId: "a01", harnessId: "claude" },
    { outcome: "unsupported", reason: "thread_bound", attemptId: "a01", harnessId: "codex" },
    {
      outcome: "delivery_unknown",
      reason: "response_timeout",
      attemptId: "a01",
      harnessId: "codex",
    },
  ];

  for (const verdict of verdicts) {
    it(`returns 200 ${verdict.outcome} with accepted=${verdict.outcome === "delivered" || verdict.outcome === "accepted"} and journals admission then the closing row`, async () => {
      const send = sendStub(verdict);
      const record = runRecord();
      const key = `msg-${verdict.outcome}`;
      await withServer([record], { ...ledger(), sendRunMessage: send }, async (base) => {
        const response = await post(
          base,
          "run-m1",
          { text: TEXT, expectedAttemptId: "a01" },
          { "Idempotency-Key": key },
        );
        expect(response.status).toBe(200);
        const body = ControlRunMessageResponse.parse(await response.json());
        expect(body).toMatchObject({
          accepted: verdict.outcome === "delivered" || verdict.outcome === "accepted",
          outcome: verdict.outcome,
          runId: "run-m1",
          messageId: key,
        });
        if (verdict.reason) expect(body.reason).toBe(verdict.reason);
        if (verdict.nativeTurnId) expect(body.nativeTurnId).toBe(verdict.nativeTurnId);
        if (verdict.attemptId) expect(body.attemptId).toBe(verdict.attemptId);
      });
      expect(send).toHaveBeenCalledWith({
        runId: "run-m1",
        text: TEXT,
        expectedAttemptId: "a01",
        messageId: key,
      });
      const journal = rows(record);
      const admission = journal[1] as Row;
      expect(admission).toMatchObject({
        seq: 2,
        type: "message.accepted",
        payload: {
          message_id: key,
          text: TEXT,
          text_sha256: sha256(TEXT),
          text_bytes: Buffer.byteLength(TEXT, "utf8"),
          title: `Live message admitted (${Buffer.byteLength(TEXT, "utf8")} bytes)`,
        },
      });
      expect(admission.payload).not.toHaveProperty("outcome");
      if (verdict.outcome === "accepted") {
        // Native acceptance is the receipt (replayable under the key); no second row.
        expect(journal.map((r) => r.type)).toEqual(["run.created", "message.accepted"]);
      } else {
        const closing = journal[2] as Row;
        expect(journal).toHaveLength(3);
        expect(closing.seq).toBe(3);
        expect(closing.type).toBe(
          verdict.outcome === "delivered" ? "message.delivered" : "message.refused",
        );
        expect(closing.payload).toMatchObject({
          message_id: key,
          outcome: verdict.outcome,
          text: TEXT,
          text_sha256: sha256(TEXT),
          ...(verdict.reason ? { reason: verdict.reason } : {}),
          ...(verdict.attemptId ? { attempt_id: verdict.attemptId } : {}),
          ...(verdict.harnessId ? { harness_id: verdict.harnessId } : {}),
        });
        expect(String(closing.payload["title"])).toContain(
          verdict.outcome === "delivered" ? "delivered" : verdict.outcome,
        );
      }
    });
  }

  it("answers not_active/run_terminal for an already-terminal run with NO journal row and no dispatch", async () => {
    const send = sendStub({ outcome: "accepted" });
    const record = runRecord("succeeded");
    await withServer([record], { ...ledger(), sendRunMessage: send }, async (base) => {
      const response = await post(base, "run-m1", { text: TEXT });
      expect(response.status).toBe(200);
      expect(ControlRunMessageResponse.parse(await response.json())).toMatchObject({
        accepted: false,
        outcome: "not_active",
        reason: "run_terminal",
      });
    });
    expect(send).not.toHaveBeenCalled();
    expect(rows(record).map((r) => r.type)).toEqual(["run.created"]);
  });
});

describe("POST /v2/runs/:id/messages journal-first admission and idempotency (CONTRACT A16/A23)", () => {
  it("does not dispatch when the admission row cannot be persisted: rejected/admission_persist_failed", async () => {
    const send = sendStub({ outcome: "accepted" });
    const record = runRecord();
    // An unwritable event log: the path is a directory, so the append throws.
    rmSync(join(record.runDir as string, "events.jsonl"));
    mkdirSync(join(record.runDir as string, "events.jsonl"));
    await withServer([record], { ...ledger(), sendRunMessage: send }, async (base) => {
      const response = await post(base, "run-m1", { text: TEXT });
      expect(response.status).toBe(200);
      expect(ControlRunMessageResponse.parse(await response.json())).toMatchObject({
        accepted: false,
        outcome: "rejected",
        reason: "admission_persist_failed",
      });
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("replays the stored receipt under the same key (one dispatch), refuses a different body (409 idempotency_conflict), and reports a restart-interrupted command as 409 delivery_interrupted", async () => {
    const send = sendStub({ outcome: "accepted", attemptId: "a01", harnessId: "codex" });
    const record = runRecord();
    const services = {
      ...ledger([{ key: "msg-interrupted", state: "interrupted" }]),
      sendRunMessage: send,
    };
    await withServer([record], services, async (base) => {
      const first = await post(base, "run-m1", { text: TEXT }, { "Idempotency-Key": "msg-same" });
      const replay = await post(base, "run-m1", { text: TEXT }, { "Idempotency-Key": "msg-same" });
      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(await first.json());
      expect(send).toHaveBeenCalledOnce();

      const conflict = await post(
        base,
        "run-m1",
        { text: "a different message" },
        { "Idempotency-Key": "msg-same" },
      );
      expect(conflict.status).toBe(409);
      expect(((await conflict.json()) as { code: string }).code).toBe("idempotency_conflict");

      const interrupted = await post(
        base,
        "run-m1",
        { text: TEXT },
        { "Idempotency-Key": "msg-interrupted" },
      );
      expect(interrupted.status).toBe(409);
      expect(((await interrupted.json()) as { code: string }).code).toBe("delivery_interrupted");
    });
    // One admission row for the one real dispatch; the replay and refusals wrote nothing.
    expect(rows(record).map((r) => r.type)).toEqual(["run.created", "message.accepted"]);
  });

  it("file-tail-stamps a receipt that lands after the run's terminal commit with the next seq", async () => {
    const record = runRecord();
    const eventsPath = join(record.runDir as string, "events.jsonl");
    const send = vi.fn(async (_input: LiveMessageInput): Promise<LiveMessageDelivery> => {
      // The run finishes while the adapter is still answering.
      writeFileSync(
        eventsPath,
        `${readFileSync(eventsPath, "utf8")}${JSON.stringify({
          ...createdRow(3),
          type: "run.completed",
          payload: { lifecycle: "succeeded" },
        })}\n`,
      );
      return { outcome: "delivered", attemptId: "a01", harnessId: "codex", liveInput: "mid_turn" };
    });
    await withServer([record], { ...ledger(), sendRunMessage: send }, async (base) => {
      const response = await post(base, "run-m1", { text: TEXT });
      expect(response.status).toBe(200);
      expect(ControlRunMessageResponse.parse(await response.json()).outcome).toBe("delivered");
    });
    expect(rows(record).map((r) => [r.seq, r.type])).toEqual([
      [1, "run.created"],
      [2, "message.accepted"],
      [3, "run.completed"],
      [4, "message.delivered"],
    ]);
  });

  it("answers 500 message_receipt_unavailable when the closing row cannot be persisted (the message may have landed)", async () => {
    const record = runRecord();
    const eventsPath = join(record.runDir as string, "events.jsonl");
    const send = vi.fn(async (_input: LiveMessageInput): Promise<LiveMessageDelivery> => {
      rmSync(eventsPath);
      mkdirSync(eventsPath);
      return { outcome: "delivered", attemptId: "a01", harnessId: "codex" };
    });
    await withServer([record], { ...ledger(), sendRunMessage: send }, async (base) => {
      const response = await post(base, "run-m1", { text: TEXT }, { "Idempotency-Key": "msg-500" });
      expect(response.status).toBe(500);
      expect(((await response.json()) as { code: string }).code).toBe(
        "message_receipt_unavailable",
      );
      // The failed command replays as the same 500: never a fresh dispatch.
      const replay = await post(base, "run-m1", { text: TEXT }, { "Idempotency-Key": "msg-500" });
      expect(replay.status).toBe(500);
      expect(send).toHaveBeenCalledOnce();
    });
  });
});

describe("POST /v2/runs/:id/messages for an accepted job that has no run yet", () => {
  const unbound = (state: string): DaemonRunRecord => ({
    id: "job-queued",
    state,
    params: { prompt: "p", mode: "agent", scope: { kind: "none" } },
  });

  it("answers a typed not_active receipt instead of a false 404 and sends nothing", async () => {
    const send = sendStub({ outcome: "delivered" });
    await withServer([unbound("queued")], { ...ledger(), sendRunMessage: send }, async (base) => {
      const headers = { "Idempotency-Key": "msg-queued" };
      const first = await post(base, "job-queued", { text: TEXT }, headers);
      expect(first.status).toBe(200);
      const receipt = ControlRunMessageResponse.parse(await first.json());
      expect(receipt).toMatchObject({
        accepted: false,
        outcome: "not_active",
        reason: "no_live_session",
        runId: "job-queued",
        messageId: "msg-queued",
      });
      const replay = await post(base, "job-queued", { text: TEXT }, headers);
      expect(await replay.json()).toEqual(receipt);
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("replays that receipt after the job binds its run, by either id, and still sends nothing", async () => {
    const send = sendStub({ outcome: "delivered" });
    const record = unbound("queued");
    await withServer([record], { ...ledger(), sendRunMessage: send }, async (base) => {
      const headers = { "Idempotency-Key": "msg-queued" };
      const receipt = await (await post(base, "job-queued", { text: TEXT }, headers)).json();
      // The daemon binding gives the same job its run (onRunStart).
      Object.assign(record, runRecord(), { id: "job-queued" });
      for (const id of ["job-queued", "run-m1"]) {
        const replay = await post(base, id, { text: TEXT }, headers);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(receipt);
      }
      const changed = await post(base, "run-m1", { text: `${TEXT}!` }, headers);
      expect(changed.status).toBe(409);
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("answers run_terminal for a job that failed before binding a run", async () => {
    const send = sendStub({ outcome: "delivered" });
    await withServer([unbound("failed")], { ...ledger(), sendRunMessage: send }, async (base) => {
      const response = await post(base, "job-queued", { text: TEXT });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        outcome: "not_active",
        reason: "run_terminal",
      });
      expect(send).not.toHaveBeenCalled();
    });
  });
});
