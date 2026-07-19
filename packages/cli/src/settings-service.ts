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
} from "@claudexor/schema";
import { GlobalConfig } from "@claudexor/schema";
import { validateModel } from "@claudexor/core";
import { loadConfig } from "@claudexor/config";
import { assertActiveProfileRegistered } from "./profile-compatibility.js";
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
          activeProfileId: h.active_profile_id,
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

export async function assertSettingsPatchValid(p: ControlSettingsUpdateRequest): Promise<void> {
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
    // The Active account (INV-135) must name a registered enabled profile of
    // THIS harness before it is persisted — an unknown/disabled id 400s here
    // rather than dying at run-resolve time. null clears to the native login.
    if (patch.activeProfileId !== undefined) {
      try {
        assertActiveProfileRegistered(
          loadConfig(process.cwd()).global.credential_profiles,
          id,
          patch.activeProfileId,
        );
      } catch (err) {
        badRequest(err instanceof Error ? err.message : String(err));
      }
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
      active_profile_id:
        patch.activeProfileId === undefined ? base.active_profile_id : patch.activeProfileId,
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
