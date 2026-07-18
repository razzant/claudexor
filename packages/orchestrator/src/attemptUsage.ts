import type { HarnessEvent } from "@claudexor/schema";
import { isSubscriptionValuation } from "@claudexor/budget";

/** One owner for streamed usage accumulation + mid-flight cash-cap behavior. */
export function processAttemptUsage(input: {
  event: HarnessEvent;
  authMode: "local_session" | "api_key" | null;
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
  const cash = !isSubscriptionValuation(input.authMode);
  if (cash && input.budgetGuard?.(cost)) {
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
