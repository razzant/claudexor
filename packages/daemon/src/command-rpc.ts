import {
  assertDeferredReservation,
  continuedRunOf,
  delegatedParentOf,
  taskGroupLaunchMetadata,
} from "@claudexor/schema";
import {
  commandStoreForRequest,
  type CommandAuthority,
  type CommandBackend,
} from "./command-authority.js";
import { publicJobRecord, type JobRecord } from "./job-record.js";
import { admitContinuationRequest } from "./continuation-admission.js";
import { assertUnexpiredRunFiles } from "./run-file-admission.js";
import {
  admitDelegatedRequest,
  type DelegationAdmissionAuthority,
} from "./delegation-admission.js";

/** Existing admission rules over their addressed subjects, in the enqueue turn. */
export function admitCommandRequest(
  commands: CommandBackend,
  raw: unknown,
  operation: string | undefined,
  delegation?: DelegationAdmissionAuthority,
  reservedDraftId?: string,
): unknown {
  taskGroupLaunchMetadata(raw, operation === "delegated-run");
  const from = continuedRunOf(raw);
  const reservation = from ? commands.deferredFor?.(from)?.reservation(from) : null;
  assertDeferredReservation(reservation, reservedDraftId);
  const request = admitContinuationRequest(
    raw,
    from ? commands.queries.select({ continuationChainOf: from }) : [],
    (id) => commands.queries.select({ ids: [id] })[0],
  );
  const p = request as {
    retryOf?: unknown;
    planRunId?: unknown;
    planRef?: { runId?: unknown };
  } | null;
  for (const id of [p?.retryOf, p?.planRunId, p?.planRef?.runId])
    if (typeof id === "string") assertUnexpiredRunFiles(commands.queries.select({ ids: [id] })[0]);
  const parentId = delegatedParentOf(request);
  const parent = parentId ? commands.queries.getByRunId(parentId) : undefined;
  return admitDelegatedRequest(request, operation, parent ? [parent] : [], delegation);
}

interface CommandLookupEnvelope {
  request?: unknown;
  idempotencyKey?: unknown;
  clientId?: unknown;
  operation?: unknown;
  idempotencyRequest?: unknown;
}

/** One parser for enqueue replay and the explicit findAccepted RPC. */
export function findAcceptedCommand(
  commands: CommandAuthority,
  input: CommandLookupEnvelope | null | undefined,
): JobRecord | null {
  return commandStoreForRequest(commands, input?.request).find({
    params: input?.request,
    idempotencyKey: String(input?.idempotencyKey ?? ""),
    clientId: String(input?.clientId ?? "daemon-client"),
    operation: typeof input?.operation === "string" ? input.operation : undefined,
    idempotencyParams: input?.idempotencyRequest,
  });
}

export function publicAcceptedCommand(
  commands: CommandAuthority,
  input: CommandLookupEnvelope | null | undefined,
): ReturnType<typeof publicJobRecord> | null {
  const record = findAcceptedCommand(commands, input);
  return record ? publicJobRecord(record) : null;
}

export function commandAcceptanceReceipt(record: JobRecord, reused: boolean) {
  return { id: record.id, state: record.state, reused };
}
