import type { CommandStore } from "./command-store.js";

export interface CommandAuthority {
  current?(): CommandStore;
  forRequest?(params: unknown): CommandStore;
  all?(): CommandStore[];
  findById?(id: string): CommandStore | undefined;
}

export function commandStores(authority: CommandAuthority): CommandStore[] {
  if (authority.all) return authority.all();
  return authority.current ? [authority.current()] : [];
}

export function commandStoreForRequest(authority: CommandAuthority, params: unknown): CommandStore {
  const store = authority.forRequest?.(params) ?? authority.current?.();
  if (!store) throw new Error("command authority cannot route the request");
  return store;
}

export function commandStoreForId(
  authority: CommandAuthority,
  id: string,
): CommandStore | undefined {
  return authority.findById?.(id) ?? commandStores(authority).find((store) => store.get(id));
}
