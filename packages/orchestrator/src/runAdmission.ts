import { loadConfig } from "@claudexor/config";
import type { OrchestratorDeps, RunInput } from "./orchestrator.js";
import { resolveRunInputDefaults } from "./run-input-resolution.js";
import { executionRunConfig } from "./run-defaults.js";
import { resolveEngineReview } from "./candidateReview.js";
import type { AccessProfile, ModeKind } from "@claudexor/schema";
import {
  ModeKind as ModeKindSchema,
  normalizeUserOutputSchema,
  resolveRunAccess,
  runAccessStrategyViolation,
  runAuxiliaryWritableRootsViolation,
  runExecutionWorkspaceViolation,
} from "@claudexor/schema";
import { assertMandatoryContext } from "@claudexor/context";
import { newId, noProjectRepoRoot } from "@claudexor/util";
import { admitAuxiliaryWritableRoots } from "@claudexor/workspace";
import { assertOutputSchemaCompiles } from "./structuredOutput.js";
import { assertWriteIsolation } from "./write-isolation.js";
import { assertCouncilWidth } from "./council.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

export interface RunAdmissionInput {
  repoRoot: string;
  executionRoot?: string;
  retryOf?: string | null;
  access?: AccessProfile;
  attempts?: number | null;
  untilClean?: boolean;
  tests?: readonly unknown[] | null;
  inPlace?: boolean;
  delegated?: boolean;
  denyPaths?: string[];
  outputSchema?: Record<string, unknown> | null;
  council?: boolean;
  n?: number;
  /** Caller-spelled service directories; admission returns their canonical grant. */
  auxiliaryWritableRoots?: string[];
}

export interface RunAdmissionDeps {
  accessDefault: AccessProfile;
  projectProtectedPaths: () => readonly string[];
  mandatoryFiles: () => readonly string[];
  maxCouncilMembers?: number;
  /** Configured credential-profile homes an auxiliary grant must never reach. */
  credentialHomes?: () => readonly string[];
}

export interface RunAdmission {
  outputSchema: Record<string, unknown> | null | undefined;
  /** Canonical auxiliary writable directories; [] = no extra engine grant. */
  auxiliaryWritableRoots: string[];
}

interface AdmissionViolation {
  code: string;
  message: string;
  retryable: false;
  requiredActions: readonly string[];
}

function throwAdmissionViolation(violation: AdmissionViolation | null): void {
  if (!violation) return;
  throw Object.assign(new Error(violation.message), {
    status: 400,
    code: violation.code,
    retryable: violation.retryable,
    requiredActions: [...violation.requiredActions],
  });
}

/**
 * Pre-announcement engine admission shared by every run strategy.
 *
 * Keep these checks together and ordered: access/strategy coherence and the
 * delegated execution-root backstop run before any filesystem-policy check;
 * output contracts and mandatory project context are then validated before a
 * run directory can be announced.
 */
