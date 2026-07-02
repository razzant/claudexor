import { z } from "zod";
import { AccessProfile, AuthPreference, ExternalContextPolicy, Id, Intent, ProviderFamily } from "./primitives.js";
import { Attachment, ImageInputMode } from "./attachment.js";

/** Quality of a usage/quota signal a harness can emit. */
export const SignalQuality = z.enum(["exact", "native", "observed", "manual", "unknown"]);
export type SignalQuality = z.infer<typeof SignalQuality>;

/**
 * Open cross-harness reasoning-effort vocabulary. Adapters declare the SUBSET
 * they actually support via `HarnessCapabilities.effort_levels`; a shared
 * normalizer maps any requested level onto the nearest supported one. New levels
 * (e.g. a future `ultra`) extend this union without touching adapter logic.
 */
export const EffortHint = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortHint = z.infer<typeof EffortHint>;


export const HarnessKind = z.enum([
  "local_cli",
  "local_server",
  "sdk",
  "remote_api",
  "external_adapter",
  "fake",
]);
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
export const WebPolicySupport = z.enum(["native", "tools", "uncontrolled", "none"]);
export type WebPolicySupport = z.infer<typeof WebPolicySupport>;

export const HarnessCapabilities = z.object({
  plan: z.boolean().default(false),
  spec: z.boolean().default(false),
  implement: z.boolean().default(false),
  create_from_scratch: z.boolean().default(false),
  repair: z.boolean().default(false),
  review: z.boolean().default(false),
  verify: z.boolean().default(false),
  compare: z.boolean().default(false),
  synthesize: z.boolean().default(false),
  shell: z.boolean().default(false),
  read_files: z.boolean().default(false),
  edit_files: z.boolean().default(false),
  apply_patch: z.boolean().default(false),
  structured_events: z.boolean().default(false),
  structured_output: z.boolean().default(false),
  json_schema_output: z.boolean().default(false),
  resume: z.boolean().default(false),
  cancel: z.boolean().default(false),
  mcp: z.boolean().default(false),
  /**
   * The adapter can inject a browser-automation MCP server (Playwright MCP) that
   * this harness drives as `browser_*` tools (navigate / screenshot / snapshot).
   * Gated on web policy: never injected under `external_context_policy:off`.
   * Requires `mcp` to be true (injection rides the harness's MCP-client surface).
   */
  browser_tool: z.boolean().default(false),
  plugins: z.boolean().default(false),
  worktree_native: z.boolean().default(false),
  web_policy: WebPolicySupport.default("none"),
  /** Honors HarnessRunSpec.max_turns (e.g. claude --max-turns). */
  max_turns: z.boolean().default(false),
  /** Honors tool_permission_policy allow/deny lists (e.g. claude --allowedTools). */
  tool_lists: z.boolean().default(false),
  /**
   * The adapter can surface interactive user questions (interaction_requested
   * events) and deliver typed answers back into the live session. Claude's
   * bidirectional stream-json control protocol today; honest false elsewhere.
   */
  interactive: z.boolean().default(false),
  /**
   * The harness can play the autonomous `orchestrate` brain intent (A3): plan
   * multi-harness work over the typed tool belt. NOT a privileged role — routed
   * like reviewers via doctor + capability + quota headroom.
   */
  orchestrate: z.boolean().default(false),
  quota_signal: SignalQuality.default("unknown"),
  usage_signal: SignalQuality.default("unknown"),
  /**
   * Ordered (weakest→strongest) reasoning-effort levels this harness actually
   * accepts. Empty = effort is not a tunable surface. The shared effort
   * normalizer clamps any requested EffortHint onto the nearest member.
   */
  effort_levels: z.array(EffortHint).default([]),
  /**
   * Known model ids/aliases this harness accepts — the manifest-declared model
   * truth source used when the adapter has no live `models()` inventory.
   * STRICT (D3): an explicit model outside the active truth source is refused
   * at settings-write, run preflight, and reviewer resolution; a harness with
   * NO truth source (no `models()` and an empty list) refuses every explicit
   * model. Data-driven like `effort_levels` — no model id is hardcoded in
   * routing logic.
   */
  known_models: z.array(z.string()).default([]),
  /**
   * Vendor CLI version this `known_models` hint set was last verified against
   * (freshness note, surfaced with manifest-sourced model lists and checked by
   * the model-hints-freshness gate). Null = never verified / not applicable.
   */
  known_models_verified_against: z.string().nullable().default(null),
});
export type HarnessCapabilities = z.infer<typeof HarnessCapabilities>;

