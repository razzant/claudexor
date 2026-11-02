import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "@claudexor/event-log";
import {
  ControlDaemonStatus,
  ControlPendingInteraction,
  ControlRunDetail,
} from "@claudexor/schema";
import { BulkExecutor } from "./bulk-executor.js";
import type { BulkJob, BulkKind, BulkResults } from "./bulk-protocol.js";
import { projectBulkJob } from "./bulk-worker.js";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "./daemon-server.js";
import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: vi.fn(function unexpectedWorker() {
      throw new Error("barrier fixture must not start a worker");
    }),
  };
});

const token = "bulk-barrier-fixture";
const timestamp = "2026-10-27T00:00:00.000Z";
const headers = { authorization: `Bearer ${token}`, "X-Claudexor-Protocol-Major": "3" };
const roots: string[] = [];
const servers: DaemonControlApiServer[] = [];
const sockets: Socket[] = [];
const releases: Array<() => void> = [];

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await server.stop();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(seq: number, type: string, payload: Record<string, unknown> = {}) {
  return (
    JSON.stringify({ seq, type, payload, ts: timestamp, run_id: "run-one", task_id: "task-one" }) +
    "\n"
  );
}

async function fixture(
  options: {
    pending?: () => ControlPendingInteraction[];
    health?: () => void;
    pollMs?: number;
    /** The SQL composition's body-free observation and its post-commit notices. */
    observe?: boolean;
  } = {},
) {
  const runDir = mkdtempSync(join(tmpdir(), "claudexor-bulk-server-"));
  roots.push(runDir);
  mkdirSync(join(runDir, "final"));
  writeFileSync(
    join(runDir, "events.jsonl"),
    event(1, "interaction.requested", { interaction_id: "old" }),
  );
  const record: DaemonRunRecord = {
    id: "job-one",
    runId: "run-one",
    taskId: "task-one",
    state: "running",
    runDir,
    params: { mode: "ask", scope: { kind: "project", root: runDir } },
  };
  const daemon: DaemonFacadeClient = {
    enqueue: async () => ({ id: record.id, state: "queued" }),
    status: async () => structuredClone(record),
    list: async (query) => ("delegatedFromRunId" in query ? [] : [structuredClone(record)]),
    fenceDelegationParent: async () => ({}),
    cancel: async () => {
      record.state = "cancelled";
      return { ok: true };
    },
    health: async () => {
      options.health?.();
      return ControlDaemonStatus.parse({
        ok: true,
        uptime_ms: 1,
        queue: 0,
        running: true,
        active: 1,
        jobs: 1,
        stopping: false,
        servingMode: "normal",
        capacity: { maxConcurrent: 1 },
        loop: null,
        memory: {
          heapUsedBytes: 0,
          heapLimitBytes: 0,
          rssBytes: 0,
          externalBytes: 0,
          nodeHeapArgs: [],
          atAdmission: null,
          sampledAt: timestamp,
        },
      });
    },
  };
  const services: DaemonControlApiOptions["services"] = { pendingInteractions: options.pending };
  const server = new DaemonControlApiServer({
    token,
    daemon,
    services,
    ...(options.pollMs ? { pollMs: options.pollMs } : {}),
    ...(options.observe
      ? {
          runObservations: async (ids: readonly string[]) =>
            ids.map(() => ({
              status: record.state as "running",
              pending: false,
              token: "observed",
              problem: null,
            })),
          runObservationChanges: () => () => {},
        }
      : {}),
  });
  servers.push(server);
  const { host, port } = await server.start();
  const base = `http://${host}:${port}`;
  const get = (path: string, extraHeaders: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers: { ...headers, ...extraHeaders } });
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { server, record, daemon, base, host, port, get, post };
}

const project = (job: BulkJob) => projectBulkJob(job, async () => null);
function jobs(handler: (job: BulkJob) => Promise<BulkResults[BulkKind]>) {
  return vi
    .spyOn(BulkExecutor.prototype, "execute")
    .mockImplementation(((job: BulkJob) =>
      handler(structuredClone(job))) as BulkExecutor["execute"]);
}

