/**
 * Validate a requested/configured model id against a harness's model truth
 * source — the model analog of the effort normalizer (`normalizeEffort`).
 * Data-driven: the caller supplies the truth list (live `models()` inventory
 * or manifest `known_models`); this never hardcodes a model list in logic.
 *
 * STRICT semantics (locked owner decision, INV-104): there is no "warn and pass through".
 * - no model requested (null/empty) → ok (the harness default is used).
 * - truth list empty → rejected: the harness cannot verify models, so an
 *   EXPLICIT model is refused with actionable text instead of being forwarded
 *   to the vendor CLI to die as an opaque native error.
 * - requested ∈ list → ok.
 * - requested ∉ list → rejected, naming the truth source and the list.
 */
export type ModelCheckStatus = "ok" | "rejected";
export interface ModelCheck {
  status: ModelCheckStatus;
  message: string | null;
}

/** Where the truth list came from; used to phrase actionable refusals. */
export type ModelTruthSource = "api" | "manifest";

export function validateModel(
  requested: string | null | undefined,
  known: readonly string[],
  source: ModelTruthSource = "manifest",
): ModelCheck {
  const model = typeof requested === "string" ? requested.trim() : "";
  if (!model) return { status: "ok", message: null };
  if (known.length === 0) {
    return {
      status: "rejected",
      message:
        `this harness cannot verify models (no ${source === "api" ? "live model inventory" : "manifest known_models"}); ` +
        `use the harness default (omit the model) or add known_models to the manifest`,
    };
  }
  if (known.includes(model)) return { status: "ok", message: null };
  const shown = known.slice(0, 80).join(", ");
  const suffix = known.length > 80 ? `, ... (${known.length} total)` : "";
  return {
    status: "rejected",
    message: `model "${model}" is not in the harness's ${source === "api" ? "live model inventory" : "manifest known-model list"} (${shown}${suffix})`,
  };
}
