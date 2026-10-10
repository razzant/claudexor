import { newId, nowIso, safeProblemMessage } from "@claudexor/util";
import type { CommandStorePort } from "./store-contracts.js";

export function beginDeliveryCommand(
  store: CommandStorePort,
  params: unknown,
  input: { key: string; client: string; operation: string; request: unknown },
) {
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
  store.update(id, {
    state: "failed",
    // This command store is the durable journal authority; redact before append.
    error: safeProblemMessage(error),
    errorCode: typeof value["code"] === "string" ? value["code"] : undefined,
    result: {
      status: typeof value["status"] === "number" ? value["status"] : 500,
      code: typeof value["code"] === "string" ? value["code"] : null,
    },
    finishedAt: nowIso(),
  });
}
