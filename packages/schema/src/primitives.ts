import { z } from "zod";

/** Current schema version for top-level artifacts. Bump on breaking ABI changes. */
export const SCHEMA_VERSION = 2 as const;

export const SchemaVersion = z.literal(SCHEMA_VERSION);

/** A non-empty identifier string. */
export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

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

export const ModeKind = z.enum([
  "ask",
  "explore",
  "agent",
  "best_of_n",
  "max_attempts",
  "until_clean",
  "plan",
  "create",
  "readonly_audit",
]);
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
]);
export type Intent = z.infer<typeof Intent>;

export const DirtyPolicy = z.enum(["refuse", "include", "stash", "copy", "snapshot"]);
export type DirtyPolicy = z.infer<typeof DirtyPolicy>;
