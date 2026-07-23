import { z } from "zod";
import { AuthSourceKind, AuthSourceReadiness, CredentialRoute } from "./auth.js";
import { CredentialProfile } from "./credential-profile.js";
import { ToolRef } from "./tool-ref.js";
import {
  AccessProfile,
  AuthPreference,
  ExternalContextPolicy,
  Id,
  Intent,
  ProviderFamily,
} from "./primitives.js";
import { Attachment, AttachmentInputClass } from "./attachment.js";
import {
  ImplementationTransport,
  RawContextPacket,
  RawGitPatchEnvelope,
  RawPatchRefusalCode,
} from "./raw.js";
import { QuotaConstraint, QuotaSource } from "./quota.js";

/** Quality of a usage/quota signal a harness can emit. */
export const SignalQuality = z
  .enum(["exact", "native", "observed", "manual", "unknown"])
  .describe(
    "Quality of a usage/quota signal a harness can emit, from exact vendor accounting through native CLI reporting, engine observation, manual entry, to unknown.",
  );
export type SignalQuality = z.infer<typeof SignalQuality>;

/**
 * Open cross-harness reasoning-effort vocabulary. Adapters declare the SUBSET
 * they actually support via `HarnessCapabilities.effort_levels`; a shared
 * normalizer maps any requested level onto the nearest supported one. New levels
 * (e.g. a future `ultra`) extend this union without touching adapter logic.
 */
export const EffortHint = z
  .enum(["low", "medium", "high", "xhigh", "max"])
  .describe(
    "Cross-harness reasoning-effort level, weakest to strongest; adapters declare the subset they support and a shared normalizer clamps requests onto the nearest supported level.",
  );
export type EffortHint = z.infer<typeof EffortHint>;

// Staged-field rule: only kinds a shipped adapter declares. New adapter
// categories (local servers, SDK embeddings, external bridges) add their
// kind together with the adapter that produces it.
export const HarnessKind = z
  .enum(["local_cli", "remote_api", "fake"])
  .describe("Kind of harness adapter: a local vendor CLI, a remote API, or a fake used for tests.");
export type HarnessKind = z.infer<typeof HarnessKind>;

/**
 * How a harness can honor the external web policy:
 * - `native`: web modes are a native config surface (codex web_search).
 * - `tools`: web runs through permissioned tools the adapter can allow/deny (claude).
 * - `uncontrolled`: the harness CAN reach the web but exposes no enforceable
 *   switch — incompatible with `off` (cannot be enforced) AND with
 *   `cached`/`live` (cannot produce required evidence). cursor/opencode today.
 * - `none`: the harness has NO web access at all — trivially satisfies `off`,
 *   incompatible with web-required policies. raw-api/fake.
 */
export const WebPolicySupport = z
  .enum(["native", "tools", "uncontrolled", "none"])
  .describe(
    "How a harness can honor the external web policy: native (a native config surface), tools (permissioned tools the adapter can allow/deny), uncontrolled (can reach the web but exposes no enforceable switch), or none (no web access at all).",
  );
export type WebPolicySupport = z.infer<typeof WebPolicySupport>;

/**
 * Declared capabilities the ENGINE actually consumes (intent gating, routing,
 * knob support, disclosure). Every field here has a reader; declared-but-
 * never-read booleans (historically: spec/repair/shell/edit_files/
 * apply_patch/structured_events/structured_output/resume/cancel/mcp/plugins/
 * worktree_native) were deleted — a capability with no consumer is the same
 * bug class as a staged field. Re-add one only WITH its consumer in the same
 * change (as `json_schema_output` was, together with the structured-output
 * gate that reads it).
 */
