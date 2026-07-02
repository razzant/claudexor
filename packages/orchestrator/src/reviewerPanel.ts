/**
 * Explicit reviewer-panel resolution (owner-configured panels). Every entry
 * must pass the SAME gates auto-selection uses — registered real harness,
 * enabled in settings, doctor-ok on the review route, readonly-review
 * capable — plus the STRICT model truth gate (D3/INV-104: live inventory
 * when the adapter has `models()`, else manifest `known_models`; empty truth
 * refuses) and the declared effort ladder. Violations throw typed
 * HarnessUnavailableError; the orchestrator turns them into review_preflight
 * failure ARTIFACTS after run-dir creation, before candidates spend money.
 */
import type { AuthPreference, ControlReviewerPanelEntry, Intent } from "@claudexor/schema";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, validateModel } from "@claudexor/core";
import { WorkspaceManager } from "@claudexor/workspace";
import type { ReviewerSpec } from "@claudexor/review";

const MODEL_INVENTORY_RETRY_DELAY_MS = 250;

interface PanelHarnessSettings {
  enabled?: boolean;
  default_model?: string | null;
}

export interface ReviewerPanelDeps {
  cwd: string;
  registry: Map<string, HarnessAdapter>;
  harnessSettings: Record<string, PanelHarnessSettings | undefined>;
  authPreferenceFor: (harnessId: string) => AuthPreference;
}

