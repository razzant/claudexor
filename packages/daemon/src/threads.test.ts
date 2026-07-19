import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "@claudexor/journal";
import { describe, expect, it } from "vitest";
import { ThreadStore, type ThreadHeadPingSink } from "./threads.js";

function store(): { root: string; journal: DurableJournal; s: ThreadStore } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-threads-")));
  const journal = new DurableJournal({ rootDir: root, partition: "global" });
  return { root, journal, s: new ThreadStore(journal) };
}

function reload(root: string, journal: DurableJournal): ThreadStore {
  journal.close();
  return new ThreadStore(new DurableJournal({ rootDir: root, partition: "global" }));
}

describe("ThreadStore", () => {
  it("defaults a no-project thread to ask and a project thread to agent", () => {
    const { s } = store();
    const noProj = s.createThread({});
    expect(noProj.mode).toBe("ask");
    expect(noProj.workspace.mode).toBe("in_place");
    const proj = s.createThread({ repoRoot: "/tmp/proj" });
    expect(proj.mode).toBe("agent");
    const iso = s.createThread({ repoRoot: "/tmp/proj", workspace: "isolated" });
    expect(iso.workspace.mode).toBe("isolated");
  });

  it("deduplicates thread creation by request and preserves the key across restart", () => {
    const { root, journal, s } = store();
    const input = {
      repoRoot: "/tmp/proj",
      idempotency: { key: "thread-1", client: "test", request: { root: "/tmp/proj" } },
    };
    const first = s.createThread(input);
    expect(s.createThread(input).id).toBe(first.id);
    expect(() =>
      s.createThread({
        ...input,
        idempotency: { key: "thread-1", client: "test", request: { root: "/tmp/other" } },
      }),
    ).toThrow(/different request/);
    const reloaded = reload(root, journal);
    expect(reloaded.createThread(input).id).toBe(first.id);
  });

  it("createTurn (run_id=null) then bindTurnRun is the single writer of run lineage", () => {
    const { s } = store();
    const t = s.createThread({ repoRoot: "/tmp/proj" });
    const turn = s.createTurn(t.id, "first move");
    expect(turn.run_id).toBeNull();
    expect(turn.kind).toBe("initial"); // first turn of the thread
    expect(s.getThread(t.id)?.head_run_id).toBeNull(); // not bound yet
    s.bindTurnRun(turn.id, "run-1");
    const after = s.getThread(t.id);
    expect(after?.head_run_id).toBe("run-1");
    expect(after?.run_ids).toEqual(["run-1"]);
    // A second turn is a followup and parents off the current head.
    const t2 = s.createTurn(t.id, "second move");
    expect(t2.kind).toBe("followup");
    expect(t2.parent_run_id).toBe("run-1");
  });

  it("persists the delivered lineage watermark across a journal restart", () => {
    const { root, journal, s } = store();
    const thread = s.createThread({ repoRoot: "/tmp/proj", workspace: "isolated" });
    const first = s.createTurn(thread.id, "first");
    s.bindTurnRun(first.id, "run-1");
    const second = s.createTurn(thread.id, "second");
    s.bindTurnRun(second.id, "run-2");

    s.setThreadWorktree(thread.id, "/tmp/thread-tree", "base-2", "run-1");
    const reloaded = reload(root, journal).getThread(thread.id);

    expect(reloaded?.workspace).toMatchObject({
      worktree_path: "/tmp/thread-tree",
      base_sha: "base-2",
      delivered_through_run_id: "run-1",
    });
    expect(reloaded?.run_ids).toEqual(["run-1", "run-2"]);
  });

  it("deduplicates turn creation by request and preserves the key across restart", () => {
    const { root, journal, s } = store();
    const thread = s.createThread({ repoRoot: "/tmp/proj" });
    const input = {
      idempotency: {
        key: "turn-1",
        client: "test",
        request: { threadId: thread.id, prompt: "first" },
      },
    };
    const first = s.createTurn(thread.id, "first", input);
    expect(s.createTurn(thread.id, "first", input).id).toBe(first.id);
    expect(() =>
      s.createTurn(thread.id, "different", {
        idempotency: { key: "turn-1", client: "test", request: { prompt: "different" } },
      }),
    ).toThrow(/different request/);
    const other = s.createThread({ repoRoot: "/tmp/other" });
    expect(() =>
      s.createTurn(other.id, "first", {
        idempotency: {
          key: "turn-1",
          client: "test",
          request: { threadId: other.id, prompt: "first" },
        },
      }),
    ).toThrow(/different request/);
    expect(s.turnsFor(other.id)).toEqual([]);
    const reloaded = reload(root, journal);
    expect(reloaded.createTurn(thread.id, "first", input).id).toBe(first.id);
  });

  it("setTurnEnqueueError records the refusal (message + typed code) on a RUNLESS turn; bindTurnRun clears it (retry path)", () => {
    const { root, journal, s } = store();
    const t = s.createThread({ repoRoot: "/tmp/proj" });
    const turn = s.createTurn(t.id, "do risky work");
    s.setTurnEnqueueError(
      turn.id,
      "access profile 'full' requires allow_full_access: true",
      "trust_full_access_required",
    );
    const refused = s.getTurn(turn.id);
    expect(refused?.enqueue_error?.message).toContain("allow_full_access");
    expect(refused?.enqueue_error?.code).toBe("trust_full_access_required");
    expect(refused?.enqueue_error?.failed_at).toBeTruthy();
    // Survives a reload (the whole point: a thread re-open still shows WHY).
    const reloadedStore = reload(root, journal);
    const reloaded = reloadedStore.getTurn(turn.id);
    expect(reloaded?.enqueue_error?.message).toContain("allow_full_access");
    expect(reloaded?.enqueue_error?.code).toBe("trust_full_access_required");
    // A REPEAT refusal (retry refused again) replaces the recorded reason.
    reloadedStore.setTurnEnqueueError(turn.id, "still refused", null);
    expect(reloadedStore.getTurn(turn.id)?.enqueue_error?.message).toBe("still refused");
    // A successful retry binds a run and the refusal vanishes with it.
    reloadedStore.bindTurnRun(turn.id, "run-retry");
    expect(reloadedStore.getTurn(turn.id)?.enqueue_error).toBeNull();
    expect(reloadedStore.getTurn(turn.id)?.run_id).toBe("run-retry");
  });

  it("setTurnEnqueueError is a no-op once a run is bound (late failure reports belong to the run)", () => {
    const { s } = store();
    const t = s.createThread({ repoRoot: "/tmp/proj" });
    const turn = s.createTurn(t.id, "ok work");
    s.bindTurnRun(turn.id, "run-1");
    s.setTurnEnqueueError(turn.id, "late refusal");
    expect(s.getTurn(turn.id)?.enqueue_error).toBeNull();
  });

  it("auto-titles a thread from the first prompt's first line", () => {
    const { s } = store();
    const t = s.createThread({ repoRoot: "/tmp/proj" });
    s.createTurn(t.id, "Make a cyberpunk racing game\nwith neon tracks");
    expect(s.getThread(t.id)?.title).toBe("Make a cyberpunk racing game");
  });

  it("updateThread renames and archives", () => {
    const { s } = store();
    const t = s.createThread({ repoRoot: "/tmp/proj" });
    s.updateThread(t.id, { title: "Renamed" });
    expect(s.getThread(t.id)?.title).toBe("Renamed");
    s.updateThread(t.id, { state: "closed" });
    expect(s.getThread(t.id)?.state).toBe("closed");
  });

  it("keeps trashed threads restorable for 30 days and leaves a purge tombstone", () => {
    const { root, journal, s } = store();
    const thread = s.createThread({ repoRoot: "/tmp/proj", workspace: "isolated" });
    s.updateThread(thread.id, { state: "closed" });
    s.setThreadWorktree(thread.id, "/tmp/thread-tree", "base-1");

    const trashed = s.trashThread(thread.id);
    expect(trashed.state).toBe("trashed");
    expect(trashed.pre_trash_state).toBe("closed");
    expect(Date.parse(trashed.purge_after ?? "")).toBeGreaterThan(Date.now());
    const restoredStore = reload(root, journal);
    expect(restoredStore.getThread(thread.id)?.state).toBe("trashed");
    expect(restoredStore.restoreThread(thread.id).state).toBe("closed");
    restoredStore.trashThread(thread.id);
    const purged = restoredStore.purgeThread(thread.id);
    expect(purged.state).toBe("purged");
    expect(purged.workspace.worktree_path).toBeNull();
    expect(restoredStore.listThreads().some((item) => item.id === thread.id)).toBe(false);
    expect(() => restoredStore.restoreThread(thread.id)).toThrow(/purged/);
  });

  it("persists a sticky eligible pool and primary, and survives a reload", () => {
    const { root, journal, s } = store();
    const t = s.createThread({
      repoRoot: "/tmp/proj",
      primaryHarness: "codex",
      eligibleHarnesses: ["codex", "claude"],
    });
    expect(t.eligible_harnesses).toEqual(["codex", "claude"]);
    expect(t.primary_harness).toBe("codex");
    expect(s.createThread({}).eligible_harnesses).toEqual([]); // default empty
    // Reload from disk: sticky routing is durable.
    const reloadedStore = reload(root, journal);
    const reloaded = reloadedStore.getThread(t.id);
    expect(reloaded?.eligible_harnesses).toEqual(["codex", "claude"]);
    expect(reloaded?.primary_harness).toBe("codex");
    // Invariant at CREATE too: a primary outside a non-empty pool is cleared, so a
    // thread is never born claiming a primary the engine would drop.
    const incoherent = reloadedStore.createThread({
      repoRoot: "/tmp/p2",
      primaryHarness: "codex",
      eligibleHarnesses: ["claude"],
    });
    expect(incoherent.eligible_harnesses).toEqual(["claude"]);
    expect(incoherent.primary_harness).toBeNull();
    // Empty pool imposes no constraint — a standalone primary is kept (engine auto-pools).
    expect(
      reloadedStore.createThread({ primaryHarness: "codex", eligibleHarnesses: [] })
        .primary_harness,
    ).toBe("codex");
  });

  it("updateThread switches the sticky primary (incl. clear to null) and pool", () => {
    const { s } = store();
    const t = s.createThread({
      repoRoot: "/tmp/proj",
      primaryHarness: "codex",
      eligibleHarnesses: ["codex"],
    });
    s.updateThread(t.id, { primaryHarness: "claude", eligibleHarnesses: ["claude", "cursor"] });
    expect(s.getThread(t.id)?.primary_harness).toBe("claude");
    expect(s.getThread(t.id)?.eligible_harnesses).toEqual(["claude", "cursor"]);
    // null clears the primary back to auto without touching the pool.
    s.updateThread(t.id, { primaryHarness: null });
    expect(s.getThread(t.id)?.primary_harness).toBeNull();
    expect(s.getThread(t.id)?.eligible_harnesses).toEqual(["claude", "cursor"]);
  });

  it("updateThread clears a sticky primary that falls outside a narrowed pool (invariant)", () => {
    const { s } = store();
    const t = s.createThread({
      repoRoot: "/tmp/proj",
      primaryHarness: "codex",
      eligibleHarnesses: ["codex", "claude"],
    });
    // Remove the primary harness (codex) from the pool: the primary must not persist
    // outside a non-empty pool, so it auto-clears to null (Auto) — the UI then shows
    // Auto instead of lying that codex answers while the engine drops it.
    s.updateThread(t.id, { eligibleHarnesses: ["claude"] });
    expect(s.getThread(t.id)?.eligible_harnesses).toEqual(["claude"]);
    expect(s.getThread(t.id)?.primary_harness).toBeNull();
    // An empty pool imposes no constraint — a primary can stand alone (engine auto-pools).
    s.updateThread(t.id, { primaryHarness: "claude", eligibleHarnesses: [] });
    expect(s.getThread(t.id)?.primary_harness).toBe("claude");
  });

  it("records the last observed model on a session", () => {
    const { s } = store();
    const t = s.createThread({ repoRoot: "/tmp/proj" });
    s.recordSession(t.id, "codex", "vendor-sess-1", "gpt-5.5");
    const sess = s.sessionsForThread(t.id);
    expect(sess[0]?.native_session_id).toBe("vendor-sess-1");
    expect(sess[0]?.last_observed_model).toBe("gpt-5.5");
    expect(s.resumeMap(t.id)).toEqual({ codex: { sessionId: "vendor-sess-1", profileId: null } });
  });

  it("thread sticky credential profile is durable and clearable (W5.4)", () => {
    const { s } = store();
    const t = s.createThread({ repoRoot: "/tmp/proj", credentialProfileId: "work" });
    expect(s.getThread(t.id)?.credential_profile_id).toBe("work");
    s.updateThread(t.id, { credentialProfileId: "personal" });
    expect(s.getThread(t.id)?.credential_profile_id).toBe("personal");
    s.updateThread(t.id, { credentialProfileId: null });
    expect(s.getThread(t.id)?.credential_profile_id).toBeNull();
    // An unrelated patch must not disturb the sticky profile.
    s.updateThread(t.id, { credentialProfileId: "work" });
    s.updateThread(t.id, { title: "renamed" });
    expect(s.getThread(t.id)?.credential_profile_id).toBe("work");
  });

  it("thread sticky access is durable and clearable (D26)", () => {
    const { s } = store();
    const t = s.createThread({ repoRoot: "/tmp/proj", access: "full" });
    expect(s.getThread(t.id)?.access).toBe("full");
    s.updateThread(t.id, { access: "workspace_write" });
    expect(s.getThread(t.id)?.access).toBe("workspace_write");
    s.updateThread(t.id, { access: null });
    expect(s.getThread(t.id)?.access).toBeNull();
    // An unrelated patch must not disturb the sticky scope.
    s.updateThread(t.id, { access: "full" });
    s.updateThread(t.id, { title: "renamed" });
    expect(s.getThread(t.id)?.access).toBe("full");
  });

  it("resume never crosses credential profiles (INV-135)", () => {
    const { s } = store();
    const t = s.createThread({ repoRoot: "/tmp/proj" });
    s.recordSession(t.id, "claude", "sess-under-work", null, "work");
    // The session recorded under profile "work" is invisible to the engine
    // default (null) and to any other profile — exact match only.
    expect(s.resumeMap(t.id)).toEqual({});
    expect(s.resumeMap(t.id, "personal")).toEqual({});
    expect(s.resumeMap(t.id, "work")).toEqual({
      claude: { sessionId: "sess-under-work", profileId: "work" },
    });
    expect(s.sessionsForThread(t.id)[0]?.profile_id).toBe("work");
    // A default-ladder session stays default-only.
    s.recordSession(t.id, "codex", "sess-default");
    expect(s.resumeMap(t.id)).toEqual({ codex: { sessionId: "sess-default", profileId: null } });
    expect(s.resumeMap(t.id, "work")).toEqual({
      claude: { sessionId: "sess-under-work", profileId: "work" },
    });
  });

  it("profile deletion clears thread pins and invalidates its native sessions", () => {
    const { s } = store();
    const a = s.createThread({ repoRoot: "/tmp/a", credentialProfileId: "work" });
    const b = s.createThread({ repoRoot: "/tmp/b", credentialProfileId: "work" });
    s.recordSession(a.id, "claude", "native-a", null, "work");
    s.recordSession(b.id, "codex", "native-b", null, "work");

    expect(s.invalidateCredentialProfile("claude", "work")).toEqual({
      clearedThreads: 2,
      invalidatedSessions: 1,
    });
    expect(s.getThread(a.id)?.credential_profile_id).toBeNull();
    expect(s.getThread(b.id)?.credential_profile_id).toBeNull();
    expect(s.resumeMap(a.id, "work")).toEqual({});
    expect(s.sessionsForThread(a.id)[0]).toMatchObject({
      state: "stale",
      native_session_id: null,
      resume_kind: "none",
    });
    // Same id under another harness is not the deleted credential material.
    expect(s.resumeMap(b.id, "work")).toEqual({
      codex: { sessionId: "native-b", profileId: "work" },
    });
  });

  it("one cached session PER profile (round-16 #3): A→B→A resumes A's own native conversation", () => {
    const { s } = store();
    const t = s.createThread({ repoRoot: "/tmp/proj" });
    s.recordSession(t.id, "claude", "native-a", null, "a");
    // Recording under profile B (or the default) must not overwrite A's row.
    s.recordSession(t.id, "claude", "native-b", null, "b");
    s.recordSession(t.id, "claude", "native-default", null, null);
    expect(s.resumeMap(t.id, "a")).toEqual({
      claude: { sessionId: "native-a", profileId: "a" },
    });
    expect(s.resumeMap(t.id, "b")).toEqual({
      claude: { sessionId: "native-b", profileId: "b" },
    });
    expect(s.resumeMap(t.id)).toEqual({
      claude: { sessionId: "native-default", profileId: null },
    });
    // A re-record under the SAME profile refreshes its own row, not a new one.
    s.recordSession(t.id, "claude", "native-a2", null, "a");
    expect(s.resumeMap(t.id, "a")).toEqual({
      claude: { sessionId: "native-a2", profileId: "a" },
    });
    expect(s.sessionsForThread(t.id)).toHaveLength(3);
  });

  it("assertKnownIds fails loudly on bogus, foreign, and thread-less turn ids (socket-caller fence)", () => {
    const { s } = store();
    const a = s.createThread({ repoRoot: "/tmp/a" });
    const b = s.createThread({ repoRoot: "/tmp/b" });
    const turnA = s.createTurn(a.id, "move in thread A");
    // Valid binding passes through normalized.
    expect(s.assertKnownIds(a.id, turnA.id)).toEqual({ threadId: a.id, turnId: turnA.id });
    // No binding at all is fine (plain non-thread runs).
    expect(s.assertKnownIds(undefined, undefined)).toEqual({
      threadId: undefined,
      turnId: undefined,
    });
    expect(s.assertKnownIds("", "")).toEqual({ threadId: undefined, turnId: undefined });
    // Bogus ids fail loudly.
    expect(() => s.assertKnownIds("th-nope", undefined)).toThrow(/no such thread/);
    expect(() => s.assertKnownIds(a.id, "tn-nope")).toThrow(/no such turn/);
    // A turn without its thread id could rebind lineage — refused.
    expect(() => s.assertKnownIds(undefined, turnA.id)).toThrow(/requires its threadId/);
    // A FOREIGN turn (belongs to thread A, claimed for thread B) — refused:
    // context would come from B while A's conversation head advances.
    expect(() => s.assertKnownIds(b.id, turnA.id)).toThrow(/belongs to thread/);
  });
});

