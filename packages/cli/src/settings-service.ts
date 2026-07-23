/**
 * Settings-write validation + patch merge — the daemon's POST /settings core.
 *
 * STRICT (INV-104): persisted routing ids must be REAL registered
 * harnesses (fakes are test fixtures, never persistable routing targets),
 * model values must pass the harness's model truth source, and effort must be
 * on the declared ladder. All violations are 400s naming the harness, the
 * value, and the truth source — a bad value must never be persisted to die
 * later as an opaque native error.
 */
import type {
  ControlSettingsUpdateRequest,
  GlobalConfig as GlobalConfigT,
  QualityTierSet,
  RoutingGoal,
} from "@claudexor/schema";
import { GlobalConfig } from "@claudexor/schema";
import { validateModel } from "@claudexor/core";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { buildRegistry, harnessModels } from "./registry.js";

export function settingsSnapshot(repoRoot: string) {
  const cfg = loadConfig(repoRoot);
  return {
    sources: cfg.sources,
    interactionTimeoutMs: cfg.global.interaction_timeout_ms,
    routing: {
      primaryHarness: cfg.global.routing.primary_harness,
      eligibleHarnesses: cfg.global.routing.eligible_harnesses,
      envInheritance: cfg.global.routing.env_inheritance,
      authPreference: cfg.global.routing.auth_preference,
      goal: cfg.global.routing.goal,
      paidFallback: cfg.global.routing.paid_fallback,
      qualityTiers: cfg.global.routing.quality_tiers,
    },
    budget: { paidBudgetPerRun: cfg.global.budget.paid_budget_per_run },
    runtime: {
      reviewerTimeoutMs: cfg.global.runtime.reviewer_timeout_ms,
      harnessInactivityTimeoutMs: cfg.global.runtime.harness_inactivity_timeout_ms,
      transientRetry: {
        maxRetries: cfg.global.runtime.transient_retry.max_retries,
        initialDelayMs: cfg.global.runtime.transient_retry.initial_delay_ms,
        maxDelayMs: cfg.global.runtime.transient_retry.max_delay_ms,
      },
    },
    harnesses: Object.fromEntries(
      Object.entries(cfg.global.harnesses).map(([id, h]) => [
        id,
        {
          enabled: h.enabled,
          nativeCredentialsEnabled: h.native_credentials_enabled,
          defaultModel: h.default_model,
          effort: h.effort,
          maxTurns: h.max_turns,
          maxRounds: h.max_rounds,
          toolsAllow: h.tools_allow,
          toolsDeny: h.tools_deny,
          fallbackModel: h.fallback_model,
          web: h.web,
          authPreference: h.auth_preference,
          profileLimitAction: h.profile_policy.limit_action,
        },
      ]),
    ),
  };
}

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

/**
 * A settings MISCONFIGURATION refusal (D-9/#22 server half): a typed 4xx that
 * carries `code: "config_error"` so the request boundary projects it as a
 * config_error problem (never a 500, never a silent accept). Distinct from
 * `badRequest` so the quality-without-tiers refusal reads as a configuration
 * error the operator fixes by changing settings, mirroring the runtime
 * RoutingPreflightError → config_error classification the strategies apply.
 */
function configError(message: string): never {
  throw Object.assign(new Error(message), { status: 400, code: "config_error" });
}

/** Total user-declared quality tiers across every intent. Zero means quality
 * routing can never rank a route (the router refuses every quality run at
 * preflight), so persisting `goal: quality` with zero tiers is unroutable. */
function totalQualityTierCount(tiers: QualityTierSet): number {
  return Object.values(tiers).reduce((sum, list) => sum + (list?.length ?? 0), 0);
}

