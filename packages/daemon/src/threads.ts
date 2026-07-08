import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Attachment, Session, Thread, ThreadTurn, WorkspaceMode } from "@claudexor/schema";
import {
  SCHEMA_VERSION,
  Session as SessionSchema,
  Thread as ThreadSchema,
  ThreadTurn as ThreadTurnSchema,
} from "@claudexor/schema";
import { newId, nowIso, redactSecrets } from "@claudexor/util";

interface ThreadStoreState {
  threads: Thread[];
  sessions: Session[];
  turns: ThreadTurn[];
}

export interface CreateThreadInput {
  title?: string;
  repoRoot?: string | null;
  mode?: Thread["mode"];
  /** in_place (default) mutates the live tree; isolated keeps a thread worktree. */
  workspace?: WorkspaceMode;
  authPreference?: Thread["auth_preference"];
  primaryHarness?: string | null;
  /** Sticky eligible harness pool for the thread (turns inherit when unset). */
  eligibleHarnesses?: string[];
}

export interface CreateTurnInput {
  kind?: ThreadTurn["kind"];
  parentRunId?: string | null;
  /** Set when this turn implements an approved plan from an earlier run. */
  planRunId?: string | null;
  /** Files/images attached to this turn, already resolved to scoped on-disk paths. */
  attachments?: Attachment[];
}

export interface UpdateThreadInput {
  title?: string;
  state?: Thread["state"];
  /** Switch the sticky primary harness (null => clear back to auto). */
  primaryHarness?: string | null;
  /** Replace the sticky eligible harness pool. */
  eligibleHarnesses?: string[];
}

/**
 * Thread routing invariant: a sticky primary harness must be a member of a
 * NON-EMPTY eligible pool (an empty pool = engine auto-pool, so it constrains
 * nothing). Returns the primary, or null when it falls outside the pool — so a
 * thread is never stored claiming a primary the engine would drop. Applied at
 * both create and update (the only writers of these two fields).
 */
function coercePrimaryToPool(primary: string | null, pool: string[]): string | null {
  if (primary && pool.length > 0 && !pool.includes(primary)) return null;
  return primary;
}

