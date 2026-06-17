/**
 * Validate a requested/configured model id against a harness's DECLARED known
 * models — the model analog of the effort normalizer (`normalizeEffort`).
 * Data-driven: the harness declares `known_models` + `models_authoritative`;
 * this never hardcodes a model list in logic.
 *
 * - no model requested (null/empty) → ok (the harness default is used).
 * - declared list empty → ok (the harness cannot vouch for a list; the vendor
 *   CLI is the authority — never block on a list we don't have).
 * - requested ∈ known_models → ok.
 * - requested ∉ known_models && authoritative → `rejected` (a hard, early error;
 *   the harness's list is exhaustive, e.g. an API `/v1/models` enumeration).
 * - requested ∉ known_models && !authoritative → `unknown` (a WARNING; passed
 *   through to the CLI, which is the final authority and may have gained the
 *   model after this known-good hint set was declared).
 */
export type ModelCheckStatus = "ok" | "unknown" | "rejected";
export interface ModelCheck {
  status: ModelCheckStatus;
  message: string | null;
}

export function validateModel(
  requested: string | null | undefined,
  known: readonly string[],
  authoritative: boolean,
): ModelCheck {
  const model = typeof requested === "string" ? requested.trim() : "";
  if (!model) return { status: "ok", message: null };
  if (known.length === 0) return { status: "ok", message: null };
  if (known.includes(model)) return { status: "ok", message: null };
  if (authoritative) {
    return { status: "rejected", message: `model "${model}" is not one this harness supports (known: ${known.join(", ")})` };
  }
  return {
    status: "unknown",
    message: `model "${model}" is not in the harness's known-good set (${known.join(", ")}); the vendor CLI is the authority — if a run fails to start, this is the likely cause`,
  };
}
