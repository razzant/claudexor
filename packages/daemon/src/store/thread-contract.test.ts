import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DurableJournal } from "./test-support/fixtures/legacy/journal/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobFiles } from "./blob-files.js";
import { setGlobalGenerationInTx } from "./generations.js";
import { Obligations } from "./obligations.js";
import { runMutation } from "./mutation.js";
import { createPartition } from "./partitions.js";
import { readJournalEvents } from "./cursors.js";
import { EngineStore } from "./store.js";
import { SqlThreadStore } from "./threads.js";
import { legacyOracle } from "./test-support/legacy-oracle.js";
import {
  applyImportedHeadRevision,
  applyThreadMutation,
  prepareThreadMutation,
} from "./thread-rows.js";

const clock = vi.hoisted(() => ({ at: "2030-01-01T00:00:00.000Z", id: 0 }));
vi.mock("@claudexor/util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@claudexor/util")>()),
  nowIso: () => clock.at,
  newId: (prefix: string) => `${prefix}-${++clock.id}`,
}));
vi.mock("./test-support/fixtures/legacy/util/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./test-support/fixtures/legacy/util/index.js")>()),
  nowIso: () => clock.at,
  newId: (prefix: string) => `${prefix}-${++clock.id}`,
}));

let root: string, store: EngineStore, obligations: Obligations, sql: SqlThreadStore;
let journal: DurableJournal, legacy: InstanceType<typeof legacyOracle.daemonThreads.ThreadStore>;
let heads: InstanceType<typeof legacyOracle.daemonThreadHeadPing.ThreadHeadPingEmitter>;
beforeEach(async () => {
  clock.id = 0;
  clock.at = "2030-01-01T00:00:00.000Z";
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-sql-threads-")));
  store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    now: () => new Date(clock.at),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  obligations = new Obligations(store);
  const generation = store.transaction(() => {
    const g = createPartition(store, "global");
    setGlobalGenerationInTx(store, g.pid);
    return g;
  });
  sql = new SqlThreadStore(store, new BlobFiles(store), generation, obligations);
  journal = new DurableJournal({
    rootDir: join(root, "legacy"),
    partition: "global",
    deferCompaction: true,
    now: () => new Date(clock.at),
  });
  heads = new legacyOracle.daemonThreadHeadPing.ThreadHeadPingEmitter(journal);
  legacy = new legacyOracle.daemonThreads.ThreadStore(journal, (ping) => heads.ping(ping));
});
afterEach(async () => {
  journal?.close();
  obligations?.close();
  await store?.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function both<T>(
  fn: (
    s: Pick<
      SqlThreadStore,
      Exclude<
        keyof InstanceType<typeof legacyOracle.daemonThreads.ThreadStore>,
        "validateProjection"
      >
    >,
  ) => T,
): T {
  const start = clock.id;
  const expected = fn(legacy);
  const end = clock.id;
  clock.id = start;
  const actual = fn(sql);
  expect(actual).toEqual(expected);
  expect(clock.id).toBe(end);
  return actual;
}

function parity(id: string): void {
  expect(sql.getThread(id)).toEqual(legacy.getThread(id));
  expect(sql.turnsFor(id)).toEqual(legacy.turnsFor(id));
  expect(sql.sessionsForThread(id)).toEqual(legacy.sessionsForThread(id));
  expect(sql.laneCheckpointsForThread(id)).toEqual(legacy.laneCheckpointsForThread(id));
  expect(sql.resumeMapAuto(id)).toEqual(legacy.resumeMapAuto(id));
  expect(sql.accountBindings(id)).toEqual(legacy.accountBindings(id));
  expect(sql.revision(id)).toBe(heads.revision(id));
}

describe("SQL conversation parity with frozen 820e849cd", () => {
  it("preserves complete turns, initial ordinals, bind conflict and sanitized refusals", () => {
    const thread = both((s) =>
      s.createThread({
        title: "",
        repoRoot: "/fixture",
        workspace: "isolated",
        idempotency: { key: "thread", client: "test", request: { root: "/fixture" } },
      }),
    );
    const prompt = "first\n" + "large conversation 😀\n".repeat(5000);
    const turn = both((s) =>
      s.createTurn(thread.id, prompt, {
        idempotency: { key: "turn", client: "test", request: { prompt } },
      }),
    );
    const second = both((s) => s.createTurn(thread.id, "second"));
    expect([turn.kind, second.kind]).toEqual(["initial", "followup"]);
    both((s) =>
      s.setTurnEnqueueError(turn.id, {
        message: "trust refused",
        code: "trust",
        retryable: true,
        required_actions: ["retry"],
        context: { message: "detail" },
      }),
    );
    both((s) => s.bindTurnRun(turn.id, "run-1"));
    const revision = sql.revision(thread.id);
    both((s) => s.bindTurnRun(turn.id, "run-1"));
    expect(sql.revision(thread.id)).toBe(revision);
    for (const s of [legacy, sql])
      expect(() => s.bindTurnRun(turn.id, "run-2")).toThrow("already bound");
    parity(thread.id);
    const row = store
      .prepare("SELECT body,prompt_sha,ordinal FROM turn WHERE id=?")
      .get(turn.id) as { body: Uint8Array; prompt_sha: string; ordinal: number };
    expect(JSON.parse(Buffer.from(row.body).toString("utf8"))).not.toHaveProperty("prompt");
    expect(row.ordinal).toBe(0);
    expect(sql.getTurn(turn.id)?.prompt).toBe(prompt);
    expect(
      store.prepare("SELECT count(*) AS n FROM event WHERE type='thread.entities_upserted'").get(),
    ).toEqual({ n: 0 });
    const before = sql.revision(thread.id);
    both((s) =>
      s.createTurn(thread.id, prompt, {
        idempotency: { key: "turn", client: "test", request: { prompt } },
      }),
    );
    expect(sql.revision(thread.id)).toBe(before);
  });

  it("keeps folder-only recency, lifecycle no-ops, conversation and keys after purge", () => {
    const thread = both((s) =>
      s.createThread({ idempotency: { key: "thread", client: "test", request: {} } }),
    );
    const turn = both((s) =>
      s.createTurn(thread.id, "retained", {
        idempotency: { key: "turn", client: "test", request: { prompt: "retained" } },
      }),
    );
    clock.at = "2030-01-02T00:00:00.000Z";
    both((s) => s.updateThread(thread.id, { folder: "kept" }));
    expect(sql.getThread(thread.id)?.updated_at).toBe(thread.updated_at);
    both((s) => s.trashThread(thread.id));
    const revision = sql.revision(thread.id);
    both((s) => s.trashThread(thread.id));
    expect(sql.revision(thread.id)).toBe(revision);
    both((s) => s.restoreThread(thread.id));
    both((s) => s.trashThread(thread.id));
    both((s) => s.purgeThread(thread.id));
    both((s) => s.purgeThread(thread.id));
    parity(thread.id);
    expect(sql.listThreads()).toEqual([]);
    expect(sql.getTurn(turn.id)?.prompt).toBe("retained");
    expect(obligations.open()).toMatchObject([
      { kind: "purge_fs", key: thread.id, state: "pending" },
    ]);
    both((s) => s.createThread({ idempotency: { key: "thread", client: "test", request: {} } }));
    both((s) =>
      s.createTurn(thread.id, "retained", {
        idempotency: { key: "turn", client: "test", request: { prompt: "retained" } },
      }),
    );
    expect(store.prepare("SELECT owner FROM idempotency ORDER BY owner").all()).toEqual([
      { owner: "thread" },
      { owner: "turn" },
    ]);
  });

  it("preserves insertion order on tied session/checkpoint times and profile roundtrip", () => {
    const thread = both((s) => s.createThread({}));
    const turn = both((s) => s.createTurn(thread.id, "turn"));
    both((s) => s.recordSession(thread.id, "codex", "native-z", null, "z"));
    both((s) => s.recordSession(thread.id, "codex", "native-a", null, "a"));
    both((s) => s.recordSession(thread.id, "claude", "native-default"));
    both((s) => s.recordLaneCheckpoint(thread.id, "codex", "z", turn.id));
    both((s) => s.recordLaneCheckpoint(thread.id, "codex", "a", turn.id));
    both((s) => s.recordLaneCheckpoint(thread.id, "claude", null, turn.id));
    expect(sql.resumeMapAuto(thread.id).codex?.profileId).toBe("z");
    parity(thread.id);
    const session = sql.sessionsForThread(thread.id).find((s) => s.harness_id === "claude")!;
    both((s) => s.migrateNullProfileContinuity("claude", "named"));
    parity(thread.id);
    expect(sql.sessionsForThread(thread.id).find((s) => s.harness_id === "claude")?.id).toBe(
      session.id,
    );
    expect(sql.laneCheckpoint(thread.id, "claude", null)).toBe(turn.id);
    both((s) => s.rollbackProfileContinuity("claude", "named"));
    parity(thread.id);
    both((s) => s.migrateNullProfileContinuity("claude", "named"));
    parity(thread.id);
    both((s) => s.invalidateCredentialProfile("claude", "named"));
    parity(thread.id);
  });

  it("proves two stable session entities may share a migrated profile", () => {
    const thread = both((s) => s.createThread({}));
    both((s) => s.recordSession(thread.id, "claude", "old-default"));
    both((s) => s.recordSession(thread.id, "claude", "existing-named", null, "named"));
    const before = legacy.sessionsForThread(thread.id);
    both((s) => s.migrateNullProfileContinuity("claude", "named"));
    expect(legacy.sessionsForThread(thread.id)).toHaveLength(2);
    expect(legacy.sessionsForThread(thread.id).map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(legacy.sessionsForThread(thread.id).map((s) => s.profile_id)).toEqual([
      "named",
      "named",
    ]);
    parity(thread.id);
    both((s) => s.recordSession(thread.id, "claude", "next-named", null, "named"));
    parity(thread.id);
    both((s) => s.rollbackProfileContinuity("claude", "named"));
    parity(thread.id);
  });

  it("rolls back entities, binding, prompt ownership and head together", () => {
    const thread = sql.createThread({});
    const before = sql.getThread(thread.id);
    const revision = sql.revision(thread.id);
    store
      .prepare(
        "CREATE TEMP TRIGGER deny_head BEFORE INSERT ON event WHEN new.type='thread.head.updated' BEGIN SELECT RAISE(ABORT,'head fault'); END",
      )
      .run();
    expect(() =>
      sql.createTurn(thread.id, "lost".repeat(30000), {
        idempotency: { key: "rolled", client: "test", request: {} },
      }),
    ).toThrow("head fault");
    expect(sql.turnsFor(thread.id)).toEqual([]);
    expect(sql.getThread(thread.id)).toEqual(before);
    expect(sql.revision(thread.id)).toBe(revision);
    expect(store.prepare("SELECT count(*) AS n FROM idempotency WHERE owner='turn'").get()).toEqual(
      { n: 0 },
    );
    expect(store.prepare("SELECT count(*) AS n FROM blob").get()).toEqual({ n: 0 });
  });

  it("pure imports retain ordinal when a turn is updated, and never advance head", () => {
    const thread = legacy.createThread({});
    legacy.createTurn(thread.id, "one");
    legacy.createTurn(thread.id, "two");
    const turn = legacy.turnsFor(thread.id)[0]!;
    legacy.bindTurnRun(turn.id, "bound");
    for (const record of journal.records(0, ["thread.entities_upserted"])) {
      const prepared = prepareThreadMutation(sql.blobs, record.payload as never);
      store.transaction(() =>
        applyThreadMutation(store, sql.generation.pid, prepared, record.time),
      );
    }
    expect(sql.turnsFor(thread.id)).toEqual(legacy.turnsFor(thread.id));
    expect(sql.revision(thread.id)).toBe(0);
    expect(store.prepare("SELECT ordinal FROM turn ORDER BY ordinal").all()).toEqual([
      { ordinal: 0 },
      { ordinal: 1 },
    ]);
    store.transaction(() => applyImportedHeadRevision(store, thread.id, heads.revision(thread.id)));
    expect(sql.revision(thread.id)).toBe(heads.revision(thread.id));
  });

  it("reopening keeps native sessions, prompts, bindings and exact head revision", async () => {
    const thread = both((s) =>
      s.createThread({ idempotency: { key: "thread", client: "test", request: {} } }),
    );
    const turn = both((s) => s.createTurn(thread.id, "retained prompt"));
    both((s) => s.recordSession(thread.id, "codex", "native"));
    both((s) => s.recordLaneCheckpoint(thread.id, "codex", null, turn.id));
    const generation = sql.generation;
    obligations.close();
    await store.close();
    store = await EngineStore.open({
      daemonDir: join(root, "daemon"),
      workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
      flusherHooks: { manualTick: true },
    });
    obligations = new Obligations(store);
    sql = new SqlThreadStore(store, new BlobFiles(store), generation, obligations);
    parity(thread.id);
    expect(sql.findThreadCreation({ key: "thread", client: "test", request: {} })).toEqual(
      legacy.getThread(thread.id),
    );
  });

  it("keeps legacy null/default checkpoint identity and tied order", () => {
    const thread = both((s) => s.createThread({}));
    const one = both((s) => s.createTurn(thread.id, "one"));
    const two = both((s) => s.createTurn(thread.id, "two"));
    both((s) => s.recordLaneCheckpoint(thread.id, "codex", null, one.id));
    both((s) => s.recordLaneCheckpoint(thread.id, "codex", "default", two.id));
    parity(thread.id);
    expect(sql.laneCheckpoint(thread.id, "codex", null)).toBe(two.id);
    both((s) => s.recordLaneCheckpoint(thread.id, "codex", null, one.id));
    parity(thread.id);
  });

  it("preserves cross-thread ping order during profile migration", () => {
    clock.id = 8;
    const first = both((s) => s.createThread({})),
      second = both((s) => s.createThread({}));
    // th-10 sorts before th-9, but its session was inserted second.
    both((s) => s.recordSession(first.id, "claude", "first"));
    both((s) => s.recordSession(second.id, "claude", "second"));
    both((s) => s.migrateNullProfileContinuity("claude", "named"));
    const expected = journal
      .records(0, ["thread.head.updated"])
      .slice(-2)
      .map(({ seq, time, type, payload }) => ({ seq, time, type, payload }));
    const actual = readJournalEvents(store, "global")
      .filter((e) => e.type === "thread.head.updated")
      .map((e) => ({
        seq: (JSON.parse(Buffer.from(e.cursor, "base64url").toString("utf8")) as { s: number }).s,
        time: e.observedAt,
        type: e.type,
        payload: e.payload,
      }));
    expect(actual).toEqual(expected);
    parity(first.id);
    parity(second.id);
  });

  it("addressed reads hydrate only the chosen prompt across unrelated history", () => {
    const thread = sql.createThread({}),
      turn = sql.createTurn(thread.id, "selected");
    const read = vi.spyOn(sql.blobs, "read");
    for (const count of [100, 1000]) {
      store.transaction(() => {
        const insert = store.prepare(
          "INSERT INTO turn(id,pid,thread_id,ordinal,created_at,prompt_sha,body) VALUES(?,999,?,?,'2000','unavailable',x'00')",
        );
        for (let n = 0; n < count; n++)
          insert.run(`unrelated-${count}-${n}`, `foreign-${count}`, n);
      });
      expect(sql.getTurn(turn.id)?.prompt).toBe("selected");
      expect(read).toHaveBeenCalledTimes(1);
      read.mockClear();
      const plans = store
        .prepare("EXPLAIN QUERY PLAN SELECT body,prompt_sha FROM turn WHERE id=? AND pid=?")
        .all(turn.id, sql.generation.pid) as Array<{ detail: string }>;
      expect(plans.some((p) => p.detail.includes("SEARCH turn USING INDEX"))).toBe(true);
    }
  });

  it("releases the last inline prompt with its row and restores both on rollback", () => {
    const thread = sql.createThread({});
    const first = sql.createTurn(thread.id, "shared");
    const second = sql.createTurn(thread.id, "shared");
    const old = (
      store.prepare("SELECT prompt_sha FROM turn WHERE id=?").get(first.id) as {
        prompt_sha: string;
      }
    ).prompt_sha;
    const replace = (turn: typeof first, prompt: string) => {
      const prepared = sql.prepare({ turns: [{ ...turn, prompt }] });
      runMutation(store, (tx) => sql.applyInTx(tx, prepared));
    };
    replace(first, "new-first");
    expect(sql.blobs.read(old).toString("utf8")).toBe("shared");
    store
      .prepare(
        "CREATE TEMP TRIGGER fail_replacement BEFORE INSERT ON event WHEN new.type='thread.head.updated' BEGIN SELECT RAISE(ABORT,'replacement fault'); END",
      )
      .run();
    expect(() => replace(second, "new-second")).toThrow("replacement fault");
    expect(sql.getTurn(second.id)?.prompt).toBe("shared");
    expect(sql.blobs.read(old).toString("utf8")).toBe("shared");
    store.prepare("DROP TRIGGER fail_replacement").run();
    replace(second, "new-second");
    expect(store.prepare("SELECT 1 FROM blob WHERE sha256=?").get(old)).toBeUndefined();
    expect(sql.getTurn(first.id)?.prompt).toBe("new-first");
    expect(sql.getTurn(second.id)?.prompt).toBe("new-second");
  });
});
