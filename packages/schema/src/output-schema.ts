/**
 * Caller-supplied per-run output-schema normalization/transport helpers. A
 * run's final ANSWER may be constrained to a JSON Schema (agent race/ask):
 * the ORIGINAL validated schema stays the conformance authority, while the
 * vendor transport gets a strict (all-required + additionalProperties:false)
 * form. Shared owner for both transforms, harness-agnostic.
 */

/** A caller-supplied output schema the structured-output routes cannot carry. */
export class UnsupportedOutputSchemaError extends Error {}

/**
 * Validate a CALLER-supplied per-run output schema and return it UNCHANGED —
 * it stays the CONFORMANCE AUTHORITY (the engine validates the final answer
 * against exactly what the caller asked for). The vendor transport separately
 * strictifies via `strictifyOutputSchema`; NEVER validate the answer against
 * the strictified form — strictify turns an optional string into a required
 * `string|null`, so `{"field":null}` would falsely pass a schema that forbids it.
 *
 * Refuses — typed, at the boundary — the shapes the native routes are
 * LIVE-VERIFIED to reject rather than let a vendor 400 surface mid-run: the
 * root must be an inline `type: "object"` (claude materializes --json-schema as
 * a StructuredOutput tool whose input_schema needs a top-level type; a
 * $ref-wrapped root 400s), `$ref` is refused anywhere, and `format` is refused
 * while the pinned claude (<2.1.205) silently drops a format-bearing schema.
 */
export function normalizeUserOutputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema["type"] !== "object" || typeof schema["properties"] !== "object") {
    throw new UnsupportedOutputSchemaError(
      'outputSchema root must be an inline object schema ({"type":"object","properties":{...}}); $ref-wrapped or non-object roots are rejected by the native structured-output routes',
    );
  }
  const hasRef = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hasRef);
    if (!value || typeof value !== "object") return false;
    const obj = value as Record<string, unknown>;
    if ("$ref" in obj) return true;
    return Object.values(obj).some(hasRef);
  };
  if (hasRef(schema)) {
    throw new UnsupportedOutputSchemaError(
      "outputSchema must not contain $ref (native structured-output routes do not resolve references); inline the referenced shapes",
    );
  }
  const hasFormat = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hasFormat);
    if (!value || typeof value !== "object") return false;
    const obj = value as Record<string, unknown>;
    if (typeof obj["format"] === "string") return true;
    return Object.values(obj).some(hasFormat);
  };
  if (hasFormat(schema)) {
    throw new UnsupportedOutputSchemaError(
      "outputSchema must not use `format`: the pinned claude CLI (<2.1.205) silently drops the whole schema when format is present; express the constraint with pattern/enum instead",
    );
  }
  return schema;
}

/** Vendor-strict transport form of a validated output schema (all keys
 *  required, additionalProperties:false, optionals nullable). Used ONLY to
 *  constrain the harness — NEVER to judge conformance (see normalizeUserOutputSchema). */
export function strictifyOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return strictifyForStructuredOutput(schema);
}

/**
 * Vendor STRICT structured-output mode (LIVE-VERIFIED against codex 0.137 /
 * the OpenAI Responses API): every object must list ALL property keys in
 * `required` and set `additionalProperties: false` — optional-with-default
 * fields become always-emitted (their Zod defaults make explicit values
 * equivalent). One owner for the transform; a schema that violates this is
 * rejected by the vendor with invalid_json_schema.
 */
export function strictifyForStructuredOutput(node: unknown): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const obj = { ...(value as Record<string, unknown>) };
    for (const key of Object.keys(obj)) obj[key] = walk(obj[key]);
    if (obj["type"] === "object" && obj["properties"] && typeof obj["properties"] === "object") {
      const props = obj["properties"] as Record<string, unknown>;
      const originallyRequired = new Set(
        Array.isArray(obj["required"]) ? (obj["required"] as unknown[]) : [],
      );
      // Vendor strict mode demands required = ALL keys; fields that were
      // OPTIONAL in the source schema stay expressible by becoming NULLABLE
      // (the OpenAI strict-mode recipe) — otherwise the model would be FORCED
      // to invent values on every call.
      for (const key of Object.keys(props)) {
        if (originallyRequired.has(key)) continue;
        const prop = props[key];
        if (prop && typeof prop === "object" && !Array.isArray(prop)) {
          const p = prop as Record<string, unknown>;
          if (typeof p["type"] === "string" && p["type"] !== "null") {
            p["type"] = [p["type"], "null"];
          } else if (Array.isArray(p["type"]) && !(p["type"] as unknown[]).includes("null")) {
            (p["type"] as unknown[]).push("null");
          }
        }
      }
      obj["required"] = Object.keys(props);
      obj["additionalProperties"] = false;
    }
    return obj;
  };
  return walk(node) as Record<string, unknown>;
}
