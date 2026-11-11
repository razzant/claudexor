import type { Intent } from "@claudexor/schema";
import type { OrchestratorDeps, RunInput } from "./orchestrator.js";
import { prepareRunAdmission } from "./runAdmission.js";
import { buildTaskContract } from "./task-contract-builder.js";

/** Uses the ordinary admission/contract/route owners without announcing a run,
 * acquiring a budget ledger, preparing a workspace or invoking a provider. */
export async function preflightOneShot(
  input: RunInput,
  deps: OrchestratorDeps,
  routes: (input: RunInput, intent: Intent) => Promise<unknown>,
): Promise<void> {
  if (input.delegatedFromRunId || input.threadId || input.mode === "plan")
    throw Object.assign(new Error("deferred messages require an operator-owned one-shot"), {
      code: "delegation_forbidden",
      status: 403,
    });
  const { resolved, mode } = prepareRunAdmission(input, deps, () => {});
  buildTaskContract(resolved, "task-deferred-preflight", mode, deps);
  await routes(
    { ...resolved, n: 1 },
    mode === "ask" ? "explain" : resolved.create ? "create_from_scratch" : "implement",
  );
}