export const HarnessCapabilities = z
  .object({
    plan: z.boolean().default(false).describe("The harness can produce plans (plan intent)."),
    implement: z
      .boolean()
      .default(false)
      .describe("The harness can implement code changes (implement intent)."),
    implementation_transport: ImplementationTransport.default("workspace").describe(
      "Typed producer/consumer transport used when implement=true.",
    ),
    create_from_scratch: z
      .boolean()
      .default(false)
      .describe("The harness can scaffold new projects (create_from_scratch intent)."),
    review: z
      .boolean()
      .default(false)
      .describe("The harness can act as a reviewer (review intent)."),
    /** Consumed by the Phase-3 FinalVerifier routing (gating pushes `verify`). */
    verify: z
      .boolean()
      .default(false)
      .describe("The harness can act as the FinalVerifier (verify intent)."),
    synthesize: z
      .boolean()
      .default(false)
      .describe("The harness can synthesize across candidate outputs (synthesize intent)."),
    read_files: z.boolean().default(false).describe("The harness can read project files."),
    /**
     * The adapter can inject a browser-automation MCP server (Playwright MCP) that
     * this harness drives as `browser_*` tools (navigate / screenshot / snapshot).
     * Gated on web policy: never injected under `external_context_policy:off`.
     */
    browser_tool: z
      .boolean()
      .default(false)
      .describe(
        "The adapter can inject a browser-automation MCP server (Playwright MCP) the harness drives as browser_* tools; never injected when web policy is off.",
      ),
    web_policy: WebPolicySupport.default("none"),
    /** Honors HarnessRunSpec.max_turns (e.g. claude --max-turns). */
    max_turns: z
      .boolean()
      .default(false)
      .describe("Honors HarnessRunSpec.max_turns (e.g. a native --max-turns flag)."),
    /** Honors tool_permission_policy allow/deny lists (e.g. claude --allowedTools). */
    tool_lists: z
      .boolean()
      .default(false)
      .describe(
        "Honors tool_permission_policy allow/deny lists (e.g. a native --allowedTools flag).",
      ),
    /**
     * The adapter can surface interactive user questions (interaction_requested
     * events) and deliver typed answers back into the live session. Claude's
     * bidirectional stream-json control protocol today; honest false elsewhere.
     */
    interactive: z
      .boolean()
      .default(false)
      .describe(
        "The adapter can surface interactive user questions (interaction_requested events) and deliver typed answers back into the live session.",
      ),
    /**
     * The harness can constrain its FINAL message to a caller-supplied JSON
     * Schema (codex `--output-schema <file>`, claude `--json-schema <json>`).
     * Consumer: the engine passes HarnessRunSpec.output_schema only to routes
     * declaring this; everything else keeps fenced-JSON parsing.
     */
    json_schema_output: z
      .boolean()
      .default(false)
      .describe(
        "The harness can constrain its final message to a caller-supplied JSON Schema (native structured-output flag).",
      ),
    /**
     * How the harness can carry the D-16 WorkReport envelope (a compiled
     * wrapper over any caller output schema). Consumer: the orchestrator spec
     * build compiles the envelope only for `constrained`/`validated` routes,
     * and the attempt finalizer demands a report only from them.
     * - `constrained`: a native schema-constrained transport carries it
     *   (codex --output-schema, claude StructuredOutput tool).
     * - `validated`: no native flag; the whole final answer is validated JSON
     *   (cursor's instructed fenced envelope on the existing parse path).
     * - `unsupported`: the route cannot carry a WorkReport; the work_state axis
     *   stays `unverified` (a disclosed absence, never a failure).
     */
    work_report_transport: z
      .enum(["constrained", "validated", "unsupported"])
      .default("unsupported")
      .describe(
        "How the harness carries the D-16 WorkReport envelope: constrained (native schema transport), validated (whole-answer JSON), or unsupported (work_state stays unverified).",
      ),
    /**
     * Where a schema-constrained structured answer surfaces relative to the
     * final message. Consumer: the orchestrator's no-caller-schema envelope
     * shape (D-16). `side_tool` (claude --json-schema materializes a
     * StructuredOutput tool; the prose message stays markdown) lets a
     * WorkReport-only envelope ride the tool while the markdown remains the
     * deliverable. `final_message` (codex --output-schema, cursor fenced JSON)
     * consumes the final message, so a no-caller WorkReport envelope must wrap
     * the markdown deliverable as `output: string`.
     */
    structured_output_channel: z
      .enum(["side_tool", "final_message"])
      .default("final_message")
      .describe(
        "Where a schema-constrained answer surfaces: side_tool (rides a tool; final message stays markdown) or final_message (constrains the final message itself).",
      ),
    /**
     * Ordered (weakest→strongest) reasoning-effort levels this harness actually
     * accepts. Empty = effort is not a tunable surface. The shared effort
     * normalizer clamps any requested EffortHint onto the nearest member.
     */
    effort_levels: z
      .array(EffortHint)
      .default([])
      .describe(
        "Ordered (weakest to strongest) reasoning-effort levels this harness actually accepts; empty means effort is not a tunable surface.",
      ),
    /**
     * Known model ids/aliases this harness accepts — the manifest-declared model
     * truth source used when the adapter has no live `models()` inventory.
     * STRICT: an explicit model outside the active truth source is refused
     * at settings-write, run preflight, and reviewer resolution; a harness with
     * NO truth source (no `models()` and an empty list) refuses every explicit
     * model. Data-driven like `effort_levels` — no model id is hardcoded in
     * routing logic.
     */
    known_models: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              id: z.string().min(1).describe("Model id/alias."),
              /** Credential routes this model is available on. A bare string
               * entry means ALL routes (backward shape). */
              routes: z
                .array(z.enum(["local_session", "api_key"]))
                .min(1)
                .describe("Credential routes this model is available on."),
            })
            .strict(),
        ]),
      )
      .default([])
      .describe(
        "Manifest-declared model ids/aliases this harness accepts (bare string = every credential route; object form scopes a model to specific routes), used as the model truth source when the adapter has no live inventory; explicit models outside the truth source are refused.",
      ),
    /**
     * Vendor CLI version this `known_models` hint set was last verified against
     * (freshness note, surfaced with manifest-sourced model lists and checked by
     * the model-hints-freshness gate). Null = never verified / not applicable.
     */
    known_models_verified_against: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Vendor CLI version the known_models hints were last verified against; null = never verified / not applicable.",
      ),
  })
  .describe(
    "Declared harness capabilities the engine actually consumes for intent gating, routing, knob support, and disclosure.",
  );
