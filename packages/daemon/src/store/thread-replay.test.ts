import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashJson } from "@claudexor/util";
import { BlobFiles } from "./blob-files.js";
import { setGlobalGenerationInTx } from "./generations.js";
import { bindIdempotencyInTx } from "./idempotency.js";
import { Obligations } from "./obligations.js";
import { createPartition } from "./partitions.js";
import { SqlProjectRouter } from "./project-router.js";
import { SqlProjectStore } from "./projects.js";
import { EngineStore } from "./store.js";
import { findThreadCreationAcross, threadReplayQuery } from "./thread-replay.js";
import { buildNewThread, threadCreationIdempotency } from "../thread-store-support.js";
import { applyThreadMutation, prepareThreadMutation } from "./thread-rows.js";

let root: string,
  store: EngineStore,
  obligations: Obligations,
  projects: SqlProjectStore,
  router: SqlProjectRouter;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-sql-replay-")));
  store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  obligations = new Obligations(store);
  store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  projects = new SqlProjectStore(store, new BlobFiles(store), obligations);
  router = new SqlProjectRouter(projects);
});
afterEach(async () => {
  vi.restoreAllMocks();
  obligations?.close();
  await store?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("thread creation replay before mutable root admission", () => {
  it("replays after root deletion and after the submitted symlink points elsewhere", () => {
    const target = join(root, "target"),
      alternate = join(root, "other"),
      alias = join(root, "alias");
    mkdirSync(target);
    mkdirSync(alternate);
    const linkKind = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(target, alias, linkKind);
    const input = {
      repoRoot: alias,
      idempotency: { key: "creation", client: "test", request: { repoRoot: alias } },
    };
    const thread = router.createThread(input);
    rmSync(alias);
    symlinkSync(alternate, alias, linkKind);
    expect(router.findThreadCreation(input)).toEqual(thread);
    rmSync(target, { recursive: true });
    rmSync(alias);
    expect(router.createThread(input)).toEqual(thread);
    expect(projects.list()).toHaveLength(1);
  });

  it("ignores a foreign request conflict, then checks only the routed scope", () => {
    const a = join(root, "a"),
      b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const one = {
      repoRoot: a,
      idempotency: { key: "same", client: "test", request: { repoRoot: a } },
    };
    const two = {
      repoRoot: b,
      idempotency: { key: "same", client: "test", request: { repoRoot: b } },
    };
    const first = router.createThread(one),
      second = router.createThread(two);
    expect(router.findThreadCreation(two)).toEqual(second);
    expect(first.id).not.toBe(second.id);
    expect(() =>
      router.findThreadCreation({
        ...two,
        idempotency: { ...two.idempotency, request: { repoRoot: b, title: "changed" } },
      }),
    ).toThrow("different request");
    const ephemeral = { ...one, ephemeral: true };
    const global = router.createThread(ephemeral);
    expect(global.id).not.toBe(first.id);
    expect(router.generationForThread(global.id)?.name).toBe("global");
  });

  it("looks up replay by the complete PK for 2000 scopes without hydrating unrelated bodies", () => {
    const input = { key: "scope-key", client: "test", request: { root: "unavailable" } };
    const scopes = Array.from({ length: 2000 }, (_, i) => ({ pid: i + 100, name: `project:${i}` }));
    const thread = buildNewThread({ title: "target" });
    const key = threadCreationIdempotency(scopes[1750]!.name, input)!;
    const prepared = prepareThreadMutation(projects.blobs, {
      threads: [thread],
      threadCreation: { ...key, threadId: thread.id },
    });
    store.transaction(() => applyThreadMutation(store, scopes[1750]!.pid, prepared, "2030"));
    const spy = vi.spyOn(projects.blobs, "read");
    expect(findThreadCreationAcross(store, scopes, input)).toEqual(thread);
    expect(spy).not.toHaveBeenCalled();
    const query = threadReplayQuery(
      scopes.map((scope) => [scope.pid, threadCreationIdempotency(scope.name, input)!.keyDigest]),
    );
    const plan = store.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.values) as Array<{
      detail: string;
    }>;
    expect(
      plan.some((row) =>
        row.detail.includes(
          "SEARCH idempotency USING PRIMARY KEY (owner=? AND pid=? AND key_digest=?)",
        ),
      ),
    ).toBe(true);
    expect(plan.some((row) => row.detail.includes("SCAN idempotency"))).toBe(false);
  });

  it.each([16_383, 16_384])(
    "executes the row-value/json_each boundary for %i scope pairs",
    (count) => {
      const pairs = Array.from({ length: count }, (_, i) => [i + 100, `key-${i}`] as const);
      store.transaction(() =>
        bindIdempotencyInTx(store, {
          owner: "thread",
          pid: pairs[count - 1]![0],
          keyDigest: pairs[count - 1]![1],
          requestDigest: "digest",
          targetId: "thread",
          operation: "thread.create",
          createdAt: "2030",
        }),
      );
      const query = threadReplayQuery(pairs);
      expect(query.sql.includes("json_each")).toBe(count > 16_383);
      expect(store.prepare(query.sql).all(...query.values)).toMatchObject([
        { target_id: "thread" },
      ]);
    },
  );

  it("allows the turn and command owners to bind the identical key digest", () => {
    const thread = router.createThread({});
    const idem = { key: "same", client: "test", request: { prompt: "turn" } };
    const turn = router.createTurn(thread.id, "turn", { idempotency: idem });
    const keyDigest = hashJson({
      client: idem.client,
      partition: "global",
      operation: "thread.turn.create",
      key: idem.key,
    });
    store.transaction(() =>
      bindIdempotencyInTx(store, {
        owner: "command",
        pid: projects.global().pid,
        keyDigest,
        requestDigest: "different-command-request",
        targetId: "command",
        operation: "thread.turn.create",
        createdAt: "2030",
      }),
    );
    expect(router.findTurnByIdempotency(thread.id, idem)).toEqual(turn);
    expect(
      store
        .prepare("SELECT owner FROM idempotency WHERE key_digest=? ORDER BY owner")
        .all(keyDigest),
    ).toEqual([{ owner: "command" }, { owner: "turn" }]);
  });
});
