/**
 * ONE construction owner for the daemon's per-run Orchestrator, hoisted from
 * `claudexord` so the credential-evidence wiring (A7) lives beside the quota
 * wiring it siblings: the same event stream that feeds the quota registry
 * feeds the unusable-credential ledger's success-clearing, and the same deps
 * boundary that injects quota snapshots injects the ledger's observations.
 *
 * The account evidence is the engine store's graph (`createSqlDaemonServices`
 * builds one per store lifetime): its in-memory ledgers are bounded and
 * self-expiring, the last-served facts are durable, and the same credential
 * generation clears both. Agent Runs produce refusal marks and service facts;
 * every unpinned pool choice (runs, reviewers, the Accounts `next_up`
 * projection) reads them.
 */
import { logPath, type AccountEvidence, type QuotaRegistry } from "@claudexor/daemon";
import { Orchestrator, createCredentialExecutionObserver } from "@claudexor/orchestrator";
import { buildRegistry } from "./registry.js";
import type { RuntimeConcurrencyCaps, CapturedRunStart } from "@claudexor/schema";
import { logLine } from "./log-line.js";
import { daemonRunScopeIndex } from "./run-scope-index.js";

type OrchestratorDeps = ConstructorParameters<typeof Orchestrator>[0];

/** The orchestrator's #363 memory over the store's evidence graph. */
function refusalMemory(
  accounts: AccountEvidence,
): NonNullable<OrchestratorDeps["preProgressRefusals"]> {
  const { refusals } = accounts;
  return {
    live: () => refusals.live(),
    generation: (harnessId, profileId) => refusals.generation(harnessId, profileId),
    record: (value) => refusals.record(value),
    clear: (harnessId, profileId, model) => refusals.clear(harnessId, profileId, model),
    services: accounts.services,
  };
}

export function buildRunOrchestrator(args: {
  /** The store's account evidence graph (required: never a private fallback). */
  accounts: AccountEvidence;
  p: CapturedRunStart;
  delegationBudgetAuthority: OrchestratorDeps["delegationBudgetAuthority"];
  quotaStore: () => QuotaRegistry;
  /** Typed per-harness refusal while a unified-accounts migration is
   * incomplete (a crash between phases) — other harnesses keep working. */
  accountsMigrationGate?: OrchestratorDeps["accountsMigrationGate"];
  runtimeConcurrencyCaps?: RuntimeConcurrencyCaps;
}): Orchestrator {
  const { p, quotaStore } = args;
  const credentialUnusableLedger = args.accounts.unusable;
  return new Orchestrator({
    registry: buildRegistry(),
    executionDefaults: p.deferredDefaults,
    delegationBudgetAuthority: args.delegationBudgetAuthority,
    accountsMigrationGate: args.accountsMigrationGate,
    routingGoal: p.routingGoal,
    // Admission ages each window at the deciding reader (#457); display keeps read().
    quotaSnapshots: () => quotaStore().readAdmission().snapshots,
    // The absence half of the SAME projection: `auth_revoked` is how the
    // poller reports a vendor rejecting a profile's credential, and run
    // admission is the surface that has to act on it.
    quotaAbsences: () => quotaStore().read().absences,
    credentialObserverFactory: (subject) => {
      const binding = credentialUnusableLedger.bind(subject);
      const observer = createCredentialExecutionObserver(credentialUnusableLedger, binding);
      const maintain = (operation: () => void) => {
        try {
          operation();
        } catch (error) {
          logLine(
            logPath(),
            `account observation failed (${subject.harnessId}/${subject.profileId ?? "default"}): ${String(error)}`,
          );
        }
      };
      return {
        observe: (event) =>
          maintain(() => {
            observer.observe(event);
            // Numeric quota and cooldown observations remain useful while
            // sessions run across managed login changes. Authentication proof
            // has its separate generation/order authority in the observer.
            const sameProfile =
              event.credential_profile_id === undefined ||
              event.credential_profile_id === subject.profileId;
            const sameRoute =
              subject.route === null ||
              event.credential_route === undefined ||
              event.credential_route === subject.route;
            if (sameProfile && sameRoute) {
              quotaStore().ingest(subject.harnessId, {
                ...event,
                ...(subject.profileId !== null ? { credential_profile_id: subject.profileId } : {}),
                ...(event.credential_route === undefined && subject.route !== null
                  ? { credential_route: subject.route }
                  : {}),
              });
            }
          }),
        finish: () => maintain(() => observer.finish()),
      };
    },
    credentialUnusable: () => credentialUnusableLedger.live(),
    credentialEvidence: credentialUnusableLedger,
    preProgressRefusals: refusalMemory(args.accounts),
    reviewerPanel: p.reviewerPanel,
    reviewerModels:
      p.reviewerModels && typeof p.reviewerModels === "object" ? p.reviewerModels : undefined,
    reviewerEfforts:
      p.reviewerEfforts && typeof p.reviewerEfforts === "object" ? p.reviewerEfforts : undefined,
    runtimeConcurrencyCaps: args.runtimeConcurrencyCaps,
    // Durable process custody: the daemon's run-scope index.
    runScopes: daemonRunScopeIndex(),
  });
}
