import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_PROTOCOL_MAJOR, ThreadExportManifest } from "@claudexor/schema";
import { DaemonControlApiServer } from "./daemon-server.js";
import { createThreadExport, type ThreadExportDeps } from "./thread-export.js";
import { currentDigests } from "./thread-export-digests.js";
import { buildInventory } from "./thread-export-inventory.js";
import { handleThreadExportRoute } from "./thread-export-routes.js";
import { handleThreadTurnRetry } from "./thread-turn-routes.js";
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";

// Preserve the real filesystem result, but choose the instant Stop arrives:
// after the missing lane's lstat, before inventory/refusal resumes.
const statObservation = vi.hoisted(() => ({ after: null as null | ((path: string) => void) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      try {
        return await actual.lstat(...args);
      } finally {
        statObservation.after?.(String(args[0]));
      }
    }) as typeof actual.lstat,
  };
});

const THREAD = "th-transfer";
const roots: string[] = [];
const servers: Server[] = [];
const controlServers: DaemonControlApiServer[] = [];
afterEachClosed(async () => {
  statObservation.after = null;
  // This test's entries, taken before their closes: a late close never reaches the next test's.
  const ownedRoots = roots.splice(0);
  const ownedControlServers = controlServers.splice(0);
  const ownedServers = servers.splice(0);
  for (const server of ownedControlServers) await server.stop();
  for (const server of ownedServers) await new Promise<void>((done) => server.close(() => done()));
  return () => {
    for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
  };
});

