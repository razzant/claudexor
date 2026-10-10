import { z } from "zod/v3";
import { Id, IsoTimestamp, NonBlankString } from "./primitives.js";
import { HarnessModel } from "./harness.js";
import { AccountCatalogAvailability } from "./model-operation.js";

/**
 * Models enumerable for one harness. `source` is honest about provenance:
 * "api" when the adapter implemented a real enumeration (raw-api / OpenAI
 * `GET /v1/models`), "manifest" when the list is the manifest's known-good
 * hint set, "none" when the harness has no model truth source at all (the
 * list is then empty and explicit models are refused under strict model-truth validation).
 */
export const ControlHarnessModelsResponse = z
  .object({
    harnessId: z.string().describe("Harness the models belong to."),
    models: z
      .array(HarnessModel)
      .default([])
      .describe("Enumerable models; empty when the harness has no model truth source."),
    source: z
      .enum(["api", "manifest", "none"])
      .describe(
        "Provenance of the list: api (a live vendor enumeration), manifest (the manifest's known-good hint set), or none (no model truth source; explicit models are refused).",
      ),
    /** Freshness note for manifest-sourced lists: the vendor CLI version the
     * known-model hints were last verified against (null for api/none). */
    verifiedAgainst: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Vendor CLI version the manifest hints were last verified against; null for api/none sources.",
      ),
  })
  .describe("Models enumerable for one harness, with honest provenance.");
export type ControlHarnessModelsResponse = z.infer<typeof ControlHarnessModelsResponse>;

export const ControlHarnessAccountCatalog = ControlHarnessModelsResponse.extend({
  credentialProfileId: Id,
  observedAt: IsoTimestamp.nullable().describe(
    "Original account catalog observation, or null for manifest hints whose observation time is unknown.",
  ),
  provenance: NonBlankString,
}).strict();
export type ControlHarnessAccountCatalog = z.infer<typeof ControlHarnessAccountCatalog>;
export const ControlHarnessAccountModelsResponse = z
  .object({
    harnessId: Id,
    accounts: z.array(
      AccountCatalogAvailability.extend({ catalog: ControlHarnessAccountCatalog.nullable() }),
    ),
    partial: z.boolean(),
  })
  .strict();
export type ControlHarnessAccountModelsResponse = z.infer<
  typeof ControlHarnessAccountModelsResponse
>;
export const ControlHarnessModelsQueryResponse = z.union([
  ControlHarnessModelsResponse.strict(),
  ControlHarnessAccountModelsResponse,
]);
export type ControlHarnessModelsQueryResponse = z.infer<typeof ControlHarnessModelsQueryResponse>;
