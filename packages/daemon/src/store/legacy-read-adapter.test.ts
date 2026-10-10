import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "@claudexor/journal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandStore } from "../command-store.js";
import { DaemonLocalClient } from "../daemon-local-client.js";
import { DaemonServer } from "../server.js";
import type { CommandBackend } from "../command-authority.js";
import type { CommandStorePort } from "../store-contracts.js";
import { legacyCommandBackend } from "./legacy-read-adapter.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function stores() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-port-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let tick = 0;
  const create = (partition: string) => {
    const journal = new DurableJournal({ rootDir: root, partition });
    cleanup.push(() => journal.close());
    return new CommandStore(journal, () => new Date(Date.UTC(2020, 0, 1, 0, 0, tick++)));
  };
  const global = create("global"),
    project = create("project:p");
  const backend = legacyCommandBackend({ current: () => global, all: () => [global, project] });
  const accept = (store: CommandStore, id: string, params: unknown = {}) =>
    store.accept({ id, params, idempotencyKey: id, clientId: "test" }).record;
  return { root, global, project, backend, accept };
}

describe("legacy command boundary", () => {
  it("keeps all-kind activity separate from product pages and addressed details", () => {
    const { global, project, backend, accept } = stores();
    accept(global, "first", { prompt: "full first prompt", threadId: "thread-a" });
    accept(project, "second", { prompt: "full second prompt" });
    accept(global, "model", { kind: "model" });
    accept(project, "delivery-hidden", { prompt: "delivery copy" });
    project.update("second", { runId: "run-second", state: "succeeded" });
    expect(backend.queries.count()).toBe(4);
    expect(backend.queries.active().map((row) => row.id)).toEqual([
      "first",
      "model",
      "delivery-hidden",
    ]);
    const page = backend.queries.publicList({ page: { limit: 1, state: null, cursor: null } });
    expect(page.map((row) => row.id)).toEqual(["second", "first"]); // includes next-page sentinel
    expect(page[0]!.params).not.toHaveProperty("prompt");
    expect(backend.queries.publicList({ id: "run-second" })[0]!.params).toEqual({
      prompt: "full second prompt",
    });
    expect(backend.queries.getByRunId("run-second")?.id).toBe("second");
    expect(backend.findById?.("second")?.get("second")?.runId).toBe("run-second");
  });

  it("keeps continuation order and performs one global prune across partitions", () => {
    const { global, project, backend, accept } = stores();
    for (const [store, id] of [
      [global, "a"],
      [project, "b"],
      [global, "c"],
      [project, "d"],
    ] as const) {
      accept(store, id);
      store.update(id, { state: "succeeded", finishedAt: "2020-01-02T00:00:00.000Z" });
    }
    global.update("c", { runId: "run-c" });
    accept(project, "successor", { continueFrom: "run-c" });
    project.update("successor", { runId: "run-next", state: "failed" });
    accept(global, "tail", { continueFrom: "run-next" });
    expect(backend.queries.select({ continuationChainOf: "run-c" }).map((row) => row.id)).toEqual([
      "c",
      "tail",
      "successor",
    ]); // legacy store order, not a newly sorted chain
    expect(backend.pruneHistory(2, 1000, Date.parse("2020-02-01T00:00:00.000Z"))).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(global.get("a")).toBeUndefined();
    expect(project.get("b")).toBeUndefined();
    expect(project.get("successor")).toBeDefined();
  });

  it("serves and schedules a structural backend without any enumeration member", async () => {
    const { root, global, backend: legacy } = stores();
    // A structural backend deliberately exposes no records(), count or journal.
    const port: CommandStorePort = {
      accept: global.accept.bind(global),
      find: global.find.bind(global),
      get: global.get.bind(global),
      update: global.update.bind(global),
      prune: global.prune.bind(global),
      prunedScopeRoots: global.prunedScopeRoots.bind(global),
      recoverDurableTerminal: global.recoverDurableTerminal.bind(global),
      flushed: global.flushed.bind(global),
    };
    const active = vi.fn(() => {
      throw new Error("admission history read forbidden");
    });
    vi.spyOn(global, "records").mockImplementation(() => {
      throw new Error("legacy scan forbidden");
    });
    const commands: CommandBackend = {
      forRequest: () => port,
      findById: () => port,
      queries: {
        getByRunId: vi.fn(() => undefined),
        select: vi.fn(() => []),
        publicList: vi.fn(() => []),
        active,
        count: vi.fn(() => 37),
      },
      pruneHistory: vi.fn(() => []),
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = vi.fn(async () => {
      await held;
      return { lifecycle: "succeeded" };
    });
    const server = new DaemonServer({
      socketPath: join(root, "unused.sock"),
      token: "fixture",
      commands,
      runner,
      maxConcurrent: 1,
    });
    const client = new DaemonLocalClient(() => server);
    try {
      const accepted = await client.enqueue(
        { mode: "ask", prompt: "one request" },
        { idempotencyKey: "one", clientId: "test" },
      );
      expect(runner).toHaveBeenCalledOnce();
      const queued = await client.enqueue(
        { mode: "ask", prompt: "second request" },
        { idempotencyKey: "two", clientId: "test" },
      );
      expect(runner).toHaveBeenCalledOnce();
      expect(await client.status(queued.id)).toMatchObject({ state: "queued" });
      expect(active).not.toHaveBeenCalled();
      expect(await client.status(accepted.id)).toMatchObject({ state: "running" });
      expect(await client.list({ activeOnly: true })).toEqual([]);
      expect(commands.queries.publicList).toHaveBeenCalledWith({ activeOnly: true });
      expect(await server.dispatch("claudexor.health", {})).toMatchObject({ jobs: 37, active: 1 });
      expect(port).not.toHaveProperty("records");
      expect(await client.status(accepted.id)).toMatchObject({ state: "running" });
      await expect(client.list({ activeOnly: true })).resolves.toEqual([]);
      expect(() => legacy.queries.active()).toThrow("legacy scan forbidden");
      release();
      await vi.waitFor(() => expect(global.get(queued.id)?.state).toBe("succeeded"));
      expect(runner).toHaveBeenCalledTimes(2);
      expect(active).not.toHaveBeenCalled();
    } finally {
      release();
      await server.stop();
    }
  });
});