export type HarnessCapabilities = z.infer<typeof HarnessCapabilities>;

export type KnownModelEntry = HarnessCapabilities["known_models"][number];

/** Model ids from a known_models list that are valid on `route`. ONE owner for
 * the route filter (INV-122): a bare string entry is valid on every route;
 * `route: null` (undecidable pre-spawn) returns only the route-UNRESTRICTED
 * ids — fail-closed, a route-scoped model never leaks past an unknown route. */
export function knownModelIdsForRoute(
  entries: readonly KnownModelEntry[],
  route: "local_session" | "api_key" | null,
): string[] {
  return entries
    .filter((entry) =>
      typeof entry === "string" ? true : route !== null && entry.routes.includes(route),
    )
    .map((entry) => (typeof entry === "string" ? entry : entry.id));
}

export const CredentialTransportKind = z
  .enum(["config_file", "env_var", "oauth_token_env", "os_keychain", "http_header", "none"])
  .describe(
    "Mechanism that carries a credential to the harness process (config file, env var, OAuth token env, OS keychain, HTTP header, or none).",
  );
export type CredentialTransportKind = z.infer<typeof CredentialTransportKind>;

export const CredentialRelocation = z
  .enum(["HOME", "CONFIG_DIR", "ENV", "none"])
  .describe(
    "Which relocation lever moves the credential into a scoped environment (HOME, a config dir override, env injection, or none).",
  );
export type CredentialRelocation = z.infer<typeof CredentialRelocation>;

export const CredentialTransport = z
  .object({
    source: AuthSourceKind,
    kind: CredentialTransportKind,
    relocatable_by: z
      .array(CredentialRelocation)
      .default([])
      .describe("Relocation levers that can move this transport into a scoped environment."),
  })
  .describe("How a credential from one auth source physically reaches the harness process.");
export type CredentialTransport = z.infer<typeof CredentialTransport>;

export const AuthCapabilities = z
  .object({
    supported_sources: z
      .array(AuthSourceKind)
      .default([])
      .describe("Auth sources this harness supports."),
    preferred_source: AuthSourceKind.nullable()
      .default(null)
      .describe("Auth source the adapter prefers; null when it has no preference."),
    credential_transports: z
      .array(CredentialTransport)
      .default([])
      .describe("Declared credential transports per auth source."),
  })
  .default({})
  .describe("Declared auth routing facts for a harness.");
export type AuthCapabilities = z.infer<typeof AuthCapabilities>;

export const ContainmentKind = z
  .enum([
    "env_or_file_injection",
    "scoped_home_keychain_bridge",
    "host_user_context",
    "process_sandbox",
    "container",
  ])
  .describe(
    "Isolation containment level an adapter supports for run environments, from env/file injection through scoped-HOME keychain bridging to process sandboxes and containers.",
  );
export type ContainmentKind = z.infer<typeof ContainmentKind>;

export const IsolationCapabilities = z
  .object({
    supported_containment: z
      .array(ContainmentKind)
      .default(["env_or_file_injection"])
      .describe("Containment mechanisms the adapter can run under."),
  })
  .default({})
  .describe("Declared isolation containment facts for a harness.");
export type IsolationCapabilities = z.infer<typeof IsolationCapabilities>;

export const ReadonlyMechanism = z
  .enum(["fs_sandbox", "permission_deny", "tool_allowlist", "none"])
  .describe(
    "How read-only access is enforced for a harness: a filesystem sandbox, permission denial, a tool allowlist, or none (read-only intent is advisory).",
  );
export type ReadonlyMechanism = z.infer<typeof ReadonlyMechanism>;

export const AccessControlCapabilities = z
  .object({
    readonly_mechanism: ReadonlyMechanism.default("none"),
  })
  .default({})
  .describe("Declared access-control facts for a harness.");
export type AccessControlCapabilities = z.infer<typeof AccessControlCapabilities>;

/**
 * Structured per-harness facts the engine consumes: auth routing (scoped-home
 * keychain bridging), isolation containment, honest readonly mechanism, and
 * vision input. The v0.15 triage deleted the never-consumed subtrees
 * (execution_surfaces, session, output, probe/env metadata, access booleans):
 * a declared capability with no consumer is a staged field. Re-add a branch
 * only WITH its consumer in the same change.
 */
