import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResumable } from "@claudexor/schema";
import {
  carryingAttempts,
  resumableOf,
  type ContinuityTerminalFacts,
} from "./continuity-terminal.js";

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const block = (sid: string, acted: boolean): RunResumable => ({
  cause: "other",
  resetsAt: null,
  limitWindow: null,
  limitEvidence: null,
  carriers: acted ? ["native", "packet"] : ["native"],
  limitCode: null,
  session: { harness: "fake", nativeSessionId: sid, holderProfileId: null },
  workspace: { kind: "none", root: null },
});

type Item = ContinuityTerminalFacts & { attemptId: string; status?: string };

/** A run log whose harness rows record, per attempt, the given event types. */
function runLog(activity: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "cx-terminal-"));
  roots.push(dir);
  let seq = 0;
  const rows = Object.entries(activity).flatMap(([attempt, types]) =>
    types.map((type) =>
      JSON.stringify({
        seq: ++seq,
        ts: "2026-10-29T00:00:00.000Z",
        run_id: "r",
        task_id: "t",
        type: "harness.event",
        payload: {
          attempt_id: attempt,
          session_id: `s-${attempt}`,
          type,
          ...(type === "message" ? { text: "narration of a dying try" } : {}),
        },
      }),
    ),
  );
  writeFileSync(join(dir, "events.jsonl"), rows.join("\n") + "\n");
  return dir;
}

describe("the carrying attempt of a serial Ask chain", () => {
  it("is the newest started attempt whose own recorded activity progressed; idle or unstarted fallbacks never evict it", () => {
    const dir = runLog({
      a01: ["started", "tool_call"],
      "a01-fb": ["started", "message"],
      a02: [],
    });
    const worked: Item = { attemptId: "a01", started: true, resumable: block("sid-1", true) };
    // A continued run's later attempt inherits the chain's `acted`: its block offers
    // `packet` although the attempt itself recorded nothing but narration.
    const idle: Item = { attemptId: "a01-fb", started: true, resumable: block("sid-2", true) };
    const unstarted: Item = { attemptId: "a02", started: false, resumable: block("sid-3", true) };
    expect(carryingAttempts([worked, idle, unstarted], dir)).toEqual([worked]);
    const later = runLog({ a01: ["started", "tool_call"], "a01-fb": ["started", "tool_result"] });
    expect(resumableOf(carryingAttempts([worked, idle], later))?.session?.nativeSessionId).toBe(
      "sid-2",
    );
  });

  it("lets a completed winner speak alone, whatever it recorded, so no failed attempt's block survives it", () => {
    const dir = runLog({ a01: ["started", "tool_call"], "a01-fb": ["started"] });
    const failed: Item = { attemptId: "a01", started: true, resumable: block("sid-1", true) };
    const winner: Item = {
      attemptId: "a01-fb",
      status: "success",
      started: true,
      resumableOnFailure: block("sid-2", true),
    };
    expect(carryingAttempts([failed, winner], dir)).toEqual([winner]);
    expect(resumableOf(carryingAttempts([failed, winner], dir))).toBeNull();
    // Concurrent candidates keep the first-declared rule.
    expect(resumableOf([failed, winner])?.session?.nativeSessionId).toBe("sid-1");
  });

  it("falls back to every attempt when none started", () => {
    const items: Item[] = [
      { attemptId: "a01", resumable: block("sid-1", true) },
      { attemptId: "a02" },
    ];
    expect(carryingAttempts(items, runLog({}))).toEqual(items);
  });
});
