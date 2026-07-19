import { z } from "zod";
import { AccessProfile, ModeKind, ProviderFamily } from "./primitives.js";
import { AdapterStatus, EffortHint, ReadonlyMechanism } from "./harness.js";
import { WorkspaceMode } from "./thread.js";
import { AttachmentInputClass } from "./attachment.js";

/**
 * AgentCapabilityCatalog — the machine-readable answer to "what can this
 * Claudexor install do RIGHT NOW", for external agents (MCP hosts, scripts,
 * other CLIs). It is a DERIVED projection over existing truth sources —
 * harness manifests + doctor status (gateway.statusAll), the model-truth
 * service, the CLI command registry, and the schema's own closed vocabularies.
 * Nothing in it is hand-maintained; a catalog field without a live producer
 * must not exist (staged-field rule).
 */

/**
 * ControlRunStartRequest keys a DIRECT client may NOT send to POST /runs —
 * they belong to the daemon-internal thread-turn pipeline (POST
 * /threads/:id/turns pre-creates the turn and wires plan lineage). The
 * daemon-server 400-guards these; the capability catalog must exclude them
 * from the advertised run-control keys, or the catalog would lie to agents.
 * ONE list, two consumers — keep them in lockstep here.
 *
 * `threadId` is server-owned like `turnId` (D10): a thread turn is ALWAYS
 * created through POST /threads/:id/turns (the route owns scope resolution,
 * lineage, and the continuation packet). POST /runs is for one-shot,
 * thread-less runs only — a threadId there would smuggle a turn past the
 * continuity pipeline, so it is refused. The field stays on the schema
 * because the daemon-internal enqueue params still carry it (the turn route
 * fills it in), exactly like turnId.
 */
export const RUN_START_CLIENT_REJECTED_KEYS = [
  "threadId",
  "turnId",
  "planRunId",
  "planRef",
] as const;

/**
 * Mode -> tree mutability. ask/plan/audit are read-only BY CONSTRUCTION
 * (Bible invariant); agent writes; orchestrate may write above suggest
 * autonomy. The catalog derives its readOnlyModes/writeModes split from this
 * single map instead of re-encoding the split at each consumer.
 */
export const MODE_MUTABILITY: Record<z.infer<typeof ModeKind>, "read" | "write"> = {
  ask: "read",
  plan: "read",
  agent: "write",
  orchestrate: "write",
};

export const CatalogModelSummary = z
  .object({
    source: z
      .enum(["api", "manifest", "none"])
      .describe(
        "Where the model list comes from: a live vendor API enumeration, the adapter manifest's curated hints, or nothing (model overrides are refused for source=none).",
      ),
    count: z
      .number()
      .int()
      .min(0)
      .describe("Number of enumerable models (GET /harnesses/:id/models has the full list)."),
    verifiedAgainst: z
      .string()
      .nullable()
      .describe(
        "Vendor CLI version the manifest hints were last verified against (null for api/none sources).",
      ),
  })
  .describe("Summary of a harness's model truth source (full list via the models endpoint/verb).");
export type CatalogModelSummary = z.infer<typeof CatalogModelSummary>;

export const CatalogHarness = z
  .object({
    id: z
      .string()
      .describe("Harness id (codex, claude, cursor, opencode, raw-api, openrouter, ...)."),
    enabled: z
      .boolean()
      .describe(
        "False when settings disable this harness (harnesses.<id>.enabled=false) — routing excludes it regardless of doctor status.",
      ),
    displayName: z.string().describe("Human display name from the manifest."),
    status: AdapterStatus.describe(
      "Doctor verdict: ok | degraded | unavailable (doctor-backed, cached ~90s).",
    ),
    providerFamily: ProviderFamily.describe("Vendor family the harness routes to."),
    enabledIntents: z
      .array(z.string())
      .describe("Intents the gateway will route to this harness right now."),
    disabledIntents: z
      .array(z.string())
      .describe("Intents the doctor disabled (with reasons in `reasons`)."),
    reasons: z
      .array(z.string())
      .describe("Human-readable doctor/discovery reasons for degraded or unavailable status."),
    configuredModel: z
      .string()
      .nullable()
      .describe(
        "The user's configured per-harness default model, if any (null = engine default routing).",
      ),
    configuredModelValid: z
      .boolean()
      .nullable()
      .describe("Strict truth-source check of configuredModel (null when no model is configured)."),
    models: CatalogModelSummary,
    webPolicy: z
      .enum(["native", "tools", "uncontrolled", "none"])
      .describe("How external web/search is controlled for this harness."),
    attachmentInputs: z
      .array(AttachmentInputClass)
      .describe("Finite media/MIME/size/count/transport declarations for this adapter."),
    effortLevels: z
      .array(EffortHint)
      .describe("Reasoning-effort ladder the adapter declares (normalized by the engine)."),
    accessProfilesSupported: z
      .array(AccessProfile)
      .describe("Access profiles the adapter can enforce."),
    readonlyMechanism: ReadonlyMechanism.describe(
      "HOW read-only is enforced (fs_sandbox | permission_deny | tool_allowlist | none) — none means read-only intent is advisory for this harness.",
    ),
  })
  .describe("Per-harness live capability row (manifest + doctor + model truth).");
