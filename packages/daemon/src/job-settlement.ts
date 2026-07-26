import { nowIso, redactSecrets } from "@claudexor/util";
import { commandStoreForId, type CommandAuthority } from "./command-authority.js";
import type { JobRecord } from "./job-record.js";

interface JobErrorSettlement {
  thrown: unknown;
  record: JobRecord;
  aborted: boolean;
  commands: CommandAuthority;
  update: (record: JobRecord, patch: Partial<JobRecord>) => JobRecord;
}

/**
 * Settle a runner throw without allowing local terminal-finalization failures
 * to overwrite a terminal event already accepted by durable authority.
 */
export function settleJobError({
  thrown,
  record,
  aborted,
  commands,
  update,
}: JobErrorSettlement): JobRecord {
  const code = thrownField(thrown, "code");
  const status = thrownField(thrown, "status");
  const retryable = thrownField(thrown, "retryable");
  const typedStatus =
    typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
      ? status
      : undefined;
  const error = redactSecrets(thrown instanceof Error ? thrown.message : String(thrown));

  if (code === "terminal_recovery_required") {
    try {
      const recovered = commandStoreForId(commands, record.id)?.recoverDurableTerminal(record.id);
      if (!recovered) throw new Error("durable terminal event was not found");
      return recovered;
    } catch (recoveryError) {
      const recoveryDetail = redactSecrets(
        recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      );
      return update(record, {
        state: "interrupted",
        error: `${error}; immediate terminal recovery failed: ${recoveryDetail}`,
        errorCode: code,
        ...(typedStatus !== undefined ? { errorStatus: typedStatus } : {}),
        ...(typeof retryable === "boolean" ? { errorRetryable: retryable } : {}),
        finishedAt: nowIso(),
      });
    }
  }

  return update(record, {
    state: aborted ? "cancelled" : "failed",
    error,
    ...(typeof code === "string" && code ? { errorCode: code } : {}),
    ...(typedStatus !== undefined ? { errorStatus: typedStatus } : {}),
    // Only an explicit boolean is a retryability claim. In particular, an
    // untyped refusal must preserve the refused-turn recorder's default.
    ...(typeof retryable === "boolean" ? { errorRetryable: retryable } : {}),
    finishedAt: nowIso(),
  });
}

function thrownField(thrown: unknown, field: string): unknown {
  return thrown && typeof thrown === "object" && field in thrown
    ? (thrown as Record<string, unknown>)[field]
    : undefined;
}
