import {
  errorCode,
  redactSecrets,
  safeProblemContext,
  safeProblemRequiredActions,
} from "@claudexor/util";
import { replacementRefusal } from "./daemon-shutdown-rpc.js";

export function storageOnlyFailure(error: unknown): boolean {
  if (error instanceof AggregateError)
    return error.errors.length > 0 && error.errors.every(storageOnlyFailure);
  return ["store_corrupt", "store_flush_unavailable"].includes(
    (error as { code?: string })?.code ?? "",
  );
}

/** The daemon's safe problem projection; clients preserve these facts verbatim. */
export function rpcProblem(error: unknown) {
  const fields = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = errorCode(error);
  return {
    message: redactSecrets(error instanceof Error ? error.message : String(error)),
    ...(code ? { code } : {}),
    ...("status" in fields ? { status: Number(fields.status) } : {}),
    ...(typeof fields.retryable === "boolean"
      ? { retryable: fields.retryable }
      : replacementRefusal(error)
        ? { retryable: true }
        : {}),
    ...("context" in fields ? { context: safeProblemContext(fields.context) } : {}),
    ...("requiredActions" in fields
      ? { requiredActions: safeProblemRequiredActions(fields.requiredActions) }
      : {}),
  };
}
