import {
  ControlRunStartRequest,
  delegatedParentOf,
  resolveRunReviewRequested,
} from "@claudexor/schema";
import { newId } from "@claudexor/util";
import { commandStoreForRequest, type CommandBackend } from "./command-authority.js";
import {
  admitCommandRequest,
  commandAcceptanceReceipt,
  findAcceptedCommand,
} from "./command-rpc.js";
import type { DelegationAdmissionAuthority } from "./delegation-admission.js";
import type { JobRecord } from "./job-record.js";
import { restoreExactRetryDefaults } from "./exact-retry-defaults.js";

interface EnqueueDeps {
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
}

/** A job id, and the creation time its staged bodies carry, fixed before staging. */
interface AcceptanceStamp {
  id: string;
  createdAt?: string;
}

type EnqueuePlan =
  | { replay: JobRecord }
  | { request: unknown; key: string; client: string; original?: unknown; operation?: string };

/** Replay is recovered before mutable Stop, reservation and admission checks. */
function planEnqueue(params: any, deps: Omit<EnqueueDeps, "accept" | "publish">): EnqueuePlan {
  const raw = params?.request;
  if (raw && typeof raw === "object" && Object.hasOwn(raw, "deferredDefaults"))
    throw Object.assign(new Error("deferredDefaults is server-owned"), {
      code: "server_owned_field",
      status: 400,
      retryable: false,
    });
  const replay = findAcceptedCommand(deps.commands, params);
  if (replay) return { replay };
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
  return {
    request,
    key: String(params?.idempotencyKey ?? ""),
    client: String(params?.clientId ?? "daemon-client"),
    // The private snapshot is not part of the caller's replay body. A raw
    // Exact Retry without an explicit intent projection replays its exact
    // public body, while the accepted command retains the engine snapshot.
    original: params?.idempotencyRequest ?? (request !== raw ? raw : undefined),
    operation,
  };
}

export function enqueueCommand(params: any, deps: EnqueueDeps) {
  const plan = planEnqueue(params, deps);
  if ("replay" in plan) return commandAcceptanceReceipt(plan.replay, true);
  const { request } = plan;
  const accepted = deps.accept(request, plan.key, plan.client, plan.original, plan.operation);
  const parent = delegatedParentOf(request);
  if (!accepted.reused && parent) deps.delegation!.noteChildAccepted(parent, accepted.record.id);
  if (!accepted.reused) deps.publish(accepted.record);
  return commandAcceptanceReceipt(accepted.record, accepted.reused);
}

/** The accepted command for an admitted request: Agent review intent resolved. */
function acceptance(
  commands: CommandBackend,
  request: unknown,
  key: string,
  client: string,
  original: unknown,
  operation: string | undefined,
  stamp: AcceptanceStamp,
) {
  const store = commandStoreForRequest(commands, request);
  const parsed = ControlRunStartRequest.safeParse(request);
  const params =
    parsed.success && parsed.data.mode === "agent"
      ? { ...(request as Record<string, unknown>), review: resolveRunReviewRequested(parsed.data) }
      : request;
  return {
    store,
    input: {
      id: stamp.id,
      params,
      idempotencyKey: key,
      clientId: client,
      // Resolved defaults belong to accepted execution, never the wire digest.
      idempotencyParams: original ?? request,
      operation,
      ...(stamp.createdAt ? { createdAt: stamp.createdAt } : {}),
    },
  };
}

/**
 * Stage an acceptance's large bodies off the request thread, then enqueue
 * synchronously exactly as `enqueueCommand` does, with the same job id and the
 * creation time those bodies carry. Staging is a dry run of the same plan; a
 * replay, Stop, refusal or any staging failure is left to the synchronous
 * enqueue, which decides and reports as before.
 */
export async function enqueueStaged(
  params: any,
  deps: Omit<EnqueueDeps, "accept" | "stopping"> & { stopping(): boolean },
) {
  const stamp: AcceptanceStamp = { id: newId("job") };
  try {
    const plan = planEnqueue(params, { ...deps, stopping: deps.stopping() });
    if (!("replay" in plan)) {
      const { request, key, client, original, operation } = plan;
      const staged = acceptance(deps.commands, request, key, client, original, operation, stamp);
      stamp.createdAt = await staged.store.stageAcceptance?.(staged.input);
    }
  } catch {
    // The synchronous enqueue below decides and reports.
  }
  return enqueueCommand(params, {
    ...deps,
    stopping: deps.stopping(),
    accept: (request, key, client, original, operation) => {
      const { store, input } = acceptance(
        deps.commands,
        request,
        key,
        client,
        original,
        operation,
        stamp,
      );
      return store.accept(input);
    },
  });
}
