/**
 * run-deadline/1 and the daemon's queue: a queued job whose deadline won is
 * held in place (it never starts, it keeps its slot and its thread) until its
 * deadline transition settles. Its durable cancel is retried while it cannot
 * be written; a hold that ends — the cancel landed, or a Stop took the job —
 * offers the queue again at once; and an admission answer counts held jobs as
 * about to run, as the scheduler does.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { JobRecord } from "./job-record.js";
import { fileRecordIo, type RecordIo } from "./run-deadline-record.js";
import { legacyDaemon, until } from "./test-support/run-deadline-daemon.js";
import { frozenClock, outcome, removeTemps } from "./test-support/run-deadline-faults.js";

afterAll(removeTemps, 0);

function slotRunner() {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const ran: string[] = [];
  return {
    ran,
    release: () => release(),
    runner: async (params: unknown) => {
      const name = (params as { label: string }).label;
      ran.push(name);
      if (name === "blocker") await blocked;
      return { lifecycle: "succeeded" };
    },
  };
}

describe("run-deadline/1: a queued job its deadline holds", () => {
  it("whose cancel cannot be written stays held and never starts; the cancel is retried, then the queue moves on", async () => {
    const time = frozenClock();
    const slot = slotRunner();
    const d = await legacyDaemon(time, fileRecordIo, slot.runner);
    const update = d.store.update.bind(d.store);
    let failures = 3;
    d.store.update = (id: string, patch: Partial<JobRecord>) => {
      if (patch.errorCode === "run_deadline_expired" && failures > 0) {
        failures -= 1;
        throw Object.assign(new Error("injected cancel write failure"), { code: "EIO" });
      }
      return update(id, patch);
    };
    try {
      const blocker = await d.client.enqueue(
        { label: "blocker" },
        { idempotencyKey: "b", clientId: "t" },
      );
      await until(
        () => Promise.resolve(slot.ran),
        (ran) => ran.includes("blocker"),
      );
      const job = await d.client.enqueue(
        { label: "job", deadline: { at: time.iso(10_000) } },
        { idempotencyKey: "j", clientId: "t" },
      );
      await d.client.enqueue({ label: "behind" }, { idempotencyKey: "n", clientId: "t" });
      time.advance(11_000); // its deadline passes while it is queued
      const record = await until(
        () => d.client.status(job.id),
        (r) => r.state !== "queued",
        1_000,
      );
      expect(record).toMatchObject({ state: "cancelled", errorCode: "run_deadline_expired" });
      expect(failures, "every failed cancel was retried until it landed").toBe(0);
      slot.release();
      await until(
        () => d.client.status(blocker.id),
        (r) => r.state === "succeeded",
      );
      await until(
        () => Promise.resolve(slot.ran),
        (ran) => ran.includes("behind"),
        1_000,
      );
      expect(slot.ran, "the held job never started").toEqual(["blocker", "behind"]);
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("frees its place at once when a Stop takes it, and admission counts it as about to run meanwhile", async () => {
    const time = frozenClock();
    const slot = slotRunner();
    let releaseFlush: (() => void) | null = null;
    let flushes: number | null = null;
    const io: RecordIo = {
      ...fileRecordIo,
      // The renewal's flush after its rename waits: the job is held meanwhile.
      flush: async (dir) => {
        if (flushes !== null && (flushes += 1) === 2)
          await new Promise<void>((resolve) => (releaseFlush = resolve));
        await fileRecordIo.flush(dir);
      },
    };
    const d = await legacyDaemon(time, io, slot.runner);
    try {
      const blocker = await d.client.enqueue(
        { label: "blocker" },
        { idempotencyKey: "b", clientId: "t" },
      );
      await until(
        () => Promise.resolve(slot.ran),
        (ran) => ran.includes("blocker"),
      );
      const job = await d.client.enqueue(
        { label: "job", deadline: { at: time.iso(10_000) } },
        { idempotencyKey: "j", clientId: "t" },
      );
      const behind = await d.client.enqueue(
        { label: "behind" },
        { idempotencyKey: "n", clientId: "t" },
      );
      flushes = 0;
      const renewal = outcome(
        d.client.runDeadline(job.id, { action: "set", at: time.iso(60_000), expectedRevision: 0 }),
      );
      await until(
        () => Promise.resolve(releaseFlush),
        (r) => typeof r === "function",
      );
      flushes = null;
      time.advance(10_500); // past its deadline, inside the head start: held while the renewal is pending
      slot.release();
      await until(
        () => d.client.status(blocker.id),
        (r) => r.state === "succeeded",
      );
      // Nothing runs, and the job behind is told why: the held job takes the one slot.
      const admission = await until(
        () => Promise.resolve(d.server.admission(behind.id)),
        (a) => a !== null && a.blockers.length > 0,
      );
      expect(admission).toMatchObject({ phase: "queued" });
      expect(admission!.blockers).toContainEqual({ kind: "global_limit", limit: 1 });
      expect(
        d.server.admission(job.id)?.blockers,
        "the held job itself is not its own blocker",
      ).toEqual([]);
      expect(slot.ran).toEqual(["blocker"]);
      // A Stop takes the held job: the job behind starts while the renewal is still pending.
      await d.client.cancel(job.id);
      await until(
        () => Promise.resolve(slot.ran),
        (ran) => ran.includes("behind"),
      );
      expect(slot.ran).toEqual(["blocker", "behind"]);
      releaseFlush!();
      // The Stop came after the replaced deadline: that terminal is the expiry.
      expect(await renewal).toEqual({ ok: false, code: "run_deadline_expired" });
      expect(await d.client.status(job.id)).toMatchObject({ state: "cancelled" });
      expect(await d.client.runDeadline(job.id, { action: "read" })).toMatchObject({
        state: "expired",
        revision: 0,
      });
    } finally {
      slot.release();
      (releaseFlush as (() => void) | null)?.();
      await d.close();
    }
  });
});
