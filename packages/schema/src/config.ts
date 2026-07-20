import { z } from "zod";
import { AccessProfile, AuthPreference, ExternalContextPolicy } from "./primitives.js";
import { EffortHint } from "./harness.js";
import { CredentialProfile } from "./credential-profile.js";
import { PaidBudget, PaidFallback, QualityTierSet, RoutingGoal } from "./budget.js";
import { TestCommandGrant, TestCommandInvocation } from "./task.js";

// All retired v1 portfolio ids are rejected; v2 routing uses the explicit
// auto, quality, and economy goals instead.
/**
 * Project config — safe, versioned settings. This shape may NOT carry sensitive
 * settings (full access, secrets, budget-above-cap, plugin auto-install, etc.);
 * those live only in global/user-local/trust configs and are modeled separately.
 */
export const ProjectConfig = z
  .object({
    version: z.literal(1).default(1).describe("Config format version."),
    context: z
      .object({
        mandatory_files: z
          .array(z.string())
          .default([])
          .describe("Files every context pack must include."),
        include: z.array(z.string()).default([]).describe("Globs to include in context building."),
        exclude: z
          .array(z.string())
          .default([])
          .describe("Globs to exclude from context building."),
      })
      .strict()
      .default({})
      .describe("Context-building preferences for the project."),
    tests: z
      .object({
        commands: z
          .array(TestCommandInvocation)
          .default([])
          .describe("Typed-argv test commands run as deterministic gates."),
      })
      .strict()
      .default({ commands: [] })
      .describe("Project-configured deterministic test gates."),
    budget: z
      .object({ routing_goal: RoutingGoal.optional() })
      .strict()
      .default({})
      .describe("Safe project routing preference; paid fallback remains user-global."),
  })
  .strict()
  .describe(
    "Project config (.claudexor/config.yaml) — safe, versioned settings only; sensitive settings live in global/user-local/trust configs.",
  );
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** Sensitive trust settings — only valid in global/user-local/trust files. */
export const TrustConfig = z
  .object({
    version: z.literal(1).default(1).describe("Config format version."),
    access_default: AccessProfile.default("workspace_write").describe(
      "Default access profile for runs in this repo.",
    ),
    allow_full_access: z
      .boolean()
      .default(false)
      .describe("Per-repo allow required before any run may use the full access profile."),
    /**
     * Provenance ONLY: which repo root this file was written for. The file's
     * key stays the repo-root HASH in its filename — this field never gates
     * anything; it exists so trust state is enumerable (Settings lists the
     * projects with full access). Legacy files (written before this field)
     * carry null and surfaces disclose them as revocable only via CLI.
     */
    repo_root: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Provenance only: repo root this trust file was written for; never gates anything. Null on legacy files written before this field.",
      ),
    test_command_grants: z
      .array(TestCommandGrant)
      .default([])
      .describe("External exact grants for versioned project test commands."),
  })
  .strict()
  .describe(
    "Sensitive per-repo trust settings — only valid in global/user-local trust files, never in the versioned repo config.",
  );
export type TrustConfig = z.infer<typeof TrustConfig>;

