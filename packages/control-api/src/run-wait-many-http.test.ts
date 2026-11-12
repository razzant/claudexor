import { getEventListeners } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AjvModule from "ajv";
import {
  Agent,
  request,
  type ClientRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { connect, type Socket } from "node:net";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlOperationCatalog,
  ControlProblem,
  RunWaitManyResult,
  RUN_WAIT_MANY_REQUEST_BYTES,
  type ControlRunState,
  type RunObservationRecord,
} from "@claudexor/schema";
import { InteractionRegistry, digestPendingIdentities } from "../../daemon/src/interactions.js";
import { readRunObservations } from "../../daemon/src/run-observation.js";
import { applyCommandInTx, prepareCommandRow } from "../../daemon/src/store/command-rows.js";
import { SqlCommandQueries } from "../../daemon/src/store/command-queries.js";
import { StoreBusyError } from "../../daemon/src/store/errors.js";
import { SqlEventLedger } from "../../daemon/src/store/event-store.js";
import { setGlobalGenerationInTx } from "../../daemon/src/store/generations.js";
import { SqlInteractionStore } from "../../daemon/src/store/interactions.js";
import { runMutation } from "../../daemon/src/store/mutation.js";
import { createPartition } from "../../daemon/src/store/partitions.js";
import { resourceFixture } from "../../daemon/src/store/test-support/resource-fixture.js";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "./daemon-server.js";
import { RefusedBodies } from "./request-body.js";
import type { RunObservationListener } from "./run-wait-many.js";

const fixtureCleanups: Array<() => Promise<void>> = [];
const clients = new Set<ClientRequest>();
const token = "wait-many-http-fixture";
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "X-Claudexor-Protocol-Major": "3",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A hang detector, not a performance promise. Also clears its own timer. */
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("HTTP fixture did not settle")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  for (const client of clients) client.destroy();
  clients.clear();
  try {
    for (const cleanup of fixtureCleanups.splice(0)) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture(observationAvailable = true, pollMs = 1000) {
  const records = new Map<string, RunObservationRecord>();
  const questions = new Map<string, string[] | Error>();
  const listeners = new Set<RunObservationListener>();
  const firstRead = deferred<void>();
  const signals: AbortSignal[] = [];
  const forbidden = {
    enqueue: vi.fn(async () => {
      throw new Error("observer tried to enqueue");
    }),
    cancel: vi.fn(async () => {
      throw new Error("observer tried to cancel");
    }),
    runTimeLimit: vi.fn(async () => {
      throw new Error("observer changed a run deadline");
    }),
    answerInteraction: vi.fn(() => {
      throw new Error("observer tried to answer");
    }),
    sendRunMessage: vi.fn(async () => {
      throw new Error("observer tried to steer");
    }),
    createThreadTurn: vi.fn(async () => {
      throw new Error("observer tried to create a turn");
    }),
    applyThread: vi.fn(async () => {
      throw new Error("observer tried to apply");
    }),
    beginDelivery: vi.fn(async () => {
      throw new Error("observer tried to begin delivery");
    }),
    recordOperatorDecision: vi.fn(() => {
      throw new Error("observer tried to grant approval");
    }),
  };
  const list = vi.fn(async () => {
    throw new Error("wait-many used the old run-list projection");
  });
  const status = vi.fn(async () => {
    throw new Error("wait-many used the run-detail projection");
  });
  const read = (ids: readonly string[], signal?: AbortSignal) =>
    readRunObservations(
      {
        observationRecords: (requested) =>
          [...records.values()].filter(
            (row) =>
              requested.includes(row.jobId) ||
              (row.runId !== null && requested.includes(row.runId)),
          ),
      },
      {
        snapshotPendingIdentities: async (ids) =>
          new Map(
            ids.map((id) => {
              const value = questions.get(id) ?? [];
              return [id, value instanceof Error ? value : digestPendingIdentities(value)] as const;
            }),
          ),
      },
      "11111111-1111-4111-8111-111111111111",
      ids,
      signal,
    );
  const snapshot = vi.fn(async (ids: readonly string[], signal?: AbortSignal) => {
    if (signal) signals.push(signal);
    const rows = await read(ids, signal);
    firstRead.resolve();
    return rows;
  });
  const subscribe = vi.fn((listener: RunObservationListener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  const options: DaemonControlApiOptions = {
    token,
    pollMs,
    daemon: { list, status, ...forbidden },
    services: forbidden,
    runObservations: observationAvailable ? snapshot : undefined,
    runObservationChanges: subscribe,
  };
  const server = new DaemonControlApiServer(options);
  const { host, port } = await server.start();
  const base = `http://${host}:${port}`;
  function seed(
    jobId: string,
    state: ControlRunState = "running",
    runId: string | null = `run-${jobId}`,
  ) {
    records.set(jobId, {
      jobId,
      runId,
      state,
      partition: "global",
      epoch: "epoch-one",
      createdAt: "2026-10-22T00:00:00.000Z",
    });
  }
  /** The store's post-commit notice for a job names the job and its run. */
  function wake(jobId: string) {
    for (const listener of listeners) listener(new Set([jobId, `run-${jobId}`]));
  }
  function raw(
    body?: string | Buffer,
    path = "/v2/runs/wait-many",
    extraHeaders: Record<string, string> = {},
  ) {
    const client = request(`${base}${path}`, {
      method: "POST",
      headers: { ...headers, ...extraHeaders },
    });
    clients.add(client);
    client.on("close", () => clients.delete(client));
    const done = new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>(
      (resolve, reject) => {
        client.on("error", reject);
        client.on("close", () =>
          reject(new Error("HTTP client closed before response completion")),
        );
        client.on("response", (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              status: response.statusCode!,
              body: Buffer.concat(chunks).toString("utf8"),
              headers: response.headers,
            }),
          );
        });
      },
    );
    void done.catch(() => {});
    if (body !== undefined) client.end(body);
    return { client, done };
  }
  const f = {
    server,
    base,
    raw,
    seed,
    read,
    questions,
    wake,
    snapshot,
    firstRead,
    signals,
    subscribe,
    listeners,
    forbidden,
    list,
    status,
  };
  fixtureCleanups.push(async () => {
    await bounded(f.server.stop());
    expect(f.listeners.size).toBe(0);
    for (const forbidden of Object.values(f.forbidden)) expect(forbidden).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.status).not.toHaveBeenCalled();
  });
  return f;
}