export const HarnessCapabilityProfile = z
  .object({
    auth: AuthCapabilities,
    access_control: AccessControlCapabilities,
    isolation: IsolationCapabilities,
    /** Every accepted media class has a finite MIME/size/count/transport declaration. */
    attachment_inputs: z.array(AttachmentInputClass).default([]),
    /**
     * The adapter can inject engine-owned MCP servers into the harness sandbox
     * (the generalized browser-MCP seam): claude via `--mcp-config` inline JSON,
     * codex via `-c mcp_servers.<name>.*` overrides. Consumers: the browser-tool
     * wiring and the delegation belt. When false, `HarnessRunSpec.extra_mcp_servers`
     * is refused at preflight (never silently dropped) and the Agent `delegate`
     * toggle is a typed refusal naming the harness.
     */
    mcp_injection: z
      .boolean()
      .default(false)
      .describe(
        "The adapter can inject engine-owned MCP servers into the harness sandbox (browser tool, delegation belt); false = extra_mcp_servers and the delegate toggle are refused.",
      ),
    /**
     * The injected belt can only reach the daemon (socket + control API, OUTSIDE
     * the run sandbox) at FULL access. Codex's workspace-write seatbelt cancels
     * that escalation-requiring MCP call in headless exec; only danger-full-access
     * lets it through — the browser MCP already rides this. Claude does not
     * sandbox its MCP servers (false). true => a --delegate lane below full
     * access is a typed preflight refusal, never a silent non-delegation.
     */
    mcp_injection_requires_full_access: z
      .boolean()
      .default(false)
      .describe(
        "An injected MCP server can only reach the daemon (belt) at full access; below it the harness sandbox cancels the call. true => --delegate below full access is refused for this harness.",
      ),
  })
  .default({})
  .describe(
    "Structured per-harness facts the engine consumes: auth routing, isolation containment, readonly mechanism, finite attachment inputs, and MCP injection.",
  );
export type HarnessCapabilityProfile = z.infer<typeof HarnessCapabilityProfile>;

/**
 * One enumerable model offered by a harness. Deliberately small: only the
 * fields a real enumeration source (an OpenAI-compatible `GET /v1/models`)
 * can honestly populate. `label`/`context_window` are nullable because the
 * raw `{data:[{id}]}` list rarely carries them.
 */
export const HarnessModel = z
  .object({
    id: z.string().describe("Model id as the vendor enumerates it."),
    label: z
      .string()
      .nullable()
      .default(null)
      .describe("Human-readable model label; null when the enumeration source has none."),
    context_window: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe("Context window in tokens; null when the enumeration source does not report it."),
    /** Credential routes the model is scoped to per the manifest annotation;
     * null = unannotated (available on every route). */
    routes: z
      .array(z.enum(["local_session", "api_key"]))
      .nullable()
      .default(null)
      .describe("Credential routes the model is scoped to; null = every route."),
  })
  .describe(
    "One enumerable model offered by a harness, limited to fields a real enumeration source can honestly populate.",
  );
export type HarnessModel = z.infer<typeof HarnessModel>;

export const HarnessManifest = z
  .object({
    id: Id.describe("Harness id (codex, claude, cursor, opencode, raw-api, ...)."),
    display_name: z.string().describe("Human display name of the harness."),
    kind: HarnessKind,
    version: z.string().optional().describe("Vendor CLI/API version, when discovered."),
    adapter_version: z.string().optional().describe("Version of the Claudexor adapter itself."),
    provider_family: ProviderFamily.default("unknown"),
    capability_profile: HarnessCapabilityProfile,
    /** Compatibility convenience fields. New routing/UI should prefer capability_profile. */
    capabilities: HarnessCapabilities,
    auth_modes: z
      .array(z.enum(["local_session", "api_key", "none"]))
      .default([])
      .describe("Auth modes the harness supports (availability only, not readiness)."),
    access_profiles_supported: z
      .array(AccessProfile)
      .default([])
      .describe("Access profiles the adapter can enforce."),
  })
  .describe(
    "Static manifest an adapter declares for its harness: identity, kind, capabilities, auth modes, and access profiles.",
  );
export type HarnessManifest = z.infer<typeof HarnessManifest>;

/** Result of a conformance probe for one capability check. */
export const ConformanceCheck = z
  .object({
    id: z.string().describe("Check id."),
    status: z.enum(["pass", "fail", "skip"]).describe("Outcome of the check: pass, fail, or skip."),
    detail: z.string().optional().describe("Human-readable detail for the outcome."),
    duration_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("How long the check took, in milliseconds."),
  })
  .describe("Result of a conformance probe for one capability check.");
export type ConformanceCheck = z.infer<typeof ConformanceCheck>;

export const AdapterStatus = z
  .enum(["ok", "degraded", "unavailable"])
  .describe(
    "Doctor verdict for a harness: ok (usable), degraded (usable with limitations), or unavailable.",
  );
export type AdapterStatus = z.infer<typeof AdapterStatus>;

export const ConformanceReport = z
  .object({
    harness_id: Id.describe("Harness the report is about."),
    status: AdapterStatus,
    checks: z.array(ConformanceCheck).default([]).describe("Individual probe results."),
    enabled_intents: z
      .array(Intent)
      .default([])
      .describe("Intents the gateway will route to this harness."),
    disabled_intents: z.array(Intent).default([]).describe("Intents the doctor disabled."),
    reasons: z
      .array(z.string())
      .default([])
      .describe("Human-readable reasons for degraded/unavailable status or disabled intents."),
    auth_sources: z
      .array(AuthSourceReadiness)
      .default([])
      .describe(
        "Doctor-backed readiness by authentication source; an empty array means the adapter did not report source readiness.",
      ),
  })
  .describe(
    "Doctor/conformance report for one harness: status, probe results, and the intents enabled or disabled by it.",
  );
