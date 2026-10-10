import { existsSync } from "node:fs";
import {
  isEphemeralRunScope,
  PROJECT_NOT_REGISTERED_REQUIRED_ACTIONS,
  type ControlProjectListingProblem,
  type Thread,
  type ThreadTurn,
} from "@claudexor/schema";
import { hashJson, isClaudexorOwnedRuntimePath } from "@claudexor/util";
import type { CreateThreadInput, CreateTurnInput, UpdateThreadInput } from "../threads.js";
import { recordInterruptedRunlessTurns } from "../runless-turn-recovery.js";
import {
  isServedPid,
  requireServedGeneration,
  servedGenerations,
  SERVED_PIDS_SQL,
} from "./generations.js";
import { partitionById, type PartitionGeneration } from "./partitions.js";
import { SqlProjectStore } from "./projects.js";
import { findThreadCreationAcross } from "./thread-replay.js";
import { decodeBody } from "./thread-rows.js";
import { SqlThreadStore } from "./threads.js";

/** SQL routing returns one generation, never an array of recovered stores.
 * Command/interaction/decision owners use these same addressed routes. */
export class SqlProjectRouter {
  constructor(readonly projects: SqlProjectStore) {}
  get store() {
    return this.projects.store;
  }

  threadStore(generation: Pick<PartitionGeneration, "pid" | "name" | "epoch">): SqlThreadStore {
    return new SqlThreadStore(
      this.store,
      this.projects.blobs,
      generation,
      this.projects.obligations,
    );
  }
  private globalThreads(): SqlThreadStore {
    return this.threadStore(this.projects.global());
  }

  generationForThread(id: string): PartitionGeneration | null {
    return this.entityGeneration("thread", id);
  }
  generationForTurn(id: string): PartitionGeneration | null {
    return this.entityGeneration("turn", id);
  }
  generationForCommand(id: string): PartitionGeneration | null {
    return this.entityGeneration("command", id);
  }
  private entityGeneration(
    table: "thread" | "turn" | "command",
    id: string,
  ): PartitionGeneration | null {
    const row = this.store.prepare(`SELECT pid FROM ${table} WHERE id=?`).get(id) as
      { pid: number } | undefined;
    return row && isServedPid(this.store, row.pid) ? partitionById(this.store, row.pid) : null;
  }

  generationForRequest(params: unknown): PartitionGeneration {
    const input = params as { threadId?: unknown; scope?: unknown } | null;
    if (typeof input?.threadId === "string") {
      const generation = this.generationForThread(input.threadId);
      if (generation) return generation;
    }
    const scope = input?.scope as { kind?: unknown; root?: unknown } | undefined;
    if (scope?.kind !== "project" || isEphemeralRunScope(scope)) return this.projects.global();
    const root = typeof scope.root === "string" ? scope.root : "";
    const project = this.projects.findByRoot(root);
    if (!project)
      throw Object.assign(new Error(`project is not registered: ${root}`), {
        code: "project_not_registered",
        status: 404,
        retryable: false,
        requiredActions: [...PROJECT_NOT_REGISTERED_REQUIRED_ACTIONS],
      });
    const generation = this.projects.partition(project.id);
    if (!generation) throw new Error("registered project has no generation");
    return requireServedGeneration(this.store, generation.pid);
  }

  registerProject(input: Parameters<SqlProjectStore["register"]>[0]) {
    return this.projects.register(input);
  }
  relinkProject(id: string, root: string) {
    return this.projects.relink(id, root);
  }
  removeProject(id: string, activeRunRoots: ReadonlySet<string>) {
    return this.projects.remove(id, activeRunRoots);
  }

  findThreadCreation(input: CreateThreadInput & { ephemeral?: boolean }): Thread | null {
    const root = input.ephemeral === true ? null : (input.repoRoot ?? null);
    if (!root) return this.globalThreads().findThreadCreation(input.idempotency) ?? null;
    // Do not resolve the old root (or a symlink to it) before accepted replay.
    const scopes = servedGenerations(this.store).filter((g) => g.name !== "global");
    const accepted = findThreadCreationAcross(this.store, scopes, input.idempotency, true);
    if (accepted) return accepted;
    const project = this.projects.findByRoot(root);
    const generation = project ? this.projects.partition(project.id) : null;
    if (!generation) return null;
    requireServedGeneration(this.store, generation.pid);
    return this.threadStore(generation).findThreadCreation(input.idempotency) ?? null;
  }

