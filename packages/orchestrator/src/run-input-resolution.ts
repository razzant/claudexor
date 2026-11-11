import type { EffortHint, ResolvedConfig, RoutingGoal } from "@claudexor/schema";
import { HarnessUnavailableError, chosenModel, type AdapterRegistry } from "@claudexor/core";
import { noProjectRepoRoot } from "@claudexor/util";
import type { RunInput } from "./orchestrator.js";

export interface RunInputResolutionDeps {
  config: ResolvedConfig;
  registryIds: Iterable<string>;
  /** The operator's own choice for an instance (#395), below a saved default. */
  instanceModel?: (harnessId: string) => string | null;
  routingGoal?: RoutingGoal;
}

/** What each registered instance's operator chose outside Settings, for this owner. */
export function registryInstanceModel(registry: AdapterRegistry) {
  return (harnessId: string) =>
    registry.get(harnessId)?.modelRequirement?.instanceChoice?.model ?? null;
}

/** The run's pool: the requested one (a thread turn arrives with its sticky
 * pool projected), else Settings `routing.eligible_harnesses`, else Auto. */
export function effectiveHarnessPool(
  requested: string[] | undefined,
  configuredPool: string[],
): string[] | undefined {
  return requested ?? (configuredPool.length > 0 ? configuredPool : undefined);
}

/** Resolve stable pool, primary, model, web, and routing defaults once per run. */
export function resolveRunInputDefaults(input: RunInput, deps: RunInputResolutionDeps): RunInput {
  if (
    input.contextMode === "off" &&
    !(input.mode === "ask" && input.repoRoot === noProjectRepoRoot())
  ) {
    throw new Error("contextMode 'off' is only supported for Ask without a repoRoot");
  }
  const cfg = deps.config;
  const harnesses = effectiveHarnessPool(input.harnesses, cfg.global.routing.eligible_harnesses);
  const explicitPrimary = input.primaryHarness;
  const configPrimary = cfg.global.routing.primary_harness;
  const primaryHarness =
    explicitPrimary ??
    (input.harnesses?.length === 1 ? input.harnesses[0] : undefined) ??
    configPrimary ??
    undefined;
  if (primaryHarness && harnesses?.length && !harnesses.includes(primaryHarness)) {
    if (explicitPrimary) {
      throw new Error(
        `primary harness '${explicitPrimary}' is not in the eligible harness pool (${harnesses.join(", ")}); ` +
          `pass --primary-harness as one of [${harnesses.join(", ")}], or add '${explicitPrimary}' to --harness`,
      );
    }
    throw new HarnessUnavailableError(
      `ambiguous primary harness: the configured default primary '${primaryHarness}' is not in the selected pool [${harnesses.join(", ")}], ` +
        `and no --primary-harness was given. Pin one explicitly, e.g. \`--primary-harness ${harnesses[0]}\` ` +
        `(or another of [${harnesses.join(", ")}]).`,
    );
  }
  if (input.web && input.externalContextPolicy && input.web !== input.externalContextPolicy) {
    throw new Error(
      `contradictory web policy: web='${input.web}' vs externalContextPolicy='${input.externalContextPolicy}' (pass one, or equal values)`,
    );
  }
  const web = input.web ?? input.externalContextPolicy ?? "auto";
  // Materialize this iterable exactly once: registry.keys() is repeatable, but
  // embedders are allowed to supply any Iterable. The same frozen universe is
  // also the lane snapshot for a pure Auto pool, whose eventual lanes are not
  // known until routing but whose Settings defaults must already be immutable.
  const knownHarnessIds = [...new Set(deps.registryIds)];
  const knownHarnessIdSet = new Set(knownHarnessIds);
  validateHarnessMap("models", input.models, knownHarnessIds, knownHarnessIdSet);
  validateHarnessMap("efforts", input.efforts, knownHarnessIds, knownHarnessIdSet);
  const snapshotLaneIds = harnesses ?? knownHarnessIds;
  // A blank model was never a choice: it falls through to the next one (#395).
  const models: Record<string, string> = Object.fromEntries(
    Object.entries(input.models ?? {}).filter(([, model]) => chosenModel(model)),
  );
  const scalarModel = chosenModel(input.model);
  if (scalarModel) {
    const scalarTarget = primaryHarness ?? (harnesses?.length === 1 ? harnesses[0] : undefined);
    if (!scalarTarget) {
      throw new Error(
        `a scalar model ('${scalarModel}') is ambiguous without a primary harness: ` +
          `the pool is ${harnesses?.length ? `[${harnesses.join(", ")}]` : "auto-resolved"} — ` +
          `set a primary harness, pass exactly one --harness, or use a harness-scoped model map`,
      );
    }
    models[scalarTarget] ??= scalarModel;
  }
  const harnessCfg = cfg.global.harnesses;
  for (const harnessId of snapshotLaneIds) {
    const defaultModel =
      chosenModel(harnessCfg[harnessId]?.default_model) ?? deps.instanceModel?.(harnessId);
    if (defaultModel) models[harnessId] ??= defaultModel;
  }
  const efforts: Record<string, EffortHint> = { ...input.efforts };
  for (const harnessId of snapshotLaneIds) {
    const effort = input.effort ?? harnessCfg[harnessId]?.effort;
    if (effort) efforts[harnessId] ??= effort;
  }
  return {
    ...input,
    continuation: input.continuation?.from
      ? {
          ...input.continuation,
          from: {
            ...input.continuation.from,
            inheritModel:
              input.continuation.from.inheritModel ??
              (input.model === undefined && input.models === undefined),
          },
        }
      : input.continuation,
    harnesses,
    primaryHarness,
    primaryHarnessExplicit: explicitPrimary !== undefined,
    model: undefined,
    models,
    effort: undefined,
    efforts,
    routingGoal:
      input.routingGoal ??
      deps.routingGoal ??
      cfg.project.budget?.routing_goal ??
      cfg.global.routing.goal ??
      "auto",
    web,
    externalContextPolicy: web,
  };
}

function validateHarnessMap(
  name: "models" | "efforts",
  values: Readonly<Record<string, unknown>> | undefined,
  knownHarnessIds: readonly string[],
  knownHarnessIdSet: ReadonlySet<string>,
): void {
  for (const key of Object.keys(values ?? {})) {
    if (knownHarnessIdSet.has(key)) continue;
    throw new Error(
      `${name} map names unknown harness '${key}' (registered: ${[...knownHarnessIds].sort().join(", ")}); ` +
        `run \`claudexor harness list --all\``,
    );
  }
}
