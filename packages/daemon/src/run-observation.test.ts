import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../artifact-store/src/index.js";
import * as eventLog from "../../event-log/src/index.js";
import type { RunWaitManySummary } from "@claudexor/schema";
import { InteractionRegistry, type InteractionContext } from "./interactions.js";
import type { JobRecord } from "./job-record.js";
import { readRunObservations } from "./run-observation.js";
import { applyCommandInTx, prepareCommandRow } from "./store/command-rows.js";
import { SqlCommandQueries } from "./store/command-queries.js";
import { SqlCommandStore } from "./store/commands.js";
import { StoreBusyError, StoreCorruptError } from "./store/errors.js";
import { SqlEventLedger } from "./store/event-store.js";
import { setGlobalGenerationInTx } from "./store/generations.js";
import { SqlInteractionStore } from "./store/interactions.js";
import { runMutation } from "./store/mutation.js";
import { createPartition } from "./store/partitions.js";
import { resourceFixture } from "./store/test-support/resource-fixture.js";
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";

const TIME = "2026-10-22T00:00:00.000Z";
const STORE = "11111111-1111-4111-8111-111111111111";
const EPOCH = "11111111111111111111111111111111";
const cleanup: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

function question(runId: string, id: string, timeoutAt: string | null = null): InteractionContext {
  return {
    runId,
    taskId: "task-a",
    attemptId: "a01",
    harnessId: "claude",
    request: { interaction_id: id, source_tool: "AskUserQuestion", questions: [] },
    requestedAt: TIME,
    timeoutAt,
  };
}

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-run-observation-")));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const f = await resourceFixture(root, { manualTick: true, now: () => new Date(TIME) });
  cleanup.push(() => f.close());
  const generation = f.store.transaction(() => {
    const value = createPartition(f.store, "global", { epoch: EPOCH });
    setGlobalGenerationInTx(f.store, value.pid);
    return value;
  });
  const events = new SqlEventLedger(f.store, f.blobs, generation);
  const pending = new SqlInteractionStore(f.store, events);
  const registry = new InteractionRegistry({ forRequest: () => pending, forRun: () => pending });
  const queries = new SqlCommandQueries(f.store, f.blobs);
  function seed(id: string, patch: Partial<JobRecord> = {}) {
    const row = prepareCommandRow(
      {
        id,
        state: "running",
        runId: `run-${id}`,
        createdAt: TIME,
        params: { mode: "ask", prompt: "fixture prompt" },
        ...patch,
      },
      { pid: generation.pid, live: true, operation: "ask", clientId: "fixture" },
      (bytes) => f.blobs.prepareBody(bytes),
    );
    f.store.transaction(() => applyCommandInTx(f.store, row, "accept"));
  }
  const read = (ids: readonly string[], signal?: AbortSignal, storeId = STORE) =>
    readRunObservations(queries, registry, storeId, ids, signal);
  return { ...f, root, generation, events, pending, registry, queries, seed, read };
}

function known(row: RunWaitManySummary | undefined, status: string, pending: boolean): string {
  expect(row).toEqual({
    status,
    pending,
    token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    problem: null,
  });
  return row!.token!;
}

const problem = (reason: "not_found" | "snapshot_unavailable" | "not_observed") => ({
  status: null,
  pending: null,
  token: null,
  problem: reason,
});