  createThread(input: CreateThreadInput & { ephemeral?: boolean }): Thread {
    const accepted = this.findThreadCreation(input);
    if (accepted) return accepted;
    const root = input.ephemeral === true ? null : (input.repoRoot ?? null);
    if (!root) return this.globalThreads().createThread(input);
    let project = this.projects.findByRoot(root);
    if (!project)
      project = this.registerProject({
        root,
        idempotencyKey: `thread-auto-register-${hashJson(root)}`,
        clientId: "thread-create",
      }).project;
    const generation = this.projects.partition(project.id)!;
    return this.threadStore(generation).createThread(input);
  }

  listThreadsResilient(): { threads: Thread[]; problems: ControlProjectListingProblem[] } {
    const threads = this.globalThreads().listThreads();
    const problems: ControlProjectListingProblem[] = [];
    for (const project of this.projects.list()) {
      const generation = this.projects.partition(project.id);
      if (!generation || generation.status !== "ready") continue;
      if (!existsSync(project.root)) {
        problems.push({
          projectId: project.id,
          root: project.root,
          code: "project_root_missing",
          message: `project root no longer exists: ${project.root}`,
        });
        continue;
      }
      threads.push(...this.threadStore(generation).listThreads());
    }
    threads.sort((a, b) =>
      a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
    );
    return { threads, problems };
  }
  listThreads(): Thread[] {
    return this.listThreadsResilient().threads;
  }
  listPurgedThreads(): Thread[] {
    return (
      this.store
        .prepare(`SELECT body FROM thread WHERE pid IN (${SERVED_PIDS_SQL}) AND state='purged'`)
        .all() as Array<{ body: Uint8Array }>
    ).map(decodeBody<Thread>);
  }
  getThread(id: string): Thread | undefined {
    return this.forThread(id)?.getThread(id);
  }
  getTurn(id: string): ThreadTurn | undefined {
    return this.forTurn(id)?.getTurn(id);
  }
  turnsFor(id: string): ThreadTurn[] {
    return this.forThread(id)?.turnsFor(id) ?? [];
  }
  sessionsForThread(id: string) {
    return this.forThread(id)?.sessionsForThread(id) ?? [];
  }
  createTurn(id: string, prompt: string, input: CreateTurnInput = {}) {
    return this.requireThread(id).createTurn(id, prompt, input);
  }
  findTurnByIdempotency(id: string, input: NonNullable<CreateTurnInput["idempotency"]>) {
    return this.requireThread(id).findTurnByIdempotency(id, input);
  }
  updateThread(id: string, patch: UpdateThreadInput) {
    return this.requireThread(id).updateThread(id, patch);
  }
  trashThread(id: string) {
    return this.requireThread(id).trashThread(id);
  }
  restoreThread(id: string) {
    return this.requireThread(id).restoreThread(id);
  }
  purgeThread(id: string) {
    return this.requireThread(id).purgeThread(id);
  }
  setThreadWorktree(id: string, path: string, base: string, through?: string): void {
    this.requireThread(id).setThreadWorktree(id, path, base, through);
  }
  assertKnownIds(threadId: unknown, turnId: unknown) {
    const id = typeof threadId === "string" && threadId ? threadId : undefined;
    const turn = typeof turnId === "string" && turnId ? turnId : undefined;
    return (
      id ? this.requireThread(id) : turn ? this.requireTurn(turn) : this.globalThreads()
    ).assertKnownIds(threadId, turnId);
  }
  bindTurnRun(id: string, runId: string): void {
    this.requireTurn(id).bindTurnRun(id, runId);
  }
  setTurnEnqueueError(
    id: string,
    problem: Parameters<SqlThreadStore["setTurnEnqueueError"]>[1],
  ): void {
    this.requireTurn(id).setTurnEnqueueError(id, problem);
  }
  resumeMap(id: string, profileId: string | null = null) {
    return this.requireThread(id).resumeMap(id, profileId);
  }
  resumeMapAuto(id: string) {
    return this.requireThread(id).resumeMapAuto(id);
  }
  accountBindings(id: string) {
    return this.requireThread(id).accountBindings(id);
  }
  recordSession(
    id: string,
    harnessId: string,
    nativeId: string,
    observed?: string | null,
    profileId: string | null = null,
  ): void {
    this.requireThread(id).recordSession(id, harnessId, nativeId, observed, profileId);
  }
  recordLaneCheckpoint(
    id: string,
    harnessId: string,
    profileId: string | null,
    turnId: string,
  ): void {
    this.requireThread(id).recordLaneCheckpoint(id, harnessId, profileId, turnId);
  }
  laneCheckpoint(id: string, harnessId: string, profileId: string | null) {
    return this.forThread(id)?.laneCheckpoint(id, harnessId, profileId) ?? null;
  }
  laneCheckpointsForThread(id: string) {
    return this.forThread(id)?.laneCheckpointsForThread(id) ?? [];
  }
  setTurnContinuity(
    id: string,
    disclosure: Parameters<SqlThreadStore["setTurnContinuity"]>[1],
  ): void {
    this.forTurn(id)?.setTurnContinuity(id, disclosure);
  }
  pingThreadHead(id: string): void {
    this.forThread(id)?.pingHead(id);
  }

