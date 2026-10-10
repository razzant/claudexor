/** Structural boundaries shared by the legacy and SQL composition roots.
 * These are method sets, not storage selectors or alternate lifecycle owners. */
import type { CommandListQuery } from "@claudexor/schema";
import type { CommandStore } from "./command-store.js";
import type { JobRecord } from "./job-record.js";
import type { ProjectStore } from "./projects.js";
import type { ResourceStore } from "./resource-store.js";
import type { InteractionStore } from "./interactions.js";
import type { ProjectPartitions } from "./project-partitions.js";
import type { JournalManager } from "./journal-manager.js";

export type CommandStorePort = Pick<
  CommandStore,
  "accept" | "find" | "get" | "update" | "prune" | "prunedScopeRoots" | "recoverDurableTerminal"
>;
/** Enumeration belongs only to the still-serving legacy graph. */
export type LegacyCommandStorePort = CommandStorePort & Pick<CommandStore, "records" | "count">;

export interface CommandQueries {
  getByRunId(runId: string): JobRecord | undefined;
  select(query: CommandListQuery): JobRecord[];
  publicList(query: CommandListQuery): JobRecord[];
  active(): JobRecord[];
  count(): number;
}

export type ProjectStorePort = Pick<
  ProjectStore,
  | "list"
  | "listWithNesting"
  | "get"
  | "findByRoot"
  | "nestingFor"
  | "register"
  | "relink"
  | "unregister"
>;
export type ResourceStorePort = Pick<
  ResourceStore,
  | "create"
  | "status"
  | "write"
  | "cancel"
  | "finalize"
  | "resolve"
  | "readModel"
  | "publishModel"
  | "releaseModel"
  | "listModelResources"
>;
export type InteractionStorePort = Pick<
  InteractionStore,
  "request" | "resolve" | "resolveRun" | "status" | "pendingForRun"
>;

export type ProjectThreadPort = Pick<
  ProjectPartitions,
  | "registerProject"
  | "relinkProject"
  | "removeProject"
  | "createThread"
  | "findThreadCreation"
  | "listThreads"
  | "listThreadsResilient"
  | "listPurgedThreads"
  | "getThread"
  | "getTurn"
  | "turnsFor"
  | "sessionsForThread"
  | "createTurn"
  | "findTurnByIdempotency"
  | "updateThread"
  | "trashThread"
  | "restoreThread"
  | "purgeThread"
  | "setThreadWorktree"
  | "assertKnownIds"
  | "bindTurnRun"
  | "setTurnEnqueueError"
  | "resumeMap"
  | "resumeMapAuto"
  | "accountBindings"
  | "recordSession"
  | "recordLaneCheckpoint"
  | "laneCheckpoint"
  | "laneCheckpointsForThread"
  | "setTurnContinuity"
  | "pingThreadHead"
  | "healthyProjectRoots"
  | "migrateNullProfileContinuity"
  | "rollbackProfileContinuity"
  | "invalidateCredentialProfile"
  | "assertCredentialProfileInvalidationReady"
  | "operatorDecision"
  | "findOperatorDecisionByIdempotency"
  | "recordOperatorDecision"
  | "recordRunEvent"
  | "beginDelivery"
  | "completeDelivery"
  | "failDelivery"
>;

/** Product recovery operations, without journal preparation or file ownership. */
export type PartitionControlPort = Pick<
  JournalManager,
  | "events"
  | "inspect"
  | "validate"
  | "exportRecovery"
  | "preflightQuarantine"
  | "quarantineAndStartFresh"
>;
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
