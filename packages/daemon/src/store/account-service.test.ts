import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CredentialProfile } from "@claudexor/schema";
import { createAccountEvidence } from "../account-evidence.js";
import { createPartition } from "./partitions.js";
import { setGlobalGenerationInTx } from "./generations.js";
import {
  ENGINE_APPLICATION_ID,
  ENGINE_SCHEMA_VERSION,
  ENGINE_TABLES,
  readSchemaIdentity,
} from "./schema.js";
import { createSqlDaemonServices } from "./sql-daemon-services.js";
import { EngineStore } from "./store.js";
import { builtWorker } from "./test-support/resource-fixture.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

/**
 * The engine-store DDL exactly as schema version 1 shipped it (engine 4.1.0,
 * commit 211a8f52 `ENGINE_SCHEMA_SQL`), frozen here as the upgrade fixture:
 * never regenerate it from the current schema.
 */
const V1_DDL = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE partition(id INTEGER PRIMARY KEY, name TEXT NOT NULL, epoch TEXT NOT NULL, status TEXT NOT NULL,
  next_seq INTEGER NOT NULL, project_id TEXT, created_at TEXT NOT NULL, UNIQUE(name, epoch)) STRICT;
CREATE TABLE event(pid INTEGER NOT NULL, seq INTEGER NOT NULL, time TEXT NOT NULL, type TEXT NOT NULL,
  payload BLOB NOT NULL, payload_sha TEXT, slot_key TEXT, group_key TEXT, PRIMARY KEY(pid, seq)) WITHOUT ROWID, STRICT;
