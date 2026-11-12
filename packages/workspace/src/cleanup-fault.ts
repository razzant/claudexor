import { rmSync } from "node:fs";
import { removeTree } from "@claudexor/util";

/**
 * Keep a cleanup fault beside the outcome it followed, never in its place: a
 * non-enumerable `cleanupError` (the lane capture and revert already use), so no
 * receipt or record serializes it and the outcome's own facts stay as they were.
 * An outcome that already carries one, or cannot take one (frozen), keeps its own.
 */
export function noteCleanupFault(outcome: unknown, fault: unknown): void {
  if (fault === undefined || outcome === null || typeof outcome !== "object") return;
  if ("cleanupError" in outcome) return;
  try {
    Object.defineProperty(outcome, "cleanupError", { value: fault, enumerable: false });
  } catch {
    // Frozen: the outcome stands without the diagnostic.
  }
}

/** A disposable scratch directory `body` may allocate (`held.dir`). */
export interface HeldScratch {
  dir: string | null;
}

/**
 * Run `body`, then remove the scratch it allocated. A removal that fails leaves the
 * directory where it is (the OS temp dir) and never replaces what `body` returned or
 * threw: its fault is noted beside that outcome ({@link noteCleanupFault}).
 */
export async function withDisposableScratch<T>(
  body: (held: HeldScratch) => Promise<T>,
): Promise<T> {
  const held: HeldScratch = { dir: null };
  let outcome: unknown;
  try {
    return (outcome = await body(held));
  } catch (error) {
    outcome = error;
    throw error;
  } finally {
    try {
      if (held.dir) rmSync(held.dir, { recursive: true, force: true });
    } catch (fault) {
      noteCleanupFault(outcome, fault);
    }
  }
}

/**
 * An envelope whose creation failed before it was returned never started: no harness
 * ran in it, and no caller holds it to dispose of. Its creator, which made `base` in
 * this same call, removes it whole (#501) without waiting on the main thread, its
 * `owner.json` last; the orphan sweeper keeps a directory whose creating process is
 * alive, so nothing else would. A removal that fails leaves it, keeps `refusal` as
 * the outcome and says so: the fault is noted beside it and named after its message.
 * Resolves to what to throw.
 */
export async function discardUnstartedEnvelope(base: string, refusal: unknown): Promise<unknown> {
  try {
    await removeTree(base, { lastEntry: "owner.json" });
  } catch (fault) {
    noteCleanupFault(refusal, fault);
    if (refusal instanceof Error) {
      const why = fault instanceof Error ? fault.message : String(fault);
      refusal.message = `${refusal.message}; its never-started envelope ${base} could not be removed: ${why}`;
    }
  }
  return refusal;
}
