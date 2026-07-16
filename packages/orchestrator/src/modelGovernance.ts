/**
 * STRICT run-preflight model gate (INV-104): every route that resolved an
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
import { knownModelIdsForRoute, type KnownModelEntry } from "@claudexor/schema";

export interface ModelGovernedRoute {
  adapter: HarnessAdapter;
  /** Manifest model truth source (used when the adapter has no live models()). */
  knownModels: readonly KnownModelEntry[];
  /** Pre-spawn credential-route estimate: route-annotated manifest models are
   * filtered by it, and stay EXCLUDED when it is null (fail-closed — a
   * route-scoped model never passes the gate on an undecidable route). */
  authRouteEstimate: "local_session" | "api_key" | null;
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
      // Route-aware manifest truth (INV-104 x INV-061): route-annotated models
      // count only on their routes; an undecidable route excludes them.
      truth = {
        list: knownModelIdsForRoute(routed.knownModels, routed.authRouteEstimate),
        source: "manifest",
      };
    }
    for (const { role, model } of candidates) {
      const check = validateModel(model, truth.list, truth.source);
      if (check.status !== "ok") {
        throw new HarnessUnavailableError(
          `harness '${id}' refused ${role} '${model}' (truth source: ${truth.source}${truth.source === "manifest" ? `, route: ${routed.authRouteEstimate ?? "undecided"}` : ""}): ${check.message}; ` +
            `run \`claudexor models --harness ${id}\``,
        );
      }
    }
  }
}