export type ConformanceReport = z.infer<typeof ConformanceReport>;

export const BrowserToolSpec = z
  .object({
    output_dir: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Output directory for the browser MCP's per-navigation accessibility snapshots, kept in the run artifact tree; null = the MCP's own temp dir.",
      ),
    headless: z
      .boolean()
      .default(false)
      .describe(
        "Run the browser headless (no visible window); default false so the user can watch the agent browse.",
      ),
  })
  .describe(
    "Per-run browser-tool wiring, present only when the orchestrator decided this run gets the agent-driven browser (opt-in, browser_tool capability, web policy not off).",
  );
export type BrowserToolSpec = z.infer<typeof BrowserToolSpec>;

/**
 * One extra MCP server the adapter injects into the harness sandbox (generalized
 * from the browser-MCP seam). The engine names them, supplies the exact local
 * command + args + env, and each adapter translates the list into its native
 * MCP-injection transport (claude `--mcp-config` inline JSON, codex
 * `-c mcp_servers.<name>.*` overrides). Only injected on adapters whose
 * `capability_profile.mcp_injection` is true. `name` is the server key the
 * harness exposes its tools under (`mcp__<name>__*`).
 */
export const ExtraMcpServer = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        /^[a-z0-9_]+$/,
        "MCP server name must be lowercase alphanumeric/underscore (it becomes the mcp__<name>__* tool prefix)",
      )
      .describe("Server key the harness exposes the injected tools under (mcp__<name>__*)."),
    command: z.string().min(1).describe("Absolute executable for the MCP server process."),
    args: z.array(z.string()).default([]).describe("Argv for the MCP server process."),
    env: z
      .record(z.string(), z.string())
      .default({})
      .describe("Extra environment variables for the MCP server process."),
  })
  .describe(
    "One extra MCP server the adapter injects into the harness sandbox; translated per adapter alongside the browser one.",
  );
export type ExtraMcpServer = z.infer<typeof ExtraMcpServer>;