async function write(client: ClientRequest, bytes: Buffer) {
  await bounded(
    new Promise<void>((resolve, reject) => {
      client.write(bytes, (error) => (error ? reject(error) : resolve()));
    }),
  );
}

/** One request through `agent`: its status and whether it reused a socket. It
 * settles once the request has also finished sending, so the socket is free. */
function agentSend(agent: Agent, url: string, method: string, body?: Buffer) {
  return new Promise<{ status: number; reused: boolean }>((resolve, reject) => {
    const client = request(url, {
      method,
      headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) },
      agent,
    });
    let status = 0;
    client.on("error", reject);
    client.on("response", (response) => {
      status = response.statusCode!;
      response.resume();
    });
    client.on("close", () => resolve({ status, reused: client.reusedSocket }));
    client.end(body);
  });
}

function paddedBody(size: number) {
  const json = JSON.stringify({ targets: [{ runId: "a" }], waitMs: 0 });
  return Buffer.concat([Buffer.from(json), Buffer.alloc(size - Buffer.byteLength(json), 0x20)]);
}

describe("POST /v2/runs/wait-many over real HTTP", () => {
  it("keeps a completed POST alive, then wakes from the injected compact source without an idempotency key", async () => {
    const f = await fixture();
    f.seed("a");
    f.seed("b", "succeeded");
    const [knownB] = await f.read(["b"]);
    const pending = f.raw(
      JSON.stringify({
        targets: [{ runId: "a" }, { runId: "b", seen: knownB!.token! }, { runId: "run-a" }],
        waitMs: 1000,
      }),
    );
    await bounded(f.firstRead.promise);
    await nextTurn();
    expect(pending.client.writableFinished).toBe(true);
    expect(f.signals[0]).toBeDefined();
    expect(f.signals[0]!.aborted).toBe(false);
    expect(f.listeners.size).toBe(1);
    f.questions.set("run-a", ["question-a"]);
    f.wake("a");
    const response = await bounded(pending.done);
    expect(response.status).toBe(200);
    expect(RunWaitManyResult.parse(JSON.parse(response.body))).toEqual({
      wakeReason: "attention",
      attention: [0, 2],
      summaries: await f.read(["a", "b", "run-a"]),
    });
    expect(f.subscribe).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
    expect(getEventListeners(f.signals[0]!, "abort")).toHaveLength(0);
  });

  it("advertises the schema-owned read-only naturally idempotent operation", async () => {
    const f = await fixture();
    const response = await fetch(`${f.base}/v2/operations`, { headers });
    expect(response.status).toBe(200);
    const catalog = ControlOperationCatalog.parse(await response.json());
    expect(
      catalog.operations.find(
        (operation) => operation.method === "POST" && operation.path === "/v2/runs/wait-many",
      ),
    ).toMatchObject({
      mutability: "read_only",
      idempotency: "natural",
      applicability: "run",
      requestSchema: "RunWaitManyInput",
      responseSchema: "RunWaitManyResult",
      errorSchema: "ControlProblem",
    });
  });

  it("returns a typed unavailable problem when the compact source is absent", async () => {
    const f = await fixture(false);
    const response = await bounded(
      f.raw(JSON.stringify({ targets: [{ runId: "a" }], waitMs: 0 })).done,
    );
    expect([501, 503]).toContain(response.status);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    const problem = ControlProblem.parse(JSON.parse(response.body));
    expect(problem.code).toMatch(/unavailable|unsupported/);
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it("preserves per-target failures and duplicate indexes beside healthy attention on the wire", async () => {
    const f = await fixture();
    f.seed("a", "succeeded");
    f.seed("broken");
    f.questions.set("run-broken", new Error("pending identities unavailable"));
    const ids = ["missing", "a", "broken", "run-a"];
    const response = await bounded(
      f.raw(
        JSON.stringify({
          targets: ids.map((runId) => ({ runId })),
          waitMs: 0,
        }),
      ).done,
    );
    expect(response.status).toBe(200);
    expect(RunWaitManyResult.parse(JSON.parse(response.body))).toEqual({
      wakeReason: "attention",
      attention: [1, 3],
      summaries: await f.read(ids),
    });
  });

  it.each([
    {},
    { targets: [] },
    { targets: [{ runId: " " }] },
    { targets: [{ runId: "a", seen: "not-a-token" }] },
    { targets: [{ runId: "a" }], waitMs: -1 },
    { targets: [{ runId: "a" }], waitMs: 50_001 },
    { targets: [{ runId: "a" }], progress: true },
    { targets: Array.from({ length: 1001 }, () => ({ runId: "a" })) },
  ])("refuses invalid input before discovery/subscription: %j", async (input) => {
    const f = await fixture();
    const response = await bounded(f.raw(JSON.stringify(input)).done);
    expect(response.status).toBe(400);
    ControlProblem.parse(JSON.parse(response.body));
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it("cleans an in-flight snapshot on an actual socket disconnect, with no worker control", async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const exited = deferred<void>();
    let active = 0;
    let readSignal: AbortSignal | undefined;
    f.snapshot.mockImplementationOnce(async (_ids, signal) => {
      readSignal = signal;
      active++;
      entered.resolve();
      try {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return [{ status: null, pending: null, token: null, problem: "not_observed" as const }];
      } finally {
        active--;
        exited.resolve();
      }
    });
    const pending = f.raw(JSON.stringify({ targets: [{ runId: "a" }], waitMs: 1000 }));
    await bounded(entered.promise);
    expect(active).toBe(1);
    pending.client.destroy();
    await bounded(exited.promise);
    await vi.waitFor(() => expect(f.listeners.size).toBe(0));
    expect(active).toBe(0);
    expect(readSignal?.aborted).toBe(true);
    expect(getEventListeners(readSignal!, "abort")).toHaveLength(0);
    const calls = f.snapshot.mock.calls.length;
    f.wake("a");
    await nextTurn();
    expect(f.snapshot).toHaveBeenCalledTimes(calls);
    await bounded(f.server.stop()); // A detached read/handler would keep stop pending.
  });

  it("lets the observer deadline wait for a started read and answers that read's facts", async () => {
    const f = await fixture();
    f.seed("a");
    const entered = deferred<void>();
    const release = deferred<void>();
    let readSignal: AbortSignal | undefined;
    f.snapshot.mockImplementationOnce(async (ids, signal) => {
      readSignal = signal;
      entered.resolve();
      await release.promise;
      return f.read(ids, signal);
    });
    const pending = f.raw(JSON.stringify({ targets: [{ runId: "a" }], waitMs: 30 }));
    let answered = false;
    void pending.done.then(() => {
      answered = true;
    });
    await bounded(entered.promise);
    await sleep(80);
    expect(answered).toBe(false);
    release.resolve();
    const response = await bounded(pending.done);
    expect(response.status).toBe(200);
    expect(RunWaitManyResult.parse(JSON.parse(response.body))).toEqual({
      wakeReason: "timeout",
      attention: [],
      summaries: await f.read(["a"]),
    });
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect(readSignal?.aborted).toBe(false);
    expect(f.listeners.size).toBe(0);
    expect(getEventListeners(readSignal!, "abort")).toHaveLength(0);
  });

  it("answers a wait that a stopping daemon interrupts with a retryable 503", async () => {
    const f = await fixture();
    f.seed("a");
    const pending = f.raw(JSON.stringify({ targets: [{ runId: "a" }], waitMs: 1000 }));
    await bounded(f.firstRead.promise);
    await nextTurn();
    const stopped = f.server.stop();
    const response = await bounded(pending.done);
    expect(response.status).toBe(503);
    expect(ControlProblem.parse(JSON.parse(response.body))).toMatchObject({
      code: "daemon_stopping",
      retryable: true,
    });
    await bounded(stopped);
    expect(f.listeners.size).toBe(0);
  });

  it.each([
    new StoreBusyError("fixture snapshot unavailable"),
    new Error("fixture snapshot failed"),
  ])(
    "projects a throwing snapshot as a request problem and releases the observer: %s",
    async (error) => {
      const f = await fixture();
      f.snapshot.mockRejectedValueOnce(error);
      const response = await bounded(
        f.raw(JSON.stringify({ targets: [{ runId: "a" }], waitMs: 1000 })).done,
      );
      expect(response.status).toBe(error instanceof StoreBusyError ? 503 : 500);
      const problem = ControlProblem.parse(JSON.parse(response.body));
      if (error instanceof StoreBusyError)
        expect(problem).toMatchObject({ code: "store_busy", retryable: true });
      expect(problem).not.toHaveProperty("summaries");
      expect(f.listeners.size).toBe(0);
      await bounded(f.server.stop());
    },
  );

  it("accepts exactly 1MiB raw input and rejects the next byte before discovery", async () => {
    const f = await fixture();
    f.seed("a", "succeeded");
    const admitted = await bounded(f.raw(paddedBody(RUN_WAIT_MANY_REQUEST_BYTES)).done);
    expect(admitted.status).toBe(200);
    expect(RunWaitManyResult.parse(JSON.parse(admitted.body)).attention).toEqual([0]);
    f.snapshot.mockClear();
    f.subscribe.mockClear();
    const refused = await bounded(f.raw(paddedBody(RUN_WAIT_MANY_REQUEST_BYTES + 1)).done);
    expect(refused.status).toBe(413);
    ControlProblem.parse(JSON.parse(refused.body));
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it("admits exactly 1MiB with omitted waitMs through route and observer revalidation", async () => {
    let controls = 155_910;
    const targets = Array.from({ length: 1000 }, () => {
      const count = Math.min(256, controls);
      controls -= count;
      return { runId: "\u0001".repeat(count) + "x".repeat(256 - count) };
    });
    targets[999]!.runId = "€" + "é".repeat(11) + "x".repeat(244);
    const input = { targets };
    const bytes = JSON.stringify(input);
    expect(Buffer.byteLength(bytes, "utf8")).toBe(1_048_576);
    expect(input).not.toHaveProperty("waitMs");
    const f = await fixture();
    // Immediate healthy attention avoids waiting for the effective 25s default.
    f.seed(targets[999]!.runId, "succeeded");
    const admitted = await bounded(f.raw(bytes).done);
    expect(admitted.status).toBe(200);
    const result = RunWaitManyResult.parse(JSON.parse(admitted.body));
    expect(result.wakeReason).toBe("attention");
    expect(result.attention).toEqual([999]);
    expect(result.summaries).toHaveLength(1000);
    expect(result.summaries[999]).toMatchObject({ status: "succeeded", problem: null });
    expect(f.snapshot).toHaveBeenCalledOnce();
    // Repeated handles share one read.
    expect(f.snapshot.mock.calls[0]![0]).toEqual([
      ...new Set(targets.map((target) => target.runId)),
    ]);
    expect(f.subscribe).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);

    f.snapshot.mockClear();
    f.subscribe.mockClear();
    const overLimit = {
      targets: [...targets.slice(0, 999), { runId: "€" + "é".repeat(12) + "x".repeat(243) }],
    };
    const overBytes = JSON.stringify(overLimit);
    expect(Buffer.byteLength(overBytes, "utf8")).toBe(1_048_577);
    const refused = await bounded(f.raw(overBytes).done);
    expect(refused.status).toBe(413);
    ControlProblem.parse(JSON.parse(refused.body));
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it.each(["chunked", "content-length"] as const)(
    "rejects streamed %s excess before upload completion instead of buffering the advertised remainder",
    async (framing) => {
      const f = await fixture();
      const pending = f.raw(
        undefined,
        "/v2/runs/wait-many",
        framing === "chunked"
          ? { "transfer-encoding": "chunked" }
          : { "content-length": String(20 * RUN_WAIT_MANY_REQUEST_BYTES) },
      );
      pending.client.flushHeaders();
      const prefix = paddedBody(RUN_WAIT_MANY_REQUEST_BYTES);
      const upload = (async () => {
        for (let offset = 0; offset < prefix.length; offset += 32_768)
          await write(pending.client, prefix.subarray(offset, offset + 32_768));
        pending.client.write(Buffer.from(" "), () => {});
      })();
      // A declared oversized Content-Length may be refused before any body read.
      // Observe that response even if the in-progress client write then fails.
      void upload.catch(() => {});
      // The server must reject now. The client intentionally never ends the body
      // or sends the remaining advertised 19MiB; waiting for either is a failure.
      const response = await bounded(pending.done);
      expect(pending.client.writableEnded).toBe(false);
      expect(response.status).toBe(413);
      ControlProblem.parse(JSON.parse(response.body));
      expect(f.snapshot).not.toHaveBeenCalled();
      expect(f.subscribe).not.toHaveBeenCalled();
      pending.client.destroy();
      await bounded(Promise.allSettled([upload]));
    },
  );

  it("keeps a keep-alive connection after refusing a large JSON body, so the next request reuses it", async () => {
    const f = await fixture();
    f.seed("a", "succeeded");
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const send = (body: Buffer) => agentSend(agent, `${f.base}/v2/runs/wait-many`, "POST", body);
    try {
      expect((await bounded(send(paddedBody(3 * 1024 * 1024)))).status).toBe(413);
      const next = await bounded(
        send(Buffer.from(JSON.stringify({ targets: [{ runId: "a" }], waitMs: 0 }))),
      );
      expect(next).toEqual({ status: 200, reused: true });
    } finally {
      agent.destroy();
    }
  });

  it("leaves no socket listener behind across many requests on one keep-alive connection", async () => {
    const f = await fixture();
    f.seed("a", "succeeded");
    let serverSocket: Socket | undefined;
    (Reflect.get(f.server, "server") as Server).once("connection", (socket: Socket) => {
      serverSocket = socket;
    });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const wait = Buffer.from(JSON.stringify({ targets: [{ runId: "a" }], waitMs: 0 }));
    try {
      expect(
        (await bounded(agentSend(agent, `${f.base}/v2/runs/wait-many`, "POST", wait))).status,
      ).toBe(200);
      const baseline = serverSocket!.listenerCount("close");
      for (let round = 0; round < 12; round++) {
        const refused = paddedBody(RUN_WAIT_MANY_REQUEST_BYTES + 1);
        expect(
          await bounded(agentSend(agent, `${f.base}/v2/runs/wait-many`, "POST", refused)),
        ).toEqual({ status: 413, reused: true });
        expect(await bounded(agentSend(agent, `${f.base}/healthz`, "GET"))).toEqual({
          status: 200,
          reused: true,
        });
      }
      expect(serverSocket!.listenerCount("close")).toBe(baseline);
    } finally {
      agent.destroy();
    }
  });

  it("answers pipelined requests in order before closing a connection whose refused body is unfinished at stop", async () => {
    const f = await fixture();
    f.seed("job");
    const refused = deferred<void>();
    const discard = RefusedBodies.prototype.discard;
    vi.spyOn(RefusedBodies.prototype, "discard").mockImplementation(function (
      this: RefusedBodies,
      res,
    ) {
      discard.call(this, res);
      if (!res.req.complete) refused.resolve();
    });
    const { hostname, port } = new URL(f.base);
    const socket = connect({ host: hostname, port: Number(port) });
    socket.on("error", () => {});
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    const ended = new Promise<string>((resolve) => socket.once("end", () => resolve(text)));
    const head = (length: number) =>
      `POST /v2/runs/wait-many HTTP/1.1\r\nHost: ${hostname}:${port}\r\nAuthorization: ${headers.authorization}\r\nX-Claudexor-Protocol-Major: 3\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`;
    const wait = JSON.stringify({ targets: [{ runId: "job" }], waitMs: 50_000 });
    socket.write(head(Buffer.byteLength(wait)) + wait);
    await bounded(f.firstRead.promise);
    // Pipelined behind the open wait: a body the route refuses, left unfinished.
    socket.write(head(16 * 1024 * 1024));
    socket.write(Buffer.alloc(3 * 1024 * 1024, 0x20));
    await bounded(refused.promise);
    const stopped = f.server.stop();
    const raw = await bounded(ended);
    expect(raw.indexOf("HTTP/1.1 503 ")).toBe(0);
    expect(raw.indexOf("HTTP/1.1 413 ")).toBeGreaterThan(0);
    expect(raw).toContain('"code":"daemon_stopping"');
    await bounded(stopped);
    socket.destroy();
  });

  it("answers 503 when stop aborts a read that rejects on abort", async () => {
    const f = await fixture();
    const entered = deferred<void>();
    f.snapshot.mockImplementationOnce(
      (_ids, signal) =>
        new Promise<never>((_resolve, reject) => {
          entered.resolve();
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        }),
    );
    const pending = f.raw(JSON.stringify({ targets: [{ runId: "a" }], waitMs: 1000 }));
    await bounded(entered.promise);
    const stopped = f.server.stop();
    const response = await bounded(pending.done);
    expect(response.status).toBe(503);
    expect(ControlProblem.parse(JSON.parse(response.body))).toMatchObject({
      code: "daemon_stopping",
      retryable: true,
    });
    await bounded(stopped);
  });

  it("retains the existing shared-reader 10MiB default for old callers", async () => {
    const f = await fixture();
    const json = JSON.stringify({ protocolMajor: 3, client: "wait-many-http-fixture" });
    const body = Buffer.concat([
      Buffer.from(json),
      Buffer.alloc(10 * 1024 * 1024 - Buffer.byteLength(json), 0x20),
    ]);
    const response = await bounded(f.raw(body, "/v2/handshake").done);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ compatible: true, protocolMajor: 3 });
    expect(f.snapshot).not.toHaveBeenCalled();
  });

  it("keeps strict UTF-8 rejection in the shared reader before schema/discovery", async () => {
    const f = await fixture();
    const bytes = Buffer.concat([
      Buffer.from('{"targets":[{"runId":"'),
      Buffer.from([0xff]),
      Buffer.from('"}],"waitMs":0}'),
    ]);
    const response = await bounded(f.raw(bytes).done);
    expect(response.status).toBe(400);
    expect(ControlProblem.parse(JSON.parse(response.body)).code).toBe("invalid_encoding");
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it("accepts valid multibyte UTF-8 split between real HTTP writes and trims handles", async () => {
    const f = await fixture();
    f.seed("ж", "succeeded");
    const bytes = Buffer.from(JSON.stringify({ targets: [{ runId: " ж " }], waitMs: 0 }));
    const split = bytes.indexOf(Buffer.from("ж")) + 1;
    const pending = f.raw();
    await write(pending.client, bytes.subarray(0, split));
    pending.client.end(bytes.subarray(split));
    const response = await bounded(pending.done);
    expect(response.status).toBe(200);
    expect(RunWaitManyResult.parse(JSON.parse(response.body))).toEqual({
      wakeReason: "attention",
      attention: [0],
      summaries: await f.read(["ж"]),
    });
    expect(f.snapshot.mock.calls[0]![0]).toEqual(["ж"]);
  });
});

const Ajv = AjvModule.default ?? (AjvModule as unknown as typeof AjvModule.default);
/** The published 5.1.0 RunWaitManyResult, byte-for-byte as generated then: the
 * strict reader of an older same-major client that never asks for the opt-in. */
const RESULT_5_1_0 = JSON.parse(
  '{"$ref":"#/definitions/RunWaitManyResult","definitions":{"RunWaitManyResult":{"type":"object","properties":{"wakeReason":{"type":"string","enum":["attention","problems","timeout","aborted"]},"attention":{"type":"array","items":{"type":"integer","minimum":0,"maximum":999},"maxItems":1000},"summaries":{"type":"array","items":{"anyOf":[{"type":"object","properties":{"status":{"type":"string","enum":["queued","running","succeeded","failed","cancelled","interrupted"]},"pending":{"type":"boolean"},"token":{"type":"string","minLength":43,"maxLength":43,"pattern":"^[A-Za-z0-9_-]{43}$"},"problem":{"type":"null"}},"required":["status","pending","token","problem"],"additionalProperties":false},{"type":"object","properties":{"status":{"type":"null"},"pending":{"type":"null"},"token":{"type":"null"},"problem":{"type":"string","enum":["not_found","snapshot_unavailable","not_observed"]}},"required":["status","pending","token","problem"],"additionalProperties":false}]},"minItems":1,"maxItems":1000}},"required":["wakeReason","attention","summaries"],"additionalProperties":false}},"$schema":"http://json-schema.org/draft-07/schema#"}',
);
const readAs5_1_0 = new Ajv({ strict: false }).compile(RESULT_5_1_0);

/** The daemon's own composition: real SQL store, interaction registry and producer. */
async function sqlServer() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-wait-many-blocking-")));
  const store = await resourceFixture(root, { manualTick: true });
  const generation = store.store.transaction(() => {
    const value = createPartition(store.store, "global", { epoch: "1".repeat(32) });
    setGlobalGenerationInTx(store.store, value.pid);
    return value;
  });
  const pending = new SqlInteractionStore(
    store.store,
    new SqlEventLedger(store.store, store.blobs, generation),
  );
  const registry = new InteractionRegistry({ forRequest: () => pending, forRun: () => pending });
  const queries = new SqlCommandQueries(store.store, store.blobs);
  const snapshot = vi.fn(
    (ids: readonly string[], signal?: AbortSignal, options?: { includeBlocking: true }) =>
      readRunObservations(queries, registry, "store-under-test", ids, signal, options),
  );
  const refuse = vi.fn(async () => {
    throw new Error("observer used a mutating or projection service");
  });
  const server = new DaemonControlApiServer({
    token,
    daemon: { list: refuse, status: refuse, enqueue: refuse, cancel: refuse },
    services: {},
    runObservations: snapshot,
    runObservationChanges: (listener) => store.store.observations.subscribe(listener),
  });
  const { host, port } = await server.start();
  const asked: Array<Promise<unknown>> = [];
  const runs = new Set<string>();
  fixtureCleanups.push(async () => {
    await bounded(server.stop());
    for (const runId of runs) registry.dropForRun(runId);
    await Promise.all(asked);
    await store.close();
    rmSync(root, { recursive: true, force: true });
    expect(refuse).not.toHaveBeenCalled();
  });
  return {
    snapshot,
    seed(jobId: string, runId: string) {
      const row = prepareCommandRow(
        {
          id: jobId,
          state: "running",
          runId,
          createdAt: "2026-11-09T00:00:00.000Z",
          params: { mode: "agent" },
        },
        { pid: generation.pid, live: true, operation: "agent", clientId: "fixture" },
        (bytes) => store.blobs.prepareBody(bytes),
      );
      runMutation(store.store, (tx) => applyCommandInTx(tx, row, "accept"));
    },
    /** Asked through the live registry, the same path a harness question takes. */
    ask(runId: string, id: string, delivery: "blocking" | "async") {
      runs.add(runId);
      asked.push(
        registry.register(
          {
            runId,
            taskId: "task",
            attemptId: "a01",
            harnessId: "codex",
            request: { interaction_id: id, source_tool: "fixture", delivery, questions: [] },
            requestedAt: "2026-11-09T00:00:00.000Z",
            timeoutAt: null,
          },
          {},
        ),
      );
    },
    /** A pending row an older engine wrote before delivery existed. */
    legacy(runId: string, id: string) {
      store.store
        .prepare("INSERT INTO interaction(id,pid,run_id,state,request) VALUES(?,?,?,'pending',?)")
        .run(`${runId}\u0000${id}`, generation.pid, runId, Buffer.from("{}"));
    },
    async post(body: unknown) {
      const response = await bounded(
        fetch(`http://${host}:${port}/v2/runs/wait-many`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, body: await response.text() };
    },
  };
}

describe("includeBlocking from the real SQL producer over real HTTP (#628)", () => {
  async function asked() {
    const f = await sqlServer();
    for (const id of ["async", "mixed", "quiet", "legacy"]) f.seed(`job-${id}`, `run-${id}`);
    f.ask("run-async", "a1", "async");
    f.ask("run-mixed", "m1", "async");
    f.ask("run-mixed", "m2", "blocking");
    f.legacy("run-legacy", "l1");
    const targets = ["job-async", "job-mixed", "job-quiet", "run-legacy", "missing"].map(
      (runId) => ({ runId }),
    );
    return { f, targets };
  }

  it("answers an omitted or false opt-in with the old strict bytes and the opt-in with blocking", async () => {
    const { f, targets } = await asked();
    const plain = await f.post({ targets, waitMs: 0 });
    expect(plain.status).toBe(200);
    expect(plain.body).not.toContain("blocking");
    expect(readAs5_1_0(JSON.parse(plain.body))).toBe(true);
    const parsed = RunWaitManyResult.parse(JSON.parse(plain.body));
    expect(plain.body).toBe(JSON.stringify(parsed));
    expect(parsed.attention).toEqual([0, 1, 3]);
    const unasked = await f.post({ targets, waitMs: 0, includeBlocking: false });
    expect(unasked).toEqual(plain);
    expect(f.snapshot.mock.calls.every((call) => call.length === 2)).toBe(true);

    const marked = await f.post({ targets, waitMs: 0, includeBlocking: true });
    expect(marked.status).toBe(200);
    const result = RunWaitManyResult.parse(JSON.parse(marked.body));
    expect(marked.body).toBe(JSON.stringify(result));
    expect(result).toEqual({
      wakeReason: "attention",
      attention: [0, 1, 3],
      summaries: [
        { ...parsed.summaries[0], blocking: false },
        { ...parsed.summaries[1], blocking: true },
        parsed.summaries[2],
        { ...parsed.summaries[3], blocking: true },
        { status: null, pending: null, token: null, problem: "not_found" },
      ],
    });
    // The opt-in shape is exactly what an older strict reader refuses.
    expect(readAs5_1_0(JSON.parse(marked.body))).toBe(false);
    expect(f.snapshot.mock.calls.at(-1)![2]).toEqual({ includeBlocking: true });
  });

  it("wakes an opted-in wait for a newly asked async question and keeps tokens shared", async () => {
    const { f, targets } = await asked();
    const first = RunWaitManyResult.parse(
      JSON.parse((await f.post({ targets, waitMs: 0, includeBlocking: true })).body),
    );
    const seen = targets.map(({ runId }, index) => ({
      runId,
      seen: first.summaries[index]!.token,
    }));
    const waiting = f.post({ targets: seen, waitMs: 1500, includeBlocking: true });
    await vi.waitFor(() => expect(f.snapshot).toHaveBeenCalledTimes(2));
    f.ask("run-quiet", "q1", "async");
    const woke = RunWaitManyResult.parse(JSON.parse((await waiting).body));
    expect(woke.wakeReason).toBe("attention");
    expect(woke.attention).toEqual([2]);
    expect(woke.summaries[2]).toMatchObject({ status: "running", pending: true, blocking: false });
    const plain = RunWaitManyResult.parse(
      JSON.parse((await f.post({ targets: seen, waitMs: 0 })).body),
    );
    // One token per observation: a reader without the opt-in sees the same change.
    expect(plain.attention).toEqual([2]);
    expect(plain.summaries.map((row) => row.token)).toEqual(woke.summaries.map((row) => row.token));
  });

  it.each(["true", 1, null])("refuses includeBlocking %j before any read", async (value) => {
    const { f, targets } = await asked();
    const response = await f.post({ targets, waitMs: 0, includeBlocking: value });
    expect(response.status).toBe(400);
    ControlProblem.parse(JSON.parse(response.body));
    expect(f.snapshot).not.toHaveBeenCalled();
  });
});
