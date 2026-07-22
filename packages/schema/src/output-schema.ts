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
 * $ref-wrapped root 400s), references must be resolvable local JSON Pointers,
 * and `format` is refused while the pinned claude (<2.1.205) silently drops a
 * format-bearing schema. Local refs are inlined in the transport-only copy.
 */
export function normalizeUserOutputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema["type"] !== "object" || typeof schema["properties"] !== "object") {
    throw new UnsupportedOutputSchemaError(
      'outputSchema root must be an inline object schema ({"type":"object","properties":{...}}); $ref-wrapped or non-object roots are rejected by the native structured-output routes',
    );
  }
  // Validate every local reference now, before the run is announced. The
  // returned copy is intentionally discarded here: the original schema stays
  // the conformance authority and is compiled by the dialect-aware validator.
  dereferenceLocalOutputSchema(schema);
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
  const transportSchema = strictifyForStructuredOutput(dereferenceLocalOutputSchema(schema));
  // `$schema` chooses the engine-side conformance validator. Native provider
  // transports accept a strict JSON Schema subset and do not need this
  // meta-schema declaration; keep it only on the untouched caller authority.
  delete transportSchema["$schema"];
  return transportSchema;
}

function decodeJsonPointerToken(token: string): string {
  if (/~(?:[^01]|$)/.test(token)) {
    throw new UnsupportedOutputSchemaError(
      `outputSchema contains an invalid local $ref JSON Pointer token: ${JSON.stringify(token)}`,
    );
  }
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function localRefTokens(ref: string): string[] {
  if (!ref.startsWith("#")) {
    throw new UnsupportedOutputSchemaError(
      `outputSchema $ref must be a local JSON Pointer fragment; external refs are unsupported: ${ref}`,
    );
  }
  let pointer: string;
  try {
    // URI-fragment decoding precedes JSON Pointer tokenization (RFC 6901 §6).
    // In particular, `%2F` is a pointer separator, not a slash inside one key.
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    throw new UnsupportedOutputSchemaError(
      `outputSchema contains an invalid percent-encoded local $ref: ${JSON.stringify(ref)}`,
    );
  }
  if (!pointer.startsWith("/")) {
    throw new UnsupportedOutputSchemaError(
      `outputSchema $ref must resolve from a local JSON Pointer beginning with '/'; anchors and root refs are unsupported: ${ref}`,
    );
  }
  return pointer.slice(1).split("/").map(decodeJsonPointerToken);
}

function localRefTarget(root: Record<string, unknown>, ref: string): unknown {
  let current: unknown = root;
  for (const token of localRefTokens(ref)) {
    if (
      !current ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, token)
    ) {
      throw new UnsupportedOutputSchemaError(`outputSchema $ref does not resolve: ${ref}`);
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_VALUE_KEYWORDS = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "additionalItems",
  "unevaluatedItems",
  "contentSchema",
]);
const REF_ANNOTATION_KEYWORDS = new Set([
  "title",
  "description",
  "$comment",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

function forEachChildSchema(
  source: Record<string, unknown>,
  visit: (schema: unknown) => void,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (
      SCHEMA_MAP_KEYWORDS.has(key) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      for (const child of Object.values(value as Record<string, unknown>)) visit(child);
    } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      value.forEach(visit);
    } else if (key === "items") {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    } else if (
      key === "dependencies" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      for (const child of Object.values(value as Record<string, unknown>)) {
        if (!Array.isArray(child)) visit(child);
      }
    } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
      visit(value);
    }
  }
}

