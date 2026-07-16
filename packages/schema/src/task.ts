import { z } from "zod";
import {
  AccessProfile,
  AuthPreference,
  ContentHash,
  DirtyPolicy,
  ExternalContextPolicy,
  Id,
  IsoTimestamp,
  ModeKind,
  NonBlankString,
  SchemaVersion,
} from "./primitives.js";
import { PaidBudget, RoutingGoal } from "./budget.js";

export const SuccessCriterion = z
  .object({
    id: Id.describe("Criterion id."),
    text: z.string().describe("Human-readable statement of what must hold for the run to succeed."),
    required: z
      .boolean()
      .default(true)
      .describe("Whether this criterion is required (vs advisory)."),
  })
  .describe("A single success criterion the run is held to.");
export type SuccessCriterion = z.infer<typeof SuccessCriterion>;

export const TestCommandInvocation = z
  .object({
    program: NonBlankString.describe("Executable invoked directly without an implicit shell."),
    args: z.array(z.string()).default([]).describe("Exact argv passed to the executable."),
    cwd: z
      .string()
      .optional()
      .describe("Optional project-relative working directory for the command."),
    envAllowlist: z
      .array(NonBlankString)
      .default([])
      .describe("Non-secret parent environment names explicitly forwarded to the command."),
  })
  .strict()
  .describe("Canonical deterministic command invocation; no implicit shell parsing.");
export type TestCommandInvocation = z.infer<typeof TestCommandInvocation>;

export const TestCommandGrant = z
  .object({
    projectDigest: ContentHash.describe("Digest of the canonical project identity."),
    configDigest: ContentHash.describe("Digest of the parsed versioned project config blob."),
    commandDigest: ContentHash.describe("Digest of the canonical command invocation."),
    executablePath: z.string().describe("Resolved executable path approved by the operator."),
    executableDigest: ContentHash.describe("Digest of the resolved executable bytes."),
    scriptPath: z.string().nullable().default(null).describe("Resolved script path, when any."),
    scriptDigest: ContentHash.nullable().default(null).describe("Digest of the script bytes."),
    accessProfile: AccessProfile.describe("Effective access profile covered by this grant."),
  })
  .strict()
  .describe("External exact grant for one versioned project test command.");
export type TestCommandGrant = z.infer<typeof TestCommandGrant>;

export const TestCommand = TestCommandInvocation.extend({
  id: Id.describe("Test command id."),
  required: z.boolean().default(true).describe("Whether this test must pass (vs advisory)."),
  trust_required: z
    .boolean()
    .default(false)
    .describe("Whether this command originated in versioned project config."),
  trust_grant: TestCommandGrant.nullable()
    .default(null)
    .describe("Matching external grant; null when none was found."),
})
  .strict()
  .describe("A deterministic typed-argv test command used as a verification gate.");
export type TestCommand = z.infer<typeof TestCommand>;

export const ProtectedPathApproval = z
  .object({
    /** Glob approved by the operator/user for this run; consumed only by the
     * auto-protected gate/test path policy, not by built-in critical-path gates. */
    path: NonBlankString.describe(
      "Glob approved by the operator/user for this run; consumed only by the auto-protected gate/test path policy, not by built-in critical-path gates.",
    ),
    reason: NonBlankString.optional().describe("Optional human-readable reason for the approval."),
  })
  .strict()
  .describe(
    "Per-run typed operator approval allowing changes under an auto-protected gate/test path.",
  );
export type ProtectedPathApproval = z.infer<typeof ProtectedPathApproval>;

export const TaskConstraints = z
  .object({
    /** Globs whose changes escalate risk to a human-approval gate (wired into
     * classifyRisk/requireHuman). These are spec/config-owned and cannot be
     * suppressed by per-run protected-path approvals. The other constraint kinds
     * were unwired and removed. */
    protected_paths: z
      .array(z.string())
      .default([])
      .describe(
        "Spec/config-owned globs whose changes escalate risk to a human-approval gate; cannot be suppressed by per-run protected-path approvals.",
      ),
    /** Per-run globs no candidate may touch AT ALL (create, modify, or delete —
     * stricter than protected_paths, which gates only tampering with existing
     * files). Enforced by the engine's post-diff policy gate on envelope runs;
     * an in-place run with deny_paths is refused at preflight. An operator
     * accept_risk decision MAY still deliver a violating patch (INV-111: the
     * human is the final authority). */
    deny_paths: z
      .array(z.string())
      .default([])
      .describe(
        "Per-run globs no candidate may touch at all; enforced by the engine post-diff gate on envelope runs (in-place runs with deny_paths are refused). accept_risk may still deliver (INV-111).",
      ),
    /** Engine-derived gate/test path protections. Per-run approvals can narrow
     * only this auto-protected set, never spec/config-owned protected_paths. */
    auto_protected_paths: z
      .array(z.string())
      .default([])
      .describe(
        "Engine-derived gate/test path protections; per-run approvals can narrow only this set.",
      ),
    /** Per-run typed approvals for protected gate/test path changes. These are
     * produced by explicit surfaces (CLI/control/IDE), then consumed by policy. */
    protected_path_approvals: z
      .array(ProtectedPathApproval)
      .default([])
      .describe(
        "Per-run typed approvals for protected gate/test path changes, produced by explicit surfaces and consumed by policy.",
      ),
  })
  .describe("Path-protection constraints applied to a run.");
