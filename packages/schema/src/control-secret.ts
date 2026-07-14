import { z } from "zod";

export const SecretMetadata = z
  .object({
    name: z.string().describe("Secret name/label."),
    backend: z.enum(["keychain", "file"]).describe("Secret storage backend."),
    present: z.boolean().default(true).describe("Whether a value is stored."),
  })
  .describe("Secret metadata; never the value.");
export type SecretMetadata = z.infer<typeof SecretMetadata>;

export const ControlSecretListResponse = z
  .object({
    backend: z.enum(["keychain", "file"]).describe("Active secret store backend."),
    secrets: z.array(SecretMetadata).default([]).describe("Stored secret metadata."),
  })
  .describe("Metadata-only response for listing stored secrets.");
export type ControlSecretListResponse = z.infer<typeof ControlSecretListResponse>;

export const ControlSecretSetRequest = z
  .object({
    name: z.string().min(1).describe("Managed secret reference name."),
    value: z.string().min(1).describe("Value accepted only by the non-journaled secret route."),
  })
  .strict()
  .describe("Write one managed secret through the daemon-owned store.");
export type ControlSecretSetRequest = z.infer<typeof ControlSecretSetRequest>;

export const ControlSecretMutationResponse = z
  .object({
    name: z.string(),
    backend: z.enum(["keychain", "file"]).optional(),
    stored: z.boolean().optional(),
    deleted: z.boolean().optional(),
    warning: z.string().optional(),
  })
  .strict()
  .refine((value) => value.stored === true || value.deleted === true, {
    message: "stored or deleted receipt is required",
  })
  .describe("Managed-secret mutation receipt; never contains the value.");
export type ControlSecretMutationResponse = z.infer<typeof ControlSecretMutationResponse>;