/** Spec passed to a harness adapter's run(). */
export const HarnessRunSpec = z
  .object({
    session_id: Id.describe("Session id this run belongs to."),
    intent: Intent,
    prompt: z.string().describe("Prompt text delivered to the harness."),
    /**
     * Optional caller-supplied system-level instructions layered on top of the
     * prompt for TASK-PRODUCING lanes (primary, candidate, planner, explorer)
     * — never reviewers, synthesis, or the auth smoke.
     * Adapters deliver it natively (claude `--append-system-prompt`, codex
     * `developer_instructions`) or as a delimited prompt prefix.
     */
    instructions: z
      .string()
      .optional()
      .describe(
        "Caller-supplied system-level instructions for task-producing lanes; delivered natively (append-system-prompt / developer_instructions) or as a delimited prompt prefix.",
      ),
    cwd: z.string().describe("Working directory the harness process runs in."),
    access: AccessProfile.default("workspace_write"),
    external_context_policy: ExternalContextPolicy.default("auto"),
    tool_permission_policy: z
      .object({
        web: ExternalContextPolicy.default("auto").describe(
          "Web policy forwarded to tool permissioning.",
        ),
        allow: z.array(z.string()).default([]).describe("Tool names explicitly allowed."),
        deny: z.array(z.string()).default([]).describe("Tool names explicitly denied."),
      })
      .default({ web: "auto", allow: [], deny: [] })
      .describe("Tool allow/deny policy for harnesses that support tool lists."),
    model_hint: z
      .string()
      .nullable()
      .default(null)
      .describe("Requested model id; null = the harness's default."),
    effort_hint: EffortHint.nullable()
      .default(null)
      .describe("Requested reasoning effort; null = the harness's default."),
    max_turns: z
      .number()
      .int()
      .nullable()
      .default(null)
      .describe("Maximum agent turns, for harnesses that honor it; null = no limit."),
    /**
     * Which auth route the attempt should use. `auto` = subscription-first with
     * api_key fallback; adapters seed native session vs inject the key accordingly.
     */
    auth_preference: AuthPreference.default("auto"),
    /**
     * The RESOLVED credential profile for this attempt (INV-135), stamped by
     * the orchestrator (the one resolve owner) from the durable registry —
     * adapters consume the typed transport and never read config. Null = the
     * engine-default credential ladder. An explicit profile is STRICT: the
     * adapter uses exactly its transport or refuses with a typed error, never
     * a silent fallback to default credentials.
     */
    credential_profile: CredentialProfile.nullable()
      .default(null)
      .describe(
        "Resolved credential profile for this attempt; null = engine-default credentials. Explicit profiles are strict: exact transport or typed refusal.",
      ),
    /**
     * Native CLI session id to resume into (codex `exec resume`, claude `--resume`,
     * cursor `agent --resume`, opencode `run --session`). Null starts a fresh session.
     */
    resume_session_id: z
      .string()
      .nullable()
      .default(null)
      .describe("Native CLI session id to resume into; null starts a fresh session."),
    /**
     * How the child harness env is composed. `mirror_native` inherits the parent
     * env (minus provider-secret scrub); `clean` spawns from a minimal allowlist
     * (agent env isolation). Threaded from routing.env_inheritance at spawn.
     */
    env_inheritance: z
      .enum(["mirror_native", "clean"])
      .default("mirror_native")
      .describe(
        "How the child harness env is composed: mirror_native inherits the parent env (minus provider-secret scrub); clean spawns from a minimal allowlist.",
      ),
    evidence_policy: z
      .enum(["stream_only", "allow_vendor_session_artifacts"])
      .default("allow_vendor_session_artifacts")
      .describe(
        "Whether route evidence may read vendor session artifacts; auth capability smokes require stream_only.",
      ),
    /**
     * Opt-in live text deltas (F2.5 W-C4): adapters that support partial
     * output add their native flag (claude --include-partial-messages,
     * cursor --stream-partial-output; codex exec has no deltas). Set ONLY on
     * single-candidate chat lanes — racing lanes stay delta-free (noise × N).
     * Delta messages carry payload.delta=true and never enter answers.
     */
    stream_deltas: z
      .boolean()
      .default(false)
      .describe(
        "Opt-in live text deltas on supporting adapters; single-candidate chat lanes only.",
      ),
    env: z
      .record(z.string(), z.string())
      .default({})
      .describe("Extra environment variables injected into the harness process."),
    /**
     * Immutable user/agent resources forwarded only after the selected adapter's
     * finite `capability_profile.attachment_inputs` declaration admits them.
     */
    attachments: z
      .array(Attachment)
      .default([])
      .describe(
        "Digest-bound resources forwarded to the harness in its declared native attachment transport.",
      ),
    /**
     * Agent-driven browser wiring. Null = no browser tool this run (the common
     * case). Set by the orchestrator only when the run opted in, the harness has
     * `browser_tool`, and web policy is not `off`.
     */
    browser: BrowserToolSpec.nullable()
      .default(null)
      .describe("Agent-driven browser wiring; null = no browser tool this run (the common case)."),
    /**
     * Extra MCP servers to inject into the harness sandbox (the delegation belt,
     * and any future engine-owned server). Empty by default. Only honored by
     * adapters whose `capability_profile.mcp_injection` is true; the engine
     * refuses `delegate` on an adapter that cannot inject rather than silently
     * dropping the belt.
     */
    extra_mcp_servers: z
      .array(ExtraMcpServer)
      .default([])
      .describe("Extra MCP servers injected into the harness sandbox; adapter-translated."),
    /**
     * JSON Schema constraining the harness's FINAL message (a caller-supplied
     * per-run output schema on agent/ask answers). Passed only to routes whose
     * manifest declares `json_schema_output`; consumers add the native CLI flag.
     */
    output_schema: z
      .unknown()
      .optional()
      .describe(
        "JSON Schema constraining the harness's final message; passed only to routes declaring json_schema_output.",
      ),
    raw_context_packet: RawContextPacket.nullable()
      .optional()
      .describe("Hash-bound context packet supplied only to git-patch-envelope producers."),
    extra: z
      .record(z.string(), z.unknown())
      .default({})
      .describe("Adapter-specific extras (no cross-adapter meaning)."),
  })
  .describe(
    "Spec passed to a harness adapter's run(): prompt, working directory, access, policies, routing hints, and wiring.",
  );
export type HarnessRunSpec = z.infer<typeof HarnessRunSpec>;

/**
 * One multiple-choice option of an interactive question (AskUserQuestion-style).
 */
export const InteractionOption = z
  .object({
    label: z.string().describe("Option label shown to the user."),
    description: z
      .string()
      .nullable()
      .default(null)
      .describe("Optional longer explanation of the option."),
  })
  .describe("One multiple-choice option of an interactive question.");
export type InteractionOption = z.infer<typeof InteractionOption>;

export const InteractionQuestion = z
  .object({
    id: Id.describe("Question id."),
    question: z.string().describe("The question text."),
    /** Short chip/header text some harnesses attach to a question. */
    header: z
      .string()
      .nullable()
      .default(null)
      .describe("Short chip/header text some harnesses attach to a question."),
    options: z
      .array(InteractionOption)
      .default([])
      .describe("Selectable options; empty for free-text-only questions."),
    multi_select: z.boolean().default(false).describe("Whether multiple options may be selected."),
  })
  .describe("One question of an interactive user-input request.");
export type InteractionQuestion = z.infer<typeof InteractionQuestion>;

/**
 * A live request for user input raised by an interactive harness session.
 * Carried on `interaction_requested` HarnessEvents and projected into
 * `interaction.requested` RunEvents.
 */
