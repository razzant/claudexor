import { runFilesExpired } from "@claudexor/workspace";
import type { JobRecord } from "./job-record.js";

/** Expiration is irreversible even while its asynchronous cleanup is pending.
 * Called synchronously before a NEW command claim; idempotent receipt replay
 * stays ahead of admission and never revives or requires expired source bytes. */
export function assertUnexpiredRunFiles(
  record: Pick<JobRecord, "id" | "runId" | "runDir"> | undefined,
): void {
  if (!record?.runDir) return;
  if (!runFilesExpired(record.runDir)) return;
  throw Object.assign(new Error(`run ${record.runId ?? record.id} expired by retention`), {
    code: "run_expired_by_retention",
    status: 410,
    retryable: false,
    requiredActions: ["Use Run Again to start a new run; expired evidence cannot be reused."],
  });
}
