import { existsSync } from "node:fs";
import type {
  ControlProjectListingProblem,
  Project,
  RunEvent,
  Thread,
  ThreadTurn,
} from "@claudexor/schema";
import { hashJson, isClaudexorOwnedRuntimePath, newId, nowIso } from "@claudexor/util";
import { commandProjection, type CommandStore } from "./command-store.js";
import { JournalManager, type JournalProjectionSlot } from "./journal-manager.js";
import { interactionProjection, type InteractionStore } from "./interactions.js";
import {
  operatorDecisionProjection,
  type OperatorDecisionRecord,
  type OperatorDecisionStore,
} from "./operator-decisions.js";
import { runEventProjection, type RunEventStore } from "./run-events.js";
import type { ProjectStore } from "./projects.js";
import {
  threadProjection,
  type CreateThreadInput,
  type CreateTurnInput,
  type ThreadHeadPingSink,
  type ThreadStore,
  type UpdateThreadInput,
} from "./threads.js";
import type { CommandAuthority } from "./command-authority.js";

interface ProjectPartition {
  manager: JournalManager;
  commands: JournalProjectionSlot<CommandStore>;
  interactions: JournalProjectionSlot<InteractionStore>;
  decisions: JournalProjectionSlot<OperatorDecisionStore>;
  runEvents: JournalProjectionSlot<RunEventStore>;
  threads: JournalProjectionSlot<ThreadStore>;
}

export class ProjectPartitions implements CommandAuthority {
  private readonly partitions = new Map<string, ProjectPartition>();

  constructor(
    private readonly rootDir: string,
    private readonly projects: JournalProjectionSlot<ProjectStore>,
    private readonly globalCommands: JournalProjectionSlot<CommandStore>,
    private readonly globalInteractions: JournalProjectionSlot<InteractionStore>,
    private readonly globalDecisions: JournalProjectionSlot<OperatorDecisionStore>,
    private readonly globalRunEvents: JournalProjectionSlot<RunEventStore>,
    private readonly globalThreads: JournalProjectionSlot<ThreadStore>,
    /** Global-partition `thread.head.updated` sink, threaded into every project ThreadStore. */
    private readonly headPing?: ThreadHeadPingSink,
  ) {
    this.sync();
  }

  all(): CommandStore[] {
    return [
      this.globalCommands.current(),
      ...this.healthy().map((entry) => entry.commands.current()),
    ];
  }

  interactionStores(): InteractionStore[] {
    return [
      this.globalInteractions.current(),
      ...this.healthy().map((entry) => entry.interactions.current()),
    ];
  }

  interactionsForRequest(params: unknown): InteractionStore {
    const commandStore = this.forRequest(params);
    if (commandStore === this.globalCommands.current()) return this.globalInteractions.current();
    const entry = this.healthy().find((candidate) => candidate.commands.current() === commandStore);
    if (!entry) throw new Error("command partition has no interaction authority");
    return entry.interactions.current();
  }

  operatorDecision(params: unknown, runId: string): OperatorDecisionRecord | null {
    return this.decisionStoreForRequest(params).get(runId);
  }

  recordOperatorDecision(
    params: unknown,
    decision: OperatorDecisionRecord,
    idempotency?: { key: string; client: string; request: unknown },
  ): OperatorDecisionRecord {
    return this.decisionStoreForRequest(params).record(decision, idempotency);
  }

  recordRunEvent(params: unknown, event: RunEvent): RunEvent {
    return this.runEventStoreForRequest(params).record(event);
  }

  forRequest(params: unknown): CommandStore {
    const input = record(params);
    const threadId = stringField(input, "threadId");
    if (threadId) {
      const store = this.threadStoreForThread(threadId);
      if (store) return this.commandStoreForThreadStore(store);
    }
    const scope = record(input.scope);
    if (scope.kind !== "project") return this.globalCommands.current();
    const root = stringField(scope, "root");
    return this.partitionForRoot(root).commands.current();
  }

  findById(id: string): CommandStore | undefined {
    return this.all().find((store) => store.get(id));
  }

