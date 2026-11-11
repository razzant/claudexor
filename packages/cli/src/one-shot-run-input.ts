import type { ControlRunStartRequest } from "@claudexor/schema";
import type { RunInput } from "@claudexor/orchestrator";
import { noProjectRepoRoot } from "@claudexor/util";

/** One translation for ordinary execution and start preflight. Resource byte
 * resolution stays with the caller so thread turns keep their stored refs. */
export function oneShotRunInput(p: ControlRunStartRequest): RunInput {
  return {
    repoRoot: p.scope.kind === "project" ? p.scope.root : noProjectRepoRoot(),
    prompt: p.prompt,
    mode: p.mode,
    instructions: p.instructions,
    executionRoot: p.execution.workspaceRoot,
    // A declared one-shot root keeps its run state in the one-shot namespace (#503).
    ephemeral: p.scope.kind === "project" && p.scope.ephemeral === true,
    inPlace: p.execution.isolation === "live",
    delegated: p.execution.delegated,
    workspaceKind: p.execution.workspaceKind,
    scopePaths: p.execution.scopePaths,
    auxiliaryWritableRoots: p.execution.auxiliaryWritableRoots,
    contextMode:
      p.scope.kind === "none" && p.mode === "ask"
        ? "off"
        : p.scope.kind === "project"
          ? p.scope.context
          : undefined,
    authPreference: p.authPreference,
    credentialProfileId: p.credentialProfileId,
    harnesses: p.harnesses,
    primaryHarness: p.primaryHarness,
    routingGoal: p.routingGoal,
    model: p.model,
    models: p.models,
    effort: p.effort,
    efforts: p.efforts,
    processingPreference: p.processingPreference,
    promptCacheTtl: p.promptCacheTtl,
    review: p.review,
    browser: p.browser === true,
    n: p.n,
    attempts: p.attempts ?? null,
    untilClean: p.untilClean === true,
    deepScan: p.deepScan === true,
    create: p.create === true,
    council: p.council === true,
    delegate: p.delegate === true,
    synthesis: p.synthesis,
    paidBudget: p.paidBudget,
    access: p.access,
    web: p.web ?? p.externalContextPolicy,
    externalContextPolicy: p.externalContextPolicy ?? p.web,
    maxTurns: p.maxTurns,
    denyPaths: p.denyPaths,
    outputSchema: p.outputSchema,
    tests: p.tests,
    protectedPathApprovals: p.protectedPathApprovals,
    planRef: p.planRef,
  };
}
