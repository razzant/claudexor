import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_SCHEMA_DIALECT,
  OUTPUT_SCHEMA_DIALECTS,
  outputSchemaDialectFromUri,
} from "./output-schema-dialect.js";
import { SCHEMA_VERSION } from "./primitives.js";
import { StructuredOutputConformance } from "./telemetry.js";

describe("output schema dialect contract", () => {
  it("publishes one canonical URI per supported dialect", () => {
    expect(DEFAULT_OUTPUT_SCHEMA_DIALECT).toBe("draft-07");
    expect(OUTPUT_SCHEMA_DIALECTS).toEqual([
      {
        dialect: "draft-07",
        uri: "http://json-schema.org/draft-07/schema#",
        defaultWhenOmitted: true,
      },
      {
        dialect: "draft-2020-12",
        uri: "https://json-schema.org/draft/2020-12/schema",
        defaultWhenOmitted: false,
      },
    ]);
  });

  it("normalizes accepted URI spellings and refuses unknown dialects", () => {
    expect(outputSchemaDialectFromUri("https://json-schema.org/draft-07/schema#")).toBe("draft-07");
    expect(outputSchemaDialectFromUri("http://json-schema.org/draft/2020-12/schema#")).toBe(
      "draft-2020-12",
    );
    expect(outputSchemaDialectFromUri("https://json-schema.org/draft/2019-09/schema")).toBeNull();
  });

  it("keeps receipts written before dialect identity readable", () => {
    const parsed = StructuredOutputConformance.parse({
      schema_version: SCHEMA_VERSION,
      status: "passed",
      reason: null,
      output_path: "final/output.json",
      generated_at: "2026-07-22T00:00:00.000Z",
    });
    expect(parsed.schema_dialect).toBeNull();
    expect(parsed.schema_hash).toBeNull();
  });
});