  beginDelivery(
    params: unknown,
    input: { key: string; client: string; operation: string; request: unknown },
  ) {
    const store = this.forRequest(params);
    const accepted = store.accept({
      id: newId("delivery"),
      params,
      idempotencyKey: input.key,
      clientId: input.client,
      operation: `delivery.${input.operation}`,
      idempotencyParams: input.request,
    });
    const record = accepted.reused
      ? accepted.record
      : store.update(accepted.record.id, { state: "running", startedAt: nowIso() });
    return { ...record, reused: accepted.reused };
  }

  completeDelivery(id: string, result: unknown): void {
    const store = this.findById(id);
    if (!store) throw new Error(`delivery authority lost command ${id}`);
    store.update(id, { state: "succeeded", result, finishedAt: nowIso() });
  }

  failDelivery(id: string, error: unknown): void {
    const store = this.findById(id);
    if (!store) throw new Error(`delivery authority lost command ${id}`);
    const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
    store.update(id, {
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
      errorCode: typeof value["code"] === "string" ? value["code"] : undefined,
      result: {
        status: typeof value["status"] === "number" ? value["status"] : 500,
        code: typeof value["code"] === "string" ? value["code"] : null,
      },
      finishedAt: nowIso(),
    });
  }

  registerProject(input: Parameters<ProjectStore["register"]>[0]): Project {
    const project = this.projects.current().register(input);
    this.ensure(project.id);
    return project;
  }

  /**
   * F2 ghost-cleanup sweep: unregister every project that can never
   * be a legitimate user project — its root is INSIDE the Claudexor runtime
   * tree (an envelope worktree that was auto-registered as a ghost) or its root
   * is permanently GONE from disk. Closes and drops each ghost's partition so
   * it stops polluting listings/retention. Idempotent and best-effort; returns
   * the retired projects for disclosure/logging.
   */
  quarantineGhostProjects(): Array<{ projectId: string; root: string; reason: string }> {
    const registry = this.projects.current();
    const retired: Array<{ projectId: string; root: string; reason: string }> = [];
    for (const project of registry.list()) {
      const owned = isClaudexorOwnedRuntimePath(project.root);
      const gone = !existsSync(project.root);
      if (!owned && !gone) continue;
      registry.unregister(project.id);
      retired.push({
        projectId: project.id,
        root: project.root,
        reason: owned ? "root_inside_claudexor_runtime" : "root_permanently_missing",
      });
    }
    if (retired.length > 0) this.sync();
    return retired;
  }

  relinkProject(id: string, root: string): Project {
    const project = this.projects.current().relink(id, root);
    this.ensure(id).threads.current().relinkProjectRoot(project.root);
    return project;
  }

  /**
   * QA-049 minimal project remove: retire a registered project. Fails CLOSED
   * with a typed 409 while any NON-PURGED thread or any live/queued run still
   * references it (the caller supplies the roots with active runs, since the job
   * list lives in the daemon composition). On success: unregister the durable
   * global-registry entry, ARCHIVE the project's journal partition (rename it
   * out of the active journal tree — never delete), and drop the in-memory
   * partition. Run artifact trees are left in place for normal GC/retention.
   * Unknown id -> 404. A partition still in recovery -> 409 (its threads cannot
   * be fenced safely).
   */
  removeProject(
    id: string,
    activeRunRoots: ReadonlySet<string>,
  ): import("@claudexor/schema").ControlProjectRemoveReceipt {
    const registry = this.projects.current();
    const project = registry.get(id);
    if (!project) {
      throw Object.assign(new Error(`no such project: ${id}`), {
        code: "project_not_found",
        status: 404,
      });
    }
    this.sync();
    const entry = this.partitions.get(id);
    if (entry) {
      if (!entry.manager.ready()) {
        throw Object.assign(
          new Error(`project ${id} partition requires journal recovery before it can be removed`),
          { code: "journal_recovery_required", status: 409 },
        );
      }
      const blocking = entry.threads
        .current()
        .listThreads()
        .filter((thread) => thread.state !== "purged");
      if (blocking.length > 0) {
        throw Object.assign(
          new Error(
            `project ${id} still has ${blocking.length} thread(s); trash and purge them before removing it`,
          ),
          { code: "project_has_threads", status: 409 },
        );
      }
    }
    if (activeRunRoots.has(project.root)) {
      throw Object.assign(
        new Error(
          `project ${id} has a live or queued run; wait for it to finish before removing it`,
        ),
        { code: "project_has_active_run", status: 409 },
      );
    }
    registry.unregister(id);
    const archivedPartitionPath = entry ? entry.manager.archivePartition() : null;
    this.partitions.delete(id);
    return {
      projectId: project.id,
      root: project.root,
      registryRemoved: true,
      journalPartitionArchived: archivedPartitionPath !== null,
      archivedPartitionPath,
      artifactsRetained: true,
    };
  }

