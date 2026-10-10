/** Frozen legacy modules from 820e849cd, never the future SQL reducers.
 * Kept as namespaces so future equivalence assertions use the original public surfaces.
 * This test-only entry owns no production selection, migration or runtime lifecycle. */
import * as cliSetupJobReducer from "./fixtures/legacy/cli/setup-job-reducer.js";
import * as cliSetupJobStore from "./fixtures/legacy/cli/setup-job-store.js";
import * as daemonCommandListProjection from "./fixtures/legacy/daemon/command-list-projection.js";
import * as daemonCommandListSelect from "./fixtures/legacy/daemon/command-list-select.js";
import * as daemonCommandRetention from "./fixtures/legacy/daemon/command-retention.js";
import * as daemonCommandScopeRoots from "./fixtures/legacy/daemon/command-scope-roots.js";
import * as daemonCommandStore from "./fixtures/legacy/daemon/command-store.js";
import * as daemonIdempotencyWireProjection from "./fixtures/legacy/daemon/idempotency-wire-projection.js";
import * as daemonInteractions from "./fixtures/legacy/daemon/interactions.js";
import * as daemonJobRecord from "./fixtures/legacy/daemon/job-record.js";
import * as daemonJournalFoldPolicy from "./fixtures/legacy/daemon/journal-fold-policy.js";
import * as daemonJournaledRunEvents from "./fixtures/legacy/daemon/journaled-run-events.js";
import * as daemonOperatorDecisions from "./fixtures/legacy/daemon/operator-decisions.js";
import * as daemonProjects from "./fixtures/legacy/daemon/projects.js";
import * as daemonQuotaPollLanes from "./fixtures/legacy/daemon/quota-poll-lanes.js";
import * as daemonQuotaPollPacer from "./fixtures/legacy/daemon/quota-poll-pacer.js";
import * as daemonQuotaRefreshBatches from "./fixtures/legacy/daemon/quota-refresh-batches.js";
import * as daemonQuotaRefreshCoordinator from "./fixtures/legacy/daemon/quota-refresh-coordinator.js";
import * as daemonQuotaRefreshDemand from "./fixtures/legacy/daemon/quota-refresh-demand.js";
import * as daemonQuotaRegistryReplay from "./fixtures/legacy/daemon/quota-registry-replay.js";
import * as daemonQuotaRegistrySupport from "./fixtures/legacy/daemon/quota-registry-support.js";
import * as daemonQuotaRegistry from "./fixtures/legacy/daemon/quota-registry.js";
import * as daemonQuotaResources from "./fixtures/legacy/daemon/quota-resources.js";
import * as daemonResourceStore from "./fixtures/legacy/daemon/resource-store.js";
import * as daemonRunEventTerminalIndex from "./fixtures/legacy/daemon/run-event-terminal-index.js";
import * as daemonRunEvents from "./fixtures/legacy/daemon/run-events.js";
import * as daemonTerminalAuthority from "./fixtures/legacy/daemon/terminal-authority.js";
import * as daemonThreadHeadPing from "./fixtures/legacy/daemon/thread-head-ping.js";
import * as daemonThreadLaneCheckpoints from "./fixtures/legacy/daemon/thread-lane-checkpoints.js";
import * as daemonThreadLifecycle from "./fixtures/legacy/daemon/thread-lifecycle.js";
import * as daemonThreadStoreSupport from "./fixtures/legacy/daemon/thread-store-support.js";
import * as daemonThreadTitle from "./fixtures/legacy/daemon/thread-title.js";
import * as daemonThreadWorktreeState from "./fixtures/legacy/daemon/thread-worktree-state.js";
import * as daemonThreads from "./fixtures/legacy/daemon/threads.js";

export const legacyOracle = {
  cliSetupJobReducer,
  cliSetupJobStore,
  daemonCommandListProjection,
  daemonCommandListSelect,
  daemonCommandRetention,
  daemonCommandScopeRoots,
  daemonCommandStore,
  daemonIdempotencyWireProjection,
  daemonInteractions,
  daemonJobRecord,
  daemonJournalFoldPolicy,
  daemonJournaledRunEvents,
  daemonOperatorDecisions,
  daemonProjects,
  daemonQuotaPollLanes,
  daemonQuotaPollPacer,
  daemonQuotaRefreshBatches,
  daemonQuotaRefreshCoordinator,
  daemonQuotaRefreshDemand,
  daemonQuotaRegistryReplay,
  daemonQuotaRegistrySupport,
  daemonQuotaRegistry,
  daemonQuotaResources,
  daemonResourceStore,
  daemonRunEventTerminalIndex,
  daemonRunEvents,
  daemonTerminalAuthority,
  daemonThreadHeadPing,
  daemonThreadLaneCheckpoints,
  daemonThreadLifecycle,
  daemonThreadStoreSupport,
  daemonThreadTitle,
  daemonThreadWorktreeState,
  daemonThreads,
};