  migrateNullProfileContinuity(harnessId: string, rowId: string) {
    return this.continuity((s) => s.migrateNullProfileContinuity(harnessId, rowId));
  }
  rollbackProfileContinuity(harnessId: string, rowId: string) {
    return this.continuity((s) => s.rollbackProfileContinuity(harnessId, rowId));
  }
  private continuity(apply: (s: SqlThreadStore) => { sessions: number; checkpoints: number }) {
    let sessions = 0,
      checkpoints = 0;
    for (const generation of servedGenerations(this.store)) {
      const result = apply(this.threadStore(generation));
      sessions += result.sessions;
      checkpoints += result.checkpoints;
    }
    return { sessions, checkpoints, skippedPartitions: this.unreadyProjects() };
  }
  private unreadyProjects(): string[] {
    return (
      this.store
        .prepare(
          `SELECT p.id FROM project p LEFT JOIN partition q ON q.id=p.current_pid
      WHERE p.pid=? AND p.status='active' AND (q.id IS NULL OR q.status<>'ready') ORDER BY p.rowid`,
        )
        .all(this.projects.global().pid) as Array<{ id: string }>
    ).map((row) => row.id);
  }
  assertCredentialProfileInvalidationReady(): void {
    const unavailable = this.unreadyProjects();
    if (unavailable.length)
      throw Object.assign(
        new Error(
          `credential profile deletion requires recovery of project partition(s): ${unavailable.join(", ")}`,
        ),
        { status: 409, code: "journal_recovery_required" },
      );
  }
  invalidateCredentialProfile(harnessId: string, profileId: string) {
    this.assertCredentialProfileInvalidationReady();
    let clearedThreads = 0,
      invalidatedSessions = 0;
    for (const generation of servedGenerations(this.store)) {
      const result = this.threadStore(generation).invalidateCredentialProfile(harnessId, profileId);
      clearedThreads += result.clearedThreads;
      invalidatedSessions += result.invalidatedSessions;
    }
    return { clearedThreads, invalidatedSessions };
  }
  healthyProjectRoots(): string[] {
    return (
      this.store
        .prepare(
          `SELECT p.root FROM project p JOIN partition q ON q.id=p.current_pid
      WHERE p.pid=? AND p.status='active' AND q.status='ready' ORDER BY p.rowid`,
        )
        .all(this.projects.global().pid) as Array<{ root: string }>
    ).map((row) => row.root);
  }
  quarantineGhostProjects() {
    const retired: Array<{ projectId: string; root: string; reason: string }> = [];
    for (const project of this.projects.list()) {
      const owned = isClaudexorOwnedRuntimePath(project.root);
      if (!owned && existsSync(project.root)) continue;
      this.projects.unregister(project.id);
      retired.push({
        projectId: project.id,
        root: project.root,
        reason: owned ? "root_inside_claudexor_runtime" : "root_permanently_missing",
      });
    }
    return retired;
  }

  /** Startup-only query joins the selected turn to its command, without
   * loading accepted request bodies or every command's retained history. */
  recoverRunlessTurns(): number {
    const rows = this.store
      .prepare(
        `SELECT c.turn_id,json_extract(CAST(c.error AS TEXT),'$.error') AS error FROM turn t JOIN command c ON c.turn_id=t.id
      WHERE t.pid IN (${SERVED_PIDS_SQL}) AND t.run_id IS NULL AND c.pid=t.pid AND c.live=1
        AND c.state='interrupted' AND c.run_id IS NULL
        AND json_extract(CAST(t.body AS TEXT),'$.enqueue_error') IS NULL ORDER BY c.rowid`,
      )
      .all() as Array<{ turn_id: string; error: string | null }>;
    return recordInterruptedRunlessTurns(
      this,
      rows.map((row) => ({
        state: "interrupted",
        params: { turnId: row.turn_id },
        ...(row.error !== null ? { error: row.error } : {}),
      })),
    );
  }

  private forThread(id: string): SqlThreadStore | undefined {
    const g = this.generationForThread(id);
    return g ? this.threadStore(g) : undefined;
  }
  private forTurn(id: string): SqlThreadStore | undefined {
    const g = this.generationForTurn(id);
    return g ? this.threadStore(g) : undefined;
  }
  private requireThread(id: string): SqlThreadStore {
    const s = this.forThread(id);
    if (!s) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
    return s;
  }
  private requireTurn(id: string): SqlThreadStore {
    const s = this.forTurn(id);
    if (!s) throw Object.assign(new Error(`no such turn: ${id}`), { status: 404 });
    return s;
  }
}