  journal(partition: string): JournalManager {
    if (!partition.startsWith("project:")) throw unknownPartition(partition);
    const id = partition.slice("project:".length);
    if (!id || !this.projects.current().get(id)) throw unknownPartition(partition);
    return this.ensure(id).manager;
  }

  createThread(input: CreateThreadInput): Thread {
    if (input.repoRoot && !this.projects.current().findByRoot(input.repoRoot)) {
      this.registerProject({
        root: input.repoRoot,
        idempotencyKey: `thread-auto-register-${hashJson(input.repoRoot)}`,
        clientId: "thread-create",
      });
    }
    return this.threadStoreForRoot(input.repoRoot).createThread(input);
  }

  listThreads(): Thread[] {
    return this.listThreadsResilient().threads;
  }

  /**
   * Thread listing that is RESILIENT to a dead project (F2): a
   * registered project whose filesystem root has vanished (e.g. a swept ghost
   * envelope worktree) is SKIPPED with a disclosed per-project problem instead
   * of failing the whole listing, while every other project's threads load.
   * Each store sorts ITS threads by recency, but the stores concatenate —
   * without a merge-sort a fresh project thread lands below every global one
   * (dogfood: the fresh thread sank to the bottom). One global recency order.
   */
  listThreadsResilient(): { threads: Thread[]; problems: ControlProjectListingProblem[] } {
    this.sync();
    const registry = this.projects.current();
    const threads: Thread[] = [...this.globalThreads.current().listThreads()];
    const problems: ControlProjectListingProblem[] = [];
    for (const [id, entry] of this.partitions) {
      if (!entry.manager.ready()) continue;
      const root = registry.get(id)?.root;
      if (!root) continue;
      if (!existsSync(root)) {
        problems.push({
          projectId: id,
          root,
          code: "project_root_missing",
          message: `project root no longer exists: ${root}`,
        });
        continue;
      }
      threads.push(...entry.threads.current().listThreads());
    }
    threads.sort((a, b) =>
      a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
    );
    return { threads, problems };
  }

  getThread(id: string): Thread | undefined {
    return this.threadStoreForThread(id)?.getThread(id);
  }

  turnsFor(id: string): ThreadTurn[] {
    return this.threadStoreForThread(id)?.turnsFor(id) ?? [];
  }

  sessionsForThread(id: string) {
    return this.threadStoreForThread(id)?.sessionsForThread(id) ?? [];
  }

  createTurn(id: string, prompt: string, input: CreateTurnInput = {}): ThreadTurn {
    return this.requireThreadStore(id).createTurn(id, prompt, input);
  }

  updateThread(id: string, patch: UpdateThreadInput): Thread {
    return this.requireThreadStore(id).updateThread(id, patch);
  }

  invalidateCredentialProfile(harnessId: string, profileId: string) {
    this.assertCredentialProfileInvalidationReady();
    return this.threadStores().reduce(
      (total, store) => {
        const result = store.invalidateCredentialProfile(harnessId, profileId);
        return {
          clearedThreads: total.clearedThreads + result.clearedThreads,
          invalidatedSessions: total.invalidatedSessions + result.invalidatedSessions,
        };
      },
      { clearedThreads: 0, invalidatedSessions: 0 },
    );
  }

