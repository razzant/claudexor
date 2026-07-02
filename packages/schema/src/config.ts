import { z } from "zod";
import { AccessProfile, AuthPreference, ExternalContextPolicy } from "./primitives.js";
import { EffortHint } from "./harness.js";
import { Portfolio } from "./budget.js";

export const RoutingPolicy = z.enum(["auto", "primary", "portfolio"]);
export type RoutingPolicy = z.infer<typeof RoutingPolicy>;

/**
 * Project config — safe, versioned settings. This shape may NOT carry sensitive
 * settings (full access, secrets, budget-above-cap, plugin auto-install, etc.);
 * those live only in global/user-local/trust configs and are modeled separately.
 */
export const ProjectConfig = z
  .object({
    version: z.literal(1).default(1),
    context: z
      .object({
        mandatory_files: z.array(z.string()).default([]),
        include: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),
    tests: z.object({ commands: z.array(z.string()).default([]) }).strict().default({ commands: [] }),
    budget: z
      .object({ portfolio: Portfolio.default("subscription-first") })
      .strict()
      .default({ portfolio: "subscription-first" }),
  })
  .strict();
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** Sensitive trust settings — only valid in global/user-local/trust files. */
export const TrustConfig = z
  .object({
    version: z.literal(1).default(1),
    access_default: AccessProfile.default("workspace_write"),
    allow_full_access: z.boolean().default(false),
  })
  .strict();
export type TrustConfig = z.infer<typeof TrustConfig>;

/** Global user config (~/.claudexor/config.yaml). */
export const GlobalConfig = z
  .object({
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
        /**
         * How the child harness env is built: `mirror_native` inherits the user's
         * shell env (default, matches how the native CLIs run); `clean` spawns from
         * a minimal allowlist (agent env isolation).
         */
        env_inheritance: z.enum(["mirror_native", "clean"]).default("mirror_native"),
        /** Default auth route preference (subscription/api_key/auto). */
        auth_preference: AuthPreference.default("auto"),
      })
      .strict()
      .default({}),
    budget: z
      .object({
        max_usd_per_run: z.number().nonnegative().nullable().default(null),
      })
      .strict()
      .default({}),
    runtime: z
      .object({
        /**
         * Bounded retry policy for adapter-declared transient failures. User-global
         * only: a versioned repo must not silently increase operator runtime costs.
         */
        transient_retry: z
          .object({
            max_retries: z.number().int().min(0).max(5).default(2),
            initial_delay_ms: z.number().int().nonnegative().default(1_000),
            max_delay_ms: z.number().int().nonnegative().default(10_000),
          })
          .strict()
          .default({}),
        reviewer_timeout_ms: z.number().int().positive().default(600_000),
      })
      .strict()
      .default({}),
    harnesses: z
      .record(
        z.string(),
        z
          .object({
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
            /** Per-harness auth route preference; overrides routing.auth_preference. */
            auth_preference: AuthPreference.default("auto"),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();
export type GlobalConfig = z.infer<typeof GlobalConfig>;

/** The fully-resolved effective config after precedence merge. */
export const ResolvedConfig = z.object({
  project: ProjectConfig,
  trust: TrustConfig,
  global: GlobalConfig,
  sources: z.array(z.string()).default([]),
});
export type ResolvedConfig = z.infer<typeof ResolvedConfig>;
