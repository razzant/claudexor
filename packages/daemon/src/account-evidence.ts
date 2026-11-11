import type { AccountLastService, CredentialProfile } from "@claudexor/schema";
import { CredentialGeneration } from "./credential-generation.js";
import { CredentialUnusableLedger } from "./credential-unusable-ledger.js";
import { ModelCapabilityLedger } from "./model-capability-ledger.js";
import { ModelSubstitutionLedger } from "./model-substitution-ledger.js";
import { PreProgressRefusalLedger } from "./pre-progress-refusal-ledger.js";
import { AccountServiceStore, type ServiceProducer } from "./store/account-service.js";
import type { EngineStore } from "./store/store.js";

/** The store's last-served facts as routing and Accounts read them. A write is
 * ordering evidence: its failure is logged and never fails a run, a ranking or
 * a credential mutation. */
export interface AccountServiceEvidence {
  serve(profile: CredentialProfile, model: string | null, producer: ServiceProducer): void;
  retract(profile: CredentialProfile, model: string | null, producer: ServiceProducer): void;
  orders(
    harnessId: string,
    model: string | null,
    profiles: readonly CredentialProfile[],
  ): ReadonlyMap<string, number>;
  latest(profiles: readonly CredentialProfile[]): AccountLastService[];
}

/**
 * The daemon's account evidence for ONE engine-store lifetime: the credential
 * generation every observation binds to, the bounded in-memory ledgers that
 * share it, and the store's durable last-served facts. The SQL services graph
 * builds it once and retires it on close; a global-generation recovery keeps
 * the same store, so it keeps this evidence too. Every credential change that
 * moves the generation also deletes the durable facts it voided, after the
 * move, so a failed delete leaves at worst a stale ordering preference.
 * Without a store (library embedders, unit tests) nothing is durable.
 */
export function createAccountEvidence(
  store?: EngineStore,
  warn: (line: string) => void = () => {},
) {
  const durable = store ? new AccountServiceStore(store) : null;
  const guarded = <T>(label: string, action: () => T, fallback: T): T => {
    try {
      return action();
    } catch (error) {
      warn(`account service evidence ${label} failed: ${String(error)}`);
      return fallback;
    }
  };
  const credentials = new CredentialGeneration(undefined, (scope) => {
    if (durable) guarded("clear", () => durable.clear(scope), undefined);
  });
  const services: AccountServiceEvidence | null = durable && {
    serve: (profile, model, producer) =>
      guarded("write", () => durable.serve(profile, model, producer), undefined),
    retract: (profile, model, producer) =>
      guarded("retraction", () => durable.retract(profile, model, producer), undefined),
    orders: (harnessId, model, profiles) =>
      guarded("read", () => durable.orders(harnessId, model, profiles), new Map()),
    // The Accounts read reports its own failure to the caller instead.
    latest: (profiles) => durable.latest(profiles),
  };
  return {
    credentials,
    unusable: new CredentialUnusableLedger(undefined, undefined, credentials),
    refusals: new PreProgressRefusalLedger(undefined, undefined, credentials),
    substitutions: new ModelSubstitutionLedger(),
    capabilities: new ModelCapabilityLedger(credentials),
    services,
    /** The owning store is closing: no outcome of an earlier run binds any more. */
    retire: () => credentials.retire(),
  };
}
export type AccountEvidence = ReturnType<typeof createAccountEvidence>;