export const InteractionRequest = z
  .object({
    interaction_id: Id.describe("Interaction id used to correlate the answer set."),
    questions: z
      .array(InteractionQuestion)
      .default([])
      .describe("Questions the harness wants answered."),
    /** Native tool that raised the request (e.g. "AskUserQuestion"). */
    source_tool: z
      .string()
      .nullable()
      .default(null)
      .describe('Native tool that raised the request (e.g. "AskUserQuestion").'),
  })
  .describe("A live request for user input raised by an interactive harness session.");
export type InteractionRequest = z.infer<typeof InteractionRequest>;

export const InteractionAnswer = z
  .object({
    question_id: Id.describe("Id of the question being answered."),
    selected_labels: z.array(z.string()).default([]).describe("Labels of the selected options."),
    free_text: z
      .string()
      .nullable()
      .default(null)
      .describe("Free-text answer; null when only options were selected."),
  })
  .describe("The user's answer to one interactive question.");
export type InteractionAnswer = z.infer<typeof InteractionAnswer>;

export const InteractionAnswerSet = z
  .object({
    interaction_id: Id.describe("Interaction this answer set responds to."),
    answers: z.array(InteractionAnswer).default([]).describe("Answers, one per question."),
  })
  .describe("Typed answers delivered back into a live interactive harness session.");
export type InteractionAnswerSet = z.infer<typeof InteractionAnswerSet>;

