import { EffortPreferenceRejectedError } from "./errors.js";
import {
  EFFORT_PREFERENCE_ORDER,
  mergeEffortLadders,
  type EffortHint,
  type EffortResolution,
  type HarnessRunSpec,
} from "../schema/index.js";

/**
 * Effort resolution against VENDOR-ordered ladders. A level's rank is its
 * position in the ladder the vendor itself advertised (a model's own ordered
 * list, or the harness's merged ladder — `mergeEffortLadders` in the schema
 * package). Only when the vendor ladder does not list the requested word at all
 * does the resolver consult the shared preference order
 * (`EFFORT_PREFERENCE_ORDER`), and then only to PLACE the word onto a level the
 * route really advertises; the receipt names that placement. Ranking is NOT
 * permission: what a run may actually use is whatever the resolved (harness,
 * model) ADVERTISES, so a level newer than this repo passes through untouched
 * the moment the vendor ships it.
 */

/**
 * Outcome of resolving a requested effort against an advertised vocabulary.
 * The ONE result every consumer of a route reads: the arg builder takes
 * `effort`, the receipt derives `downward`/`floor` from `ladder` — the order the
 * level was actually chosen by — and the disclosure names `placedBy`. `rejected`
 * carries actionable text naming what IS advertised — an unknown level is never
 * silently downgraded into something we merely guessed at.
 */
export type EffortCheck =
  | {
      status: "ok";
      effort: EffortHint | null;
      clamped: boolean;
      /** The rank order the level was chosen by; `advertised` itself when nothing was clamped. */
      ladder: readonly EffortHint[];
      /** Which order placed a clamped request; null for exact, omitted or unrequested. */
      placedBy: "vendor" | "shared" | null;
    }
  | { status: "rejected"; message: string };

/** Only a vendor-proven total order may drive substitutions. The display merge
 * breaks ties between disconnected/branching chains; those ties are not ranks.
 * Exact membership remains usable even when ordering cannot be established. */
export function effortRankLadder(
  lists: ReadonlyArray<readonly EffortHint[]>,
): readonly EffortHint[] {
  const merged = mergeEffortLadders(lists);
  if (!merged.consistent) return [];
  const { order } = merged;
  return order.every(
    (level, index) =>
      index === 0 ||
      lists.some((list) => {
        const before = list.indexOf(order[index - 1]!);
        return before >= 0 && list[before + 1] === level;
      }),
  )
    ? order
    : [];
}

/**
 * The two rank orders one route may clamp along, both derived from the vendor's
 * RAW ordered lists. `vendor` is the route's own merged order and is tried
 * first. `shared` merges the comparable words of the SAME raw lists with
 * `EFFORT_PREFERENCE_ORDER`, only for a word the vendor order does not list.
 * Extra vendor words do not disable that placement. Using raw lists (never an
 * already-collapsed `vendor`) preserves contradictions between comparable
 * words: the fallback cannot invent a rank the vendor disputes.
 */
export interface EffortLadders {
  vendor: readonly EffortHint[];
  shared: readonly EffortHint[];
}

export function effortLadders(lists: ReadonlyArray<readonly EffortHint[]>): EffortLadders {
  return {
    vendor: effortRankLadder(lists),
    shared: effortRankLadder([
      ...lists.map((list) => list.filter((level) => EFFORT_PREFERENCE_ORDER.includes(level))),
      EFFORT_PREFERENCE_ORDER,
    ]),
  };
}

/** A bare ladder is the degenerate vendor-only case: no shared fallback. */
export type EffortLadderInput = readonly EffortHint[] | EffortLadders;

function laddersOf(input: EffortLadderInput): EffortLadders {
  return Array.isArray(input)
    ? { vendor: input as readonly EffortHint[], shared: [] }
    : (input as EffortLadders);
}

/**
 * Where `requested` lands on ONE rank order: the strongest advertised level not
 * above it, else the known minimum. `null` when this order cannot place the
 * request (the caller tries the next order); a typed rejection when the order
 * places the request below every advertised level but cannot rank them all.
 */
