import { lstatSync, unlinkSync } from "node:fs";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import type {
  NativeHomeLifetime,
  NativeHomeRetentionInput,
  NativeHomeRetentionResult,
} from "@claudexor/core";
import { canonicalIsolationLocator } from "@claudexor/core";
import { codexContinuity, codexStoreHome } from "./continuity.js";
import { CODEX_SESSION_ID, RolloutInventory, rolloutPathDisappeared } from "./rollout-lineage.js";

/** Retire cold dated rollout files only after the inventory has accounted for
 * every part that can supply a history base or affect the group's age. */
async function prune(input: NativeHomeRetentionInput) {
  const result: NativeHomeRetentionResult = {
    deleted_files: [],
    errors: [],
    freed_bytes: 0,
    kept_referenced: 0,
    kept_recent: 0,
    kept_unknown: 0,
    truncated: false,
  };
  const hold = (reason: string, retry = false) => {
    result.holdReason = reason;
    result.errors.push(reason);
    result.truncated = retry;
    return result;
  };
  const cancelled = () => {
    if (!input.signal?.aborted) return false;
    result.truncated = true;
    if (!result.errors.length)
      result.errors.push(`native retention cancelled for ${input.home}; resume next pass`);
    return true;
  };
  if (cancelled()) return result;
  const inventory = new RolloutInventory();
  // The scan fills this map. A retained group leaves it as soon as it is counted.
  const pending = inventory.groups;
  const keepReferenced = (id: string) => {
    const group = pending.get(id);
    if (group) {
      result.kept_referenced += group.candidates.size;
      pending.delete(id);
    }
  };
  const protectedIds = new Set<string>();
  let protectedSize = -1;
  const refreshProtections = () => {
    // SQL and producer rechecks only add references. An imported rollout may
    // supply a header without its filename establishing the referenced ID.
    if (protectedSize === input.protectedSessionIds.size) return;
    let veto: NativeHomeRetentionResult | undefined;
    for (const ref of input.protectedSessionIds) {
      if (!CODEX_SESSION_ID.test(ref)) {
        const reason = `unrecognized Codex session reference ${ref}; home ${input.home} kept`;
        if (protectedSize < 0) throw new Error(reason);
        veto ??= hold(`native retention proof unreadable (Error: ${reason}): ${input.home}`);
        continue;
      }
      const id = ref.toLowerCase();
      if (protectedIds.has(id)) continue;
      if (protectedSize >= 0) {
        if (!inventory.knownIds.has(id))
          veto ??= hold(
            `new Codex session reference ${ref} has no recognized filename ID in inventory: ${input.home}`,
            true,
          );
        keepReferenced(id);
      }
      protectedIds.add(id);
    }
    protectedSize = input.protectedSessionIds.size;
    return veto;
  };
  refreshProtections();
  const home = canonicalIsolationLocator(input.home, "Codex retention home");
  const sessionsChanged = await inventory.scan(home, "sessions", cancelled);
  if (sessionsChanged) return hold(sessionsChanged, true);
  result.kept_unknown = inventory.keptUnknown("inventory");
  for (const [id, { candidates, companions }] of pending) {
    if (!candidates.size) pending.delete(id);
    else if (protectedIds.has(id)) keepReferenced(id);
    else if ([...candidates, ...companions].some((part) => part.stat.mtimeMs >= input.olderThan)) {
      result.kept_recent += candidates.size;
      pending.delete(id);
    }
  }
  if (cancelled() || !pending.size) return result;
  if (input.maxDeletions <= 0) {
    result.truncated = true;
    return result;
  }
  const archiveChanged = await inventory.scan(home, "archived_sessions", cancelled);
  if (archiveChanged) return hold(archiveChanged, true);
  let unreadable;
  try {
    unreadable = await inventory.lineage(cancelled, keepReferenced);
  } catch (error) {
    result.kept_unknown = inventory.keptUnknown("lineageHold");
    if (rolloutPathDisappeared(error))
      return hold(`rollout inventory changed: ${String(error)}`, true);
    return hold(String(error));
  }
  if (cancelled()) return result;
  const late = refreshProtections();
  if (late) return late;
  // A sole unknown outgoing edge can point anywhere. Only its own unreferenced
  // file can go, and only after every other header has ruled out an incoming edge.
  groupsLoop: for (const [id, { candidates, companions }] of pending) {
    if (cancelled()) return result;
    if (unreadable?.part === null) break; // Multiple unreadable headers rule out every unlink.
    if (unreadable && !candidates.has(unreadable.part)) continue;
    await yieldToAdmission();
    if (cancelled()) return result;
    for (const part of candidates) {
      if (unreadable && part !== unreadable.part) continue;
      if (cancelled()) return result;
      if (result.deleted_files.length >= input.maxDeletions) {
        result.truncated = true;
        return result;
      }
      try {
        const currentProof = input.canPrune();
        const late = refreshProtections();
        if (late) return late;
        const retained = !pending.has(id);
        if (retained && !unreadable) continue groupsLoop;
        if (!currentProof)
          return cancelled() ? result : hold(`native references or setup state changed: ${home}`);
        if (retained) break groupsLoop; // The sole file we could unlink just gained a reference.
      } catch (error) {
        return hold(`native retention proof unreadable (${String(error)}): ${home}`);
      }
      try {
        const directoryChanged = inventory.checkDirectories();
        if (directoryChanged) return hold(directoryChanged, true);
        // Every surviving member still participates in the age proof.
        let freedBytes = 0;
        for (const entry of [...candidates, ...companions]) {
          const before = entry.stat;
          const stat = lstatSync(entry.path, { throwIfNoEntry: false });
          if (
            !stat?.isFile() ||
            stat.dev !== before.dev ||
            stat.ino !== before.ino ||
            stat.mtimeMs !== before.mtimeMs ||
            stat.size !== before.size
          ) {
            // The receipt now names this companion as the cause of a hold.
            if (!candidates.has(entry)) result.kept_unknown--;
            return hold(`rollout changed: ${entry.path}`, true);
          }
          if (entry === part && stat.nlink === 1) freedBytes = stat.size;
        }
        if (!input.dryRun) {
          try {
            unlinkSync(part.path);
          } catch (error) {
            if (rolloutPathDisappeared(error)) return hold(`rollout changed: ${part.path}`, true);
            if (unreadable) return hold(`unlink failed for ${part.path}: ${String(error)}`);
            result.errors.push(`${part.path}: ${String(error)}`);
            continue;
          }
        }
        result.deleted_files.push(part.path);
        candidates.delete(part);
        if (!candidates.size) pending.delete(id);
        result.freed_bytes += freedBytes;
        if (!input.dryRun) {
          const replaced = inventory.didUnlink(part.path);
          if (replaced) return hold(replaced, true);
        }
        if (unreadable) break groupsLoop;
      } catch (error) {
        return hold(String(error), rolloutPathDisappeared(error));
      }
    }
  }
  if (!cancelled() && unreadable) {
    if (pending.size) {
      if (!result.deleted_files.length) {
        result.kept_unknown = inventory.keptUnknown("lineageHold");
        return hold(unreadable.reason);
      }
      result.holdReason = `pass limited to the sole ${unreadable.reason}`;
      result.truncated = true;
    }
    if (unreadable.storageFailure) result.errors.push(unreadable.storageFailure);
  }
  return result;
}

const codexNativeHomeLifetime: NativeHomeLifetime = {
  status: "managed",
  preserves:
    "Credentials, configuration, SQLite logs/indexes, archived sessions, unknown layouts, referenced or recent rollout groups, and all rollouts named as history bases during this pass.",
  home: (env) => canonicalIsolationLocator(codexStoreHome(env), "Codex retention home"),
  prune,
};

export const codexPersistence = {
  continuity: codexContinuity,
  nativeHomeLifetime: codexNativeHomeLifetime,
  nativeSessionExport: {
    storeRoot: codexStoreHome,
    // By exact thread id. Only `sessions` is shown by this adapter's own rollout
    // contract so far. No real on-disk fixture, and no real `.zst` frame, proves them.
    sessionLocations: { sessions: 4, archived_sessions: 4, shell_snapshots: 1 },
    laneCredentialStores: [".codex/auth.json"],
    formatEvidence: null,
    outOfClosure: [],
  },
};
