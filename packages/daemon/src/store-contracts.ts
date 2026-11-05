/** Operational storage boundaries, independent of their implementation. */
import type {
  Attachment,
  CommandListQuery,
  ControlJournalExportReceipt,
  ControlJournalInspection,
  ControlJournalQuarantineReceipt,
  ControlJournalValidation,
  ControlPendingInteraction,
  ControlProjectListingProblem,
  ControlResource,
  ControlResourceRelease,
  ControlUploadImport,
  ControlUploadStatus,
  ModelPayloadRef,
  Project,
  ProjectNesting,
  ResourceAttachmentRef,
  RunEvent,
  RunObservationRecord,
  Session,
  Thread,
  ThreadExportDigestEntry,
  ThreadRetireRequest,
  ThreadRetirementOperation,
  ThreadTurn,
  TaskGroupPageQuery,
  TaskGroupPage,
} from "@claudexor/schema";
export type { TaskGroupPageQuery } from "@claudexor/schema";
import type { AcceptCommand, FindCommand } from "./command-store.js";
import type { JobRecord } from "./job-record.js";
import type { ProjectRegistration, RegisterProject } from "./projects.js";
import type { InteractionContext, InteractionTerminal } from "./interactions.js";
import type { OperatorDecisionRecord, RecordedOperatorDecision } from "./operator-decisions.js";
import type { CreateThreadInput, CreateTurnInput, UpdateThreadInput } from "./threads.js";
import type { JournalQuarantineRequest } from "./journal-recovery-operation.js";
import type { JournalEventPage, JournalEventPageRequest } from "./store/cursors.js";
import type { ThreadClosure } from "./store/thread-closure.js";
import type { RetirementRefusal } from "./store/thread-retirement.js";
import type { ResourceUseHolder } from "./store/resource-uses.js";
export interface ProfileContinuityResult {
  sessions: number;
  checkpoints: number;
  skippedPartitions: string[];
}

export interface CommandStorePort {
  accept(input: AcceptCommand): { record: JobRecord; reused: boolean };
  find(input: FindCommand): JobRecord | null;
  get(id: string): JobRecord | undefined;
  update(id: string, patch: Partial<JobRecord>): JobRecord;
  prune(ids: readonly string[]): void;
  prunedScopeRoots(): string[];
  recoverDurableTerminal(id: string): JobRecord | null;
  flushed(): Promise<void>;
  /** Off-loop staging of the bodies `accept` will own; resolves the creation
   * time they carry, for `accept` to reuse (stores with file bodies only). */
  stageAcceptance?(input: AcceptCommand): Promise<string>;
  /** Off-loop staging of the bodies `update` will own (stores with file bodies only). */
  stageUpdate?(id: string, patch: Partial<JobRecord>): Promise<void>;
}

export interface ProjectStorePort {
  list(): Project[];
  listWithNesting(): Array<
    Project & {
      nesting: ProjectNesting[];
    }
  >;
  get(id: string): Project | undefined;
  findByRoot(root: string): Project | undefined;
  nestingFor(id: string): ProjectNesting[];
  register(input: RegisterProject): ProjectRegistration;
  relink(id: string, rootInput: string): Project;
  unregister(id: string): Project | undefined;
}

export interface ResourceStorePort {
  create(raw: unknown, idempotencyKey: string): ControlUploadStatus;
  status(uploadId: string): ControlUploadStatus;
  write(uploadId: string, chunks: AsyncIterable<Uint8Array>): Promise<ControlUploadStatus>;
  cancel(uploadId: string): ControlUploadStatus;
  finalize(
    uploadId: string,
    expectedSha256: string | undefined,
    idempotencyKey: string,
  ): ControlResource;
  /** Keyed import: begin, read or replay, publishing verified bytes under the same key. */
  importUpload(raw: unknown, idempotencyKey: string): ControlUploadImport;
  /** Release a managed ordinary ID: no new reference afterwards; accepted holders keep bytes. */
  releaseResource(resourceId: string, raw: unknown): ControlResourceRelease;
  /** `heldBy`: an accepted owner reading its own refs (a released ID it holds still resolves). */
  resolve(refs: ResourceAttachmentRef[] | undefined, heldBy?: ResourceUseHolder): Attachment[];
  readModel(raw: ModelPayloadRef): Buffer;
  /** Off the request thread. Result GET stays on `readModel` so ACK cannot race it. */
  readModelAsync(raw: ModelPayloadRef): Promise<Buffer>;
  publishModel(bytes: Uint8Array): ModelPayloadRef;
  releaseModel(raw: ModelPayloadRef): void;
  expireModel(raw: ModelPayloadRef, expiredAt: string): void;
  listModelResources(): Array<
    ModelPayloadRef & {
      createdAt: string;
    }
  >;
}

