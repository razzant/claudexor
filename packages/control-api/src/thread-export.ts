/**
 * The one producer of a thread's exact export and the conditional acceptance of
 * its retirement. It composes existing owners: the store's closure and purge
 * decision, adapters' declared session layouts, and the run and lane trees.
 * Reading a manifest writes nothing. A transfer serves only what the current
 * inventory named, re-identified at open. Acceptance re-hashes every exported
 * byte, then lets the store bind the decision in one transaction.
 */
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import {
  THREAD_EXPORT_SCHEMA_VERSION,
  ThreadRetirement,
  type ThreadExportManifest,
  type ThreadRetireRequest,
} from "@claudexor/schema";
import {
  digestDecoded,
  digestStream,
  itemChanged,
  openIdentified,
  streamDecoded,
} from "./thread-export-walk.js";
import { currentDigests } from "./thread-export-digests.js";
export { verifyLaneRemoval } from "./thread-export-digests.js";
import {
  BUSY_GAPS,
  buildInventory,
  problem,
  stale,
  type Inventory,
  type ThreadExportClosure,
  type ThreadExportDeps,
} from "./thread-export-inventory.js";
export {
  type NativeLayout,
  type NativeStoreRef,
  type ThreadExportClosure,
  type ThreadExportDeps,
} from "./thread-export-inventory.js";

const refusalStatus = (code: string): number => (code === "thread_purged" ? 410 : 409);
const refusalError = (code: string, message: string) =>
  problem(code, refusalStatus(code), message, { context: { settled: true } });

/** A memory bound only: a thread evicted here is rebuilt by its next transfer. */
const HELD_THREADS = 32;