function placeOnLadder(
  requested: EffortHint,
  advertised: readonly EffortHint[],
  ladder: readonly EffortHint[],
): EffortHint | Extract<EffortCheck, { status: "rejected" }> | null {
  const want = ladder.indexOf(requested);
  // Only levels the ladder places can host a clamp; a level outside the ladder
  // is a valid TARGET only through the exact-match branch of `resolveEffort`.
  const rankable = advertised.filter((level) => ladder.indexOf(level) >= 0);
  if (want < 0 || rankable.length === 0) return null;
  const ordered = [...rankable].sort((a, b) => ladder.indexOf(a) - ladder.indexOf(b));
  const lower = ordered.filter((level) => ladder.indexOf(level) <= want).at(-1);
  if (!lower && rankable.length !== advertised.length)
    return {
      status: "rejected",
      message: "The advertised minimum effort cannot be established from the vendor order.",
    };
  return lower ?? ordered[0]!;
}

/**
 * Resolve a requested reasoning-effort level against the levels a specific
 * (harness, model) advertises. THE single owner of effort semantics; every
 * surface (adapters, settings writes, preflight) resolves through it.
 *
 * `advertised` is what the resolved target accepts (the model's own ordered
 * list, or the harness ladder when the model recorded none). `ladder` is the
 * rank authority for clamping — normally `effortLadders(rawVendorLists)`, whose
 * `vendor` order lets a level one sibling model advertises clamp onto what THIS
 * model accepts (`ultra` on gpt-5.4 → `xhigh`, because the merged codex ladder
 * places `ultra` above it) and whose `shared` order places a word no vendor list
 * carries (`ultra` on a `max`-capped Claude → `max`; `none` → the known minimum).
 * A bare array is the degenerate vendor-only case (nothing beyond the target's
 * own order is known; no shared fallback), and it defaults to `advertised`.
 *
 * - nothing requested → ok, no effort (pass no flag).
 * - `advertised` empty → ok, no effort: effort is not a tunable surface here, so
 *   the caller discloses it as ignored (INV-105) instead of clamping to a guess.
 * - requested IS advertised → PASS THROUGH VERBATIM. This is what makes a
 *   future vendor level work with no Claudexor change.
 * - requested is not advertised but the VENDOR order places it → the strongest
 *   advertised level not above the request; if every supported level exceeds
 *   the request, the known minimum (reasoning cannot be disabled there).
 * - the vendor order does not list it but the SHARED order does → the same
 *   choice along the shared order, flagged `placedBy: "shared"`.
 * - neither order places it → REJECT, naming the advertised set. We cannot place
 *   it, so any "nearest" would be invented.
 */
export function resolveEffort(
  requested: EffortHint | null | undefined,
  advertised: readonly EffortHint[],
  ladder: EffortLadderInput = advertised,
): EffortCheck {
  const verbatim = (effort: EffortHint | null): EffortCheck => ({
    status: "ok",
    effort,
    clamped: false,
    ladder: advertised,
    placedBy: null,
  });
  if (requested === null || requested === undefined) return verbatim(null);
  if (advertised.length === 0) return verbatim(null);
  if (advertised.includes(requested)) return verbatim(requested);

  const ladders = laddersOf(ladder);
  const orders = [
    ["vendor", ladders.vendor],
    ["shared", ladders.shared],
  ] as const;
  for (const [placedBy, order] of orders) {
    const comparable =
      placedBy === "shared" ? advertised.filter((level) => order.includes(level)) : advertised;
    const placed = placeOnLadder(requested, comparable, order);
    if (placed === null) continue;
    if (typeof placed !== "string") return placed;
    return { status: "ok", effort: placed, clamped: true, ladder: order, placedBy };
  }
  const outside = !EFFORT_PREFERENCE_ORDER.includes(requested)
    ? `; "${requested}" is outside the shared preference order (${EFFORT_PREFERENCE_ORDER.join(", ")})`
    : "";
  return {
    status: "rejected",
    message:
      `effort "${requested}" is not advertised here and the advertised ladder cannot place it ` +
      `(advertised: ${advertised.join(", ")})${outside}`,
  };
}

/**
 * Map a requested effort onto a level the resolved (harness, model) accepts, or
 * null when none should be sent. Thin translational wrapper over `resolveEffort`
 * for arg builders, which must never emit a level the vendor would reject: a
 * rejection yields null (send NO flag, keep the vendor default) rather than a
 * fabricated downgrade. Surfaces that can talk back to the user call
 * `resolveEffort` and report its `message`.
 */
