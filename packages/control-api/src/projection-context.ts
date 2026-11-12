import { AsyncLocalStorage } from "node:async_hooks";

/** A single read's decoded inputs, including children. Never retained between requests. */
class ProjectionContext {
  private readonly values = new Map<object | string, Map<string, unknown>>();

  read<T>(owner: object | string, key: string, read: () => T): T {
    let values = this.values.get(owner);
    if (!values) this.values.set(owner, (values = new Map()));
    if (!values.has(key)) values.set(key, read());
    return values.get(key) as T;
  }
}

const current = new AsyncLocalStorage<ProjectionContext>();

/** Scope only pure projection, never mutations or a long-lived subscription. */
export function inRunProjection<T>(read: () => T): T {
  return current.getStore() ? read() : current.run(new ProjectionContext(), read);
}

/** True inside a projection scope (the bulk worker's jobs). */
export function inProjectionScope(): boolean {
  return current.getStore() !== undefined;
}

/** Mutation callers outside a projection retain their ordinary fresh-read behavior. */
export function projectionRead<T>(owner: object | string, key: string, read: () => T): T {
  const context = current.getStore();
  return context ? context.read(owner, key, read) : read();
}
