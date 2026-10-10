/** One logical journal record as the fold sees it: an ordinary frame or one
 * record inside a compacted snapshot. `byteLength` is the record's serialized
 * logical size in bytes as stored in its source (informational: it feeds the
 * retired-bytes receipt, never a decision). */
export interface FoldRecord {
  seq: number;
  type: string;
  time: string;
  payload: unknown;
  byteLength: number;
}

/** Default (undefined / empty object) = keep. Deterministic. Called once per
 * logical record in seq order, for ordinary frames and for records inside
 * compacted snapshots alike. */
export interface FoldVerdict {
  /** Do not retain this record (retire/slot/group still apply). */
  drop?: boolean;
  /** Single-holder key: a later record with the same slot drops the earlier holder. */
  slot?: string;
  /** Multi-holder key: registered, never auto-superseded. */
  group?: string;
  /** Drop every retained record currently registered under these slot/group
   * names (applied BEFORE registering this record). */
  retire?: readonly string[];
}

/** The policy is supplied by the caller (the daemon); the journal stays generic
 * and never decides WHAT is dead. */
export interface JournalFold {
  verdict(record: FoldRecord): FoldVerdict;
}

/** Identity fold: every record is retained. */
export const keepEverything: JournalFold = Object.freeze({ verdict: () => ({}) });

export interface FoldResult<T> {
  retained: T[];
  retiredCount: number;
  retiredBytes: number;
}

/** Streaming fold engine. Records are pushed in seq order; a record dropped by
 * a later verdict leaves no reference behind (tombstones are Map deletions), so
 * memory is proportional to the retained set plus live slot/group names, never
 * to the number of records seen. */
export interface FoldStream<T> {
  push(record: T, view: FoldRecord): void;
  finish(): FoldResult<T>;
}

interface Held<T> {
  record: T;
  bytes: number;
  slot: string | undefined;
  group: string | undefined;
}

export function foldStream<T>(fold: JournalFold = keepEverything): FoldStream<T> {
  // Insertion order is seq order; deletions never reorder the survivors.
  const held = new Map<number, Held<T>>();
  const slots = new Map<string, number>();
  const groups = new Map<string, Set<number>>();
  let nextId = 0;
  let retiredCount = 0;
  let retiredBytes = 0;
  let finished = false;

  const drop = (id: number): void => {
    const entry = held.get(id);
    if (!entry) return;
    held.delete(id);
    retiredCount += 1;
    retiredBytes += entry.bytes;
    if (entry.slot !== undefined && slots.get(entry.slot) === id) slots.delete(entry.slot);
    if (entry.group !== undefined) {
      const members = groups.get(entry.group);
      members?.delete(id);
      if (members && members.size === 0) groups.delete(entry.group);
    }
  };

  const retire = (name: string): void => {
    const holder = slots.get(name);
    if (holder !== undefined) drop(holder);
    const members = groups.get(name);
    if (members) for (const id of [...members]) drop(id);
  };

  return {
    push(record, view) {
      if (finished) throw new Error("journal fold stream is finished");
      const verdict = fold.verdict(view) ?? {};
      if (verdict.retire) for (const name of verdict.retire) retire(name);
      if (verdict.slot !== undefined) {
        const holder = slots.get(verdict.slot);
        if (holder !== undefined) drop(holder);
      }
      if (verdict.drop) {
        retiredCount += 1;
        retiredBytes += view.byteLength;
        return;
      }
      const id = nextId;
      nextId += 1;
      held.set(id, { record, bytes: view.byteLength, slot: verdict.slot, group: verdict.group });
      if (verdict.slot !== undefined) slots.set(verdict.slot, id);
      if (verdict.group !== undefined) {
        let members = groups.get(verdict.group);
        if (!members) {
          members = new Set();
          groups.set(verdict.group, members);
        }
        members.add(id);
      }
    },
    finish() {
      finished = true;
      const retained: T[] = [];
      for (const entry of held.values()) retained.push(entry.record);
      held.clear();
      slots.clear();
      groups.clear();
      return { retained, retiredCount, retiredBytes };
    },
  };
}
