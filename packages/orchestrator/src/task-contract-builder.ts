import type {
  AccessProfile,
  ActiveTaskContract,
  AuthPreference,
  EffortHint,
  ExternalContextPolicy,
  ModeKind,
  PaidBudget,
  ProcessingPreference,
  PromptCacheTtl,
  ProtectedPathApproval,
  RoutingGoal,
  TestCommandInvocation,
} from "@claudexor/schema";
import {
  ActiveTaskContract as TaskContractSchema,
  resolveRunAccess,
  SCHEMA_VERSION,
  TRUST_FULL_ACCESS_CODE,
} from "@claudexor/schema";
import { loadConfig, trustConfigPath } from "@claudexor/config";
import { nowIso } from "@claudexor/util";
import { resolveContractGates } from "./contract-gates.js";

interface TaskContractBuildInput {
  repoRoot: string;
  prompt: string;
  review?: boolean;
  instructions?: string;
  baseRef?: string;
  delegate?: boolean;
  /** Wire `execution.delegated`: an EXTERNAL orchestrator owns this workspace
   *  and carries its own authority. Unrelated to the `delegate` belt flag above
   *  and to `delegatedFromRunId` (belt-child provenance). Already carried on
   *  RunInput (orchestrator.ts) — declared here so the trust gate can read it. */
  delegated?: boolean;
  parentRunId?: string | null;
  delegatedFromRunId?: string | null;
  tests?: TestCommandInvocation[];
  protectedPathApprovals?: ProtectedPathApproval[];
  denyPaths?: string[];
  paidBudget?: PaidBudget;
  routingGoal?: RoutingGoal;
  access?: AccessProfile;
  /** Canonical admitted grant (`admitRun`), never the caller spelling. */
  auxiliaryWritableRoots?: string[];
  web?: ExternalContextPolicy;
  externalContextPolicy?: ExternalContextPolicy;
  outputSchema?: Record<string, unknown> | null;
  authPreference?: AuthPreference;
  credentialProfileId?: string | null;
  maxTurns?: number | null;
  models?: Record<string, string>;
  efforts?: Record<string, EffortHint>;
  processingPreference?: ProcessingPreference;
  promptCacheTtl?: PromptCacheTtl;
}

export interface TaskContractDefaults {
  paidBudget?: PaidBudget;
  routingGoal?: RoutingGoal;
}

/**
 * Build and validate the immutable task contract from one resolved run input.
 * This is the single owner for trust, gate, access, and frozen route facts.
 */
