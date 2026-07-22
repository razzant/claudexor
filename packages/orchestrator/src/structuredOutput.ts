import { join } from "node:path";
import AjvModule from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

// ajv ships CJS; under NodeNext the default import resolves to the module
// namespace whose `.default` is the constructor (module.exports.default is set
// by ajv itself, so this is correct at runtime in both ESM and CJS).
const Ajv = AjvModule.default ?? (AjvModule as unknown as typeof AjvModule.default);
const Ajv2020 = Ajv2020Module.default ?? (Ajv2020Module as unknown as typeof Ajv2020Module.default);
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import {
  DEFAULT_OUTPUT_SCHEMA_DIALECT,
  OUTPUT_SCHEMA_DIALECTS,
  outputSchemaDialectFromUri,
  SCHEMA_VERSION,
  StructuredOutputConformance,
  type OutputSchemaDialect,
} from "@claudexor/schema";
import { hashJson, nowIso } from "@claudexor/util";

export interface StructuredOutputVerdict {
  status: "passed" | "failed";
  reason: string | null;
}

/** A declared dialect is caller-actionable, not a retryable engine failure. */
export class UnsupportedOutputSchemaDialectError extends Error {
  readonly status = 400;
  readonly code = "unsupported_schema_dialect";
  readonly retryable = false;
  readonly supportedDialects = OUTPUT_SCHEMA_DIALECTS.map(({ dialect, uri }) => ({ dialect, uri }));
  readonly context = { supportedDialects: this.supportedDialects };
  readonly requiredActions = [
    `set $schema to one of: ${OUTPUT_SCHEMA_DIALECTS.map(({ uri }) => uri).join(", ")}; or omit $schema for ${DEFAULT_OUTPUT_SCHEMA_DIALECT}`,
  ];

  constructor(readonly dialect: unknown) {
    super(
      `unsupported outputSchema dialect ${JSON.stringify(dialect)}; supported dialects: ${OUTPUT_SCHEMA_DIALECTS.map(({ uri }) => uri).join(", ")} (omitted $schema defaults to ${DEFAULT_OUTPUT_SCHEMA_DIALECT})`,
    );
    this.name = "UnsupportedOutputSchemaDialectError";
  }
}

/** A malformed schema is a caller error and retrying the same input cannot help. */
export class InvalidOutputSchemaError extends Error {
  readonly status = 400;
  readonly code = "invalid_output_schema";
  readonly retryable = false;
  readonly requiredActions = ["fix the output schema and retry the run"];

