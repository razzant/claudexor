import type { PartitionControlPort } from "@claudexor/daemon";
import type { ControlJournalValidation } from "@claudexor/schema";

interface SetupReplacement {
  isBoundToCurrentGeneration(): boolean;
  replaceAfter<T>(operation: () => T | Promise<T>): Promise<T>;
}

/** One recovery route binding, available before storage opens and after a
 * generation replacement. The startup owner alone decides admission. */
export function recoveryControlServices(options: {
  partition(name: string): PartitionControlPort;
  setup(): SetupReplacement | null;
  onValidated?(name: string, result: ControlJournalValidation): void;
  afterQuarantine?(): Promise<void>;
}) {
  return {
    journalEvents: async (name: string, cursor?: string) => options.partition(name).events(cursor),
    recoveryInspectPartition: async (name: string) => options.partition(name).inspect(),
    recoveryValidatePartition: async (name: string) => {
      const result = await options.partition(name).validate();
      options.onValidated?.(name, result);
      return result;
    },
    recoveryExportPartition: async (name: string) => options.partition(name).exportRecovery(),
    recoveryQuarantinePartition: async (name: string, input: unknown) => {
      const target = options.partition(name);
      const request = input as Parameters<PartitionControlPort["quarantineAndStartFresh"]>[0];
      const setup = options.setup();
      let receipt;
      if (name === "global" && setup) {
        const preflight = target.preflightQuarantine(request);
        receipt =
          preflight.disposition === "completed" && setup.isBoundToCurrentGeneration()
            ? preflight.receipt
            : await setup.replaceAfter(() => target.quarantineAndStartFresh(request));
      } else receipt = await target.quarantineAndStartFresh(request);
      await options.afterQuarantine?.();
      return receipt;
    },
  };
}
