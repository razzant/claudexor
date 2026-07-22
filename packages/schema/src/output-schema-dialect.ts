import { z } from "zod";

/** JSON Schema dialects the structured-output validator can compile. */
export const OutputSchemaDialect = z
  .enum(["draft-07", "draft-2020-12"])
  .describe("JSON Schema dialect selected for structured-output validation.");
export type OutputSchemaDialect = z.infer<typeof OutputSchemaDialect>;

export const DEFAULT_OUTPUT_SCHEMA_DIALECT: OutputSchemaDialect = "draft-07";

/**
 * Canonical public identifiers for supported output-schema dialects. The
 * capability catalog and validator both project this list; keep URI aliases
 * private so machines receive one stable identifier per dialect.
 */
export const OUTPUT_SCHEMA_DIALECTS = [
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
] as const satisfies readonly {
  dialect: OutputSchemaDialect;
  uri: string;
  defaultWhenOmitted: boolean;
}[];

/** Resolve accepted http/https and trailing-# spellings to one dialect id. */
export function outputSchemaDialectFromUri(uri: string): OutputSchemaDialect | null {
  const normalized = uri.replace(/#$/, "");
  if (
    normalized === "http://json-schema.org/draft-07/schema" ||
    normalized === "https://json-schema.org/draft-07/schema"
  ) {
    return "draft-07";
  }
  if (
    normalized === "https://json-schema.org/draft/2020-12/schema" ||
    normalized === "http://json-schema.org/draft/2020-12/schema"
  ) {
    return "draft-2020-12";
  }
  return null;
}
