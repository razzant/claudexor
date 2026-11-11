import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { RunContinuityReceipt } from "@claudexor/schema";
import {
  addExecutionEvent,
  copyExecutionFold,
  emptyExecutionFold,
  type ExecutionFold,
} from "@claudexor/workspace";
import { addBudgetEvent, emptyBudgetFold, type BudgetEventFold } from "./budget-valuation.js";
import { inProjectionScope, projectionRead } from "./projection-context.js";
import { continuityReceiptOf } from "./run-continuation-projection.js";
import {
  COMPLETE_INTEGRITY,
  addPlanEvent,
  addTimelineEvent,
  countEventsRead,
  emptyPlanCandidates,
  emptyTimelineWindow,
  parseEventLine,
  runEventsSource,
  type PlanCandidates,
  type RunDirCarrier,
  type RunEventsIntegrity,
  type TimelineWindow,
} from "./run-timeline.js";

/**
 * What run detail and summary fold from a run's complete events.jsonl: the
 * integrity counts, the timeline window, plan candidates, continuity receipts,
 * budget accumulators and the continuation planner's execution facts. The
 * events themselves are not kept. Artifacts, decisions and live fields are
 * never part of it; projections combine them freshly on every request.
 */
export interface RunEventFacts {
  integrity: RunEventsIntegrity;
  timeline: TimelineWindow;
  plans: PlanCandidates;
  continuity: RunContinuityReceipt[];
  budget: BudgetEventFold;
  execution: ExecutionFold;
}

const CHUNK_BYTES = 64 * 1024;
const GUARD_BYTES = 4 * 1024;
/** Per-thread retention bounds. A run over its share, or evicted, is simply
 * folded from byte 0 again by its next read. */
const RETAINED_RUNS = 32;
const RETAINED_RUN_BYTES = 8 * 1024 * 1024;
const RETAINED_BYTES = 64 * 1024 * 1024;

interface Retained {
  dev: bigint;
  ino: bigint;
  /** Folded through this offset, which always follows a newline. */
  offset: number;
  /** The log's first bytes and the bytes just before `offset`, re-checked on reuse. */
  head: Buffer;
  tail: Buffer;
  /** Never mutated once retained: a later read folds into a copy. */
  facts: RunEventFacts;
  bytes: number;
}

/** Recency-ordered, keyed by run directory, only in the projecting thread. */
const retained = new Map<string, Retained>();
let retainedBytes = 0;

/**
 * The run's folded event facts, read once per projection. Inside a projection
 * scope (the bulk worker) a run's folded prefix is kept between requests and
 * only appended bytes are parsed; another identity, a shorter log or changed
 * guard bytes refold from byte 0. A last record without its newline counts
 * for this answer only. Callers outside a projection always fold afresh.
 */
export function readRunEventFacts(rec: RunDirCarrier): RunEventFacts {
  return projectionRead(rec.runDir ?? "", "events:facts", () =>
    foldRunEvents(rec, inProjectionScope()),
  );
}

/** Test observability of the retention bounds. */
export function retainedRunEventFactsForTests(): { runs: number; bytes: number } {
  return { runs: retained.size, bytes: retainedBytes };
}

function emptyFacts(integrity: RunEventsIntegrity): RunEventFacts {
  return {
    integrity,
    timeline: emptyTimelineWindow(),
    plans: emptyPlanCandidates(),
    continuity: [],
    budget: emptyBudgetFold(),
    execution: emptyExecutionFold(),
  };
}

function copyFacts(facts: RunEventFacts): RunEventFacts {
  const { timeline, plans } = facts;
  return {
    integrity: { ...facts.integrity },
    timeline: { ...timeline, rows: [...timeline.rows], sizes: [...timeline.sizes] },
    plans: { last: plans.last, byAttempt: new Map(plans.byAttempt) },
    continuity: [...facts.continuity],
    budget: { ...facts.budget },
    execution: copyExecutionFold(facts.execution),
  };
}

function addRunEvent(facts: RunEventFacts, ev: Record<string, unknown>, size: number): void {
  addTimelineEvent(facts.timeline, ev, size);
  addPlanEvent(facts.plans, ev);
  const receipt = continuityReceiptOf(ev);
  if (receipt) facts.continuity.push(receipt);
  addBudgetEvent(facts.budget, ev);
  addExecutionEvent(facts.execution, ev);
}

