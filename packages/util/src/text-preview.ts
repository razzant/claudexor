/**
 * The first `units` UTF-16 code units of `text`, one fewer when that cut would
 * split a surrogate pair (its lone half reads as U+FFFD). Shorter text and a
 * lone surrogate already in the source are kept exactly.
 */
export function wholeCharPrefix(text: string, units: number): string {
  return text.slice(0, (text.codePointAt(units - 1) ?? 0) > 0xffff ? units - 1 : units);
}

/**
 * A display label of at most `max` UTF-16 code units: the text itself when it
 * fits, otherwise a whole-character prefix ending in a visible "…". Only a
 * label: the complete text stays beside it, and an answer key, option label or
 * any other working content never comes from it (INV-146).
 */
export function displayPreview(text: string, max: number): string {
  return text.length <= max ? text : `${wholeCharPrefix(text, max - 1)}…`;
}
