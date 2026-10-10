import type {
  ContinuityDisclosure,
  LaneCheckpoint,
  Session,
  Thread,
  ThreadTurn,
  TurnEnqueueProblem,
} from "@claudexor/schema";
import { Thread as ThreadSchema, ThreadTurn as ThreadTurnSchema } from "@claudexor/schema";
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
} from "../thread-lane-checkpoints.js";
import { reduceThreadLifecycle, type ThreadLifecycleAction } from "../thread-lifecycle.js";
import { deriveThreadTitle } from "../thread-title.js";
import {
  threadCreationIdempotency,
  turnRunConflict,
  turnIdempotency,
  type ThreadMutation,
  buildNewThread,
  mergeThreadPatch,
} from "../thread-store-support.js";
import { threadWorktreeMutation } from "../thread-worktree-state.js";

import type { CreateThreadInput, CreateTurnInput, UpdateThreadInput } from "../threads.js";
import { BlobFiles } from "./blob-files.js";
import { appendPreparedEventInTx, prepareEvent } from "./event-store.js";
import { globalGeneration, isServedPid, requireServedGeneration } from "./generations.js";
import { lookupIdempotency } from "./idempotency.js";
import { runMutation, type MutationContext } from "./mutation.js";
import { Obligations } from "./obligations.js";
import type { PartitionGeneration } from "./partitions.js";
import { appendEvent } from "./retention.js";
import type { EngineStore } from "./store.js";
import { findThreadCreationAcross } from "./thread-replay.js";
import {
  applyThreadMutation,
  decodeBody,
  hydrateTurn,
  prepareThreadMutation,
  readThread,
  readTurn,
  type PreparedThreadMutation,
} from "./thread-rows.js";

/** Addressed SQL conversation owner. It never loads retained journal history. */
export class SqlThreadStore {
  constructor(
    readonly store: EngineStore,
    readonly blobs: BlobFiles,
    readonly generation: Pick<PartitionGeneration, "pid" | "name" | "epoch">,
    readonly obligations: Obligations,
  ) {}

  private allThreads(): Thread[] {
    return this.store
      .prepare("SELECT body FROM thread WHERE pid=? ORDER BY rowid")
      .all(this.generation.pid)
      .map((row) => decodeBody<Thread>(row as { body: Uint8Array }));
  }
  private allSessions(): Session[] {
    return this.store
      .prepare("SELECT body FROM session WHERE pid=? ORDER BY insertion_ordinal")
      .all(this.generation.pid)
      .map((row) => decodeBody<Session>(row as { body: Uint8Array }));
  }
  private allCheckpoints(): LaneCheckpoint[] {
    return this.store
      .prepare("SELECT body FROM lane_checkpoint WHERE pid=? ORDER BY insertion_ordinal")
      .all(this.generation.pid)
      .map((row) => decodeBody<LaneCheckpoint>(row as { body: Uint8Array }));
  }

  prepare(mutation: ThreadMutation): PreparedThreadMutation {
    requireServedGeneration(this.store, this.generation.pid);
    return prepareThreadMutation(this.blobs, mutation);
  }

  /** Compound project relink and terminal owners compose in their one transaction. */
  applyInTx(tx: MutationContext, prepared: PreparedThreadMutation): void {
    requireServedGeneration(tx, this.generation.pid);
    const time = tx.now().toISOString();
    tx.changes.blobChanged(...applyThreadMutation(tx, this.generation.pid, prepared, time));
    // The former full entity event consumes sequence, but has no stream row.
    appendEvent(tx, this.generation.pid, { type: "thread.entities_upserted", payload: null, time });
    const touched = new Set([
      ...(prepared.mutation.threads ?? []).map((item) => item.id),
      ...(prepared.mutation.turns ?? []).map((item) => item.thread_id),
      ...(prepared.mutation.sessions ?? []).map((item) => item.thread_id),
      ...(prepared.mutation.checkpoints ?? []).map((item) => item.thread_id),
    ]);
    for (const id of touched) this.pingHeadInTx(tx, id);
  }

  private commit(mutation: ThreadMutation, purge?: Thread): void {
    const prepared = this.prepare(mutation);
    runMutation(this.store, (tx) => {
      this.applyInTx(tx, prepared);
      if (purge)
        this.obligations.create("purge_fs", purge.id, this.generation.pid, { thread: purge });
    });
  }

