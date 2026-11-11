import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { ThreadExportGapCode, ThreadExportSession } from "@claudexor/schema";
import { MAX_LINE_BYTES, nameOwnedBy, transcriptFacts } from "./thread-export-sessions.js";
import {
  bundleSegment,
  describeEntry,
  walkTree,
  type WalkedEntry,
  type WalkProblem,
} from "./thread-export-walk.js";

/** One account store of a harness, named by the adapter's own declaration. */
export interface NativeStoreRef {
  storeKey: string;
  profileId: string | null;
  root: string;
  /** Every spelling of this store a transcript may have recorded. */
  spellings?: readonly string[];
}

export interface NativeLayout {
  stores: NativeStoreRef[];
  /** The store directories that hold session-bound entries, each with the depth
   * of those entries below it. Nothing else in a store is ever listed. */
  sessionLocations: Readonly<Record<string, number>>;
  /** Stores whose root could not be determined: each may hold any session. */
  unresolved: readonly { storeKey: string; message: string }[];
  /** What a recorded real session proves of this layout; null when nothing does. */
  evidence: {
    vendorVersions: readonly string[];
    platforms: readonly string[];
    transcriptOf(rel: string, nativeSessionId: string): string | null;
    versionField: string | null;
  } | null;
  /** Known sources this export does not carry, named on every manifest. */
  outOfClosure: readonly { source: string; reason: string }[];
}

export interface StoreSessionMaterial {
  /** Session id -> everything in this store whose name that session owns. */
  owned: Map<string, WalkedEntry[]>;
  problems: WalkProblem[];
}

/**
 * Find every entry of one store bound to these exact session ids, in one walk of
 * the adapter's declared session locations. The rule is the name alone: no file
 * is opened, no path is taken from a transcript or tool text, nothing outside
 * those locations is listed, and a link is never entered. What a matched
 * directory holds is carried whole.
 */
export async function storeSessionMaterial(
  store: NativeStoreRef,
  locations: Readonly<Record<string, number>>,
  sessionIds: readonly string[],
  signal?: AbortSignal,
): Promise<StoreSessionMaterial> {
  const owned = new Map<string, WalkedEntry[]>();
  const problems: WalkProblem[] = [];
  const claim = async (id: string, path: string, rel: string): Promise<void> => {
    const list = owned.get(id) ?? [];
    owned.set(id, list);
    const entry = await describeEntry(path, rel);
    signal?.throwIfAborted();
    if ("message" in entry) problems.push(entry);
    else if (entry.kind !== "directory") list.push(entry);
    else {
      const walked = await walkTree(path, rel, signal);
      list.push(...walked.entries);
      problems.push(...walked.problems);
    }
  };
  const visit = async (dir: string, rel: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        problems.push({ rel, message: (error as NodeJS.ErrnoException).code ?? "unreadable" });
      return;
    }
    signal?.throwIfAborted();
    let visited = 0;
    for (const entry of names) {
      // Unmatched names do no I/O: give Stop a turn even in a flat store.
      if (++visited % 64 === 0) await nextTurn();
      signal?.throwIfAborted();
      const childRel = `${rel}/${entry.name}`;
      const path = join(dir, entry.name);
      const owners = sessionIds.filter((id) => nameOwnedBy(entry.name, id));
      for (const id of owners) await claim(id, path, childRel);
      if (owners.length === 0 && entry.isDirectory() && depth > 1)
        await visit(path, childRel, depth - 1);
    }
  };
  for (const [location, depth] of Object.entries(locations)) {
    signal?.throwIfAborted();
    const path = join(store.root, location);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      signal?.throwIfAborted();
      if (!absent(error))
        problems.push({
          rel: location,
          message: (error as NodeJS.ErrnoException).code ?? "unreadable",
        });
      continue;
    }
    signal?.throwIfAborted();
    if (!stat.isDirectory()) {
      problems.push({
        rel: location,
        message: stat.isSymbolicLink()
          ? "session location is a symlink; not followed"
          : "session location is not a directory",
      });
      continue;
    }
    await visit(path, location, depth);
  }
  return { owned, problems };
}

