import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonControlApiServer } from "@claudexor/control-api";
import {
  createPartition,
  createSqlDaemonServices,
  currentGeneration,
  EngineStore,
  setGlobalGenerationInTx,
} from "@claudexor/daemon";
import { describe, expect, it, vi } from "vitest";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const cleanups: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  for (const close of cleanups.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

const TEXT = "Please inspect the API first.";

/** One accepted job behind real control HTTP and the real SQL delivery ledger. */
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sql-message-")));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  cleanups.push(() => store.close());
  if (!currentGeneration(store, "global"))
    store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
  cleanups.push(() => graph.close());
  const commands = graph.commands.current();
  const job = commands.accept({
    id: "job-msg",
    params: { prompt: "p", mode: "agent", scope: { kind: "none" } },
    clientId: "fixture",
    operation: "run.create",
    idempotencyKey: "launch",
  }).record;
  const send = vi.fn(async () => ({
    outcome: "delivered" as const,
    attemptId: "a01",
    harnessId: "fake",
  }));
  const control = new DaemonControlApiServer({
    token: "fixture",
    daemon: {
      enqueue: async () => {
        throw new Error("enqueue is not part of this suite");
      },
      status: async (id) => graph.commands.queries.select({ id })[0]!,
      // The daemon's own addressing: a job id, or its run id once bound.
      list: async (query) => ("id" in query ? graph.commands.queries.select({ id: query.id }) : []),
      cancel: async () => ({}),
    },
    services: {
      beginDelivery: async (params, input) => graph.commands.beginDelivery(params, input),
      completeDelivery: async (id, result) => graph.commands.completeDelivery(id, result),
      failDelivery: async (id, error) => graph.commands.failDelivery(id, error),
      sendRunMessage: send,
    },
  });
  const { host, port } = await control.start();
  cleanups.push(() => control.stop());
  const post = async (id: string, key: string, body: Record<string, unknown> = { text: TEXT }) => {
    const response = await fetch(`http://${host}:${port}/v2/runs/${id}/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture",
        "X-Claudexor-Protocol-Major": "3",
        "content-type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const runDir = join(root, "run");
  /** The daemon's binding write: onRunStart updates the same command with its run. */
  const bind = () => {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({
        seq: 1,
        ts: "2026-10-20T00:00:00.000Z",
        run_id: "run-msg",
        task_id: "task-msg",
        type: "run.created",
        payload: { mode: "agent" },
      })}\n`,
    );
    commands.update(job.id, { state: "running", runId: "run-msg", taskId: "task-msg", runDir });
  };
  const journaled = () =>
    readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: { message_id?: string } })
      .filter((row) => row.type.startsWith("message."))
      .map((row) => [row.type, row.payload.message_id]);
  return { post, bind, send, journaled };
}

const conflict = { status: 409, body: expect.objectContaining({ code: "idempotency_conflict" }) };

describe("live messages over the SQL delivery ledger across run binding", () => {
  it("replays a queued job's receipt after its run binds, by job or run id, sending nothing", async () => {
    const f = await fixture();
    const early = await f.post("job-msg", "queued-early");
    expect(early).toMatchObject({
      status: 200,
      body: { outcome: "not_active", reason: "no_live_session", runId: "job-msg" },
    });
    expect(await f.post("job-msg", "queued-early")).toEqual(early);
    f.bind();
    expect(await f.post("job-msg", "queued-early")).toEqual(early);
    expect(await f.post("run-msg", "queued-early")).toEqual(early);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.journaled()).toEqual([]);
  });

  it("keeps a changed body or attempt guard in conflict before and after binding", async () => {
    const f = await fixture();
    await f.post("job-msg", "queued-early");
    const changed = [{ text: "A different message." }, { text: TEXT, expectedAttemptId: "a01" }];
    for (const body of changed)
      expect(await f.post("job-msg", "queued-early", body)).toEqual(conflict);
    f.bind();
    for (const id of ["job-msg", "run-msg"])
      for (const body of changed) expect(await f.post(id, "queued-early", body)).toEqual(conflict);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("delivers a fresh key once after binding and replays that bound receipt by either id", async () => {
    const f = await fixture();
    await f.post("job-msg", "queued-early");
    f.bind();
    const delivered = await f.post("job-msg", "bound-key");
    expect(delivered).toMatchObject({
      status: 200,
      body: { outcome: "delivered", runId: "run-msg", messageId: "bound-key", attemptId: "a01" },
    });
    expect(await f.post("run-msg", "bound-key")).toEqual(delivered);
    expect(await f.post("job-msg", "bound-key")).toEqual(delivered);
    expect(await f.post("run-msg", "bound-key", { text: "Changed." })).toEqual(conflict);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.journaled()).toEqual([
      ["message.accepted", "bound-key"],
      ["message.delivered", "bound-key"],
    ]);
  });
});