export async function resolveExplicitReviewerPanel(
  deps: ReviewerPanelDeps,
  panel: ControlReviewerPanelEntry[],
): Promise<ReviewerSpec[]> {
  const { cwd, registry, harnessSettings } = deps;
  const known = [...registry.keys()].sort().join(", ");
  const modelInventory = new Map<string, Set<string>>();
  const statusByRoute = new Map<
    string,
    {
      manifest: Awaited<ReturnType<HarnessAdapter["discover"]>> | null;
      status: "ok" | "degraded" | "unavailable";
      enabledIntents: Intent[];
      reasons: string[];
    }
  >();
  const specs: ReviewerSpec[] = [];
  const reviewModelHome: {
    current: { env: Record<string, string>; dispose: () => void } | null;
  } = { current: null };
  try {
    const reviewModelEnv = (): Record<string, string> => {
      reviewModelHome.current ??= new WorkspaceManager(cwd).readOnlyHomeEnv();
      return reviewModelHome.current.env;
    };
    for (const entry of panel) {
      const adapter = registry.get(entry.harness);
      if (!adapter) {
        throw new HarnessUnavailableError(
          `unknown reviewer harness '${entry.harness}' (registered: ${known}); run \`claudexor harness list --all\``,
        );
      }
      if (harnessSettings[entry.harness]?.enabled === false) {
        throw new HarnessUnavailableError(
          `reviewer harness '${entry.harness}' is disabled in settings (harnesses.${entry.harness}.enabled=false)`,
        );
      }
      const authPreference = deps.authPreferenceFor(entry.harness);
      const routeKey = `${entry.harness}\0${authPreference}`;
      if (!statusByRoute.has(routeKey)) {
        let manifest: Awaited<ReturnType<HarnessAdapter["discover"]>> | null = null;
        try {
          manifest = await adapter.discover();
        } catch {
          manifest = null;
        }
        try {
          const report = await adapter.doctor({ cwd, env: reviewModelEnv(), authPreference });
          statusByRoute.set(routeKey, {
            manifest,
            status: report.status,
            enabledIntents: report.enabled_intents,
            reasons: report.reasons ?? [],
          });
        } catch (err) {
          statusByRoute.set(routeKey, {
            manifest,
            status: "unavailable",
            enabledIntents: [],
            reasons: [err instanceof Error ? err.message : String(err)],
          });
        }
      }
      const status = statusByRoute.get(routeKey);
      const manifest = status?.manifest;
      if (!status || !manifest) {
        throw new HarnessUnavailableError(`reviewer harness '${entry.harness}' is unavailable`);
      }
      if (manifest.kind === "fake") {
        throw new HarnessUnavailableError(
          `reviewer harness '${entry.harness}' is a fake harness and cannot be used in reviewer panels`,
        );
      }
      if (status.status !== "ok") {
        const reason = status.reasons.length > 0 ? `: ${status.reasons.join("; ")}` : "";
        throw new HarnessUnavailableError(
          `reviewer harness '${entry.harness}' is not doctor-ok${reason}`,
        );
      }
      if (
        !status.enabledIntents.includes("review") ||
        !manifest.capabilities.review ||
        !manifest.access_profiles_supported.includes("readonly")
      ) {
        throw new HarnessUnavailableError(
          `reviewer harness '${entry.harness}' cannot perform readonly review`,
        );
      }
      const requestedModel = entry.model ?? harnessSettings[entry.harness]?.default_model ?? null;
      if (requestedModel) {
        if (typeof adapter.models !== "function") {
          // STRICT (D3): the manifest list is the truth source here; an empty
          // list means the harness cannot verify models and the explicit
          // model is refused (validateModel phrases both refusals).
          const check = validateModel(
            requestedModel,
            manifest.capabilities.known_models,
            "manifest",
          );
          if (check.status !== "ok") {
            throw new HarnessUnavailableError(
              `reviewer harness '${entry.harness}' refused requested model '${requestedModel}': ${check.message}; run \`claudexor models --harness ${entry.harness}\``,
            );
          }
        } else {
          const inventoryKey = `${entry.harness}\0${authPreference}`;
          if (!modelInventory.has(inventoryKey)) {
            modelInventory.set(
              inventoryKey,
              await listModelIdsWithRetry(adapter.models.bind(adapter), {
                cwd,
                authPreference,
                env: reviewModelEnv,
                harnessId: entry.harness,
                requestedModel,
              }),
            );
          }
          const models = modelInventory.get(inventoryKey);
          if (models && !models.has(requestedModel)) {
            const available = [...models].slice(0, 80).join(", ");
            const suffix = models.size > 80 ? `, ... (${models.size} total)` : "";
            throw new HarnessUnavailableError(
              `reviewer harness '${entry.harness}' does not support requested model '${requestedModel}' on the review route (available: ${available}${suffix}); run \`claudexor models --harness ${entry.harness}\``,
            );
          }
        }
      }
      const requestedEffort = entry.effort ?? null;
      if (requestedEffort && !manifest.capabilities.effort_levels.includes(requestedEffort)) {
        const supported = manifest.capabilities.effort_levels.join(", ");
        const suffix = supported ? ` (supported: ${supported})` : " (harness declares no effort controls)";
        throw new HarnessUnavailableError(
          `reviewer harness '${entry.harness}' does not support requested effort '${requestedEffort}'${suffix}`,
        );
      }
      specs.push({
        adapter,
        providerFamily: manifest.provider_family,
        requestedModel,
        requestedEffort,
        authPreference,
      });
    }
  } finally {
    reviewModelHome.current?.dispose();
  }
  return specs;
}

/** One retry with a short delay: transient inventory hiccups (cold auth,
 * slow first call) must not fail a panel that would succeed a moment later —
 * but a persistently empty/erroring inventory still refuses loudly. */
async function listModelIdsWithRetry(
  listModels: NonNullable<HarnessAdapter["models"]>,
  input: {
    cwd: string;
    authPreference: AuthPreference;
    env: () => Record<string, string>;
    harnessId: string;
    requestedModel: string;
  },
): Promise<Set<string>> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const models = await listModels({
        cwd: input.cwd,
        env: input.env(),
        authPreference: input.authPreference,
      });
      if (models.length === 0) {
        throw new Error("model inventory was empty");
      }
      return new Set(models.map((m) => m.id));
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, MODEL_INVENTORY_RETRY_DELAY_MS));
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
  throw new HarnessUnavailableError(
    `reviewer harness '${input.harnessId}' could not verify requested model '${input.requestedModel}' because its model inventory call failed after retry: ${detail}; run \`claudexor models --harness ${input.harnessId}\``,
  );
}