  assertCredentialProfileInvalidationReady(): void {
    this.sync();
    const unavailable = [...this.partitions.entries()]
      .filter(([, entry]) => !entry.manager.ready())
      .map(([id]) => id);
    if (unavailable.length > 0) {
      throw Object.assign(
        new Error(
          `credential profile deletion requires recovery of project partition(s): ${unavailable.join(", ")}`,
        ),
        { status: 409, code: "journal_recovery_required" },
      );
    }
  }

  trashThread(id: string): Thread {
    return this.requireThreadStore(id).trashThread(id);
  }

  restoreThread(id: string): Thread {
    return this.requireThreadStore(id).restoreThread(id);
  }

  purgeThread(id: string): Thread {
    return this.requireThreadStore(id).purgeThread(id);
  }

  setThreadWorktree(
    id: string,
    path: string,
    baseSha: string,
    deliveredThroughRunId?: string,
  ): void {
    this.requireThreadStore(id).setThreadWorktree(id, path, baseSha, deliveredThroughRunId);
  }

  assertKnownIds(threadId: unknown, turnId: unknown): { threadId?: string; turnId?: string } {
    const id = typeof threadId === "string" && threadId ? threadId : undefined;
    const turn = typeof turnId === "string" && turnId ? turnId : undefined;
    const store = id
      ? this.requireThreadStore(id)
      : turn
        ? this.requireTurnStore(turn)
        : this.globalThreads.current();
    return store.assertKnownIds(threadId, turnId);
  }

  getTurn(id: string): ThreadTurn | undefined {
    return this.threadStoreForTurn(id)?.getTurn(id);
  }

  bindTurnRun(id: string, runId: string): void {
    this.requireTurnStore(id).bindTurnRun(id, runId);
  }

  setTurnEnqueueError(
    id: string,
    message: string,
    code: string | null = null,
    retryable = true,
  ): void {
    this.requireTurnStore(id).setTurnEnqueueError(id, message, code, retryable);
  }

  resumeMap(
    id: string,
    profileId: string | null = null,
  ): Record<string, { sessionId: string; profileId: string | null }> {
    return this.requireThreadStore(id).resumeMap(id, profileId);
  }

  recordSession(
    id: string,
    harnessId: string,
    nativeSessionId: string,
    observedModel?: string | null,
    profileId: string | null = null,
  ): void {
    this.requireThreadStore(id).recordSession(
      id,
      harnessId,
      nativeSessionId,
      observedModel,
      profileId,
    );
  }

  recordLaneCheckpoint(
    id: string,
    harnessId: string,
    profileId: string | null,
    turnId: string,
  ): void {
    this.requireThreadStore(id).recordLaneCheckpoint(id, harnessId, profileId, turnId);
  }

  laneCheckpoint(id: string, harnessId: string, profileId: string | null): string | null {
    return this.threadStoreForThread(id)?.laneCheckpoint(id, harnessId, profileId) ?? null;
  }

  laneCheckpointsForThread(id: string): import("@claudexor/schema").LaneCheckpoint[] {
    return this.threadStoreForThread(id)?.laneCheckpointsForThread(id) ?? [];
  }

  setTurnContinuity(
    turnId: string,
    disclosure: import("@claudexor/schema").ContinuityDisclosure,
  ): void {
    this.threadStoreForTurn(turnId)?.setTurnContinuity(turnId, disclosure);
  }

  /**
   * Run-terminal invalidation (the W12 path with no store mutation to ride):
   * a terminal changes the thread's presented state (needs-me, outcome), so
   * the daemon pings the owning store's head directly.
   */
  pingThreadHead(id: string): void {
    this.threadStoreForThread(id)?.pingHead(id);
  }

  close(): void {
    for (const entry of this.partitions.values()) entry.manager.close();
    this.partitions.clear();
  }

  private sync(): void {
    const ids = new Set(
      this.projects
        .current()
        .list()
        .map((project) => project.id),
    );
    for (const id of ids) this.ensure(id);
    for (const [id, entry] of this.partitions) {
      if (ids.has(id)) continue;
      entry.manager.close();
      this.partitions.delete(id);
    }
  }