function assertSupportedReferenceScope(root: Record<string, unknown>): void {
  let hasRef = false;
  let hasNestedId = false;
  const scan = (value: unknown, depth: number): void => {
    if (typeof value === "boolean" || !value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const schema = value as Record<string, unknown>;
    for (const keyword of ["$dynamicRef", "$recursiveRef", "$dynamicAnchor", "$recursiveAnchor"]) {
      if (keyword in schema) {
        throw new UnsupportedOutputSchemaError(
          `outputSchema ${keyword} is unsupported by native structured-output transport; use an inline local $ref without dynamic or recursive scope`,
        );
      }
    }
    if (typeof schema["$ref"] === "string") hasRef = true;
    if (depth > 0 && typeof schema["$id"] === "string") hasNestedId = true;
    forEachChildSchema(schema, (child) => scan(child, depth + 1));
  };
  scan(root, 0);
  if (hasRef && hasNestedId) {
    throw new UnsupportedOutputSchemaError(
      "outputSchema cannot combine local $ref with nested $id scopes for native transport; inline the scoped schema or remove the nested $id",
    );
  }
}

/**
 * Build the provider transport authority by inlining resolvable local refs.
 * The caller's original schema remains untouched for Ajv conformance and
 * hashing. Native transports never see `$ref`, `$defs`, or `definitions`.
 */
function dereferenceLocalOutputSchema(root: Record<string, unknown>): Record<string, unknown> {
  assertSupportedReferenceScope(root);
  const walkSchema = (value: unknown, resolving: readonly string[]): unknown => {
    if (typeof value === "boolean") return value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const source = value as Record<string, unknown>;
    const refValue = source["$ref"];
    if (refValue !== undefined) {
      if (typeof refValue !== "string") {
        throw new UnsupportedOutputSchemaError("outputSchema $ref must be a string");
      }
      if (resolving.includes(refValue)) {
        throw new UnsupportedOutputSchemaError(
          `outputSchema contains a cyclic local $ref: ${[...resolving, refValue].join(" -> ")}`,
        );
      }
      const unsupportedSiblings = Object.keys(source).filter(
        (key) => key !== "$ref" && !REF_ANNOTATION_KEYWORDS.has(key),
      );
      if (unsupportedSiblings.length > 0) {
        throw new UnsupportedOutputSchemaError(
          `outputSchema $ref siblings are unsupported for native transport (${unsupportedSiblings.join(", ")}); inline the combined constraints`,
        );
      }
      const target = walkSchema(localRefTarget(root, refValue), [...resolving, refValue]);
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        throw new UnsupportedOutputSchemaError(
          `outputSchema local $ref must resolve to an object schema for native transport: ${refValue}`,
        );
      }
      const annotations = Object.fromEntries(
        Object.entries(source).filter(([key]) => REF_ANNOTATION_KEYWORDS.has(key)),
      );
      return { ...(target as Record<string, unknown>), ...annotations };
    }

    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      // Definitions are source-only after all references have been inlined.
      if (key === "$defs" || key === "definitions") continue;
      if (key === "unevaluatedProperties") {
        const hasCrossSchemaApplicator = [
          "allOf",
          "anyOf",
          "oneOf",
          "if",
          "then",
          "else",
          "dependentSchemas",
        ].some((keyword) => keyword in source);
        if (
          child !== false ||
          source["type"] !== "object" ||
          !source["properties"] ||
          typeof source["properties"] !== "object" ||
          Array.isArray(source["properties"]) ||
          hasCrossSchemaApplicator
        ) {
          throw new UnsupportedOutputSchemaError(
            "outputSchema unevaluatedProperties can be transported only when false on an inline object with local properties and no cross-schema applicators; otherwise inline the evaluated properties and use additionalProperties:false",
          );
        }
        // strictifyForStructuredOutput adds additionalProperties:false to this
        // same object, which is equivalent for the proven simple shape.
        continue;
      }
      if (key === "unevaluatedItems") {
        throw new UnsupportedOutputSchemaError(
          "outputSchema unevaluatedItems is unsupported by native structured-output transport; express the item constraints inline",
        );
      }
      if (
        SCHEMA_MAP_KEYWORDS.has(key) &&
        child &&
        typeof child === "object" &&
        !Array.isArray(child)
      ) {
        output[key] = Object.fromEntries(
          Object.entries(child as Record<string, unknown>).map(([name, schema]) => [
            name,
            walkSchema(schema, resolving),
          ]),
        );
      } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(child)) {
        output[key] = child.map((schema) => walkSchema(schema, resolving));
      } else if (key === "items") {
        output[key] = Array.isArray(child)
          ? child.map((schema) => walkSchema(schema, resolving))
          : walkSchema(child, resolving);
      } else if (
        key === "dependencies" &&
        child &&
        typeof child === "object" &&
        !Array.isArray(child)
      ) {
        output[key] = Object.fromEntries(
          Object.entries(child as Record<string, unknown>).map(([name, dependency]) => [
            name,
            Array.isArray(dependency) ? dependency : walkSchema(dependency, resolving),
          ]),
        );
      } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
        output[key] = walkSchema(child, resolving);
      } else {
        output[key] = child;
      }
    }
    return output;
  };

  return walkSchema(root, []) as Record<string, unknown>;
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
