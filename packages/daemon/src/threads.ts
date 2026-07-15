import type { DurableJournal } from "@claudexor/journal";
import type { Attachment, Session, Thread, ThreadTurn, WorkspaceMode } from "@claudexor/schema";
import {
  SCHEMA_VERSION,
  Session as SessionSchema,
  Thread as ThreadSchema,
  ThreadTurn as ThreadTurnSchema,
} from "@claudexor/schema";
import { hashJson, newId, nowIso, redactSecrets } from "@claudexor/util";

interface ThreadStoreState {
  threads: Thread[];
  sessions: Session[];
  turns: ThreadTurn[];
}

interface ThreadMutation {
  threads?: Thread[];
  sessions?: Session[];
  turns?: ThreadTurn[];
  idempotency?: { keyDigest: string; requestDigest: string; turnId: string };
  threadCreation?: { keyDigest: string; requestDigest: string; threadId: string };
}

const UPSERTED = "thread.entities_upserted";

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
  idempotency?: { key: string; client: string; request: unknown };
}

export interface CreateTurnInput {
  kind?: ThreadTurn["kind"];
  parentRunId?: string | null;
  /** Set when this turn implements an approved plan from an earlier run. */
  planRunId?: string | null;
  /** Files/images attached to this turn, already resolved to scoped on-disk paths. */
  attachments?: Attachment[];
  idempotency?: { key: string; client: string; request: unknown };
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

/** Journal-backed thread/session projection. Returned mutations are fsynced. */
export class ThreadStore {
  private state: ThreadStoreState = { threads: [], sessions: [], turns: [] };
  private readonly turnIdByKey = new Map<string, { turnId: string; requestDigest: string }>();
  private readonly threadIdByKey = new Map<string, { threadId: string; requestDigest: string }>();

  constructor(private readonly journal: DurableJournal) {
    this.replay();
  }

  validateProjection(): void {
    for (const thread of this.state.threads) ThreadSchema.parse(thread);
    for (const session of this.state.sessions) SessionSchema.parse(session);
    for (const turn of this.state.turns) ThreadTurnSchema.parse(turn);
    assertUnique(this.state.threads, "thread");
    assertUnique(this.state.sessions, "session");
    assertUnique(this.state.turns, "turn");
    for (const value of this.turnIdByKey.values()) {
      if (!this.getTurn(value.turnId)) throw new Error("thread idempotency index is dangling");
    }
    for (const value of this.threadIdByKey.values()) {
      if (!this.getThread(value.threadId))
        throw new Error("thread creation idempotency index is dangling");
    }
  }

  private replay(): void {
    for (const record of this.journal.records()) {
      if (record.type === UPSERTED) this.apply(parseMutation(record.payload));
    }
    this.validateProjection();
  }

  private commit(mutation: ThreadMutation): void {
    const parsed = parseMutation(mutation);
    this.journal.append(UPSERTED, parsed);
    this.apply(parsed);
  }

  private apply(mutation: ThreadMutation): void {
    for (const thread of mutation.threads ?? []) upsert(this.state.threads, thread);
    for (const session of mutation.sessions ?? []) upsert(this.state.sessions, session);
    for (const turn of mutation.turns ?? []) upsert(this.state.turns, turn);
    if (mutation.idempotency) {
      const { keyDigest, requestDigest, turnId } = mutation.idempotency;
      const prior = this.turnIdByKey.get(keyDigest);
      if (prior && (prior.turnId !== turnId || prior.requestDigest !== requestDigest)) {
        throw new Error("conflicting thread idempotency history");
      }
      this.turnIdByKey.set(keyDigest, { turnId, requestDigest });
    }
    if (mutation.threadCreation) {
      const { keyDigest, requestDigest, threadId } = mutation.threadCreation;
      const prior = this.threadIdByKey.get(keyDigest);
      if (prior && (prior.threadId !== threadId || prior.requestDigest !== requestDigest)) {
        throw new Error("conflicting thread creation idempotency history");
      }
      this.threadIdByKey.set(keyDigest, { threadId, requestDigest });
    }
  }

