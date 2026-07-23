import { OUTPUT_SCHEMA_DIALECTS, RunOutcomeFacts } from "@claudexor/schema";
import { controlApiFetch, type ControlApiAddress } from "./live.js";
import type { DaemonRunOutcome } from "./daemon-run.js";

/** Fetch the run's terminal outcome facts (D8 axes incl. the D-16 work_state)
 * from the run detail; null when unavailable. Used to make the direct-run CLI
 * exit outcome-aware for a work_state veto. */
export async function fetchRunOutcomeFacts(
  addr: ControlApiAddress,
  runId: string,
): Promise<RunOutcomeFacts | null> {
  if (!runId) return null;
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
    if (!res.ok) return null;
    const detail = (await res.json()) as { summary?: { outcomeFacts?: unknown } };
    const parsed = RunOutcomeFacts.safeParse(detail.summary?.outcomeFacts);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
