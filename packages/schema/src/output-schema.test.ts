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
});
