/**
 * The run-deadline/1 snapshot on start receipts, pre-start refusals and
 * lookups (`receiptDeadline`): every job that can hold a deadline record is
 * read, an inherited deadline included; a job that cannot is never asked.
 */
import { describe, expect, it } from "vitest";
import { deadlineReplayRefusal, receiptDeadline } from "./run-start-receipt.js";
import type { DaemonRunRecord } from "./run-record.js";

const snapshot = {
  at: "2026-11-22T12:00:00.000Z",
  revision: 0,
  serverNow: "2026-11-22T11:00:00.000Z",
  state: "armed",
  stopGraceSec: 15,
  inheritedFrom: null,
  successorOf: "job-first",
  enforcement: null,
} as const;

function daemon(found: boolean | "unreadable") {
  const asked: string[] = [];
  const actions: string[] = [];
  return {
    asked,
    actions,
    client: {
      runDeadline: async (id: string, request: { action: string }) => {
        asked.push(id);
        actions.push(request.action);
        if (found === "unreadable")
          throw Object.assign(new Error("record unreadable"), {
            code: "run_deadline_record_unavailable",
            status: 503,
          });
        if (!found) throw Object.assign(new Error("absent"), { code: "run_deadline_absent" });
        return snapshot;
      },
    },
  };
}

const record = (fields: Partial<DaemonRunRecord>) =>
  ({ id: "job-x", state: "queued", params: {}, ...fields }) as DaemonRunRecord;

describe("receiptDeadline", () => {
  it.each([
    ["its own deadline", { params: { deadline: { at: snapshot.at } } }],
    ["a continuation that inherits one", { params: { continueFrom: "run-first" } }],
    ["a Delegate child capped by its parent", { params: { delegatedFromRunId: "run-parent" } }],
    ["a job its deadline ended", { errorCode: "run_deadline_expired", params: {} }],
  ])("reads the durable deadline of %s", async (_label, fields) => {
    const d = daemon(true);
    expect(await receiptDeadline(d.client as never, record(fields))).toEqual({
      deadline: snapshot,
    });
    expect(d.asked).toEqual(["job-x"]);
  });

  it("leaves the field out for a continuation that holds no record", async () => {
    const d = daemon(false);
    expect(
      await receiptDeadline(d.client as never, record({ params: { continueFrom: "run-first" } })),
    ).toEqual({});
  });

  it("never asks for a job that cannot hold a deadline", async () => {
    const d = daemon(true);
    expect(await receiptDeadline(d.client as never, record({ params: { prompt: "x" } }))).toEqual(
      {},
    );
    expect(d.asked).toEqual([]);
  });

  it("a replay of a run that held a deadline is refused with the start that carries a new one", async () => {
    const held = daemon(true);
    expect(
      await deadlineReplayRefusal(
        held.client as never,
        record({ params: { continueFrom: "run-first" } }),
        "Exact Retry",
      ),
    ).toMatchObject({ code: "run_deadline_replay_refused", retryable: false });
    const none = daemon(false);
    expect(
      await deadlineReplayRefusal(
        none.client as never,
        record({ params: { continueFrom: "run-first" } }),
        "Exact Retry",
      ),
    ).toBe(null);
  });

  it("reads with the read-only projection: no transition, no stop", async () => {
    const d = daemon(true);
    await receiptDeadline(d.client as never, record({ params: { deadline: { at: snapshot.at } } }));
    expect(d.actions).toEqual(["peek"]);
  });

  it.each([
    ["its request set a deadline", { params: { deadline: { at: snapshot.at } } }],
    ["its deadline ended it", { errorCode: "run_deadline_expired", params: {} }],
  ])("fails closed: a replay is refused when %s, even with no record left", async (_l, fields) => {
    for (const client of [daemon(false).client, undefined])
      expect(
        await deadlineReplayRefusal(client as never, record(fields), "Exact Retry"),
      ).toMatchObject({ code: "run_deadline_replay_refused", retryable: false });
  });

  it("an unreadable record is a storage failure, never an absent deadline", async () => {
    const d = daemon("unreadable");
    await expect(
      deadlineReplayRefusal(
        d.client as never,
        record({ params: { continueFrom: "run-first" } }),
        "Exact Retry",
      ),
    ).rejects.toMatchObject({ code: "run_deadline_record_unavailable" });
    await expect(
      receiptDeadline(d.client as never, record({ params: { deadline: { at: snapshot.at } } })),
    ).rejects.toMatchObject({ code: "run_deadline_record_unavailable" });
  });

  it("a thread turn's refusal names the thread turn start with a new key", async () => {
    const refusal = await deadlineReplayRefusal(
      daemon(true).client as never,
      record({ params: { deadline: { at: snapshot.at } } }),
      "A turn retry",
      { threadId: "thr-1" },
    );
    expect(refusal!.requiredActions[0]).toContain("POST /v2/threads/thr-1/turns");
    expect(refusal!.requiredActions[0]).toContain("new idempotency key");
  });
});