function deps(runDir: string, laneDir: string): ThreadExportDeps {
  const retire = vi.fn();
  const thread = {
    id: THREAD,
    state: "active" as const,
    repo: null,
    workspace: { mode: "delegated" as const, worktree_path: null },
  };
  return {
    thread: () => ({ storeId: "store-1", thread }),
    closure: () => ({
      storeId: "store-1",
      thread,
      headRevision: 1,
      digest: `sha256:${"a".repeat(64)}`,
      turns: [],
      commands: [
        {
          jobId: "job-1",
          runId: "run-1",
          state: "succeeded",
          kind: "product",
          threadId: THREAD,
          turnId: null,
          continueFrom: null,
          delegatedFrom: null,
          runDir,
        },
      ],
      documents: [],
      holds: [],
    }),
    document: () => null,
    nativeLayout: () => null,
    laneCredentialStores: () => [],
    laneDirectory: () => laneDir,
    isolatedWorktreeExists: () => false,
    resolveAttachments: () => [],
    retire,
    operation: () => null,
    settle: (_id, operationId, refusal) => ({
      operationId,
      outcome: refusal ? "refused" : "abandoned",
      code: refusal?.code ?? null,
      message: refusal?.message ?? null,
      settledAt: "2026-11-02T00:00:00.000Z",
    }),
    finishPurge: async () => undefined,
    cleanup: () => null,
    hasPurgeLeftovers: () => false,
  };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cx-export-http-"));
  roots.push(root);
  const runDir = join(root, "run");
  const laneDir = join(root, "lane");
  mkdirSync(runDir);
  const service = createThreadExport(deps(runDir, laneDir));
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    void handleThreadExportRoute(
      {
        services: { threadExport: service },
        json: (response, status, body) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        },
        requestError: (response, error) => {
          const typed = error as { status?: number; code?: string; message: string };
          response.writeHead(typed.status ?? 500, { "content-type": "application/json" });
          response.end(JSON.stringify({ code: typed.code, message: typed.message }));
        },
      },
      req.method!,
      path,
      req,
      res,
    );
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/threads/${THREAD}`;
  const manifest = async () =>
    ThreadExportManifest.parse(await (await fetch(`${base}/export`)).json());
  const item = (exportId: string, itemId: string) =>
    fetch(`${base}/export/${encodeURIComponent(exportId)}/items/${itemId}`);
  return { root, runDir, laneDir, service, base, manifest, item };
}

const hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("thread export transfer over HTTP", () => {
  it("streams past every preview cap without truncation", async () => {
    const f = await fixture();
    // Beyond artifact-read's 4 MiB text and 32 MiB binary caps; sparse to stay cheap.
    const text = "line of text\n".repeat(400_000);
    writeFileSync(join(f.runDir, "big.txt"), text);
    const big = join(f.runDir, "big.bin");
    const fd = openSync(big, "w");
    writeSync(fd, Buffer.from("tail"), 0, 4, 33 * 1024 * 1024);
    closeSync(fd);
    const manifest = await f.manifest();
    for (const [name, size] of [
      ["big.txt", Buffer.byteLength(text)],
      ["big.bin", 33 * 1024 * 1024 + 4],
    ] as const) {
      const entry = manifest.items.find((candidate) => candidate.path.endsWith(`/${name}`))!;
      const response = await f.item(manifest.exportId, entry.itemId);
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.length).toBe(size);
      expect(response.headers.get("etag")).toBe(`"sha256:${hex(bytes)}"`);
      expect(Number(response.headers.get("content-length"))).toBe(size);
    }
  });

  it("serves an empty file, and refuses what is not a transferable item", async () => {
    const f = await fixture();
    writeFileSync(join(f.runDir, "empty"), "");
    const manifest = await f.manifest();
    const empty = manifest.items.find((entry) => entry.path.endsWith("/empty"))!;
    const response = await f.item(manifest.exportId, empty.itemId);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect((await f.item(manifest.exportId, `i${"0".repeat(32)}`)).status).toBe(404);
  });

  it("refuses an item that changed since the manifest, and an export the inventory no longer answers", async () => {
    const f = await fixture();
    const path = join(f.runDir, "state.txt");
    writeFileSync(path, "original");
    const manifest = await f.manifest();
    const entry = manifest.items.find((candidate) => candidate.path.endsWith("/state.txt"))!;
    writeFileSync(path, "changed!");
    const changed = await f.item(manifest.exportId, entry.itemId);
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as any).code).toBe("thread_export_item_changed");
    const other = await f.item(`sha256:${"9".repeat(64)}`, entry.itemId);
    expect(other.status).toBe(409);
    expect(((await other.json()) as any).code).toBe("thread_export_stale");
  });

  it("addresses each transfer by item id: a whole traversal scans no manifest list", async () => {
    // What a traversal costs in comparisons of an item's id, at two sizes. A scan per
    // transfer costs about n²/2; only an addressed lookup stays at nothing as n grows.
    const scanned = async (count: number): Promise<number> => {
      const f = await fixture();
      for (let index = 0; index < count; index += 1)
        writeFileSync(join(f.runDir, `file-${index}.txt`), `${index}`);
      const manifest = await f.manifest();
      const find = Array.prototype.find;
      let comparisons = 0;
      const spy = vi.spyOn(Array.prototype, "find").mockImplementation(function (
        this: unknown[],
        predicate: (value: unknown, index: number, array: unknown[]) => unknown,
        thisArg?: unknown,
      ) {
        const listed = (this[0] as { itemId?: unknown } | undefined)?.itemId !== undefined;
        return find.call(this, (value, index, array) => {
          if (listed) comparisons += 1;
          return predicate.call(thisArg, value, index, array);
        });
      } as typeof find);
      try {
        for (const item of manifest.items)
          expect((await f.item(manifest.exportId, item.itemId)).status).toBe(200);
      } finally {
        spy.mockRestore();
      }
      return comparisons;
    };
    expect({ at40: await scanned(40), at80: await scanned(80) }).toEqual({ at40: 0, at80: 0 });
  });

  it("serves a manifest's items after a restart, with no state but the current inventory", async () => {
    const f = await fixture();
    writeFileSync(join(f.runDir, "a.txt"), "a");
    const manifest = await f.manifest();
    const entry = manifest.items.find((candidate) => candidate.path.endsWith("/a.txt"))!;
    // A fresh process remembers nothing and answers from the same identity.
    const restarted = createThreadExport(deps(f.runDir, f.laneDir));
    const chunks: Buffer[] = [];
    const res = Object.assign(new PassThrough(), { writeHead: () => undefined });
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    await restarted.transferThreadExportItem(THREAD, manifest.exportId, entry.itemId, res as never);
    expect(Buffer.concat(chunks).toString()).toBe("a");
    writeFileSync(join(f.runDir, "b.txt"), "b");
    const moved = createThreadExport(deps(f.runDir, f.laneDir));
    await expect(
      moved.transferThreadExportItem(THREAD, manifest.exportId, entry.itemId, res as never),
    ).rejects.toMatchObject({ code: "thread_export_stale" });
  });

  it("answers one inventory with one id, so a resumed transfer keeps its work", async () => {
    const f = await fixture();
    writeFileSync(join(f.runDir, "a.txt"), "a");
    const first = await f.manifest();
    const second = await f.manifest();
    expect(second.exportId).toBe(first.exportId);
    expect(second.items.map((i) => i.itemId)).toEqual(first.items.map((i) => i.itemId));
    writeFileSync(join(f.runDir, "b.txt"), "b");
    expect((await f.manifest()).exportId).not.toBe(first.exportId);
  });

  it("refuses unknown parameters and another store", async () => {
    const f = await fixture();
    expect((await fetch(`${f.base}/export?surprise=1`)).status).toBe(400);
    const other = await fetch(`${f.base}/export?expectedStoreId=store-2`);
    expect(other.status).toBe(409);
    expect(((await other.json()) as any).code).toBe("store_mismatch");
    expect((await fetch(`${f.base}/export?expectedStoreId=store-1`)).status).toBe(200);
  });

  it("lets the event loop run admission turns while it inventories retained history", async () => {
    const f = await fixture();
    const noise = `${JSON.stringify({ type: "message", text: "x".repeat(4096) })}\n`.repeat(4000);
    for (let index = 0; index < 8; index++)
      writeFileSync(join(f.runDir, `events-${index}.jsonl`), noise);
    let turns = 0;
    let reading = true;
    const counting = (async () => {
      while (reading) {
        turns += 1;
        await nextTurn();
      }
    })();
    await f.service.threadExportManifest(THREAD);
    reading = false;
    await counting;
    // No fixed latency bound: only that other turns ran between its reads.
    expect(turns).toBeGreaterThan(8);
  });
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function bounded<T>(promise: Promise<T>): Promise<T | "timed out"> {
  return Promise.race([
    promise,
    new Promise<"timed out">((done) => setTimeout(() => done("timed out"), 10_000)),
  ]);
}

/**
 * The real control API server over the real export service. The closure holds
 * 40 engine records, so a read in flight is between two of them; once Stop is
 * asked, `readsAfterStop` counts what that read still took.
 */
async function servedExport() {
  const root = mkdtempSync(join(tmpdir(), "cx-export-stop-"));
  roots.push(root);
  const runDir = join(root, "run");
  mkdirSync(runDir);
  writeFileSync(join(runDir, "a.txt"), "a");
  const base = deps(runDir, join(root, "lane"));
  const records = Array.from({ length: 40 }, (_, index) => ({
    key: `record:${index}`,
    path: `sql/records/${String(index).padStart(2, "0")}.json`,
  }));
  const watch = { armed: false, stopAsked: false, readsAfterStop: 0, reached: latch() };
  const settle = vi.fn(base.settle);
  const exportDeps: ThreadExportDeps = {
    ...base,
    settle,
    closure: (id) => ({ ...base.closure(id)!, documents: records }),
    document: (_id, key) => {
      if (watch.armed) {
        if (watch.stopAsked) watch.readsAfterStop += 1;
        watch.reached.resolve();
      }
      return Buffer.from(`${JSON.stringify({ key })}\n`);
    },
  };
  const server = new DaemonControlApiServer({
    token: "stop-token",
    daemon: {} as never,
    services: { threadExport: createThreadExport(exportDeps) },
  });
  controlServers.push(server);
  const { host, port } = await server.start();
  const call = (
    path: string,
    init: { method?: string; body?: string; signal?: AbortSignal } = {},
  ) =>
    fetch(`http://${host}:${port}/v2/threads/${THREAD}${path}`, {
      ...init,
      headers: {
        authorization: "Bearer stop-token",
        "content-type": "application/json",
        "x-claudexor-protocol-major": String(CONTROL_PROTOCOL_MAJOR),
      },
    }).then(
      async (response) => ({ status: response.status, body: await response.text() }),
      (error: unknown) => ({ status: 0, body: String(error) }),
    );
  /** Start a request, ask Stop while it is between two records, await both. */
  const stopWhileReading = async (request: () => ReturnType<typeof call>) => {
    watch.armed = true;
    const answer = request();
    await bounded(watch.reached.promise);
    watch.stopAsked = true;
    const stop = server.stop().then(() => "stopped" as const);
    return { answer: await bounded(answer), stop: await bounded(stop) };
  };
  return { deps: exportDeps, watch, settle, retire: base.retire, call, stopWhileReading };
}

