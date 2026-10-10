import type {
  CommandStorePort,
  LegacyCommandStorePort,
  CommandQueries,
} from "./store-contracts.js";

export interface CommandAuthority {
  current?(): CommandStorePort;
  forRequest?(params: unknown): CommandStorePort;
  findById?(id: string): CommandStorePort | undefined;
}

export interface LegacyCommandAuthority extends CommandAuthority {
  current?(): LegacyCommandStorePort;
  forRequest?(params: unknown): LegacyCommandStorePort;
  all?(): LegacyCommandStorePort[];
  findById?(id: string): LegacyCommandStorePort | undefined;
}

/** A complete command boundary; SQL never supplies a legacy enumeration fallback. */
export interface CommandBackend extends CommandAuthority {
  readonly queries: CommandQueries;
  pruneHistory(cap: number, retentionMs: number, now: number): string[];
}

export function commandStores(authority: LegacyCommandAuthority): LegacyCommandStorePort[] {
  if (authority.all) return authority.all();
  return authority.current ? [authority.current()] : [];
}

export function commandStoreForRequest(
  authority: CommandAuthority,
  params: unknown,
): CommandStorePort {
  const store = authority.forRequest?.(params) ?? authority.current?.();
  if (!store) throw new Error("command authority cannot route the request");
  return store;
}

export function commandStoreForId(
  authority: CommandAuthority,
  id: string,
): CommandStorePort | undefined {
  const addressed = authority.findById?.(id);
  if (addressed) return addressed;
  // Compatibility for an explicitly enumerable legacy authority. A structural
  // SQL authority has no `all` member and cannot enter this branch.
  if ("all" in authority && typeof authority.all === "function") {
    return (authority as LegacyCommandAuthority).all?.().find((store) => store.get(id));
  }
  const current = authority.current?.();
  return current?.get(id) ? current : undefined;
}
