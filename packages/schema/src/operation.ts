import { z } from "zod";

// v3.0.0 broke run/thread/status/mode contracts wholesale, so the negotiated
// major moved to 3. The URL prefix stays the frozen literal `/v2/` — a path
// spelling, not the compatibility contract; the negotiated protocolMajor is
// the ONLY compatibility signal (renaming every route for cosmetic symmetry
// was rejected as churn).
export const CONTROL_PROTOCOL_MAJOR = 3 as const;

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
    /** Build identity of the serving engine (D20/INV-116 spirit): stale-
     * daemon skew is visible at the handshake instead of guessed later. */
    engine: z
      .object({
        version: z.string().min(1).describe("Lockstep workspace version."),
        sha: z
          .string()
          .min(1)
          .describe(
            "Git commit SHA of the build; 'unknown' outside a stamped package or git checkout.",
          ),
        entry: z.string().min(1).describe("Resolved entry path of the serving process."),
      })
      .strict()
      .describe("Build identity of the serving engine."),
  })
  .strict()
  .describe("Successful control-plane negotiation.");
export type ControlHandshakeResponse = z.infer<typeof ControlHandshakeResponse>;

export const ControlOperationDescriptor = z
  .object({
    id: z.string().min(1),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().startsWith("/v2/"),
    /** One-line human summary of the operation (code-first route descriptor
     * field). Feeds the generated operation catalog + endpoints doc. */
    summary: z.string().min(1).describe("One-line human summary of the operation."),
    /** Auth boundary for the route. Every product route is loopback + bearer
     * token; only the unversioned GET /healthz probe is loopback-only (and it
     * is not in this catalog). */
    auth: z
      .enum(["loopback_bearer", "loopback_only"])
      .describe("Auth boundary: loopback + bearer token, or loopback-only."),
    requestSchema: z.string().min(1).nullable(),
    responseSchema: z.string().min(1).nullable(),
    errorSchema: z.literal("ControlProblem"),
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
