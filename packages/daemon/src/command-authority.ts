import type { CommandStorePort, CommandQueries } from "./store-contracts.js";

export interface CommandAuthority {
  current?(): CommandStorePort;
  forRequest?(params: unknown): CommandStorePort;
  findById?(id: string): CommandStorePort | undefined;
}

/** A complete command boundary; SQL never supplies a legacy enumeration fallback. */
export interface CommandBackend extends CommandAuthority {
  readonly queries: CommandQueries;
  pruneHistory(cap: number, retentionMs: number, now: number): string[];
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
  const current = authority.current?.();
  return current?.get(id) ? current : undefined;
}
