import { rmSync } from "node:fs";

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