/**
 * Durable thread/session registry (chat/session-first SSOT). The Thread is
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
    let raw: Partial<ThreadStoreState>;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ThreadStoreState>;
    } catch {
      // A corrupt store must not brick the daemon; threads are recoverable
      // from run artifacts, so start empty rather than crash-looping.
      this.state = { threads: [], sessions: [], turns: [] };
      return;
    }
    // Per-record leniency: ONE invalid record must not wipe the whole history.
    // A record stamped by a different schema_version is forward-migrated first
    // (additive fields are covered by zod defaults); only a genuinely
    // unparseable record is dropped — and then the original file is backed up
    // and the loss is logged, so a schema change never SILENTLY erases history.
    let dropped = 0;
    const keep = <T>(items: unknown[] | undefined, schema: { safeParse(v: unknown): { success: boolean; data?: T } }): T[] =>
      (items ?? []).flatMap((item) => {
        let parsed = schema.safeParse(item);
        if (!parsed.success && item && typeof item === "object") {
          // Forward-migrate: bump schema_version AND coerce retired enum values
          // (Thread.state "blocked" -> "active", ThreadTurnKind "orchestrate"
          // -> "followup", SessionResumeKind "resume_latest"/"rehost" -> the
          // values the daemon actually stamps) so an old record is migrated,
          // not dropped.
          const rec = item as Record<string, unknown>;
          const migrated: Record<string, unknown> = { ...rec, schema_version: SCHEMA_VERSION };
          if (migrated["state"] === "blocked") migrated["state"] = "active";
          if (migrated["kind"] === "orchestrate") migrated["kind"] = "followup";
          if (migrated["resume_kind"] === "resume_latest") migrated["resume_kind"] = "resume_by_id";
          if (migrated["resume_kind"] === "rehost") {
            // "rehost" meant "continued on a DIFFERENT harness — native resume
            // impossible". resumeMap keys on state==="live" + native id, so the
            // state must flip to "rebound" too or a stale live rehost record
            // would still resume natively despite its own retirement semantics.
            migrated["resume_kind"] = "none";
            migrated["state"] = "rebound";
          }
          parsed = schema.safeParse(migrated);
        }
        if (parsed.success && parsed.data !== undefined) return [parsed.data];
        dropped++;
        return [];
      });
    this.state = {
      threads: keep(raw.threads, ThreadSchema),
      sessions: keep(raw.sessions, SessionSchema),
      turns: keep(raw.turns, ThreadTurnSchema),
    };
    if (dropped > 0) {
      try {
        writeFileSync(`${this.path}.bak`, JSON.stringify(raw, null, 2), { mode: 0o600 });
        console.error(
          `[claudexor] threads store: ${dropped} record(s) unparseable after migration; original backed up to ${this.path}.bak`,
        );
      } catch {
        /* best-effort backup */
      }
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
    // Same invariant as updateThread: a sticky primary must be a member of a
    // non-empty eligible pool. Enforce it at CREATE too (the create request carries
    // primary + pool independently) so a thread is never born incoherent.
    const eligible = input.eligibleHarnesses ?? [];
    const primary = coercePrimaryToPool(input.primaryHarness ?? null, eligible);
    const thread = ThreadSchema.parse({
      schema_version: SCHEMA_VERSION,
      id: newId("th"),
      created_at: now,
      updated_at: now,
      repo: input.repoRoot ? { root: input.repoRoot, base_ref: "HEAD" } : null,
      title: input.title ?? null,
      // Default mode follows the scope: a no-project thread can only Ask
      // (read-only), so it must NOT default to agent (which would 400 on the
      // first turn for lack of a project root). A project thread defaults to agent.
      mode: input.mode ?? (input.repoRoot ? "agent" : "ask"),
      // An isolated workspace needs a git project for its worktree; a no-project
      // thread is always in_place (review #6 — never persist a doomed config).
      workspace: { mode: input.repoRoot ? input.workspace ?? "in_place" : "in_place", worktree_path: null, base_sha: null },
      auth_preference: input.authPreference ?? "auto",
      primary_harness: primary,
      eligible_harnesses: eligible,
    });
    this.state.threads.push(thread);
    this.persist();
    return thread;
  }

  /** Rename and/or open/close (archive) a thread. */
  updateThread(id: string, patch: UpdateThreadInput): Thread {
    const thread = this.getThread(id);
    if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
    if (patch.title !== undefined) thread.title = patch.title;
    if (patch.state !== undefined) thread.state = patch.state;
    if (patch.primaryHarness !== undefined) thread.primary_harness = patch.primaryHarness;
    if (patch.eligibleHarnesses !== undefined) thread.eligible_harnesses = patch.eligibleHarnesses;
    // Invariant (thread.ts contract): a sticky primary must be a member of a non-empty
    // eligible pool. If a PATCH leaves the primary outside the pool — e.g. the user
    // removed the primary harness from the pool — clear it to null (Auto) rather than
    // persist an incoherent state that the UI would show as "X answers in chat" while
    // the engine silently drops X. (An empty pool = auto, so it imposes no constraint.)
    thread.primary_harness = coercePrimaryToPool(thread.primary_harness, thread.eligible_harnesses);
    thread.updated_at = nowIso();
    this.persist();
    return thread;
  }

  /** Persist the resolved isolated worktree path + base sha for a thread. */
  setThreadWorktree(id: string, worktreePath: string, baseSha: string): void {
    const thread = this.getThread(id);
    if (!thread) return;
    thread.workspace = { ...thread.workspace, worktree_path: worktreePath, base_sha: baseSha };
    thread.updated_at = nowIso();
    this.persist();
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

  getTurn(turnId: string): ThreadTurn | undefined {
    return this.state.turns.find((t) => t.id === turnId);
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

  /**
   * Create a turn BEFORE its run is enqueued (run_id is bound later via
   * `bindTurnRun`). This is the single-writer entry point: the control API and
   * the daemon runner both create here, so a run is recorded on its thread
   * exactly once — there is no second "POST /runs with threadId silently skips
   * the turn" path. `parentRunId` is captured here (head at creation time), so
   * concurrent turns cannot both claim the same stale head.
   */
  createTurn(threadId: string, prompt: string, input: CreateTurnInput = {}): ThreadTurn {
    const thread = this.getThread(threadId);
    if (!thread) throw Object.assign(new Error(`no such thread: ${threadId}`), { status: 404 });
    // Count TURNS, not run_ids: run_ids is only filled at bindTurnRun (which lags
    // the runner), so a second turn created before the first binds would also see
    // an empty run_ids and wrongly claim "initial" (review #5).
    const existingTurns = this.state.turns.filter((t) => t.thread_id === threadId).length;
    const kind: ThreadTurn["kind"] = input.kind ?? (existingTurns === 0 ? "initial" : "followup");
    const turn = ThreadTurnSchema.parse({
      id: newId("tn"),
      thread_id: threadId,
      run_id: null,
      parent_run_id: input.parentRunId !== undefined ? input.parentRunId : thread.head_run_id,
      plan_run_id: input.planRunId ?? null,
      kind,
      // The durable conversation store is read back into UIs: redact at the
      // persist boundary exactly like jobs.json / events.jsonl do.
      prompt: redactSecrets(prompt),
      attachments: input.attachments ?? [],
      created_at: nowIso(),
    });
    this.state.turns.push(turn);
    // First prompt names the thread (no LLM): cheap, honest, editable via rename.
    if (!thread.title) thread.title = turn.prompt.split("\n")[0].slice(0, 60);
    thread.updated_at = nowIso();
    this.persist();
    return turn;
  }

  /** Bind a started run to its turn and advance the thread head (runner-owned). */
  bindTurnRun(turnId: string, runId: string): void {
    const turn = this.state.turns.find((t) => t.id === turnId);
    if (!turn) return;
    turn.run_id = runId;
    // A binding run supersedes any recorded refusal (the retry path): the
    // turn is no longer an orphan, so the stale error must not linger.
    turn.enqueue_error = null;
    const thread = this.getThread(turn.thread_id);
    if (thread) {
      if (!thread.run_ids.includes(runId)) thread.run_ids.push(runId);
      thread.head_run_id = runId;
      thread.updated_at = nowIso();
    }
    this.persist();
  }

  /**
   * Persist the reason a turn's run could NOT be enqueued/started (trust
   * refusal, preflight validation, enqueue throw). Only meaningful for a
   * RUNLESS turn: once a run is bound the turn's honesty lives on the run's
   * own terminal artifacts, so a late failure report is ignored. `code` is
   * the typed throw's machine code (e.g. trust_full_access_required) that
   * surfaces key remedies on; `retryable=false` marks refusals with NO
   * recorded job to replay (the enqueue itself threw) so surfaces offer
   * "send a new message" instead of a doomed Retry.
   */
  setTurnEnqueueError(turnId: string, message: string, code: string | null = null, retryable = true): void {
    const turn = this.state.turns.find((t) => t.id === turnId);
    if (!turn || turn.run_id) return;
    turn.enqueue_error = { message: redactSecrets(message), code, retryable, failed_at: nowIso() };
    const thread = this.getThread(turn.thread_id);
    if (thread) thread.updated_at = nowIso();
    this.persist();
  }


  /** Record/refresh the native CLI session a harness emitted for this thread. */
  recordSession(threadId: string, harnessId: string, nativeSessionId: string, observedModel?: string | null): void {
    const existing = this.state.sessions.find((s) => s.thread_id === threadId && s.harness_id === harnessId);
    const now = nowIso();
    if (existing) {
      existing.native_session_id = nativeSessionId;
      existing.state = "live";
      existing.resume_kind = "resume_by_id";
      if (observedModel) existing.last_observed_model = observedModel;
      existing.updated_at = now;
    } else {
      this.state.sessions.push(
        SessionSchema.parse({
          id: newId("se"),
          thread_id: threadId,
          harness_id: harnessId,
          native_session_id: nativeSessionId,
          last_observed_model: observedModel ?? null,
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

}
