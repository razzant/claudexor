/**
 * Hot run-detail polls of a successor without work of its own name the
 * ancestor it inherits without rereading that ancestor's whole event log:
 * when the ancestor's terminal records decide its source, its log is not read
 * at all; otherwise its execution facts come from the bounded event fold run
 * detail keeps between reads, so a repeated poll reads only the fold's guard
 * bytes. Cached list summaries read no log either way.
 *
 * Astra r3 review repro (`.review-evidence/astra-r3/projection-review/
 * hot-ancestor-repro.mjs`, sha256 3d937edc…): the same actual bulk-worker
 * detail and summary jobs and the same byte counting of `events.jsonl`; the
 * no-terminal-record case is this repair's own.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeContinuationSources } from "@claudexor/workspace";
import { projectBulkJob } from "./bulk-worker.js";

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)

/** Bytes read from one events.jsonl through node:fs, whole-file or by descriptor,
 * under either spelling of its path (a reader may canonicalize it). */
function countReads(path: string) {
  const reads = { bytes: 0 };
  const fds = new Set<number>();
  const spellings = new Set([path, fs.realpathSync(path)]);
  const { readFileSync, openSync, readSync, closeSync } = fs;
  fs.readFileSync = function (this: unknown, file: unknown, ...rest: unknown[]) {
    const result = (readFileSync as (...args: unknown[]) => string | Buffer).call(
      this,
      file,
      ...rest,
    );
    if (spellings.has(String(file))) reads.bytes += Buffer.byteLength(result);
    return result;
  } as typeof fs.readFileSync;
  fs.openSync = function (this: unknown, file: unknown, ...rest: unknown[]) {
    const fd = (openSync as (...args: unknown[]) => number).call(this, file, ...rest);
    if (spellings.has(String(file))) fds.add(fd);
    return fd;
  } as typeof fs.openSync;
  fs.readSync = function (this: unknown, fd: number, ...rest: unknown[]) {
    const read = (readSync as (...args: unknown[]) => number).call(this, fd, ...rest);
    if (fds.has(fd)) reads.bytes += read;
    return read;
  } as typeof fs.readSync;
  fs.closeSync = function (this: unknown, fd: number) {
    fds.delete(fd);
    return closeSync.call(this, fd);
  } as typeof fs.closeSync;
  syncBuiltinESMExports();
  return {
    reads,
    restore() {
      Object.assign(fs, { readFileSync, openSync, readSync, closeSync });
      syncBuiltinESMExports();
    },
  };
}

const event = (run: string, seq: number, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({
    seq,
    ts: "2026-10-29T02:00:00.000Z",
    run_id: run,
    task_id: `task-${run}`,
    type,
    payload,
  }) + "\n";

/** A holds sid-A and a long history; B continues it, records nothing and is interrupted. */
function chain(withTerminalRecord: boolean) {
  const root = fs.mkdtempSync(join(tmpdir(), "cx-hot-ancestor-"));
  roots.push(root);
  const a = join(root, "A");
  const b = join(root, "B");
  fs.mkdirSync(join(a, "attempts", "a01"), { recursive: true });
  fs.mkdirSync(join(a, "final"), { recursive: true });
  fs.mkdirSync(join(b, "final"), { recursive: true });
  fs.writeFileSync(
    join(a, "attempts/a01/session-capsule.json"),
    JSON.stringify({
      harness: "claude",
      nativeSessionId: "sid-A",
      holderProfileId: null,
      file: null,
      mtimeMs: null,
      sidecars: [],
      cwd: root,
      requestedModel: null,
    }),
  );
  if (withTerminalRecord)
    fs.writeFileSync(
      join(a, "final/resumable.yaml"),
      JSON.stringify({
        cause: "other",
        resetsAt: null,
        limitWindow: null,
        limitEvidence: null,
        carriers: ["native", "packet"],
        limitCode: null,
        session: { harness: "claude", nativeSessionId: "sid-A", holderProfileId: null },
        workspace: { kind: "none", root: null },
      }),
    );
  const process = { harness_id: "claude", attempt_id: "a01", session_id: "process-A" };
  fs.writeFileSync(
    join(a, "events.jsonl"),
    event("A", 1, "harness.event", {
      ...process,
      type: "started",
      payload: { native_session_id: "sid-A" },
    }) +
      Array.from({ length: 3000 }, (_, i) =>
        event("A", i + 2, "harness.event", {
          ...process,
          type: "message",
          text: `observed fact ${i} ${"x".repeat(80)}`,
        }),
      ).join(""),
  );
  fs.writeFileSync(join(b, "events.jsonl"), event("B", 1, "run.created", { prompt: "Continue" }));
  writeContinuationSources(b, [
    { runId: "A", runDir: a, state: withTerminalRecord ? "failed" : "interrupted" },
  ]);
  const record = {
    id: "B",
    runId: "B",
    runDir: b,
    state: "interrupted",
    params: { mode: "ask", continueFrom: "A" },
  };
  return { ancestorLog: join(a, "events.jsonl"), record };
}

async function detailPolls(record: Record<string, unknown>, log: string, polls: number) {
  const job = {
    kind: "detail",
    input: { record, cursor: 1, pending: [], operator: null, children: [] },
  } as unknown as Parameters<typeof projectBulkJob>[0];
  const results: { bytes: number; session: string | undefined }[] = [];
  for (let i = 0; i < polls; i++) {
    const counter = countReads(log);
    try {
      const detail = JSON.parse((await projectBulkJob(job, async () => null)) as string) as {
        summary: { resumable?: { session?: { nativeSessionId?: string } | null } | null };
      };
      results.push({
        bytes: counter.reads.bytes,
        session: detail.summary.resumable?.session?.nativeSessionId,
      });
    } finally {
      counter.restore();
    }
  }
  return results;
}

async function listPolls(record: Record<string, unknown>, log: string) {
  const job = (input: Record<string, unknown>) =>
    ({ kind: "summary", input }) as unknown as Parameters<typeof projectBulkJob>[0];
  const cold = await projectBulkJob(job({ record }), async () => null);
  const counter = countReads(log);
  try {
    await projectBulkJob(job({ record, cached: cold }), async () => null);
    return counter.reads.bytes;
  } finally {
    counter.restore();
  }
}

describe("hot detail polls of a successor without own work and its inherited ancestor", () => {
  it("read nothing of the ancestor's log when its terminal record decides its source", async () => {
    const { ancestorLog, record } = chain(true);
    const polls = await detailPolls(record, ancestorLog, 3);
    expect(polls.map((poll) => poll.session)).toEqual(["sid-A", "sid-A", "sid-A"]);
    expect(polls.map((poll) => poll.bytes)).toEqual([0, 0, 0]);
    expect(await listPolls(record, ancestorLog)).toBe(0);
  });

  it("fold the ancestor's log once when its facts decide, then reuse that bounded fold", async () => {
    const { ancestorLog, record } = chain(false);
    const size = fs.statSync(ancestorLog).size;
    const polls = await detailPolls(record, ancestorLog, 3);
    expect(polls.map((poll) => poll.session)).toEqual(["sid-A", "sid-A", "sid-A"]);
    // The first poll folds the whole log once (plus the fold's guard bytes).
    expect(polls[0]!.bytes).toBeGreaterThanOrEqual(size);
    // Unchanged polls re-check only the fold's guard bytes, never the history.
    for (const poll of polls.slice(1)) expect(poll.bytes).toBeLessThan(size / 10);
    expect(await listPolls(record, ancestorLog)).toBe(0);
  });
});
