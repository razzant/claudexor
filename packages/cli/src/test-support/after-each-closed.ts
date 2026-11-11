import { afterEach, type TestContext } from "vitest";

/**
 * One afterEach in two phases, for cleanup that awaits closes and then removes
 * (#376). `close` keeps the hook deadline (`timeout`, or the configured
 * hookTimeout) and returns the tail; the tail runs next, in the same test. A
 * synchronous tail has no deadline: Vitest cannot stop synchronous work, so a
 * deadline would only fail a removal that finished late. A tail that awaits its
 * removal (`fs/promises`) is registered with `"awaited"` and keeps the same
 * deadline as the close: Vitest is still waiting when that timer fires, so it is
 * a real one.
 *
 * The tail is handed over per test context. It never runs when `close` rejected
 * or timed out in that test, not even if the close settles later, and a late
 * close in one test cannot run its tail in another. The outcome of the close
 * hook decides this, not the test's `signal`: a test whose own timeout already
 * aborted that signal still gets its tail after a timely close, and none after
 * a late one. This relies on Vitest's default `sequence.hooks: "stack"`: the
 * hook registered second runs first, and a failing after-hook stops the rest.
 * Under another order the tail is skipped, never run before the close settled.
 *
 * If the close times out, the rest of that function runs during a later test, so
 * it must not reach shared state by then: take entries of shared lists and handles
 * (`const owned = roots.splice(0)`) before the first await, and put what follows the
 * last await in the tail. A removal that waits for file end goes through the tail
 * as well (the tail hands the folders over), so that no other hook removes what a
 * failed close kept.
 */
export function afterEachClosed(
  close: (context: TestContext) => Promise<(() => void | Promise<void>) | undefined>,
  timeout?: number,
  tail: "sync" | "awaited" = "sync",
): void {
  const tails = new WeakMap<TestContext, () => void | Promise<void>>();
  afterEach(
    (context) => {
      const owned = tails.get(context);
      tails.delete(context);
      if (tail === "awaited") return owned?.();
      owned?.();
    },
    tail === "awaited" ? timeout : 0,
  );
  afterEach(async (context) => {
    const owned = await close(context);
    if (owned) tails.set(context, owned);
  }, timeout);
}
