/**
 * STRICT run-preflight model gate (D3/INV-104): every route that resolved an
 * explicit model (per-run map or per-harness settings default) must pass its
 * harness's model truth source — the live `models()` inventory when the
 * adapter has one, else the manifest `known_models` list. A violation throws
 * a typed error BEFORE any vendor CLI spawns; the orchestrator surfaces it
 * through the routing-failure path, so failure.yaml names harness, model, and
 * truth source. Fallback models get the same gate: a downgrade target that
 * cannot run is a config bug better caught before the run than mid-run.
 */
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, validateModel } from "@claudexor/core";

export interface ModelGovernedRoute {
  adapter: HarnessAdapter;
  /** Manifest model truth source (used when the adapter has no live models()). */
  knownModels: readonly string[];
  settings: { defaultModel: string | null; fallbackModel: string | null } | null;
}

export async function assertRouteModelsAllowed(
  routes: readonly ModelGovernedRoute[],
  models: Record<string, string> | undefined,
  cwd: string,
): Promise<void> {
  const checked = new Set<string>();
  for (const routed of routes) {
    const id = routed.adapter.id;
    if (checked.has(id)) continue;
    checked.add(id);
    const resolved = models?.[id] ?? routed.settings?.defaultModel ?? null;
    const candidates = [
      { role: "model", model: resolved },
      { role: "fallback_model", model: routed.settings?.fallbackModel ?? null },
    ].filter((c): c is { role: string; model: string } => Boolean(c.model));
    if (candidates.length === 0) continue;
    let truth: { list: readonly string[]; source: "api" | "manifest" };
    if (typeof routed.adapter.models === "function") {
      const inventory = await routed.adapter.models({ cwd });
      truth = { list: inventory.map((m) => m.id), source: "api" };
    } else {
      truth = { list: routed.knownModels, source: "manifest" };
    }
    for (const { role, model } of candidates) {
      const check = validateModel(model, truth.list, truth.source);
      if (check.status !== "ok") {
        throw new HarnessUnavailableError(
          `harness '${id}' refused ${role} '${model}' (truth source: ${truth.source}): ${check.message}; ` +
            `run \`claudexor models --harness ${id}\``,
        );
      }
    }
  }
}
