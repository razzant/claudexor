import type { HarnessProcessingSpec } from "@claudexor/core";
import { canonicalProfileConfigDir } from "./profile.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  HarnessRunSpec,
  HarnessEvent,
  ProcessingCostBasis,
  ProcessingPreference,
  ProcessingReceipt,
  UsageCostBasis,
} from "@claudexor/schema";

/** --settings opts in without /fast's model switch. The CLI checks eligibility. */
export function prepareClaudeProcessing(
  preference?: ProcessingPreference,
  inheritedFast?: boolean,
  allowPaid = true,
): ProcessingReceipt {
  if (preference === undefined && allowPaid)
    return {
      requested: null,
      submitted: inheritedFast === true ? "fast" : inheritedFast === false ? "standard" : null,
      submittedNative: inheritedFast === undefined ? null : `fastMode=${inheritedFast}`,
      observed: "unknown",
      observedNative: [],
      reason: inheritedFast !== undefined ? "native_explicit" : "native_default_unconfirmed",
      source: "claude.managed_settings",
    };
  const fast = preference === "fast" && allowPaid;
  return {
    requested: preference ?? null,
    submitted: fast ? "fast" : "standard",
    submittedNative: `fastMode=${fast}`,
    observed: "unknown",
    observedNative: [],
    reason:
      !allowPaid && (preference === "fast" || inheritedFast)
        ? "paid_processing_disallowed; ordinary_service_requested"
        : preference === "economy" || preference === "ultrafast"
          ? `${preference}_not_supported; ordinary_service_requested`
          : fast
            ? "native_model_and_account_eligibility_unconfirmed"
            : null,
    source: "claude.settings.fastMode",
  };
}

export function claudeProcessingCost(
  receipt: ProcessingReceipt,
  subscription: boolean | null,
): ProcessingCostBasis {
  return {
    nativeMode: receipt.submittedNative,
    kind:
      subscription === false
        ? "cash"
        : subscription === true && receipt.submitted === "fast"
          ? "paid_credits"
          : subscription === true && receipt.submitted === "standard"
            ? "included"
            : "unknown",
    source: "claude_fast_usage_credits; ordinary_subscription_receipts_remain_separate",
  };
}

/** Native totals keep only the last speed; aggregate per-message observations. */
export function claudeProcessingObserver(initial: ProcessingReceipt, basis: ProcessingCostBasis) {
  let receipt = initial;
  const messages = new Map<string, string | null>();
  const active = new Map<string | null, string>();
  return (obj: any, events: HarnessEvent[] | null, sessionId: string): HarnessEvent[] | null => {
    const message =
      obj?.type === "assistant"
        ? obj.message
        : obj?.type === "stream_event" && obj.event?.type === "message_start"
          ? obj.event.message
          : null;
    if (message && typeof message.id === "string" && message.model !== "<synthetic>") {
      const speed = typeof message.usage?.speed === "string" ? message.usage.speed : null;
      if (obj?.type === "stream_event") active.set(obj.parent_tool_use_id ?? null, message.id);
      // A later complete frame can enrich a partial frame, but never erase it.
      if (!messages.has(message.id) || speed !== null) messages.set(message.id, speed);
    }
    if (obj?.type === "stream_event" && obj.event?.type === "message_delta") {
      const id = active.get(obj.parent_tool_use_id ?? null);
      const speed = obj.event.usage?.speed;
      if (id && typeof speed === "string") messages.set(id, speed);
    }
    const speeds = [
      ...new Set([...messages.values()].filter((speed): speed is string => speed !== null)),
    ];
    const known = speeds.filter((speed) => speed === "fast" || speed === "standard");
    receipt = {
      ...receipt,
      observedNative: speeds,
      observed:
        known.length > 1
          ? "mixed"
          : messages.size > 0 && [...messages.values()].every((speed) => speed === known[0])
            ? (known[0] as "fast" | "standard")
            : "unknown",
    };
    const disabled = obj?.fast_mode_disabled_reason;
    if (typeof disabled === "string")
      receipt = { ...receipt, reason: `native_fast_mode_disabled:${disabled}` };
    const notification =
      obj?.type === "system" &&
      obj.subtype === "notification" &&
      obj.key === "fast-mode-overage-rejected";
    const out = events ?? (notification ? [] : null);
    if (notification && out)
      out.push({
        type: "status",
        session_id: sessionId,
        ts: new Date().toISOString(),
        text: String(obj.text ?? "Fast mode fallback"),
        payload: { native_notification: obj.key },
      });
    if (out)
      for (const event of out) {
        event.processing = { ...receipt, observedNative: [...receipt.observedNative] };
        // A terminal aggregate may combine paid and ordinary sends. The
        // configuration's prospective billing class is not an amount receipt.
        const observedBasis =
          receipt.observed === "mixed" ||
          (receipt.observed === "unknown" &&
            !(basis.kind === "included" && receipt.submitted === "standard")) ||
          (receipt.observed === "fast" && basis.kind === "included")
            ? { ...basis, kind: "unknown" as const }
            : receipt.observed === "standard" && basis.kind === "paid_credits"
              ? {
                  ...basis,
                  kind: "included" as const,
                  nativeMode: "fastMode=false",
                  source: "claude_observed_ordinary_subscription_service",
                }
              : basis;
        event.processing_cost_basis = event.type === "usage" ? observedBasis : basis;
        if (event.type === "usage" && event.usage?.cost_usd !== undefined) {
          const rows =
            obj?.modelUsage && typeof obj.modelUsage === "object"
              ? Object.values(obj.modelUsage)
              : [];
          const list = rows.length > 0 && rows.every((entry: any) => entry?.costBasis === "list");
          const cost_basis: UsageCostBasis = {
            kind: list ? "valuation" : "unknown",
            source: list
              ? "claude.modelUsage.costBasis=list"
              : "claude.total_cost_usd_without_amount_basis",
          };
          Object.assign(event.usage, { cost_basis });
          if (list) event.usage.estimated = true;
        }
        if (typeof obj?.fast_mode_state === "string")
          event.payload = { ...event.payload, native_fast_mode_state: obj.fast_mode_state };
      }
    return out;
  };
}