export function buildTaskContract(
  input: TaskContractBuildInput,
  taskId: string,
  mode: ModeKind,
  defaults: TaskContractDefaults,
): ActiveTaskContract {
  const resolvedCfg = loadConfig(input.repoRoot);
  const cfg = resolvedCfg.project;
  const access = resolveRunAccess(input, resolvedCfg.trust.access_default);
  const requestedAccess = access.requested;
  // Effective access is COMPUTED by the engine, never echoed from a client.
  const effectiveAccess: AccessProfile = access.effective;
  // The full-access allow is a CONSENT CEREMONY for the operator sitting at a
  // surface (the app's one-time grant, `claudexor trust --allow-full-access`):
  // a loud error, never a silent downgrade. Versioned repo config still cannot
  // self-grant it (ProjectConfig structurally excludes the sensitive trust
  // settings). Through the narrow control/CLI surface the ACCESS DEFAULT can
  // only be readonly|workspace_write and the full-access grant is a separate
  // explicit field; a hand-edited user-level trust file may itself carry
  // `access_default: full`, which still faces this gate on a non-delegated run.
  //
  // A run marked `execution.delegated` skips it: an external orchestrator owns
  // the workspace and carries its own authority. What that buys differs by
  // caller, so state both honestly. A control-API client holds the daemon token
  // and can already POST /v2/trust to grant itself the allow, so the second
  // ceremony bought nothing there. An MCP tool caller is the HOST'S MODEL: it
  // holds no token and has no trust-writing tool, so for it this marker is a
  // real widening — one call with `delegated: true` and `access: "full"` runs
  // unsandboxed native full on any `repoPath` with no grant, and the only
  // remaining control is the host's own MCP tool-approval policy. Kept anyway
  // per INV-122: prefer the broad capability plus an accurate residual over a
  // weaker second boundary. The residual is disclosed in SECURITY.md.
  //
  // The gate applies to the EFFECTIVE profile either way, so a run clamped to
  // readonly never runs unsandboxed and needs no allow.
  if (
    effectiveAccess === "full" &&
    input.delegated !== true &&
    !resolvedCfg.trust.allow_full_access
  ) {
    // Typed refusal: the `code` rides the daemon job record onto the thread
    // turn (TurnEnqueueError.code), so surfaces key remedies on the CODE —
    // never on substring-matching this human message.
    throw Object.assign(
      new Error(
        `access profile 'full' requires allow_full_access: true in the user-level trust file for this repo ` +
          `(${trustConfigPath(input.repoRoot)}); enable it with \`claudexor trust --allow-full-access\` — refusing to run unsandboxed`,
      ),
      // Refusal semantics are born at the throw (W24): the one-time grant is
      // a 403, and the daemon persists this status onto the job record.
      { code: TRUST_FULL_ACCESS_CODE, status: 403 },
    );
  }
  const externalContextPolicy = input.web ?? input.externalContextPolicy ?? "auto";
  // Deterministic gate commands come from explicit run input, then versioned
  // project config. Without these, gateSpecs is empty and convergence is
  // review-only; with them, convergence is test-driven.
  const resolvedGates = resolveContractGates({
    repoRoot: input.repoRoot,
    effectiveAccess,
    config: cfg,
    trustGrants: resolvedCfg.trust.test_command_grants,
    operatorCommands: input.tests ?? [],
    projectCommands: cfg.tests?.commands ?? [],
  });
  const commands = resolvedGates.commands;
  const protectedPaths = [...new Set(cfg.constraints.protected_paths)];
  const autoProtectedPaths = resolvedGates.autoProtectedPaths;
  const protectedPathApprovals = [
    ...new Map(
      [...(input.protectedPathApprovals ?? [])].map((approval) => [approval.path, approval]),
    ).values(),
  ];
  const reviewRequested = mode === "agent" && input.review === true;
  return TaskContractSchema.parse({
    schema_version: SCHEMA_VERSION,
    task_id: taskId,
    created_at: nowIso(),
    repo: { root: input.repoRoot, base_ref: input.baseRef ?? "HEAD", dirty_policy: "snapshot" },
    mode: { kind: mode },
    delegation_requested: input.delegate === true,
    review_requested: reviewRequested,
    ...(mode === "agent" && !reviewRequested
      ? {
          convergence: {
            require_final_cross_family_clean_review: false,
            require_final_diff_stable_after_review: false,
          },
        }
      : {}),
    run_lineage: {
      parent_run_id: input.parentRunId ?? null,
      delegated_from_run_id: input.delegatedFromRunId ?? null,
    },
    // The contract is the executable task: exact prompt and instructions, the
    // same bytes the harness receives (credential-shaped text is not masked).
    user_intent: { raw: input.prompt },
    instructions: input.instructions,
    // Already normalized/strictified at the engine boundary (run() refuses
    // unsupported shapes before any run dir exists).
    output_schema: input.outputSchema ?? null,
    auth_preference: input.authPreference ?? "auto",
    credential_profile_id: input.credentialProfileId ?? null,
    max_turns: input.maxTurns ?? null,
    constraints: {
      protected_paths: protectedPaths,
      deny_paths: [...new Set(input.denyPaths ?? [])],
      auto_protected_paths: autoProtectedPaths,
      protected_path_approvals: protectedPathApprovals,
    },
    tests: { commands },
    access: {
      requested_profile: requestedAccess,
      effective_profile: effectiveAccess,
      auxiliary_writable_roots: input.auxiliaryWritableRoots ?? [],
    },
    external_context: {
      policy: externalContextPolicy,
      // Web is optional for every non-off policy. The field remains in the
      // frozen contract for compatibility with persisted explicit-required
      // contracts, but ordinary run construction never turns it on.
      web_required: false,
      // Per-route upgrades (e.g. claude cached->live) are disclosed in events
      // and telemetry.yaml; the immutable contract records the requested policy.
      effective_mode: externalContextPolicy,
    },
    // Harness-native tool names are adapter knowledge; the neutral contract
    // carries only the policy plus user-configured allow/deny lists (wired
    // from per-harness settings).
    tool_permission_policy: {
      web: externalContextPolicy,
      allow: [],
      deny: [],
    },
    budget: {
      routing_goal:
        input.routingGoal ?? defaults.routingGoal ?? cfg?.budget?.routing_goal ?? "auto",
      paid_budget:
        input.paidBudget ?? defaults.paidBudget ?? resolvedCfg.global.budget.paid_budget_per_run,
    },
    // The resolved harness-scoped model map (scalar already expanded to the
    // primary by resolveRunInput). The contract is what route spec building
    // reads — there is no run-global model (INV-103).
    routing_models: input.models ?? {},
    // QA-035: resolveRunInputDefaults has already expanded explicit, scalar,
    // and Settings-derived effort into a frozen per-lane map. Persist that map
    // verbatim so TaskContract construction cannot re-read a later Settings
    // state or leave pure Auto routing as a drift seam.
    routing_efforts: input.efforts ?? {},
    processing_preference: input.processingPreference,
    prompt_cache_ttl: input.promptCacheTtl,
  });
}
