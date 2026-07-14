import type { CommandStore } from "./command-store.js";

export interface CommandAuthority {
  current?(): CommandStore;
  forRequest?(params: unknown): CommandStore;
  all?(): CommandStore[];
  findById?(id: string): CommandStore | undefined;
}

export function commandStores(authority: CommandAuthority | undefined): CommandStore[] {
  if (!authority) return [];
  if (authority.all) return authority.all();
  return authority.current ? [authority.current()] : [];
}

export function commandStoreForRequest(
  authority: CommandAuthority | undefined,
  params: unknown,
): CommandStore | undefined {
  return authority?.forRequest?.(params) ?? authority?.current?.();
}

export function commandStoreForId(
  authority: CommandAuthority | undefined,
  id: string,
): CommandStore | undefined {
  return authority?.findById?.(id) ?? commandStores(authority).find((store) => store.get(id));
}
