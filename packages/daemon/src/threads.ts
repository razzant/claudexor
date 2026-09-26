import type { DurableJournal } from "@claudexor/journal";
import type {
  Attachment,
  ContinuityDisclosure,
  LaneCheckpoint,
  Session,
  Thread,
  ThreadTurn,
  TurnEnqueueProblem,
  WorkspaceMode,
} from "@claudexor/schema";
import {
  LaneCheckpoint as LaneCheckpointSchema,
  Session as SessionSchema,
  Thread as ThreadSchema,
  ThreadTurn as ThreadTurnSchema,
} from "@claudexor/schema";
import {
  newId,
  nowIso,
  redactSecrets,
  safeProblemContext,
  safeProblemMessage,
  safeProblemRequiredActions,
} from "@claudexor/util";
import {
  accountBindingsFrom,
  invalidateCredentialProfileMutation,
  findLaneCheckpoint,
  makeLaneCheckpoint,
  makeSessionRecord,
  migrateNullProfileContinuityMutation,
  resumeMapAutoFrom,
  resumeMapFrom,
  rollbackProfileContinuityMutation,
  stampContinuity,
  threadLaneCheckpoints,
} from "./thread-lane-checkpoints.js";
import { reduceThreadLifecycle, type ThreadLifecycleAction } from "./thread-lifecycle.js";
import { deriveThreadTitle } from "./thread-title.js";
import {
  assertUnique,
  findIdempotentTurn,
  idempotencyConflict,
  parseMutation,
  threadCreationIdempotency,
  turnRunConflict,
  turnIdempotency,
  upsert,
  type ThreadMutation,
  buildNewThread,
  mergeThreadPatch,
} from "./thread-store-support.js";
import { threadWorktreeMutation } from "./thread-worktree-state.js";

interface ThreadStoreState {
  threads: Thread[];
  sessions: Session[];
  turns: ThreadTurn[];
  checkpoints: LaneCheckpoint[]; // per-lane checkpoints (INV-137)
}

const UPSERTED = "thread.entities_upserted";

export interface CreateThreadInput {
  title?: string;
  folder?: string | null;
  repoRoot?: string | null;
  mode?: Thread["mode"];
  /** in_place (default) mutates the live tree; isolated keeps a thread worktree. */
  workspace?: WorkspaceMode;
  authPreference?: Thread["auth_preference"];
  credentialProfileId?: string | null;
  /** Sticky write scope for write turns (null/omit = repo trust default). */
  access?: Thread["access"];
  primaryHarness?: string | null;
  /** Sticky eligible harness pool for the thread (turns inherit when unset). */
  eligibleHarnesses?: string[];
  idempotency?: { key: string; client: string; request: unknown };
}

export interface CreateTurnInput {
  kind?: ThreadTurn["kind"];
  parentRunId?: string | null;
  answersPlanRunId?: string | null;
  planRunId?: string | null;
  /** Freeze-on-implement provenance (D17): sha256 of the implemented plan. */
  planHash?: string | null;
  planOverridden?: boolean;
  /** Files/images attached to this turn, already resolved to scoped on-disk paths. */
  attachments?: Attachment[];
  idempotency?: { key: string; client: string; request: unknown };
}

export interface UpdateThreadInput {
  title?: string;
  folder?: string | null;
  state?: "active" | "closed";
  /** Switch the sticky primary harness (null => clear back to auto). */
  primaryHarness?: string | null;
  /** Switch the thread's sticky credential profile (null => engine default). */
  credentialProfileId?: string | null;
  /** Replace the sticky eligible harness pool. */
  eligibleHarnesses?: string[];
  /** Switch the sticky write scope (null => repo trust default). */
  access?: Thread["access"];
}

/**
 * Sink for the content-free `thread.head.updated` invalidation ping (W12).
 * Bound at composition time to the GLOBAL-partition emitter, so a mutation in
 * a project partition still reaches the app's single global stream.
 */
export type ThreadHeadPingSink = (ping: { threadId: string; projectId: string | null }) => void;

/** Journal-backed thread/session projection. Returned mutations are fsynced. */
export class ThreadStore {
  private state: ThreadStoreState = { threads: [], sessions: [], turns: [], checkpoints: [] };
  private readonly turnIdByKey = new Map<string, { turnId: string; requestDigest: string }>();
  private readonly threadIdByKey = new Map<string, { threadId: string; requestDigest: string }>();

