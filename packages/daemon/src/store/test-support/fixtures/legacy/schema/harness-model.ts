import { z } from "zod/v3";
import { ProcessingCapability } from "./processing.js";

/**
 * One enumerable model offered by a harness. Deliberately small: only the
 * fields a real enumeration source (an OpenAI-compatible `GET /v1/models`)
 * can honestly populate. `label`/`context_window` are nullable because the
 * raw `{data:[{id}]}` list rarely carries them.
 */
export const HarnessModel = z
  .object({
    processing: ProcessingCapability.optional(),
    id: z.string().describe("Model id as the vendor enumerates it."),
    label: z
      .string()
      .nullable()
      .default(null)
      .describe("Human-readable model label; null when the enumeration source has none."),
    context_window: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe("Context window in tokens; null when the enumeration source does not report it."),
    /** Credential routes the model is scoped to per the manifest annotation;
     * null = unannotated (available on every route). */
    routes: z
      .array(z.enum(["local_session", "api_key"]))
      .nullable()
      .default(null)
      .describe("Credential routes the model is scoped to; null = every route."),
    /** Row provenance inside ONE producer's answer. Absent = live, so producers
     * that predate the field (codex, cursor, raw-api) need no change. */
    origin: z
      .enum(["live", "hint"])
      .optional()
      .describe(
        "Where this row came from: live = the vendor's own enumeration reported it; hint = a frozen known-model id the producer appends when its live answer lacks it or could not be read. Absent = live.",
      ),
    /** What an alias row resolved to when the vendor was asked (claude's
     * `default` -> `claude-opus-5-5[1m]`). Diagnostic only: the row id is what
     * travels, never rewritten to this. */
    resolved_model: z
      .string()
      .nullable()
      .optional()
      .describe(
        "For an alias row, the exact model id the vendor reported it resolves to at enumeration time; null or absent when the source reports none. The row id is what is sent; this is never substituted for it.",
      ),
  })
  .describe(
    "One enumerable model offered by a harness, limited to fields a real enumeration source can honestly populate.",
  );
export type HarnessModel = z.infer<typeof HarnessModel>;