/** Never inspect an ambient user store; caller binds the managed profile path. */
export function claudeConfiguredFast(configDir: string | null | undefined): boolean | undefined {
  if (!configDir) return undefined;
  try {
    const value = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
    return typeof value.fastMode === "boolean" ? value.fastMode : undefined;
  } catch {
    return undefined;
  }
}

export async function prepareClaudeSessionProcessing(input: HarnessProcessingSpec) {
  const configDir =
    input.credentialProfile?.credential_kind === "config_dir_login"
      ? canonicalProfileConfigDir(input.credentialProfile.isolation_locator ?? "")
      : undefined;
  const receipt = prepareClaudeProcessing(
    input.preference,
    claudeConfiguredFast(configDir),
    input.allowPaid,
  );
  const subscription = input.credentialProfile
    ? input.credentialProfile.credential_kind !== "api_key"
    : input.authPreference === "subscription"
      ? true
      : input.authPreference === "api_key"
        ? false
        : null;
  return {
    model: input.model,
    receipt,
    costBasis: claudeProcessingCost(receipt, subscription),
  };
}
export function claudeProcessingArgs(spec: HarnessRunSpec): string[] {
  const args: string[] = [];
  const processing =
    spec.processing ??
    (spec.processing_preference !== undefined || spec.processing_allow_paid === false
      ? prepareClaudeProcessing(spec.processing_preference, undefined, spec.processing_allow_paid)
      : undefined);
  if (
    (spec.processing_preference !== undefined ||
      processing?.requested != null ||
      spec.processing_allow_paid === false) &&
    (processing?.submittedNative === "fastMode=true" ||
      processing?.submittedNative === "fastMode=false")
  )
    args.push(
      "--settings",
      JSON.stringify({ fastMode: processing.submittedNative === "fastMode=true" }),
    );
  return args;
}
export function applyClaudeRunProcessing(
  spec: HarnessRunSpec,
  configDir: string | null | undefined,
  subscription: boolean,
): HarnessRunSpec {
  const inheritedFast =
    spec.processing_preference === undefined ? claudeConfiguredFast(configDir) : undefined;
  const processing =
    spec.processing ??
    (spec.processing_preference !== undefined || spec.processing_allow_paid === false
      ? prepareClaudeProcessing(spec.processing_preference, undefined, spec.processing_allow_paid)
      : inheritedFast === true
        ? prepareClaudeProcessing(undefined, true)
        : undefined);
  if (processing)
    spec = {
      ...spec,
      processing,
      processing_cost_basis:
        spec.processing_cost_basis ?? claudeProcessingCost(processing, subscription),
    };
  return spec;
}
