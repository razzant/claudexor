import { z } from "zod";
import { AccessProfile, AuthPreference, ExternalContextPolicy } from "./primitives.js";
import { EffortHint } from "./harness.js";
import { DeliveryPolicy } from "./workproduct.js";
import { Portfolio } from "./budget.js";

export const RoutingPolicy = z.enum(["auto", "primary", "portfolio"]);
export type RoutingPolicy = z.infer<typeof RoutingPolicy>;

/** What to do when the preferred auth route's quota/money is exhausted. */
export const FallbackMode = z.enum(["subscription_to_api", "harness_to_harness", "both", "off"]);
export type FallbackMode = z.infer<typeof FallbackMode>;

/** Auto-fallback policy (every harness supports both subscription and api_key). */
export const FallbackConfig = z
  .object({
    on_quota_exhaustion: FallbackMode.default("both"),
    on_money_exhaustion: FallbackMode.default("both"),
  })
  .default({});
export type FallbackConfig = z.infer<typeof FallbackConfig>;

export const SecretRef = z.object({
  ref: z.string().min(1),
  env: z.string().optional(),
});
export type SecretRef = z.infer<typeof SecretRef>;

/**
 * Project config — safe, versioned settings. This shape may NOT carry sensitive
 * settings (full access, secrets, budget-above-cap, plugin auto-install, etc.);
 * those live only in global/user-local/trust configs and are modeled separately.
 */
export const ProjectConfig = z.object({
  version: z.literal(1).default(1),
  project: z
    .object({
      name: z.string().optional(),
      language_stack: z.array(z.string()).default([]),
      package_manager: z.string().optional(),
    })
    .default({ language_stack: [] }),
  context: z
    .object({
      agents_md_first: z.boolean().default(true),
      never_silent_truncate: z.boolean().default(true),
      mandatory_files: z.array(z.string()).default([]),
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    })
    .default({}),
  tests: z.object({ commands: z.array(z.string()).default([]) }).default({ commands: [] }),
  delivery: z
    .object({
      default_mutation_mode: DeliveryPolicy.shape.mutation_mode.optional(),
      default_apply_policy: DeliveryPolicy.shape.apply_policy.optional(),
    })
    .default({}),
  review: z
    .object({
      default_attempts: z.number().int().positive().default(3),
      strictness: z.enum(["advisory", "block"]).default("block"),
    })
    .default({}),
  budget: z.object({ portfolio: Portfolio.default("subscription-first") }).default({ portfolio: "subscription-first" }),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** Sensitive trust settings — only valid in global/user-local/trust files. */
export const TrustConfig = z.object({
  version: z.literal(1).default(1),
  repo_hash: z.string().optional(),
  access_default: AccessProfile.default("workspace_write"),
  allow_full_access: z.boolean().default(false),
  full_access_requires_prompt: z.boolean().default(true),
  max_api_budget_usd_per_day: z.number().nonnegative().nullable().default(null),
  preferred_harnesses: z.array(z.string()).default([]),
});
export type TrustConfig = z.infer<typeof TrustConfig>;

/** Global user config (~/.claudexor/config.yaml). */
export const GlobalConfig = z.object({
  version: z.literal(1).default(1),
  default_portfolio: Portfolio.default("subscription-first"),
  /**
   * How long an interactive run waits for the user's answer to a harness
   * question (interaction.requested) before delivering a benign decline and
   * letting the model continue with assumptions.
   */
  interaction_timeout_ms: z.number().int().positive().default(900_000),
  routing: z
    .object({
      default_policy: RoutingPolicy.default("auto"),
      primary_harness: z.string().nullable().default(null),
      eligible_harnesses: z.array(z.string()).default([]),
      default_model: z.string().nullable().default(null),
      env_inheritance: z.enum(["mirror_native", "clean", "profile_only"]).default("mirror_native"),
      /** Default auth route preference (subscription/api_key/auto). */
      auth_preference: AuthPreference.default("auto"),
      /** Auto-fallback policy on quota/money exhaustion (never silent). */
      fallback: FallbackConfig,
    })
    .default({}),
  budget: z
    .object({
      max_usd_per_run: z.number().nonnegative().nullable().default(null),
      max_usd_per_day: z.number().nonnegative().nullable().default(null),
    })
    .default({}),
  harnesses: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().default(true),
        default_model: z.string().nullable().default(null),
        effort: EffortHint.nullable().default(null),
        max_turns: z.number().int().positive().nullable().default(null),
        max_rounds: z.number().int().positive().nullable().default(null),
        max_usd: z.number().nonnegative().nullable().default(null),
        tools_allow: z.array(z.string()).default([]),
        tools_deny: z.array(z.string()).default([]),
        fallback_model: z.string().nullable().default(null),
        web: ExternalContextPolicy.default("auto"),
        native_options: z.record(z.string(), z.unknown()).default({}),
        auth_ref: SecretRef.nullable().default(null),
        /** Per-harness auth route preference; overrides routing.auth_preference. */
        auth_preference: AuthPreference.default("auto"),
      }),
    )
    .default({}),
  secrets: z
    .record(
      z.string(),
      z.object({
        description: z.string().optional(),
        harnesses: z.array(z.string()).default([]),
        env: z.string().optional(),
      }),
    )
    .default({}),
});
export type GlobalConfig = z.infer<typeof GlobalConfig>;

/** The fully-resolved effective config after precedence merge. */
export const ResolvedConfig = z.object({
  project: ProjectConfig,
  trust: TrustConfig,
  global: GlobalConfig,
  sources: z.array(z.string()).default([]),
});
export type ResolvedConfig = z.infer<typeof ResolvedConfig>;
