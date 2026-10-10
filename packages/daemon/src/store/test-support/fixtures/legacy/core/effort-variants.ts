import { EFFORT_PREFERENCE_ORDER, type EffortHint, type EffortResolution } from "../schema/index.js";
import { effortReceipt, resolveEffort } from "./effort.js";

/**
 * Effort as a MODEL-ID carrier (Cursor, Antigravity). These CLIs expose no
 * effort flag: the level is a token of a compound model id (`grok-4.7-xhigh`,
 * `gemini-3.8-flash-high`). "One effort word on every route" therefore means
 * choosing the LISTED sibling of the requested model's family (owner decision
 * 2026-10-05, «2. B»): the model id names the family, the effort names the
 * level, and the account's own model list decides what exists.
 *
 * Family = the id with exactly ONE shared-order level token removed. Every
 * other token (`fast`, `thinking`, `codex`, `mini`, `extra`, …) stays in the
 * key, so a level choice never crosses fast/standard or thinking/no-thinking
 * and `extra-high` is not a synonym of anything. A family exists only when THIS
 * account lists two or more levels under one key; a bare id (`grok-4.7`) is its
 * own key and selects a listed `grok-4.7-<level>` sibling. Rank is ONLY the
 * shared preference order: the vendor's model list is a menu, never a ladder,
 * and labels are never read. An id carrying two or more level tokens is
 * ambiguous and stays as it is.
 *
 * Nothing here refuses. A word outside the shared order, an id without a
 * family, an empty or unread account list, a missing model: each leaves the id
 * unchanged with an `omitted` receipt whose reason says why.
 *
 * ONE result: the preparation that returns this selection also puts `model`
 * into `ProcessingReceipt.submittedNative`, the id authority every transport
 * reads. The requested id is the caller's own model hint, so the effort receipt
 * carries no native-id fields of its own — `parameter: "--model"` names the
 * carrier and `submitted` is the level token.
 */

export interface EffortVariantFamily {
  /** The id with its single level token removed; the id itself when it carries none. */
  key: string;
  /** The level token the id carries; null for a bare id. */
  level: EffortHint | null;
}

/** `null` = ambiguous (two or more shared-order tokens): never guessed. */
export function effortVariantFamily(id: string): EffortVariantFamily | null {
  const tokens = id.split("-");
  const levelAt = tokens.flatMap((token, index) =>
    EFFORT_PREFERENCE_ORDER.includes(token) ? [index] : [],
  );
  if (levelAt.length > 1) return null;
  if (levelAt.length === 0) return { key: id, level: null };
  const index = levelAt[0]!;
  return { key: tokens.filter((_, i) => i !== index).join("-"), level: tokens[index]! };
}

export interface EffortVariantSelection {
  /** The id to submit: the listed family member the level chose, else the requested id unchanged. */
  model: string | null;
  /** The ONE effort receipt of this preparation (`parameter: "--model"`). */
  effort: EffortResolution;
}

const SHARED_ORDER_TEXT = EFFORT_PREFERENCE_ORDER.join(" < ");
const rank = (level: string): number => EFFORT_PREFERENCE_ORDER.indexOf(level);

/**
 * Listed families: key → level → the exact listed id. Only ids with exactly one
 * level token contribute; a key where one level maps to two different ids (the
 * token in two positions) is dropped instead of being guessed.
 */
function listedFamilies(catalog: readonly string[]): Map<string, Map<EffortHint, string>> {
  const families = new Map<string, Map<EffortHint, string>>();
  const ambiguous = new Set<string>();
  for (const id of new Set(catalog)) {
    const family = effortVariantFamily(id);
    if (!family || family.level === null) continue;
    const members = families.get(family.key) ?? new Map<EffortHint, string>();
    const existing = members.get(family.level);
    if (existing !== undefined && existing !== id) ambiguous.add(family.key);
    members.set(family.level, id);
    families.set(family.key, members);
  }
  for (const key of ambiguous) families.delete(key);
  return families;
}

/**
 * Select the listed variant of `model`'s family that `requested` places on the
 * shared preference order: the requested level when the account lists it, else
 * the strongest listed level not above it, else the weakest listed level.
 *
 * `catalog` is the model list of the exact account that will run; pass
 * `unavailable` to say why none was consulted (no pinned account, unread list)
 * — the id then stays unchanged and the receipt says so.
 */
export function selectEffortVariant(
  preference: string | null | undefined,
  model: string | null,
  catalog: readonly string[],
  unavailable?: string,
): EffortVariantSelection {
  const requested = preference?.trim() ? preference : null;
  const unchanged = (
    note: string | null,
    source: EffortResolution["source"] = "account_catalog",
  ): EffortVariantSelection => {
    const receipt = effortReceipt(
      { status: "ok", effort: null, clamped: false, ladder: [], placedBy: null },
      requested,
      source,
      "--model",
    );
    const reason = [receipt.reason, note].filter((part) => part).join("; ");
    return { model, effort: reason ? { ...receipt, reason } : receipt };
  };
  if (!requested) return unchanged(null, "adapter");
  if (!model)
    return unchanged(
      "no model was requested, so the effort has no family to select from",
      "adapter",
    );
  if (catalog.length === 0)
    return unchanged(
      `${unavailable ?? "the account listed no models"}; the requested model id is unchanged`,
      "adapter",
    );
  const family = effortVariantFamily(model);
  if (!family)
    return unchanged(
      `"${model}" carries more than one shared-order level token, so its family is ambiguous and the id is unchanged`,
    );
  const members = listedFamilies(catalog).get(family.key);
  if (!members || members.size < 2)
    return unchanged(
      `the account lists no second level for the family "${family.key}" of "${model}", so the id is unchanged`,
    );
  const levels = [...members.keys()].sort((a, b) => rank(a) - rank(b));
  const check = resolveEffort(requested, levels, { vendor: [], shared: EFFORT_PREFERENCE_ORDER });
  if (check.status !== "ok" || check.effort === null)
    return unchanged(`the id is unchanged (family "${family.key}" lists: ${levels.join(", ")})`);
  const selected = members.get(check.effort)!;
  const receipt = effortReceipt(check, requested, "account_catalog", "--model");
  return {
    model: selected,
    effort: {
      ...receipt,
      reason:
        `effort "${requested}" selected the listed variant "${selected}" of family "${family.key}" ` +
        `(listed levels: ${levels.join(", ")}; ranked by the shared preference order ${SHARED_ORDER_TEXT}, ` +
        `which claims no vendor support) for requested model "${model}"`,
    },
  };
}
