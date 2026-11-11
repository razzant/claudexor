import { CODEX_PROGRAM } from "./program.js";
import { selectProgramLauncher, resolveSelectedProgramAsync } from "@claudexor/core";
import { isAbsolute } from "node:path";
import { composeBaseEnv } from "@claudexor/core";
import { HarnessUnavailableError } from "@claudexor/core";
import { ConformanceReport as ConformanceReportSchema } from "@claudexor/schema";
import type { ConformanceReport } from "@claudexor/schema";

export const resolveCodexBin = () => selectProgramLauncher(CODEX_PROGRAM);

/**
 * Effective environment for a doctor probe: the scoped DoctorSpec.env is a
 * PATCH over the normalized host env with the same semantics runCapture
 * applies when spawning (null/undefined deletes) — so the broken-install
 * advisory diagnoses exactly the env the version probe spawned in (INV-067).
 */
export function probeEnv(patch?: Record<string, string | null | undefined>): NodeJS.ProcessEnv {
  const env = composeBaseEnv("mirror_native");
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

export async function detectVersion(
  abortSignal?: AbortSignal,
  env?: Record<string, string | null | undefined>,
): Promise<string | null> {
  const environment = probeEnv(env);
  return (
    await resolveSelectedProgramAsync(CODEX_PROGRAM, {
      environment,
      sourceEnv: environment,
      abortSignal,
    })
  ).versionOutput;
}

/** An absolute override was never a PATH lookup — say what actually failed. */
function deadEnd(bin: string): string {
  return isAbsolute(bin) ? `codex override ${bin} is not runnable` : "codex not found on PATH";
}

/** The discover() dead-end for a missing CLI, advisory-enriched when the
 *  filesystem still holds evidence of a broken install. */
export function missingCliError(
  advisory: string | null,
  bin: string = resolveCodexBin(),
): HarnessUnavailableError {
  const summary = isAbsolute(bin)
    ? `codex CLI override ${bin} is not runnable (fix CLAUDEXOR_CODEX_BIN)`
    : "codex CLI not found on PATH (set CLAUDEXOR_CODEX_BIN to override)";
  return new HarnessUnavailableError(`${summary}${advisory ? ` — ${advisory}` : ""}`);
}

/** The doctor() unavailable report for a missing CLI; wording is unchanged
 *  when there is no advisory evidence. */
export function missingCliReport(
  advisory: string | null,
  bin: string = resolveCodexBin(),
): ConformanceReport {
  return ConformanceReportSchema.parse({
    harness_id: "codex",
    status: "unavailable",
    checks: [
      {
        id: "installed",
        status: "fail",
        detail: advisory ? `${deadEnd(bin)} — ${advisory}` : deadEnd(bin),
      },
    ],
    reasons: [
      isAbsolute(bin)
        ? `codex CLI override ${bin} is not runnable (fix CLAUDEXOR_CODEX_BIN)`
        : "codex CLI not found (install Codex or set CLAUDEXOR_CODEX_BIN)",
      ...(advisory ? [advisory] : []),
    ],
  });
}

/** A usable fallback remains installed; skipped preferred entries are diagnostic. */
export function installedCliCheck(version: string, path: string | null, advisory: string | null) {
  return {
    id: "installed",
    status: "pass" as const,
    detail: [path ? `${version} at ${path}` : version, advisory].filter(Boolean).join(" — "),
  };
}