  constructor(cause: unknown) {
    super(
      `outputSchema is not a compilable JSON Schema: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "InvalidOutputSchemaError";
  }
}

function outputSchemaDialect(schema: Record<string, unknown>): OutputSchemaDialect {
  const declared = schema["$schema"];
  if (declared === undefined) return DEFAULT_OUTPUT_SCHEMA_DIALECT;
  if (typeof declared !== "string") throw new UnsupportedOutputSchemaDialectError(declared);
  const dialect = outputSchemaDialectFromUri(declared);
  if (dialect) return dialect;
  throw new UnsupportedOutputSchemaDialectError(declared);
}

function outputSchemaCompiler(schema: Record<string, unknown>): {
  ajv: InstanceType<typeof Ajv> | InstanceType<typeof Ajv2020>;
  schema: Record<string, unknown>;
} {
  const dialect = outputSchemaDialect(schema);
  // The selected Ajv class already fixes the dialect. Removing the declaration
  // lets us accept the URI's harmless http/https and trailing-# spellings while
  // still compiling the caller's validation keywords under the declared draft.
  const schemaForCompiler = { ...schema };
  delete schemaForCompiler["$schema"];
  return {
    ajv:
      dialect === "draft-2020-12"
        ? new Ajv2020({ allErrors: true, strict: false })
        : new Ajv({ allErrors: true, strict: false }),
    schema: schemaForCompiler,
  };
}

/** Preflight: prove a caller schema COMPILES under the same ajv the validator
 *  uses, so a malformed schema is refused before any run dir exists instead of
 *  crashing the validator mid-run. Throws on a schema ajv cannot build. */
export function assertOutputSchemaCompiles(schema: Record<string, unknown>): void {
  const compiler = outputSchemaCompiler(schema);
  try {
    compiler.ajv.compile(compiler.schema);
  } catch (err) {
    throw new InvalidOutputSchemaError(err);
  }
}

/**
 * The ONE engine validator for a run's structured-output contract (Quiz-6a).
 * The `schema` here is the CALLER's ORIGINAL contract (the conformance
 * authority) — NEVER the vendor-strictified transport form, which would falsely
 * pass e.g. `{"field":null}` for an optional string. Every capable lane was
 * constrained natively at preflight; this turns the winner's answer text into a
 * typed conformance receipt (final/structured_output.yaml). A non-conformant
 * answer is a FAILED receipt, never a failed run — the run stays
 * success-with-warnings and the embedder retries on the receipt.
 *
 * Only a CONFORMANT answer becomes final/output.json (the primary
 * structured_output artifact must never surface known-invalid data). A
 * parsed-but-non-conformant answer is preserved under final/output.invalid.json
 * (diagnostic) for the embedder to inspect; an unparsable answer writes nothing.
 */
export function finalizeStructuredOutput(opts: {
  store: ArtifactStore;
  finalDir: string;
  log: EventLog;
  schema: Record<string, unknown>;
  answerText: string | null | undefined;
}): StructuredOutputVerdict {
  const schemaDialect = outputSchemaDialect(opts.schema);
  const text = opts.answerText?.trim() ?? "";
  let value: unknown;
  let parsed = false;
  let reason: string | null = null;
  if (!text) {
    reason = "the run produced no final answer text to validate";
  } else {
    try {
      value = JSON.parse(text);
      parsed = true;
    } catch {
      // Mandatory native constraining means the answer SHOULD be pure JSON;
      // anything else is honestly non-conformant (no fenced-block salvage).
      reason = "final answer is not valid JSON";
    }
  }
  let status: "passed" | "failed" = "failed";
  if (parsed) {
    // strict:false — accept the JSON Schema dialect as-authored; do not
    // re-litigate meta-schema strictness (the boundary already proved it
    // compiles). This validates the ORIGINAL caller schema.
    const compiler = outputSchemaCompiler(opts.schema);
    try {
      const validate = compiler.ajv.compile(compiler.schema);
      if (validate(value) === true) {
        status = "passed";
      } else {
        reason =
          (validate.errors ?? [])
            .map((e: ErrorObject) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`)
            .join("; ")
            .slice(0, 1000) || "schema validation failed";
      }
    } catch (err) {
      reason = `output schema failed to compile: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Conformant → the canonical output.json (a valid primary artifact).
  // Parsed-but-invalid → a DIAGNOSTIC file, never the primary structured output.
  let outputPath: string | null = null;
  if (parsed && status === "passed") {
    opts.store.writeText(join(opts.finalDir, "output.json"), JSON.stringify(value, null, 2) + "\n");
    outputPath = "final/output.json";
  } else if (parsed) {
    opts.store.writeText(
      join(opts.finalDir, "output.invalid.json"),
      JSON.stringify(value, null, 2) + "\n",
    );
    outputPath = "final/output.invalid.json";
  }
  const receipt = StructuredOutputConformance.parse({
    schema_version: SCHEMA_VERSION,
    schema_dialect: schemaDialect,
    schema_hash: hashJson(opts.schema),
    status,
    reason: status === "passed" ? null : reason,
    output_path: outputPath,
    generated_at: nowIso(),
  });
  opts.store.writeYaml(join(opts.finalDir, "structured_output.yaml"), receipt);
  if (outputPath) {
    opts.log.emit("output.ready", {
      kind: "structured_output",
      path: outputPath,
      ...(status === "passed" ? {} : { state: "diagnostic" }),
    });
  }
  return { status, reason: receipt.reason };
}
