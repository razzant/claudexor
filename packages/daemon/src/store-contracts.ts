/** Operational storage boundaries, independent of their implementation. */
import type {
  Attachment,
  CommandListQuery,
  ControlJournalEvent,
  ControlJournalExportReceipt,
  ControlJournalInspection,
  ControlJournalQuarantineReceipt,
  ControlJournalValidation,
  ControlPendingInteraction,
  ControlProjectListingProblem,
  ControlResource,
  ControlUploadStatus,
  ModelPayloadRef,
  Project,
  ProjectNesting,
  ResourceAttachmentRef,
  RunEvent,
  Session,
  Thread,
  ThreadTurn,
} from "@claudexor/schema";
import type { AcceptCommand, FindCommand } from "./command-store.js";
import type { JobRecord } from "./job-record.js";
import type { ProjectRegistration, RegisterProject } from "./projects.js";
import type { InteractionContext, InteractionTerminal } from "./interactions.js";
import type { OperatorDecisionRecord, RecordedOperatorDecision } from "./operator-decisions.js";
import type { CreateThreadInput, CreateTurnInput, UpdateThreadInput } from "./threads.js";
import type { JournalQuarantineRequest } from "./journal-recovery-operation.js";
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
  resolve(refs: ResourceAttachmentRef[] | undefined): Attachment[];
  readModel(raw: ModelPayloadRef): Buffer;
  publishModel(bytes: Uint8Array): ModelPayloadRef;
  releaseModel(raw: ModelPayloadRef): void;
  expireModel(raw: ModelPayloadRef, expiredAt: string): void;
  listModelResources(): Array<
    ModelPayloadRef & {
      createdAt: string;
    }
  >;
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
}

export interface ProjectThreadPort {
  registerProject(input: RegisterProject): ProjectRegistration;
  relinkProject(id: string, root: string): Project;
  removeProject(
    id: string,
    activeRunRoots: ReadonlySet<string>,
  ): import("@claudexor/schema").ControlProjectRemoveReceipt;
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
  findTurnByIdempotency(
    id: string,
    input: NonNullable<CreateTurnInput["idempotency"]>,
  ): ThreadTurn | undefined;
  updateThread(id: string, patch: UpdateThreadInput): Thread;
  trashThread(id: string): Thread;
  restoreThread(id: string): Thread;
  purgeThread(id: string): Thread;
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
  getByRunId(runId: string): JobRecord | undefined;
  select(query: CommandListQuery): JobRecord[];
  publicList(query: CommandListQuery): JobRecord[];
  active(): JobRecord[];
  count(): number;
}

/** Product recovery operations, without journal preparation or file ownership. */
export interface PartitionControlPort {
  events(afterCursor?: string): ControlJournalEvent[];
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
