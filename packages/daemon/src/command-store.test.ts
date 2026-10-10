/** Historical replay/file contract against the sealed legacy reference.
 * SQL serving behavior is covered by store/command-contract.test.ts. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";
import { publicJobRecord, type JobRecord } from "./job-record.js";

const roots: string[] = [];
const journals: DurableJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openJournal(root?: string): { root: string; journal: DurableJournal } {
  const dir = root ?? realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-command-store-")));
  if (!root) roots.push(dir);
  const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
  journals.push(journal);
  return { root: dir, journal };
}

const params = {
  mode: "agent",
  prompt: "Refactor the retention module and keep every test green.",
  scope: { kind: "project", root: "/tmp/project" },
};

describe("CommandStore journaled updates (D1: params are immutable after acceptance)", () => {
  it("journals command.updated without params and replays the accepted params back", () => {
    const { root, journal } = openJournal();
    const store = new CommandStore(journal);
    const { record } = store.accept({
      id: "job-1",
      params,
      idempotencyKey: "key-1",
      clientId: "test",
    });
    store.update(record.id, { state: "running", startedAt: "2026-09-14T00:00:00.000Z" });
    store.update(record.id, {
      state: "succeeded",
      result: { lifecycle: "succeeded" },
      finishedAt: "2026-09-14T00:01:00.000Z",
    });
    const updates = journal.records<{ record: Record<string, unknown> }>(0, ["command.updated"]);
    expect(updates).toHaveLength(2);
    for (const update of updates) expect(update.payload.record).not.toHaveProperty("params");
    // The live record and the accepted frame both still carry the params.
    expect(store.get(record.id)?.params).toEqual(params);
    const accepted = journal.records<{ record: JobRecord }>(0, ["command.accepted"]);
    expect(accepted[0]?.payload.record.params).toEqual(params);
    journal.close();

    const reopened = new CommandStore(openJournal(root).journal);
    const replayed = reopened.get(record.id);
    expect(replayed).toMatchObject({ state: "succeeded", result: { lifecycle: "succeeded" } });
    expect(replayed?.params).toEqual(params);
    // Exact Retry / Run Again / decision rerun read the prompt off the public
    // job record (run-retry-routes, decision-rerun, thread-turn-routes).
    expect((publicJobRecord(replayed!).params as { prompt: string }).prompt).toBe(params.prompt);
    expect(reopened.find({ params, idempotencyKey: "key-1", clientId: "test" })?.id).toBe(
      record.id,
    );
  });

  it("replays legacy full-record updates unchanged and mixes them with the new form", () => {
    const { root, journal } = openJournal();
    const store = new CommandStore(journal);
    const { record } = store.accept({
      id: "job-legacy",
      params,
      idempotencyKey: "key-legacy",
      clientId: "test",
    });
    // A pre-upgrade daemon journaled the complete record on every update.
    journal.append("command.updated", {
      record: { ...record, params, state: "running", startedAt: "2026-09-14T00:00:00.000Z" },
    });
    journal.close();

    const { journal: second } = openJournal(root);
    const resumed = new CommandStore(second);
    expect(resumed.get(record.id)).toMatchObject({ state: "running", params });
    resumed.update(record.id, { state: "cancelled", finishedAt: "2026-09-14T00:02:00.000Z" });
    second.close();

    const final = new CommandStore(openJournal(root).journal);
    expect(final.get(record.id)).toMatchObject({ state: "cancelled", params });
  });

  it("ignores a params patch: the accepted params stay authoritative in memory and on disk", () => {
    const { journal } = openJournal();
    const store = new CommandStore(journal);
    const { record } = store.accept({
      id: "job-2",
      params,
      idempotencyKey: "key-2",
      clientId: "test",
    });
    const next = store.update(record.id, {
      state: "running",
      params: { prompt: "tampered" },
    } as Partial<JobRecord>);
    expect(next.params).toEqual(params);
    expect(store.get(record.id)?.params).toEqual(params);
    const [update] = journal.records<{ record: Record<string, unknown> }>(0, ["command.updated"]);
    expect(update?.payload.record).not.toHaveProperty("params");
  });

  it("keeps the pruned commands' project roots in the tombstone across restarts", () => {
    const { root, journal } = openJournal();
    const store = new CommandStore(journal);
    const scoped = (r: string) => ({
      mode: "agent",
      prompt: "p",
      scope: { kind: "project", root: r },
    });
    store.accept({ id: "job-p1", params: scoped("/tmp/p1"), idempotencyKey: "k1", clientId: "t" });
    store.update("job-p1", {
      state: "succeeded",
      runId: "run-p1",
      finishedAt: "2026-09-14T00:00:00.000Z",
    });
    store.accept({ id: "job-p2", params: scoped("/tmp/p2"), idempotencyKey: "k2", clientId: "t" });
    store.accept({ id: "job-none", params: { mode: "ask" }, idempotencyKey: "k3", clientId: "t" });
    store.prune(["job-p1", "job-none"]);
    expect(store.prunedScopeRoots()).toEqual(["/tmp/p1"]);
    expect(journal.records(0, ["command.pruned"])[0]?.payload).toEqual({
      ids: ["job-p1", "job-none"],
      roots: ["/tmp/p1"],
      run_ids: ["run-p1"],
    });
    // A legacy tombstone (no roots) still prunes and adds nothing.
    journal.append("command.pruned", { ids: ["job-p2"] });
    journal.close();
    const reopened = new CommandStore(openJournal(root).journal);
    expect(reopened.prunedScopeRoots()).toEqual(["/tmp/p1"]);
    expect(reopened.get("job-p2")).toBeUndefined();
    expect(reopened.records()).toEqual([]);
  });

  it("still refuses an update that precedes its acceptance", () => {
    const { root, journal } = openJournal();
    journal.append("command.updated", {
      record: { id: "job-orphan", state: "running", createdAt: "2026-09-14T00:00:00.000Z" },
    });
    journal.close();
    expect(() => new CommandStore(openJournal(root).journal)).toThrow(
      "command update precedes acceptance",
    );
  });
});
