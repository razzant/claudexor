import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import { hashJson } from "@claudexor/util";
import { describe, expect, it } from "vitest";
import {
  assertOutputSchemaCompiles,
  finalizeStructuredOutput,
  InvalidOutputSchemaError,
  UnsupportedOutputSchemaDialectError,
} from "./structuredOutput.js";

const draft202012Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    tuple: {
      type: "array",
      prefixItems: [{ type: "string" }],
      items: false,
    },
  },
  required: ["tuple"],
  additionalProperties: false,
};

describe("structured output schema dialects", () => {
  it("compiles and validates a declared draft 2020-12 schema", () => {
    assertOutputSchemaCompiles(draft202012Schema);

    const root = mkdtempSync(join(tmpdir(), "claudexor-structured-output-"));
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-test");
    const log = new EventLog(paths.eventsPath, "run-test", "task-test");
    const verdict = finalizeStructuredOutput({
      store,
      finalDir: paths.finalDir,
      log,
      schema: draft202012Schema,
      answerText: JSON.stringify({ tuple: ["ok"] }),
    });

    expect(verdict).toEqual({ status: "passed", reason: null });
    expect(JSON.parse(readFileSync(join(paths.finalDir, "output.json"), "utf8"))).toEqual({
      tuple: ["ok"],
    });
    expect(store.readYaml(join(paths.finalDir, "structured_output.yaml"))).toMatchObject({
      schema_dialect: "draft-2020-12",
      schema_hash: hashJson(draft202012Schema),
      status: "passed",
    });
    log.dispose();
  });

  it("enforces draft 2020-12 unevaluatedProperties semantics", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      allOf: [{ properties: { ok: { type: "boolean" } }, required: ["ok"] }],
      unevaluatedProperties: false,
    };
    assertOutputSchemaCompiles(schema);

    const root = mkdtempSync(join(tmpdir(), "claudexor-structured-output-"));
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-unevaluated");
    const log = new EventLog(paths.eventsPath, "run-unevaluated", "task-test");
    const verdict = finalizeStructuredOutput({
      store,
      finalDir: paths.finalDir,
      log,
      schema,
      answerText: JSON.stringify({ ok: true, extra: true }),
    });

    expect(verdict.status).toBe("failed");
    expect(verdict.reason).toContain("unevaluated properties");
    expect(store.readYaml(join(paths.finalDir, "structured_output.yaml"))).toMatchObject({
      schema_dialect: "draft-2020-12",
      status: "failed",
    });
    log.dispose();
  });

  it.each([
    ["omitted", undefined],
    ["declared", "http://json-schema.org/draft-07/schema#"],
  ])("keeps %s $schema backward-compatible with draft-07", (_label, dialect) => {
    expect(() => {
      const schema: Record<string, unknown> = {
        type: "object",
        properties: { ok: { type: "boolean" } },
      };
      if (dialect) schema["$schema"] = dialect;
      assertOutputSchemaCompiles(schema);
    }).not.toThrow();
  });

  it("rejects an unknown declared dialect with a typed actionable error", () => {
    try {
      assertOutputSchemaCompiles({
        $schema: "https://example.test/custom-schema",
        type: "object",
        properties: {},
      });
      throw new Error("expected the schema dialect to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedOutputSchemaDialectError);
      expect(error).toMatchObject({
        code: "unsupported_schema_dialect",
        retryable: false,
        status: 400,
        supportedDialects: [
          { dialect: "draft-07", uri: "http://json-schema.org/draft-07/schema#" },
          {
            dialect: "draft-2020-12",
            uri: "https://json-schema.org/draft/2020-12/schema",
          },
        ],
      });
    }
  });

  it("rejects a malformed schema with a typed non-retryable error", () => {
    try {
      assertOutputSchemaCompiles({ type: "definitely-not-a-json-schema-type" });
      throw new Error("expected the malformed schema to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidOutputSchemaError);
      expect(error).toMatchObject({
        code: "invalid_output_schema",
        retryable: false,
        status: 400,
      });
    }
  });
});
