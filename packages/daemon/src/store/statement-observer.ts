import type { StatementSync } from "node:sqlite";

type Failure = (error: unknown, context: string) => unknown;

/** Observe execution on the native object, preserving its prototype, options,
 * accessors and bindings. A prepared statement may fail long after prepare(). */
export function observeStatement(statement: StatementSync, failure: Failure): StatementSync {
  for (const method of ["get", "all", "run", "iterate"] as const) {
    const native = statement[method];
    Object.defineProperty(statement, method, {
      configurable: true,
      writable: true,
      value: function (this: StatementSync, ...args: unknown[]) {
        try {
          const value = Reflect.apply(native, this, args);
          return method === "iterate" ? observeIterator(value, failure) : value;
        } catch (error) {
          throw failure(error, `executing statement.${method}`);
        }
      },
    });
  }
  return statement;
}

/** SQLite steps lazily in next(). Keep the actual iterator and its native
 * return/reset behavior, including early for-of exit and iterable identity. */
function observeIterator<T extends Iterator<unknown>>(iterator: T, failure: Failure): T {
  for (const method of ["next", "return"] as const) {
    const native = iterator[method];
    if (!native) continue;
    Object.defineProperty(iterator, method, {
      configurable: true,
      writable: true,
      value: function (this: T, ...args: unknown[]) {
        try {
          return Reflect.apply(native, this, args);
        } catch (error) {
          throw failure(error, `executing statement iterator.${method}`);
        }
      },
    });
  }
  return iterator;
}
