import type { HarnessCapabilities, ModelInventoryAbsence } from "../schema/index.js";
import type { HarnessAdapter } from "./adapter.js";

/** A route-scoped producer is queried only for a known supported route.
 * Undeclared producers retain legacy behavior; failed producers never fall back. */
export function hasModelInventoryForRoute(
  adapter: Pick<HarnessAdapter, "models">,
  declaredRoutes: Readonly<HarnessCapabilities["model_inventory_routes"]>,
  route: "local_session" | "api_key" | null,
): adapter is Pick<HarnessAdapter, "models"> & Required<Pick<HarnessAdapter, "models">> {
  return (
    typeof adapter.models === "function" &&
    (declaredRoutes === undefined || (route !== null && declaredRoutes.includes(route)))
  );
}

/**
 * Validate a requested/configured model id against a harness's model truth
 * source — the model analog of the effort normalizer (`normalizeEffort`).
 * Data-driven: the caller supplies the truth list (live `models()` inventory
 * or manifest `known_models`) AND the harness's declaration of what an
 * absence from its lists proves (`model_inventory_absence`, INV-104). There
 * are no defaults: every caller states which list it holds and what that list
 * may refuse with, and no model id is ever hardcoded here.
 *
 * A list always proves PRESENCE. Where the harness declares absence
 * `authoritative` (the declaration a manifest gets when it says nothing), the
 * list is a complete enumeration and the strict rule holds:
 * - no model requested (null/empty) → ok (the harness default is used).
 * - truth list empty → rejected: the harness cannot verify models, so an
 *   EXPLICIT model is refused with actionable text instead of being forwarded
 *   to the vendor CLI to die as an opaque native error.
 * - requested ∈ list → ok.
 * - requested ∉ list → rejected, naming the truth source and the list.
 *
 * ADVISORY (owner-approved 2026-09-21 for a live producer, 2026-09-24 for the
 * harness as a whole): a miss and an empty list are both `ok` with an
 * `unverified` note. The gate decides nothing it cannot prove; the explicit
 * model travels to the vendor unchanged and the vendor accepts or refuses it.
 * The declaration belongs to the HARNESS, not to one of its lists: a manifest
 * hint list is one day's memory of the same vendor menu the live producer
 * reads, so it can refuse no more than that producer can. No other list is
 * consulted — nothing is ever substituted to admit a model.
 */
export type ModelCheckStatus = "ok" | "rejected";
export interface ModelCheck {
  status: ModelCheckStatus;
  message: string | null;
  /** True only on an `ok` the truth source could not actually verify: the
   * model was forwarded because absence was unprovable. Callers that can
   * disclose (the per-spawn gate, the settings response, readiness detail)
   * say so once; nothing depends on it to run. */
  unverified?: boolean;
}

/** Where the truth list came from; used to phrase actionable refusals. */
export type ModelTruthSource = "api" | "manifest";

/** The note a forwarded (unverifiable) model carries. One sentence, frozen:
 * what the list said, why it cannot refuse, and what happens instead. */
const UNPROVABLE_ABSENCE =
  "this harness's list cannot prove a model is absent, so the request is forwarded to the vendor";

export function validateModel(
  requested: string | null | undefined,
  known: readonly string[],
  source: ModelTruthSource,
  absence: ModelInventoryAbsence,
): ModelCheck {
  const model = typeof requested === "string" ? requested.trim() : "";
  if (!model) return { status: "ok", message: null };
  const advisory = absence === "advisory";
  if (known.length === 0) {
    if (advisory) {
      return {
        status: "ok",
        message: `${source === "api" ? "the harness returned no model list" : "the harness manifest lists no models"}; ${UNPROVABLE_ABSENCE}`,
        unverified: true,
      };
    }
    return {
      status: "rejected",
      message:
        `this harness cannot verify models (no ${source === "api" ? "live model inventory" : "manifest known_models"}); ` +
        (source === "api"
          ? "repair the live account/auth route or use the harness default (omit the model)"
          : "use the harness default (omit the model) or add known_models to the manifest"),
    };
  }
  if (known.includes(model)) return { status: "ok", message: null };
  if (advisory) {
    return {
      status: "ok",
      message: `model "${model}" is not in ${source === "api" ? "this account's listed models" : "this harness's manifest known-model list"}; ${UNPROVABLE_ABSENCE}`,
      unverified: true,
    };
  }
  const shown = known.slice(0, 80).join(", ");
  const suffix = known.length > 80 ? `, ... (${known.length} total)` : "";
  return {
    status: "rejected",
    message: `model "${model}" is not in the harness's ${source === "api" ? "live model inventory" : "manifest known-model list"} (${shown}${suffix})`,
  };
}