/** Normalized event emitted by every adapter (the SSOT of adapter output). */
export const HarnessEvent = z
  .object({
    type: z
      .enum([
        "started",
        "thinking",
        "message",
        "tool_call",
        "tool_result",
        "interaction_requested",
        "file_change",
        "patch_produced",
        "usage",
        "error",
        "status",
        "context",
        "completed",
      ])
      .describe(
        "Normalized event type covering session lifecycle, output, tool use, interaction, file changes, usage, transient status, context-management signals, and errors.",
      ),
    session_id: Id.describe("Session the event belongs to."),
    ts: z.string().describe("Event timestamp."),
    text: z.string().optional().describe("Text content for thinking/message/error events."),
    /**
     * True on the harness's TYPED final answer message — claude/cursor's
     * terminal `result` event, codex's last agent message finalized at
     * `turn.completed`. Narration (mid-run) messages never set it; consumers
     * take a final message VERBATIM as the answer instead of joining prose.
     */
    final: z
      .boolean()
      .optional()
      .describe(
        "True on the harness's typed final-answer message (vendor terminal result); mid-run narration never sets it.",
      ),
    /** Typed tool info; set on `tool_call` and `tool_result` events. */
    tool: ToolRef.optional().describe("Typed tool info; set on tool_call and tool_result events."),
    /** Set on `interaction_requested` events. */
    interaction: InteractionRequest.optional().describe("Set on interaction_requested events."),
    patch_envelope: RawGitPatchEnvelope.optional().describe(
      "Typed hash-bound patch produced by a git-patch-envelope harness.",
    ),
    refusal_code: RawPatchRefusalCode.optional().describe(
      "Typed refusal code for a rejected raw patch contract.",
    ),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().optional().describe("Input tokens consumed."),
        output_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Output tokens produced."),
        cached_input_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Input tokens served from cache."),
        cost_usd: z.number().nonnegative().optional().describe("Cost in USD."),
        /** True when cost_usd is derived from token pricing (not natively reported). */
        estimated: z
          .boolean()
          .optional()
          .describe("True when cost_usd is derived from token pricing (not natively reported)."),
      })
      .optional()
      .describe("Token/cost usage reported by the harness."),
    observed_model: z.string().optional().describe("Model the harness actually reported using."),
    credential_route: CredentialRoute.optional().describe(
      "Concrete credential route selected before spawn; first-class route evidence, never inferred from free-form payload text.",
    ),
    credential_source: AuthSourceKind.optional().describe(
      "Concrete credential source selected before spawn; exact native subscription requires native_session, never an OAuth token or API key.",
    ),
    /** Credential profile the attempt runs under (INV-135); stamped by the
     * adapter alongside credential_route so quota/api_retry records stay
     * independently attributable to the profile. Absent = engine default. */
    credential_profile_id: Id.optional().describe(
      "Credential profile the attempt runs under; absent = engine-default credentials (INV-135 attribution).",
    ),
    /** Vendor-owned quota windows. All reported windows remain independent. */
    quota: z
      .object({
        source: QuotaSource,
        plan_label: z.string().nullable().default(null),
        subject_id: z.string().nullable().default(null),
        constraints: z.array(QuotaConstraint),
      })
      .strict()
      .optional()
      .describe(
        "All quota windows from a vendor-owned machine-readable source; never scraped from prose or collapsed into a fake aggregate.",
      ),
    /**
     * Typed live plan/todo progress: adapters map their native plan tools
     * (codex `todo_list` items, claude `TodoWrite` todos) into this shape in
     * the parse layer; the orchestrator forwards the LAST-WINS list as a
     * `plan.progress` run event and the UI renders live checklists. Never
     * parsed from prose.
     */
    plan_progress: z
      .object({
        items: z
          .array(
            z.object({
              id: z.string().describe("Plan item id."),
              title: z.string().describe("Plan item title."),
              status: z
                .enum(["pending", "in_progress", "completed"])
                .describe("Progress state of the item."),
            }),
          )
          .default([])
          .describe("Last-wins list of plan/todo items."),
      })
      .optional()
      .describe(
        "Typed live plan/todo progress mapped from the harness's native plan tools, never parsed from prose.",
      ),
    /**
     * Typed rate-limit / quota signal. Adapters set this in their parse layer when
     * the native CLI reports a 429 / quota / overload (adapter knowledge is allowed);
     * the budget layer projects it WITHOUT regex over model/CLI prose. Replaces the
     * old string-matching governance in budget/observe.ts.
     */
    rate_limit: z
      .object({
        resets_at: z
          .string()
          .nullable()
          .default(null)
          .describe("When the rate window resets, when reported."),
        retry_delay_ms: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .default(null)
          .describe("Suggested retry delay in milliseconds, when reported."),
      })
      .optional()
      .describe(
        "Typed rate-limit/quota signal set by the adapter when the native CLI reports a 429/quota/overload.",
      ),
    /**
     * Typed transient-status detail; set on `status` events. Today's only kind
     * is claude's native `api_retry` (the CLI is retrying an API call by
     * itself): the adapter maps the official fields through instead of
     * fabricating a thinking block, so retries land in the activity feed —
     * never in the reasoning disclosure. `error_category` passes the vendor's
     * own label (e.g. rate_limit, overloaded) verbatim as disclosed evidence.
     */
    status: z
      .object({
        kind: z.enum(["api_retry"]).describe("Kind of transient status."),
        attempt: z.number().int().nonnegative().optional().describe("Retry attempt number."),
        max_retries: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Vendor's configured retry ceiling."),
        retry_delay_ms: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Delay before the retry, when reported."),
        error_category: z
          .enum([
            "authentication_failed",
            "oauth_org_not_allowed",
            "billing_error",
            "rate_limit",
            "overloaded",
            "invalid_request",
            "model_not_found",
            "server_error",
            "max_output_tokens",
            "unknown",
          ])
          .optional()
          .describe(
            "Vendor's error category mapped onto the documented enum; unrecognized values collapse to 'unknown' (never free-form prose).",
          ),
      })
      .optional()
      .describe("Typed transient-status detail set by the adapter on status events."),
    /**
     * Typed transient-failure signal. Adapters set this from native CLI/API error
     * shapes in their parse layer; the orchestrator consumes it for bounded retry
     * policy without governing on free-form harness prose.
     */
    transient: z
      .object({
        kind: z
          .enum(["network", "stream_disconnect", "service_unavailable", "timeout", "unknown"])
          .default("unknown")
          .describe("Kind of transient failure."),
        retry_delay_ms: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .default(null)
          .describe("Suggested retry delay in milliseconds, when reported."),
      })
      .optional()
      .describe(
        "Typed transient-failure signal set by the adapter from native CLI/API error shapes, consumed for bounded retry policy.",
      ),
    /**
     * Typed CONTEXT-management signal (D-16), a sibling of `transient`/
     * `rate_limit` and DELIBERATELY separate from the transient-retry taxonomy:
     * adapters set it in their parse layer from native compaction / context-
     * exhaustion frames (claude `compact_boundary` system frames + result
     * `terminal_reason`, codex only when a recorded fixture proves a typed
     * marker). Context signals NEVER enter the transient_retry loop; a terminal
     * `capacity_exhausted` with no completed WorkReport is what the finalizer
     * maps to `interrupted / context_capacity_exhausted`.
     */
    context: z
      .object({
        kind: z
          .enum(["compaction_started", "compaction_completed", "capacity_exhausted"])
          .describe(
            "Kind of context signal: a compaction boundary starting/completing, or terminal capacity exhaustion.",
          ),
        cause: z
          .enum([
            "prompt_too_long",
            "repeated_refill",
            "blocking_limit",
            "window_exceeded",
            "unknown",
          ])
          .default("unknown")
          .describe("Why the context signal fired, mapped onto a typed cause (never prose)."),
        native_code: z
          .string()
          .nullable()
          .default(null)
          .describe("The vendor's own terminal/context code passed verbatim as evidence; null when none."),
        trigger: z
          .enum(["manual", "auto"])
          .nullable()
          .default(null)
          .describe("Whether the compaction was manually or automatically triggered; null when unreported."),
        pre_tokens: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .default(null)
          .describe("Token count before the compaction/exhaustion, when the vendor reports it; null otherwise."),
      })
      .optional()
      .describe(
        "Typed context-management signal (compaction boundary / capacity exhaustion) set by the adapter; orthogonal to the transient-retry taxonomy.",
      ),
    error: z.string().optional().describe("Error text for error events."),
    aborted: z
      .boolean()
      .optional()
      .describe(
        "Typed terminal cancellation marker, set on completed events when the run was aborted.",
      ),
    payload: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Raw adapter-specific payload for diagnostics."),
  })
  .describe("Normalized event emitted by every adapter (the SSOT of adapter output).");
export type HarnessEvent = z.infer<typeof HarnessEvent>;
