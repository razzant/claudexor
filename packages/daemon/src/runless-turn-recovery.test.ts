import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordInterruptedRunlessTurns, RESTARTED_BEFORE_START } from "./runless-turn-recovery.js";
import { ThreadStore } from "./store/test-support/fixtures/legacy/daemon/threads.js";

const roots: string[] = [];
const journals: DurableJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open(root: string): DurableJournal {
  const journal = new DurableJournal({ rootDir: root, partition: "global" });
  journals.push(journal);
  return journal;
}

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "runless-recovery-")));
  roots.push(root);
  const journal = open(root);
  const store = new ThreadStore(journal);
  const thread = store.createThread({ repoRoot: "/author/project" });
  return { root, journal, store, thread };
}

describe("runless recovery turn lookup", () => {
  it("observes the latest turn mutation and retains it through purge and replay", () => {
    const { root, journal, store, thread } = fixture();
    const runless = store.createTurn(thread.id, "accepted before restart");
    const bound = store.createTurn(thread.id, "already started");
    const refused = store.createTurn(thread.id, "already refused");
    const untouched = store.createTurn(thread.id, "not interrupted");
    store.bindTurnRun(bound.id, "run-bound");
    store.setTurnEnqueueError(refused.id, {
      message: "prior refusal",
      code: "trust_full_access_required",
      retryable: true,
      required_actions: [],
      context: {},
    });
    const priorRefusal = store.getTurn(refused.id)?.enqueue_error;
    const records = [
      { state: "interrupted", params: { turnId: runless.id }, error: "original failure" },
      { state: "interrupted", params: { turnId: runless.id }, error: "duplicate failure" },
      { state: "interrupted", params: { turnId: bound.id } },
      { state: "interrupted", params: { turnId: refused.id } },
      { state: "interrupted", params: { turnId: "missing-turn" } },
      { state: "interrupted", params: { turnId: 42 } },
      { state: "interrupted", params: null },
      { state: "interrupted", params: { turnId: untouched.id }, runId: "run-started" },
      { state: "succeeded", params: { turnId: untouched.id } },
    ];
    expect(recordInterruptedRunlessTurns(store, records)).toBe(1);
    expect(store.getTurn(runless.id)?.enqueue_error).toMatchObject({
      code: RESTARTED_BEFORE_START,
      message: "original failure",
      retryable: true,
    });
    expect(store.getTurn(bound.id)?.enqueue_error).toBeNull();
    expect(store.getTurn(refused.id)?.enqueue_error).toEqual(priorRefusal);
    expect(store.getTurn(untouched.id)?.enqueue_error).toBeNull();
    expect(store.getTurn("missing-turn")).toBeUndefined();
    store.bindTurnRun(runless.id, "run-retried");
    store.trashThread(thread.id);
    store.purgeThread(thread.id);
    journal.close();

    const replayed = new ThreadStore(open(root));
    expect(replayed.getThread(thread.id)?.state).toBe("purged");
    expect(replayed.getTurn(runless.id)).toMatchObject({
      run_id: "run-retried",
      enqueue_error: null,
    });
    expect(replayed.getTurn(refused.id)?.enqueue_error).toEqual(priorRefusal);
    expect(recordInterruptedRunlessTurns(replayed, records)).toBe(0);
    expect(replayed.turnsFor(thread.id).map((turn) => turn.id)).toEqual([
      runless.id,
      bound.id,
      refused.id,
      untouched.id,
    ]);
  });

  it.each([128, 1024])(
    "does linear lookup work for repeated recovery with %i retained turns and commands",
    (count) => {
      const { root, journal, store, thread } = fixture();
      const seed = store.createTurn(thread.id, "retained historical turn");
      const turns = Array.from({ length: count }, (_, index) => ({
        ...seed,
        id: index === 0 ? seed.id : `historical-turn-${index}`,
        enqueue_error: {
          code: RESTARTED_BEFORE_START,
          message: "already recovered",
          retryable: true,
          required_actions: [],
          context: {},
          failed_at: seed.created_at,
        },
      }));
      // Seed a real journal in one batch so fixture creation does not dominate
      // this deterministic operation-count regression with fsyncs.
      journal.append("thread.entities_upserted", { turns });
      journal.close();
      const replayed = new ThreadStore(open(root));
      let examinedIds = 0;
      for (const turn of replayed.turnsFor(thread.id)) {
        const id = turn.id;
        Object.defineProperty(turn, "id", {
          enumerable: true,
          get: () => {
            examinedIds += 1;
            return id;
          },
        });
      }
      const writes = vi.spyOn(replayed, "setTurnEnqueueError");
      const records = turns.flatMap((turn) => [
        { state: "interrupted", params: { turnId: turn.id } },
        { state: "interrupted", params: { turnId: `absent-${turn.id}` } },
      ]);
      for (let pass = 0; pass < 3; pass += 1) {
        expect(recordInterruptedRunlessTurns(replayed, records)).toBe(0);
      }
      // A scan per command reads O(commands * turns) ids, including every
      // missing id. Indexed lookup needs no history scan on later startups.
      expect(examinedIds).toBeLessThanOrEqual(records.length * 3);
      expect(writes).not.toHaveBeenCalled();
    },
  );
});