describe("readRunObservations over real SQLite", () => {
  it("preserves duplicate/job/run positions with one deduplicated command and pending batch", async () => {
    const f = await fixture();
    f.seed("job-a", { runId: "run-a", state: "succeeded" });
    f.seed("job-queued", { state: "queued", runId: undefined });
    const addressed = vi.spyOn(f.queries, "observationRecords");
    const batch = vi.spyOn(f.registry, "snapshotPendingIdentities");
    const ids = ["run-a", "job-a", "missing", "run-a", "job-queued", "missing"];
    const rows = await f.read(ids);
    expect(rows).toHaveLength(6);
    const token = known(rows[0], "succeeded", false);
    expect(rows).toEqual([
      { status: "succeeded", pending: false, token, problem: null },
      { status: "succeeded", pending: false, token, problem: null },
      problem("not_found"),
      { status: "succeeded", pending: false, token, problem: null },
      {
        status: "queued",
        pending: false,
        token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        problem: null,
      },
      problem("not_found"),
    ]);
    expect(ids).toEqual(["run-a", "job-a", "missing", "run-a", "job-queued", "missing"]);
    expect(addressed.mock.calls).toEqual([[["run-a", "job-a", "missing", "job-queued"]]]);
    expect(batch.mock.calls).toEqual([[["run-a"]]]);
  });

  it("keeps tokens stable across repeats, clocks, progress, result and question prose", async () => {
    const f = await fixture();
    f.seed("job-a", { runId: "run-a" });
    f.pending.request(question("run-a", "question-a"));
    const first = await f.read(["job-a"]);
    known(first[0], "running", true);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2036-10-22T00:00:00Z"));
    // Changed summary/body/read-independent facts cannot enter the token.
    f.store.transaction(() => {
      f.store
        .prepare(
          "UPDATE command SET summary=?,error=?,params_sha='unread-prompt',result_sha='unread-result',last_event_seq=999 WHERE id='job-a'",
        )
        .run(
          Buffer.from(JSON.stringify("invalid command summary shape")),
          Buffer.from("changed result diagnostics"),
        );
      f.store
        .prepare("UPDATE interaction SET request=? WHERE run_id='run-a'")
        .run(Buffer.from("changed question prose, deliberately not JSON"));
    });
    expect(await f.read(["run-a"])).toEqual(first);
    expect(await f.read(["job-a"])).toEqual(first);
  });

  it("changes tokens for each canonical identity component and actual queued-to-run binding", async () => {
    const f = await fixture();
    f.seed("job-a", { state: "queued", runId: undefined });
    const queued = known((await f.read(["job-a"]))[0], "queued", false);
    f.store.transaction(() =>
      f.store.prepare("UPDATE command SET run_id='run-a' WHERE id='job-a'").run(),
    );
    const bound = known((await f.read(["job-a"]))[0], "queued", false);
    expect(bound).not.toBe(queued);
    expect((await f.read(["run-a"]))[0]!.token).toBe(bound);
    f.store.transaction(() =>
      f.store.prepare("UPDATE command SET state='running' WHERE id='job-a'").run(),
    );
    const running = known((await f.read(["job-a"]))[0], "running", false);
    expect(running).not.toBe(bound);
    const otherStore = known(
      (await f.read(["job-a"], undefined, "22222222-2222-4222-8222-222222222222"))[0],
      "running",
      false,
    );
    expect(otherStore).not.toBe(running);
    f.store.transaction(() =>
      f.store
        .prepare("UPDATE partition SET epoch=? WHERE id=?")
        .run("2".repeat(32), f.generation.pid),
    );
    const regenerated = known((await f.read(["job-a"]))[0], "running", false);
    expect(regenerated).not.toBe(running);
    f.store.transaction(() =>
      f.store
        .prepare("UPDATE partition SET name='project:renamed' WHERE id=?")
        .run(f.generation.pid),
    );
    const repartitioned = known((await f.read(["job-a"]))[0], "running", false);
    expect(repartitioned).not.toBe(regenerated);
    f.store.transaction(() =>
      f.store.prepare("UPDATE command SET id='job-b' WHERE id='job-a'").run(),
    );
    const renamedJob = known((await f.read(["run-a"]))[0], "running", false);
    expect(renamedJob).not.toBe(repartitioned);
    f.store.transaction(() =>
      f.store.prepare("UPDATE command SET run_id='run-b' WHERE id='job-b'").run(),
    );
    const renamedRun = known((await f.read(["job-b"]))[0], "running", false);
    expect(renamedRun).not.toBe(renamedJob);
  });

  it("detects A-to-B question replacement even while pending remains true", async () => {
    const f = await fixture();
    f.seed("job-a", { runId: "run-a" });
    const empty = known((await f.read(["run-a"]))[0], "running", false);
    f.pending.request(question("run-a", "question-A"));
    const a = known((await f.read(["run-a"]))[0], "running", true);
    expect(a).not.toBe(empty);
    expect(f.pending.resolve("run-a", "question-A", "answered")).toBe("resolved");
    f.pending.request(question("run-a", "question-B"));
    const b = known((await f.read(["run-a"]))[0], "running", true);
    expect(b).not.toBe(a);
    expect(f.pending.resolve("run-a", "question-B", "answered")).toBe("resolved");
    expect((await f.read(["run-a"]))[0]!.token).toBe(empty);
  });

  it("separates per-run pending read failure from known false and missing target", async () => {
    const f = await fixture();
    f.seed("job-good", { runId: "run-good" });
    f.seed("job-bad", { runId: "run-bad" });
    const original = f.pending.pendingIdentityDigest.bind(f.pending);
    vi.spyOn(f.pending, "pendingIdentityDigest").mockImplementation((runId) => {
      if (runId === "run-bad") throw new Error("private diagnostic must not be echoed");
      return original(runId);
    });
    const rows = await f.read(["run-bad", "run-good", "missing", "job-bad"]);
    const token = known(rows[1], "running", false);
    expect(rows).toEqual([
      problem("snapshot_unavailable"),
      { status: "running", pending: false, token, problem: null },
      problem("not_found"),
      problem("snapshot_unavailable"),
    ]);
  });

  it.each(["unknown", "waiting_on_user"])(
    "reports malformed SQL lifecycle %s as an explicit target problem",
    async (state) => {
      const f = await fixture();
      f.seed("job-bad", { runId: "run-bad" });
      f.seed("job-good", { runId: "run-good" });
      f.store.transaction(() =>
        f.store.prepare("UPDATE command SET state=? WHERE id='job-bad'").run(state),
      );
      const rows = await f.read(["run-bad", "run-good"]);
      expect(rows[0]).toEqual(problem("snapshot_unavailable"));
      known(rows[1], "running", false);
    },
  );

  it.each(["command", "pending"])(
    "propagates a typed connection-wide %s failure unchanged",
    async (owner) => {
      const f = await fixture();
      f.seed("job-a", { runId: "run-a" });
      const failure =
        owner === "command" ? new StoreCorruptError("fixture") : new StoreBusyError("fixture");
      if (owner === "command")
        vi.spyOn(f.queries, "observationRecords").mockImplementation(() => {
          throw failure;
        });
      else
        vi.spyOn(f.pending, "pendingIdentityDigest").mockImplementation(() => {
          throw failure;
        });
      await expect(f.read(["run-a", "missing"])).rejects.toBe(failure);
    },
  );

  it("does no storage work after a pre-abort and labels every unread position not_observed", async () => {
    const f = await fixture();
    f.seed("job-a", { state: "succeeded", runId: "run-a" });
    const addressed = vi.spyOn(f.queries, "observationRecords");
    const pending = vi.spyOn(f.registry, "snapshotPendingIdentities");
    const controller = new AbortController();
    controller.abort();
    expect(await f.read(["job-a", "missing", "job-a"], controller.signal)).toEqual([
      problem("not_observed"),
      problem("not_observed"),
      problem("not_observed"),
    ]);
    expect(addressed).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
  });

  it("honors abort between scalar selection and pending observation instead of inferring completion", async () => {
    const f = await fixture();
    f.seed("job-a", { state: "succeeded", runId: "run-a" });
    const controller = new AbortController();
    const select = f.queries.observationRecords.bind(f.queries);
    vi.spyOn(f.queries, "observationRecords").mockImplementation((ids) => {
      const rows = select(ids);
      controller.abort();
      return rows;
    });
    const pending = vi.spyOn(f.registry, "snapshotPendingIdentities");
    expect(await f.read(["run-a", "missing"], controller.signal)).toEqual([
      problem("not_observed"),
      problem("not_observed"),
    ]);
    expect(pending).not.toHaveBeenCalled();
  });

  it("never hydrates params/results, question bodies, artifacts or event logs", async () => {
    const f = await fixture();
    f.seed("job-a", {
      runId: "run-a",
      state: "succeeded",
      params: { mode: "ask", prompt: "p".repeat(70_000) },
      result: { text: "r".repeat(70_000) },
      runDir: join(f.root, "unread-run"),
    });
    f.pending.request(question("run-a", "question-a"));
    const readers = [
      vi.spyOn(f.blobs, "read"),
      vi.spyOn(SqlCommandStore.prototype, "get"),
      vi.spyOn(f.queries, "select"),
      vi.spyOn(f.queries, "publicList"),
      vi.spyOn(f.queries, "getByRunId"),
      vi.spyOn(f.queries, "active"),
      vi.spyOn(f.pending, "pendingForRun"),
      vi.spyOn(f.registry, "pendingForRun"),
      vi.spyOn(ArtifactStore.prototype, "readYaml"),
      vi.spyOn(eventLog, "readRunEvents"),
      vi.spyOn(eventLog, "lastRunEventSeq"),
      vi.spyOn(eventLog, "retainedOutput"),
      vi.spyOn(f.events, "records"),
    ];
    known((await f.read(["job-a", "run-a"]))[0], "succeeded", true);
    for (const reader of readers) expect(reader).not.toHaveBeenCalled();
  });

  it("yields to the event loop while mapping a full 1000-target snapshot", async () => {
    const f = await fixture();
    const ids = Array.from({ length: 1000 }, (_, i) => `job-${i}`);
    for (const id of ids) f.seed(id);
    let yielded = false;
    const turn = setImmediate(() => {
      yielded = true;
    });
    try {
      const rows = await f.read(ids);
      expect(yielded).toBe(true);
      expect(rows).toHaveLength(1000);
      known(rows[0], "running", false);
      known(rows[999], "running", false);
    } finally {
      clearImmediate(turn);
    }
  });

  it("runs the registry's existing finite/null expiry reconciliation once for a batch", async () => {
    const f = await fixture();
    f.seed("job-a", { runId: "run-a" });
    f.seed("job-b", { runId: "run-b" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(TIME));
    const expiring = f.registry.register(
      question("run-a", "expired", "2026-10-22T00:00:01.000Z"),
      {},
    );
    const disabled = f.registry.register(question("run-b", "disabled"), {});
    clock.mockReturnValue(Date.parse("2026-10-22T00:00:02.000Z"));
    clock.mockClear();
    const bodies = vi.spyOn(f.pending, "pendingForRun");
    await f.registry.snapshotPendingIdentities(["run-a", "run-b", "run-a"]);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(bodies).not.toHaveBeenCalled();
    await expect(expiring).resolves.toEqual({ kind: "released", reason: "timeout" });
    const rows = await f.read(["run-a", "run-b"]);
    known(rows[0], "running", false);
    known(rows[1], "running", true);
    f.registry.dropForRun("run-b");
    await expect(disabled).resolves.toEqual({ kind: "released", reason: "run_terminal" });
  });
});

describe("post-commit observation notices", () => {
  function listen(f: Awaited<ReturnType<typeof fixture>>) {
    const notices: Array<string[] | undefined> = [];
    const unsubscribe = f.store.observations.subscribe((changed) =>
      notices.push(changed && [...changed].sort()),
    );
    return { notices, unsubscribe };
  }
  function row(f: Awaited<ReturnType<typeof fixture>>, id: string) {
    return prepareCommandRow(
      { id, state: "running", runId: `run-${id}`, createdAt: TIME, params: { mode: "ask" } },
      { pid: f.generation.pid, live: true, operation: "ask", clientId: "fixture" },
      (bytes) => f.blobs.prepareBody(bytes),
    );
  }

  it("names a committed command's job and run after COMMIT, and nothing for a rollback", async () => {
    const f = await fixture();
    const { notices, unsubscribe } = listen(f);
    runMutation(f.store, (tx) => {
      applyCommandInTx(tx, row(f, "job-a"), "accept");
      expect(notices).toEqual([]);
    });
    expect(notices).toEqual([["job-a", "run-job-a"]]);
    expect(() =>
      runMutation(f.store, (tx) => {
        applyCommandInTx(tx, row(f, "job-b"), "accept");
        throw new Error("injected rollback");
      }),
    ).toThrow();
    expect(f.queries.observationRecords(["job-b"])).toEqual([]);
    expect(notices).toHaveLength(1);
    unsubscribe();
    runMutation(f.store, (tx) => applyCommandInTx(tx, row(f, "job-c"), "accept"));
    expect(notices).toHaveLength(1);
  });

  it("names the run and every job bound to it when its question is asked or answered", async () => {
    const f = await fixture();
    f.seed("job-a", { runId: "run-a" });
    const { notices } = listen(f);
    f.pending.request(question("run-a", "question-a"));
    expect(notices).toEqual([["job-a", "run-a"]]);
    expect(f.pending.resolve("run-a", "question-a", "answered")).toBe("resolved");
    expect(notices).toEqual([
      ["job-a", "run-a"],
      ["job-a", "run-a"],
    ]);
  });

  it("keeps a throwing observer from failing the commit or starving other observers", async () => {
    const f = await fixture();
    f.store.observations.subscribe(() => {
      throw new Error("observer defect");
    });
    const { notices } = listen(f);
    runMutation(f.store, (tx) => applyCommandInTx(tx, row(f, "job-a"), "accept"));
    expect(notices).toEqual([["job-a", "run-job-a"]]);
    expect(f.queries.observationRecords(["job-a"])).toHaveLength(1);
  });
});
