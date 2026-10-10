import { COMMAND_SUMMARY_PARAM_KEYS, type CommandSummaryParams } from "../schema/index.js";
import { redactSecrets } from "../util/index.js";
import { publicJobRecord, type JobRecord } from "./job-record.js";
import { selectProductCommands } from "./command-retention.js";
import { parseCommandListQuery } from "./command-list-select.js";

/** Collections carry only the request facts their consumers use, never full
 * params/results. Keep the historical redacted 240-character HTTP preview. */
export function compactCommandRecord(record: JobRecord): JobRecord & { promptPreview?: string } {
  const source =
    record.params && typeof record.params === "object"
      ? (record.params as Record<string, unknown>)
      : {};
  const params: CommandSummaryParams = {};
  for (const key of COMMAND_SUMMARY_PARAM_KEYS) {
    if (source[key] !== undefined) (params as Record<string, unknown>)[key] = source[key];
  }
  const prompt = typeof source.prompt === "string" ? redactSecrets(source.prompt) : undefined;
  return publicJobRecord({
    id: record.id,
    state: record.state,
    createdAt: record.createdAt,
    runId: record.runId,
    taskId: record.taskId,
    runDir: record.runDir,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
    errorCode: record.errorCode,
    errorStatus: record.errorStatus,
    errorRetryable: record.errorRetryable,
    errorRequiredActions: record.errorRequiredActions,
    errorContext: record.errorContext,
    params,
    ...(prompt === undefined
      ? {}
      : { promptPreview: prompt.length > 240 ? `${prompt.slice(0, 240)}...` : prompt }),
  });
}

export function publicCommandList(records: readonly JobRecord[], rawQuery: unknown): JobRecord[] {
  const query = parseCommandListQuery(rawQuery);
  return selectProductCommands(records, query).map(
    "id" in query || "turnId" in query ? publicJobRecord : compactCommandRecord,
  );
}
