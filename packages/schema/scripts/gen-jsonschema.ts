/**
 * Generates JSON Schema files from the Zod SSOT into packages/schema/generated/.
 * Run via `pnpm schema:gen`. CI verifies the output is committed and up to date.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  BudgetLease,
  ConformanceReport,
  ContextPack,
  DecisionRecord,
  GateResult,
  GlobalConfig,
  HarnessManifest,
  ProjectConfig,
  ReviewFinding,
  RouteProof,
  RunEvent,
  TaskContract,
  TrustConfig,
  WorkProduct,
  WorkspaceEnvelope,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "generated");
mkdirSync(outDir, { recursive: true });

const schemas = {
  TaskContract,
  ContextPack,
  HarnessManifest,
  ConformanceReport,
  ReviewFinding,
  WorkProduct,
  BudgetLease,
  RouteProof,
  DecisionRecord,
  GateResult,
  RunEvent,
  ProjectConfig,
  GlobalConfig,
  TrustConfig,
  WorkspaceEnvelope,
} as const;

for (const [name, schema] of Object.entries(schemas)) {
  const json = zodToJsonSchema(schema, { name, target: "jsonSchema2020-12" });
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(json, null, 2) + "\n");
}

console.log(`Wrote ${Object.keys(schemas).length} JSON schemas to ${outDir}`);