export function normalizeEffort(
  requested: EffortHint | null | undefined,
  advertised: readonly EffortHint[],
  ladder: EffortLadderInput = advertised,
): EffortHint | null {
  const check = resolveEffort(requested, advertised, ladder);
  return check.status === "ok" ? check.effort : null;
}

const SHARED_ORDER_TEXT = EFFORT_PREFERENCE_ORDER.join(" < ");

/**
 * The typed receipt for ONE check — the same object the arg builder read, so
 * `submitted` and the flag actually sent cannot disagree, and `downward`/`floor`
 * are judged on the ladder that chose the level. `reason` states a shared-order
 * placement (it never implies vendor support), and notes a word outside the
 * shared order when nothing was submitted; it is prose, consumers branch on
 * `resolution` only.
 */
export function effortReceipt(
  check: EffortCheck,
  requested: string | null | undefined,
  source: EffortResolution["source"],
  parameter: string | null,
  unverifiable = false,
): EffortResolution {
  const base = {
    requested: requested ?? null,
    source,
    parameter,
    observed: null,
    observedSource: null,
  };
  if (check.status === "rejected")
    return { ...base, submitted: null, resolution: "rejected", reason: check.message };
  const submitted = unverifiable ? null : check.effort;
  if (submitted === null) {
    const resolution = requested && unverifiable ? "unverifiable" : "omitted";
    const outside =
      requested && !EFFORT_PREFERENCE_ORDER.includes(requested)
        ? `"${requested}" is outside the shared preference order (${SHARED_ORDER_TEXT}); no native effort was submitted`
        : null;
    return { ...base, submitted, resolution, ...(outside ? { reason: outside } : {}) };
  }
  const resolution = !check.clamped
    ? "exact"
    : check.ladder.indexOf(submitted) < check.ladder.indexOf(requested!)
      ? "downward"
      : "floor";
  const reason =
    check.placedBy === "shared"
      ? `"${requested}" is not on this route's vendor ladder; the shared preference order (${SHARED_ORDER_TEXT}) placed it and resolved it ${resolution} to ${submitted}, which claims neither vendor support for "${requested}" nor equal quality across vendors`
      : null;
  return { ...base, submitted, resolution, ...(reason ? { reason } : {}) };
}

/** Shared typed receipt; native adapters supply the final route's capability
 * facts. Empty supported and unavailable proof remain different outcomes. */
export function resolveEffortEvidence(
  requested: string | null | undefined,
  advertised: readonly string[],
  ladder: EffortLadderInput,
  source: EffortResolution["source"],
  parameter: string | null,
  unverifiable = false,
): EffortResolution {
  const check = resolveEffort(requested, unverifiable ? [] : advertised, ladder);
  return effortReceipt(check, requested, source, parameter, unverifiable);
}

/** Diagnostic only: status events never inject assistant conversation text. */
export function effortResolutionEvent(
  sessionId: string,
  receipt: EffortResolution,
  spec?: Pick<HarnessRunSpec, "model_hint" | "processing">,
): import("../schema/index.js").HarnessEvent {
  const modelChanged =
    receipt.parameter === "--model" &&
    spec?.processing?.submittedNative != null &&
    spec.processing.submittedNative !== spec.model_hint;
  const detail =
    receipt.requested && (receipt.resolution !== "exact" || modelChanged)
      ? `effort=${receipt.requested}: ${receipt.resolution}; submitted=${receipt.submitted ?? "omitted (native default)"}` +
        (receipt.reason ? `; ${receipt.reason}` : "")
      : null;
  return {
    type: "status",
    session_id: sessionId,
    ts: new Date().toISOString(),
    effort_resolution: receipt,
    // An exact selection that changed the model id is information, not an
    // adaptation: it never rides the ignored-settings (warning) channel.
    ...(detail
      ? {
          text: `[effort] ${detail}`,
          ...(receipt.resolution !== "exact" ? { payload: { ignored_settings: [detail] } } : {}),
        }
      : {}),
  };
}

/** Native adapters stop before transport when their final route cannot place a preference. */
export function throwIfEffortRejected(receipt: import("../schema/index.js").EffortResolution): void {
  if (receipt.resolution === "rejected")
    throw new EffortPreferenceRejectedError(
      receipt.reason ?? "The final route cannot place the effort preference.",
    );
}
