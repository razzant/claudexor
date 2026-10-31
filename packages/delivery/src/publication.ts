/** G (rev 12/14): `pr` of a result without a rendered patch view refuses typed in
 * this release; scanning such a result for `pr` is a follow-up. Nothing is
 * scanned, created or sent. */
export const PR_UNRENDERED_REFUSAL =
  "refusing 'pr' delivery: this result has no rendered patch view, and this release publishes only results that have one (pr_unrendered_result); nothing was scanned or sent. Apply, branch or commit it locally instead.";

/**
 * The delivery owner's typed reason for a refused delivery, when it has one:
 * what a wire problem carries as its code, so a client never parses prose. A
 * Git result's own refusal, or the publication scanner's for `pr`.
 */
export function deliveryRefusalCode(delivered: {
  refusal?: { code: string };
  publicationRefusal?: { code: string };
}): string | undefined {
  return delivered.refusal?.code ?? delivered.publicationRefusal?.code;
}
