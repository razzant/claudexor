import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";
import {
  RunFactsInvalidError,
  validateRunFactsReceipt,
  type ExpectedRunFactsIdentity,
  type RunFacts as RunFactsType,
} from "@claudexor/schema";

type RunDetail = Record<string, unknown> | null;

// The pure shape/identity validation and its typed refusal live in ONE shared
// owner (@claudexor/schema, S2); this module keeps only the CLI's own
// filesystem guards and detail plumbing.
export type { ExpectedRunFactsIdentity } from "@claudexor/schema";

export type ApplyEligibilityProjection = {
  eligible: boolean;
  state: string | null;
  reason: string | null;
  requiredAction: string | null;
};

/** Exact validated terminal receipt from an already-fetched run detail. */
export function projectRunFacts(
  detail: RunDetail,
  expected: ExpectedRunFactsIdentity = {},
): RunFactsType | null {
  if (!detail) return null;
  const value = detail["runFacts"];
  if (value === null || value === undefined) return null;
  return validateRunFactsReceipt(value, expectedIdentityFromDetail(detail, expected));
}

/** Pure projection of the delivery-gate verdict from an already-fetched detail. */
export function projectApplyEligibility(detail: RunDetail): ApplyEligibilityProjection | null {
  if (!detail) return null;
  const value = detail["applyEligibility"];
  return value && typeof value === "object" ? (value as ApplyEligibilityProjection) : null;
}

/** Pure projection of the server-owned outcome banner from a fetched detail. */
export function projectOutcomeBanner(detail: RunDetail): string | null {
  if (!detail) return null;
  const banner = detail["outcomeBanner"];
  return typeof banner === "string" && banner.length > 0 ? banner : null;
}

/**
 * Shared fields appended to both terminal machine surfaces. RunFacts is
 * intentionally always present; only a genuinely missing legacy receipt
 * projects to null, while present malformed data fails loudly.
 */
export function projectTerminalDetailFields(
  detail: RunDetail,
  expected: ExpectedRunFactsIdentity = {},
): {
  outcomeBanner?: string;
  applyEligibility?: ApplyEligibilityProjection;
  runFacts: RunFactsType | null;
} {
  const outcomeBanner = projectOutcomeBanner(detail);
  const applyEligibility = projectApplyEligibility(detail);
  return {
    ...(outcomeBanner ? { outcomeBanner } : {}),
    ...(applyEligibility ? { applyEligibility } : {}),
    runFacts: projectRunFacts(detail, expected),
  };
}

type YamlArtifactReader = {
  readYaml(path: string): unknown;
};

/** Read the canonical immutable RunFacts artifact without reconstructing it. */
export function readRunFactsArtifact(
  reader: YamlArtifactReader,
  finalDir: string,
  expected: ExpectedRunFactsIdentity = {},
): RunFactsType | null {
  const path = join(finalDir, "run_facts.yaml");
  const finalDirStat = lstatOrNull(finalDir);
  if (finalDirStat === null) return null;
  if (!finalDirStat.isDirectory() || finalDirStat.isSymbolicLink()) {
    throw new RunFactsInvalidError();
  }

  const artifactStat = lstatOrNull(path);
  if (artifactStat === null) return null;
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) throw new RunFactsInvalidError();

  let raw: unknown;
  try {
    raw = reader.readYaml(path);
  } catch {
    throw new RunFactsInvalidError();
  }
  return validateRunFactsReceipt(raw, expected);
}

function expectedIdentityFromDetail(
  detail: Exclude<RunDetail, null>,
  expected: ExpectedRunFactsIdentity,
): ExpectedRunFactsIdentity {
  const summary = detail["summary"];
  if (!summary || typeof summary !== "object") return expected;
  const record = summary as Record<string, unknown>;
  const summaryRunId = typeof record["runId"] === "string" ? record["runId"] : undefined;
  const summaryTaskId = typeof record["taskId"] === "string" ? record["taskId"] : undefined;
  if (
    (expected.runId !== undefined &&
      summaryRunId !== undefined &&
      expected.runId !== summaryRunId) ||
    (expected.taskId !== undefined &&
      summaryTaskId !== undefined &&
      expected.taskId !== summaryTaskId)
  ) {
    throw new RunFactsInvalidError();
  }
  return {
    runId: expected.runId ?? summaryRunId,
    taskId: expected.taskId ?? summaryTaskId,
    ...(expected.lifecycle !== undefined ? { lifecycle: expected.lifecycle } : {}),
  };
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw new RunFactsInvalidError();
  }
}