CREATE INDEX event_type    ON event(pid, type, seq);
CREATE INDEX event_slot    ON event(pid, slot_key)  WHERE slot_key  IS NOT NULL;
CREATE INDEX event_group   ON event(pid, group_key) WHERE group_key IS NOT NULL;
CREATE INDEX event_payload ON event(payload_sha)    WHERE payload_sha IS NOT NULL;
CREATE INDEX event_command_age ON event(time,pid,seq) WHERE type IN ('command.accepted','command.updated');
CREATE TABLE blob(sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, inline BLOB) STRICT;
CREATE TABLE command(id TEXT PRIMARY KEY, pid INTEGER NOT NULL, operation TEXT NOT NULL, state TEXT NOT NULL, client_id TEXT,
  run_id TEXT, task_id TEXT, run_dir TEXT, thread_id TEXT, turn_id TEXT, delegated_from TEXT, continue_from TEXT, scope_root TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, summary BLOB NOT NULL, params_sha TEXT NOT NULL, result_sha TEXT,
  error BLOB, last_event_seq INTEGER, response_state TEXT, response_expires_at TEXT, request_resource_id TEXT, response_resource_id TEXT,
  kind TEXT NOT NULL, live INTEGER NOT NULL DEFAULT 1, needs_decision INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX command_run       ON command(run_id);
CREATE INDEX command_partition ON command(pid);
CREATE INDEX command_active    ON command(state, pid) WHERE live = 1 AND state IN ('queued','running');
CREATE INDEX command_thread    ON command(thread_id, state);
CREATE INDEX command_turn      ON command(turn_id, created_at);
CREATE INDEX command_request_resource ON command(request_resource_id) WHERE request_resource_id IS NOT NULL;
CREATE INDEX command_response_resource ON command(response_resource_id) WHERE response_resource_id IS NOT NULL;
CREATE INDEX command_parent    ON command(delegated_from);
CREATE INDEX command_continue  ON command(continue_from);
CREATE INDEX command_list      ON command(created_at DESC, id DESC)        WHERE live = 1 AND kind = 'product';
CREATE INDEX command_list_state ON command(state, created_at DESC, id DESC) WHERE live = 1 AND kind = 'product';
CREATE INDEX command_terminal  ON command(created_at, id)
  WHERE live = 1 AND kind IN ('product','delivery','maintenance') AND finished_at IS NOT NULL;
CREATE INDEX command_prunable  ON command(created_at, id)
  WHERE live = 1 AND kind IN ('product','delivery','maintenance') AND finished_at IS NOT NULL AND needs_decision = 0;
CREATE INDEX command_expiry    ON command(response_state, response_expires_at) WHERE kind = 'model';
CREATE INDEX command_maintenance_harness ON command(json_extract(CAST(summary AS TEXT),'$.params.harness'),created_at)
  WHERE live=1 AND kind='maintenance';
CREATE INDEX command_params    ON command(params_sha);
CREATE INDEX command_result    ON command(result_sha) WHERE result_sha IS NOT NULL;
CREATE TABLE run_terminal(run_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, event BLOB NOT NULL) STRICT;
CREATE TABLE effect_obligation(kind TEXT NOT NULL, key TEXT NOT NULL, pid INTEGER NOT NULL, created_at TEXT NOT NULL, payload BLOB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', materialized_g INTEGER, PRIMARY KEY(kind, key)) WITHOUT ROWID, STRICT;
CREATE TABLE idempotency(owner TEXT NOT NULL, pid INTEGER NOT NULL, key_digest TEXT NOT NULL, operation TEXT NOT NULL,
  request_digest TEXT NOT NULL, target_id TEXT NOT NULL, result BLOB, created_at TEXT NOT NULL,
  PRIMARY KEY(owner, pid, key_digest)) WITHOUT ROWID, STRICT;
CREATE INDEX idempotency_target ON idempotency(target_id);
CREATE TABLE thread(id TEXT PRIMARY KEY, pid INTEGER NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL,
  head_revision INTEGER NOT NULL DEFAULT 0, body BLOB NOT NULL) STRICT;
CREATE INDEX thread_list ON thread(pid, state, updated_at DESC);
CREATE TABLE turn(id TEXT PRIMARY KEY, pid INTEGER NOT NULL, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, run_id TEXT,
  created_at TEXT NOT NULL, prompt_sha TEXT NOT NULL, body BLOB NOT NULL) STRICT;
CREATE UNIQUE INDEX turn_thread ON turn(thread_id, ordinal);
CREATE UNIQUE INDEX turn_run    ON turn(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX turn_prompt        ON turn(prompt_sha);
CREATE TABLE session(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, harness_id TEXT NOT NULL, profile_id TEXT NOT NULL DEFAULT '', pid INTEGER NOT NULL,
  insertion_ordinal INTEGER NOT NULL DEFAULT 0, body BLOB NOT NULL) WITHOUT ROWID, STRICT;
CREATE INDEX session_lane ON session(thread_id, harness_id, profile_id);
CREATE INDEX session_order ON session(thread_id, insertion_ordinal);
CREATE INDEX session_partition ON session(pid, insertion_ordinal);
CREATE TABLE lane_checkpoint(thread_id TEXT NOT NULL, harness_id TEXT NOT NULL, profile_id TEXT NOT NULL DEFAULT '', pid INTEGER NOT NULL,
  insertion_ordinal INTEGER NOT NULL DEFAULT 0, turn_id TEXT NOT NULL, body BLOB NOT NULL, PRIMARY KEY(thread_id, harness_id, profile_id)) WITHOUT ROWID, STRICT;
CREATE INDEX lane_checkpoint_order ON lane_checkpoint(thread_id, insertion_ordinal);
CREATE INDEX lane_checkpoint_partition ON lane_checkpoint(pid, insertion_ordinal);
CREATE TABLE interaction(id TEXT PRIMARY KEY, pid INTEGER NOT NULL, run_id TEXT NOT NULL, state TEXT NOT NULL,
  request BLOB NOT NULL, resolution BLOB) STRICT;
CREATE INDEX interaction_pending ON interaction(run_id) WHERE state = 'pending';
CREATE INDEX interaction_run ON interaction(run_id);
CREATE INDEX interaction_partition_pending ON interaction(pid,run_id) WHERE state = 'pending';
CREATE TABLE operator_decision(run_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, body BLOB NOT NULL) STRICT;
CREATE TABLE project(id TEXT PRIMARY KEY, pid INTEGER NOT NULL, root TEXT NOT NULL, status TEXT NOT NULL,
  current_pid INTEGER, creation_key_digest TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body BLOB NOT NULL) STRICT;
CREATE UNIQUE INDEX project_root_active ON project(pid, root) WHERE status = 'active';
CREATE INDEX project_current_pid ON project(current_pid) WHERE status = 'active';
CREATE TABLE pruned_root(root TEXT PRIMARY KEY) STRICT;
CREATE TABLE resource(id TEXT PRIMARY KEY, purpose TEXT, kind TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  state TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, released_at TEXT, body BLOB NOT NULL) STRICT;
CREATE INDEX resource_sha    ON resource(sha256);
CREATE INDEX resource_expiry ON resource(state, expires_at);
CREATE TABLE upload(id TEXT PRIMARY KEY, state TEXT NOT NULL, received_bytes INTEGER NOT NULL, expected_bytes INTEGER,
  finalize_sha TEXT, body BLOB NOT NULL) STRICT;
CREATE INDEX upload_finalize ON upload(finalize_sha) WHERE finalize_sha IS NOT NULL;
CREATE TABLE import_partition(name TEXT PRIMARY KEY, status TEXT NOT NULL, pid INTEGER, epoch TEXT, next_seq INTEGER,
  previous_frame_hash TEXT, source_size INTEGER, source_mtime TEXT, fingerprint TEXT, records INTEGER, digest TEXT, problem TEXT) STRICT;
CREATE TABLE unclassified(pid INTEGER NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, reason TEXT NOT NULL, payload BLOB NOT NULL,
  PRIMARY KEY(pid, seq)) WITHOUT ROWID, STRICT;
`;
const V1_TABLES = [...V1_DDL.matchAll(/CREATE TABLE (\w+)\(/g)].map((match) => match[1]!);

const cleanups: Array<() => Promise<void> | void> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-account-service-"));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Real SQL owners over a private root; reopening the same root gives NEW objects. */
async function openGraph(root: string, now?: () => Date) {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorker("flusher-worker.js"),
    ...(now ? { now } : {}),
  });
  const global = store.prepare("SELECT value FROM meta WHERE key='global_pid'").get();
  if (!global)
    store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
  let closing: Promise<void> | undefined;
  /** One close: a later caller gets its outcome, not a success it never saw (#376). */
  const close = () =>
    (closing ??= (async () => {
      await graph.close();
      await store.close();
    })());
  cleanups.push(close);
  return { store, graph, close };
}

const profile = (id: string, overrides: Partial<CredentialProfile> = {}): CredentialProfile => ({
  ...CredentialProfile.parse({
    harness_id: "fake",
    profile_id: id,
    display_name: id,
    credential_kind: "config_dir_login",
    isolation_locator: `/tmp/cx-account-service/${id}`,
    created_at: "2026-10-12T00:00:00.000Z",
  }),
  ...overrides,
});
const producer = (runId: string, tryIndex = 0) => ({ runId, attemptId: `${runId}-a1`, tryIndex });
const order = (
  services: NonNullable<ReturnType<typeof createAccountEvidence>["services"]>,
  model: string | null,
  rows: CredentialProfile[],
) => Object.fromEntries(services.orders("fake", model, rows));

/** Every row of every table, in a stable order independent of the physical layout. */
function dump(db: { prepare(sql: string): { all(): unknown[] } }, tables: readonly string[]) {
  const key = (row: unknown) =>
    JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? [...v] : v));
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => ({ ...(row as object) }))
        .sort((x, y) => key(x).localeCompare(key(y))),
    ]),
  );
}

describeStore("durable last-served facts (engine store schema v2)", () => {
  it("upgrades a real v1 store to the current version: keeps every row and adds only expected schema objects", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "daemon"), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const v1 = new DatabaseSync(join(root, "daemon", "engine.sqlite"));
    v1.exec("PRAGMA journal_mode=WAL");
    v1.exec(V1_DDL);
    v1.exec(`PRAGMA application_id=${ENGINE_APPLICATION_ID}`);
    for (const [key, value] of [
      ["schema_version", "1"],
      ["store_id", "11111111-1111-4111-8111-111111111111"],
      ["created_at", "2026-10-01T00:00:00.000Z"],
      ["global_pid", "1"],
    ])
      v1.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run(key, value);
    v1.exec(`
      INSERT INTO partition(id,name,epoch,status,next_seq,project_id,created_at)
        VALUES(1,'global','e1','ready',3,NULL,'2026-10-01T00:00:00.000Z');
      INSERT INTO thread(id,pid,state,updated_at,head_revision,body)
        VALUES('th-1',1,'active','2026-10-01T00:00:01.000Z',2,x'7b7d');
      INSERT INTO session(id,thread_id,harness_id,profile_id,pid,insertion_ordinal,body)
        VALUES('ses-1','th-1','codex','work',1,1,x'7b7d');
      INSERT INTO event(pid,seq,time,type,payload)
        VALUES(1,1,'2026-10-01T00:00:02.000Z','thread.created',x'7b7d'),
              (1,2,'2026-10-01T00:00:03.000Z','quota.observed',x'7b2261223a317d');
      PRAGMA user_version=1;
    `);
    const before = dump(v1, V1_TABLES);
    v1.close();
    // Version 2 adds account_last_service; version 3 adds task-group indexes.
    // Version 4 adds deferred_message and its four indexes; v5 adds turn_plan_answer.
    // Version 6 moves task-group membership into a column and rebuilds both group
    // indexes on it.
    expect([...ENGINE_TABLES].sort()).toEqual(
      [...V1_TABLES, "account_last_service", "deferred_message"].sort(),
    );

    const upgraded = await openGraph(root);
    expect(readSchemaIdentity(upgraded.store.db)).toMatchObject({
      applicationId: ENGINE_APPLICATION_ID,
      userVersion: ENGINE_SCHEMA_VERSION,
    });
    expect(ENGINE_SCHEMA_VERSION).toBe(6);
    expect(
      upgraded.store
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      [
        ...[...V1_DDL.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map((match) => match[1]!),
        "turn_plan_answer",
        "command_task_group",
        "command_task_group_state",
        "deferred_message_slot",
        "deferred_message_predecessor",
        "deferred_message_successor",
        "deferred_message_body",
      ].sort(),
    );
    const after = dump(upgraded.store.db, V1_TABLES);
    const metaAfter = Object.fromEntries(
      (after["meta"] as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]),
    );
    expect(metaAfter).toEqual({
      schema_version: String(ENGINE_SCHEMA_VERSION),
      store_id: "11111111-1111-4111-8111-111111111111",
      created_at: "2026-10-01T00:00:00.000Z",
      global_pid: "1",
    });
    expect({ ...after, meta: [] }).toEqual({ ...before, meta: [] });
    const services = upgraded.graph.accounts.services!;
    services.serve(profile("a"), "M", producer("run-1"));
    expect(order(services, "M", [profile("a")])).toEqual({ a: 1 });
    await upgraded.close();

    // A newer version than this engine is refused before any write.
    const newer = new DatabaseSync(join(root, "daemon", "engine.sqlite"));
    newer.exec(`PRAGMA user_version=${ENGINE_SCHEMA_VERSION + 1}`);
    const rows = () =>
      (newer.prepare("SELECT count(*) AS n FROM account_last_service").get() as { n: number }).n;
    expect(rows()).toBe(1);
    await expect(
      EngineStore.open({
        daemonDir: join(root, "daemon"),
        workerEntry: builtWorker("flusher-worker.js"),
      }),
    ).rejects.toMatchObject({ code: "store_schema_unsupported" });
    expect(rows()).toBe(1);
    newer.close();
  });

  it("keeps the order across a close and a fresh graph, by acceptance, never by the wall clock", async () => {
    const root = tempRoot();
    let clock = Date.parse("2026-10-13T10:00:00.000Z");
    const first = await openGraph(root, () => new Date(clock));
    const [a, b] = [profile("a"), profile("b")];
    const firstServices = first.graph.accounts.services!;
    firstServices.serve(b, "M", producer("run-1"));
    clock -= 60 * 60_000; // the wall clock steps back an hour
    firstServices.serve(a, "M", producer("run-2"));
    firstServices.serve(a, "M", producer("run-2")); // the same try twice is one fact
    expect(order(firstServices, "M", [a, b])).toEqual({ b: 1, a: 2 });
    first.graph.accounts.refusals.record({
      harness_id: "fake",
      profile_id: "a",
      requested_model: "M",
    });
    await first.close();

    const second = await openGraph(root);
    expect(second.graph.accounts).not.toBe(first.graph.accounts);
    const services = second.graph.accounts.services!;
    expect(order(services, "M", [a, b])).toEqual({ b: 1, a: 2 });
    expect(services.latest([a, b])).toEqual([
      {
        harness_id: "fake",
        profile_id: "a",
        requested_model: "M",
        observed_at: "2026-10-13T09:00:00.000Z",
      },
      {
        harness_id: "fake",
        profile_id: "b",
        requested_model: "M",
        observed_at: "2026-10-13T10:00:00.000Z",
      },
    ]);
    // Refusal marks are bounded process memory: a restart forgets them, the order survives.
    expect(second.graph.accounts.refusals.live()).toEqual([]);
    services.serve(b, "M", producer("run-3"));
    expect(order(services, "M", [a, b])).toEqual({ a: 2, b: 3 });
  });

  it("keeps null, empty and literal-null model keys distinct; a binding is identity, a label is not", async () => {
    const f = await openGraph(tempRoot());
    const services = f.graph.accounts.services!;
    const a = profile("a");
    for (const model of [null, "", "null"]) services.serve(a, model, producer(`run-${model}`));
    expect([null, "", "null"].map((model) => order(services, model, [a]))).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 3 },
    ]);
    expect(services.latest([a]).map((row) => row.requested_model)).toEqual(["null", "", null]);
    // Renaming or toggling the row keeps its history.
    expect(order(services, "", [{ ...a, display_name: "Renamed", enabled: false }])).toEqual({
      a: 2,
    });
    // Re-pointing, re-creating or re-kinding it does not.
    for (const changed of [
      { isolation_locator: "/tmp/cx-account-service/elsewhere" },
      { created_at: "2026-10-14T00:00:00.000Z" },
      {
        credential_kind: "oauth_token" as const,
        isolation_locator: null,
        secret_ref: "claude_oauth:a",
      },
    ]) {
      expect(order(services, "", [{ ...a, ...changed }])).toEqual({});
      expect(services.latest([{ ...a, ...changed }])).toEqual([]);
    }
  });

  it("credential changes clear through the generation: one row, every row, never the defaults", async () => {
    const f = await openGraph(tempRoot());
    const evidence = f.graph.accounts;
    const services = evidence.services!;
    const [a, b] = [profile("a"), profile("b")];
    services.serve(a, "M", producer("run-1"));
    services.serve(b, "M", producer("run-2"));
    const generationA = evidence.credentials.generation("fake", "a");
    const generationB = evidence.credentials.generation("fake", "b");
    evidence.unusable.clearSubject("fake", "a");
    expect(order(services, "M", [a, b])).toEqual({ b: 2 });
    expect(evidence.credentials.generation("fake", "a")).toBeGreaterThan(generationA);
    expect(evidence.credentials.generation("fake", "b")).toBe(generationB);
    evidence.unusable.clearDefaultSubjects(); // no default rows exist: nothing to delete
    expect(order(services, "M", [a, b])).toEqual({ b: 2 });
    // An Enabled toggle keeps the binding: the generation moves, its facts stay.
    for (const ledger of [evidence.unusable, evidence.refusals]) {
      const before = evidence.credentials.generation("fake", "b");
      ledger.clearSubject("fake", "b", true);
      expect(evidence.credentials.generation("fake", "b")).toBeGreaterThan(before);
      expect(order(services, "M", [a, b])).toEqual({ b: 2 });
    }
    evidence.refusals.noteCredentialChange();
    expect(order(services, "M", [a, b])).toEqual({});
  });

  it("a failed clear still moves the generation, is logged, and never throws into the mutation", async () => {
    const f = await openGraph(tempRoot());
    const warnings: string[] = [];
    const evidence = createAccountEvidence(f.store, (line) => warnings.push(line));
    const a = profile("a");
    evidence.services!.serve(a, "M", producer("run-1"));
    evidence.unusable.record({
      harness_id: "fake",
      profile_id: "a",
      model: null,
      code: "auth_revoked",
      source: "attempt_stream",
      detail: null,
      observed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const before = evidence.credentials.generation("fake", "a");
    vi.spyOn(f.store, "transaction").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });
    expect(() => evidence.unusable.clearSubject("fake", "a")).not.toThrow();
    expect(evidence.credentials.generation("fake", "a")).toBeGreaterThan(before);
    expect(evidence.unusable.live()).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining("account service evidence clear failed")]);
    // Disclosed residual: the stale preference stays until the next clear removes it.
    expect(order(evidence.services!, "M", [a])).toEqual({ a: 1 });
    evidence.refusals.clearSubject("fake", "a");
    expect(order(evidence.services!, "M", [a])).toEqual({});
  });

  it("reads write nothing", async () => {
    const f = await openGraph(tempRoot());
    const services = f.graph.accounts.services!;
    const [a, b] = [profile("a"), profile("b")];
    services.serve(a, "M", producer("run-1"));
    const changes = () => (f.store.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    services.orders("fake", "M", [a, b]);
    services.latest([a, b]);
    expect(changes()).toBe(before);
  });

  it("lives as long as its store: global recovery keeps it, closing the store retires it", async () => {
    const f = await openGraph(tempRoot());
    const evidence = f.graph.accounts;
    const a = profile("a");
    evidence.services!.serve(a, "M", producer("run-1"));
    evidence.refusals.record({ harness_id: "fake", profile_id: "a", requested_model: "M" });
    f.store.transaction(() =>
      setGlobalGenerationInTx(f.store, createPartition(f.store, "global").pid),
    );
    f.graph.rebindGlobal();
    expect(f.graph.accounts).toBe(evidence);
    expect(evidence.refusals.live()).toHaveLength(1);
    expect(order(evidence.services!, "M", [a])).toEqual({ a: 1 });
    expect(Number.isFinite(evidence.credentials.generation("fake", "a"))).toBe(true);
    await f.close();
    // A late outcome of a run from the closed graph binds to nothing.
    expect(Number.isNaN(evidence.credentials.generation("fake", "a"))).toBe(true);
    expect(() => evidence.refusals.noteCredentialChange()).not.toThrow();
  });
});
