import { z } from "zod/v3";

/** Physical transport evidence, separate from a model's token/context window. */
const InputMeasure = z.object({
  scope: z
    .literal("turn_text")
    .describe("All text input items in one native turn; separate instructions are excluded."),
  unit: z.literal("unicode_scalars"),
  limit: z.number().int().positive().safe(),
  source: z.string().min(1),
});

export const HarnessInputLimit = InputMeasure.extend({
  verified_against: z
    .string()
    .min(1)
    .describe("Native runtime version against which the bound was observed."),
}).describe(
  "Adapter-owned observed input bound, not a predictive refusal or a model-window claim.",
);
export type HarnessInputLimit = z.infer<typeof HarnessInputLimit>;

export const HarnessRequestRefusal = z
  .discriminatedUnion("kind", [
    InputMeasure.extend({
      kind: z.literal("input_too_large"),
      limit: z.number().int().positive().safe().nullable(),
      actual: z.number().int().nonnegative().safe().nullable(),
      native_code: z.string().min(1),
    }),
    z.object({
      kind: z.literal("vendor_cli_too_old"),
      native_code: z.literal("claude_code_version_too_old"),
      source: z.literal("claude_stdout"),
      binary_path: z.string().min(1).nullable(),
      installed_version: z.string().min(1).nullable(),
    }),
    z.object({
      kind: z.literal("credential_source_unconfirmed"),
      native_code: z.literal("grok_credential_source_unconfirmed"),
      source: z.literal("grok_init"),
      reported_source: z
        .string()
        .max(80)
        .describe("Redacted credential source the vendor's startup frame reported."),
    }),
    z.object({
      kind: z.literal("vendor_not_retryable"),
      source: z.literal("agy_stderr"),
      error_id: z
        .string()
        .min(1)
        .max(128)
        .nullable()
        .describe("The vendor's own error id from the same record, verbatim; null when absent."),
    }),
  ])
  .describe(
    "Vendor-attested request refusal that stops retries and account rotation on its harness; input, executable and credential-source causes and an explicit vendor not-retryable verdict carry their own evidence.",
  );
export type HarnessRequestRefusal = z.infer<typeof HarnessRequestRefusal>;

export const HarnessPermissionDenial = z
  .object({
    permission: z.string().min(1),
    source: z.string().min(1),
  })
  .strict()
  .describe(
    "Adapter-attested native tool permission refusal, not a claim inferred from model prose or empty output. Does not grant broader access.",
  );
export type HarnessPermissionDenial = z.infer<typeof HarnessPermissionDenial>;

export const CatalogInputLimit = HarnessInputLimit.extend({
  askPromptBudget: z
    .object({
      shape: z
        .literal("ordinary_initial_attempt")
        .describe(
          "Ordinary ASK initial attempt, including thread-turn continuity; excludes deep-scan and automatic continuation attempts.",
        ),
      engineOverheadMax: z.number().int().nonnegative().safe(),
    })
    .optional(),
});
export type CatalogInputLimit = z.infer<typeof CatalogInputLimit>;
