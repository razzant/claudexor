import { CapturedRunStart, decodeAcceptedRunStart } from "@claudexor/schema";
import { commandStoreForId, type CommandBackend } from "./command-authority.js";
import { assertDeferredOperator } from "./deferred-message-owner.js";

/** Exact Retry names an immutable accepted source. Preferences come only from
 * that engine-owned body, never from an operation/client label or payload.
 * This supplies no admission exemption: the rebuilt request still passes the
 * current continuation, delegation, file, project and execution owners. */
export function restoreExactRetryDefaults(
  commands: CommandBackend,
  raw: unknown,
  operation: string | undefined,
): unknown {
  const input = raw as { retryOf?: unknown; parentRunId?: unknown } | null;
  if (operation !== "run.retry" || typeof input?.retryOf !== "string") return raw;
  const sourceId = commands.queries.select({ ids: [input.retryOf] })[0]?.id;
  const source = sourceId ? commandStoreForId(commands, sourceId)?.get(sourceId) : undefined;
  if (!source) return raw; // Ordinary admission owns missing/expired sources.
  if (
    !source.params ||
    typeof source.params !== "object" ||
    !Object.hasOwn(source.params, "deferredDefaults")
  )
    return raw;
  const { deferredDefaults } = decodeAcceptedRunStart(source.params);
  if (!deferredDefaults) return raw;
  assertDeferredOperator(false, source.params);
  if (input.parentRunId !== (source.runId ?? source.id))
    throw Object.assign(new Error("Exact Retry must name its accepted source as parent"), {
      code: "retry_source_mismatch",
      status: 409,
      retryable: false,
    });
  return CapturedRunStart.parse({ ...(raw as object), deferredDefaults });
}
