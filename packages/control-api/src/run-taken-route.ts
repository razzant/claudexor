import type { ServerResponse } from "node:http";
import type { ControlRunDecisionRequest, ControlRunDecisionResponse } from "@claudexor/schema";
import { runIdempotentDelivery, type DeliveryCommandServices } from "./run-apply-routes.js";
import { discardRunResult, takeRunResult } from "./run-discard.js";
import type { DaemonRunRecord } from "./run-record.js";

/** Run the caller-owned taken or discard decision through the same mutation and durable
 * delivery receipt owners as apply, revert, and discard. */
export function runResultDisposition(input: {
  services?: DeliveryCommandServices;
  record: DaemonRunRecord;
  body: ControlRunDecisionRequest;
  key: string;
  chainMutation<T>(record: DaemonRunRecord, work: () => Promise<T>): Promise<T>;
}): Promise<ControlRunDecisionResponse> {
  return input.chainMutation(input.record, () =>
    runIdempotentDelivery(input.services, {
      params: input.record.params,
      key: input.key,
      operation: input.body.action === "taken" ? "run.decision.taken" : "run.decision.discard",
      request: { runId: input.record.runId ?? input.record.id, body: input.body },
      work: () =>
        input.body.action === "taken"
          ? takeRunResult(input.record, input.body.reason ?? "captured_result")
          : discardRunResult(input.record),
    }),
  );
}

export async function handleRunDisposition(
  input: Parameters<typeof runResultDisposition>[0] & {
    response: ServerResponse;
    json(response: ServerResponse, status: number, body: unknown): void;
    requestError(response: ServerResponse, error: unknown): void;
  },
): Promise<void> {
  try {
    input.json(input.response, 200, await runResultDisposition(input));
  } catch (error) {
    input.requestError(input.response, error);
  }
}
