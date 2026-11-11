import { describe, expect, it } from "vitest";
import {
  RunObservationRecord,
  RunWaitManyInput,
  RunWaitManyResult,
  RunWaitManySummary,
} from "./run-observation.js";

const TOKEN = "A".repeat(43);
const observed = { status: "interrupted", pending: false, token: TOKEN, problem: null };
const unavailable = { status: null, pending: null, token: null, problem: "snapshot_unavailable" };

describe("RunObservationRecord", () => {
  const record = {
    jobId: "job-a",
    runId: null,
    partition: "global",
    epoch: "a".repeat(32),
    state: "queued",
    createdAt: "2026-10-22T00:00:00.000Z",
  };

  it("keeps the actual run binding nullable and exposes only scalar identity facts", () => {
    expect(RunObservationRecord.parse(record)).toEqual(record);
    const bound = { ...record, runId: "run-a", state: "running" };
    expect(RunObservationRecord.parse(bound)).toEqual(bound);
  });

  it.each([
    { ...record, state: "waiting_on_user" },
    { ...record, state: "unknown" },
    { ...record, state: null },
    { ...record, runId: 1 },
    { ...record, params: { prompt: "body" } },
    { ...record, result: { text: "body" } },
  ])("rejects malformed scalar records and body fields: %j", (value) => {
    expect(RunObservationRecord.safeParse(value).success).toBe(false);
  });
});

