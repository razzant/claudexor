import type { HarnessAdapter, HarnessModelSpec, HarnessProcessingSpec } from "@claudexor/core";
import type { HarnessCapabilities, HarnessRunSpec } from "@claudexor/schema";
import { canonicalCodexProfileHome } from "./profile.js";
import { defaultNativeCodexHome } from "./auth.js";
import {
  codexEffortsForEnv,
  type CodexEffortProbe,
  type CodexEffortCatalog,
} from "./effort-probe.js";
import {
  prepareCodexProcessing,
  codexProcessingCost,
  codexConfiguredTier,
  legacyCodexProcessing,
  codexProcessingForPaidPolicy,
  retainCodexProcessing,
  sameCodexTierIntent,
} from "./processing.js";
import { tomlBasicString } from "./toml.js";
type Env = Record<string, string | null | undefined>;

/**
 * The manifest declaration of what `models()` below covers and proves — kept
 * beside the producer so the two halves cannot drift apart (INV-104).
 *
 * `local_session`: the probe reads the selected account's own codex HOME, so an
 * API-key or unscoped query keeps manifest truth instead of borrowing a
 * subscription catalog. `advisory`: see the contract on `models()` — the vendor
 * CLI substitutes a bundled default list when its remote fetch times out and
 * nothing on the wire marks which list answered, so a model this list omits is
 * not evidence the account lacks it.
 */
export const CODEX_MODEL_INVENTORY = {
  model_inventory_routes: ["local_session"],
  model_inventory_absence: "advisory",
} as const satisfies Pick<
  HarnessCapabilities,
  "model_inventory_routes" | "model_inventory_absence"
>;
export function codexProcessingMethods(
  runtime: { probeEfforts: CodexEffortProbe; nowMs: () => number },
  envFor: (env?: Env, home?: string) => Env,
): Pick<HarnessAdapter, "models" | "prepareProcessing"> {
  return {
    /**
     * The account's live `model/list` answer. It proves PRESENCE and nothing
     * else, which is why the manifest declares this inventory `advisory`: the
     * vendor CLI substitutes a bundled default list when its own remote fetch
     * times out, and the wire says nothing about which list answered — the
     * envelope is `data` + `nextCursor`, the entries carry ids, efforts and
     * display metadata, and no field anywhere marks freshness or origin. A
     * previous-generation bundled list is therefore indistinguishable from a
     * current account list, so a model this answer omits may still be one the
     * account runs: observed live, the same accounts that were refused
     * `gpt-6-astra` served it in the same window.
     */
    async models(input?: HarnessModelSpec) {
      try {
        if (
          input?.credentialProfile
            ? input.credentialProfile.credential_kind !== "config_dir_login"
            : input?.authPreference === "api_key"
        )
          return [];
        const home = input?.credentialProfile
          ? canonicalCodexProfileHome(input.credentialProfile.isolation_locator ?? "")
          : defaultNativeCodexHome(input?.env);
        const result = await codexEffortsForEnv(runtime, envFor(input?.env, home));
        // A failure snapshot is not an account observation. Retain only the
        // selected account's last live model/list answer through its own cache.
        if (!result.live) return [];
        return (
          result.catalog.nativeModels ??
          Object.keys(result.catalog.models).map((id) => ({
            id,
            label: null,
            context_window: null,
            routes: null,
            ...(result.catalog.processing?.[id]
              ? { processing: result.catalog.processing[id] }
              : {}),
          }))
        );
      } catch {
        return [];
      }
    },
    async prepareProcessing(input: HarnessProcessingSpec) {
      const native = input.credentialProfile?.credential_kind === "config_dir_login";
      const home = native
        ? canonicalCodexProfileHome(input.credentialProfile!.isolation_locator ?? "")
        : undefined;
      const env = home ? envFor(input.env, home) : undefined;
      const subscription = native
        ? true
        : input.credentialProfile?.credential_kind === "api_key"
          ? false
          : null;
      const configured = input.preference
        ? undefined
        : codexProcessingForPaidPolicy(
            legacyCodexProcessing(codexConfiguredTier(home)),
            input.allowPaid,
            subscription,
          );
      // Initial inheritance comes from the first account; a later try keeps it.
      const retained =
        configured &&
        input.chosen &&
        !sameCodexTierIntent(input.chosen.submittedNative, configured.submittedNative)
          ? input.chosen
          : undefined;
      const catalog =
        native &&
        (input.preference || retained?.submitted === "fast" || retained?.submitted === "economy")
          ? (await codexEffortsForEnv(runtime, env)).catalog
          : undefined;
      const capability = catalog?.processing?.[input.model ?? catalog.defaultModel ?? ""];
      const selected = input.preference
        ? prepareCodexProcessing(
            input.preference,
            capability,
            undefined,
            input.allowPaid,
            subscription,
          )!
        : retained
          ? retainCodexProcessing(retained, capability)
          : // A tier the engine already chose keeps its own reason when this
            // account's setting resolves to the same tier.
            input.chosen?.source === "codex.service_tier" &&
              sameCodexTierIntent(input.chosen.submittedNative, configured!.submittedNative)
            ? { ...input.chosen, observed: "unknown" as const, observedNative: [] }
            : configured!;
      const receipt = codexProcessingForPaidPolicy(selected, input.allowPaid, subscription);
      return {
        model: input.model,
        receipt,
        costBasis: codexProcessingCost(receipt, subscription),
      };
    },
  };
}
export function codexProcessingArgs(
  spec: Pick<
    HarnessRunSpec,
    "model_hint" | "processing" | "processing_preference" | "processing_allow_paid"
  >,
  catalog?: CodexEffortCatalog,
): string[] {
  const processing =
    spec.processing ??
    prepareCodexProcessing(
      spec.processing_preference,
      catalog?.processing?.[spec.model_hint ?? catalog?.defaultModel ?? ""],
      undefined,
      spec.processing_allow_paid,
    );
  // A managed-config receipt lets Codex read its own setting; every tier the
  // engine chose, including a retained intent, is sent explicitly.
  return processing?.submittedNative &&
    (spec.processing_preference !== undefined ||
      processing.requested !== null ||
      processing.source === "codex.service_tier" ||
      spec.processing_allow_paid === false)
    ? ["-c", `service_tier=${tomlBasicString(processing.submittedNative)}`]
    : [];
}
export function applyCodexRunProcessing(
  spec: HarnessRunSpec,
  catalog: CodexEffortCatalog,
  home: string | null | undefined,
  subscription: boolean,
): HarnessRunSpec {
  const inheritedTier =
    spec.processing_preference === undefined ? codexConfiguredTier(home) : undefined;
  const processing =
    spec.processing ??
    (spec.processing_preference !== undefined || spec.processing_allow_paid === false
      ? prepareCodexProcessing(
          spec.processing_preference,
          catalog.processing?.[spec.model_hint ?? catalog.defaultModel ?? ""],
          inheritedTier,
          spec.processing_allow_paid,
          subscription,
        )
      : inheritedTier
        ? legacyCodexProcessing(inheritedTier)
        : undefined);
  if (processing) {
    const actual = codexProcessingForPaidPolicy(
      processing,
      spec.processing_allow_paid,
      subscription,
    );
    spec = {
      ...spec,
      processing: actual,
      processing_cost_basis: codexProcessingCost(actual, subscription),
    };
  }
  return spec;
}
