import { OUTPUT_SCHEMA_DIALECTS } from "@claudexor/schema";
import type { DaemonRunOutcome } from "./daemon-run.js";

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