  constructor(
    private readonly journal: DurableJournal,
    private readonly headPing?: ThreadHeadPingSink,
  ) {
    this.replay();
  }

  validateProjection(): void {
    for (const thread of this.state.threads) ThreadSchema.parse(thread);
    for (const session of this.state.sessions) SessionSchema.parse(session);
    for (const turn of this.state.turns) ThreadTurnSchema.parse(turn);
    for (const checkpoint of this.state.checkpoints) LaneCheckpointSchema.parse(checkpoint);
    assertUnique(this.state.threads, "thread");
    assertUnique(this.state.sessions, "session");
    assertUnique(this.state.turns, "turn");
    assertUnique(this.state.checkpoints, "lane checkpoint");
    for (const value of this.turnIdByKey.values()) {
      if (!this.getTurn(value.turnId)) throw new Error("thread idempotency index is dangling");
    }
    for (const value of this.threadIdByKey.values()) {
      if (!this.getThread(value.threadId))
        throw new Error("thread creation idempotency index is dangling");
    }
  }

  private replay(): void {
    for (const record of this.journal.records(0, [UPSERTED])) {
      if (record.type === UPSERTED) this.apply(parseMutation(record.payload));
    }
    this.validateProjection();
  }

  private commit(mutation: ThreadMutation): void {
    const parsed = parseMutation(mutation);
    this.journal.append(UPSERTED, parsed);
    this.apply(parsed);
    // Every PERSISTED mutation invalidates the touched threads' summaries —
    // pinging here (the single writer) covers create/rename/archive/turn-add/
    // enqueue-error/session/checkpoint without per-call-site wiring. Replay never
    // pings (it goes through apply(), not commit()); run-terminal pings directly.
    const touched = new Set<string>([
      ...(parsed.threads ?? []).map((thread) => thread.id),
      ...(parsed.turns ?? []).map((turn) => turn.thread_id),
      ...(parsed.sessions ?? []).map((session) => session.thread_id),
      ...(parsed.checkpoints ?? []).map((checkpoint) => checkpoint.thread_id),
    ]);
    for (const threadId of touched) this.pingHead(threadId);
  }

  /**
   * Emit the content-free head-invalidation ping for one thread. The owning
   * partition name is this store's journal partition — the single source of
   * the thread->project mapping.
   */
  pingHead(threadId: string): void {
    const partition = this.journal.options.partition;
    const projectId = partition.startsWith("project:") ? partition.slice("project:".length) : null;
    this.headPing?.({ threadId, projectId });
  }

  private apply(mutation: ThreadMutation): void {
    for (const thread of mutation.threads ?? []) upsert(this.state.threads, thread);
    for (const session of mutation.sessions ?? []) upsert(this.state.sessions, session);
    for (const turn of mutation.turns ?? []) upsert(this.state.turns, turn);
    for (const checkpoint of mutation.checkpoints ?? []) upsert(this.state.checkpoints, checkpoint);
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
    const thread = buildNewThread(input);
    if (creation) creation.threadId = thread.id;
    this.commit({ threads: [thread], ...(creation ? { threadCreation: creation } : {}) });
    return thread;
  }

  /** Rename and/or open/close (archive) a thread. */
  updateThread(id: string, patch: UpdateThreadInput): Thread {
    const thread = this.getThread(id);
    if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
    if (thread.state === "trashed" || thread.state === "purged") {
      throw Object.assign(new Error(`thread ${id} is ${thread.state}`), {
        status: 409,
        code: `thread_${thread.state}`,
      });
    }
    const next = mergeThreadPatch(thread, patch);
    this.commit({ threads: [next] });
    return next;
  }

  trashThread(id: string): Thread {
    return this.changeLifecycle(id, "trash");
  }

  restoreThread(id: string): Thread {
    return this.changeLifecycle(id, "restore");
  }

  purgeThread(id: string): Thread {
    return this.changeLifecycle(id, "purge");
  }

  private changeLifecycle(id: string, action: ThreadLifecycleAction): Thread {
    const thread = this.getThread(id);
    if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
    const next = reduceThreadLifecycle(thread, action);
    if (next !== thread) this.commit({ threads: [next] });
    return next;
  }

