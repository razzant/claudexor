import {
  newId,
  nowIso,
  safeProblemContext,
  safeProblemMessage,
  safeProblemRequiredActions,
} from "@claudexor/util";
import type { CommandStorePort } from "./store-contracts.js";

export function beginDeliveryCommand(
  store: CommandStorePort,
  params: unknown,
  input: { key: string; client: string; operation: string; request: unknown },
  admit?: () => void,
) {
  if (
    admit &&
    !store.find({
      params,
      idempotencyKey: input.key,
      clientId: input.client,
      operation: `delivery.${input.operation}`,
      idempotencyParams: input.request,
    })
  )
    admit();
  const accepted = store.accept({
    id: newId("delivery"),
    params,
    idempotencyKey: input.key,
    clientId: input.client,
    operation: `delivery.${input.operation}`,
    idempotencyParams: input.request,
  });
  const record = accepted.reused
    ? accepted.record
    : store.update(accepted.record.id, { state: "running", startedAt: nowIso() });
  return { ...record, reused: accepted.reused };
}

export function completeDeliveryCommand(
  store: CommandStorePort | undefined,
  id: string,
  result: unknown,
): void {
  if (!store) throw new Error(`delivery authority lost command ${id}`);
  store.update(id, { state: "succeeded", result, finishedAt: nowIso() });
}

export function failDeliveryCommand(
  store: CommandStorePort | undefined,
  id: string,
  error: unknown,
): void {
  if (!store) throw new Error(`delivery authority lost command ${id}`);
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const context = safeProblemContext(value["context"]);
  const requiredActions = safeProblemRequiredActions(value["requiredActions"]);
  store.update(id, {
    state: "failed",
    // This command store is the durable journal authority; redact before append.
    error: safeProblemMessage(error),
    errorCode: typeof value["code"] === "string" ? value["code"] : undefined,
    // A replay answers the same typed recovery facts as the first refusal.
    ...(requiredActions.length > 0 ? { errorRequiredActions: requiredActions } : {}),
    ...(Object.keys(context).length > 0 ? { errorContext: context } : {}),
    result: {
      status: typeof value["status"] === "number" ? value["status"] : 500,
      code: typeof value["code"] === "string" ? value["code"] : null,
    },
    finishedAt: nowIso(),
  });
}
