import { ControlPendingInteraction } from "@claudexor/schema";
import type { InteractionStorePort } from "../../store-contracts.js";
import type { InteractionStore } from "./fixtures/legacy/daemon/interactions.js";

/**
 * The frozen legacy store predates question delivery, so its rows carry no
 * `delivery`. Reading them through the current schema gives them the
 * historical blocking meaning, exactly as the SQL store reads its old rows.
 */
export function legacyInteractionPort(store: InteractionStore): InteractionStorePort {
  return {
    request: (ctx) => ControlPendingInteraction.parse(store.request(ctx)),
    resolve: (runId, interactionId, terminal) => store.resolve(runId, interactionId, terminal),
    resolveRun: (runId, terminal) => store.resolveRun(runId, terminal),
    status: (runId, interactionId) => store.status(runId, interactionId),
    pendingForRun: (runId) => ControlPendingInteraction.array().parse(store.pendingForRun(runId)),
  };
}