// Stop before acceptance only: a confirmed acceptance and its physical deletion
// are separate phases and are not exercised here.
describe("the control API server's Stop reaches export work in flight", () => {
  it.each([false, true])(
    "keeps the refusal boundary after a missing lane read (Stop: %s)",
    async (stop) => {
      const root = mkdtempSync(join(tmpdir(), "cx-refusal-stop-"));
      roots.push(root);
      const runDir = join(root, "run");
      const laneDir = join(root, "missing-lane");
      mkdirSync(runDir);
      const base = deps(runDir, laneDir);
      const settle = vi.fn(base.settle);
      const service = createThreadExport({ ...base, settle });
      const abort = new AbortController();
      const reason = new Error("controlled Stop after lstat");
      statObservation.after = (path) => {
        if (stop && path === laneDir) {
          statObservation.after = null;
          abort.abort(reason);
        }
      };
      const answer = await service
        .retireThread(
          THREAD,
          {
            operationId: "op-missing-lane",
            exportId: `sha256:${"0".repeat(64)}`,
            closureDigest: `sha256:${"a".repeat(64)}`,
            contentDigest: `sha256:${"b".repeat(64)}`,
            laneDigest: `sha256:${"c".repeat(64)}`,
          },
          abort.signal,
        )
        .catch((error: unknown) => error);
      expect({ stopped: answer === reason, decisions: settle.mock.calls.length }).toEqual({
        stopped: stop,
        decisions: stop ? 0 : 1,
      });
      expect(base.retire).not.toHaveBeenCalled();
      if (!stop)
        expect(answer).toMatchObject({ code: "thread_export_stale", context: { settled: true } });
    },
  );

  /** A read Stop ended is the stopping server's typed answer: repeat it after reconnecting. */
  const stoppingAnswer = (answer: unknown) => {
    expect(answer).toMatchObject({ status: 503 });
    expect(JSON.parse((answer as { body: string }).body)).toMatchObject({
      code: "daemon_stopping",
      retryable: true,
      requiredActions: ["reconnect"],
    });
  };

  it("ends a manifest read", async () => {
    const f = await servedExport();
    const { answer, stop } = await f.stopWhileReading(() => f.call("/export"));
    expect(stop).toBe("stopped");
    expect(f.watch.readsAfterStop).toBe(0);
    stoppingAnswer(answer);
  });

  it("ends a manifest read whose client left, answering nothing, and keeps serving", async () => {
    const f = await servedExport();
    f.watch.armed = true;
    const client = new AbortController();
    const answer = f.call("/export", { signal: client.signal });
    await bounded(f.watch.reached.promise);
    f.watch.stopAsked = true;
    client.abort();
    expect(await answer).toMatchObject({ status: 0 });
    // Its other 39 records stay unread: the read ends at its next one.
    await new Promise((settle) => setTimeout(settle, 100));
    expect(f.watch.readsAfterStop).toBeLessThan(10);
    f.watch.armed = false;
    expect((await f.call("/export")).status).toBe(200);
  });

  it("ends the inventory rebuild an item transfer shares with other waiters", async () => {
    const f = await servedExport();
    // An export another process answered before a restart: this server holds none of it.
    const { manifest } = await buildInventory(f.deps, THREAD);
    const item = manifest.items.find((entry) => entry.path.endsWith("/a.txt"))!;
    const { answer, stop } = await f.stopWhileReading(() =>
      f.call(`/export/${encodeURIComponent(manifest.exportId)}/items/${item.itemId}`),
    );
    expect(stop).toBe("stopped");
    expect(f.watch.readsAfterStop).toBe(0);
    stoppingAnswer(answer);
  });

  it("ends a retirement before its acceptance and binds no outcome", async () => {
    const f = await servedExport();
    // Without Stop this request would be accepted: it names the current export.
    const inventory = await buildInventory(f.deps, THREAD);
    const digests = await currentDigests(f.deps, inventory);
    const request = {
      operationId: "op-stop",
      exportId: inventory.manifest.exportId,
      closureDigest: inventory.manifest.closureDigest,
      contentDigest: digests.content,
      laneDigest: digests.lane,
    };
    const { answer, stop } = await f.stopWhileReading(() =>
      f.call("/retire", { method: "POST", body: JSON.stringify(request) }),
    );
    expect(stop).toBe("stopped");
    expect(f.watch.readsAfterStop).toBe(0);
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.settle).not.toHaveBeenCalled();
    // The outcome stays unknown: the caller repeats this same operation.
    expect(answer).toMatchObject({ status: 503 });
    expect(JSON.parse((answer as { body: string }).body)).toMatchObject({
      code: "thread_retirement_unavailable",
      retryable: true,
    });
  });
});