/** Claudexor v3 global user config (~/.claudexor/v3/config.yaml). */
export const GlobalConfig = z
  .object({
    version: z.literal(1).default(1).describe("Config format version."),
    /**
     * How long an interactive run waits for the user's answer to a harness
     * question (interaction.requested) before delivering a benign decline and
     * letting the model continue with assumptions.
     */
    interaction_timeout_ms: z
      .number()
      .int()
      .positive()
      .default(900_000)
      .describe(
        "How long an interactive run waits for the user's answer to a harness question before delivering a benign decline and letting the model continue.",
      ),
    routing: z
      .object({
        primary_harness: z
          .string()
          .nullable()
          .default(null)
          .describe("Global default primary harness; null = engine decides."),
        eligible_harnesses: z
          .array(z.string())
          .default([])
          .describe("Harness pool eligible for routing/races; empty = all available."),
        /**
         * How the child harness env is built: `mirror_native` inherits the user's
         * shell env (default, matches how the native CLIs run); `clean` spawns from
         * a minimal allowlist (agent env isolation).
         */
        env_inheritance: z
          .enum(["mirror_native", "clean"])
          .default("mirror_native")
          .describe(
            "How the child harness env is built: mirror_native inherits the user's shell env; clean spawns from a minimal allowlist.",
          ),
        /** Default auth route preference (subscription/api_key/auto). */
        auth_preference: AuthPreference.default("auto"),
        goal: RoutingGoal.default("auto"),
        paid_fallback: PaidFallback.default("when_unavailable"),
        quality_tiers: QualityTierSet,
      })
      .strict()
      .default({})
      .describe("Global routing defaults."),
    budget: z
      .object({
        paid_budget_per_run: PaidBudget.default({ kind: "unlimited" }),
        /**
         * Per-candidate reservation floor (USD) held against the run cap for
         * every race-wave slot AFTER the first, BEFORE any usage streams.
         * Makes concurrent in-flight candidates visible to the budget breaker
         * so a parallel wave cannot blow past the finite paid budget between
         * settlements. The first slot never holds it: a cap smaller than the
         * floor still runs one candidate and stops on real usage.
         */
        estimate_usd_floor: z
          .number()
          .nonnegative()
          .default(0.05)
          .describe(
            "Per-candidate USD reservation floor held against the run cap for every race-wave slot after the first, so a parallel wave cannot blow past the cap between settlements.",
          ),
      })
      .strict()
      .default({})
      .describe("Global budget limits."),
    runtime: z
      .object({
        /**
         * Bounded retry policy for adapter-declared transient failures. User-global
         * only: a versioned repo must not silently increase operator runtime costs.
         */
        transient_retry: z
          .object({
            max_retries: z
              .number()
              .int()
              .min(0)
              .max(5)
              .default(2)
              .describe("Maximum retries for a transient failure."),
            initial_delay_ms: z
              .number()
              .int()
              .nonnegative()
              .default(1_000)
              .describe("Initial retry delay in milliseconds."),
            max_delay_ms: z
              .number()
              .int()
              .nonnegative()
              .default(10_000)
              .describe("Maximum retry delay in milliseconds."),
          })
          .strict()
          .default({})
          .describe(
            "Bounded retry policy for adapter-declared transient failures; user-global only.",
          ),
        reviewer_timeout_ms: z
          .number()
          .int()
          .positive()
          .default(600_000)
          .describe("Wall-clock timeout for a reviewer run, in milliseconds."),
        /**
         * Inactivity watchdog for candidate/planner/read-only harness streams:
         * NO events for this window means the CLI is wedged — the stream is
         * aborted (process-group kill) and the attempt fails with a typed
         * timeout instead of parking the run in `running` forever. Distinct
         * from the reviewer wall-clock timeout: long runs are fine as long as
         * they keep emitting. Note the timer resets on HARNESS events — a tool
         * call that streams nothing for the whole window is indistinguishable
         * from a hang and will be killed.
         */
        harness_inactivity_timeout_ms: z
          .number()
          .int()
          .positive()
          .default(1_200_000)
          .describe(
            "Inactivity watchdog for harness streams: no events for this window aborts the stream and fails the attempt with a typed timeout.",
          ),
      })
      .strict()
      .default({})
      .describe("Global runtime timeouts and retry policy."),
    /**
     * Disk retention for engine-owned runtime artifacts (W3.6). The daemon's
     * retention service deletes ONLY terminal, unreferenced run trees past
     * their age — active/queued/blocked runs, runs referenced by live
     * threads, and undelivered/applyable work products always survive, and
     * the newest N runs per project survive regardless of age.
     */
    retention: z
      .object({
        runs_max_age_days: z
          .number()
          .int()
          .positive()
          .default(30)
          .describe("Delete terminal, unreferenced run trees older than this many days."),
        reviews_max_age_days: z
          .number()
          .int()
          .positive()
          .default(14)
          .describe("Delete standalone diff-review trees older than this many days."),
        keep_last_runs_per_project: z
          .number()
          .int()
          .nonnegative()
          .default(20)
          .describe("The newest N runs per project always survive, regardless of age."),
      })
      .strict()
      .default({})
      .describe("Disk retention policy for engine-owned runtime artifacts."),
    /**
     * Durable NON-SECRET credential-profile registry (INV-135): additional
     * credential identities per harness beyond the engine default. Uniqueness
     * of (harness_id, profile_id) is enforced here; secret material lives in
     * the vendor dir or the secret store, never in config.
     */
    credential_profiles: z
      .array(CredentialProfile)
      .default([])
      .superRefine((profiles, ctx) => {
        const seen = new Set<string>();
        for (const p of profiles) {
          const key = `${p.harness_id}\u0000${p.profile_id}`;
          if (seen.has(key))
            ctx.addIssue({
              code: "custom",
              message: `duplicate credential profile ${p.profile_id} for harness ${p.harness_id}`,
            });
          seen.add(key);
        }
      })
      .describe(
        "Durable non-secret credential-profile registry; secret material lives in the vendor dir or the secret store, never in config.",
      ),
    harnesses: z
      .record(
        z.string(),
        z
          .object({
            enabled: z
              .boolean()
              .default(true)
              .describe("Whether the harness participates in routing."),
            /**
             * Whether the native/default vendor credential (the "CLI login"
             * account — ~/.claude, the native codex home) is routable for this
             * harness (INV-135). false EXCLUDES it from the credential ladder:
             * an unpinned run of a harness whose CLI login is disabled has
             * nothing routable and refuses rather than silently falling back
             * INTO the disabled CLI login. Enabled credential profiles route
             * only by explicit pin (per-run --profile / per-thread) or as
             * quota-rotation targets — never as a silent auto-default.
             */
            native_credentials_enabled: z
              .boolean()
              .default(true)
              .describe(
                "Whether the native/default vendor credential (the CLI login) participates in this harness's credential ladder.",
              ),
            default_model: z
              .string()
              .nullable()
              .default(null)
              .describe("Per-harness default model; null = the harness's own default."),
            effort: EffortHint.nullable()
              .default(null)
              .describe("Default reasoning effort for the harness; null = harness default."),
            max_turns: z
              .number()
              .int()
              .positive()
              .nullable()
              .default(null)
              .describe("Default max agent turns; null = no limit."),
            max_rounds: z
              .number()
              .int()
              .positive()
              .nullable()
              .default(null)
              .describe("Default max convergence rounds; null = engine default."),
            /**
             * ONE typed profile-selection policy (INV-135, W5.4): what happens
             * when the selected credential profile hits its vendor limit.
             * Rotation is OPT-IN and rotates only on typed vendor-limit
             * signals or proactive headroom breaches — never on ordinary
             * network errors.
             */
            profile_policy: z
              .object({
                limit_action: z
                  .enum(["fail", "ask", "rotate"])
                  .default("fail")
                  .describe(
                    "On a typed vendor limit: fail the attempt, surface a typed ask, or rotate to the next eligible profile.",
                  ),
                rotation_eligible: z
                  .array(z.string())
                  .default([])
                  .describe(
                    "Priority-ordered profile ids eligible for rotation; empty = every enabled profile of this harness in registry order.",
                  ),
                headroom_threshold: z
                  .number()
                  .min(0)
                  .max(1)
                  .default(0.9)
                  .describe(
                    "Preflight headroom bound: a selected profile whose active window is at/over this ratio triggers the limit action BEFORE spawn.",
                  ),
              })
              .strict()
              .default({})
              .describe("Typed profile-selection policy for this harness (INV-135)."),
            tools_allow: z
              .array(z.string())
              .default([])
              .describe("Tool names allowed for this harness."),
            tools_deny: z
              .array(z.string())
              .default([])
              .describe("Tool names denied for this harness."),
            fallback_model: z
              .string()
              .nullable()
              .default(null)
              .describe("Model to fall back to on typed fallback signals; null = none."),
            web: ExternalContextPolicy.default("auto").describe(
              "Default web policy for this harness.",
            ),
            /** Per-harness auth route preference; overrides routing.auth_preference. */
            auth_preference: AuthPreference.default("auto"),
          })
          .strict()
          .describe("Per-harness settings."),
      )
      .default({})
      .describe("Per-harness settings keyed by harness id."),
  })
  .strict()
  .describe(
    "Claudexor v3 global user config (~/.claudexor/v3/config.yaml): routing, budget, runtime, and per-harness settings.",
  );
export type GlobalConfig = z.infer<typeof GlobalConfig>;

/** The fully-resolved effective config after precedence merge. */
export const ResolvedConfig = z
  .object({
    project: ProjectConfig,
    trust: TrustConfig,
    global: GlobalConfig,
    sources: z
      .array(z.string())
      .default([])
      .describe("Config file paths that contributed to the merge."),
  })
  .describe("The fully-resolved effective config after precedence merge.");
export type ResolvedConfig = z.infer<typeof ResolvedConfig>;