export type TaskConstraints = z.infer<typeof TaskConstraints>;

export const ConvergencePredicate = z
  .object({
    require_tests_pass: z
      .boolean()
      .default(true)
      .describe("Require all configured test commands to pass before convergence."),
    require_no_accepted_block_open: z
      .boolean()
      .default(true)
      .describe("Block convergence while an accepted BLOCK review finding is still open."),
    require_no_accepted_fix_first_open: z
      .boolean()
      .default(true)
      .describe("Block convergence while an accepted FIX_FIRST review finding is still open."),
    require_final_cross_family_clean_review: z
      .boolean()
      .default(true)
      .describe(
        "Require a final clean review from a different provider family before convergence.",
      ),
    require_final_diff_stable_after_review: z
      .boolean()
      .default(true)
      .describe(
        "Require the diff to be unchanged after the final review (a mutated diff makes the review stale).",
      ),
    /**
     * Block convergence while an accepted NEEDS_HUMAN escalation is still open.
     * Closes the v0.8 hole where, with cross-family clean review disabled, a run
     * could converge to success with an open NEEDS_HUMAN finding.
     */
    require_no_accepted_needs_human_open: z
      .boolean()
      .default(true)
      .describe("Block convergence while an accepted NEEDS_HUMAN escalation is still open."),
  })
  .describe("Predicate deciding when an until-clean/convergence run may stop as successful.");
export type ConvergencePredicate = z.infer<typeof ConvergencePredicate>;

/** One node of the spec-derived task graph; edges are `depends_on`. */
export const TaskGraphNode = z
  .object({
    id: Id.describe("Task node id."),
    title: z.string().default("").describe("Human-readable task title."),
    depends_on: z
      .array(Id)
      .default([])
      .describe("Ids of tasks this node depends on (graph edges)."),
  })
  .describe("One node of the spec-derived task graph; edges are depends_on.");
export type TaskGraphNode = z.infer<typeof TaskGraphNode>;

/** A topologically-ordered task graph built from a frozen SpecPack's tasks. */
export const TaskGraph = z
  .object({
    nodes: z.array(TaskGraphNode).default([]).describe("Task nodes of the graph."),
    /** Topological execution order (node ids); empty when there are no tasks. */
    order: z
      .array(Id)
      .default([])
      .describe("Topological execution order (node ids); empty when there are no tasks."),
  })
  .describe("A topologically-ordered task graph built from a frozen SpecPack's tasks.");
export type TaskGraph = z.infer<typeof TaskGraph>;

/**
 * Immutable contract describing a single run. Built once, hashed, never mutated.
 */
