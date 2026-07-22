/**
 * Caller-supplied per-run output-schema normalization/transport helpers. A
 * run's final ANSWER may be constrained to a JSON Schema (agent race/ask):
 * the ORIGINAL validated schema stays the conformance authority, while the
 * vendor transport gets a strict (all-required + additionalProperties:false)
 * form. Shared owner for both transforms, harness-agnostic.
 */

/** A caller-supplied output schema the structured-output routes cannot carry. */
/** Every fail-closed shape refusal is caller-actionable: it must surface as
 *  the same typed `invalid_output_schema` contract the compile-failure path
 *  uses (W24 errorCode/errorStatus), never as an untyped 500. */
export class UnsupportedOutputSchemaError extends Error {
  readonly status = 400;
  readonly code = "invalid_output_schema";
  readonly retryable = false;
  readonly requiredActions = ["fix the output schema and retry the run"];
}

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

/** Fail-closed ceiling for schema nesting: deeper documents would risk a raw
 *  RangeError (stack exhaustion) in the recursive walks instead of a typed
 *  refusal. No legitimate output contract nests anywhere near this. */
const MAX_SCHEMA_DEPTH = 256;

/**
 * Generic deep scan of the WHOLE document — every object node, not just
 * keyword-reachable schema positions. A $ref may point at any JSON Pointer
 * (including subtrees under ad-hoc non-keyword keys), and unreferenced
 * non-keyword subtrees are copied verbatim into the vendor transport, so
 * dynamic/recursive/scoped semantics anywhere in the document must fail
 * closed at preflight. Map-keyword containers skip the key check on the map
 * itself (property NAMES may legitimately collide with keywords) but their
 * values are scanned. Keyword-shaped keys inside data values (default,
 * examples) are refused too — fail closed beats a mid-run vendor 400.
 */
function assertSupportedReferenceScope(root: Record<string, unknown>): void {
  const scan = (value: unknown, depth: number): void => {
    if (typeof value === "boolean" || !value || typeof value !== "object") return;
    if (depth > MAX_SCHEMA_DEPTH) {
      throw new UnsupportedOutputSchemaError(
        `outputSchema nesting exceeds ${MAX_SCHEMA_DEPTH} levels; flatten the schema`,
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) scan(item, depth + 1);
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
    if (depth > 0 && typeof schema["$id"] === "string") {
      throw new UnsupportedOutputSchemaError(
        "outputSchema cannot carry nested $id scopes for native transport; inline the scoped schema or remove the nested $id",
      );
    }
    // $ref values are validated document-wide, not just in schema positions:
    // an external ref anywhere would otherwise ride a verbatim-copied subtree
    // into the vendor transport instead of failing closed here.
    const refValue = schema["$ref"];
    if (refValue !== undefined) {
      if (typeof refValue !== "string") {
        throw new UnsupportedOutputSchemaError("outputSchema $ref must be a string");
      }
      localRefTokens(refValue);
    }
    for (const [key, child] of Object.entries(schema)) {
      if (
        SCHEMA_MAP_KEYWORDS.has(key) &&
        child &&
        typeof child === "object" &&
        !Array.isArray(child)
      ) {
        for (const entry of Object.values(child as Record<string, unknown>)) scan(entry, depth + 2);
      } else {
        scan(child, depth + 1);
      }
    }
  };
  scan(root, 0);
}

/** Fail-closed ceiling for transport dereference work: each $ref occurrence
 *  re-copies its target, so N doubling layers expand ~2^N nodes and an
 *  adversarial schema could exhaust the daemon during preflight. */
const MAX_DEREFERENCE_NODES = 10_000;

function containsRefDeep(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsRefDeep);
  const obj = value as Record<string, unknown>;
  if ("$ref" in obj) return true;
  return Object.values(obj).some(containsRefDeep);
}

/**
 * Build the provider transport authority by inlining resolvable local refs.
 * The caller's original schema remains untouched for Ajv conformance and
 * hashing. Native transports never see `$ref`, `$defs`, or `definitions`.
 */
function dereferenceLocalOutputSchema(root: Record<string, unknown>): Record<string, unknown> {
  assertSupportedReferenceScope(root);
  let visitedNodes = 0;
  const walkSchema = (value: unknown, resolving: readonly string[], depth: number): unknown => {
    if (typeof value === "boolean") return value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    if (++visitedNodes > MAX_DEREFERENCE_NODES) {
      throw new UnsupportedOutputSchemaError(
        "outputSchema local $ref expansion exceeds the transport budget; inline or simplify the shared definitions",
      );
    }
    // The EXPANDED tree is capped too: a flat $defs chain of single-level
    // refs keeps the source shallow while resolution recurses one frame per
    // link — that must be a typed refusal, never stack exhaustion, and it
    // also bounds every later walk over the transport copy (strictify).
    if (depth > MAX_SCHEMA_DEPTH) {
      throw new UnsupportedOutputSchemaError(
        `outputSchema local $ref expansion nests past ${MAX_SCHEMA_DEPTH} levels; flatten the reference chain`,
      );
    }
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
      const target = walkSchema(
        localRefTarget(root, refValue),
        [...resolving, refValue],
        depth + 1,
      );
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
    // defineProperty, not assignment: an own "__proto__" key from JSON.parse
    // must round-trip as an own data property instead of hitting the
    // Object.prototype setter (which would silently drop the key).
    const setOwn = (key: string, val: unknown): void => {
      Object.defineProperty(output, key, {
        value: val,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    };
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
        setOwn(
          key,
          Object.fromEntries(
            Object.entries(child as Record<string, unknown>).map(([name, schema]) => [
              name,
              walkSchema(schema, resolving, depth + 2),
            ]),
          ),
        );
      } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(child)) {
        setOwn(
          key,
          child.map((schema) => walkSchema(schema, resolving, depth + 2)),
        );
      } else if (key === "items") {
        setOwn(
          key,
          Array.isArray(child)
            ? child.map((schema) => walkSchema(schema, resolving, depth + 2))
            : walkSchema(child, resolving, depth + 1),
        );
      } else if (
        key === "dependencies" &&
        child &&
        typeof child === "object" &&
        !Array.isArray(child)
      ) {
        setOwn(
          key,
          Object.fromEntries(
            Object.entries(child as Record<string, unknown>).map(([name, dependency]) => [
              name,
              Array.isArray(dependency) ? dependency : walkSchema(dependency, resolving, depth + 2),
            ]),
          ),
        );
      } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
        setOwn(key, walkSchema(child, resolving, depth + 1));
      } else {
        // Verbatim-copied subtrees (unknown/non-schema keys) never get their
        // refs resolved, and the native routes 400 on any $ref they see.
        if (containsRefDeep(child)) {
          throw new UnsupportedOutputSchemaError(
            `outputSchema $ref under non-schema key ${JSON.stringify(key)} cannot be resolved for native transport; move the reference under a schema keyword or inline it`,
          );
        }
        setOwn(key, child);
      }
    }
    return output;
  };

  return walkSchema(root, [], 0) as Record<string, unknown>;
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