describe("ThreadStore thread.head.updated ping (W12)", () => {
  function pingStore(partition = "global") {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-threads-ping-")));
    const pings: Array<{ threadId: string; projectId: string | null }> = [];
    const sink: ThreadHeadPingSink = (ping) => pings.push(ping);
    const journal = new DurableJournal({ rootDir: root, partition });
    return { root, journal, pings, s: new ThreadStore(journal, sink) };
  }

  it("pings exactly once per persisted mutation on every path", () => {
    const { pings, s } = pingStore();
    const thread = s.createThread({ repoRoot: "/tmp/proj" });
    expect(pings).toEqual([{ threadId: thread.id, projectId: null }]);

    s.updateThread(thread.id, { title: "renamed" });
    expect(pings).toHaveLength(2);
    s.updateThread(thread.id, { state: "closed" });
    expect(pings).toHaveLength(3);
    s.updateThread(thread.id, { state: "active" });
    expect(pings).toHaveLength(4);

    // turn-add touches the thread AND the turn: still ONE ping (deduped per commit)
    const turn = s.createTurn(thread.id, "first move");
    expect(pings).toHaveLength(5);
    s.bindTurnRun(turn.id, "run-1");
    expect(pings).toHaveLength(6);

    const refused = s.createTurn(thread.id, "risky move");
    expect(pings).toHaveLength(7);
    s.setTurnEnqueueError(refused.id, "trust refused", "trust_full_access_required");
    expect(pings).toHaveLength(8);

    s.recordSession(thread.id, "claude", "native-session-1");
    expect(pings).toHaveLength(9);
    s.trashThread(thread.id);
    expect(pings).toHaveLength(10);
    expect(pings.every((ping) => ping.threadId === thread.id)).toBe(true);
  });

  it("stamps the owning project id from the store partition", () => {
    const { pings, s } = pingStore("project:proj-42");
    const thread = s.createThread({ repoRoot: "/tmp/proj" });
    expect(pings).toEqual([{ threadId: thread.id, projectId: "proj-42" }]);
  });

  it("journal replay never pings, and an idempotent duplicate does not ping", () => {
    const { root, journal, pings, s } = pingStore();
    const input = {
      repoRoot: "/tmp/proj",
      idempotency: { key: "thread-1", client: "test", request: { root: "/tmp/proj" } },
    };
    s.createThread(input);
    expect(pings).toHaveLength(1);
    // Same idempotency key returns the existing thread: nothing persisted, no ping.
    s.createThread(input);
    expect(pings).toHaveLength(1);
    journal.close();
    const replayed: Array<{ threadId: string; projectId: string | null }> = [];
    void new ThreadStore(new DurableJournal({ rootDir: root, partition: "global" }), (ping) =>
      replayed.push(ping),
    );
    expect(replayed).toEqual([]);
  });
});
