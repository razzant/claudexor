import { existsSync } from "node:fs";
import type {
  ControlProjectListingProblem,
  Project,
  RunEvent,
  Thread,
  ThreadTurn,
} from "@claudexor/schema";
import { isEphemeralRunScope, PROJECT_NOT_REGISTERED_REQUIRED_ACTIONS } from "@claudexor/schema";
import { hashJson, isClaudexorOwnedRuntimePath } from "@claudexor/util";
import type { CommandStore } from "./command-store.js";
import type { JournalManager, JournalProjectionSlot } from "./journal-manager.js";
import type { JournalManagerOptions } from "./journal-manager-lifecycle.js";
import type { InteractionStore } from "./interactions.js";
import { isJournaledRunEvent, journaledRunEventCopy } from "./journaled-run-events.js";
import {
  type OperatorDecisionRecord,
  type OperatorDecisionStore,
  type RecordedOperatorDecision,
} from "./operator-decisions.js";
import type { RunEventStore } from "./run-events.js";
import type { ProjectStore } from "./projects.js";
import {
  type CreateThreadInput,
  type CreateTurnInput,
  type ThreadHeadPingSink,
  type ThreadStore,
  type UpdateThreadInput,
} from "./threads.js";
import type { CommandAuthority } from "./command-authority.js";
import {
  beginDeliveryCommand,
  completeDeliveryCommand,
  failDeliveryCommand,
} from "./delivery-command.js";
import {
  activatePreparedProjectPartitions,
  prepareProjectPartitions,
  refreshProjectPartitionsPreparation,
  ProjectPartitionCollection,
  type ProjectPartitionsPreparation,
} from "./project-partition-preparation.js";
import { listProjectThreadsResilient } from "./project-thread-listing.js";
import {
  applyProfileContinuityAcross,
  invalidateCredentialProfileAcross,
  type ProfileContinuityResult,
} from "./partition-accounts.js";
import { removeProjectFromPartitions } from "./project-remove.js";