export type CatalogHarness = z.infer<typeof CatalogHarness>;

export const CatalogCliCommand = z
  .object({
    id: z.string().describe("CLI verb."),
    mutability: z
      .enum(["read", "write", "delivery", "ops"])
      .describe(
        "read = never mutates the tree; write = produces tree changes (envelope or live); delivery = moves an existing WorkProduct into the tree/VCS; ops = local config/daemon plumbing.",
      ),
    stability: z.enum(["stable", "experimental"]).describe("Contract stability of the verb."),
    recovery: z
      .boolean()
      .describe("True for post-run recovery verbs (inspect/follow/apply/decision)."),
  })
  .describe(
    "CLI verb projection from the command registry (same data `claudexor help --json` serves).",
  );
export type CatalogCliCommand = z.infer<typeof CatalogCliCommand>;

export const CatalogMutabilityMatrix = z
  .object({
    readOnlyModes: z
      .array(ModeKind)
      .describe(
        "Canonical modes that never mutate the project tree (ask/plan/audit; orchestrate in suggest autonomy is also read-only).",
      ),
    writeModes: z
      .array(ModeKind)
      .describe(
        "Canonical modes that may mutate a tree (agent always; orchestrate only above suggest autonomy).",
      ),
    isolationKinds: z
      .array(z.enum(["envelope", "live"]))
      .describe(
        "Run isolation: envelope = isolated worktree in the external per-project runtime namespace (default), live = the project tree itself.",
      ),
    workspaceModes: z
      .array(WorkspaceMode)
      .describe("Thread workspace modes (in_place | isolated)."),
    accessProfiles: z
      .array(AccessProfile)
      .describe(
        "Access vocabulary; `full` additionally requires the per-repo trust allow (claudexor trust --allow-full-access).",
      ),
    applyModes: z
      .array(z.enum(["apply", "commit", "branch", "pr"]))
      .describe("Delivery modes for applying a run's WorkProduct to the project."),
  })
  .describe(
    "The mutability matrix: every way a Claudexor run can (or cannot) touch a tree, from the schema's closed vocabularies.",
  );
export type CatalogMutabilityMatrix = z.infer<typeof CatalogMutabilityMatrix>;

export const AgentCapabilityCatalog = z
  .object({
    ok: z.literal(true).describe("Envelope marker (matches the CLI JSON convention)."),
    version: z
      .string()
      .describe(
        "Claudexor version serving this catalog (compare with CLAUDEXOR_PLUGIN_VERSION to detect plugin skew).",
      ),
    generatedAt: z.string().describe("ISO timestamp when the catalog was composed."),
    harnesses: z.array(CatalogHarness).describe("Live per-harness capabilities (doctor-backed)."),
    availableHarnesses: z.array(z.string()).describe("Convenience: ids with doctor status ok."),
    modes: z
      .array(ModeKind)
      .describe(
        "Canonical run modes (strategies like --n/--until-clean/--swarm are flags, not modes).",
      ),
    runControlKeys: z
      .array(z.string())
      .describe(
        "Accepted POST /runs request keys (derived from the ControlRunStartRequest schema; the CLI/MCP/ACP surfaces project subsets of these).",
      ),
    mutability: CatalogMutabilityMatrix,
    cliCommands: z
      .array(CatalogCliCommand)
      .describe(
        "CLI verbs with mutability/stability (full flag detail via `claudexor help --json`).",
      ),
    mcpTools: z.array(z.string()).describe("MCP tool names `claudexor mcp serve` exposes."),
    runApplyStates: z
      .array(z.string())
      .describe(
        "RunApplyState vocabulary an agent can encounter on run results (not_applied | applied | applied_review_blocked | reverted) — distinct from the ApplyEligibility verdict object on run details.",
      ),
  })
  .describe(
    "Machine-readable capability catalog for external agents — derived, never hand-maintained.",
  );
export type AgentCapabilityCatalog = z.infer<typeof AgentCapabilityCatalog>;