  pingHeadInTx(tx: MutationContext, threadId: string): void {
    requireServedGeneration(tx, this.generation.pid);
    const global = globalGeneration(tx);
    if (!global || global.status !== "ready")
      throw new Error("global thread head authority is unavailable");
    const row = tx
      .prepare(
        "UPDATE thread SET head_revision=head_revision+1 WHERE id=? AND pid=? RETURNING head_revision",
      )
      .get(threadId, this.generation.pid) as { head_revision: number } | undefined;
    if (!row) return;
    const projectId = this.generation.name.startsWith("project:")
      ? this.generation.name.slice(8)
      : null;
    const event = prepareEvent(this.blobs, {
      type: "thread.head.updated",
      time: tx.now().toISOString(),
      payload: { thread_id: threadId, project_id: projectId, revision: row.head_revision },
    });
    appendPreparedEventInTx(tx, this.blobs, global.pid, event);
  }

  pingHead(threadId: string): void {
    requireServedGeneration(this.store, this.generation.pid);
    runMutation(this.store, (tx) => this.pingHeadInTx(tx, threadId));
  }
  revision(threadId: string): number {
    return Number(
      (
        this.store
          .prepare("SELECT head_revision FROM thread WHERE id=? AND pid=?")
          .get(threadId, this.generation.pid) as { head_revision: number } | undefined
      )?.head_revision ?? 0,
    );
  }
  createThread(input: CreateThreadInput): Thread {
    const creation = threadCreationIdempotency(this.generation.name, input.idempotency);
    const existing = this.findThreadCreation(input.idempotency);
    if (existing) return existing;
    const thread = buildNewThread(input);
    if (creation) creation.threadId = thread.id;
    this.commit({ threads: [thread], ...(creation ? { threadCreation: creation } : {}) });
    return thread;
  }

  /** Accepted-creation replay lookup, recovered before mutable path admission. */
  findThreadCreation(
    input: CreateThreadInput["idempotency"],
    exactRequestOnly = false,
  ): Thread | undefined {
    if (!isServedPid(this.store, this.generation.pid)) return undefined;
    return findThreadCreationAcross(this.store, [this.generation], input, exactRequestOnly);
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
    const thread = this.changeLifecycle(id, "purge");
    // An imported purged conversation may still have filesystem leftovers.
    // Repeating purge preserves its revision and accepted creation bindings.
    if (
      !this.store.prepare("SELECT 1 FROM effect_obligation WHERE kind='purge_fs' AND key=?").get(id)
    ) {
      runMutation(this.store, () =>
        this.obligations.create("purge_fs", id, this.generation.pid, { thread }),
      );
    }
    return thread;
  }