const absent = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};
const problemOf = (store: NativeStoreRef, error: unknown) => ({
  storeKey: store.storeKey,
  message: `${store.root}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
});

/**
 * Distinct stores to read: two spellings of one store are one store. A store
 * that does not exist holds nothing; one that cannot be resolved or read may
 * hold any session, so it is reported, never skipped.
 */
export async function existingStores(stores: readonly NativeStoreRef[]): Promise<{
  stores: NativeStoreRef[];
  problems: { storeKey: string; message: string }[];
}> {
  const seen = new Set<string>();
  const out: NativeStoreRef[] = [];
  const problems: { storeKey: string; message: string }[] = [];
  for (const store of stores) {
    let real: string;
    let stat;
    try {
      real = await realpath(store.root);
      if (seen.has(real)) continue;
      stat = await lstat(real);
    } catch (error) {
      if (!absent(error)) problems.push(problemOf(store, error));
      continue;
    }
    // A store is a directory; anything else holds no session.
    if (!stat.isDirectory()) continue;
    seen.add(real);
    out.push({ ...store, root: real, spellings: [...new Set([real, store.root])] });
  }
  return { stores: out, problems };
}

export interface NativeSessionSink {
  gap(code: ThreadExportGapCode, subject: string, message: string): void;
  /** Carry one entry under this bundle prefix, exactly. */
  carry(prefix: string, entry: WalkedEntry): void;
  disclose(source: string, reason: string): void;
}

/**
 * Every copy of one harness's recorded sessions, in every store it declares,
 * and how far the recording that qualifies its layout covers each. A session
 * gets its status, and every reason it cannot retire becomes a named gap: no
 * declared format, a store that cannot be listed, a copy missing its transcript,
 * a session held nowhere, or anything the recording did not prove.
 */
export async function exportHarnessSessions(
  harness: string,
  layout: NativeLayout | null,
  sessions: ReadonlyMap<string, ThreadExportSession>,
  laneEntries: readonly WalkedEntry[],
  sink: NativeSessionSink,
  signal?: AbortSignal,
): Promise<void> {
  const ids = [...sessions.keys()];
  const held = (id: string) => sessions.get(id)!;
  for (const { source, reason } of layout?.outOfClosure ?? []) sink.disclose(source, reason);
  if (!layout) {
    for (const id of ids) {
      held(id).status = "unsupported";
      sink.gap(
        "native_session_unsupported",
        id,
        `harness ${harness} declares no exportable session format`,
      );
    }
    return;
  }
  const unreadable = new Set<string>();
  const reasons = (): Map<string, Set<string>> => new Map();
  const unproven = reasons();
  const lacking = reasons();
  const note = (to: Map<string, Set<string>>) => (id: string, reason: string) => {
    const list = to.get(id) ?? new Set<string>();
    list.add(reason);
    to.set(id, list);
  };
  const doubt = note(unproven);
  const lack = note(lacking);
  const unread = (id: string, subject: string, message: string): void => {
    unreadable.add(id);
    sink.gap("native_session_unreadable", subject, message);
  };
  const resolved = await existingStores(layout.stores);
  // A store whose contents cannot be listed may hold a copy of any session.
  for (const problem of [...layout.unresolved, ...resolved.problems]) {
    for (const id of ids) unreadable.add(id);
    sink.gap("native_session_unreadable", problem.storeKey, problem.message);
  }
  for (const store of resolved.stores) {
    const material = await storeSessionMaterial(store, layout.sessionLocations, ids, signal);
    for (const issue of material.problems) {
      for (const id of ids) unreadable.add(id);
      sink.gap("native_session_unreadable", `${store.storeKey}/${issue.rel}`, issue.message);
    }
    for (const [id, entries] of material.owned) {
      if (entries.length === 0) continue;
      held(id).copies.push({ storeKey: store.storeKey, profileId: store.profileId });
      for (const entry of entries)
        sink.carry(`native/${bundleSegment(harness)}/${bundleSegment(store.storeKey)}`, entry);
      await proveCopy(layout, store, id, entries, { doubt, lack, unread }, signal);
    }
  }
  for (const id of ids) {
    const session = held(id);
    if (laneEntries.some((entry) => entry.rel.split("/").some((n) => nameOwnedBy(n, id)))) {
      session.copies.push({ storeKey: "lane", profileId: null });
      if (layout.evidence) doubt(id, "a copy in a lane home, which no recording exercised");
    }
    if (session.copies.length === 0 && !unreadable.has(id))
      lack(id, `session ${id} was recorded but is in no ${harness} store`);
    for (const reason of lacking.get(id) ?? []) sink.gap("native_session_missing", id, reason);
    if (!layout.evidence && session.copies.length > 0)
      sink.gap(
        "native_format_unqualified",
        id,
        `no real on-disk ${harness} session was recorded; its files are preserved but cannot retire`,
      );
    for (const reason of unproven.get(id) ?? [])
      sink.gap("native_format_unqualified", id, `${harness}: ${reason}`);
    session.status = unreadable.has(id)
      ? "unreadable"
      : lacking.has(id)
        ? "missing"
        : !layout.evidence || unproven.has(id)
          ? "unqualified"
          : "exported";
  }
}

/**
 * A recording proves exact versions, platforms and entries, never a whole harness.
 * This host must be a platform it was recorded on. Every entry of this copy must be
 * one the recording held, beside the transcript it belongs with; that transcript is
 * read whole, and must name only recorded versions and only store paths this export
 * carries.
 */
async function proveCopy(
  layout: NativeLayout,
  store: NativeStoreRef,
  id: string,
  entries: readonly WalkedEntry[],
  report: {
    doubt(id: string, reason: string): void;
    lack(id: string, reason: string): void;
    unread(id: string, subject: string, message: string): void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const { doubt, lack } = report;
  const evidence = layout.evidence;
  if (!evidence) return;
  if (!evidence.platforms.includes(process.platform))
    doubt(id, `no recording exercised a session on ${process.platform}`);
  const carried = new Set(entries.map((entry) => entry.rel));
  const files = new Map<string, WalkedEntry & { kind: "file" }>();
  for (const entry of entries) if (entry.kind === "file") files.set(entry.rel, entry);
  const transcripts = new Set<string>();
  for (const entry of entries) {
    const transcript = entry.kind === "file" ? evidence.transcriptOf(entry.rel, id) : null;
    if (transcript === null) doubt(id, `no recording exercised ${entry.kind} ${entry.rel}`);
    else transcripts.add(transcript);
  }
  for (const transcript of transcripts) {
    const entry = files.get(transcript);
    if (!entry) {
      lack(
        id,
        `${store.storeKey} holds material of this session without its transcript ${transcript}`,
      );
      continue;
    }
    let facts: Awaited<ReturnType<typeof transcriptFacts>>;
    try {
      facts = await transcriptFacts(
        entry.file.absPath,
        evidence.versionField,
        store.spellings ?? [store.root],
        process.platform,
        signal,
      );
    } catch (error) {
      // Stop is not a transcript the store failed to hold.
      signal?.throwIfAborted();
      report.unread(
        id,
        `${store.storeKey}/${transcript}`,
        (error as NodeJS.ErrnoException).code ?? String(error),
      );
      continue;
    }
    if (facts.unreadableRows > 0)
      doubt(
        id,
        `${transcript} has ${facts.unreadableRows} row(s) that are not UTF-8 JSON records, so what they name is unchecked`,
      );
    if (facts.oversizedRows > 0)
      doubt(
        id,
        `${transcript} has ${facts.oversizedRows} row(s) over ${MAX_LINE_BYTES} bytes, which this export does not read`,
      );
    if (evidence.versionField) {
      if (facts.versions.size === 0) doubt(id, `${transcript} names no vendor version`);
      for (const version of facts.versions)
        if (!evidence.vendorVersions.includes(version))
          doubt(id, `no recording exercised vendor version ${version}`);
    }
    for (const reference of facts.storeReferences)
      if (!carried.has(reference))
        doubt(id, `its transcript names ${reference} in the store, which is not carried`);
  }
}