export const ExecutionSurfaceKind = z.enum([
  "cli_one_shot",
  "stdin_stream_session",
  "background_session",
  "local_http_server",
  "acp_stdio_jsonrpc",
]);
export type ExecutionSurfaceKind = z.infer<typeof ExecutionSurfaceKind>;

export const ExecutionSurface = z.object({
  kind: ExecutionSurfaceKind,
  input: z.enum(["prompt_arg", "stdin_once", "stdin_stream", "json_rpc", "http"]).default("prompt_arg"),
  output: z.enum(["text", "json", "ndjson", "sse", "json_rpc"]).default("text"),
  event_schema: z.enum(["none", "native", "normalized", "versioned"]).default("none"),
  supports_followup: z.boolean().default(false),
  supports_interrupt: z.boolean().default(false),
  supports_permission_reply: z.boolean().default(false),
});
export type ExecutionSurface = z.infer<typeof ExecutionSurface>;

export const SessionCapabilities = z
  .object({
    native_session_id_emitted: z.boolean().default(false),
    resume_latest: z.boolean().default(false),
    resume_by_id: z.boolean().default(false),
    fork: z.boolean().default(false),
    list: z.boolean().default(false),
    logs: z.boolean().default(false),
    attach_tui: z.boolean().default(false),
    export: z.boolean().default(false),
    diff: z.boolean().default(false),
  })
  .default({});
export type SessionCapabilities = z.infer<typeof SessionCapabilities>;

export const OutputCapabilities = z
  .object({
    ndjson_events: z.boolean().default(false),
    partial_deltas: z.boolean().default(false),
    tool_lifecycle: z.boolean().default(false),
    file_changes: z.boolean().default(false),
    final_json: z.boolean().default(false),
    json_schema_final: z.boolean().default(false),
    usage_signal: SignalQuality.default("unknown"),
    cost_signal: SignalQuality.default("unknown"),
  })
  .default({});
export type OutputCapabilities = z.infer<typeof OutputCapabilities>;

export const AuthSourceKind = z.enum([
  "native_session",
  "browser_login",
  "api_key_env",
  "api_key_flag",
  "provider_auth_file",
  "project_env",
  "none",
]);
export type AuthSourceKind = z.infer<typeof AuthSourceKind>;

export const CredentialTransportKind = z.enum(["config_file", "env_var", "oauth_token_env", "os_keychain", "http_header", "none"]);
export type CredentialTransportKind = z.infer<typeof CredentialTransportKind>;

export const CredentialRelocation = z.enum(["HOME", "CONFIG_DIR", "ENV", "none"]);
export type CredentialRelocation = z.infer<typeof CredentialRelocation>;

export const CredentialTransport = z.object({
  source: AuthSourceKind,
  kind: CredentialTransportKind,
  relocatable_by: z.array(CredentialRelocation).default([]),
  requires_user_session: z.boolean().default(false),
  bypass_env_vars: z.array(z.string()).default([]),
});
export type CredentialTransport = z.infer<typeof CredentialTransport>;

export const AuthCapabilities = z
  .object({
    supported_sources: z.array(AuthSourceKind).default([]),
    preferred_source: AuthSourceKind.nullable().default(null),
    probe_command: z.array(z.string()).default([]),
    env_vars: z.array(z.string()).default([]),
    credential_transports: z.array(CredentialTransport).default([]),
  })
  .default({});