export interface PendingIdentityDigest {
  pending: boolean;
  digest: string;
}

export interface InteractionStorePort {
  request(ctx: InteractionContext): ControlPendingInteraction;
  resolve(
    runId: string,
    interactionId: string,
    terminal: InteractionTerminal,
  ): "resolved" | "not_found" | "already_resolved";
  resolveRun(
    runId: string,
    terminal: Extract<InteractionTerminal, "run_terminal" | "interrupted">,
  ): string[];
  status(runId: string, interactionId: string): "pending" | "resolved" | "missing";
  pendingForRun(runId: string): ControlPendingInteraction[];
  /** SQL observation capability; legacy answer-only ports need not implement it. */
  pendingIdentityDigest?(runId: string): PendingIdentityDigest;
}

export interface ProjectThreadPort {
  /** Cooperative served listing for maintenance, including unfinished purges. */
  retentionThreads(signal?: AbortSignal): Promise<Thread[]>;
  retentionReferences(
    ignoreThreadIds?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<import("./store/retention-references.js").DiskRetentionReferences>;
  registerProject(input: RegisterProject): ProjectRegistration;
  relinkProject(id: string, root: string): Project;
  removeProject(
    id: string,
    activeRunRoots: ReadonlySet<string>,
  ): import("@claudexor/schema").ControlProjectRemoveReceipt;
  /** #333 opt-in: also purge the threads already in the trash, in one commit. */
  removeProjectWithTrashedThreads(
    id: string,
    activeRunRoots: ReadonlySet<string>,
  ): import("./store/projects.js").ProjectRemoval;
  createThread(
    input: CreateThreadInput & {
      ephemeral?: boolean;
    },
  ): Thread;
  findThreadCreation(
    input: CreateThreadInput & {
      ephemeral?: boolean;
    },
  ): Thread | null;
  listThreads(): Thread[];
  listThreadsResilient(): {
    threads: Thread[];
    problems: ControlProjectListingProblem[];
  };
  listPurgedThreads(): Thread[];
  getThread(id: string): Thread | undefined;
  getTurn(id: string): ThreadTurn | undefined;
  turnsFor(id: string): ThreadTurn[];
  sessionsForThread(id: string): Session[];
  createTurn(id: string, prompt: string, input?: CreateTurnInput): ThreadTurn;
  /** Off-loop staging of a turn prompt body `createTurn` will own (best effort). */
  stageTurnPrompt?(id: string, prompt: string): Promise<void>;
  findTurnByIdempotency(
    id: string,
    input: NonNullable<CreateTurnInput["idempotency"]>,
  ): ThreadTurn | undefined;
  updateThread(id: string, patch: UpdateThreadInput): Thread;
  trashThread(id: string): Thread;
  restoreThread(id: string): Thread;
  purgeThread(id: string): Thread;
  retireThread(
    id: string,
    request: ThreadRetireRequest,
    acceptedLane: readonly ThreadExportDigestEntry[],
  ): Thread;
  retirementOperation(id: string, operationId: string): ThreadRetirementOperation | null;
  settleRetirement(
    id: string,
    operationId: string,
    refusal: RetirementRefusal | null,
  ): ThreadRetirementOperation;
  /** An observation from the store's read-only snapshot, off the writer's thread;
   * retirement reads the closure again inside its transaction. `signal` ends the wait. */
  threadClosure(id: string, signal?: AbortSignal): Promise<ThreadClosure | null>;
  /** The thread row and its store without the closure; null for no such thread. */
  threadRecord(id: string): { storeId: string; thread: Thread } | null;
  threadClosureDocument(id: string, key: string): Buffer | null;
  threadCleanup(id: string): { reason: string | null } | null;
  setThreadWorktree(
    id: string,
    path: string,
    baseSha: string,
    deliveredThroughRunId?: string,
  ): void;
  assertKnownIds(
    threadId: unknown,
    turnId: unknown,
  ): {
    threadId?: string;
    turnId?: string;
  };
  bindTurnRun(id: string, runId: string): void;
  setTurnEnqueueError(id: string, problem: import("@claudexor/schema").TurnEnqueueProblem): void;
  resumeMap(
    id: string,
    profileId?: string | null,
  ): Record<
    string,
    {
      sessionId: string;
      profileId: string | null;
    }
  >;
  resumeMapAuto(id: string): Record<
    string,
    {
      sessionId: string;
      profileId: string | null;
    }
  >;
  accountBindings(id: string): Record<string, string>;
  recordSession(
    id: string,
    harnessId: string,
    nativeSessionId: string,
    observedModel?: string | null,
    profileId?: string | null,
  ): void;
  recordLaneCheckpoint(
    id: string,
    harnessId: string,
    profileId: string | null,
    turnId: string,
  ): void;
  laneCheckpoint(id: string, harnessId: string, profileId: string | null): string | null;
  laneCheckpointsForThread(id: string): import("@claudexor/schema").LaneCheckpoint[];
  setTurnContinuity(
    turnId: string,
    disclosure: import("@claudexor/schema").ContinuityDisclosure,
  ): void;
  pingThreadHead(id: string): void;
  healthyProjectRoots(): string[];
  migrateNullProfileContinuity(harnessId: string, rowId: string): ProfileContinuityResult;
  rollbackProfileContinuity(harnessId: string, rowId: string): ProfileContinuityResult;
  invalidateCredentialProfile(
    harnessId: string,
    profileId: string,
  ): {
    clearedThreads: number;
    invalidatedSessions: number;
  };
  assertCredentialProfileInvalidationReady(): void;
  operatorDecision(params: unknown, runId: string): OperatorDecisionRecord | null;
  findOperatorDecisionByIdempotency(
    params: unknown,
    runId: string,
    idempotency: {
      key: string;
      client: string;
      request: unknown;
    },
  ): OperatorDecisionRecord | null;
  recordOperatorDecision(
    params: unknown,
    decision: OperatorDecisionRecord,
    idempotency?: {
      key: string;
      client: string;
      request: unknown;
    },
  ): RecordedOperatorDecision;
  recordRunEvent(params: unknown, event: RunEvent): RunEvent;
  beginDelivery(
    params: unknown,
    input: { key: string; client: string; operation: string; request: unknown },
  ): JobRecord & { reused: boolean };
  completeDelivery(id: string, result: unknown): void;
  failDelivery(id: string, error: unknown): void;
}

export interface CommandQueries {
  /** Required by compact observation; absent on legacy, non-observing fixtures.
   * Persisted scalar facts must be validated per target before public use. */
  observationRecords?(ids: readonly string[]): RunObservationRecord[];
  taskGroupPage?(input: TaskGroupPageQuery): TaskGroupPage;
  getByRunId(runId: string): JobRecord | undefined;
  select(query: CommandListQuery): JobRecord[];
  publicList(query: CommandListQuery): JobRecord[];
  active(): JobRecord[];
  count(): number;
}

/** Product recovery operations, without journal preparation or file ownership. */
export interface PartitionControlPort {
  /** One bounded page of the partition's retained events (see `readJournalEventPage`). */
  events(request?: JournalEventPageRequest): JournalEventPage;
  inspect(): ControlJournalInspection;
  preflightQuarantine(input: JournalQuarantineRequest): {
    disposition: string;
    receipt: ControlJournalQuarantineReceipt | null;
  };
  validate(): ControlJournalValidation | Promise<ControlJournalValidation>;
  exportRecovery(): ControlJournalExportReceipt | Promise<ControlJournalExportReceipt>;
  quarantineAndStartFresh(
    input: JournalQuarantineRequest,
  ): ControlJournalQuarantineReceipt | Promise<ControlJournalQuarantineReceipt>;
}

export type ProjectControlPort = ProjectThreadPort & {
  journal(partition: string): PartitionControlPort;
};

export interface StoreEvent<T = unknown> {
  partition: string;
  epoch: string;
  seq: number;
  time: string;
  type: string;
  payload: T;
}
/** The quota reducer needs logical events, never checksums, files or compaction. */
export interface EventLedger {
  append<T>(type: string, payload: T): StoreEvent<T>;
  appendBatch(entries: readonly { type: string; payload: unknown }[]): StoreEvent[];
  records<T = unknown>(afterSeq: number, types: readonly string[]): StoreEvent<T>[];
  cursorFor(record: Pick<StoreEvent, "partition" | "epoch" | "seq">): string;
}
