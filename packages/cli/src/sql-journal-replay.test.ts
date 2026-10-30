import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonControlApiServer,
  type DaemonFacadeClient,
  type DaemonRunRecord,
} from "@claudexor/control-api";
import {
  SqlPartitionRecovery,
  decodeJournalCursor,
  type JournalEventPage,
} from "@claudexor/daemon";
import { ControlJournalEvent } from "@claudexor/schema";
import { afterEach, expect, it, vi } from "vitest";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { readJournalEventPage, readJournalEvents } from "../../daemon/dist/store/cursors.js";
import { quarantineGeneration } from "../../daemon/dist/store/generations.js";
import { recoveryControlServices } from "./recovery-control-services.js";

const TOKEN = "journal-replay-fixture";
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Real SQL owners behind the production recovery route binding and HTTP server. */
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sql-journal-replay-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const sql = await sqlFixture(root);
  cleanups.push(() => sql.close());
  const recovery = recoveryControlServices({
    partition: (name) =>
      new SqlPartitionRecovery(sql.store, sql.graph.blobs, sql.graph.maintenance, name, {
        projections: () => [],
      }),
    setup: () => null,
  });
  // A bound run, so admission answers without waiting for the run to start.
  writeFileSync(
    join(root, "events.jsonl"),
    `${JSON.stringify({ seq: 1, ts: new Date().toISOString(), run_id: "run-one", task_id: "task-one", type: "run.created", payload: {} })}\n`,
  );
  const record: DaemonRunRecord = {
    id: "job-one",
    runId: "run-one",
    taskId: "task-one",
    state: "running",
    runDir: root,
    params: { mode: "ask", scope: { kind: "project", root } },
  };
  const counts = { admissions: 0, cancels: 0 };
  const daemon: DaemonFacadeClient = {
    enqueue: async () => {
      counts.admissions += 1;
      return { id: record.id, state: "queued" };
    },
    status: async () => structuredClone(record),
    list: async (query) => ("delegatedFromRunId" in query ? [] : [structuredClone(record)]),
    fenceDelegationParent: async () => ({}),
    cancel: async () => {
      counts.cancels += 1;
      record.state = "cancelled";
      return { ok: true };
    },
  };
  /** Positions the owner returned, in read order. */
  const reads: Array<string | undefined> = [];
  const server = new DaemonControlApiServer({
    token: TOKEN,
    daemon,
    pollMs: 5,
    services: {
      journalEvents: async (partition, page) => {
        const result = await recovery.journalEvents(partition, page);
        reads.push((result as JournalEventPage).position);
        return result;
      },
    },
  });
  const { host, port } = await server.start();
  cleanups.push(() => server.stop());
  const headers = { authorization: `Bearer ${TOKEN}`, "X-Claudexor-Protocol-Major": "3" };
  const open = (path: string, extra: Record<string, string> = {}) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({ host, port, path, headers: { ...headers, ...extra } }, resolve);
      req.on("error", reject);
      req.end();
      cleanups.push(() => req.destroy());
    });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://${host}:${port}${path}`, {
      method,
      headers: {
        ...headers,
        "content-type": "application/json",
        "Idempotency-Key": `journal-replay-${path}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  const sseResponses = () => [
    ...(server as unknown as { sseClients: Set<ServerResponse> }).sseClients,
  ];
  return { root, sql, counts, reads, open, call, sseResponses, stop: () => server.stop() };
}

/** Waits until `progress()` holds still across a quiet interval (a hang detector bounds it). */
async function quiescent(progress: () => number, what: string) {
  await vi.waitFor(
    async () => {
      const before = progress();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(progress(), what).toBe(before);
    },
    { timeout: 10_000, interval: 0 },
  );
}

/** Frames of one SSE response, decoded once complete. */
function frames(response: IncomingMessage) {
  const events: Array<{ id: string; type: string; data: string }> = [];
  const state = { closed: false, raw: "" };
  let buffered = "";
  const consume = () =>
    response.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      state.raw += text;
      buffered += text;
      for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
        const lines = buffered.slice(0, end).split("\n");
        buffered = buffered.slice(end + 2);
        const field = (name: string) =>
          lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
        const id = field("id");
        if (id) events.push({ id, type: field("event")!, data: field("data")! });
      }
    });
  response.on("close", () => {
    state.closed = true;
  });
  response.on("error", () => {});
  return { events, state, consume };
}

function inlineBatch(count: number, type = "fixture.inline") {
  return Array.from({ length: count }, (_, i) => ({
    type,
    payload: { i, text: `inline ${i} `.padEnd(60 * 1024, ".") },
  }));
}

it("replays a large mixed history completely and in order, resuming at every page boundary", async () => {
  const f = await fixture();
  const ledger = f.sql.graph.globalEvents;
  const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  ledger.appendBatch(
    Array.from({ length: 600 }, (_, i) =>
      i % 3 === 0
        ? {
            type: "thread.head.updated",
            payload: { thread_id: "t", project_id: null, revision: i + 1 },
          }
        : { type: "fixture.small", payload: { i } },
    ),
  );
  ledger.appendBatch(inlineBatch(20));
  ledger.append("fixture.referenced", { body: "r".repeat(3 * 1024 * 1024) });
  ledger.append("fixture.secret", {
    note: `copied ${token} into a prompt`,
    body: "s".repeat(2 * 1024 * 1024),
  });
  ledger.appendBatch([1, 2, 3].map((tail) => ({ type: "fixture.small", payload: { tail } })));
  const blobs = f.sql.graph.blobs;
  const expected = readJournalEvents(f.sql.store, "global", undefined, blobs);
  const pages: JournalEventPage[] = [readJournalEventPage(f.sql.store, "global", {}, blobs)];
  while (pages.at(-1)!.more)
    pages.push(
      readJournalEventPage(
        f.sql.store,
        "global",
        { after: pages.at(-1)!.position, through: pages.at(-1)!.through },
        blobs,
      ),
    );
  expect(pages.length).toBeGreaterThan(4);
  expect(pages.flatMap((page) => page.events)).toEqual(expected);

  const whole = frames(await f.open("/v2/global/events"));
  whole.consume();
  await vi.waitFor(() => expect(whole.events.length).toBe(expected.length), { timeout: 20_000 });
  expect(whole.events.map(({ id, type }) => [id, type])).toEqual(
    expected.map((event) => [event.cursor, event.type]),
  );
  // The journal stream carries every event exactly (INV-146).
  expect(whole.state.raw).toContain(token);
  for (const [index, frame] of whole.events.entries()) {
    expect(ControlJournalEvent.parse(JSON.parse(frame.data))).toEqual(expected[index]);
  }

  // Each page boundary resumes with exactly the following page.
  for (const [index, page] of pages.slice(1).entries()) {
    const resumed = frames(
      await f.open("/v2/global/events", { "Last-Event-ID": pages[index]!.position }),
    );
    resumed.consume();
    await vi.waitFor(() =>
      expect(resumed.events.length).toBeGreaterThanOrEqual(page.events.length),
    );
    expect(resumed.events.slice(0, page.events.length).map((frame) => frame.id)).toEqual(
      page.events.map((event) => event.cursor),
    );
  }
});

it("holds at most a frame beyond each slow reader's socket while admission and Stop answer", async () => {
  const f = await fixture();
  f.sql.graph.globalEvents.appendBatch(inlineBatch(400));
  const expected = readJournalEvents(f.sql.store, "global", undefined, f.sql.graph.blobs);
  const largestFrame = Math.max(
    ...expected.map((event) => Buffer.byteLength(JSON.stringify(event)) + 256),
  );
  const readers = await Promise.all([1, 2, 3].map(() => f.open("/v2/global/events")));
  await vi.waitFor(() => {
    expect(f.sseResponses()).toHaveLength(3);
    for (const response of f.sseResponses()) expect(response.writableNeedDrain).toBe(true);
  });
  // What the daemon holds for each slow reader: at most the frame that filled its socket.
  for (const response of f.sseResponses())
    expect(response.writableLength, "bytes held for one slow reader").toBeLessThan(
      2 * largestFrame,
    );
  await quiescent(() => f.reads.length, "page reads while every reader is backpressured");

  // Control answers while every slow replay is still incomplete.
  expect(await f.call("GET", "/healthz")).toEqual({ status: 200, body: { ok: true } });
  const admitted = await f.call("POST", "/v2/runs", {
    mode: "ask",
    prompt: "fixture",
    scope: { kind: "project", root: f.root },
  });
  expect(admitted).toMatchObject({ status: 200, body: { jobId: "job-one", runId: "run-one" } });
  const stopped = await f.call("POST", "/v2/runs/run-one/control", {
    control: { kind: "cancel" },
  });
  expect(stopped).toMatchObject({ status: 200, body: { accepted: true } });
  expect(f.counts).toEqual({ admissions: 1, cancels: 1 });
  expect(f.sseResponses().every((response) => response.writableNeedDrain)).toBe(true);

  const streams = readers.map(frames);
  for (const stream of streams) stream.consume();
  await vi.waitFor(
    () => expect(streams.map((stream) => stream.events.length)).toEqual([400, 400, 400]),
    { timeout: 20_000 },
  );
  for (const stream of streams)
    expect(stream.events.map((frame) => frame.id)).toEqual(expected.map((event) => event.cursor));
});

it("never continues a stream into a replaced partition generation", async () => {
  const f = await fixture();
  const projectRoot = join(f.root, "project");
  mkdirSync(projectRoot);
  const projectId = f.sql.graph.projects.register({
    root: projectRoot,
    idempotencyKey: "project",
    clientId: "fixture",
  }).project.id;
  const name = `project:${projectId}`;
  const path = `/v2/projects/${projectId}/events`;
  const replace = (operationId: string) => {
    const generation = f.sql.graph.projects.partition(projectId)!;
    return quarantineGeneration(f.sql.store, f.sql.graph.blobs, {
      oldPid: generation.pid,
      keyDigest: operationId.padEnd(64, "0"),
      requestDigest: operationId.padEnd(64, "1"),
      operationId,
      payload: { operationId },
    }).generation!;
  };
  expect(readJournalEvents(f.sql.store, name, undefined, f.sql.graph.blobs)).toEqual([]);

  // A stream that started on an empty generation has no cursor yet.
  const empty = frames(await f.open(path));
  empty.consume();
  await vi.waitFor(() => expect(f.reads.length).toBeGreaterThan(1));
  replace("first-replacement");
  await vi.waitFor(() => expect(empty.state.closed || empty.events.length > 0).toBe(true));
  expect(empty.events).toEqual([]);
  expect(empty.state.closed).toBe(true);

  // A stream with a delivered cursor closes too; resuming that cursor is refused.
  const before = f.sql.graph.threads.ledger(f.sql.graph.projects.partition(projectId)!);
  before.append("fixture.small", { n: 1 });
  const live = frames(await f.open(path));
  live.consume();
  await vi.waitFor(() => expect(live.events.length).toBe(2));
  const next = replace("second-replacement");
  await vi.waitFor(() => expect(live.state.closed).toBe(true));
  expect(live.events.map((frame) => frame.type)).toEqual([
    "journal.partition_quarantined",
    "fixture.small",
  ]);
  const resumed = await f.open(path, { "Last-Event-ID": live.events.at(-1)!.id });
  expect(resumed.statusCode).toBe(409);
  resumed.resume();
  const fresh = frames(await f.open(path));
  fresh.consume();
  await vi.waitFor(() => expect(fresh.events.length).toBe(1));
  expect(fresh.events[0]!.type).toBe("journal.partition_quarantined");
  expect(decodeJournalCursor(fresh.events[0]!.id, name, next.epoch, 10)).toBe(1);
});

it("does not deliver a row retired before a slow reader reached it, and tails later rows", async () => {
  const f = await fixture();
  const ledger = f.sql.graph.globalEvents;
  ledger.appendBatch(inlineBatch(500));
  const [retired] = ledger.appendBatch([
    { type: "thread.head.updated", payload: { thread_id: "t", project_id: null, revision: 1 } },
  ]);
  const generation = ledger.generation;
  const seqOf = (cursor: string | undefined) =>
    cursor ? decodeJournalCursor(cursor, "global", generation.epoch, retired!.seq + 10) : 0;
  const reader = await f.open("/v2/global/events");
  await vi.waitFor(() => expect(f.sseResponses()[0]?.writableNeedDrain).toBe(true));
  const furthest = () => Math.max(0, ...f.reads.map(seqOf));
  await quiescent(furthest, "furthest page read by a backpressured walk");
  expect(furthest(), "the walk has not read the row before it is retired").toBeLessThan(
    retired!.seq,
  );
  const [replacement, later] = ledger.appendBatch([
    { type: "thread.head.updated", payload: { thread_id: "t", project_id: null, revision: 2 } },
    { type: "fixture.small", payload: { after: true } },
  ]);
  const stream = frames(reader);
  stream.consume();
  await vi.waitFor(() => expect(stream.events.at(-1)?.type).toBe("fixture.small"), {
    timeout: 20_000,
  });
  const seqs = stream.events.map((frame) => seqOf(frame.id));
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(seqs).not.toContain(retired!.seq);
  expect(seqs.slice(-2)).toEqual([replacement!.seq, later!.seq]);
  expect(seqs).toHaveLength(502);
});

it("a departed reader and daemon stop end their replays before any further page read", async () => {
  const f = await fixture();
  f.sql.graph.globalEvents.appendBatch(inlineBatch(400));
  const expected = readJournalEvents(f.sql.store, "global", undefined, f.sql.graph.blobs);
  const [leaving, staying] = await Promise.all([1, 2].map(() => f.open("/v2/global/events")));
  await vi.waitFor(() => {
    expect(f.sseResponses()).toHaveLength(2);
    for (const response of f.sseResponses()) expect(response.writableNeedDrain).toBe(true);
  });
  await quiescent(() => f.reads.length, "page reads while both readers are backpressured");
  const readsBefore = f.reads.length;

  leaving!.destroy();
  await vi.waitFor(() => expect(f.sseResponses()).toHaveLength(1));
  await quiescent(() => f.reads.length, "page reads after one reader left");
  expect(f.reads.length).toBe(readsBefore);

  // Stop ends the remaining response; its reader receives only what was already written.
  const stopping = f.stop();
  const stream = frames(staying!);
  stream.consume();
  await stopping;
  await vi.waitFor(() => expect(stream.state.closed).toBe(true));
  expect(f.reads.length).toBe(readsBefore);
  expect(stream.events.length).toBeGreaterThan(0);
  expect(stream.events.length).toBeLessThan(expected.length);
  expect(stream.events.map((frame) => frame.id)).toEqual(
    expected.slice(0, stream.events.length).map((event) => event.cursor),
  );
});
