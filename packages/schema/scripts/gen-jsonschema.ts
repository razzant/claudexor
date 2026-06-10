/**
 * Generates JSON Schema files from the Zod SSOT into packages/schema/generated/.
 * Run via `pnpm schema:gen`. CI verifies the output is committed and up to date.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  BudgetLease,
  BudgetObservation,
  ControlApplyCheckRequest,
  ControlApplyRequest,
  ControlHarnessSetupRequest,
  ControlHarnessSetupResponse,
  ControlHarnessListResponse,
  ControlQueuedRunInfo,
  ControlRunDetail,
  ControlRunStartInfo,
  ControlRunStartRequest,
  ControlRunSummary,
  ControlRunControlRequest,
  ControlRunControlResponse,
  ControlSecretListResponse,
  ControlSetupJob,
  ControlSetupJobConfirmRequest,
  ControlSetupJobCreateRequest,
  ControlSetupJobEvent,
  ControlSetupJobListResponse,
  ControlSpecFreezeRequest,
  ControlSpecQuestionsRequest,
  ControlSettingsSnapshot,
  ControlHarnessSettingsPatch,
  ControlSettingsUpdateRequest,
  ConformanceReport,
  ContextPack,
  DecisionRecord,
  GateResult,
  GlobalConfig,
  HarnessEvent,
  HarnessManifest,
  HarnessStatusDto,
  ProjectConfig,
  ReviewFinding,
  RouteProof,
  RunEvent,
  RunFailure,
  RunControl,
  RunTelemetry,
  SpecPack,
  TaskContract,
  TrustConfig,
  WorkProduct,
  WorkspaceEnvelope,
  SecretMetadata,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "generated");
mkdirSync(outDir, { recursive: true });
for (const name of readdirSync(outDir)) {
  if (name.endsWith(".schema.json")) rmSync(join(outDir, name));
}

const schemas = {
  TaskContract,
  ContextPack,
  HarnessManifest,
  ConformanceReport,
  ReviewFinding,
  WorkProduct,
  BudgetLease,
  BudgetObservation,
  RouteProof,
  DecisionRecord,
  GateResult,
  RunEvent,
  RunTelemetry,
  HarnessEvent,
  SpecPack,
  ProjectConfig,
  GlobalConfig,
  TrustConfig,
  WorkspaceEnvelope,
  ControlRunStartRequest,
  ControlRunStartInfo,
  ControlQueuedRunInfo,
  ControlRunSummary,
  ControlRunDetail,
  RunFailure,
  RunControl,
  ControlRunControlRequest,
  ControlRunControlResponse,
  ControlApplyCheckRequest,
  ControlApplyRequest,
  ControlHarnessSetupRequest,
  ControlHarnessSetupResponse,
  ControlSetupJob,
  ControlSetupJobConfirmRequest,
  ControlSetupJobCreateRequest,
  ControlSetupJobEvent,
  ControlSetupJobListResponse,
  ControlSpecQuestionsRequest,
  ControlSpecFreezeRequest,
  HarnessStatusDto,
  ControlHarnessListResponse,
  ControlSettingsSnapshot,
  ControlHarnessSettingsPatch,
  ControlSettingsUpdateRequest,
  SecretMetadata,
  ControlSecretListResponse,
} as const;

for (const [name, schema] of Object.entries(schemas)) {
  const json = zodToJsonSchema(schema, { name, target: "jsonSchema2020-12" });
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(json, null, 2) + "\n");
}

console.log(`Wrote ${Object.keys(schemas).length} JSON schemas to ${outDir}`);