  private ensure(projectId: string): ProjectPartition {
    const existing = this.partitions.get(projectId);
    if (existing) return existing;
    const manager = new JournalManager(this.rootDir, { partition: `project:${projectId}` });
    const commands = manager.registerProjection(commandProjection());
    const interactions = manager.registerProjection(interactionProjection());
    const decisions = manager.registerProjection(operatorDecisionProjection());
    const runEvents = manager.registerProjection(runEventProjection());
    const threads = manager.registerProjection(threadProjection(this.headPing));
    manager.start();
    const entry = { manager, commands, interactions, decisions, runEvents, threads };
    this.partitions.set(projectId, entry);
    return entry;
  }

  private healthy(): ProjectPartition[] {
    this.sync();
    return [...this.partitions.values()].filter((entry) => entry.manager.ready());
  }

  /**
   * Canonical roots whose partition journal is READY — the set whose thread
   * lineage / job records are trustworthy. Retention (W3.6) fails CLOSED on a
   * quarantined partition: its runs are protected, never GC'd against an empty
   * reference set (a non-ready partition contributes nothing to listThreads,
   * so its referenced runs would otherwise look unreferenced).
   */
  healthyProjectRoots(): string[] {
    this.sync();
    const registry = this.projects.current();
    const roots: string[] = [];
    for (const [id, entry] of this.partitions) {
      if (!entry.manager.ready()) continue;
      const root = registry.get(id)?.root;
      if (root) roots.push(root);
    }
    return roots;
  }

  private partitionForRoot(root: string): ProjectPartition {
    const project = this.projects.current().findByRoot(root);
    if (!project) {
      throw Object.assign(new Error(`project is not registered: ${root}`), {
        code: "project_not_registered",
        status: 404,
      });
    }
    return this.ensure(project.id);
  }

  private threadStores(): ThreadStore[] {
    return [
      this.globalThreads.current(),
      ...this.healthy().map((entry) => entry.threads.current()),
    ];
  }

  private threadStoreForRoot(root: string | null | undefined): ThreadStore {
    return root ? this.partitionForRoot(root).threads.current() : this.globalThreads.current();
  }

  private threadStoreForThread(id: string): ThreadStore | undefined {
    return this.threadStores().find((store) => store.getThread(id));
  }

  private threadStoreForTurn(id: string): ThreadStore | undefined {
    return this.threadStores().find((store) => store.getTurn(id));
  }

  private requireThreadStore(id: string): ThreadStore {
    const store = this.threadStoreForThread(id);
    if (!store) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
    return store;
  }

  private requireTurnStore(id: string): ThreadStore {
    const store = this.threadStoreForTurn(id);
    if (!store) throw Object.assign(new Error(`no such turn: ${id}`), { status: 404 });
    return store;
  }

  private commandStoreForThreadStore(store: ThreadStore): CommandStore {
    if (store === this.globalThreads.current()) return this.globalCommands.current();
    const entry = this.healthy().find((candidate) => candidate.threads.current() === store);
    if (!entry) throw new Error("thread partition has no command authority");
    return entry.commands.current();
  }

  private decisionStoreForRequest(params: unknown): OperatorDecisionStore {
    const commands = this.forRequest(params);
    if (commands === this.globalCommands.current()) return this.globalDecisions.current();
    const entry = this.healthy().find((candidate) => candidate.commands.current() === commands);
    if (!entry) throw new Error("command partition has no operator-decision authority");
    return entry.decisions.current();
  }

  private runEventStoreForRequest(params: unknown): RunEventStore {
    const commands = this.forRequest(params);
    if (commands === this.globalCommands.current()) return this.globalRunEvents.current();
    const entry = this.healthy().find((candidate) => candidate.commands.current() === commands);
    if (!entry) throw new Error("command partition has no run-event authority");
    return entry.runEvents.current();
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function unknownPartition(partition: string): Error {
  return Object.assign(new Error(`no such journal partition: ${partition}`), {
    code: "journal_partition_not_found",
    status: 404,
  });
}
