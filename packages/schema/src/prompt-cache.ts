import { z } from "zod/v3";
import { NonBlankString } from "./primitives.js";

/** Native prompt-cache lifetime chosen for a run; omission is Default. */
export const PromptCacheTtl = z
  .enum(["5m", "1h"])
  .describe(
    "Native prompt-cache lifetime for the main conversation and helper requests of a harness that declares it. Omission sends no override: native defaults, profile settings and the inherited environment stay in effect.",
  );
export type PromptCacheTtl = z.infer<typeof PromptCacheTtl>;

export const PromptCacheTtlSupport = z
  .array(PromptCacheTtl)
  .optional()
  .describe(
    "Prompt-cache lifetimes this adapter translates into native controls; a requested lifetime outside the list (or with the list absent) is disclosed as ignored.",
  );

const WriteTokens = z.number().int().nonnegative().nullable();

export const PromptCacheTtlReceipt = z
  .object({
    requested: PromptCacheTtl.nullable().describe(
      "Lifetime the engine routed to this session: the run's captured value where this adapter declares it, otherwise null (Default, or an undeclared value disclosed as ignored). The captured intent itself is the task contract's prompt_cache_ttl.",
    ),
    submitted: PromptCacheTtl.nullable().describe(
      "Value set on the native lifetime controls of this process, null when none was set. Configuration, not proof that the provider applied it.",
    ),
    reason: NonBlankString.nullable().describe(
      "Known reason the submitted value cannot govern this session (a forcing or disabling native control in effect, or a CLI that predates the controls); null when none is known.",
    ),
    observed: z
      .enum(["5m", "1h", "mixed", "none", "unknown"])
      .describe(
        "Lifetime split of the cache writes reported by the native result usage; it does not establish which request buckets that usage aggregates. none = no observed writes (not disabled caching); unknown = a result did not report the split.",
      ),
    write_5m_tokens: WriteTokens.describe(
      "Reported five-minute cache-write tokens summed over results; null when any result omitted the split.",
    ),
    write_1h_tokens: WriteTokens.describe(
      "Reported one-hour cache-write tokens summed over results; null when any result omitted the split.",
    ),
  })
  .strict()
  .describe(
    "Requested, configured and observed prompt-cache lifetime facts for one attempt. Lifecycle, outcome and cost are separate facts and never derive from this receipt.",
  );
export type PromptCacheTtlReceipt = z.infer<typeof PromptCacheTtlReceipt>;

/** The one rule turning reported write counts into the observed lifetime;
 * unknown counts stay unknown, and zero writes are `none`, never "disabled". */
export function observedPromptCacheTtl(
  write5m: number | null,
  write1h: number | null,
): PromptCacheTtlReceipt["observed"] {
  if (write5m === null || write1h === null) return "unknown";
  if (write1h > 0 && write5m > 0) return "mixed";
  return write1h > 0 ? "1h" : write5m > 0 ? "5m" : "none";
}