export type AuthCapabilities = z.infer<typeof AuthCapabilities>;

export const ContainmentKind = z.enum(["env_or_file_injection", "scoped_home_keychain_bridge", "host_user_context", "process_sandbox", "container"]);
export type ContainmentKind = z.infer<typeof ContainmentKind>;

export const IsolationCapabilities = z
  .object({
    path_redirect_sufficient: z.boolean().default(true),
    requires_user_session: z.boolean().default(false),
    supported_containment: z.array(ContainmentKind).default(["env_or_file_injection"]),
  })
  .default({});
export type IsolationCapabilities = z.infer<typeof IsolationCapabilities>;

export const ReadonlyMechanism = z.enum(["fs_sandbox", "permission_deny", "tool_allowlist", "none"]);
export type ReadonlyMechanism = z.infer<typeof ReadonlyMechanism>;

export const AccessControlCapabilities = z
  .object({
    readonly: z.boolean().default(false),
    workspace_write: z.boolean().default(false),
    full: z.boolean().default(false),
    mechanism: z.string().nullable().default(null),
    readonly_mechanism: ReadonlyMechanism.default("none"),
    conformance_required: z.boolean().default(true),
  })
  .default({});
export type AccessControlCapabilities = z.infer<typeof AccessControlCapabilities>;

export const HarnessCapabilityProfile = z
  .object({
    execution_surfaces: z.array(ExecutionSurface).default([]),
    session: SessionCapabilities,
    output: OutputCapabilities,
    auth: AuthCapabilities,
    access_control: AccessControlCapabilities,
    isolation: IsolationCapabilities,
    /** How the harness accepts image input (drives honest attach gating + the
     *  per-adapter serializer). `none` = no vision input on this route. */
    image_input: ImageInputMode.default("none"),
  })
  .default({});
export type HarnessCapabilityProfile = z.infer<typeof HarnessCapabilityProfile>;

/**
 * One enumerable model offered by a harness. Deliberately small: only the
 * fields a real enumeration source (an OpenAI-compatible `GET /v1/models`)
 * can honestly populate. `label`/`context_window` are nullable because the
 * raw `{data:[{id}]}` list rarely carries them.
 */
export const HarnessModel = z.object({
  id: z.string(),
  label: z.string().nullable().default(null),
  context_window: z.number().int().positive().nullable().default(null),
});
export type HarnessModel = z.infer<typeof HarnessModel>;

export const HarnessManifest = z.object({
  id: Id,
  display_name: z.string(),
  kind: HarnessKind,
  version: z.string().optional(),
  adapter_version: z.string().optional(),
  provider_family: ProviderFamily.default("unknown"),
  capability_profile: HarnessCapabilityProfile,
  /** Compatibility convenience fields. New routing/UI should prefer capability_profile. */
  capabilities: HarnessCapabilities,
  auth_modes: z.array(z.enum(["local_session", "api_key", "none"])).default([]),
  access_profiles_supported: z.array(AccessProfile).default([]),
});
export type HarnessManifest = z.infer<typeof HarnessManifest>;

/** Result of a conformance probe for one capability check. */
export const ConformanceCheck = z.object({
  id: z.string(),
  status: z.enum(["pass", "fail", "skip"]),
  detail: z.string().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});
export type ConformanceCheck = z.infer<typeof ConformanceCheck>;

export const AdapterStatus = z.enum(["ok", "degraded", "unavailable"]);
export type AdapterStatus = z.infer<typeof AdapterStatus>;

export const ConformanceReport = z.object({
  harness_id: Id,
  status: AdapterStatus,
  checks: z.array(ConformanceCheck).default([]),
  enabled_intents: z.array(Intent).default([]),
  disabled_intents: z.array(Intent).default([]),
  reasons: z.array(z.string()).default([]),
});
export type ConformanceReport = z.infer<typeof ConformanceReport>;