  private changeLifecycle(id: string, action: ThreadLifecycleAction): Thread {
    const thread = this.getThread(id);
    if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
    const next = reduceThreadLifecycle(thread, action);
    if (next !== thread) this.commit({ threads: [next] }, action === "purge" ? thread : undefined);
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
        this.sessionsForThread(id),
        worktreePath,
        baseSha,
        deliveredThroughRunId,
      ),
    );
  }

  listThreads(only?: "purged"): Thread[] {
    if (!isServedPid(this.store, this.generation.pid)) return [];
    return this.store
      .prepare(
        `SELECT body FROM thread WHERE pid=? AND state ${only ? "=" : "<>"} 'purged' ORDER BY updated_at DESC,rowid DESC`,
      )
      .all(this.generation.pid)
      .map((row) => decodeBody<Thread>(row as { body: Uint8Array }));
  }
  getThread(id: string): Thread | undefined {
    return isServedPid(this.store, this.generation.pid)
      ? readThread(this.store, this.generation.pid, id)
      : undefined;
  }
  turnsFor(threadId: string): ThreadTurn[] {
    if (!isServedPid(this.store, this.generation.pid)) return [];
    return this.store
      .prepare("SELECT body,prompt_sha FROM turn WHERE thread_id=? AND pid=? ORDER BY ordinal")
      .all(threadId, this.generation.pid)
      .map((row) => hydrateTurn(row as { body: Uint8Array; prompt_sha: string }, this.blobs));
  }
  getTurn(id: string): ThreadTurn | undefined {
    return isServedPid(this.store, this.generation.pid)
      ? readTurn(this.store, this.blobs, this.generation.pid, id)
      : undefined;
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
    if (!isServedPid(this.store, this.generation.pid)) return [];
    return this.store
      .prepare("SELECT body FROM session WHERE thread_id=? AND pid=? ORDER BY insertion_ordinal")
      .all(threadId, this.generation.pid)
      .map((row) => decodeBody<Session>(row as { body: Uint8Array }));
  }

  /** Native resume map for a thread: harnessId -> native session id (live sessions only). */
  resumeMap(
    threadId: string,
    profileId: string | null = null,
  ): Record<string, { sessionId: string; profileId: string | null }> {
    return resumeMapFrom(this.sessionsForThread(threadId), threadId, profileId);
  }

  createTurn(threadId: string, prompt: string, input: CreateTurnInput = {}): ThreadTurn {
    const idempotency = turnIdempotency(this.generation.name, threadId, input.idempotency);
    if (idempotency) {
      const existing = this.findTurnByIdempotency(threadId, input.idempotency!);
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
    const existingTurns =
      Number(
        (
          this.store
            .prepare(
              "SELECT ordinal FROM turn WHERE thread_id=? AND pid=? ORDER BY ordinal DESC LIMIT 1",
            )
            .get(threadId, this.generation.pid) as { ordinal: number } | undefined
        )?.ordinal ?? -1,
      ) + 1;
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
    const idempotency = turnIdempotency(this.generation.name, threadId, input);
    if (!idempotency || !isServedPid(this.store, this.generation.pid)) return undefined;
    const binding = lookupIdempotency(
      this.store,
      { owner: "turn", pid: this.generation.pid, keyDigest: idempotency.keyDigest },
      idempotency.requestDigest,
    );
    if (!binding) return undefined;
    const turn = this.getTurn(binding.targetId);
    if (!turn) throw new Error(`idempotency record points to missing turn ${binding.targetId}`);
    return turn;
  }

  /** Bind a started run to its turn and advance the thread head (runner-owned). */
  bindTurnRun(turnId: string, runId: string): void {
    const turn = this.getTurn(turnId);
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
    const turn = this.getTurn(turnId);
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
    const existing = this.sessionsForThread(threadId).find(
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
    return findLaneCheckpoint(
      this.laneCheckpointsForThread(threadId),
      threadId,
      harnessId,
      profileId,
    );
  }

  /** All lane checkpoints of a thread (used to identify the prior head's lane). */
  laneCheckpointsForThread(threadId: string): LaneCheckpoint[] {
    if (!isServedPid(this.store, this.generation.pid)) return [];
    return this.store
      .prepare(
        "SELECT body FROM lane_checkpoint WHERE thread_id=? AND pid=? ORDER BY insertion_ordinal",
      )
      .all(threadId, this.generation.pid)
      .map((row) => decodeBody<LaneCheckpoint>(row as { body: Uint8Array }));
  }

  /** Stamp how a turn's lane was continued (INV-137); last-writer-wins. */
  setTurnContinuity(turnId: string, disclosure: ContinuityDisclosure): void {
    const turn = this.getTurn(turnId);
    if (!turn) return;
    this.commit({ turns: [stampContinuity(turn, disclosure)] });
  }

  relinkProjectRoot(root: string): void {
    const threads = this.allThreads()
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
    return accountBindingsFrom(
      this.sessionsForThread(threadId),
      this.laneCheckpointsForThread(threadId),
      threadId,
    );
  }

  resumeMapAuto(threadId: string): Record<string, { sessionId: string; profileId: string | null }> {
    return resumeMapAutoFrom(this.sessionsForThread(threadId), threadId);
  }

  migrateNullProfileContinuity(
    harnessId: string,
    rowId: string,
  ): { sessions: number; checkpoints: number } {
    return this.applyContinuityMutation(
      migrateNullProfileContinuityMutation(
        this.allSessions(),
        this.allCheckpoints(),
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
        this.allSessions(),
        this.allCheckpoints(),
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
      this.allThreads(),
      this.allSessions(),
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
