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

/**
 * A non-body request parameter (query or header) an operation reads. The
 * descriptor's `requestSchema` describes the JSON request BODY only; strict
 * query filters and resume-cursor headers live here so a machine consumer can
 * construct a full valid request (QA-055). This is deliberately NOT OpenAPI —
 * just the minimum located-parameter contract the catalog needs.
 */
export const ControlOperationParameter = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        "Wire name of the parameter: the query key or the (case-insensitive) header field name.",
      ),
    location: z
      .enum(["query", "header"])
      .describe("Where the parameter travels: the URL query string or a request header."),
    required: z.boolean().describe("Whether the operation requires the parameter to be present."),
    repeatable: z
      .boolean()
      .default(false)
      .describe("Whether the parameter may appear more than once (e.g. a repeated query filter)."),
    enum: z
      .array(z.string().min(1))
      .nullable()
      .default(null)
      .describe("Closed set of accepted values when the grammar is a fixed enum; null otherwise."),
    schemaRef: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe(
        "Generated schema name (optionally a `Name#/properties/field` pointer) that types this parameter's value when it is not a simple enum; null otherwise.",
      ),
    description: z.string().min(1).describe("One-line human semantics of the parameter."),
  })
  .strict()
  .describe("A query or header request parameter an operation reads (never the JSON body).");
export type ControlOperationParameter = z.infer<typeof ControlOperationParameter>;

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
    /** Query/header parameters the operation reads. `requestSchema` covers the
     * JSON body ONLY; these are the non-body inputs (strict GET filters, SSE
     * resume cursors) a machine consumer needs to build a full valid request.
     * Empty means the operation reads no non-body parameters beyond the shared
     * protocol/auth/idempotency headers declared at catalog scope. */
    parameters: z
      .array(ControlOperationParameter)
      .default([])
      .describe("Query/header request parameters (body shape is `requestSchema`)."),
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
