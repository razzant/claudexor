import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  HarnessModel,
  ProcessingCapability,
  ProcessingCostBasis,
  ProcessingPreference,
  ProcessingReceipt,
} from "@claudexor/schema";

export function codexTierMode(tier: unknown): ProcessingPreference | null {
  if (tier === "priority" || tier === "fast" || tier === "ultrafast") return "fast";
  if (tier === "flex") return "economy";
  if (tier === "default" || tier === "standard") return "standard";
  return null;
}

/** Project only understood tiers from this account; never infer unlisted modes. */
export function codexProcessingCapability(
  value: Record<string, unknown>,
  source: string,
): ProcessingCapability {
  const tiers = value.service_tiers ?? value.serviceTiers;
  const legacy = value.additional_speed_tiers ?? value.additionalSpeedTiers;
  const nativeModes: ProcessingCapability["nativeModes"] = [];
  const advertised = Array.isArray(tiers) || Array.isArray(legacy);
  for (const raw of Array.isArray(tiers) ? tiers : []) {
    const id = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : null;
    const mode = codexTierMode(id);
    if (mode && typeof id === "string") nativeModes.push({ mode, id });
  }
  if (!Array.isArray(tiers) && Array.isArray(legacy) && legacy.includes("fast"))
    nativeModes.push({ mode: "fast", id: "priority" });
  const nativeDefault = value.default_service_tier ?? value.defaultServiceTier;
  return {
    modes: advertised
      ? [...new Set<ProcessingPreference>(["standard", ...nativeModes.map((entry) => entry.mode)])]
      : null,
    nativeModes,
    defaultNativeMode: typeof nativeDefault === "string" && nativeDefault ? nativeDefault : null,
    eligible: null,
    source,
    observedAt: null,
  };
}

/** Exact native options win; ordinary fallback never selects a premium tier. */
export function prepareCodexProcessing(
  preference: ProcessingPreference | undefined,
  capability?: ProcessingCapability,
  nativeOverride?: string,
  allowPaid = true,
  subscription: boolean | null = null,
): ProcessingReceipt | undefined {
  if (preference === undefined && nativeOverride === undefined && allowPaid) return undefined;
  const requestedTier =
    preference === "fast" ? "priority" : preference === "economy" ? "flex" : "default";
  const ordinaryFastOnly = allowPaid === false && subscription === true && preference === "fast";
  const listed = capability?.nativeModes.find(
    (entry) =>
      entry.mode === preference &&
      (!ordinaryFastOnly || entry.id === "fast" || entry.id === "priority"),
  )?.id;
  const fallback = preference !== "standard" && !listed;
  const selectedNative = nativeOverride ?? (listed || (fallback ? "default" : requestedTier));
  return codexProcessingForPaidPolicy(
    {
      requested: preference ?? null,
      submitted: codexTierMode(selectedNative),
      submittedNative: selectedNative,
      observed: "unknown",
      observedNative: [],
      reason:
        nativeOverride !== undefined
          ? "native_explicit"
          : fallback
            ? "requested_mode_not_advertised; ordinary_service_requested"
            : null,
      source: "codex.service_tier",
    },
    allowPaid,
    subscription,
  );
}

/** Only a mode-qualified included allowance can retain nonstandard service
 * under a no-paid policy. Account authentication is still checked by the route. */
export function codexProcessingForPaidPolicy(
  receipt: ProcessingReceipt,
  allowPaid: boolean | undefined,
  subscription: boolean | null,
): ProcessingReceipt {
  if (
    allowPaid !== false ||
    receipt.submitted === "standard" ||
    codexProcessingCost(receipt, subscription).kind === "included"
  )
    return receipt;
  return {
    ...receipt,
    submitted: "standard",
    submittedNative: "default",
    reason: "paid_processing_disallowed; ordinary_service_requested",
  };
}

export function observeCodexProcessing(
  receipt: ProcessingReceipt,
  tier: unknown,
): ProcessingReceipt {
  const observedNative = typeof tier === "string" && tier ? [tier] : [];
  return { ...receipt, observed: codexTierMode(tier) ?? "unknown", observedNative };
}

