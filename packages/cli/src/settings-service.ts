/**
 * Settings-write validation + patch merge — the daemon's POST /settings core.
 *
 * STRICT (D3/INV-104 + T1#26): persisted routing ids must be REAL registered
 * harnesses (fakes are test fixtures, never persistable routing targets),
 * model values must pass the harness's model truth source, and effort must be
 * on the declared ladder. All violations are 400s naming the harness, the
 * value, and the truth source — a bad value must never be persisted to die
 * later as an opaque native error.
 */
import type { ControlSettingsUpdateRequest, GlobalConfig as GlobalConfigT } from "@claudexor/schema";
import { GlobalConfig } from "@claudexor/schema";
import { validateModel } from "@claudexor/core";
import { buildRegistry, harnessModels } from "./registry.js";

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
  for (const [id, patch] of Object.entries(p.harnesses ?? {})) {
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
      const ladder = adapter ? (await adapter.discover()).capabilities.effort_levels : [];
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
  // silently persisted as a new config entry nothing will ever read.
  const knownIds = new Set(buildRegistry().keys());
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
      default_model: patch.defaultModel === undefined ? base.default_model : patch.defaultModel,
      effort: patch.effort === undefined ? base.effort : patch.effort,
      max_turns: patch.maxTurns === undefined ? base.max_turns : patch.maxTurns,
      max_rounds: patch.maxRounds === undefined ? base.max_rounds : patch.maxRounds,
      max_usd: patch.maxUsd === undefined ? base.max_usd : patch.maxUsd,
      tools_allow: patch.toolsAllow ?? base.tools_allow,
      tools_deny: patch.toolsDeny ?? base.tools_deny,
      fallback_model: patch.fallbackModel === undefined ? base.fallback_model : patch.fallbackModel,
      web: patch.web ?? base.web,
      auth_preference: patch.authPreference ?? base.auth_preference,
    };
  }
  return next;
}
