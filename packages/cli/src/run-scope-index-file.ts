import { readFileSync, renameSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { measureSync } from "@claudexor/util";
import { parseEntry, type RunScopeEntry } from "./run-scope-index-rows.js";

/**
 * The `daemon/run-scopes.json` file (schema_version 1): the discovery record a
 * host's Panic and the next daemon start read. Rows this engine cannot parse
 * are kept in place, verbatim and in their positions, so neither the recognized
 * live records nor the unknown remainder disappear from that view (positions are
 * kept as far as retirements allow); the engine never acts on an unrecognized row.
 */
export interface RunScopeIndexFile {
  schema_version: 1;
  entries: unknown[];
}

export interface LoadedRunScopeIndex {
  entries: RunScopeEntry[];
  /** Raw rows this engine could not parse, with their original positions. */
  unrecognized: Array<{ index: number; value: unknown }>;
  /** Why the whole file could not be used, or which rows are unknown; null when clean. */
  notice: string | null;
}

/** Read the index. A missing file is empty; an unusable FILE is moved aside and
 * starts empty (its obligations are unknown); unusable ROWS stay where they are. */
export function loadRunScopeIndex(
  path: string,
  log: (message: string) => void,
): LoadedRunScopeIndex {
  const empty = (notice: string | null): LoadedRunScopeIndex => ({
    entries: [],
    unrecognized: [],
    notice,
  });
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return empty(null);
    return empty(preserveAside(path, `read failed: ${String(error)}`, log));
  }
  let raw: Partial<RunScopeIndexFile>;
  try {
    raw = JSON.parse(text) as Partial<RunScopeIndexFile>;
    if (!raw || typeof raw !== "object" || raw.schema_version !== 1 || !Array.isArray(raw.entries))
      throw new Error("not a run-scope index (schema_version 1 with an entries array)");
  } catch (error) {
    return empty(preserveAside(path, `parse failed: ${String(error)}`, log));
  }
  const loaded: LoadedRunScopeIndex = { entries: [], unrecognized: [], notice: null };
  for (const [index, value] of raw.entries.entries()) {
    const entry = parseEntry(value);
    if (entry === null) loaded.unrecognized.push({ index, value });
    else loaded.entries.push(entry);
  }
  if (loaded.unrecognized.length > 0) {
    loaded.notice = `run-scope index keeps ${loaded.unrecognized.length} unrecognized row(s) (first #${loaded.unrecognized[0]!.index}) verbatim; their cleanup obligations are UNKNOWN until an operator inspects them`;
    log(loaded.notice);
  }
  return loaded;
}

/** The unusable file's bytes are evidence of unknown obligations: keep them beside the index. */
function preserveAside(path: string, reason: string, log: (message: string) => void): string {
  const aside = `${path}.unreadable-${Date.now()}`;
  let moved = false;
  try {
    renameSync(path, aside);
    moved = true;
  } catch {
    /* nothing to move (or no permission): the disclosure below still names the problem */
  }
  const notice = `run-scope index unreadable (${reason}); ${
    moved ? `preserved as ${aside}` : "could not be moved aside"
  }; its cleanup obligations are UNKNOWN until an operator inspects it`;
  log(`${notice}; starting an empty index`);
  return notice;
}

/** Recognized entries with the unrecognized rows back at their original positions. */
export function runScopeIndexBody(loaded: {
  entries: readonly RunScopeEntry[];
  unrecognized: readonly { index: number; value: unknown }[];
}): RunScopeIndexFile {
  const entries: unknown[] = [...loaded.entries];
  for (const row of loaded.unrecognized)
    entries.splice(Math.min(row.index, entries.length), 0, row.value);
  return { schema_version: 1, entries };
}

/**
 * Compact, coalesced publication with a receipt per revision. Every mutation
 * takes a new revision; `publish(revision)` resolves only once a write that
 * serialized at least that revision was renamed into place, and rejects when
 * the write that carried it failed. One write runs at a time; mutations that
 * arrive during it are carried together by the next one, so the open, seed and
 * terminal barriers keep their meaning at a fraction of the writes. A failed write
 * publishes nothing: its receipts stay rejected and its revisions stay above
 * `published` until `repeat`, or any later write, carries them. The log says so once
 * when that starts and once when it ends. The debt lives with this daemon: a restart
 * before a write lands reads the stale row and settles it again by identity.
 */
export class RunScopeIndexPublisher {
  private revision = 0;
  private published = 0;
  private lastPublishedText: string | undefined;
  private writing = false;
  /** The last write failed: its changes are unpublished. */
  private failing = false;
  private waiters: Array<{ revision: number; settle: (error?: unknown) => void }> = [];

  constructor(
    private readonly path: string,
    private readonly body: () => RunScopeIndexFile,
    private readonly log: (message: string) => void,
    private readonly write: (path: string, text: string) => Promise<void> = writeAtomically,
  ) {}

  /** The state changed: the revision a later `publish` must cover. */
  changed(): number {
    return ++this.revision;
  }

  publish(revision = this.revision): Promise<void> {
    if (revision <= this.published) return Promise.resolve();
    const receipt = new Promise<void>((resolve, reject) =>
      this.waiters.push({
        revision,
        settle: (error) => (error === undefined ? resolve() : reject(error)),
      }),
    );
    void this.drain();
    return receipt;
  }

  /**
   * Write again what a failed write left unpublished, with the current state; with
   * nothing owed it writes nothing. Only the file is repeated, never what the state
   * records. A running write is left to finish, so one that hangs collects nothing.
   */
  repeat(): void {
    // A failure here is `disclose`'s, which has told the log.
    if (!this.writing) void this.publish().catch(() => {});
  }

  private async drain(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.waiters.length > 0) {
        const target = this.revision;
        let failure: unknown;
        try {
          const text = measureSync("scope.persist", () => JSON.stringify(this.body()));
          if (text !== this.lastPublishedText) {
            await this.write(this.path, text);
            this.lastPublishedText = text;
          }
          this.published = Math.max(this.published, target);
        } catch (error) {
          failure = error ?? new Error("run-scope index write failed");
        }
        const settled = this.waiters.filter((waiter) => waiter.revision <= target);
        this.waiters = this.waiters.filter((waiter) => waiter.revision > target);
        for (const waiter of settled) waiter.settle(failure);
        this.disclose(failure);
      }
    } finally {
      this.writing = false;
    }
  }

  /** Whoever's write it was: only a change between failing and landing is news. */
  private disclose(failure: unknown): void {
    if ((failure !== undefined) === this.failing) return;
    this.failing = failure !== undefined;
    this.log(
      this.failing
        ? `run-scope index: changes stay unpublished after a failed write; the capture tick repeats it (${
            failure instanceof Error ? failure.message : String(failure)
          })`
        : "run-scope index: the unpublished changes have now landed",
    );
  }
}

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}
