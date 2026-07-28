import { OUTPUT_SCHEMA_DIALECTS, RunOutcomeFacts } from "@claudexor/schema";
import type { DaemonRunOutcome } from "./daemon-run.js";

/** Pure projection of the D8 outcome facts (incl. the D-16 work_state) from an
 * already-fetched run detail — lets the terminal path derive facts from the SAME
 * GET /runs/:id the banner and apply-eligibility projections read (INV-120/122),
 * not a third round-trip. Null when the detail is missing or malformed. */
export function projectRunOutcomeFacts(
  detail: Record<string, unknown> | null,
): RunOutcomeFacts | null {
  const summary =
    detail && typeof detail === "object"
      ? (detail as { summary?: { outcomeFacts?: unknown } }).summary
      : undefined;
  const parsed = RunOutcomeFacts.safeParse(summary?.outcomeFacts);
  return parsed.success ? parsed.data : null;
}

/** Additive typed fields for a terminal daemon refusal. The daemon remains
 * the source of code/status/retryability; domain catalogs enrich only their
 * own code with stable machine-readable remedies. */
export function daemonOutcomeProblemFields(out: DaemonRunOutcome): Record<string, unknown> {
  if (!out.errorCode) return {};
  return {
    code: out.errorCode,
    ...(out.errorStatus !== undefined ? { errorStatus: out.errorStatus } : {}),
    ...(out.errorRetryable !== undefined ? { retryable: out.errorRetryable } : {}),
    ...(out.errorCode === "unsupported_schema_dialect"
      ? {
          supportedDialects: OUTPUT_SCHEMA_DIALECTS.map(({ dialect, uri }) => ({ dialect, uri })),
        }
      : {}),
  };
}

export function mergeDaemonRunOutcome(
  started: DaemonRunOutcome,
  final: {
    state?: string;
    runDir?: string;
    error?: string;
    errorCode?: string;
    errorStatus?: number;
  } | null,
): DaemonRunOutcome {
  return {
    ...started,
    runDir: final?.runDir ?? started.runDir,
    status: final?.state ?? started.status,
    error: final?.error ?? started.error,
    errorCode: final?.errorCode ?? started.errorCode,
    errorStatus: final?.errorStatus ?? started.errorStatus,
  };
}