describe("a purged thread stays terminal", () => {
  it("refuses replaying a refused turn on a purged thread", async () => {
    const json = vi.fn();
    const enqueue = vi.fn();
    await handleThreadTurnRetry(
      {
        threadTurnChains: new Map(),
        threadDetail: async () => ({
          thread: { state: "purged" },
          sessions: [],
          turns: [{ id: "turn", run_id: null, enqueue_error: { retryable: true } }],
        }),
        daemon: { enqueue, list: async () => [] },
        json,
      } as never,
      {} as never,
      "thread",
      "turn",
      "key",
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({
        error: expect.stringContaining("purged"),
        code: "thread_purged",
        retryable: false,
        context: { threadId: "thread", turnId: "turn" },
      }),
    );
  });

  it("answers a retry the engine accepted before the purge with that retry", async () => {
    const json = vi.fn();
    const enqueue = vi.fn();
    const refused = { id: "job-refused", state: "failed", params: { turnId: "turn" } };
    const retried = { id: "job-retried", state: "cancelled", params: { turnId: "turn" } };
    await handleThreadTurnRetry(
      {
        threadTurnChains: new Map(),
        threadDetail: async () => ({
          thread: { state: "purged" },
          sessions: [],
          turns: [{ id: "turn", run_id: null, enqueue_error: { retryable: true } }],
        }),
        daemon: {
          enqueue,
          list: async () => [refused, retried],
          findAccepted: async () => retried,
        },
        waitForRunStart: async () => retried,
        isTerminalState: () => true,
        json,
      } as never,
      {} as never,
      "thread",
      "turn",
      "key",
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      expect.objectContaining({ jobId: "job-retried", state: "cancelled" }),
    );
  });
});