export function codexProcessingCost(
  receipt: ProcessingReceipt,
  subscription: boolean | null = null,
): ProcessingCostBasis {
  // Documented ordinary Fast consumes subscription limits. This prospective
  // allowance says nothing about observed execution or a cash/credit debit.
  // ultrafast and future native tiers deliberately remain unqualified.
  const included =
    subscription === true &&
    ["default", "standard", "fast", "priority"].includes(receipt.submittedNative ?? "");
  return {
    nativeMode: receipt.submittedNative,
    kind: subscription === false ? "cash" : included ? "included" : "unknown",
    source: included
      ? "codex_subscription_service_allowance"
      : "codex_service_tier_has_no_cash_receipt",
    // A ChatGPT plan may spend purchased credits beyond its included limits, for
    // Standard as well as Fast, and no Codex transport reports that debit.
    ...(subscription === true ? { debit: "unobserved" as const } : {}),
  };
}

/** Whether two native tiers are the same speed intent. `fast` and `priority` are
 * one ordinary Fast; Ultrafast and every other native tier match only themselves
 * (not by `codexTierMode`, which maps Ultrafast to the Fast mode too). */
export function sameCodexTierIntent(a: string | null, b: string | null): boolean {
  const ordinaryFast = (tier: string | null) => tier === "fast" || tier === "priority";
  return a === b || (ordinaryFast(a) && ordinaryFast(b));
}

/** Keep the intent this work unit chose without a preference. Another account's
 * native setting never replaces it; an unadvertised Fast/Economy intent falls
 * back to ordinary service with its reason. The paid policy still applies. */
export function retainCodexProcessing(
  chosen: ProcessingReceipt,
  capability?: ProcessingCapability,
): ProcessingReceipt {
  const mode =
    chosen.submitted === "fast" || chosen.submitted === "economy" ? chosen.submitted : null;
  const ordinary = mode === "fast" ? ["fast", "priority"] : ["flex"];
  const listed = mode
    ? (
        capability?.nativeModes.find(
          (entry) => entry.mode === mode && entry.id === chosen.submittedNative,
        ) ??
        capability?.nativeModes.find((entry) => entry.mode === mode && ordinary.includes(entry.id))
      )?.id
    : undefined;
  const native = listed ?? "default";
  return {
    requested: null,
    submitted: codexTierMode(native),
    submittedNative: native,
    observed: "unknown",
    observedNative: [],
    reason:
      mode && !listed
        ? "initial_processing_unavailable; ordinary_service_requested"
        : "initial_processing_retained",
    source: "codex.service_tier",
  };
}

/** Narrow read of the managed native root option. Other config shapes stay unknown. */
export function codexConfiguredTier(home: string | null | undefined): string | undefined {
  if (!home) return undefined;
  try {
    for (const raw of readFileSync(join(home, "config.toml"), "utf8").split("\n")) {
      const line = raw.trim();
      if (line.startsWith("[")) break;
      const match = line.match(/^service_tier\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
      if (match) return match[1].startsWith("'") ? match[1].slice(1, -1) : JSON.parse(match[1]);
    }
  } catch {
    /* missing or unfamiliar native config remains unknown */
  }
  return undefined;
}

export function legacyCodexProcessing(nativeTier?: string): ProcessingReceipt {
  return {
    requested: null,
    submitted: codexTierMode(nativeTier),
    submittedNative: nativeTier || null,
    observed: "unknown",
    observedNative: [],
    reason: nativeTier ? "native_explicit" : "native_default_unconfirmed",
    source: "codex.managed_config",
  };
}

export function readCodexProcessingModels(data: unknown[]) {
  const processing: Record<string, ProcessingCapability> = {};
  const nativeModels: HarnessModel[] = [];
  for (const raw of data) {
    const listed = raw as { id?: unknown };
    if (
      typeof listed.id === "string" &&
      raw &&
      typeof raw === "object" &&
      ("serviceTiers" in raw || "additionalSpeedTiers" in raw)
    )
      processing[listed.id] = codexProcessingCapability(raw, "codex.model/list");
    if (typeof listed.id === "string" && listed.id.trim()) {
      const label = (raw as { displayName?: unknown }).displayName;
      nativeModels.push({
        id: listed.id,
        label: typeof label === "string" ? label : null,
        context_window: null,
        routes: null,
        ...(processing[listed.id] ? { processing: processing[listed.id] } : {}),
      });
    }
  }
  return Object.keys(processing).length ? { processing, nativeModels } : {};
}
