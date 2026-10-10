import { unlinkSync } from "node:fs";
import type { EngineStore } from "./store.js";

/** `blob:<sha256>` or `upload:<uploadId>`: the file families the sweep/GC may unlink by "no owner". */
export type OwnerKey = `blob:${string}` | `upload:${string}`;

export type UnlinkOutcome = "removed" | "owned";

export interface UnlinkRequest {
  path: string;
  /** Synchronous owner check in the recheck section (reverse indexes / the `upload` row). */
  owners: () => boolean;
  /** Runs in the same synchronous section right after the unlink (e.g. the `blob` row delete). */
  afterUnlink?: () => void;
}

/**
 * The one rule for every unlink by "no owner" (R5_AMENDMENTS C10, generalizing
 * A3/C3 and replacing the C9 mechanism). The main thread records, after every
 * COMMIT that inserts, deletes or changes an owner row of a key, the
 * generation of that change; the unlink waits for the barrier covering the
 * latest such generation and then, in ONE synchronous section, retries when
 * the owner moved during the wait, keeps when an owner exists, else unlinks
 * (ENOENT is success). One flight per key; concurrent callers join it.
 */
export class OwnerGenerations {
  private readonly generations = new Map<OwnerKey, number>();
  private readonly inflight = new Map<OwnerKey, Promise<UnlinkOutcome>>();

  constructor(private readonly store: EngineStore) {}

  /** Right after the COMMIT of a transaction that touched the key's owner row(s). */
  noteChange(key: OwnerKey): number {
    const g = this.store.mark();
    this.generations.set(key, g);
    return g;
  }

  /** Test seam: the generation currently bound to a key. */
  generationOf(key: OwnerKey): number | undefined {
    return this.generations.get(key);
  }

  unlinkWhenUnowned(key: OwnerKey, request: UnlinkRequest): Promise<UnlinkOutcome> {
    const running = this.inflight.get(key);
    if (running) return running;
    const flight = this.loop(key, request).finally(() => {
      if (this.inflight.get(key) === flight) this.inflight.delete(key);
    });
    this.inflight.set(key, flight);
    return flight;
  }

  private async loop(key: OwnerKey, request: UnlinkRequest): Promise<UnlinkOutcome> {
    for (;;) {
      const gWait = this.generations.get(key) ?? this.store.mark();
      await this.store.synced(gWait);
      // One synchronous section: no await below this line.
      if ((this.generations.get(key) ?? gWait) > gWait) continue;
      if (request.owners()) {
        this.generations.delete(key);
        return "owned";
      }
      try {
        unlinkSync(request.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      request.afterUnlink?.();
      this.generations.delete(key);
      return "removed";
    }
  }
}
