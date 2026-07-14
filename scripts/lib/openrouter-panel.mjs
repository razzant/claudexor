/** Exact route-proof helper shared by the release triad and its tests. */
export function exactObservedModelMatch(requestedModel, observedModel) {
  return (
    typeof requestedModel === "string" &&
    requestedModel.trim().length > 0 &&
    typeof observedModel === "string" &&
    observedModel.trim().length > 0 &&
    observedModel === requestedModel
  );
}
