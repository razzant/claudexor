/** Historical menu hints; account-specific presence comes from `models()`.
 * Effort rides the vendor slug: the separate effort ladder stays empty and an
 * effort preference selects the listed level variant of the model's family
 * from the pinned account's LIVE list only (processing.ts) — these hints never
 * authorize a rewrite. New Claude ids come from the profile listing instead of extending this
 * version-stamped fallback. Inherited Gemini 3.8 hints were recorded on
 * 2026-10-03 while the binary self-updated from 1.1.13 to 1.2.16, so those
 * additions did not re-verify the fixture pin. Older 4.6 routes remain hints:
 * one account's absence cannot retire them. */
export const AGY_KNOWN_MODELS = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.5-flash-high",
  "gemini-3.5-flash-medium",
  "gemini-3.5-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
] as const;