describe("RunWaitManyInput", () => {
  it("trims handles, defaults only waitMs, and retains duplicate/alias positions", () => {
    expect(
      RunWaitManyInput.parse({
        targets: [{ runId: " job-a " }, { runId: "run-a", seen: TOKEN }, { runId: "job-a" }],
      }),
    ).toEqual({
      targets: [{ runId: "job-a" }, { runId: "run-a", seen: TOKEN }, { runId: "job-a" }],
      waitMs: 25_000,
    });
  });

  it("accepts both numeric wait boundaries and exactly 1000 targets", () => {
    const targets = Array.from({ length: 1000 }, () => ({ runId: "x".repeat(256) }));
    for (const waitMs of [0, 50_000]) {
      expect(RunWaitManyInput.parse({ targets, waitMs })).toEqual({ targets, waitMs });
    }
  });

  it.each([
    {},
    { targets: [] },
    { targets: Array.from({ length: 1001 }, () => ({ runId: "a" })) },
    { targets: [{ runId: "" }] },
    { targets: [{ runId: " \t\n " }] },
    { targets: [{ runId: "x".repeat(257) }] },
    { targets: [{ runId: 12 }] },
    { targets: [{ runId: "a", extra: true }] },
    { targets: [{ runId: "a" }], afterSeq: 1 },
    { targets: [{ runId: "a" }], waitMs: -1 },
    { targets: [{ runId: "a" }], waitMs: 50_001 },
    { targets: [{ runId: "a" }], waitMs: 1.5 },
    { targets: [{ runId: "a" }], waitMs: "0" },
    { targets: [{ runId: "a" }], waitMs: null },
    { targets: [{ runId: "a" }], waitMs: Infinity },
    { targets: [{ runId: "a" }], waitMs: NaN },
  ])("rejects invalid counts, IDs, waits and unknown fields: %j", (input) => {
    expect(RunWaitManyInput.safeParse(input).success).toBe(false);
  });

  it.each([
    "",
    "A".repeat(42),
    "A".repeat(44),
    `${"A".repeat(42)}=`,
    `${"A".repeat(42)}+`,
    `${"A".repeat(42)}/`,
    `${"A".repeat(42)}é`,
    `${"A".repeat(42)}\n`,
    43,
  ])("rejects malformed seen tokens: %j", (seen) => {
    expect(RunWaitManyInput.safeParse({ targets: [{ runId: "a", seen }] }).success).toBe(false);
  });

  it("accepts a null seen, the echo of a problem row's token", () => {
    expect(RunWaitManyInput.parse({ targets: [{ runId: "a", seen: null }], waitMs: 0 })).toEqual({
      targets: [{ runId: "a", seen: null }],
      waitMs: 0,
    });
  });

  it("keeps includeBlocking an optional boolean that is absent unless the caller sent it", () => {
    const targets = [{ runId: "a" }];
    expect(RunWaitManyInput.parse({ targets, waitMs: 0 })).not.toHaveProperty("includeBlocking");
    for (const includeBlocking of [true, false])
      expect(RunWaitManyInput.parse({ targets, waitMs: 0, includeBlocking })).toEqual({
        targets,
        waitMs: 0,
        includeBlocking,
      });
    for (const includeBlocking of ["true", 1, 0, null, {}])
      expect(RunWaitManyInput.safeParse({ targets, includeBlocking }).success).toBe(false);
  });

  it("accepts every base64url character without padding or trimming tokens", () => {
    const seen = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0_-";
    expect(RunWaitManyInput.parse({ targets: [{ runId: "a", seen }], waitMs: 0 })).toEqual({
      targets: [{ runId: "a", seen }],
      waitMs: 0,
    });
  });

  it("enforces the aggregate compact JSON limit in UTF-8 bytes, including escaping", () => {
    // 1000 individually valid 256-character IDs. Replacing 155910 ASCII
    // characters with JSON-escaped controls adds 779550 bytes; € adds two.
    let controls = 155_910;
    const targets = Array.from({ length: 1000 }, () => {
      const count = Math.min(256, controls);
      controls -= count;
      return { runId: "\u0001".repeat(count) + "x".repeat(256 - count) };
    });
    targets[999]!.runId = "€" + "x".repeat(255);
    const atLimit = { targets, waitMs: 0 };
    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(1_048_576);
    expect(RunWaitManyInput.safeParse(atLimit).success).toBe(true);

    const overLimit = {
      targets: [...targets.slice(0, 999), { runId: "€é" + "x".repeat(254) }],
      waitMs: 0,
    };
    expect(Buffer.byteLength(JSON.stringify(overLimit), "utf8")).toBe(1_048_577);
    expect(RunWaitManyInput.safeParse(overLimit).success).toBe(false);

    // M1: the cap measures caller bytes, not a default inserted after admission.
    const omittedWait = {
      targets: [...targets.slice(0, 999), { runId: "€" + "é".repeat(11) + "x".repeat(244) }],
    };
    expect(Buffer.byteLength(JSON.stringify(omittedWait), "utf8")).toBe(1_048_576);
    const parsed = RunWaitManyInput.parse(omittedWait);
    expect(parsed.targets).toEqual(omittedWait.targets);
    expect(parsed.waitMs).toBe(25_000);
    expect(Buffer.byteLength(JSON.stringify(parsed), "utf8")).toBe(1_048_591);
    expect(omittedWait).not.toHaveProperty("waitMs");

    const omittedWaitOverLimit = {
      targets: [...targets.slice(0, 999), { runId: "€" + "é".repeat(12) + "x".repeat(243) }],
    };
    expect(Buffer.byteLength(JSON.stringify(omittedWaitOverLimit), "utf8")).toBe(1_048_577);
    expect(RunWaitManyInput.safeParse(omittedWaitOverLimit).success).toBe(false);
  });
});

