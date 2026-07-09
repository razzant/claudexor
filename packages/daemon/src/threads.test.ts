import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ThreadStore } from "./threads.js";

function store(): { path: string; s: ThreadStore } {
  const path = join(mkdtempSync(join(tmpdir(), "claudexor-threads-")), "threads.json");
  return { path, s: new ThreadStore(path) };
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

  it("setTurnEnqueueError records the refusal (message + typed code) on a RUNLESS turn; bindTurnRun clears it (retry path)", () => {
    const { path, s } = store();
    const t = s.createThread({ repoRoot: "/tmp/proj" });
    const turn = s.createTurn(t.id, "do risky work");
    s.setTurnEnqueueError(turn.id, "access profile 'full' requires allow_full_access: true", "trust_full_access_required");
    const refused = s.getTurn(turn.id);
    expect(refused?.enqueue_error?.message).toContain("allow_full_access");
    expect(refused?.enqueue_error?.code).toBe("trust_full_access_required");
    expect(refused?.enqueue_error?.failed_at).toBeTruthy();
    // Survives a reload (the whole point: a thread re-open still shows WHY).
    const reloaded = new ThreadStore(path).getTurn(turn.id);
    expect(reloaded?.enqueue_error?.message).toContain("allow_full_access");
    expect(reloaded?.enqueue_error?.code).toBe("trust_full_access_required");
    // A REPEAT refusal (retry refused again) replaces the recorded reason.
    s.setTurnEnqueueError(turn.id, "still refused", null);
    expect(s.getTurn(turn.id)?.enqueue_error?.message).toBe("still refused");
    // A successful retry binds a run and the refusal vanishes with it.
    s.bindTurnRun(turn.id, "run-retry");
    expect(s.getTurn(turn.id)?.enqueue_error).toBeNull();
    expect(s.getTurn(turn.id)?.run_id).toBe("run-retry");
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

  it("persists a sticky eligible pool and primary, and survives a reload", () => {
    const { path, s } = store();
    const t = s.createThread({ repoRoot: "/tmp/proj", primaryHarness: "codex", eligibleHarnesses: ["codex", "claude"] });
    expect(t.eligible_harnesses).toEqual(["codex", "claude"]);
    expect(t.primary_harness).toBe("codex");
    expect(s.createThread({}).eligible_harnesses).toEqual([]); // default empty
    // Reload from disk: sticky routing is durable.
    const reloaded = new ThreadStore(path).getThread(t.id);
    expect(reloaded?.eligible_harnesses).toEqual(["codex", "claude"]);
    expect(reloaded?.primary_harness).toBe("codex");
    // Invariant at CREATE too: a primary outside a non-empty pool is cleared, so a
    // thread is never born claiming a primary the engine would drop.
    const incoherent = s.createThread({ repoRoot: "/tmp/p2", primaryHarness: "codex", eligibleHarnesses: ["claude"] });
    expect(incoherent.eligible_harnesses).toEqual(["claude"]);
    expect(incoherent.primary_harness).toBeNull();
    // Empty pool imposes no constraint — a standalone primary is kept (engine auto-pools).
    expect(s.createThread({ primaryHarness: "codex", eligibleHarnesses: [] }).primary_harness).toBe("codex");
  });

  it("updateThread switches the sticky primary (incl. clear to null) and pool", () => {
    const { s } = store();
    const t = s.createThread({ repoRoot: "/tmp/proj", primaryHarness: "codex", eligibleHarnesses: ["codex"] });
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
    const t = s.createThread({ repoRoot: "/tmp/proj", primaryHarness: "codex", eligibleHarnesses: ["codex", "claude"] });
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
    expect(s.resumeMap(t.id)).toEqual({ codex: "vendor-sess-1" });
  });

  it("forward-migrates an older schema_version record instead of dropping it", () => {
    const { path } = store();
    // A thread persisted by an earlier schema_version, missing the new workspace field.
    const legacy = {
      threads: [
        {
          schema_version: 1,
          id: "th-legacy",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          repo: { root: "/tmp/proj", base_ref: "HEAD" },
          title: "Legacy",
          mode: "agent",
          auth_preference: "auto",
          primary_harness: null,
          run_ids: [],
          head_run_id: null,
          state: "active",
        },
      ],
      sessions: [],
      turns: [],
    };
    writeFileSync(path, JSON.stringify(legacy));
    const s = new ThreadStore(path);
    const t = s.getThread("th-legacy");
    expect(t).toBeDefined();
    expect(t?.workspace.mode).toBe("in_place"); // additive default filled in
    expect(existsSync(`${path}.bak`)).toBe(false); // migration succeeded, no data loss
  });

  it("coerces removed enum values during migration instead of dropping", () => {
    const { path } = store();
    const legacy = {
      threads: [{
        schema_version: 1, id: "th-blocked", created_at: "t", updated_at: "t",
        repo: { root: "/p", base_ref: "HEAD" }, title: "Blocked", mode: "agent",
        auth_preference: "auto", primary_harness: null, run_ids: [], head_run_id: null,
        state: "blocked", // removed -> must coerce to "active", not drop
      }],
      sessions: [
        {
          schema_version: 1, id: "se-latest", thread_id: "th-blocked", harness_id: "codex",
          native_session_id: "vendor-1", resume_kind: "resume_latest", // retired -> resume_by_id
          state: "live", created_at: "t", updated_at: "t",
        },
        {
          // The dangerous shape: a LIVE rehost record with a stale native id.
          // Migration must flip it to none/rebound or resumeMap would resume a
          // session whose own semantics said "native resume impossible".
          schema_version: 1, id: "se-rehost", thread_id: "th-blocked", harness_id: "claude",
          native_session_id: "stale-native-id", resume_kind: "rehost",
          state: "live", created_at: "t", updated_at: "t",
        },
      ],
      turns: [{ id: "tn-o", thread_id: "th-blocked", created_at: "t", kind: "orchestrate" /* removed -> followup */ }],
    };
    writeFileSync(path, JSON.stringify(legacy));
    const s = new ThreadStore(path);
    expect(s.getThread("th-blocked")?.state).toBe("active"); // migrated, not dropped
    expect(existsSync(`${path}.bak`)).toBe(false);            // no data loss
    expect(s.turnsFor("th-blocked")[0]?.kind).toBe("followup");
    // Retired session resume kinds are coerced: resume_latest keeps native
    // continuity; a live rehost record does NOT leak its stale native id into
    // the resume map (its state flips to rebound with the coercion).
    expect(s.resumeMap("th-blocked")).toEqual({ codex: "vendor-1" });
    const rehosted = s.sessionsForThread("th-blocked").find((x) => x.harness_id === "claude");
    expect(rehosted?.resume_kind).toBe("none");
    expect(rehosted?.state).toBe("rebound");
  });

  it("assertKnownIds fails loudly on bogus, foreign, and thread-less turn ids (socket-caller fence)", () => {
    const { s } = (() => {
      const { path } = store();
      return { s: new ThreadStore(path) };
    })();
    const a = s.createThread({ repoRoot: "/tmp/a" });
    const b = s.createThread({ repoRoot: "/tmp/b" });
    const turnA = s.createTurn(a.id, "move in thread A");
    // Valid binding passes through normalized.
    expect(s.assertKnownIds(a.id, turnA.id)).toEqual({ threadId: a.id, turnId: turnA.id });
    // No binding at all is fine (plain non-thread runs).
    expect(s.assertKnownIds(undefined, undefined)).toEqual({ threadId: undefined, turnId: undefined });
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

  it("backs up the store and logs when a record is truly unparseable", () => {
    const { path } = store();
    writeFileSync(path, JSON.stringify({ threads: [{ id: "broken" /* missing required fields */ }], sessions: [], turns: [] }));
    const s = new ThreadStore(path);
    expect(s.listThreads()).toEqual([]); // unparseable record dropped
    expect(existsSync(`${path}.bak`)).toBe(true); // original preserved (fail loudly)
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8")).threads[0].id).toBe("broken");
  });
});