/**
 * The ONE cross-field routing invariant (D-9/#22): `goal: quality` with zero
 * configured quality tiers across every intent is unroutable — the router
 * refuses EVERY quality run at preflight. Extracted so BOTH the pre-lock
 * fast-fail (assertSettingsPatchValid) and the AUTHORITATIVE re-check under the
 * config lock (commitSettingsUpdate's mutator) enforce the exact same rule.
 * Pure + synchronous so it can run inside the locked read-mutate-write cycle.
 */
export function assertRoutingGoalTiersConsistent(goal: RoutingGoal, tiers: QualityTierSet): void {
  if (goal === "quality" && totalQualityTierCount(tiers) === 0) {
    configError(
      "quality routing requires at least one configured quality tier; configure a tier (via `claudexor settings`) or choose auto/economy routing — nothing was saved",
    );
  }
}

/**
 * `current` is the currently-stored routing this write merges over, and is
 * REQUIRED: the merged-effective goal/tiers invariant (D-9/#22) can only be
 * enforced against the stored state, so making it optional would let a future
 * writer call this + `updateGlobalConfig` directly and silently bypass the
 * fence. The effective value is the patch's field when present, otherwise the
 * stored one; `qualityTiers` REPLACES wholesale exactly as the persist path
 * merges it (control-services updateSettings), so a patch clearing tiers ({})
 * is honored here too.
 */