describe("RunWaitManySummary and RunWaitManyResult", () => {
  it("accepts every lifecycle and the three explicit unknown reasons", () => {
    for (const status of ["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]) {
      for (const pending of [true, false]) {
        const row = { status, pending, token: TOKEN, problem: null };
        expect(RunWaitManySummary.parse(row)).toEqual(row);
      }
    }
    for (const problem of ["not_found", "snapshot_unavailable", "not_observed"]) {
      const row = { status: null, pending: null, token: null, problem };
      expect(RunWaitManySummary.parse(row)).toEqual(row);
    }
    for (const wakeReason of ["attention", "problems", "timeout", "aborted"]) {
      const result = { wakeReason, attention: [], summaries: [unavailable] };
      expect(RunWaitManyResult.parse(result)).toEqual(result);
    }
  });

  it.each([
    { ...observed, pending: null },
    { ...observed, token: null },
    { ...observed, status: "waiting_on_user" },
    { ...observed, token: "A".repeat(42) },
    { ...observed, token: `${"A".repeat(42)}=` },
    { ...observed, problem: "not_found" },
    { ...observed, runId: "run-a" },
    { ...unavailable, pending: false },
    { ...unavailable, status: "queued" },
    { ...unavailable, token: TOKEN },
    { ...unavailable, problem: null },
    { ...unavailable, problem: "read failed: arbitrary prose" },
    { ...unavailable, message: "body" },
  ])("rejects mixed known/unknown facts and extra summary fields: %j", (row) => {
    expect(RunWaitManySummary.safeParse(row).success).toBe(false);
    expect(
      RunWaitManyResult.safeParse({
        wakeReason: "timeout",
        attention: [],
        summaries: [row],
      }).success,
    ).toBe(false);
  });

  it.each([
    { wakeReason: "disconnected", attention: [], summaries: [observed] },
    { wakeReason: "timeout", attention: [-1], summaries: [observed] },
    { wakeReason: "timeout", attention: [0.5], summaries: [observed] },
    { wakeReason: "timeout", attention: [1000], summaries: [observed] },
    { wakeReason: "timeout", attention: [], summaries: [observed], events: [] },
    {
      wakeReason: "timeout",
      attention: [],
      summaries: Array.from({ length: 1001 }, () => observed),
    },
  ])("rejects invalid/oversized result boundaries: %j", (result) => {
    expect(RunWaitManyResult.safeParse(result).success).toBe(false);
  });

  it("admits blocking only on a pending row of a wait-many result, never in the compact summary", () => {
    for (const blocking of [true, false]) {
      const row = { status: "running", pending: true, token: TOKEN, problem: null, blocking };
      const result = { wakeReason: "attention", attention: [0], summaries: [row] };
      const parsed = RunWaitManyResult.parse(result);
      expect(parsed).toEqual(result);
      // The additive key keeps the compact order and comes last.
      expect(Object.keys(parsed.summaries[0]!)).toEqual([
        "status",
        "pending",
        "token",
        "problem",
        "blocking",
      ]);
      // Task-group members and every reader without the opt-in keep the old strict row.
      expect(RunWaitManySummary.safeParse(row).success).toBe(false);
    }
    const compact = { status: "running", pending: true, token: TOKEN, problem: null };
    expect(
      Object.keys(
        RunWaitManyResult.parse({ wakeReason: "timeout", attention: [], summaries: [compact] })
          .summaries[0]!,
      ),
    ).toEqual(["status", "pending", "token", "problem"]);
  });

  it.each([
    { ...observed, blocking: false },
    { ...observed, blocking: true },
    { ...unavailable, blocking: true },
    { ...unavailable, blocking: false },
    { ...observed, pending: true, blocking: null },
    { ...observed, pending: true, blocking: "false" },
    { ...observed, pending: true, blocking: 0 },
  ])("rejects blocking without pending questions or as a non-boolean: %j", (row) => {
    expect(
      RunWaitManyResult.safeParse({ wakeReason: "timeout", attention: [], summaries: [row] })
        .success,
    ).toBe(false);
  });

  it("retains the independently reproduced 113944-byte maximum logical response", () => {
    const result = {
      wakeReason: "attention",
      attention: Array.from({ length: 1000 }, (_, i) => i),
      summaries: Array.from({ length: 1000 }, () => ({ ...observed })),
    };
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBe(113_944);
    const parsed = RunWaitManyResult.parse(result);
    expect(parsed).toEqual(result);
    expect(Buffer.byteLength(JSON.stringify(parsed), "utf8")).toBe(113_944);
    expect(Buffer.byteLength(JSON.stringify(parsed), "utf8")).toBeLessThanOrEqual(131_072);
  });

  it("fits the opt-in maximum, 1000 pending async interrupted rows, in 129944 bytes", () => {
    // The longest lifecycle, every index in attention and the longer `false`.
    const result = {
      wakeReason: "attention",
      attention: Array.from({ length: 1000 }, (_, i) => i),
      summaries: Array.from({ length: 1000 }, () => ({
        ...observed,
        pending: true,
        blocking: false,
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBe(129_944);
    const parsed = RunWaitManyResult.parse(result);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(result));
    expect(Buffer.byteLength(JSON.stringify(parsed), "utf8")).toBeLessThanOrEqual(131_072);
  });
});
