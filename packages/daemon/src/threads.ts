import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Session, SessionReboundLineage, Thread, ThreadTurn } from "@claudexor/schema";
import {
  SCHEMA_VERSION,
  Session as SessionSchema,
  Thread as ThreadSchema,
  ThreadTurn as ThreadTurnSchema,
} from "@claudexor/schema";
import { newId, nowIso } from "@claudexor/util";

interface ThreadStoreState {
  threads: Thread[];
  sessions: Session[];
  turns: ThreadTurn[];
}

export interface CreateThreadInput {
  title?: string;
  repoRoot?: string | null;
  mode?: Thread["mode"];
  authPreference?: Thread["auth_preference"];
  primaryHarness?: string | null;
}

/**
 * Durable thread/session registry (A2 chat/session-first SSOT). The Thread is
 * the Claudexor-owned conversation; Sessions are re-hostable pointers to each
 * harness's native CLI session. Persisted as one JSON file with atomic writes
 * (temp + rename), mirroring the daemon job registry's durability contract.
 */
export class ThreadStore {
  private state: ThreadStoreState = { threads: [], sessions: [], turns: [] };

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ThreadStoreState>;
      this.state = {
        threads: (raw.threads ?? []).map((t) => ThreadSchema.parse(t)),
        sessions: (raw.sessions ?? []).map((s) => SessionSchema.parse(s)),
        turns: (raw.turns ?? []).map((t) => ThreadTurnSchema.parse(t)),
      };
    } catch {
      // A corrupt store must not brick the daemon; threads are recoverable
      // from run artifacts, so start empty rather than crash-looping.
      this.state = { threads: [], sessions: [], turns: [] };
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(this.path), `.threads-${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  createThread(input: CreateThreadInput): Thread {
    const now = nowIso();
    const thread = ThreadSchema.parse({
      schema_version: SCHEMA_VERSION,
      id: newId("th"),
      created_at: now,
      updated_at: now,
      repo: input.repoRoot ? { root: input.repoRoot, base_ref: "HEAD" } : null,
      title: input.title ?? null,
      mode: input.mode ?? "agent",
      auth_preference: input.authPreference ?? "auto",
      primary_harness: input.primaryHarness ?? null,
    });
    this.state.threads.push(thread);
    this.persist();
    return thread;
  }

  listThreads(): Thread[] {
    return [...this.state.threads].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  getThread(id: string): Thread | undefined {
    return this.state.threads.find((t) => t.id === id);
  }

  turnsFor(threadId: string): ThreadTurn[] {
    return this.state.turns.filter((t) => t.thread_id === threadId);
  }

  sessionsForThread(threadId: string): Session[] {
    return this.state.sessions.filter((s) => s.thread_id === threadId);
  }

  /** Native resume map for a thread: harnessId -> native session id (live sessions only). */
  resumeMap(threadId: string): Record<string, string> {
    const map: Record<string, string> = {};
    for (const s of this.sessionsForThread(threadId)) {
      if (s.state === "live" && s.native_session_id) map[s.harness_id] = s.native_session_id;
    }
    return map;
  }

  /** Record a turn (a run enqueued inside a thread). */
  addTurn(threadId: string, runId: string | null, prompt: string, kind: ThreadTurn["kind"] = "followup"): ThreadTurn {
    const thread = this.getThread(threadId);
    if (!thread) throw Object.assign(new Error(`no such thread: ${threadId}`), { status: 404 });
    const turn = ThreadTurnSchema.parse({
      id: newId("tn"),
      thread_id: threadId,
      run_id: runId,
      parent_run_id: thread.head_run_id,
      kind,
      prompt,
      created_at: nowIso(),
    });
    this.state.turns.push(turn);
    if (runId) {
      thread.run_ids.push(runId);
      thread.head_run_id = runId;
    }
    thread.updated_at = nowIso();
    this.persist();
    return turn;
  }

  /** Record/refresh the native CLI session a harness emitted for this thread. */
  recordSession(threadId: string, harnessId: string, nativeSessionId: string): void {
    const existing = this.state.sessions.find((s) => s.thread_id === threadId && s.harness_id === harnessId);
    const now = nowIso();
    if (existing) {
      existing.native_session_id = nativeSessionId;
      existing.state = "live";
      existing.resume_kind = "resume_by_id";
      existing.updated_at = now;
    } else {
      this.state.sessions.push(
        SessionSchema.parse({
          id: newId("se"),
          thread_id: threadId,
          harness_id: harnessId,
          native_session_id: nativeSessionId,
          resume_kind: "resume_by_id",
          state: "live",
          created_at: now,
          updated_at: now,
        }),
      );
    }
    const thread = this.getThread(threadId);
    if (thread) thread.updated_at = now;
    this.persist();
  }

  /**
   * Re-host a thread onto a different harness: mark other sessions stale and
   * return the typed lossy lineage for the `session.rebound` event (the new
   * harness has no native memory of the old conversation — disclosed, never silent).
   */
  rebindSessions(threadId: string, toHarnessId: string, summary: string, reason: SessionReboundLineage["reason"]): SessionReboundLineage {
    const sessions = this.sessionsForThread(threadId);
    const from = sessions.find((s) => s.harness_id !== toHarnessId && s.state === "live");
    for (const s of sessions) {
      if (s.harness_id !== toHarnessId && s.state === "live") {
        s.state = "rebound";
        s.updated_at = nowIso();
      }
    }
    this.persist();
    return {
      thread_id: threadId,
      harness_id: toHarnessId,
      from_session_id: from?.id ?? null,
      to_session_id: null,
      summary,
      contract_ref: null,
      open_tasks: [],
      diff_state: null,
      reason,
    };
  }
}
