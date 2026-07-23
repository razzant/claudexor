import { OUTPUT_SCHEMA_DIALECTS, type ControlProblem } from "@claudexor/schema";
import { controlProblemError } from "@claudexor/control-api";
import type { DaemonRunOutcome } from "./daemon-run.js";

/** Additive typed fields for a terminal daemon refusal. */
export function daemonOutcomeProblemFields(out: DaemonRunOutcome): Record<string, unknown> {
  if (out.problem) {
    return {
      ...out.problem,
      ...(out.errorStatus !== undefined ? { errorStatus: out.errorStatus } : {}),
    };
  }
  if (!out.errorCode) return {};
  return {
    code: out.errorCode,
    ...(out.errorStatus !== undefined ? { errorStatus: out.errorStatus } : {}),
    ...(out.errorRetryable !== undefined ? { retryable: out.errorRetryable } : {}),
  };
}

/** Historical projection for the NDJSON stream surface. Issue #28 deliberately
 * leaves that multi-frame protocol unchanged while stabilizing single-object
 * `--json` failures. */
export function legacyDaemonOutcomeProblemFields(out: DaemonRunOutcome): Record<string, unknown> {
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

export function daemonOutcomeFailure(out: DaemonRunOutcome): Error {
  return controlProblemError(out.errorStatus ?? 500, {
    ...(out.problem ?? {}),
    code: out.problem?.code ?? out.errorCode,
    message: out.problem?.message ?? out.error ?? "run failed before it started",
    retryable: out.problem?.retryable ?? out.errorRetryable ?? false,
  });
}

export function mergeDaemonRunOutcome(
  started: DaemonRunOutcome,
  final: {
    state?: string;
    runDir?: string;
    error?: string;
    errorCode?: string;
    errorStatus?: number;
    problem?: ControlProblem;
  } | null,
): DaemonRunOutcome {
  return {
    ...started,
    runDir: final?.runDir ?? started.runDir,
    status: final?.state ?? started.status,
    error: final?.error ?? started.error,
    errorCode: final?.errorCode ?? started.errorCode,
    errorStatus: final?.errorStatus ?? started.errorStatus,
    problem: final?.problem ?? started.problem,
  };
}