  createThread(input: CreateThreadInput): Thread {
    const creation = threadCreationIdempotency(this.journal.options.partition, input.idempotency);
    if (creation) {
      const prior = this.threadIdByKey.get(creation.keyDigest);
      if (prior) {
        if (prior.requestDigest !== creation.requestDigest) throw idempotencyConflict();
        const existing = this.getThread(prior.threadId);
        if (!existing)
          throw new Error(`idempotency record points to missing thread ${prior.threadId}`);
        return existing;
      }
    }
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
      workspace: {
        mode: input.repoRoot ? (input.workspace ?? "in_place") : "in_place",
        worktree_path: null,
        base_sha: null,
      },
      auth_preference: input.authPreference ?? "auto",
      primary_harness: primary,
      eligible_harnesses: eligible,
    });
    if (creation) creation.threadId = thread.id;
    this.commit({ threads: [thread], ...(creation ? { threadCreation: creation } : {}) });
    return thread;
  }

  /** Rename and/or open/close (archive) a thread. */
  updateThread(id: string, patch: UpdateThreadInput): Thread {
    const thread = this.getThread(id);
    if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
    const next = ThreadSchema.parse({
      ...thread,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.primaryHarness !== undefined ? { primary_harness: patch.primaryHarness } : {}),
      ...(patch.eligibleHarnesses !== undefined
        ? { eligible_harnesses: patch.eligibleHarnesses }
        : {}),
      updated_at: nowIso(),
    });
    // Invariant (thread.ts contract): a sticky primary must be a member of a non-empty
    // eligible pool. If a PATCH leaves the primary outside the pool — e.g. the user
    // removed the primary harness from the pool — clear it to null (Auto) rather than
    // persist an incoherent state that the UI would show as "X answers in chat" while
    // the engine silently drops X. (An empty pool = auto, so it imposes no constraint.)
    next.primary_harness = coercePrimaryToPool(next.primary_harness, next.eligible_harnesses);
    this.commit({ threads: [next] });
    return next;
  }

  /** Persist the resolved isolated worktree path + base sha for a thread. */
  setThreadWorktree(id: string, worktreePath: string, baseSha: string): void {
    const thread = this.getThread(id);
    if (!thread) return;
    const next = ThreadSchema.parse({
      ...thread,
      workspace: { ...thread.workspace, worktree_path: worktreePath, base_sha: baseSha },
      updated_at: nowIso(),
    });
    this.commit({ threads: [next] });
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

  /**
   * Fail-loud prologue for the daemon runner: control-api validates thread/turn
   * ids at the HTTP boundary, but a direct socket caller can pass bogus ids —
   * a silent unbind would orphan the run from its conversation. A typed throw
   * settles the job `failed` instead. Returns the normalized ids.
   */
  assertKnownIds(rawThreadId: unknown, rawTurnId: unknown): { threadId?: string; turnId?: string } {
    const threadId = typeof rawThreadId === "string" && rawThreadId ? rawThreadId : undefined;
    const turnId = typeof rawTurnId === "string" && rawTurnId ? rawTurnId : undefined;
    if (threadId && !this.getThread(threadId)) {
      throw Object.assign(new Error(`no such thread: ${threadId}`), { code: "unknown_thread" });
    }
    if (turnId) {
      const turn = this.getTurn(turnId);
      if (!turn) {
        throw Object.assign(new Error(`no such turn: ${turnId}`), { code: "unknown_turn" });
      }
      // A turn is bound to ONE conversation: a foreign turnId would resolve
      // workspace/session context from one thread while advancing another
      // thread's lineage. A turn also never rides without its thread id.
      if (!threadId) {
        throw Object.assign(new Error(`turnId ${turnId} requires its threadId`), {
          code: "unbound_turn",
        });
      }
      if (turn.thread_id !== threadId) {
        throw Object.assign(
          new Error(`turn ${turnId} belongs to thread ${turn.thread_id}, not ${threadId}`),
          { code: "foreign_turn" },
        );
      }
    }
    return { threadId, turnId };
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
    const idempotency = turnIdempotency(
      this.journal.options.partition,
      threadId,
      input.idempotency,
    );
    if (idempotency) {
      const prior = this.turnIdByKey.get(idempotency.keyDigest);
      if (prior) {
        if (prior.requestDigest !== idempotency.requestDigest) throw idempotencyConflict();
        const existing = this.getTurn(prior.turnId);
        if (!existing) throw new Error(`idempotency record points to missing turn ${prior.turnId}`);
        return existing;
      }
    }
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
      // persistence boundary exactly like other durable state projections do.
      prompt: redactSecrets(prompt),
      attachments: input.attachments ?? [],
      created_at: nowIso(),
    });
    // First prompt names the thread (no LLM): cheap, honest, editable via rename.
    const nextThread = ThreadSchema.parse({
      ...thread,
      title: thread.title || turn.prompt.split("\n")[0].slice(0, 60),
      updated_at: nowIso(),
    });
    if (idempotency) idempotency.turnId = turn.id;
    this.commit({ threads: [nextThread], turns: [turn], ...(idempotency ? { idempotency } : {}) });
    return turn;
  }

  /** Bind a started run to its turn and advance the thread head (runner-owned). */
  bindTurnRun(turnId: string, runId: string): void {
    const turn = this.state.turns.find((t) => t.id === turnId);
    if (!turn) return;
    const nextTurn = ThreadTurnSchema.parse({ ...turn, run_id: runId, enqueue_error: null });
    // A binding run supersedes any recorded refusal (the retry path): the
    // turn is no longer an orphan, so the stale error must not linger.
    const thread = this.getThread(turn.thread_id);
    let nextThread: Thread | undefined;
    if (thread) {
      nextThread = ThreadSchema.parse({
        ...thread,
        run_ids: thread.run_ids.includes(runId) ? thread.run_ids : [...thread.run_ids, runId],
        head_run_id: runId,
        updated_at: nowIso(),
      });
    }
    this.commit({ turns: [nextTurn], ...(nextThread ? { threads: [nextThread] } : {}) });
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
  setTurnEnqueueError(
    turnId: string,
    message: string,
    code: string | null = null,
    retryable = true,
  ): void {
    const turn = this.state.turns.find((t) => t.id === turnId);
    if (!turn || turn.run_id) return;
    const nextTurn = ThreadTurnSchema.parse({
      ...turn,
      enqueue_error: { message: redactSecrets(message), code, retryable, failed_at: nowIso() },
    });
    const thread = this.getThread(turn.thread_id);
    const nextThread = thread ? ThreadSchema.parse({ ...thread, updated_at: nowIso() }) : undefined;
    this.commit({ turns: [nextTurn], ...(nextThread ? { threads: [nextThread] } : {}) });
  }

  /** Record/refresh the native CLI session a harness emitted for this thread. */
  recordSession(
    threadId: string,
    harnessId: string,
    nativeSessionId: string,
    observedModel?: string | null,
  ): void {
    const existing = this.state.sessions.find(
      (s) => s.thread_id === threadId && s.harness_id === harnessId,
    );
    const now = nowIso();
    const session = SessionSchema.parse({
      ...(existing ?? {
        id: newId("se"),
        thread_id: threadId,
        harness_id: harnessId,
        created_at: now,
      }),
      native_session_id: nativeSessionId,
      last_observed_model: observedModel || existing?.last_observed_model || null,
      resume_kind: "resume_by_id",
      state: "live",
      updated_at: now,
    });
    const thread = this.getThread(threadId);
    const nextThread = thread ? ThreadSchema.parse({ ...thread, updated_at: now }) : undefined;
    this.commit({ sessions: [session], ...(nextThread ? { threads: [nextThread] } : {}) });
  }

  relinkProjectRoot(root: string): void {
    const threads = this.state.threads
      .filter((thread) => thread.repo && thread.repo.root !== root)
      .map((thread) =>
        ThreadSchema.parse({
          ...thread,
          repo: { ...thread.repo!, root },
          updated_at: nowIso(),
        }),
      );
    if (threads.length > 0) this.commit({ threads });
  }
}