export async function assertSettingsPatchValid(
  p: ControlSettingsUpdateRequest,
  current: { goal: RoutingGoal; qualityTiers: QualityTierSet },
): Promise<void> {
  const realIds = new Set(buildRegistry({ includeFakes: false }).keys());
  const realList = [...realIds].sort().join(", ");
  if (p.primaryHarness) {
    if (!realIds.has(p.primaryHarness)) {
      badRequest(
        `primaryHarness '${p.primaryHarness}' is not a real registered harness (expected one of: ${realList})`,
      );
    }
  }
  for (const id of p.eligibleHarnesses ?? []) {
    if (!realIds.has(id)) {
      badRequest(
        `eligibleHarnesses entry '${id}' is not a real registered harness (expected one of: ${realList})`,
      );
    }
  }
  for (const [intent, tiers] of Object.entries(p.qualityTiers ?? {})) {
    for (const tier of tiers) {
      for (const route of tier) {
        if (!realIds.has(route.harness)) {
          badRequest(`quality tier for '${intent}' names unknown harness '${route.harness}'`);
        }
        const truth = await harnessModels(route.harness, process.cwd(), true);
        const model = validateModel(
          route.model,
          truth.models.map((item) => item.id),
          truth.source === "api" ? "api" : "manifest",
        );
        if (model.status !== "ok")
          badRequest(model.message ?? `model '${route.model}' was refused`);
        const manifest = await buildRegistry().get(route.harness)?.discover();
        if (!manifest?.capabilities.effort_levels.includes(route.effort)) {
          badRequest(
            `quality tier route '${route.harness}/${route.model}' does not accept effort '${route.effort}'`,
          );
        }
      }
    }
  }
  for (const [id, patch] of Object.entries(p.harnesses ?? {})) {
    // Per-harness settings persist only for REAL harnesses too: a
    // fake fixture id must fail here exactly like it does on the CLI path,
    // never quietly persist a `harnesses.fake-*` block.
    if (!realIds.has(id)) {
      badRequest(
        `harness settings for '${id}' are not persistable: not a real registered harness (expected one of: ${realList})`,
      );
    }
    const models: Array<{ field: string; value: string }> = [];
    if (patch.defaultModel) models.push({ field: "defaultModel", value: patch.defaultModel });
    if (patch.fallbackModel) models.push({ field: "fallbackModel", value: patch.fallbackModel });
    if (models.length > 0) {
      const truth = await harnessModels(id, process.cwd(), true);
      for (const { field, value } of models) {
        const check = validateModel(
          value,
          truth.models.map((m) => m.id),
          truth.source === "api" ? "api" : "manifest",
        );
        if (check.status !== "ok") {
          badRequest(
            `harness '${id}' refused ${field} '${value}' (truth source: ${truth.source}): ${check.message}`,
          );
        }
      }
    }
    if (patch.effort) {
      const adapter = buildRegistry().get(id);
      let ladder: readonly string[] = [];
      try {
        ladder = adapter ? (await adapter.discover()).capabilities.effort_levels : [];
      } catch (err) {
        // A harness whose manifest cannot be discovered (binary missing) still
        // 400s honestly rather than bubbling a raw error out of the endpoint.
        badRequest(
          `cannot verify effort for '${id}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!ladder.includes(patch.effort)) {
        badRequest(
          ladder.length === 0
            ? `harness '${id}' declares no effort ladder; leave effort unset`
            : `harness '${id}' does not accept effort '${patch.effort}' (declared ladder: ${ladder.join(", ")})`,
        );
      }
    }
  }
  // D-9/#22 server half: validate the MERGED EFFECTIVE routing, not just the
  // patch. If the write would leave `goal: quality` with zero configured tiers
  // across every intent, the engine would refuse EVERY quality run at preflight
  // (router `RoutingPreflightError`) and map it to a runtime failure. Refuse at
  // write with a typed 4xx config_error instead — whether the patch flips the
  // goal to quality over empty stored tiers, or clears the tiers while quality
  // is already active. The per-intent narrower case (tiers for some intents but
  // not the one a run uses) still surfaces at runtime, now classified as
  // config_error by the strategies.
  const effectiveGoal = p.routingGoal ?? current.goal;
  const effectiveTiers = p.qualityTiers ?? current.qualityTiers;
  assertRoutingGoalTiersConsistent(effectiveGoal, effectiveTiers);
}

const nullableSettingName = (
  value: string | null | undefined,
  current: string | null,
): string | null => {
  if (value === undefined) return current;
  if (value === null) return null;
  return value;
};

/**
 * Merge a validated settings patch into the snake_case GlobalConfig shape. Pure
 * fold of patch-over-current — no I/O, no validation — so the ONLY authority
 * that decides what gets persisted is `commitSettingsUpdate` under the lock.
 * `qualityTiers` REPLACES wholesale (a `{}` patch clears every tier).
 */
export function mergeSettingsPatch(
  cfg: GlobalConfigT,
  p: ControlSettingsUpdateRequest,
): GlobalConfigT {
  return {
    ...cfg,
    interaction_timeout_ms: p.interactionTimeoutMs ?? cfg.interaction_timeout_ms,
    routing: {
      ...cfg.routing,
      primary_harness: nullableSettingName(p.primaryHarness, cfg.routing.primary_harness),
      env_inheritance: p.envInheritance ?? cfg.routing.env_inheritance,
      eligible_harnesses: p.eligibleHarnesses ?? cfg.routing.eligible_harnesses,
      auth_preference: p.authPreference ?? cfg.routing.auth_preference,
      goal: p.routingGoal ?? cfg.routing.goal,
      paid_fallback: p.paidFallback ?? cfg.routing.paid_fallback,
      quality_tiers: p.qualityTiers ?? cfg.routing.quality_tiers,
    },
    budget: {
      ...cfg.budget,
      paid_budget_per_run: p.paidBudgetPerRun ?? cfg.budget.paid_budget_per_run,
    },
    harnesses: applyHarnessSettingsPatches(cfg.harnesses, p.harnesses),
  };
}

/**
 * The daemon's settings-write OWNER: the COMPLETE read → validate → write
 * transaction for POST /settings, made atomic (A-1 race fix).
 *
 * The bug this closes: `assertSettingsPatchValid` used to validate against a
 * snapshot read BEFORE the write, and the write committed under a SEPARATE
 * lock. Two concurrent requests could each validate a stale combination and
 * commit an invalid FINAL one (A sets goal=quality; B — validated while the
 * goal was still auto — clears qualityTiers; B commits after A ⇒ quality with
 * zero tiers persists, defeating the D-9 fence).
 *
 * The fix serializes the whole transaction on the ONE config lock
 * (`updateGlobalConfig` holds it across the read-mutate-write): the pre-lock
 * `assertSettingsPatchValid` still runs the async patch-local truth checks
 * (harness ids, model, effort — these never race) and a fast-fail, but the
 * cross-field goal/tiers invariant is RE-CHECKED against the EXACT merged
 * config under the lock, so the invalid final combination can never be
 * persisted regardless of interleaving.
 */
export async function commitSettingsUpdate(
  repoRoot: string,
  p: ControlSettingsUpdateRequest,
): Promise<void> {
  const currentRouting = loadConfig(repoRoot).global.routing;
  // Pre-lock: the patch-local truth (harness ids, models, effort ladders) and a
  // fast-fail on the goal/tiers invariant against the current snapshot.
  await assertSettingsPatchValid(p, {
    goal: currentRouting.goal,
    qualityTiers: currentRouting.quality_tiers,
  });
  // Atomic write: the merge + the cross-field re-validation both run INSIDE the
  // config lock against the state actually being mutated. A racing writer that
  // committed between the pre-lock snapshot and here is seen by `cfg`, so a
  // final quality-with-zero-tiers combination throws here (before any bytes are
  // written) instead of silently persisting.
  updateGlobalConfig((cfg) => {
    const next = mergeSettingsPatch(cfg, p);
    assertRoutingGoalTiersConsistent(next.routing.goal, next.routing.quality_tiers);
    return next;
  });
}

/** Merge camelCase per-harness patches into the snake_case GlobalConfig shape. */
export function applyHarnessSettingsPatches(
  current: GlobalConfigT["harnesses"],
  patches: ControlSettingsUpdateRequest["harnesses"],
): GlobalConfigT["harnesses"] {
  if (!patches) return current;
  // FAIL LOUDLY on unknown harness ids: a typo ('codexx') must never be
  // silently persisted as a new config entry nothing will ever read. REAL
  // harnesses only — fakes are test fixtures, never persistable.
  const knownIds = new Set(buildRegistry({ includeFakes: false }).keys());
  const next = { ...current };
  for (const [id, patch] of Object.entries(patches)) {
    if (!knownIds.has(id)) {
      throw Object.assign(
        new Error(
          `unknown harness id '${id}' (expected one of: ${[...knownIds].sort().join(", ")})`,
        ),
        { status: 400 },
      );
    }
    const base = next[id] ?? GlobalConfig.shape.harnesses.removeDefault().valueSchema.parse({});
    next[id] = {
      ...base,
      enabled: patch.enabled ?? base.enabled,
      native_credentials_enabled:
        patch.nativeCredentialsEnabled === undefined
          ? base.native_credentials_enabled
          : patch.nativeCredentialsEnabled,
      default_model: patch.defaultModel === undefined ? base.default_model : patch.defaultModel,
      effort: patch.effort === undefined ? base.effort : patch.effort,
      max_turns: patch.maxTurns === undefined ? base.max_turns : patch.maxTurns,
      max_rounds: patch.maxRounds === undefined ? base.max_rounds : patch.maxRounds,
      tools_allow: patch.toolsAllow ?? base.tools_allow,
      tools_deny: patch.toolsDeny ?? base.tools_deny,
      fallback_model: patch.fallbackModel === undefined ? base.fallback_model : patch.fallbackModel,
      web: patch.web ?? base.web,
      auth_preference: patch.authPreference ?? base.auth_preference,
      // The app's auto-switch toggle (INV-135): only limit_action is
      // patchable over the wire; rotation order and headroom keep their
      // stored values.
      profile_policy:
        patch.profileLimitAction === undefined
          ? base.profile_policy
          : { ...base.profile_policy, limit_action: patch.profileLimitAction },
    };
  }
  return next;
}