describe("bulk projection leaves the HTTP control plane available", () => {
  it("answers handshake, health, status and Stop while detail projection is held at a barrier", async () => {
    const entered = latch();
    const release = latch();
    jobs(async (job) => {
      if (job.kind === "detail") {
        entered.resolve();
        await release.promise;
      }
      return project(job);
    });
    const api = await fixture();
    let detailDone = false;
    const detail = api.get("/v2/runs/run-one").then((response) => {
      detailDone = true;
      return response;
    });
    await entered.promise;
    const responses = await Promise.all([
      api.get("/healthz"),
      api.get("/v2/daemon/status"),
      api.post("/v2/handshake", { protocolMajor: 3, client: "bulk-barrier" }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    await Promise.all(responses.map((response) => response.json()));
    const stopped = await api.post("/v2/runs/run-one/control", { control: { kind: "cancel" } });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ accepted: true });
    expect(api.record.state).toBe("cancelled");
    expect(detailDone).toBe(false);
    release.resolve();
    expect((await detail).status).toBe(200);
    await (await detail).arrayBuffer();
  });

  it("does not create a worker for a health-only embedded server", async () => {
    const api = await fixture();
    expect((await api.get("/healthz")).status).toBe(200);
    expect((await api.post("/v2/handshake", { protocolMajor: 3, client: "embedder" })).status).toBe(
      200,
    );
    expect((await api.get("/v2/daemon/status")).status).toBe(200);
    expect(Worker).not.toHaveBeenCalled();
  });

  it("uses the live event owner's cursor without submitting a file cursor job", async () => {
    const submitted = jobs(project);
    const api = await fixture();
    const path = join(api.record.runDir!, "events.jsonl");
    writeFileSync(path, "");
    // Import the package instance shared with the server so this is its live owner.
    const log = new EventLog(path, "run-one", "task-one");
    try {
      log.emit("run.created");
      appendFileSync(path, '{"seq":99}\n');
      const response = await api.get("/v2/runs/run-one");
      expect(response.status).toBe(200);
      const detail = ControlRunDetail.parse(await response.json());
      expect(detail.lastSeq).toBe(1);
      expect(detail.timeline[0]?.type).toBe("run.created");
      expect(submitted.mock.calls.map(([job]) => job.kind)).toEqual(["detail"]);
      const job = submitted.mock.calls[0]![0];
      expect(job.kind === "detail" && job.input.cursor).toBe(1);
    } finally {
      log.dispose();
    }
  });

  it("tails a quiet live run with one replay job per new event and no command hydration", async () => {
    const submitted = jobs(project);
    const api = await fixture({ pollMs: 5, observe: true });
    const status = vi.spyOn(api.daemon, "status");
    const path = join(api.record.runDir!, "events.jsonl");
    writeFileSync(path, "");
    // Import the package instance shared with the server so this is its live owner.
    const log = new EventLog(path, "run-one", "task-one");
    const replays = () =>
      submitted.mock.calls.filter(([job]) => job.kind === "event-replay").length;
    const polls = () => new Promise((resolve) => setTimeout(resolve, 100));
    try {
      log.emit("run.created");
      const response = await api.get("/v2/runs/run-one/events");
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const until = async (needle: string) => {
        while (!text.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`stream ended before ${JSON.stringify(needle)}`);
          text += decoder.decode(value, { stream: true });
        }
      };
      await until("id: 1\n");
      await polls();
      expect(replays()).toBe(1);
      log.emit("harness.event", { text: "progress" });
      await until("id: 2\n");
      await polls();
      expect(replays()).toBe(2);
      log.emit("run.completed");
      await until("event: end\n");
      expect(status).not.toHaveBeenCalled();
      await reader.cancel();
    } finally {
      log.dispose();
    }
  });

  it("fences before pending rows and replays question replacement and terminal appends during queued detail", async () => {
    const cursorRead = latch();
    const releaseCursor = latch();
    const detailQueued = latch();
    const releaseDetail = latch();
    let pending = [
      ControlPendingInteraction.parse({
        interactionId: "old",
        runId: "run-one",
        requestedAt: timestamp,
      }),
    ];
    const readPending = vi.fn(() => pending);
    jobs(async (job) => {
      if (job.kind === "cursor") {
        const value = await project(job);
        cursorRead.resolve();
        await releaseCursor.promise;
        return value;
      }
      if (job.kind === "detail") {
        detailQueued.resolve();
        await releaseDetail.promise;
      }
      return project(job);
    });
    const api = await fixture({ pending: readPending });
    const response = api.get("/v2/runs/run-one");
    await cursorRead.promise;
    expect(readPending).not.toHaveBeenCalled();
    pending = [
      ControlPendingInteraction.parse({
        interactionId: "replacement",
        runId: "run-one",
        requestedAt: timestamp,
      }),
    ];
    appendFileSync(
      join(api.record.runDir!, "events.jsonl"),
      event(2, "interaction.requested", { interaction_id: "replacement" }),
    );
    releaseCursor.resolve();
    await detailQueued.promise;
    pending = [];
    writeFileSync(join(api.record.runDir!, "final/answer.md"), "Complete terminal answer.\n");
    appendFileSync(
      join(api.record.runDir!, "events.jsonl"),
      event(3, "output.ready", { kind: "answer", path: "final/answer.md" }) +
        event(4, "run.completed"),
    );
    api.record.state = "succeeded";
    releaseDetail.resolve();
    const snapshot = ControlRunDetail.parse(await (await response).json());
    expect(snapshot.lastSeq).toBe(1);
    expect(snapshot.pendingInteractions.map((row) => row.interactionId)).toEqual(["replacement"]);
    expect(snapshot.summary.state).toBe("running");
    expect(snapshot.primaryOutput?.text).toBe("Complete terminal answer.\n");
    expect(snapshot.timeline.at(-1)?.type).toBe("run.completed");
    const stream = await api.get("/v2/runs/run-one/events", {
      "Last-Event-ID": String(snapshot.lastSeq),
    });
    expect(stream.status).toBe(200);
    const replay = await stream.text();
    expect([...replay.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))).toEqual([
      2, 3, 4,
    ]);
    expect(replay.indexOf("event: output.ready")).toBeLessThan(
      replay.indexOf("event: run.completed"),
    );
  });

  it("keeps pipelined responses in request order on one keep-alive socket", async () => {
    const entered = latch();
    const release = latch();
    const healthEntered = latch();
    jobs(async (job) => {
      if (job.kind === "detail") {
        entered.resolve();
        await release.promise;
      }
      return project(job);
    });
    const api = await fixture({ health: healthEntered.resolve });
    const socket = connect({ host: api.host, port: api.port });
    sockets.push(socket);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = once(socket, "end");
    await once(socket, "connect");
    const request = (path: string, connection: string) =>
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${api.port}\r\nAuthorization: Bearer ${token}\r\nX-Claudexor-Protocol-Major: 3\r\nConnection: ${connection}\r\n\r\n`;
    socket.write(request("/v2/runs/run-one", "keep-alive") + request("/v2/daemon/status", "close"));
    await Promise.all([entered.promise, healthEntered.promise]);
    release.resolve();
    await ended;
    const bodies = responseBodies(Buffer.concat(chunks));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ summary: { runId: "run-one" } });
    expect(bodies[1]).toMatchObject({ ok: true, uptime_ms: 1 });
  });
});

/** Decode just the two complete HTTP/1 responses captured by the socket test. */
function responseBodies(wire: Buffer): unknown[] {
  const bodies: unknown[] = [];
  let offset = 0;
  while (offset < wire.length) {
    const end = wire.indexOf("\r\n\r\n", offset);
    expect(end).toBeGreaterThanOrEqual(offset);
    const header = wire.subarray(offset, end).toString("ascii");
    expect(header).toMatch(/^HTTP\/1\.1 200 /);
    offset = end + 4;
    const chunks: Buffer[] = [];
    if (/transfer-encoding: chunked/i.test(header)) {
      for (;;) {
        const sizeEnd = wire.indexOf("\r\n", offset);
        const size = Number.parseInt(wire.subarray(offset, sizeEnd).toString("ascii"), 16);
        expect(Number.isFinite(size)).toBe(true);
        offset = sizeEnd + 2;
        if (size === 0) {
          offset += 2;
          break;
        }
        chunks.push(wire.subarray(offset, offset + size));
        offset += size + 2;
      }
    } else {
      const length = Number(header.match(/content-length: (\d+)/i)?.[1]);
      expect(Number.isFinite(length)).toBe(true);
      chunks.push(wire.subarray(offset, offset + length));
      offset += length;
    }
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }
  return bodies;
}