export const TaskContract = z
  .object({
    schema_version: SchemaVersion,
    task_id: Id.describe("Task id this contract belongs to."),
    created_at: IsoTimestamp.describe("When the contract was built."),
    repo: z
      .object({
        root: z.string().describe("Absolute path to the project repository root."),
        base_ref: z.string().describe("Git ref the run is based on."),
        base_sha: z.string().optional().describe("Resolved base commit SHA, when known."),
        dirty_policy: DirtyPolicy.default("refuse"),
      })
      .describe("Repository the run operates on and how a dirty tree is handled."),
    mode: z.object({ kind: ModeKind }).describe("Canonical run mode for this task."),
    user_intent: z
      .object({
        raw: z.string().describe("The user's original prompt, verbatim."),
        normalized: z
          .string()
          .optional()
          .describe("Optional normalized restatement of the prompt."),
      })
      .describe("The user's request this run is held to."),
    /** Caller-supplied per-run system-level instructions layered onto every
     *  TASK-PRODUCING lane's prompt (primary, candidate, planner, explorer,
     *  orchestrate-planner) — never reviewers, synthesis, or the auth smoke. */
    instructions: z
      .string()
      .optional()
      .describe("Caller-supplied per-run system-level instructions for task-producing lanes."),
    /** Caller-supplied JSON Schema the run's final ANSWER must conform to,
     * already normalized/strictified at the engine boundary. Mandatory when
     * present: every answer-producing lane is constrained natively
     * (HarnessRunSpec.output_schema) and ONE engine validator writes
     * final/output.json + a typed conformance receipt; a non-conformant answer
     * ends success-with-warnings (outputConformance failed), never a hard fail. */
    output_schema: z
      .record(z.unknown())
      .nullable()
      .default(null)
      .describe(
        "Normalized caller-supplied JSON Schema for the final answer; null when the run has no structured-output contract.",
      ),
    /** The auth route the caller REQUESTED for this run (a preference, not a
     * secret); the effective route is disclosed per attempt and rolled into
     * the telemetry auth_route receipt. */
    auth_preference: AuthPreference.default("auto").describe(
      "Requested auth route for the run (subscription/api_key/auto); the telemetry auth_route receipt carries the effective truth.",
    ),
    spec: z
      .object({
        id: Id.optional().describe("SpecPack id."),
        hash: z.string().optional().describe("Content hash of the frozen SpecPack."),
        path: z.string().optional().describe("On-disk path of the SpecPack artifact."),
      })
      .optional()
      .describe("Reference to the frozen SpecPack this contract was derived from, if any."),
    success_criteria: z
      .array(SuccessCriterion)
      .default([])
      .describe("Criteria the run must satisfy to succeed."),
    non_goals: z.array(z.string()).default([]).describe("Explicitly out-of-scope outcomes."),
    forbidden_approaches: z
      .array(z.string())
      .default([])
      .describe("Approaches the run must not take."),
    decided_tradeoffs: z
      .array(z.string())
      .default([])
      .describe("Tradeoffs already decided; reviewers must not re-litigate them."),
    /** Spec-derived task graph; null until a frozen SpecPack with tasks is resolved. */
    task_graph: TaskGraph.nullable()
      .default(null)
      .describe("Spec-derived task graph; null until a frozen SpecPack with tasks is resolved."),
    constraints: TaskConstraints.default({}),
    tests: z
      .object({
        commands: z
          .array(TestCommand)
          .default([])
          .describe("Deterministic test commands configured as gates."),
      })
      .default({ commands: [] })
      .describe("Deterministic test gates for the run."),
    access: z
      .object({
        requested_profile: AccessProfile.default("workspace_write").describe(
          "Access profile the caller requested.",
        ),
        /** Profile actually enforced by the engine (mode/trust clamps applied; never client-supplied). */
        effective_profile: AccessProfile.default("workspace_write").describe(
          "Access profile actually enforced by the engine (mode/trust clamps applied; never client-supplied).",
        ),
      })
      .default({
        requested_profile: "workspace_write",
        effective_profile: "workspace_write",
      })
      .describe("Requested vs engine-enforced access profile."),
    external_context: z
      .object({
        policy: ExternalContextPolicy.default("auto").describe(
          "Requested external web/context policy.",
        ),
        web_required: z
          .boolean()
          .default(false)
          .describe("Whether the task requires live web evidence."),
        /** Mode the selected route actually executes (disclosed upgrades, e.g. claude cached->live). */
        effective_mode: ExternalContextPolicy.default("auto").describe(
          "Policy the selected route actually executes (disclosed upgrades, e.g. cached to live).",
        ),
      })
      .default({ policy: "auto", web_required: false, effective_mode: "auto" })
      .describe("External web/context policy for the run."),
    tool_permission_policy: z
      .object({
        web: ExternalContextPolicy.default("auto").describe(
          "Web policy forwarded to tool permissioning.",
        ),
        allow: z.array(z.string()).default([]).describe("Tool names explicitly allowed."),
        deny: z.array(z.string()).default([]).describe("Tool names explicitly denied."),
      })
      .default({ web: "auto", allow: [], deny: [] })
      .describe("Tool permission policy passed to harnesses that support allow/deny lists."),
    budget: z
      .object({
        routing_goal: RoutingGoal.default("auto"),
        paid_budget: PaidBudget.default({ kind: "unlimited" }),
      })
      .default({})
      .describe("Routing goal and explicit incremental-cash budget for the run."),
    /** Resolved harness-scoped model map for this run (harness id → model id),
     * after scalar→primary expansion. The contract is the SSOT the route spec
     * builder reads; empty = every route uses its per-harness settings default. */
    routing_models: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        "Resolved harness-scoped model map for this run (harness id to model id); empty means every route uses its per-harness settings default.",
      ),
    convergence: ConvergencePredicate.default({}),
  })
  .describe("Immutable contract describing a single run; built once, hashed, never mutated.");
export type TaskContract = z.infer<typeof TaskContract>;

/**
 * Decoder for the persisted, frozen task artifact used to authorize delivery.
 * Runtime construction keeps TaskContract defaults for callers building a new
 * contract, but an existing authority must state its gate set explicitly: an
 * omitted/typoed field must never become a trustworthy empty list via defaults.
 */
export const FrozenTaskContractArtifact = z
  .object({
    tests: z.object({ commands: z.array(TestCommand) }).passthrough(),
  })
  .passthrough()
  .pipe(TaskContract)
  .describe("Persisted TaskContract with an explicit deterministic-gate authority.");
export type FrozenTaskContractArtifact = z.infer<typeof FrozenTaskContractArtifact>;
