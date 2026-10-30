import { delegatedParentOf } from "@claudexor/schema";
import type { CommandBackend } from "./command-authority.js";
import {
  admitCommandRequest,
  commandAcceptanceReceipt,
  findAcceptedCommand,
} from "./command-rpc.js";
import type { DelegationAdmissionAuthority } from "./delegation-admission.js";
import type { JobRecord } from "./job-record.js";
import { restoreExactRetryDefaults } from "./exact-retry-defaults.js";

/** Replay is recovered before mutable Stop, reservation and admission checks. */
export function enqueueCommand(
  params: any,
  deps: {
    commands: CommandBackend;
    stopping: boolean;
    delegation?: DelegationAdmissionAuthority;
    accept(
      request: unknown,
      key: string,
      client: string,
      original?: unknown,
      operation?: string,
    ): { record: JobRecord; reused: boolean };
    publish(record: JobRecord): void;
  },
) {
  const raw = params?.request;
  if (raw && typeof raw === "object" && Object.hasOwn(raw, "deferredDefaults"))
    throw Object.assign(new Error("deferredDefaults is server-owned"), {
      code: "server_owned_field",
      status: 400,
      retryable: false,
    });
  const replay = findAcceptedCommand(deps.commands, params);
  if (replay) return commandAcceptanceReceipt(replay, true);
  if (deps.stopping)
    throw Object.assign(new Error("daemon is stopping; retry after reconnect"), {
      code: "daemon_stopping",
      status: 503,
    });
  const operation = typeof params?.operation === "string" ? params.operation : undefined;
  const request = admitCommandRequest(
    deps.commands,
    restoreExactRetryDefaults(deps.commands, raw, operation),
    operation,
    deps.delegation,
  );
  const accepted = deps.accept(
    request,
    String(params?.idempotencyKey ?? ""),
    String(params?.clientId ?? "daemon-client"),
    // The private snapshot is not part of the caller's replay body. A raw
    // Exact Retry without an explicit intent projection replays its exact
    // public body, while the accepted command retains the engine snapshot.
    params?.idempotencyRequest ?? (request !== raw ? raw : undefined),
    operation,
  );
  const parent = delegatedParentOf(request);
  if (!accepted.reused && parent) deps.delegation!.noteChildAccepted(parent, accepted.record.id);
  if (!accepted.reused) deps.publish(accepted.record);
  return commandAcceptanceReceipt(accepted.record, accepted.reused);
}
