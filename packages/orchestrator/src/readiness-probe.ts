import type { DoctorSpec, AdapterRegistry } from "@claudexor/core";
import { diagnosticGenerationFor, isOrdinaryAsk, type DiagnosticGeneration } from "@claudexor/core";
import type { BudgetLedger } from "@claudexor/budget";
import type { HarnessGateway, HarnessStatus } from "@claudexor/gateway";
import type { GlobalConfig, PaidBudget } from "@claudexor/schema";
import type { RunInput } from "./orchestrator.js";

/** The run's effective paid budget: request, then execution defaults, then
 * Settings. The task contract and its ledger resolve through the same chain. */
export function effectivePaidBudget(
  input: Pick<RunInput, "paidBudget">,
  deps: { paidBudget?: PaidBudget },
  config: GlobalConfig,
): PaidBudget {
  return input.paidBudget ?? deps.paidBudget ?? config.budget.paid_budget_per_run;
}

/** The probe mode of every automatic readiness read of a run (doctor, scoped
 * route probe, model inventory), from its effective budget. Only an ordinary
 * read-only Ask (the run's own mode, not its Deep Scan strategy) ever withholds
 * paid diagnostics; Plan, Agent and every other strategy keep their probes. Once
 * the run's own ledger exists it is
 * the authority: it was built from the task contract before any later Settings
 * read and carries an inherited family's spent cap, so a Settings edit made after
 * admission neither opens nor closes the mode. */
export function probeModeOf(
  input: Pick<RunInput, "paidBudget" | "mode" | "deepScan">,
  deps: { paidBudget?: PaidBudget },
  config: GlobalConfig,
  ledger?: Pick<BudgetLedger, "remainingUsd">,
): DiagnosticGeneration {
  if (!isOrdinaryAsk(input)) return "allowed";
  if (ledger) {
    const explicit = diagnosticGenerationFor(input.paidBudget ?? deps.paidBudget);
    return explicit === "forbidden" || ledger.remainingUsd() === 0 ? "forbidden" : "allowed";
  }
  return diagnosticGenerationFor(effectivePaidBudget(input, deps, config));
}

/** Host-level readiness for the harnesses one admission may consider (a
 * user-disabled harness is never probed), with the ONE diagnostic mode every
 * automatic probe of that admission shares: the doctor here, the scoped route
 * probe and the model inventory later all take it from the effective budget. */
export async function probeCandidateStatuses(
  gateway: Pick<HarnessGateway, "statusAll">,
  registry: AdapterRegistry,
  input: Pick<RunInput, "repoRoot" | "paidBudget" | "mode" | "deepScan">,
  deps: { paidBudget?: PaidBudget },
  config: GlobalConfig,
  harnesses: string[] | undefined,
  ledger?: Pick<BudgetLedger, "remainingUsd">,
): Promise<{ statuses: HarnessStatus[]; diagnosticGeneration: DiagnosticGeneration }> {
  const diagnosticGeneration = probeModeOf(input, deps, config, ledger);
  const probeIds = (harnesses && harnesses.length > 0 ? harnesses : [...registry.keys()]).filter(
    (id) => config.harnesses[id]?.enabled !== false,
  );
  const spec: DoctorSpec = { cwd: input.repoRoot, diagnosticGeneration };
  return {
    statuses: probeIds.length > 0 ? await gateway.statusAll(spec, probeIds) : [],
    diagnosticGeneration,
  };
}
