import { redactSecrets, safeProblemContext, safeProblemRequiredActions } from "@claudexor/util";

export const JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobRecord {
  id: string;
  state: JobState;
  params: unknown;
  result?: unknown;
  error?: string;
  errorCode?: string;
  errorStatus?: number;
  errorRetryable?: boolean;
  errorRequiredActions?: string[];
  errorContext?: Record<string, unknown>;
  createdAt: string;
  runId?: string;
  taskId?: string;
  runDir?: string;
  startedAt?: string;
  finishedAt?: string;
}

export function jobStateFromResult(result: unknown, aborted: boolean): JobState {
  // The engine's synchronous terminal commit is the cutoff. A recognizable
  // lifecycle already reflects any abort present at that boundary, while a
  // later abort must not rewrite the durable result.
  const lifecycle = resultString(result, "lifecycle");
  if (
    lifecycle === "succeeded" ||
    lifecycle === "failed" ||
    lifecycle === "cancelled" ||
    lifecycle === "interrupted"
  ) {
    return lifecycle;
  }
  // Preserve the daemon's fail-closed fallback for a malformed runner result.
  return aborted ? "cancelled" : "failed";
}

export function resultReason(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  return resultString((result as Record<string, unknown>)["facts"], "reason");
}

export function resultSummary(result: unknown): string | null {
  return resultString(result, "summary");
}

export function publicJobRecord(record: JobRecord): JobRecord {
  return {
    ...record,
    error: record.error ? redactSecrets(record.error) : undefined,
    ...(record.errorRequiredActions
      ? { errorRequiredActions: safeProblemRequiredActions(record.errorRequiredActions) }
      : {}),
    ...(record.errorContext ? { errorContext: safeProblemContext(record.errorContext) } : {}),
    // Params are the exact request (Exact Retry and Run Again read them back).
    params:
      record.params &&
      typeof record.params === "object" &&
      (record.params as { kind?: string }).kind === "account_reset"
        ? { kind: "account_reset", request: (record.params as { request: unknown }).request }
        : record.params,
  };
}

function resultString(result: unknown, key: string): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}