export function createThreadExport(deps: ThreadExportDeps) {
  const held = new Map<string, Inventory>();
  const rebuilding = new Map<string, Promise<Inventory>>();
  const hold = (inventory: Inventory): void => {
    const { threadId } = inventory.manifest;
    held.delete(threadId);
    held.set(threadId, inventory);
    for (const oldest of held.keys()) {
      if (held.size <= HELD_THREADS) break;
      held.delete(oldest);
    }
  };
  /** What holds a transfer to its manifest is the identity of the current
   * inventory, never what this process happens to remember: after a restart or
   * an eviction, the same inventory answers the same export. */
  const inventoryFor = async (
    threadId: string,
    exportId: string,
    signal?: AbortSignal,
    stopping?: AbortSignal,
  ): Promise<Inventory> => {
    const remembered = held.get(threadId);
    if (remembered?.manifest.exportId === exportId) return remembered;
    // Shared by every waiter, so no one client's disconnect can abort it; the
    // server's own Stop does, since no waiter is answered after it.
    let pending = rebuilding.get(threadId);
    if (!pending) {
      pending = buildInventory(deps, threadId, stopping).finally(() => rebuilding.delete(threadId));
      rebuilding.set(threadId, pending);
    }
    const current = await pending;
    signal?.throwIfAborted();
    hold(current);
    if (current.manifest.exportId !== exportId)
      throw stale("the closure or its files changed since this export; read the manifest again");
    return current;
  };

  /** The thread row alone: what only it answers needs no closure. */
  const subject = (threadId: string) => {
    const record = deps.thread(threadId);
    if (!record) throw problem("thread_not_found", 404, `no such thread: ${threadId}`);
    return record;
  };

  /** Addressed reads only (thread row, open cleanup, the operation's binding), so
   * the answer costs the same however long the thread's history is. */
  const retirementRead = (threadId: string, operationId: string | null): ThreadRetirement => {
    const { storeId, thread } = subject(threadId);
    const acceptance = thread.retirement ?? null;
    const cleanup = acceptance ? deps.cleanup(threadId) : null;
    const open = acceptance !== null && (cleanup !== null || deps.hasPurgeLeftovers(thread));
    return ThreadRetirement.parse({
      schemaVersion: THREAD_EXPORT_SCHEMA_VERSION,
      storeId,
      threadId,
      threadState: thread.state,
      status: !acceptance ? "not_accepted" : open ? "accepted_pending_removal" : "removed",
      acceptance,
      cleanup: open ? { reason: cleanup?.reason ?? null } : null,
      operation: operationId ? deps.operation(threadId, operationId) : null,
    });
  };

  const finishCleanup = async (
    thread: ThreadExportClosure["thread"],
    stopping?: AbortSignal,
  ): Promise<void> => {
    // Acceptance is durable and independent of this attempt: a failure or Stop
    // leaves it open, and the retention pass or a restart retries it.
    await deps.finishPurge(thread, stopping).catch(() => undefined);
  };

  return {
    /** Passive: it writes nothing and stores no copy; the same inventory answers the same id. */
    async threadExportManifest(
      threadId: string,
      signal?: AbortSignal,
    ): Promise<ThreadExportManifest> {
      const inventory = await buildInventory(deps, threadId, signal);
      hold(inventory);
      return inventory.manifest;
    },

    async transferThreadExportItem(
      threadId: string,
      exportId: string,
      itemId: string,
      res: ServerResponse,
      signal?: AbortSignal,
      /** The server's Stop: the one thing that ends a rebuild other waiters share. */
      stopping?: AbortSignal,
    ): Promise<void> {
      const inventory = await inventoryFor(threadId, exportId, signal, stopping);
      const item = inventory.items.get(itemId);
      if (!item) throw problem("thread_export_item_not_found", 404, "no such export item");
      const source = inventory.sources.get(itemId);
      if (item.kind !== "file" || !source)
        throw problem(
          "thread_export_item_not_transferable",
          409,
          `a ${item.kind} item is recorded by the manifest and has no bytes to transfer`,
        );
      const headers = (sha: string, size: number) => ({
        "Content-Type": "application/octet-stream",
        "Content-Length": size,
        ETag: `"${sha}"`,
      });
      if (source.type === "document") {
        const bytes = deps.document(threadId, source.key);
        const observed = bytes
          ? `sha256:${createHash("sha256").update(bytes).digest("hex")}`
          : null;
        if (!bytes || !observed || observed !== item.sha256) throw itemChanged(item.path);
        res.writeHead(200, headers(observed, bytes.length));
        res.end(bytes);
        return;
      }
      if (source.type === "projection") {
        const again = await digestDecoded(source.file, signal);
        if (again.sha256 !== item.sha256) throw itemChanged(item.path);
        res.writeHead(200, headers(again.sha256, again.sizeBytes));
        await streamDecoded(source.file, res, signal);
        return;
      }
      const handle = await openIdentified(source.file);
      try {
        const first = await digestStream(handle.createReadStream({ autoClose: false }), signal);
        if (
          first.sizeBytes !== source.file.sizeBytes ||
          (item.sha256 && first.sha256 !== item.sha256)
        )
          throw itemChanged(item.path);
        const after = await handle.stat();
        if (after.size !== source.file.sizeBytes || after.mtimeMs !== source.file.mtimeMs)
          throw itemChanged(item.path);
        res.writeHead(200, headers(first.sha256, first.sizeBytes));
        if (first.sizeBytes === 0) res.end();
        else
          await pipeline(
            handle.createReadStream({
              start: 0,
              end: first.sizeBytes - 1,
              autoClose: false,
            }),
            res,
            signal ? { signal } : {},
          );
      } finally {
        await handle.close();
      }
    },

    /**
     * One operation gets one bound outcome. A replay returns it and evaluates
     * nothing. A definite refusal is bound before it is answered, so a delayed
     * duplicate of this operation can never accept afterwards.
     */
    async retireThread(
      threadId: string,
      request: ThreadRetireRequest,
      signal?: AbortSignal,
      /** The server's Stop alone, not the client's: it also ends the cleanup. */
      stopping?: AbortSignal,
    ): Promise<ThreadRetirement> {
      const { thread } = subject(threadId);
      const bound = deps.operation(threadId, request.operationId);
      const refuse = (code: string, message: string) => {
        signal?.throwIfAborted();
        const settled = deps.settle(threadId, request.operationId, { code, message });
        return refusalError(settled.code ?? code, settled.message ?? message);
      };
      if (bound) {
        if (bound.outcome === "abandoned")
          throw refusalError("thread_retirement_abandoned", "this operation was abandoned");
        if (bound.outcome === "refused")
          throw refusalError(bound.code ?? "thread_retirement_refused", bound.message ?? "refused");
        const accepted = thread.retirement;
        if (
          accepted?.exportId !== request.exportId ||
          accepted.closureDigest !== request.closureDigest ||
          accepted.contentDigest !== request.contentDigest ||
          accepted.laneDigest !== request.laneDigest
        )
          throw problem(
            "thread_retirement_conflict",
            409,
            "this operation was accepted with a different export",
          );
        await finishCleanup(thread, stopping);
        return retirementRead(threadId, request.operationId);
      }
      if (thread.state === "purged")
        throw thread.retirement
          ? refuse(
              "thread_retirement_conflict",
              `thread already retired by operation ${thread.retirement.operationId}`,
            )
          : refuse("thread_purged", "thread was purged outside this retirement");

      let inventory: Inventory;
      try {
        inventory = await buildInventory(deps, threadId, signal);
      } catch (error) {
        if ((error as { code?: string }).code === "thread_export_stale")
          throw refuse("thread_export_stale", (error as Error).message);
        throw error;
      }
      const { manifest } = inventory;
      const busy = manifest.gaps.find((gap) => BUSY_GAPS.has(gap.code));
      if (busy) throw refuse("thread_busy", busy.message);
      if (manifest.gaps.length > 0)
        throw refuse(
          "thread_export_incomplete",
          `${manifest.gaps[0]!.code}: ${manifest.gaps[0]!.message}`,
        );
      if (
        manifest.exportId !== request.exportId ||
        manifest.closureDigest !== request.closureDigest
      )
        throw refuse("thread_export_stale", "the closure or its files changed since this export");

      let digests;
      try {
        digests = await currentDigests(deps, inventory, signal);
      } catch (error) {
        if ((error as { code?: string }).code === "thread_export_item_changed")
          throw refuse("thread_export_stale", (error as Error).message);
        throw error;
      }
      if (digests.lane !== request.laneDigest)
        throw refuse("thread_lane_changed", "the lane bytes differ from the export's lane digest");
      if (digests.content !== request.contentDigest)
        throw refuse("thread_export_stale", "exported bytes differ from the content digest");

      // No await between the last byte read and this transaction: the store
      // rechecks the closure and binds decision, obligation and outcome at once.
      // A Stop that arrived during that last read decides nothing.
      signal?.throwIfAborted();
      deps.retire(threadId, request, digests.laneEntries);
      await finishCleanup(thread, stopping);
      return retirementRead(threadId, request.operationId);
    },

    /** Fence an unanswered operation: afterwards it can never accept. */
    abandonThreadRetirement(threadId: string, operationId: string): ThreadRetirement {
      subject(threadId);
      if (!deps.operation(threadId, operationId)) deps.settle(threadId, operationId, null);
      return retirementRead(threadId, operationId);
    },

    threadRetirement: retirementRead,
  };
}
export type ThreadExportServices = ReturnType<typeof createThreadExport>;
