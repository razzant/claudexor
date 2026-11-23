/**
 * run-deadline/1: a Delegate child that ended keeps the deadline it ended under
 * (its parent's then, if that came first), whatever its parent does later.
 * Every reader of the ended child sees that frozen deadline at once — its
 * answers and a continuation's admission — even while the record write of its
 * terminal is pending or failed; and the parent's extension commits only once
 * that frozen deadline is durable, so neither the warden nor a restart's
 * reconciliation can read a raised one.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  fileRecordIo,
  priorPath,
  readRecord,
  type DeadlineRecord,
  type RecordIo,
} from "./run-deadline-record.js";
import { SchedulerDeadlines } from "./run-deadline-scheduler.js";
import {
  HEAD_MS,
  frozenClock,
  generation,
  hold,
  outcome,
  removeTemps,
  temp,
  wardenBound,
  withFakeTimers,
  type Clock,
} from "./test-support/run-deadline-faults.js";

afterAll(removeTemps, 0);

/** The scheduler's registry over `dir`; its job ids are their own run ids. */
function scheduler(dir: string, time: Clock, io: RecordIo) {
  const commands = {
    queries: {
      observationRecords: (ids: readonly string[]) =>
        ids.map((jobId) => ({ jobId, runId: jobId, state: "running" })),
    },
  };
  return new SchedulerDeadlines(
    {
      dir,
      clock: time.clock,
      io,
      headStartMs: HEAD_MS,
      spawnWarden: async () => ({ pid: 1 }),
      platform: "linux",
      onFault: () => {},
    },
    { commands: commands as never },
    { cancel: () => {}, abort: () => {}, resume: () => {} },
  );
}

/** Turn the event loop (real file operations are in flight) until `done`, or for `turns` turns. */
async function settle(done: () => boolean, turns = Infinity) {
  const end = Date.now() + 20_000;
  for (let i = 0; i < turns && !done() && Date.now() < end; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("run-deadline/1: an ended Delegate child keeps the deadline it ended under", () => {
  it("a continuation's admission reads it at once, and the parent's extension waits until it is durable", async () => {
    await withFakeTimers(async () => {
      const dir = temp();
      const time = frozenClock();
      let gate: Promise<void> | null = null;
      let open!: () => void;
      let parentRenamed = false;
      let flushedAfter = false;
      const io: RecordIo = {
        ...fileRecordIo,
        // The child's record writes wait: its terminal record is pending.
        stage: async (path, record) => {
          if (gate && path.endsWith("b-child.json")) await gate;
          return fileRecordIo.stage(path, record);
        },
        publish: async (tmp, path) => {
          await fileRecordIo.publish(tmp, path);
          if (path.endsWith("a-parent.json")) parentRenamed = true;
        },
        flush: async (dir) => {
          await fileRecordIo.flush(dir);
          if (parentRenamed) flushedAfter = true;
        },
      };
      const deadlines = scheduler(dir, time, io);
      await hold(deadlines, "a-parent", time.iso(40_000));
      await hold(deadlines, "b-child", null, "a-parent");
      gate = new Promise<void>((resolve) => (open = resolve));
      deadlines.close("b-child"); // ended under the parent's 40 s
      const admitted = async (jobId: string) => {
        await deadlines.prepare(jobId, { label: "next", continueFrom: "b-child" });
        deadlines.reserve(jobId, { label: "next", continueFrom: "b-child" });
        return deadlines.stagedRecord(jobId)!;
      };
      expect(deadlines.recordOf("b-child")).toMatchObject({ state: "closed" });
      expect((await admitted("c-next-1")).own!.at).toBe(time.iso(40_000));

      let settled = false;
      parentRenamed = flushedAfter = false;
      const extension = deadlines
        .set("a-parent", { at: time.iso(100_000), expectedRevision: 0 }, { delegated: false })
        .finally(() => (settled = true));
      // The extension became visible and flushed; its commit would follow at
      // once, but it waits for the child's terminal record.
      const parent = join(dir, "a-parent.json");
      await settle(() => flushedAfter);
      expect((readRecord(parent) as DeadlineRecord).revision, "visible").toBe(1);
      await settle(() => false, 50);
      expect(settled, "the extension waits for the child's frozen deadline").toBe(false);
      expect(existsSync(priorPath(parent)), "not committed").toBe(true);
      expect(deadlines.peek("a-parent")!.at).toBe(time.iso(40_000));
      expect((await admitted("c-next-2")).own!.at).toBe(time.iso(40_000));

      open();
      expect((await extension).at).toBe(time.iso(100_000));
      const child = readRecord(join(dir, "b-child.json")) as DeadlineRecord;
      expect(child).toMatchObject({ state: "closed" });
      expect(child.frozen!.at, "durable before the extension committed").toBe(time.iso(40_000));
      expect(wardenBound(dir, "b-child.json")!.at).toBe(time.iso(40_000));
      expect(deadlines.peek("b-child")!.at).toBe(time.iso(40_000));
      expect((await admitted("c-next-3")).own!.at).toBe(time.iso(40_000));
      await deadlines.dispose();
    });
  });

  it("one whose frozen deadline cannot be written refuses the parent's extension, and a restart freezes the deadline it ended under", async () => {
    await withFakeTimers(async () => {
      const dir = temp();
      const time = frozenClock();
      let failChild = false;
      const io: RecordIo = {
        ...fileRecordIo,
        stage: async (path, record) => {
          if (failChild && path.endsWith("b-child.json"))
            throw Object.assign(new Error("injected child write failure"), { code: "EIO" });
          return fileRecordIo.stage(path, record);
        },
      };
      const deadlines = scheduler(dir, time, io);
      await hold(deadlines, "a-parent", time.iso(40_000));
      await hold(deadlines, "b-child", null, "a-parent");
      failChild = true;
      deadlines.close("b-child");
      const answer = await outcome(
        deadlines.set(
          "a-parent",
          { at: time.iso(100_000), expectedRevision: 0 },
          { delegated: false },
        ),
      );
      expect(answer).toEqual({ ok: false, code: "run_deadline_record_unavailable" });
      expect(deadlines.peek("a-parent")!.at).toBe(time.iso(40_000));
      expect(wardenBound(dir, "a-parent.json")!.at).toBe(time.iso(40_000));
      expect(deadlines.recordOf("b-child")).toMatchObject({ state: "closed" });
      expect(deadlines.recordOf("b-child")!.frozen!.at).toBe(time.iso(40_000));
      expect(wardenBound(dir, "b-child.json")!.at).toBe(time.iso(40_000));
      await deadlines.dispose();
      // The daemon restarts with the child's record still armed on disk.
      expect((readRecord(join(dir, "b-child.json")) as DeadlineRecord).state).toBe("armed");
      const next = await generation(dir, time, {
        "a-parent": "interrupted",
        "b-child": "succeeded",
      });
      const child = readRecord(join(dir, "b-child.json")) as DeadlineRecord;
      expect(child.state).toBe("closed");
      expect(child.frozen!.at).toBe(time.iso(40_000));
      expect(next.durableSnapshot("b-child")!.at).toBe(time.iso(40_000));
      await next.dispose();
    });
  });
});
