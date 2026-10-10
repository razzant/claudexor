/** Frozen legacy modules from 820e849cd, never the future SQL reducers.
 * Kept as namespaces so future equivalence assertions use the original public surfaces.
 * This test-only entry owns no production selection, migration or runtime lifecycle. */
import * as cliSetupJobReducer from "./legacy/cli/setup-job-reducer.js";
import * as cliSetupJobStore from "./legacy/cli/setup-job-store.js";
import * as daemonCommandListProjection from "./legacy/daemon/command-list-projection.js";
import * as daemonCommandListSelect from "./legacy/daemon/command-list-select.js";
import * as daemonCommandRetention from "./legacy/daemon/command-retention.js";
import * as daemonCommandScopeRoots from "./legacy/daemon/command-scope-roots.js";
import * as daemonCommandStore from "./legacy/daemon/command-store.js";
import * as daemonIdempotencyWireProjection from "./legacy/daemon/idempotency-wire-projection.js";
import * as daemonInteractions from "./legacy/daemon/interactions.js";
import * as daemonJobRecord from "./legacy/daemon/job-record.js";
import * as daemonJournalFoldPolicy from "./legacy/daemon/journal-fold-policy.js";
import * as daemonJournaledRunEvents from "./legacy/daemon/journaled-run-events.js";
import * as daemonOperatorDecisions from "./legacy/daemon/operator-decisions.js";
import * as daemonProjects from "./legacy/daemon/projects.js";
import * as daemonQuotaPollLanes from "./legacy/daemon/quota-poll-lanes.js";
import * as daemonQuotaPollPacer from "./legacy/daemon/quota-poll-pacer.js";
import * as daemonQuotaRefreshBatches from "./legacy/daemon/quota-refresh-batches.js";
import * as daemonQuotaRefreshCoordinator from "./legacy/daemon/quota-refresh-coordinator.js";
import * as daemonQuotaRefreshDemand from "./legacy/daemon/quota-refresh-demand.js";
import * as daemonQuotaRegistryReplay from "./legacy/daemon/quota-registry-replay.js";
import * as daemonQuotaRegistrySupport from "./legacy/daemon/quota-registry-support.js";
import * as daemonQuotaRegistry from "./legacy/daemon/quota-registry.js";
import * as daemonQuotaResources from "./legacy/daemon/quota-resources.js";
import * as daemonResourceStore from "./legacy/daemon/resource-store.js";
import * as daemonRunEventTerminalIndex from "./legacy/daemon/run-event-terminal-index.js";
import * as daemonRunEvents from "./legacy/daemon/run-events.js";
import * as daemonTerminalAuthority from "./legacy/daemon/terminal-authority.js";
import * as daemonThreadHeadPing from "./legacy/daemon/thread-head-ping.js";
import * as daemonThreadLaneCheckpoints from "./legacy/daemon/thread-lane-checkpoints.js";
import * as daemonThreadLifecycle from "./legacy/daemon/thread-lifecycle.js";
import * as daemonThreadStoreSupport from "./legacy/daemon/thread-store-support.js";
import * as daemonThreadTitle from "./legacy/daemon/thread-title.js";
import * as daemonThreadWorktreeState from "./legacy/daemon/thread-worktree-state.js";
import * as daemonThreads from "./legacy/daemon/threads.js";

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
