import { z } from "zod";
import { AccessProfile, Id, Intent, ProviderFamily } from "./primitives.js";

/** Quality of a usage/quota signal a harness can emit. */
export const SignalQuality = z.enum(["exact", "native", "observed", "manual", "unknown"]);
export type SignalQuality = z.infer<typeof SignalQuality>;

export const HarnessKind = z.enum([
  "local_cli",
  "local_server",
  "sdk",
  "remote_api",
  "external_adapter",
  "fake",
]);
export type HarnessKind = z.infer<typeof HarnessKind>;

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
  plugins: z.boolean().default(false),
  worktree_native: z.boolean().default(false),
  quota_signal: SignalQuality.default("unknown"),
  usage_signal: SignalQuality.default("unknown"),
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

export const AuthCapabilities = z
  .object({
    supported_sources: z.array(AuthSourceKind).default([]),
    preferred_source: AuthSourceKind.nullable().default(null),
    probe_command: z.array(z.string()).default([]),
    env_vars: z.array(z.string()).default([]),
    can_scrub_env: z.boolean().default(true),
  })
  .default({});
export type AuthCapabilities = z.infer<typeof AuthCapabilities>;

export const AccessControlCapabilities = z
  .object({
    readonly: z.boolean().default(false),
    workspace_write: z.boolean().default(false),
    full: z.boolean().default(false),
    mechanism: z.string().nullable().default(null),
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
  })
  .default({});
export type HarnessCapabilityProfile = z.infer<typeof HarnessCapabilityProfile>;

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
  models: z
    .object({ discovery: z.enum(["available", "unavailable", "experimental"]).default("unavailable") })
    .default({ discovery: "unavailable" }),
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

/** Spec passed to a harness adapter's run(). */
export const HarnessRunSpec = z.object({
  session_id: Id,
  intent: Intent,
  prompt: z.string(),
  cwd: z.string(),
  access: AccessProfile.default("workspace_write"),
  model_hint: z.string().nullable().default(null),
  max_usd: z.number().nullable().default(null),
  max_turns: z.number().int().nullable().default(null),
  env: z.record(z.string(), z.string()).default({}),
  output_schema: z.unknown().optional(),
  extra: z.record(z.string(), z.unknown()).default({}),
});
export type HarnessRunSpec = z.infer<typeof HarnessRunSpec>;

/** Normalized event emitted by every adapter (the SSOT of adapter output). */
export const HarnessEvent = z.object({
  type: z.enum([
    "started",
    "thinking",
    "message",
    "tool_call",
    "file_change",
    "usage",
    "error",
    "completed",
  ]),
  session_id: Id,
  ts: z.string(),
  text: z.string().optional(),
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
  error: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type HarnessEvent = z.infer<typeof HarnessEvent>;