function foldRunEvents(rec: RunDirCarrier, reuse: boolean): RunEventFacts {
  const key = rec.runDir ?? "";
  const path = runEventsSource(rec);
  if (typeof path !== "string") {
    forget(key);
    return emptyFacts(path);
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    // Freeze the end on the opened descriptor, exactly like the snapshot reader.
    const { dev, ino, size } = fstatSync(fd, { bigint: true });
    const end = Number(size);
    const prior = reuse ? retained.get(key) : undefined;
    const usable =
      prior !== undefined &&
      prior.dev === dev &&
      prior.ino === ino &&
      prior.offset <= end &&
      sameBytes(fd, prior.head, 0) &&
      sameBytes(fd, prior.tail, prior.offset - prior.tail.length);
    const facts = usable ? copyFacts(prior.facts) : emptyFacts({ ...COMPLETE_INTEGRITY });
    const { offset, partial } = foldLines(fd, usable ? prior.offset : 0, end, facts);
    countEventsRead();
    let answer = facts;
    if (reuse) {
      if (usable && offset === prior.offset) answer = prior.facts;
      remember(
        key,
        usable && offset === prior.offset
          ? prior
          : {
              dev,
              ino,
              offset,
              head: bytesAt(fd, 0, Math.min(GUARD_BYTES, offset)),
              tail: bytesAt(fd, Math.max(0, offset - GUARD_BYTES), Math.min(GUARD_BYTES, offset)),
              facts,
              bytes: retainedSize(facts),
            },
      );
    }
    if (partial === null) return answer;
    // Evaluate the unterminated record without consuming it.
    answer = copyFacts(answer);
    const event = parseEventLine(partial.toString("utf8"), answer.integrity);
    if (event) addRunEvent(answer, event, partial.length);
    return answer;
  } catch (err) {
    forget(key);
    const absent = (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
    return emptyFacts({ ...COMPLETE_INTEGRITY, ...(absent ? { absent } : { unreadable: true }) });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Fold every newline-terminated line in [from, end). Returns the offset after
 * the last newline and the unterminated remainder, if any. */
function foldLines(
  fd: number,
  from: number,
  end: number,
  facts: RunEventFacts,
): { offset: number; partial: Buffer | null } {
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let pending: Buffer[] = [];
  let offset = from;
  for (let at = from; at < end;) {
    const read = readSync(fd, buf, 0, Math.min(CHUNK_BYTES, end - at), at);
    if (read === 0) throw new Error("Run events changed while reading");
    const chunk = buf.subarray(0, read);
    let start = 0;
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, newline);
      const line = pending.length ? Buffer.concat([...pending, piece]) : piece;
      pending = [];
      const event = parseEventLine(line.toString("utf8"), facts.integrity);
      if (event) addRunEvent(facts, event, line.length + 1);
      start = newline + 1;
      offset = at + start;
    }
    // The buffer is reused for the next chunk: keep a copy of the remainder.
    if (start < read) pending.push(Buffer.from(chunk.subarray(start)));
    at += read;
  }
  return { offset, partial: pending.length ? Buffer.concat(pending) : null };
}

function sameBytes(fd: number, expected: Buffer, at: number): boolean {
  return expected.length === 0 || bytesAt(fd, at, expected.length).equals(expected);
}

function bytesAt(fd: number, at: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  return out.subarray(0, length ? readSync(fd, out, 0, length, at) : 0);
}

/** Source bytes of the kept rows, plus the plan, continuity and execution values. */
function retainedSize({ timeline, plans, continuity, execution }: RunEventFacts): number {
  let bytes = timeline.bytes + 2 * GUARD_BYTES;
  for (const value of [plans.last, ...plans.byAttempt.values(), ...continuity])
    bytes += value ? JSON.stringify(value).length : 0;
  const { starts, receipts, attempts } = execution;
  return bytes + JSON.stringify([starts, receipts, attempts]).length;
}

function remember(key: string, entry: Retained): void {
  forget(key);
  if (entry.bytes > RETAINED_RUN_BYTES) return;
  retained.set(key, entry);
  retainedBytes += entry.bytes;
  for (const oldest of retained.keys()) {
    if (retained.size <= RETAINED_RUNS && retainedBytes <= RETAINED_BYTES) break;
    forget(oldest);
  }
}

function forget(key: string): void {
  const entry = retained.get(key);
  if (!entry) return;
  retained.delete(key);
  retainedBytes -= entry.bytes;
}
