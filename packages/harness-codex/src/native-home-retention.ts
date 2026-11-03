import { lstatSync, unlinkSync, type Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { join } from "node:path";
import type { NativeHomeLifetime, NativeHomeRetentionInput } from "@claudexor/core";
import { canonicalIsolationLocator } from "@claudexor/core";
import { codexContinuity, codexStoreHome } from "./continuity.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROLLOUT = new RegExp(`^rollout-.+-(${UUID})\\.jsonl(?:\\.zst)?$`, "i");
const SESSION_ID = new RegExp(`^${UUID}$`, "i");

/** The same filename/part contract as codexContinuity. SQLite logs and indexes
 * have no proven independent deletion contract and are deliberately untouched. */
async function prune(input: NativeHomeRetentionInput) {
  const result = {
    deleted_files: [] as string[],
    errors: [] as string[],
    freed_bytes: 0,
    kept_referenced: 0,
    kept_recent: 0,
    kept_unknown: 0,
    truncated: false,
  };
  const cancelled = () => {
    if (!input.signal?.aborted) return false;
    result.truncated = true;
    if (!result.errors.length)
      result.errors.push(`native retention cancelled for ${input.home}; resume next pass`);
    return true;
  };
  if (cancelled()) return result;
  let normalizedSize = -1;
  let normalized = new Set<string>();
  const protectedIds = () => {
    // The proof only adds protections within a pass. Keep membership checks
    // cheap across large homes, but validate every newly published reference.
    if (input.protectedSessionIds.size !== normalizedSize) {
      normalized = new Set(
        [...input.protectedSessionIds].map((id) => {
          if (!SESSION_ID.test(id))
            throw new Error(`unrecognized Codex session reference ${id}; home ${input.home} kept`);
          return id.toLowerCase();
        }),
      );
      normalizedSize = input.protectedSessionIds.size;
    }
    return normalized;
  };
  protectedIds(); // Reject unreadable ownership before scanning any files.
  const home = canonicalIsolationLocator(input.home, "Codex retention home");
  const sessions = join(home, "sessions");
  const sessionsStat = await lstat(sessions).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!sessionsStat) return result;
  if (!sessionsStat.isDirectory())
    throw new Error(`Codex sessions ${sessions} is not a plain directory; home kept`);
  const groups = new Map<string, Array<{ path: string; stat: Stats }>>();
  const scan = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (cancelled()) return;
      const path = join(dir, entry.name);
      if (
        depth > 0 &&
        entry.isDirectory() &&
        (depth === 3 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)
      )
        await scan(path, depth - 1);
      else if (depth === 0 && entry.isFile()) {
        const match = ROLLOUT.exec(entry.name);
        if (!match) {
          result.kept_unknown += 1;
          continue;
        }
        const id = match[1]!.toLowerCase();
        const parts = groups.get(id) ?? [];
        parts.push({ path, stat: await lstat(path) });
        groups.set(id, parts);
      } else result.kept_unknown += 1;
    }
  };
  // Complete inventory before the first unlink; a failed read deletes nothing.
  await scan(sessions, 3);
  groupsLoop: for (const [id, parts] of groups) {
    if (cancelled()) return result;
    if (protectedIds().has(id)) {
      result.kept_referenced += parts.length;
      continue;
    }
    if (parts.some((part) => part.stat.mtimeMs >= input.olderThan)) {
      result.kept_recent += parts.length;
      continue;
    }
    await yieldToAdmission();
    if (cancelled()) return result;
    for (const [i, part] of parts.entries()) {
      if (cancelled()) return result;
      if (result.deleted_files.length >= input.maxDeletions) {
        result.truncated = true;
        return result;
      }
      let currentProof: boolean;
      try {
        currentProof = input.canPrune();
        if (protectedIds().has(id)) {
          result.kept_referenced += parts.length - i;
          continue groupsLoop;
        }
      } catch (error) {
        result.errors.push(
          `native retention proof unreadable; remaining files kept: ${String(error)}`,
        );
        return result;
      }
      if (!currentProof) {
        result.errors.push(
          "native retention references or setup state changed; remaining files kept",
        );
        return result;
      }
      try {
        // Recheck remaining inventoried parts after the fresh proof. A changed
        // part protects the group. No await from proof to unlink.
        const remaining = parts.slice(i);
        const current = remaining.map((entry) => lstatSync(entry.path));
        if (
          current.some((stat, index) => {
            const before = remaining[index]!.stat;
            return (
              !stat.isFile() ||
              stat.dev !== before.dev ||
              stat.ino !== before.ino ||
              stat.mtimeMs !== before.mtimeMs ||
              stat.size !== before.size
            );
          })
        ) {
          result.kept_unknown += remaining.length;
          continue groupsLoop;
        }
        if (!input.dryRun) unlinkSync(part.path);
        result.deleted_files.push(part.path);
        if (current[0]!.nlink === 1) result.freed_bytes += current[0]!.size;
      } catch (error) {
        result.errors.push(
          `${part.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return result;
}

const codexNativeHomeLifetime: NativeHomeLifetime = {
  status: "managed",
  preserves:
    "Credentials, configuration, SQLite logs/indexes, archived sessions and unknown layouts; referenced or recently updated rollout parts.",
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
