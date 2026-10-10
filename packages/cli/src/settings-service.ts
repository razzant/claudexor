import { resolveEffort, effortLadders } from "@claudexor/core";
/**
 * Settings-write validation + patch merge — the daemon's POST /settings core.
 *
 * STRICT (INV-104): persisted routing ids must be REAL registered
 * harnesses (fakes are test fixtures, never persistable routing targets),
 * model values must pass the harness's model truth source, and the effort a
 * harness ends up holding must be on the ladder of the model it ends up
 * pointing at. All violations are 400s naming the harness, the value, and the
 * truth source — a bad value must never be persisted to die later as an opaque
 * native error.
 */
import type {
  GlobalConfig as GlobalConfigT,
  HarnessCapabilities,
  QualityTierSet,
  RoutingGoal,
  RuntimeConcurrencyCaps,
} from "@claudexor/schema";
import {
  ControlSettingsUpdateRequest,
  GlobalConfig,
  runtimeConcurrencyCaps,
  concurrencyState,
} from "@claudexor/schema";
import { effortLevelsForModel } from "@claudexor/schema";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { buildRegistry, checkHarnessModelTruth, harnessModelTruth } from "./registry.js";

export function settingsSnapshot(
  repoRoot: string,
  effectiveConcurrencyCaps?: RuntimeConcurrencyCaps,
) {
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
      ...(effectiveConcurrencyCaps
        ? {
            concurrency: concurrencyState(
              runtimeConcurrencyCaps(cfg.global, cfg.runtimeConcurrencySources),
              effectiveConcurrencyCaps,
            ),
          }
        : {}),
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
  throw Object.assign(new Error(message), { status: 400, code: "invalid_request" });
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
 * Effort-carrier support for a settings write. An adapter with an effort
 * carrier (`effortParameter`: a separate flag, or `--model` where the level is
 * a token of the compound model id and preparation selects the listed variant)
 * defers vocabulary resolution to dispatch; other adapters keep manifest
 * validation under lock. `null` means the harness has no adapter to ask.
 */
export type PatchEffortCapabilities = ReadonlyMap<
  string,
  HarnessCapabilities | { effortParameter: string } | null
>;

/** Effort is a preference resolved at dispatch. A route with an effort carrier
 * accepts any word at WRITE time: a flag adapter resolves it against the final
 * account's ladder, and a compound-id route (Cursor, Antigravity) selects the
 * listed level variant of the model's family from the running account's
 * inventory, omitting (never refusing) a word it cannot place. Only a route
 * with no carrier at all still refuses here (a validation, never lost paid
 * work). Adapters without a declaration retain validation against their
 * ladder: its own order first, the shared preference order only for a word
 * that ladder does not list. */
export function assertHarnessEffortPairsValid(
  harnesses: GlobalConfigT["harnesses"],
  capabilities: PatchEffortCapabilities,
): void {
  for (const [id, caps] of capabilities) {
    const settings = harnesses[id];
    const effort = settings?.effort ?? null;
    if (!effort) continue;
    const model = settings?.default_model ?? null;
    if (caps && "effortParameter" in caps) continue;
    const ladder = caps ? effortLevelsForModel(caps, model) : [];
    if (
      ladder.length &&
      resolveEffort(
        effort,
        ladder,
        effortLadders([
          caps!.effort_levels,
          ...Object.values(caps!.model_effort_levels).map((entry) => entry.levels),
        ]),
      ).status === "ok"
    )
      continue;
    badRequest(
      ladder.length === 0
        ? `harness '${id}' declares no effort ladder; leave effort unset`
        : `harness '${id}'${model ? ` model '${model}'` : ""} does not accept effort '${effort}' (advertised: ${ladder.join(", ")})`,
    );
  }
}

/**
 * `current` is the currently-stored state this write merges over, and is
 * REQUIRED: the merged-effective invariants (goal/tiers per D-9/#22, and the
 * per-harness model/effort pair per INV-104) can only be enforced against the
 * stored state, so making it optional would let a future writer call this +
 * `updateGlobalConfig` directly and silently bypass the fences. The effective
 * value is the patch's field when present, otherwise the stored one;
 * `qualityTiers` REPLACES wholesale exactly as the persist path merges it
 * (control-services updateSettings), so a patch clearing tiers ({}) is honored
 * here too.
 *
 * Returns the manifest effort facts it probed, so `commitSettingsUpdate` can
 * re-run the pair invariant under the lock without spawning the vendor CLIs twice.
 */
export async function assertSettingsPatchValid(
  p: ControlSettingsUpdateRequest,
  current: {
    goal: RoutingGoal;
    qualityTiers: QualityTierSet;
    harnesses: GlobalConfigT["harnesses"];
  },
  /** Admission notes the write must surface: models a truth source admitted
   * WITHOUT being able to verify them (INV-104). Appended, never thrown. */
  notes: string[] = [],
): Promise<PatchEffortCapabilities> {
  const realIds = new Set(buildRegistry({ includeFakes: false }).keys());
  const realList = [...realIds].sort().join(", ");
  const effortCapabilities = new Map<
    string,
    HarnessCapabilities | { effortParameter: string } | null
  >();
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
        const truth = await harnessModelTruth(route.harness, process.cwd(), true);
        const model = checkHarnessModelTruth(truth, route.model);
        if (model.status !== "ok")
          badRequest(model.message ?? `model '${route.model}' was refused`);
        if (model.unverified && model.message)
          notes.push(
            `quality tier route '${route.harness}/${route.model}' (truth source: ${truth.response.source}): ${model.message}`,
          );
        const adapter = buildRegistry().get(route.harness);
        const manifest = adapter?.effortParameter ? null : await adapter?.discover();
        // A tier names harness AND model, so hold it to what that MODEL
        // advertises rather than the harness-wide union. No merge is involved
        // here, unlike the per-harness pair below: a tier route is a COMPLETE
        // (harness, model, effort) triple and `qualityTiers` replaces wholesale,
        // so `route.model`/`route.effort` already ARE the effective pair.
        const advertised = manifest ? effortLevelsForModel(manifest.capabilities, route.model) : [];
        if (!adapter?.effortParameter && !advertised.includes(route.effort)) {
          badRequest(
            `quality tier route '${route.harness}/${route.model}' does not accept effort '${route.effort}'` +
              (advertised.length > 0 ? ` (advertised: ${advertised.join(", ")})` : ""),
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
      // One truth read per harness; each field is judged under the harness's
      // own absence declaration (INV-104). An advisory harness persists an
      // unlisted model and says so in the response notes instead of refusing.
      const truth = await harnessModelTruth(id, process.cwd(), true);
      for (const { field, value } of models) {
        const check = checkHarnessModelTruth(truth, value);
        if (check.status !== "ok") {
          badRequest(
            `harness '${id}' refused ${field} '${value}' (truth source: ${truth.response.source}): ${check.message}`,
          );
        }
        if (check.unverified && check.message)
          notes.push(
            `harness '${id}' ${field} '${value}' (truth source: ${truth.response.source}): ${check.message}`,
          );
      }
    }
    // Touching EITHER half of the (model, effort) pair puts the merged pair up for
    // validation, so this only resolves the manifest facts; the pair itself is
    // judged from the merged settings below. A patch that touches neither half is
    // left alone — see `assertHarnessEffortPairsValid`.
    if (patch.effort !== undefined || patch.defaultModel !== undefined) {
      const adapter = buildRegistry().get(id);
      try {
        effortCapabilities.set(
          id,
          adapter?.effortParameter
            ? { effortParameter: adapter.effortParameter }
            : adapter
              ? (await adapter.discover()).capabilities
              : null,
        );
      } catch (err) {
        // A harness whose manifest cannot be discovered (binary missing) still
        // 400s honestly rather than bubbling a raw error out of the endpoint.
        badRequest(
          `cannot verify effort for '${id}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  // Validate separate-knob support while preserving the original preference.
  if (effortCapabilities.size > 0) {
    assertHarnessEffortPairsValid(
      applyHarnessSettingsPatches(current.harnesses, p.harnesses),
      effortCapabilities,
    );
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
  return effortCapabilities;
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
    interaction_timeout_ms:
      p.interactionTimeoutMs === undefined ? cfg.interaction_timeout_ms : p.interactionTimeoutMs,
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
 * (harness ids, models — these never race) and a fast-fail, but EVERY
 * merged-effective invariant is RE-CHECKED against the EXACT merged config under
 * the lock, so an invalid final combination can never be persisted regardless of
 * interleaving. The per-harness (model, effort) pair is merged-effective too — a
 * racing writer can narrow `default_model` under an effort this one validated —
 * so it is re-checked here as well, from the manifest facts the pre-lock pass
 * already probed (no second vendor-CLI spawn under the lock).
 */
export async function commitSettingsUpdate(
  repoRoot: string,
  p: ControlSettingsUpdateRequest,
): Promise<string[]> {
  const currentGlobal = loadConfig(repoRoot).global;
  const notes: string[] = [];
  // Pre-lock: the patch-local truth (harness ids, models), the manifest effort
  // facts, and a fast-fail on the merged-effective invariants against the
  // current snapshot.
  const effortCapabilities = await assertSettingsPatchValid(
    p,
    {
      goal: currentGlobal.routing.goal,
      qualityTiers: currentGlobal.routing.quality_tiers,
      harnesses: currentGlobal.harnesses,
    },
    notes,
  );
  // Atomic write: the merge + the cross-field re-validation both run INSIDE the
  // config lock against the state actually being mutated. A racing writer that
  // committed between the pre-lock snapshot and here is seen by `cfg`, so a
  // final quality-with-zero-tiers combination (or a stranded harness
  // model/effort pair) throws here (before any bytes are written) instead of
  // silently persisting.
  updateGlobalConfig((cfg) => {
    const next = mergeSettingsPatch(cfg, p);
    assertRoutingGoalTiersConsistent(next.routing.goal, next.routing.quality_tiers);
    assertHarnessEffortPairsValid(next.harnesses, effortCapabilities);
    return next;
  });
  return notes;
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
        { status: 400, code: "invalid_request" },
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
      // The app's auto-switch control (INV-135, tri-state since A6:
      // auto | fail | rotate): only limit_action is patchable over the
      // wire; rotation order and headroom keep their stored values.
      profile_policy:
        patch.profileLimitAction === undefined
          ? base.profile_policy
          : { ...base.profile_policy, limit_action: patch.profileLimitAction },
    };
  }
  return next;
}

/** Bind both reads and post-write readback to the same daemon-lifetime snapshot. */
export function settingsControlServices(
  root: string,
  effective: RuntimeConcurrencyCaps | undefined,
  changed: () => void,
) {
  return {
    settings: async () => settingsSnapshot(root, effective),
    updateSettings: async (patch: unknown) => {
      const notes = await commitSettingsUpdate(
        root,
        ControlSettingsUpdateRequest.parse(patch ?? {}),
      );
      changed();
      // The write's admission notes ride the read-back once; a plain read
      // carries none (the snapshot schema defaults them to []).
      return { ...settingsSnapshot(root, effective), notes };
    },
  };
}