export function threadProjection() {
  return {
    name: "threads",
    create: (journal: DurableJournal) => new ThreadStore(journal),
    validate: (store: ThreadStore) => store.validateProjection(),
  };
}

function parseMutation(value: unknown): ThreadMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid thread mutation");
  }
  const mutation = value as ThreadMutation;
  const idempotency = mutation.idempotency;
  const threadCreation = mutation.threadCreation;
  if (
    idempotency !== undefined &&
    (!idempotency ||
      typeof idempotency.keyDigest !== "string" ||
      typeof idempotency.requestDigest !== "string" ||
      typeof idempotency.turnId !== "string")
  ) {
    throw new Error("invalid thread idempotency record");
  }
  if (
    threadCreation !== undefined &&
    (!threadCreation ||
      typeof threadCreation.keyDigest !== "string" ||
      typeof threadCreation.requestDigest !== "string" ||
      typeof threadCreation.threadId !== "string")
  ) {
    throw new Error("invalid thread creation idempotency record");
  }
  return {
    ...(mutation.threads
      ? { threads: mutation.threads.map((item) => ThreadSchema.parse(item)) }
      : {}),
    ...(mutation.sessions
      ? { sessions: mutation.sessions.map((item) => SessionSchema.parse(item)) }
      : {}),
    ...(mutation.turns
      ? { turns: mutation.turns.map((item) => ThreadTurnSchema.parse(item)) }
      : {}),
    ...(idempotency ? { idempotency: { ...idempotency } } : {}),
    ...(threadCreation ? { threadCreation: { ...threadCreation } } : {}),
  };
}

function threadCreationIdempotency(
  partition: string,
  input: CreateThreadInput["idempotency"],
): ThreadMutation["threadCreation"] {
  if (!input) return undefined;
  validateIdempotencyKey(input.key);
  return {
    keyDigest: hashJson({
      client: input.client,
      partition,
      operation: "thread.create",
      key: input.key,
    }),
    requestDigest: hashJson(input.request),
    threadId: "",
  };
}

function turnIdempotency(
  partition: string,
  threadId: string,
  input: CreateTurnInput["idempotency"],
): ThreadMutation["idempotency"] {
  if (!input) return undefined;
  validateIdempotencyKey(input.key);
  return {
    keyDigest: hashJson({
      client: input.client,
      partition,
      operation: "thread.turn.create",
      key: input.key,
    }),
    requestDigest: hashJson(input.request),
    turnId: "",
  };
}

function validateIdempotencyKey(key: string): void {
  if (!key || key.length > 256) {
    throw Object.assign(new Error("Idempotency-Key must contain 1-256 characters"), {
      code: "invalid_idempotency_key",
      status: 400,
    });
  }
}

function idempotencyConflict(): Error & { code: string; status: number } {
  return Object.assign(new Error("idempotency key was already used with a different request"), {
    code: "idempotency_conflict",
    status: 409,
  });
}

function upsert<T extends { id: string }>(items: T[], value: T): void {
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) items.push(value);
  else items[index] = value;
}

function assertUnique(items: Array<{ id: string }>, kind: string): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error(`duplicate ${kind} id in journal projection`);
  }
}
