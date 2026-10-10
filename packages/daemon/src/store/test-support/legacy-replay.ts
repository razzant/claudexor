import type { DurableJournal } from "./fixtures/legacy/journal/index.js";
import { legacyOracle as legacy } from "./legacy-oracle.js";

/** Baseline projections only. The SQL path must supply its own factory in PR-C. */
export function legacyStores(journal: DurableJournal, workingCopy: string, now: string) {
  const clock = () => new Date(now);
  return {
    commands: new legacy.daemonCommandStore.CommandStore(journal, clock),
    interactions: new legacy.daemonInteractions.InteractionStore(journal),
    decisions: new legacy.daemonOperatorDecisions.OperatorDecisionStore(journal),
    projects: new legacy.daemonProjects.ProjectStore(journal),
    threads: new legacy.daemonThreads.ThreadStore(journal),
    heads: new legacy.daemonThreadHeadPing.ThreadHeadPingEmitter(journal),
    quota: new legacy.daemonQuotaRegistry.QuotaRegistry(journal, [], clock),
    runEvents: new legacy.daemonRunEvents.RunEventStore(journal),
    setup: new legacy.cliSetupJobStore.SetupJobStore(workingCopy, { journal, now: clock }),
  };
}

/** Exact domain values, not a normalizer: no IDs, timestamps or payload fields are removed. */
export function legacySnapshot(journal: DurableJournal, stores: ReturnType<typeof legacyStores>) {
  const threads = stores.threads.listThreads();
  const setup = stores.setup.list();
  return {
    commands: stores.commands.records(),
    prunedRoots: stores.commands.prunedScopeRoots(),
    projects: stores.projects.list(),
    threads: threads.map((thread) => ({
      thread,
      turns: stores.threads.turnsFor(thread.id),
      sessions: stores.threads.sessionsForThread(thread.id),
      checkpoints: stores.threads.laneCheckpointsForThread(thread.id),
      revision: stores.heads.revision(thread.id),
    })),
    quota: stores.quota.read(),
    resources: stores.quota.readResources(),
    setup: setup.map((job) => ({ job, events: stores.setup.events(job.jobId) })),
    terminalEvents: [...legacy.daemonRunEventTerminalIndex.durableTerminalRunEvents(journal)],
  };
}
