import type { ModelOperations } from "@claudexor/daemon";
import type { JobAdmission } from "@claudexor/schema";

/** Existing model controls, with one synchronous snapshot of this operation's
 * live admission facts. Provider dispatch and result custody stay in their owner. */
export function modelOperationControlServices(
  operations: Pick<ModelOperations, "create" | "inspect" | "readResult" | "acknowledge" | "cancel">,
  admission?: (id: string) => JobAdmission | null,
) {
  const snapshot = (id: string) => {
    const detail = operations.inspect(id);
    return admission ? { ...detail, admission: admission(id) } : detail;
  };
  return {
    createModelOperation: async (...args: Parameters<ModelOperations["create"]>) =>
      snapshot((await operations.create(...args)).id),
    getModelOperation: async (id: string) => snapshot(id),
    readModelResult: async (id: string) => operations.readResult(id),
    acknowledgeModelResult: async (id: string, sha256: string) =>
      snapshot(operations.acknowledge(id, sha256).id),
    cancelModelOperation: async (...args: Parameters<ModelOperations["cancel"]>) =>
      snapshot((await operations.cancel(...args)).id),
  };
}
