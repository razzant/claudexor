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

  it("coerces removed v0.9 enum values during migration instead of dropping (D5)", () => {
    const { path } = store();
    const legacy = {
      threads: [{
        schema_version: 1, id: "th-blocked", created_at: "t", updated_at: "t",
        repo: { root: "/p", base_ref: "HEAD" }, title: "Blocked", mode: "agent",
        auth_preference: "auto", primary_harness: null, run_ids: [], head_run_id: null,
        state: "blocked", // removed in v0.10 -> must coerce to "active", not drop
      }],
      sessions: [],
      turns: [{ id: "tn-o", thread_id: "th-blocked", created_at: "t", kind: "orchestrate" /* removed -> followup */ }],
    };
    writeFileSync(path, JSON.stringify(legacy));
    const s = new ThreadStore(path);
    expect(s.getThread("th-blocked")?.state).toBe("active"); // migrated, not dropped
    expect(existsSync(`${path}.bak`)).toBe(false);            // no data loss
    expect(s.turnsFor("th-blocked")[0]?.kind).toBe("followup");
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
