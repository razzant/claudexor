/**
 * The run-deadline/1 snapshot on start receipts, pre-start refusals and
 * lookups (`receiptDeadline`): every job that can hold a deadline record is
 * read, an inherited deadline included; a job that cannot is never asked.
 */
import { describe, expect, it } from "vitest";
import { receiptDeadline } from "./run-start-receipt.js";
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

function daemon(found: boolean) {
  const asked: string[] = [];
  return {
    asked,
    client: {
      runDeadline: async (id: string) => {
        asked.push(id);
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
});