export type { ProjectPartitionsPreparation } from "./project-partition-preparation.js";
export class ProjectPartitions implements CommandAuthority {
  private readonly partitions: ProjectPartitionCollection;
  private preparationResult: ProjectPartitionsPreparation | null = null;

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
    private readonly requestMaintenance?: JournalManagerOptions["requestMaintenance"],
  ) {
    this.partitions = new ProjectPartitionCollection(
      rootDir,
      projects,
      headPing,
      requestMaintenance,
    );
  }

  prepare(): ProjectPartitionsPreparation {
    if (this.preparationResult) return this.preparationResult;
    const prepared = prepareProjectPartitions({
      rootDir: this.rootDir,
      projects: this.projects,
      headPing: this.headPing,
      requestMaintenance: this.requestMaintenance,
    });
    this.partitions.clear();
    for (const [id, entry] of prepared.entries) this.partitions.set(id, entry);
    this.preparationResult = prepared.receipt;
    return prepared.receipt;
  }

  revalidatePreparation(): void {
    if (!this.preparationResult) throw new Error("project partitions are not prepared");
    for (const entry of this.partitions.values()) {
      // A manager reopened by a recovery-route quarantine is live authority
      // (C6): only still-prepared partitions revalidate.
      if (entry.manager.ready()) continue;
      entry.manager.revalidatePreparation();
    }
  }

  /** Live stage-2 re-verdict for the in-process reopen (C6): quarantined
   * partitions reopened by their manager count ready, and a registry that
   * became readable after a global reopen restores coverage. Refreshes the
   * cached receipt the activation gate checks. */
  refreshPreparation(): ProjectPartitionsPreparation {
    if (!this.preparationResult) throw new Error("project partitions are not prepared");
    this.preparationResult = refreshProjectPartitionsPreparation({
      rootDir: this.rootDir,
      projects: this.projects,
      headPing: this.headPing,
      requestMaintenance: this.requestMaintenance,
      previous: this.preparationResult,
      entries: this.partitions,
    });
    return this.preparationResult;
  }

  activatePrepared(): void {
    if (!this.preparationResult) throw new Error("project partitions are not prepared");
    activatePreparedProjectPartitions({
      rootDir: this.rootDir,
      projects: this.projects,
      headPing: this.headPing,
      requestMaintenance: this.requestMaintenance,
      receipt: this.preparationResult,
      entries: this.partitions,
      resetReceipt: (receipt) => (this.preparationResult = receipt),
    });
  }
  recoverAfterStartup(): void {
    for (const entry of this.partitions.values()) entry.manager.recoverAfterStartup();
  }

  all(): CommandStore[] {
    return [
      this.globalCommands.current(),
      ...this.partitions.healthy().map((entry) => entry.commands.current()),
    ];
  }

  interactionStores(): InteractionStore[] {
    return [
      this.globalInteractions.current(),
      ...this.partitions.healthy().map((entry) => entry.interactions.current()),
    ];
  }

  interactionsForRequest(params: unknown): InteractionStore {
    const commandStore = this.forRequest(params);
    if (commandStore === this.globalCommands.current()) return this.globalInteractions.current();
    const entry = this.partitions
      .healthy()
      .find((candidate) => candidate.commands.current() === commandStore);
    if (!entry) throw new Error("command partition has no interaction authority");
    return entry.interactions.current();
  }

  operatorDecision(params: unknown, runId: string): OperatorDecisionRecord | null {
    return this.decisionStoreForRequest(params).get(runId);
  }

  findOperatorDecisionByIdempotency(
    params: unknown,
    runId: string,
    idempotency: { key: string; client: string; request: unknown },
  ): OperatorDecisionRecord | null {
    return this.decisionStoreForRequest(params).findByIdempotency(runId, idempotency);
  }

  recordOperatorDecision(
    params: unknown,
    decision: OperatorDecisionRecord,
    idempotency?: { key: string; client: string; request: unknown },
  ): RecordedOperatorDecision {
    return this.decisionStoreForRequest(params).record(decision, idempotency);
  }

  /**
   * Durable sink for run events. Only the lifecycle-significant subset is
   * journaled (`JOURNALED_RUN_EVENT_TYPES`); a filtered event is returned
   * untouched and can never fail its producer. The journaled `run.created`
   * carries the prompt digest, never the prompt text.
   */
  recordRunEvent(params: unknown, event: RunEvent): RunEvent {
    if (isJournaledRunEvent(event)) {
      this.runEventStoreForRequest(params).record(journaledRunEventCopy(event));
    }
    // The producer keeps its own event (prompt included) for events.jsonl and
    // the live bus; only the journal copy carries the digest.
    return event;
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
    // A declared one-shot root is never registered, so INV-035's "no-project
    // state remains global" governs it (partitionForRoot would 404 instead).
    if (isEphemeralRunScope(scope)) return this.globalCommands.current();
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
    return beginDeliveryCommand(this.forRequest(params), params, input);
  }

  completeDelivery(id: string, result: unknown): void {
    completeDeliveryCommand(this.findById(id), id, result);
  }

  failDelivery(id: string, error: unknown): void {
    failDeliveryCommand(this.findById(id), id, error);
  }

  registerProject(input: Parameters<ProjectStore["register"]>[0]): Project {
    const project = this.projects.current().register(input);
    this.partitions.ensure(project.id);
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
    if (retired.length > 0) this.partitions.sync();
    return retired;
  }

  relinkProject(id: string, root: string): Project {
    const project = this.projects.current().relink(id, root);
    this.partitions.ensure(id).threads.current().relinkProjectRoot(project.root);
    return project;
  }

  /**
   * QA-049 minimal project remove: retire a registered project. Fails CLOSED
   * with a typed 409 while any NON-PURGED thread or any live/queued run still
   * references it (the caller supplies the roots with active runs, since the job
   * list lives in the daemon composition). On success, ARCHIVE the journal
   * partition (rename out of the active tree — never delete) FIRST — that fallible
   * rename+fsync must throw with the registry still intact rather than strand an
   * unregistered project whose partition never moved — THEN unregister the durable
   * registry entry and drop the in-memory partition. Artifact trees are left for
   * GC/retention. Unknown id -> 404. Recovery-pending partition -> 409.
   */
  removeProject(
    id: string,
    activeRunRoots: ReadonlySet<string>,
  ): import("@claudexor/schema").ControlProjectRemoveReceipt {
    this.partitions.sync();
    return removeProjectFromPartitions(
      this.projects.current(),
      this.partitions,
      id,
      activeRunRoots,
    );
  }

  journal(partition: string): JournalManager {
    if (!partition.startsWith("project:")) throw unknownPartition(partition);
    const id = partition.slice("project:".length);
    const prepared = this.partitions.get(id);
    if (prepared) return prepared.manager;
    if (this.preparationResult?.coverage === "global_registry_unavailable") {
      throw unknownPartition(partition);
    }
    if (!id || !this.projects.current().get(id)) throw unknownPartition(partition);
    return this.partitions.ensure(id).manager;
  }

  /** `ephemeral`: the caller declared this root ONE-SHOT (INV-035) — never registered, so the
   * thread takes the global no-project partition, exactly as its commands and run events do. */
  createThread(input: CreateThreadInput & { ephemeral?: boolean }): Thread {
    const root = input.ephemeral === true ? null : (input.repoRoot ?? null);
    if (root && !this.projects.current().findByRoot(root)) {
      const idempotencyKey = `thread-auto-register-${hashJson(root)}`;
      this.registerProject({ root, idempotencyKey, clientId: "thread-create" });
    }
    return this.threadStoreForRoot(root).createThread(input);
  }

  listThreads(): Thread[] {
    return this.listThreadsResilient().threads;
  }

  /** Dead-project-resilient listing in one global recency order (F2);
   * the mechanics live in project-thread-listing.ts. */
  listThreadsResilient(): { threads: Thread[]; problems: ControlProjectListingProblem[] } {
    return listProjectThreadsResilient({
      partitions: this.partitions,
      projects: this.projects,
      globalThreads: this.globalThreads,
    });
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

  findTurnByIdempotency(
    id: string,
    input: NonNullable<CreateTurnInput["idempotency"]>,
  ): ThreadTurn | undefined {
    return this.requireThreadStore(id).findTurnByIdempotency(id, input);
  }

  updateThread(id: string, patch: UpdateThreadInput): Thread {
    return this.requireThreadStore(id).updateThread(id, patch);
  }

  /** Unified-accounts continuity steps (contract: partition-accounts.ts). */
  migrateNullProfileContinuity(harnessId: string, rowId: string): ProfileContinuityResult {
    return applyProfileContinuityAcross(this.continuityHosts(), (store) =>
      store.migrateNullProfileContinuity(harnessId, rowId),
    );
  }

  rollbackProfileContinuity(harnessId: string, rowId: string): ProfileContinuityResult {
    return applyProfileContinuityAcross(this.continuityHosts(), (store) =>
      store.rollbackProfileContinuity(harnessId, rowId),
    );
  }

  private continuityHosts(): { stores: ThreadStore[]; skippedPartitions: string[] } {
    this.partitions.sync();
    return {
      stores: this.threadStores(),
      skippedPartitions: [...this.partitions.entries()]
        .filter(([, entry]) => !entry.manager.ready())
        .map(([id]) => id),
    };
  }

  invalidateCredentialProfile(harnessId: string, profileId: string) {
    this.assertCredentialProfileInvalidationReady();
    return invalidateCredentialProfileAcross(this.threadStores(), harnessId, profileId);
  }

  assertCredentialProfileInvalidationReady(): void {
    this.partitions.sync();
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

  setTurnEnqueueError(id: string, problem: import("@claudexor/schema").TurnEnqueueProblem): void {
    this.requireTurnStore(id).setTurnEnqueueError(id, problem);
  }

  resumeMap(
    id: string,
    profileId: string | null = null,
  ): Record<string, { sessionId: string; profileId: string | null }> {
    return this.requireThreadStore(id).resumeMap(id, profileId);
  }

  resumeMapAuto(id: string): Record<string, { sessionId: string; profileId: string | null }> {
    return this.requireThreadStore(id).resumeMapAuto(id);
  }

  accountBindings(id: string): Record<string, string> {
    return this.requireThreadStore(id).accountBindings(id);
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

  /**
   * Canonical roots whose partition journal is READY — the set whose thread
   * lineage / job records are trustworthy. Retention (W3.6) fails CLOSED on a
   * quarantined partition: its runs are protected, never GC'd against an empty
   * reference set (a non-ready partition contributes nothing to listThreads,
   * so its referenced runs would otherwise look unreferenced).
   */
  healthyProjectRoots(): string[] {
    return this.partitions.healthyRoots();
  }

  private partitionForRoot(root: string) {
    const project = this.projects.current().findByRoot(root);
    if (!project) {
      throw Object.assign(new Error(`project is not registered: ${root}`), {
        code: "project_not_registered",
        status: 404,
        retryable: false,
        requiredActions: [...PROJECT_NOT_REGISTERED_REQUIRED_ACTIONS],
      });
    }
    return this.partitions.ensure(project.id);
  }

  private threadStores(): ThreadStore[] {
    return [
      this.globalThreads.current(),
      ...this.partitions.healthy().map((entry) => entry.threads.current()),
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
    const entry = this.partitions
      .healthy()
      .find((candidate) => candidate.threads.current() === store);
    if (!entry) throw new Error("thread partition has no command authority");
    return entry.commands.current();
  }

  private decisionStoreForRequest(params: unknown): OperatorDecisionStore {
    const commands = this.forRequest(params);
    if (commands === this.globalCommands.current()) return this.globalDecisions.current();
    const entry = this.partitions
      .healthy()
      .find((candidate) => candidate.commands.current() === commands);
    if (!entry) throw new Error("command partition has no operator-decision authority");
    return entry.decisions.current();
  }

  private runEventStoreForRequest(params: unknown): RunEventStore {
    const commands = this.forRequest(params);
    if (commands === this.globalCommands.current()) return this.globalRunEvents.current();
    const entry = this.partitions
      .healthy()
      .find((candidate) => candidate.commands.current() === commands);
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
