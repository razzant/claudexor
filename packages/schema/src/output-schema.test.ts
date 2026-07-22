import { describe, expect, it } from "vitest";
import {
  normalizeUserOutputSchema,
  strictifyOutputSchema,
  UnsupportedOutputSchemaError,
} from "./output-schema.js";

describe("strictifyOutputSchema", () => {
  it("keeps the dialect declaration out of the native provider transport", () => {
    const source = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    };

    const transport = strictifyOutputSchema(source);

    expect(transport).not.toHaveProperty("$schema");
    expect(source).toHaveProperty("$schema");
    expect(transport).toMatchObject({
      type: "object",
      required: ["ok"],
      additionalProperties: false,
    });
  });

  it("inlines local $defs refs only in the provider transport", () => {
    const source = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { result: { $ref: "#/$defs/result" } },
      required: ["result"],
      $defs: {
        result: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    };

    expect(normalizeUserOutputSchema(source)).toBe(source);
    expect(strictifyOutputSchema(source)).toMatchObject({
      properties: {
        result: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    });
    expect(source.properties.result).toEqual({ $ref: "#/$defs/result" });
  });

  it("resolves escaped object keys and array indexes in local JSON Pointers", () => {
    const source = {
      type: "object",
      properties: { result: { $ref: "#/$defs/results~1v1/oneOf/0" } },
      required: ["result"],
      $defs: {
        "results/v1": { oneOf: [{ type: "string" }, { type: "number" }] },
      },
    };

    expect(strictifyOutputSchema(source)).toMatchObject({
      properties: { result: { type: "string" } },
    });
  });

  it("decodes the URI fragment before splitting JSON Pointer tokens", () => {
    const source = {
      type: "object",
      properties: { result: { $ref: "#/$defs/bucket%2F$defs%2Ftarget" } },
      required: ["result"],
      $defs: {
        bucket: { $defs: { target: { type: "string" } } },
        "bucket/$defs/target": { type: "number" },
      },
    };

    expect(strictifyOutputSchema(source)).toMatchObject({
      properties: { result: { type: "string" } },
    });
  });

  it("preserves output property names that match definition keywords", () => {
    const source = {
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: {
            definitions: { type: "string" },
            $defs: { type: "number" },
          },
          required: ["definitions", "$defs"],
        },
      },
      required: ["payload"],
    };

    expect(strictifyOutputSchema(source)).toMatchObject({
      properties: {
        payload: {
          properties: {
            definitions: { type: "string" },
            $defs: { type: "number" },
          },
        },
      },
    });
  });

  it.each([
    ["external", "https://example.test/schema.json#/$defs/result"],
    ["missing", "#/$defs/missing"],
  ])("rejects %s refs before provider invocation", (_label, ref) => {
    expect(() =>
      normalizeUserOutputSchema({
        type: "object",
        properties: { result: { $ref: ref } },
      }),
    ).toThrow(UnsupportedOutputSchemaError);
  });

  it("rejects cyclic local refs before provider invocation", () => {
    expect(() =>
      normalizeUserOutputSchema({
        type: "object",
        properties: { result: { $ref: "#/$defs/result" } },
        $defs: { result: { $ref: "#/$defs/result" } },
      }),
    ).toThrow(/cyclic local \$ref/);
  });

  it("rejects scoped and sibling ref semantics the native transport cannot preserve", () => {
    expect(() =>
      normalizeUserOutputSchema({
        type: "object",
        properties: {
          nested: {
            $id: "nested.json",
            type: "object",
            properties: { value: { $ref: "#/$defs/value" } },
            $defs: { value: { type: "string" } },
          },
        },
      }),
    ).toThrow(/nested \$id scopes/);

    expect(() =>
      normalizeUserOutputSchema({
        type: "object",
        properties: {
          value: { $ref: "#/$defs/value", minLength: 2 },
        },
        $defs: { value: { type: "string" } },
      }),
    ).toThrow(/\$ref siblings/);
  });

  it("rejects dynamic refs and only lowers equivalent unevaluatedProperties", () => {
    expect(() =>
      normalizeUserOutputSchema({
        type: "object",
        properties: { value: { $dynamicRef: "#value" } },
      }),
    ).toThrow(/\$dynamicRef is unsupported/);

    const simple = strictifyOutputSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      unevaluatedProperties: false,
    });
    expect(simple).not.toHaveProperty("unevaluatedProperties");
    expect(simple).toHaveProperty("additionalProperties", false);

    expect(() =>
      normalizeUserOutputSchema({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
        allOf: [{ properties: { ok: { type: "boolean" } } }],
        unevaluatedProperties: false,
      }),
    ).toThrow(/unevaluatedProperties can be transported only/);
  });

  it("rejects dynamic scope and nested $id hiding under non-keyword container keys", () => {
    // A $ref may point at ANY JSON Pointer and unreferenced non-keyword
    // subtrees ride the transport verbatim, so the scan must cover every
    // node of the document, not just keyword-reachable schema positions.
    expect(() =>
      normalizeUserOutputSchema({
        type: "object",
        properties: { x: { $ref: "#/junk" } },
        junk: { $dynamicRef: "#foo", type: "object" },
      }),
    ).toThrow(/\$dynamicRef is unsupported/);

    // Same class, one level deeper: the dynamic keyword hides under a
    // non-keyword key INSIDE the referenced subtree.
    expect(() =>
      normalizeUserOutputSchema({
        type: "object",
        properties: { x: { $ref: "#/junk" } },
        junk: { type: "object", inner: { $dynamicRef: "#foo" } },
      }),
    ).toThrow(/\$dynamicRef is unsupported/);

    // Unreferenced ad-hoc subtree: still refused (it would be copied
    // verbatim into the vendor transport).
    expect(() =>
      normalizeUserOutputSchema({
        type: "object",
        properties: { ok: { type: "boolean" } },
        junk: { $dynamicRef: "#foo" },
      }),
    ).toThrow(/\$dynamicRef is unsupported/);

    expect(() =>
      normalizeUserOutputSchema({
        type: "object",
        properties: { x: { $ref: "#/junk" } },
        junk: { $id: "junk.json", type: "object" },
      }),
    ).toThrow(/nested \$id scopes/);
  });

  it("rejects a nested $id even without any $ref in the document", () => {
    // The scoped-$id refusal must not be conditional on a $ref being present:
    // an un-referenced nested $id would still ride the transport copy.
    expect(() =>
      normalizeUserOutputSchema({
        type: "object",
        properties: {
          nested: { $id: "nested.json", type: "object", properties: { v: { type: "string" } } },
        },
      }),
    ).toThrow(/nested \$id scopes/);
  });

  it("shape refusals carry the typed invalid_output_schema contract", () => {
    // Fail-closed refusals must flow the daemon's W24 errorCode/errorStatus
    // path exactly like compile failures — never an untyped 500.
    try {
      normalizeUserOutputSchema({
        type: "object",
        properties: { x: { $ref: "https://example.test/remote.json#/x" } },
      });
      expect.unreachable("external $ref must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedOutputSchemaError);
      const typed = err as UnsupportedOutputSchemaError;
      expect(typed.code).toBe("invalid_output_schema");
      expect(typed.status).toBe(400);
      expect(typed.retryable).toBe(false);
      expect(typed.requiredActions).toEqual(["fix the output schema and retry the run"]);
    }
  });

  it("round-trips an own __proto__ key as data instead of dropping it", () => {
    // JSON.parse creates "__proto__" as an OWN property; plain assignment in
    // the transport copy would hit the Object.prototype setter and silently
    // drop the key (and locally repoint the transient object's prototype).
    const schema = JSON.parse(
      '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"__proto__":{"marker":1}}',
    ) as Record<string, unknown>;
    const transport = strictifyOutputSchema(schema);
    expect(Object.getOwnPropertyNames(transport)).toContain("__proto__");
    expect(Object.getPrototypeOf(transport)).toBe(Object.prototype);
    expect(JSON.stringify(transport)).toContain('"__proto__":{"marker":1}');
  });

  it("refuses schema nesting past the typed depth ceiling", () => {
    let leaf: Record<string, unknown> = { type: "boolean" };
    for (let i = 0; i < 300; i++) {
      leaf = { type: "object", properties: { next: leaf } };
    }
    expect(() => normalizeUserOutputSchema(leaf)).toThrow(/nesting exceeds/);
  });

  it("refuses a local-ref expansion that exceeds the transport budget", () => {
    // Each layer references the previous one twice: ~2^N nodes when inlined.
    const schema: Record<string, unknown> = {
      type: "object",
      properties: { root: { $ref: "#/$defs/layer24" } },
      $defs: { layer0: { type: "object", properties: { leaf: { type: "boolean" } } } },
    };
    const defs = schema["$defs"] as Record<string, unknown>;
    for (let i = 1; i <= 24; i++) {
      defs[`layer${i}`] = {
        type: "object",
        properties: {
          a: { $ref: `#/$defs/layer${i - 1}` },
          b: { $ref: `#/$defs/layer${i - 1}` },
        },
      };
    }
    expect(() => strictifyOutputSchema(schema)).toThrow(/exceeds the transport budget/);
  });
});
