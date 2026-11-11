import type { HarnessProcessingSpec, PreparedHarnessProcessing } from "@claudexor/core";
import type { CredentialProfile, HarnessRunSpec } from "@claudexor/schema";

/**
 * Grok Build exposes no processing tiers, so a preference is reported
 * unavailable. A named grok.com login draws on the subscription's shared
 * weekly allowance (included), but the same pool can continue on purchased
 * Extra Usage Credits or Auto Top Up and no Grok transport reports that debit:
 * cash stays unknown, never an exact zero. `total_cost_usd` is not a receipt.
 */
export function prepareGrokProcessing(
  spec: Pick<HarnessProcessingSpec, "preference" | "model"> & {
    credentialProfile?: CredentialProfile | null;
  },
): PreparedHarnessProcessing {
  const subscription = spec.credentialProfile?.credential_kind === "config_dir_login";
  return {
    model: spec.model,
    receipt: {
      requested: spec.preference ?? null,
      submitted: null,
      submittedNative: null,
      observed: "unknown",
      observedNative: [],
      reason: spec.preference ? "processing_control_unavailable" : null,
      source: "grok_cli_has_no_processing_tiers",
    },
    costBasis: subscription
      ? {
          nativeMode: null,
          kind: "included",
          source: "grok_subscription_allowance",
          debit: "unobserved",
        }
      : { nativeMode: null, kind: "unknown", source: "grok_route_not_subscription" },
  };
}

/** A direct run prepares itself the same way the engine's gate would. */
export function applyGrokRunProcessing(spec: HarnessRunSpec): HarnessRunSpec {
  if (spec.processing && spec.processing_cost_basis) return spec;
  const prepared = prepareGrokProcessing({
    preference: spec.processing_preference,
    model: spec.model_hint,
    credentialProfile: spec.credential_profile,
  });
  return { ...spec, processing: prepared.receipt, processing_cost_basis: prepared.costBasis };
}
