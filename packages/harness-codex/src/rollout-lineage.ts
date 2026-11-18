import { lstatSync, type BigIntStats, type Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { record } from "./responses.js";
import { readCodexRolloutHead, RolloutIdentityChanged } from "./rollout-file.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const CODEX_SESSION_ID = new RegExp(`^${UUID}$`, "i");
const IDS_IN_NAME = new RegExp(UUID, "gi");
const NAME = new RegExp(`^rollout-.+-(${UUID})(?:_(${UUID}))?\\.jsonl(?:\\.zst)?$`, "i");
const ROLLOUT = /^rollout-.+\.jsonl(?:\.zst)?$/i;
const DATE_DIR = [/^\d{2}$/, /^\d{2}$/, /^\d{4}$/];

interface RolloutPart {
  path: string;
  stat: Stats;
}

interface RolloutGroup {
  candidates: Set<RolloutPart>;
  companions: RolloutPart[];
}

export function rolloutPathDisappeared(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function historyBase(header: unknown): string | undefined {
  const meta = record(header);
  const payload = record(meta?.payload);
  if (
    meta?.type !== "session_meta" ||
    typeof payload?.id !== "string" ||
    !CODEX_SESSION_ID.test(payload.id)
  )
    throw new Error("expected a session_meta header with a session id");
  if (payload.history_base == null) return undefined;
  const id = record(payload.history_base)?.thread_id;
  if (typeof id !== "string" || !CODEX_SESSION_ID.test(id))
    throw new Error("history_base names no rollout id");
  return id.toLowerCase();
}

/** One pass over the two Codex stores. Only dated, one-id session files can be removed. */
export class RolloutInventory {
  readonly groups = new Map<string, RolloutGroup>();
  readonly knownIds = new Set<string>();
  private readonly unknownSessions = new Map<string, "informational" | "veto">();
  private readonly parts: RolloutPart[] = [];
  private readonly directories = new Map<string, BigIntStats | undefined>();
  private unreadable?: string;

  keptUnknown(outcome: "inventory" | "lineageHold"): number {
    if (outcome === "inventory") return this.unknownSessions.size;
    let count = 0;
    for (const kind of this.unknownSessions.values()) {
      if (kind === "informational") count++;
    }
    return count;
  }

  async scan(home: string, store: "sessions" | "archived_sessions", cancelled: () => boolean) {
    const visit = async (dir: string, depth: number, datedPath: boolean): Promise<void> => {
      if (cancelled()) return;
      const before =
        depth === 3
          ? lstatSync(dir, { bigint: true, throwIfNoEntry: false })
          : lstatSync(dir, { bigint: true });
      this.directories.set(dir, before);
      if (!before) return;
      if (!before.isDirectory()) throw new Error(`${dir} is not a plain directory`);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (cancelled()) return;
        const path = join(dir, entry.name);
        const dated = depth > 0 && DATE_DIR[depth - 1]!.test(entry.name);
        // Continuity walks three directories under sessions, regardless of their names.
        const directoryInLookup = depth > 0 && (store === "sessions" || dated);
        if (directoryInLookup && entry.isDirectory()) {
          await visit(path, depth - 1, datedPath && dated);
          continue;
        }
        // Imported paths supply edges only; keep the original name proof for late references.
        const match = datedPath ? NAME.exec(entry.name) : null;
        const ids = entry.name.match(IDS_IN_NAME) ?? [];
        const locatedPart =
          store === "sessions" &&
          depth === 0 &&
          ids.length > 0 &&
          (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst"));
        // A final hyphen + UUID grouped dated parts even if the prefix contained
        // another UUID. An underscore-separated thread/rollout pair never did.
        const grouped = store === "sessions" && depth === 0 && entry.isFile() && match && !match[2];
        const candidate = grouped && ids.length === 1;
        const rollout = (datedPath && ROLLOUT.test(entry.name)) || locatedPart;
        const linkedBranch = directoryInLookup && entry.isSymbolicLink();
        const unsafe = linkedBranch || (rollout && !entry.isFile());
        if (store === "sessions" && !candidate)
          this.unknownSessions.set(path, unsafe ? "veto" : "informational");
        if (unsafe) {
          const reason = linkedBranch ? "link in rollout lookup" : "not a plain rollout file";
          this.unreadable ??= `${path}: ${reason}`;
          continue;
        }
        if (!rollout) continue;
        const part = { path, stat: await lstat(path) };
        this.parts.push(part);
        if (match) {
          const id = match[1]!.toLowerCase();
          this.knownIds.add(id);
          if (match[2]) this.knownIds.add(match[2].toLowerCase());
          if (grouped) {
            const group: RolloutGroup = this.groups.get(id) ?? {
              candidates: new Set(),
              companions: [],
            };
            if (candidate) group.candidates.add(part);
            else group.companions.push(part);
            this.groups.set(id, group);
          }
        }
      }
    };
    try {
      await visit(join(home, store), 3, true);
    } catch (error) {
      if (rolloutPathDisappeared(error)) return `rollout inventory changed: ${String(error)}`;
      throw error;
    }
  }

  /** A partial unlink may leave either representation. Both headers contribute edges. */
  async lineage(cancelled: () => boolean, keepReferenced: (id: string) => void) {
    if (this.unreadable) throw new Error(this.unreadable);
    let unreadable: { part: RolloutPart; reason: string } | undefined;
    let storageFailure: string | undefined;
    for (const part of this.parts) {
      if (cancelled()) break;
      const { path, stat } = part;
      let base;
      try {
        base = historyBase(await readCodexRolloutHead(path, stat));
      } catch (error) {
        if (this.unknownSessions.has(path)) this.unknownSessions.set(path, "veto");
        if (rolloutPathDisappeared(error)) throw error;
        const reason = `unreadable rollout header (${String(error)}): ${path}`;
        if (error instanceof RolloutIdentityChanged || (error as NodeJS.ErrnoException)?.syscall)
          storageFailure ??= reason;
        if (unreadable)
          return { part: null, reason: `${unreadable.reason}; ${reason}`, storageFailure };
        unreadable = { part, reason };
        continue;
      }
      if (base) keepReferenced(base);
    }
    return unreadable && { ...unreadable, storageFailure };
  }

  /** Check the listed directories by metadata. No file enumeration or header reads here. */
  checkDirectories(): string | undefined {
    for (const [dir, before] of this.directories) {
      const now = lstatSync(dir, { bigint: true, throwIfNoEntry: false });
      if (
        (now && !now.isDirectory()) ||
        now?.dev !== before?.dev ||
        now?.ino !== before?.ino ||
        now?.size !== before?.size ||
        now?.mtimeNs !== before?.mtimeNs ||
        now?.ctimeNs !== before?.ctimeNs
      )
        return `rollout directory changed: ${dir}`;
    }
  }

  didUnlink(path: string): string | undefined {
    const dir = dirname(path);
    const before = this.directories.get(dir);
    const now = lstatSync(dir, { bigint: true, throwIfNoEntry: false });
    if (!now?.isDirectory() || now.dev !== before?.dev || now.ino !== before?.ino)
      return `rollout directory replaced: ${dir}`;
    this.directories.set(dir, now);
  }
}
