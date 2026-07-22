import { runCapture } from "@claudexor/core";
import { HarnessUnavailableError } from "@claudexor/core";
import { ConformanceReport as ConformanceReportSchema } from "@claudexor/schema";
import type { ConformanceReport } from "@claudexor/schema";

export const BIN = process.env.CLAUDEXOR_CODEX_BIN || "codex";

/**
 * Effective environment for a doctor probe: the scoped DoctorSpec.env is a
 * PATCH over the inherited process env with the same semantics runCapture
 * applies when spawning (null/undefined deletes) — so the broken-install
 * advisory diagnoses exactly the env the version probe spawned in (INV-067).
 */
export function probeEnv(patch?: Record<string, string | null | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
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
  try {
    const r = await runCapture(BIN, ["--version"], {
      timeoutMs: 10_000,
      abortSignal,
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: 0,
      ...(env ? { env } : {}),
    });
    return r.stdout.trim() || `${BIN} (version unknown)`;
  } catch {
    return null;
  }
}

/** The discover() dead-end for a missing CLI, advisory-enriched when the
 *  filesystem still holds evidence of a broken install. */
export function missingCliError(advisory: string | null): HarnessUnavailableError {
  return new HarnessUnavailableError(
    `codex CLI not found on PATH (set CLAUDEXOR_CODEX_BIN to override)${advisory ? ` — ${advisory}` : ""}`,
  );
}

/** The doctor() unavailable report for a missing CLI; wording is unchanged
 *  when there is no advisory evidence. */
export function missingCliReport(advisory: string | null): ConformanceReport {
  return ConformanceReportSchema.parse({
    harness_id: "codex",
    status: "unavailable",
    checks: [
      {
        id: "installed",
        status: "fail",
        detail: advisory ? `codex not found on PATH — ${advisory}` : "codex not found on PATH",
      },
    ],
    reasons: [
      "codex CLI not found (install Codex or set CLAUDEXOR_CODEX_BIN)",
      ...(advisory ? [advisory] : []),
    ],
  });
}
