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
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

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

    const root = reapMk(join(tmpdir(), "claudexor-structured-output-"));
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

    expect(verdict).toEqual({ status: "passed", reason: null, normalizedOptionalNulls: 0 });
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

  it("restores an adapter-created optional null before validating the original schema", () => {
    const schema = {
      type: "object",
      properties: { note: { type: "string" } },
      required: [],
      additionalProperties: false,
    };
    const root = reapMk(join(tmpdir(), "claudexor-structured-output-"));
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-optional-null");
    const log = new EventLog(paths.eventsPath, "run-optional-null", "task-test");
    const verdict = finalizeStructuredOutput({
      store,
      finalDir: paths.finalDir,
      log,
      schema,
      answerText: JSON.stringify({ note: null }),
      transportStrictified: true,
    });
    expect(verdict).toEqual({ status: "passed", reason: null, normalizedOptionalNulls: 1 });
    expect(JSON.parse(readFileSync(join(paths.finalDir, "output.json"), "utf8"))).toEqual({});
    expect(store.readYaml(join(paths.finalDir, "structured_output.yaml"))).toMatchObject({
      status: "passed",
      normalized_optional_nulls: 1,
    });
    log.dispose();
  });

  it("does not restore caller nulls when strict transport provenance is absent", () => {
    const schema = { type: "object", properties: { note: { type: "string" } }, required: [] };
    const root = reapMk(join(tmpdir(), "claudexor-structured-output-"));
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-nonstrict-null");
    const log = new EventLog(paths.eventsPath, "run-nonstrict-null", "task-test");
    const verdict = finalizeStructuredOutput({
      store,
      finalDir: paths.finalDir,
      log,
      schema,
      answerText: JSON.stringify({ note: null }),
      transportStrictified: false,
    });
    expect(verdict).toEqual({
      status: "failed",
      reason: "/note: must be string",
      normalizedOptionalNulls: 0,
    });
    expect(JSON.parse(readFileSync(join(paths.finalDir, "output.invalid.json"), "utf8"))).toEqual({
      note: null,
    });
    log.dispose();
  });

  it("keeps required null invalid after optional-null restoration", () => {
    const schema = {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    };
    const root = reapMk(join(tmpdir(), "claudexor-structured-output-"));
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-required-null");
    const log = new EventLog(paths.eventsPath, "run-required-null", "task-test");
    const verdict = finalizeStructuredOutput({
      store,
      finalDir: paths.finalDir,
      log,
      schema,
      answerText: JSON.stringify({ note: null }),
      transportStrictified: true,
    });
    expect(verdict.status).toBe("failed");
    expect(verdict.normalizedOptionalNulls).toBe(0);
    expect(JSON.parse(readFileSync(join(paths.finalDir, "output.invalid.json"), "utf8"))).toEqual({
      note: null,
    });
    log.dispose();
  });

  it("preserves substantive PASS/FAIL findings while restoring absent obligations", () => {
    const schema = {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              item: { type: "string" },
              verdict: { type: "string", enum: ["PASS", "FAIL"] },
              severity: { type: "string", enum: ["critical", "advisory"] },
              reason: { type: "string" },
              obligation_id: { type: "string" },
            },
            required: ["item", "verdict", "severity", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["findings"],
      additionalProperties: false,
    };
    const root = reapMk(join(tmpdir(), "claudexor-structured-output-"));
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-review-findings");
    const log = new EventLog(paths.eventsPath, "run-review-findings", "task-test");
    const verdict = finalizeStructuredOutput({
      store,
      finalDir: paths.finalDir,
      log,
      schema,
      answerText: JSON.stringify({
        findings: [
          {
            item: "quality",
            verdict: "FAIL",
            severity: "critical",
            reason: "broken",
            obligation_id: null,
          },
          {
            item: "docs",
            verdict: "PASS",
            severity: "advisory",
            reason: "clear",
            obligation_id: null,
          },
        ],
      }),
      transportStrictified: true,
    });
    expect(verdict).toEqual({ status: "passed", reason: null, normalizedOptionalNulls: 2 });
    expect(JSON.parse(readFileSync(join(paths.finalDir, "output.json"), "utf8"))).toEqual({
      findings: [
        { item: "quality", verdict: "FAIL", severity: "critical", reason: "broken" },
        { item: "docs", verdict: "PASS", severity: "advisory", reason: "clear" },
      ],
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

    const root = reapMk(join(tmpdir(), "claudexor-structured-output-"));
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
