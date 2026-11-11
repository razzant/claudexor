import type { HarnessEvent, ObservedModelCatalogMatch } from "@claudexor/schema";

export interface ObservedModelTelemetry {
  /** Model identity the harness stream actually reported (route evidence). */
  observedModel: string | null;
  /** Catalog proof of the SAME event that set observedModel; dropped once a later
   * event names another model or another native try begins (beginNativeRetry). */
  observedModelCatalogMatch?: ObservedModelCatalogMatch | null;
}

/** First-wins route evidence. The proof is read only from the event that set
 * observedModel, so a later try's proof can never fill an earlier try's label.
 * A later event that names another model leaves that proof unsupported. */
export function observeObservedModel(t: ObservedModelTelemetry, ev: HarnessEvent): void {
  if (!ev.observed_model) return;
  if (t.observedModel) {
    if (ev.observed_model !== t.observedModel) t.observedModelCatalogMatch = null;
    return;
  }
  t.observedModel = ev.observed_model;
  const match = ev.observed_model_catalog_match;
  t.observedModelCatalogMatch = match?.label === ev.observed_model ? match : null;
}
