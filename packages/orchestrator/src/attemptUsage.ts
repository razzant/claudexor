import type { HarnessEvent } from "@claudexor/schema";
import type { AttemptTelemetry } from "./attemptTelemetry.js";

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
  const usage = input.event.usage;
  if (!usage?.cost_usd) {
    return { cost: input.cost, costEstimated: input.costEstimated, hardCapReached: false };
  }
  const cost = input.cost + usage.cost_usd;
  const costEstimated = input.costEstimated || usage.estimated === true;
  input.emit?.("budget.observation", {
    harness_id: input.harnessId,
    attempt_id: input.attemptId,
    kind: "spend",
    usd: usage.cost_usd,
    estimated: usage.estimated === true,
  });
  const paidOrUnknown = input.telemetry.usageCost.cashUsd + input.telemetry.usageCost.unknownUsd;
  if (paidOrUnknown > 0 && input.budgetGuard?.(paidOrUnknown)) {
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
