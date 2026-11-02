import type { HarnessEvent } from "@claudexor/schema";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import { observeUsageSpend } from "./laneStreamEvents.js";

/** One owner for streamed usage accumulation + mid-flight cash-cap behavior. */
export function processAttemptUsage(input: {
  event: HarnessEvent;
  telemetry: Pick<AttemptTelemetry, "usageCost">;
  harnessId: string;
  attemptId: string;
  cost: number;
  costEstimated: boolean;
  emit?: (type: "budget.observation", payload: Record<string, unknown>) => void;
  budgetGuard?: (streamedUsd: number) => boolean;
  cancel: () => void;
}): { cost: number; costEstimated: boolean; hardCapReached: boolean } {
  const spend = observeUsageSpend(
    input.event,
    (type, payload) => input.emit?.(type, payload),
    input.harnessId,
    input.attemptId,
    input.telemetry.usageCost,
  );
  const cost = input.cost + spend.costUsd;
  const costEstimated = input.costEstimated || spend.estimated;
  const paidOrUnknown =
    input.telemetry.usageCost.cashUsd +
    (input.telemetry.usageCost.unknownPaidUsd ?? input.telemetry.usageCost.unknownUsd);
  // A reported zero adds no spend, so it cannot reach the cap.
  if (spend.costUsd > 0 && paidOrUnknown > 0 && input.budgetGuard?.(paidOrUnknown)) {
    input.emit?.("budget.observation", {
      harness_id: input.harnessId,
      attempt_id: input.attemptId,
      kind: "cooldown",
      detail: "hard cap mid-flight abort",
    });
    input.cancel();
    return { cost, costEstimated, hardCapReached: true };
  }
  return { cost, costEstimated, hardCapReached: false };
}
