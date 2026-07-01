import { z } from "zod";

/** Current schema version for top-level artifacts. Bump on breaking ABI changes. */
export const SCHEMA_VERSION = 2 as const;

export const SchemaVersion = z.literal(SCHEMA_VERSION);

/** A non-empty identifier string. */
export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

/** A user-supplied scalar that must contain visible content, not just spaces. */
export const NonBlankString = z.string().min(1).regex(/\S/, "must contain non-whitespace");
export type NonBlankString = z.infer<typeof NonBlankString>;

/** ISO-8601 timestamp string. */
export const IsoTimestamp = z.string().min(1);
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;

/** A content hash (algo:hex), e.g. "sha256:abcd...". */
export const ContentHash = z.string().min(1);
export type ContentHash = z.infer<typeof ContentHash>;

export const RiskLevel = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const AccessProfile = z.enum([
  "readonly",
  "workspace_write",
  "full",
  "external_sandbox_full",
  "inherit_native",
]);
export type AccessProfile = z.infer<typeof AccessProfile>;

/** External context policy is separate from process/network sandboxing. */
export const ExternalContextPolicy = z.enum(["off", "auto", "cached", "live"]);
export type ExternalContextPolicy = z.infer<typeof ExternalContextPolicy>;

/** Whether a terminal run also has a loaded user-facing output artifact. */
export const OutputReadyState = z.enum(["pending", "finalizing", "ready", "diagnostic"]);
export type OutputReadyState = z.infer<typeof OutputReadyState>;

/** Provider families used for route-diversity reasoning. Open-ended via "unknown". */
export const ProviderFamily = z.enum([
  "openai",
  "anthropic",
  "google",
  "cursor",
  "opencode",
  "xai",
  "local",
  "unknown",
]);
export type ProviderFamily = z.infer<typeof ProviderFamily>;

/**
 * Canonical modes (v0.9 collapse, BREAKING): the 9 v0.8 ids shrank to 5
 * intents-on-a-thread. The old engine strategies became FLAGS, not modes:
 * `best_of_n` -> agent + n, `max_attempts` -> agent + attempts,
 * `until_clean` -> agent + until_clean, `create` -> agent + create,
 * `explore` -> audit + swarm, `readonly_audit` -> audit. Old ids hard-error
 * at every wire boundary (Bible: modes are canonical and breaking, never
 * silent aliases). `orchestrate` is the autonomous brain intent (A3).
 */
export const ModeKind = z.enum(["ask", "plan", "audit", "agent", "orchestrate"]);
export type ModeKind = z.infer<typeof ModeKind>;

/** Canonical intents a harness can be assigned. Roles are intents, never fixed classes. */
export const Intent = z.enum([
  "plan",
  "spec",
  "implement",
  "create_from_scratch",
  "repair",
  "review",
  "verify",
  "compare",
  "synthesize",
  "arbitrate",
  "explain",
  "audit",
  "orchestrate",
]);
export type Intent = z.infer<typeof Intent>;

/**
 * How a dirty working tree is handled when creating an envelope.
 * `include` and `stash` are ALIASES of `snapshot` in the current
 * WorkspaceManager (a stash-create snapshot becomes the base SHA without
 * touching the live tree); `copy` additionally copies dirty files into the
 * worktree; `refuse` fails loudly.
 */
export const DirtyPolicy = z.enum(["refuse", "include", "stash", "copy", "snapshot"]);
export type DirtyPolicy = z.infer<typeof DirtyPolicy>;

/**
 * A user's preferred auth route for a harness, thread, or the orchestrate brain.
 * `subscription` = native/OAuth session; `api_key` = a stored API key; `auto`
 * lets the engine pick subscription-first and fall back per policy. This is a
 * preference, not a secret — the actual key refs live in global/trust config.
 */
export const AuthPreference = z.enum(["subscription", "api_key", "auto"]);
export type AuthPreference = z.infer<typeof AuthPreference>;

/**
 * Typed reason an auto-fallback (route/auth switch) or session re-host happened.
 * Fallback decisions are driven by typed budget/quota signals and events, never
 * by regex over model/CLI prose (Bible: no regex governance).
 */
export const FallbackReason = z.enum([
  "quota_exhausted",
  "money_exhausted",
  "subscription_exhausted",
  "rate_limited",
  "harness_error",
  "stall",
  "web_evidence_unsatisfied",
  "fallback_model",
  /** A native vendor session could not be carried into an isolated envelope
   * turn (write/race candidate runs fresh; continuity rides on the tree). */
  "not_portable",
  /** No usable auth source for the route (native session + api key both absent). */
  "auth_unavailable",
  /** Auto routing selected a doctor/smoke-proven route over another available
   * auth source; used to disclose cost/readiness tradeoffs without implying the
   * other source was missing. */
  "readiness_preferred",
  "manual",
]);
export type FallbackReason = z.infer<typeof FallbackReason>;
