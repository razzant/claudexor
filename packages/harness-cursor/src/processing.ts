import { selectEffortVariant, type HarnessAdapter, type HarnessModelSpec } from "@claudexor/core";
import type { HarnessRunSpec, HarnessEvent } from "@claudexor/schema";
import type { CursorModelLister, CursorEnvMap } from "./models.js";
import type { CursorEventParser } from "./parse.js";
import type {
  HarnessModel,
  ProcessingCostBasis,
  ProcessingPreference,
  ProcessingReceipt,
} from "@claudexor/schema";

/** Only a pair actually listed by this account authorizes a same-effort variant. */
export function cursorProcessingModels(models: HarnessModel[]): HarnessModel[] {
  const ids = new Set(models.map((model) => model.id));
  return models.map((model) => {
    const standard = model.id.endsWith("-fast") ? model.id.slice(0, -5) : model.id;
    const fast = `${standard}-fast`;
    const paired = ids.has(standard) && ids.has(fast);
    if (!paired) return model;
    return {
      ...model,
      processing: {
        modes: ["standard", "fast"],
        nativeModes: [
          { mode: "standard", id: standard },
          { mode: "fast", id: fast },
        ],
        defaultNativeMode: model.id,
        eligible: null,
        source: "cursor_account_model_inventory",
        observedAt: null,
      },
    };
  });
}

/**
 * ONE prepared result for a Cursor route. The effort preference is applied
 * FIRST: it selects the listed level variant of the requested model's family
 * (`-fast`/`thinking` stay in the family key, so the level never switches
 * fast/standard). The existing fast/standard pair and the paid policy then run
 * on that selected id exactly as before. `model`, `receipt.submittedNative`
 * and the `--model` argument are the same value; `effort` is the receipt of the
 * level choice (`parameter: --model`).
 */
export function prepareCursorProcessing(
  preference: ProcessingPreference | undefined,
  requestedModel: string | null,
  models: HarnessModel[],
  allowPaid = true,
  effort: string | null = null,
) {
  const level = selectEffortVariant(
    effort,
    requestedModel,
    models.map((item) => item.id),
    "the account's `cursor-agent --list-models` answer was empty",
  );
  const model = level.model;
  const catalog = cursorProcessingModels(models);
  const entry = catalog.find((item) => item.id === model);
  // An existing explicit native Fast model remains deliberate native intent.
  const nativeFast = model?.endsWith("-fast") && entry;
  const desired = allowPaid && (nativeFast || preference === "fast") ? "fast" : "standard";
  const variant = entry?.processing?.nativeModes.find((item) => item.mode === desired)?.id;
  const selected = preference === undefined && allowPaid ? model : (variant ?? model);
  const receipt: ProcessingReceipt = {
    requested: preference ?? null,
    submitted: nativeFast && allowPaid ? "fast" : variant ? desired : null,
    submittedNative: selected,
    observed: "unknown",
    observedNative: [],
    reason:
      !allowPaid && (nativeFast || preference === "fast")
        ? variant
          ? "paid_processing_disallowed; ordinary_variant_selected"
          : "paid_processing_unconfirmed; selected_model_preserved"
        : nativeFast
          ? "native_explicit"
          : !variant
            ? "processing_variant_unconfirmed; selected_model_preserved"
            : preference === "economy"
              ? "economy_not_supported; ordinary_variant_selected"
              : null,
    source: "cursor_account_model_inventory",
  };
  const costBasis: ProcessingCostBasis = {
    nativeMode: selected,
    kind: "unknown",
    source: "cursor_cli_has_no_tier_billing_receipt",
  };
  return { model: selected, receipt, costBasis, effort: level.effort };
}

export async function applyCursorRunProcessing(
  spec: HarnessRunSpec,
  listModels: CursorModelLister,
  env: CursorEnvMap,
) {
  let processing = spec.processing;
  let nativeModel = processing?.submittedNative ?? spec.model_hint;
  if (
    !processing &&
    (spec.processing_preference || spec.effort_hint || spec.model_hint?.endsWith("-fast"))
  ) {
    const models = await listModels(env, spec.cwd);
    const prepared = prepareCursorProcessing(
      spec.processing_preference,
      spec.model_hint ?? null,
      models,
      spec.processing_allow_paid,
      spec.effort_hint,
    );
    processing = spec.processing_preference
      ? prepared.receipt
      : { ...prepared.receipt, requested: null };
    nativeModel = prepared.model;
    spec = {
      ...spec,
      processing,
      processing_cost_basis: prepared.costBasis,
    };
  }
  return { spec, nativeModel };
}
export function cursorProcessingParser(
  parser: CursorEventParser,
  spec: HarnessRunSpec,
): CursorEventParser {
  return (obj, sessionId): HarnessEvent[] | null => {
    const events = parser(obj, sessionId);
    if (spec.processing && events)
      for (const event of events) {
        event.processing = spec.processing;
        event.processing_cost_basis = spec.processing_cost_basis;
      }
    return events;
  };
}

export function cursorProcessingMethods(
  modelsFor: (spec?: HarnessModelSpec) => Promise<HarnessModel[]>,
): Pick<HarnessAdapter, "models" | "prepareProcessing"> {
  return {
    models: async (spec) => cursorProcessingModels(await modelsFor(spec)),
    prepareProcessing: async (spec) => {
      const models = await modelsFor(spec);
      return {
        ...prepareCursorProcessing(
          spec.preference,
          spec.model,
          models,
          spec.allowPaid,
          spec.effort,
        ),
        // init.model carries the display label of a row in this same read.
        catalog: models,
      };
    },
  };
}