/**
 * Per-run browser-tool wiring. Present (non-null) on a HarnessRunSpec ONLY when
 * the orchestrator has decided this run gets the agent-driven browser: the run
 * opted in, the harness has the `browser_tool` capability, AND web policy is not
 * `off`. The adapter injects Playwright MCP accordingly.
 */
export const BrowserToolSpec = z.object({
  /**
   * `--output-dir` for the browser MCP. Captures the per-navigation accessibility
   * SNAPSHOTS (Playwright MCP writes screenshot image files to the agent's cwd,
   * not here) into the run artifact tree as a browsing record the Canvas gallery
   * lists. The live view is the headed window itself. Null = MCP's own temp dir.
   */
  output_dir: z.string().nullable().default(null),
  /**
   * Run the browser headless (no visible window). Default false — a headed
   * Chromium so the user can watch the agent browse directly (the chosen mirror:
   * a real visible window, not an embedded screencast).
   */
  headless: z.boolean().default(false),
});
export type BrowserToolSpec = z.infer<typeof BrowserToolSpec>;

/** Spec passed to a harness adapter's run(). */
export const HarnessRunSpec = z.object({
  session_id: Id,
  intent: Intent,
  prompt: z.string(),
  cwd: z.string(),
  access: AccessProfile.default("workspace_write"),
  external_context_policy: ExternalContextPolicy.default("auto"),
  tool_permission_policy: z
    .object({
      web: ExternalContextPolicy.default("auto"),
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({ web: "auto", allow: [], deny: [] }),
  model_hint: z.string().nullable().default(null),
  effort_hint: EffortHint.nullable().default(null),
  max_usd: z.number().nullable().default(null),
  max_turns: z.number().int().nullable().default(null),
  /**
   * Which auth route the attempt should use. `auto` = subscription-first with
   * api_key fallback; adapters seed native session vs inject the key accordingly.
   */
  auth_preference: AuthPreference.default("auto"),
  /**
   * Native CLI session id to resume into (codex `exec resume`, claude `--resume`,
   * cursor `agent --resume`, opencode `run --session`). Null starts a fresh session.
   */
  resume_session_id: z.string().nullable().default(null),
  /**
   * How the child harness env is composed. `mirror_native` inherits the parent
   * env (minus provider-secret scrub); `clean` spawns from a minimal allowlist
   * (agent env isolation). Threaded from routing.env_inheritance at spawn.
   */
  env_inheritance: z.enum(["mirror_native", "clean"]).default("mirror_native"),
  env: z.record(z.string(), z.string()).default({}),
  /**
   * User/agent attachments (images, files) forwarded to the harness in its
   * native shape per `capability_profile.image_input`. Empty for non-vision
   * harnesses — the orchestrator drops + discloses rather than silently ignore.
   */
  attachments: z.array(Attachment).default([]),
  /**
   * Agent-driven browser wiring. Null = no browser tool this run (the common
   * case). Set by the orchestrator only when the run opted in, the harness has
   * `browser_tool`, and web policy is not `off`.
   */
  browser: BrowserToolSpec.nullable().default(null),
  output_schema: z.unknown().optional(),
  extra: z.record(z.string(), z.unknown()).default({}),
});
export type HarnessRunSpec = z.infer<typeof HarnessRunSpec>;

/**
 * Coarse tool classification used for typed governance (no tool-name string
 * matching outside adapters). Adapters map native tool names to a kind.
 */
export const ToolKind = z.enum(["web", "file", "command", "mcp", "search", "other"]);
export type ToolKind = z.infer<typeof ToolKind>;

/**
 * Typed tool reference attached to `tool_call` / `tool_result` events.
 * `status` is REQUIRED on `tool_result` events (adapter conformance enforces it);
 * a missing status on a result is treated as a dropped/diagnostic event, never as ok.
 */
export const ToolRef = z.object({
  name: z.string(),
  kind: ToolKind.default("other"),
  use_id: z.string().optional(),
  /** Redacted, bounded human-readable target (query/url/path/command). */
  target: z.string().optional(),
  status: z.enum(["ok", "error", "cancelled", "denied"]).optional(),
  /** Redacted, bounded error detail for status=error results. */
  error_summary: z.string().optional(),
  /** Redacted, bounded content detail for results (success or failure). */
  content_summary: z.string().optional(),
  exit_code: z.number().int().optional(),
});
export type ToolRef = z.infer<typeof ToolRef>;

/**
 * One multiple-choice option of an interactive question (AskUserQuestion-style).
 */
export const InteractionOption = z.object({
  label: z.string(),
  description: z.string().nullable().default(null),
});
export type InteractionOption = z.infer<typeof InteractionOption>;

export const InteractionQuestion = z.object({
  id: Id,
  question: z.string(),
  /** Short chip/header text some harnesses attach to a question. */
  header: z.string().nullable().default(null),
  options: z.array(InteractionOption).default([]),
  multi_select: z.boolean().default(false),
});
export type InteractionQuestion = z.infer<typeof InteractionQuestion>;

/**
 * A live request for user input raised by an interactive harness session.
 * Carried on `interaction_requested` HarnessEvents and projected into
 * `interaction.requested` RunEvents.
 */
export const InteractionRequest = z.object({
  interaction_id: Id,
  questions: z.array(InteractionQuestion).default([]),
  /** Native tool that raised the request (e.g. "AskUserQuestion"). */
  source_tool: z.string().nullable().default(null),
});
export type InteractionRequest = z.infer<typeof InteractionRequest>;

export const InteractionAnswer = z.object({
  question_id: Id,
  selected_labels: z.array(z.string()).default([]),
  free_text: z.string().nullable().default(null),
});
export type InteractionAnswer = z.infer<typeof InteractionAnswer>;

export const InteractionAnswerSet = z.object({
  interaction_id: Id,
  answers: z.array(InteractionAnswer).default([]),
});
export type InteractionAnswerSet = z.infer<typeof InteractionAnswerSet>;

/** Normalized event emitted by every adapter (the SSOT of adapter output). */
export const HarnessEvent = z.object({
  type: z.enum([
    "started",
    "thinking",
    "message",
    "tool_call",
    "tool_result",
    "interaction_requested",
    "file_change",
    "usage",
    "error",
    "completed",
  ]),
  session_id: Id,
  ts: z.string(),
  text: z.string().optional(),
  /** Typed tool info; set on `tool_call` and `tool_result` events. */
  tool: ToolRef.optional(),
  /** Set on `interaction_requested` events. */
  interaction: InteractionRequest.optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cached_input_tokens: z.number().int().nonnegative().optional(),
      cost_usd: z.number().nonnegative().optional(),
      /** True when cost_usd is derived from token pricing (not natively reported). */
      estimated: z.boolean().optional(),
    })
    .optional(),
  observed_model: z.string().optional(),
  /**
   * Typed rate-limit / quota signal. Adapters set this in their parse layer when
   * the native CLI reports a 429 / quota / overload (adapter knowledge is allowed);
   * the budget layer projects it WITHOUT regex over model/CLI prose. Replaces the
   * old string-matching governance in budget/observe.ts.
   */
  rate_limit: z
    .object({
      resets_at: z.string().nullable().default(null),
      retry_delay_ms: z.number().int().nonnegative().nullable().default(null),
    })
    .optional(),
  /**
   * Typed transient-failure signal. Adapters set this from native CLI/API error
   * shapes in their parse layer; the orchestrator consumes it for bounded retry
   * policy without governing on free-form harness prose.
   */
  transient: z
    .object({
      kind: z.enum(["network", "stream_disconnect", "service_unavailable", "timeout", "unknown"]).default("unknown"),
      retry_delay_ms: z.number().int().nonnegative().nullable().default(null),
    })
    .optional(),
  error: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type HarnessEvent = z.infer<typeof HarnessEvent>;
