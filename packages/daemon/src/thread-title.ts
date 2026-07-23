/** Max user-perceived characters in an auto-derived thread title (incl. the
 *  ellipsis). Historically a raw `.slice(0, 60)` of UTF-16 code units. */
const AUTO_TITLE_MAX_GRAPHEMES = 60;

/**
 * Derive a durable thread title from the first prompt line (QA-048).
 *
 * The old `firstLine.slice(0, 60)` counted UTF-16 code units, so it could split
 * a supplementary scalar between its surrogates — a lone `\ud83d` then serializes
 * to JSON that Foundation's JSONDecoder rejects, breaking the whole macOS thread
 * list. It also cut mid-word with no omission cue. This segments on extended
 * grapheme clusters (Intl.Segmenter) so an emoji/ZWJ sequence/combining mark is
 * never split, and appends an ellipsis when the source overflows.
 *
 * Producer-only + migration-safe: this runs solely when a thread has no title
 * yet (its first turn); titles already stored are never re-derived.
 */
export function deriveThreadTitle(prompt: string): string {
  const firstLine = prompt.split("\n")[0] ?? "";
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemes: string[] = [];
  for (const { segment } of segmenter.segment(firstLine)) {
    graphemes.push(segment);
    // Stop early once we know it overflows (no need to segment a huge prompt).
    if (graphemes.length > AUTO_TITLE_MAX_GRAPHEMES) break;
  }
  if (graphemes.length <= AUTO_TITLE_MAX_GRAPHEMES) return graphemes.join("");
  // Reserve one grapheme for the ellipsis so the result stays within the cap.
  return graphemes.slice(0, AUTO_TITLE_MAX_GRAPHEMES - 1).join("") + "…";
}