export function admitRun(
  input: RunAdmissionInput,
  mode: ModeKind,
  deps: RunAdmissionDeps,
): RunAdmission {
  if (input.council) assertCouncilWidth(input.n, deps.maxCouncilMembers);
  const effectiveAccess = resolveRunAccess(
    { mode, access: input.access },
    deps.accessDefault,
  ).effective;
  throwAdmissionViolation(runAccessStrategyViolation(input, effectiveAccess));
  throwAdmissionViolation(
    runExecutionWorkspaceViolation(
      {
        mode,
        retryOf: input.retryOf,
        execution: {
          isolation: input.inPlace === true ? "live" : "envelope",
          delegated: input.delegated === true,
          ...(input.executionRoot === undefined ? {} : { workspaceRoot: input.executionRoot }),
        },
      },
      effectiveAccess,
    ),
  );
  throwAdmissionViolation(
    runAuxiliaryWritableRootsViolation(
      { mode, execution: { auxiliaryWritableRoots: input.auxiliaryWritableRoots } },
      effectiveAccess,
    ),
  );

  if (effectiveAccess !== "readonly") {
    assertWriteIsolation({
      mode,
      protectedPaths: mode === "agent" ? deps.projectProtectedPaths() : [],
      denyPaths: input.denyPaths,
      inPlace: input.inPlace,
      repoRoot: input.repoRoot,
      executionRoot: input.executionRoot ?? input.repoRoot,
    });
  }

  let outputSchema = input.outputSchema;
  if (outputSchema !== undefined && outputSchema !== null) {
    if (mode !== "agent" && mode !== "ask") {
      throw new Error(
        `outputSchema constrains the final answer and applies to agent/ask runs (got mode=${mode}); drop the schema or switch modes`,
      );
    }
    if (input.untilClean || (input.attempts !== undefined && input.attempts !== null)) {
      throw new Error(
        "outputSchema is not supported with convergence flags (--until-clean/--attempts): convergence delivers a gated patch, not a structured answer; drop the schema or the convergence flags",
      );
    }
    outputSchema = normalizeUserOutputSchema(outputSchema);
    assertOutputSchemaCompiles(outputSchema);
  }

  if (input.repoRoot !== NO_PROJECT_ROOT) {
    assertMandatoryContext(input.executionRoot ?? input.repoRoot, deps.mandatoryFiles());
  }
  const executionRoot = input.executionRoot ?? input.repoRoot;
  return {
    outputSchema,
    auxiliaryWritableRoots: admitAuxiliaryWritableRoots(input.auxiliaryWritableRoots, {
      repoRoot: input.repoRoot,
      executionRoot,
      credentialHomes: deps.credentialHomes?.() ?? [],
    }),
  };
}

/** Resolve and admit the input before a run is announced or acquires process custody. */
export function prepareRunAdmission(
  input: RunInput,
  deps: OrchestratorDeps,
  onDelegatedLedgerAttached: () => void,
): { resolved: RunInput; mode: ModeKind; runId: string } {
  let resolved = resolveRunInputDefaults(input, {
    config: executionRunConfig(input.repoRoot, deps.executionDefaults),
    registryIds: deps.registry.keys(),
    routingGoal: deps.routingGoal,
  });
  const parsedMode = ModeKindSchema.safeParse(resolved.mode ?? "agent");
  if (!parsedMode.success) {
    throw new Error(`unknown mode: ${String(resolved.mode)}`);
  }
  const mode: ModeKind = parsedMode.data;
  if (mode === "agent") resolved.review = resolveEngineReview(resolved, deps);
  if (resolved.delegate === true && mode !== "agent") {
    throw new Error(`Delegate is an agent-only strategy (got mode=${mode})`);
  }
  const runId = resolved.runId ?? newId("run");
  resolved = {
    ...resolved,
    runId,
    taskId: resolved.taskId ?? newId("task"),
    onDelegatedLedgerAttached,
  };
  if (resolved.delegate === true) {
    resolved = {
      ...resolved,
      delegationParentRunId: runId,
    };
  }
  // Admission returns the CANONICAL auxiliary grant; routing, the contract
  // and every writable lane read that list, never the caller spelling.
  ({
    outputSchema: resolved.outputSchema,
    auxiliaryWritableRoots: resolved.auxiliaryWritableRoots,
  } = admitRun(resolved, mode, {
    maxCouncilMembers: deps.runtimeConcurrencyCaps?.max_council_members,
    accessDefault: loadConfig(resolved.repoRoot).trust.access_default,
    projectProtectedPaths: () => loadConfig(resolved.repoRoot).project.constraints.protected_paths,
    mandatoryFiles: () => loadConfig(resolved.repoRoot).project.context.mandatory_files,
    credentialHomes: () =>
      loadConfig(resolved.repoRoot).global.credential_profiles.flatMap((profile) =>
        profile.isolation_locator ? [profile.isolation_locator] : [],
      ),
  }));
  return { resolved, mode, runId };
}