  /** Persist the resolved isolated worktree path + base sha for a thread. */
  setThreadWorktree(
    id: string,
    worktreePath: string,
    baseSha: string,
    deliveredThroughRunId?: string,
  ): void {
    const thread = this.getThread(id);
    if (!thread) return;
    this.commit(
      threadWorktreeMutation(
        thread,
        this.state.sessions,
        worktreePath,
        baseSha,
        deliveredThroughRunId,
      ),
    );
  }

  listThreads(): Thread[] {
    return this.state.threads
      .filter((thread) => thread.state !== "purged")
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
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
  resumeMap(
    threadId: string,
    profileId: string | null = null,
  ): Record<string, { sessionId: string; profileId: string | null }> {
    return resumeMapFrom(this.state.sessions, threadId, profileId);
  }

  createTurn(threadId: string, prompt: string, input: CreateTurnInput = {}): ThreadTurn {
    const idempotency = turnIdempotency(
      this.journal.options.partition,
      threadId,
      input.idempotency,
    );
    if (idempotency) {
      const existing = findIdempotentTurn(this.turnIdByKey, (id) => this.getTurn(id), idempotency);
      if (existing) return existing;
    }
    const thread = this.getThread(threadId);
    if (!thread) throw Object.assign(new Error(`no such thread: ${threadId}`), { status: 404 });
    if (thread.state === "trashed" || thread.state === "purged") {
      throw Object.assign(new Error(`thread ${threadId} is ${thread.state}`), {
        status: 409,
        code: `thread_${thread.state}`,
      });
    }
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
      answers_plan_run_id: input.answersPlanRunId ?? null,
      plan_run_id: input.planRunId ?? null,
      plan_hash: input.planHash ?? null,
      plan_readiness_overridden: input.planOverridden === true,
      kind,
      // Redact at the persistence boundary (the store is read back into UIs).
      prompt: redactSecrets(prompt),
      attachments: input.attachments ?? [],
      created_at: nowIso(),
    });
    // First prompt names the thread (no LLM): cheap, honest, editable via rename.
    const nextThread = ThreadSchema.parse({
      ...thread,
      title: thread.title || deriveThreadTitle(turn.prompt),
      updated_at: nowIso(),
    });
    if (idempotency) idempotency.turnId = turn.id;
    this.commit({ threads: [nextThread], turns: [turn], ...(idempotency ? { idempotency } : {}) });
    return turn;
  }

  findTurnByIdempotency(
    threadId: string,
    input: NonNullable<CreateTurnInput["idempotency"]>,
  ): ThreadTurn | undefined {
    const idempotency = turnIdempotency(this.journal.options.partition, threadId, input);
    return findIdempotentTurn(this.turnIdByKey, (id) => this.getTurn(id), idempotency);
  }

  /** Bind a started run to its turn and advance the thread head (runner-owned). */
  bindTurnRun(turnId: string, runId: string): void {
    const turn = this.state.turns.find((t) => t.id === turnId);
    if (!turn) return;
    if (turn.run_id === runId) return;
    if (turn.run_id) throw turnRunConflict(turnId, turn.run_id, runId);
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
   * own terminal artifacts, so a late failure report is ignored. One typed
   * object carries code, retryability, recovery actions, and bounded context;
   * adding a field cannot silently fall out of a positional callback chain.
   */
  setTurnEnqueueError(turnId: string, problem: TurnEnqueueProblem): void {
    const turn = this.state.turns.find((t) => t.id === turnId);
    if (!turn || turn.run_id) return;
    const nextTurn = ThreadTurnSchema.parse({
      ...turn,
      enqueue_error: {
        ...problem,
        message: safeProblemMessage(problem.message),
        required_actions: safeProblemRequiredActions(problem.required_actions),
        context: safeProblemContext(problem.context),
        failed_at: nowIso(),
      },
    });
    const thread = this.getThread(turn.thread_id);
    const nextThread = thread ? ThreadSchema.parse({ ...thread, updated_at: nowIso() }) : undefined;
    this.commit({ turns: [nextTurn], ...(nextThread ? { threads: [nextThread] } : {}) });
  }

  /** Record/refresh a harness's native session; see `makeSessionRecord` (INV-135). */
  recordSession(
    threadId: string,
    harnessId: string,
    nativeSessionId: string,
    observedModel?: string | null,
    profileId: string | null = null,
  ): void {
    const existing = this.state.sessions.find(
      (s) =>
        s.thread_id === threadId &&
        s.harness_id === harnessId &&
        (s.profile_id ?? null) === (profileId ?? null),
    );
    const session = makeSessionRecord(
      existing,
      threadId,
      harnessId,
      nativeSessionId,
      observedModel,
      profileId,
    );
    const thread = this.getThread(threadId);
    const nextThread = thread
      ? ThreadSchema.parse({ ...thread, updated_at: session.updated_at })
      : undefined;
    this.commit({ sessions: [session], ...(nextThread ? { threads: [nextThread] } : {}) });
  }

  /** Advance a lane's checkpoint to `turnId` (INV-137): the lane
   * (thread, harness, profile) has now SEEN that turn. Same (harness, profile)
   * key as `resumeMap`, so the next turn's packet math is exact. */
  recordLaneCheckpoint(
    threadId: string,
    harnessId: string,
    profileId: string | null,
    turnId: string,
  ): void {
    this.commit({ checkpoints: [makeLaneCheckpoint(threadId, harnessId, profileId, turnId)] });
  }

  /** The last turn a lane has seen, or null when the lane never ran. */
  laneCheckpoint(threadId: string, harnessId: string, profileId: string | null): string | null {
    return findLaneCheckpoint(this.state.checkpoints, threadId, harnessId, profileId);
  }

  /** All lane checkpoints of a thread (used to identify the prior head's lane). */
  laneCheckpointsForThread(threadId: string): LaneCheckpoint[] {
    return threadLaneCheckpoints(this.state.checkpoints, threadId);
  }

  /** Stamp how a turn's lane was continued (INV-137); last-writer-wins. */
  setTurnContinuity(turnId: string, disclosure: ContinuityDisclosure): void {
    const turn = this.state.turns.find((t) => t.id === turnId);
    if (!turn) return;
    this.commit({ turns: [stampContinuity(turn, disclosure)] });
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

  /** D-U1 order 2 / INV-137 unified-accounts readers and mutations — the
   * derivation contracts live in thread-lane-checkpoints.ts. */
  accountBindings(threadId: string): Record<string, string> {
    return accountBindingsFrom(this.state.sessions, this.state.checkpoints, threadId);
  }

  resumeMapAuto(threadId: string): Record<string, { sessionId: string; profileId: string | null }> {
    return resumeMapAutoFrom(this.state.sessions, threadId);
  }

  migrateNullProfileContinuity(
    harnessId: string,
    rowId: string,
  ): { sessions: number; checkpoints: number } {
    return this.applyContinuityMutation(
      migrateNullProfileContinuityMutation(
        this.state.sessions,
        this.state.checkpoints,
        harnessId,
        rowId,
      ),
    );
  }

  rollbackProfileContinuity(
    harnessId: string,
    rowId: string,
  ): { sessions: number; checkpoints: number } {
    return this.applyContinuityMutation(
      rollbackProfileContinuityMutation(
        this.state.sessions,
        this.state.checkpoints,
        harnessId,
        rowId,
      ),
    );
  }

  private applyContinuityMutation(mutation: {
    sessions: Session[];
    checkpoints: LaneCheckpoint[];
  }): {
    sessions: number;
    checkpoints: number;
  } {
    if (mutation.sessions.length > 0 || mutation.checkpoints.length > 0) this.commit(mutation);
    return { sessions: mutation.sessions.length, checkpoints: mutation.checkpoints.length };
  }

  invalidateCredentialProfile(
    harnessId: string,
    profileId: string,
  ): { clearedThreads: number; invalidatedSessions: number } {
    const mutation = invalidateCredentialProfileMutation(
      this.state.threads,
      this.state.sessions,
      harnessId,
      profileId,
    );
    if (mutation.threads.length > 0 || mutation.sessions.length > 0) this.commit(mutation);
    return {
      clearedThreads: mutation.threads.length,
      invalidatedSessions: mutation.sessions.length,
    };
  }
}

export function threadProjection(headPing?: ThreadHeadPingSink) {
  return {
    name: "threads",
    create: (journal: DurableJournal) => new ThreadStore(journal, headPing),
    validate: (store: ThreadStore) => store.validateProjection(),
  };
}
