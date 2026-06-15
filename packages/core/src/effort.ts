import type { EffortHint } from "@claudexor/schema";
import { EffortHint as EffortHintSchema } from "@claudexor/schema";

/**
 * The full cross-harness reasoning-effort ladder, ordered weakest→strongest.
 * DERIVED from the EffortHint enum's declaration order (the single source) so the
 * ladder can never drift from the enum: a future level (e.g. `ultra`) appended to
 * the enum is automatically ranked and every adapter clamps it with no code
 * change. An EffortHint's RANK is its index here; the normalizer below clamps any
 * requested level onto the nearest level a given adapter actually supports.
 */
const EFFORT_LADDER: readonly EffortHint[] = EffortHintSchema.options;

function rank(level: EffortHint): number {
  return EFFORT_LADDER.indexOf(level);
}

/**
 * Map a requested reasoning-effort hint onto the nearest level a harness
 * actually supports.
 *
 * - `requested` null/undefined → null (no effort was asked for; pass no flag).
 * - `supported` empty → null (effort is NOT a tunable surface for this adapter;
 *   it passes no effort flag at all — honest, not a silent clamp to a default).
 * - `requested` exactly supported → returned unchanged.
 * - otherwise CLAMP to the nearest supported level BY RANK: above the strongest
 *   supported → the strongest; below the weakest → the weakest; in-between → the
 *   closest by rank, ties resolving to the LOWER (cheaper) level.
 *
 * Pure and data-driven: the adapter feeds its own declared `effort_levels` and
 * never hard-codes a clamp table.
 */
export function normalizeEffort(
  requested: EffortHint | null | undefined,
  supported: readonly EffortHint[],
): EffortHint | null {
  if (requested === null || requested === undefined) return null;
  if (supported.length === 0) return null;
  if (supported.includes(requested)) return requested;

  const want = rank(requested);
  let best: EffortHint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of supported) {
    const distance = Math.abs(rank(level) - want);
    // Strictly-closer wins; on a tie keep the LOWER-ranked (cheaper) candidate.
    if (distance < bestDistance || (distance === bestDistance && best !== null && rank(level) < rank(best))) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}
