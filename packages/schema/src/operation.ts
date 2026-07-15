import { z } from "zod";

export const CONTROL_PROTOCOL_MAJOR = 2 as const;

export const ControlHandshakeRequest = z
  .object({
    protocolMajor: z.number().int().positive(),
    client: z.string().min(1).max(80),
  })
  .strict()
  .describe("Control-plane protocol negotiation requested before product calls.");
export type ControlHandshakeRequest = z.infer<typeof ControlHandshakeRequest>;

export const ControlHandshakeResponse = z
  .object({
    protocolMajor: z.literal(CONTROL_PROTOCOL_MAJOR),
    compatible: z.literal(true),
    operationsPath: z.literal("/v2/operations"),
  })
  .strict()
  .describe("Successful v2 control-plane negotiation.");
export type ControlHandshakeResponse = z.infer<typeof ControlHandshakeResponse>;

export const ControlOperationDescriptor = z
  .object({
    id: z.string().min(1),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().startsWith("/v2/"),
    requestSchema: z.string().min(1).nullable(),
    responseSchema: z.string().min(1).nullable(),
    mutability: z.enum(["read_only", "mutating"]),
    idempotency: z.enum(["none", "natural", "key_required"]),
    applicability: z.enum(["global", "project", "thread", "run"]),
    responseKind: z.enum(["json", "stream", "binary"]),
    completion: z.enum(["immediate", "durable_handle", "terminal_stream"]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.responseKind === "json" && value.responseSchema === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["responseSchema"],
        message: "JSON operations require an explicit response schema",
      });
    }
  })
  .describe("Machine-readable truth for one implemented v2 operation.");
export type ControlOperationDescriptor = z.infer<typeof ControlOperationDescriptor>;

export const ControlOperationCatalog = z
  .object({
    protocolMajor: z.literal(CONTROL_PROTOCOL_MAJOR),
    operations: z.array(ControlOperationDescriptor),
  })
  .strict()
  .describe("Implemented v2 operations; absence means unsupported.");
export type ControlOperationCatalog = z.infer<typeof ControlOperationCatalog>;
