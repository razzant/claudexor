import { createHash } from "node:crypto";
import type { RunEvent } from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import {
  JOURNALED_RUN_EVENT_TYPES,
  POST_TERMINAL_AUDIT_EVENT_TYPES,
  isJournaledRunEvent,
  journaledRunEventCopy,
} from "./journaled-run-events.js";

function event(type: RunEvent["type"], payload: Record<string, unknown> = {}): RunEvent {
  return {
    seq: 1,
    ts: "2026-09-14T00:00:00.000Z",
    run_id: "run-1",
    task_id: "task-1",
    type,
    payload,
  };
}

describe("journaled run events (owner decision D1: no per-token deltas in the journal)", () => {
  it("keeps exactly the lifecycle-significant types", () => {
    expect([...JOURNALED_RUN_EVENT_TYPES].sort()).toEqual(
      [
        "run.created",
        "interaction.requested",
        "interaction.answered",
        "interaction.timeout",
        "interaction.withdrawn",
        "message.accepted",
        "message.delivered",
        "message.refused",
        "output.ready",
        "run.completed",
        "run.failed",
        "run.blocked",
      ].sort(),
    );
    for (const type of ["harness.event", "harness.started", "budget.cash", "gate.completed"]) {
      expect(isJournaledRunEvent(event(type as RunEvent["type"]))).toBe(false);
    }
    for (const type of JOURNALED_RUN_EVENT_TYPES)
      expect(isJournaledRunEvent(event(type))).toBe(true);
  });

  it("replaces the run.created prompt with its sha256 and byte length", () => {
    const prompt = "Refactor the retention module — keep every test green.";
    const copy = journaledRunEventCopy(event("run.created", { mode: "agent", prompt }));
    expect(copy.payload).toEqual({
      mode: "agent",
      prompt_sha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
      prompt_bytes: Buffer.byteLength(prompt, "utf8"),
    });
    expect(copy.payload).not.toHaveProperty("prompt");
    expect(copy).toMatchObject({ seq: 1, run_id: "run-1", task_id: "task-1", type: "run.created" });
  });

  it("drops the live-message text from the journal copy and keeps the digest fields", () => {
    const text = "Use MANGO, not the plan's fruit.";
    for (const type of ["message.accepted", "message.delivered", "message.refused"] as const) {
      const copy = journaledRunEventCopy(
        event(type, {
          message_id: "msg-1",
          attempt_id: "a01",
          outcome: "delivered",
          text_sha256: createHash("sha256").update(text, "utf8").digest("hex"),
          text_bytes: Buffer.byteLength(text, "utf8"),
          text,
          title: "Live message delivered (32 bytes)",
        }),
      );
      expect(copy.payload).not.toHaveProperty("text");
      expect(copy.payload).toMatchObject({
        message_id: "msg-1",
        attempt_id: "a01",
        outcome: "delivered",
        text_bytes: Buffer.byteLength(text, "utf8"),
      });
      expect(copy).toMatchObject({ seq: 1, run_id: "run-1", type });
    }
    // A text-less receipt is stored as emitted (identity, not a rebuilt copy).
    const bare = event("message.refused", { message_id: "msg-2", outcome: "not_active" });
    expect(journaledRunEventCopy(bare)).toBe(bare);
  });

  it("allows exactly the cancel audit and the live-message receipts after a run's terminal", () => {
    expect([...POST_TERMINAL_AUDIT_EVENT_TYPES].sort()).toEqual(
      [
        "control.requested",
        "control.applied",
        "control.rejected",
        "message.accepted",
        "message.delivered",
        "message.refused",
      ].sort(),
    );
    for (const type of ["harness.event", "interaction.requested", "run.completed"]) {
      expect(POST_TERMINAL_AUDIT_EVENT_TYPES.has(type)).toBe(false);
    }
  });

  it("leaves a prompt-less or non-string-prompt run.created and every other type untouched", () => {
    const bare = event("run.created", { mode: "ask" });
    expect(journaledRunEventCopy(bare)).toBe(bare);
    const odd = event("run.created", { mode: "ask", prompt: 42 });
    expect(journaledRunEventCopy(odd)).toBe(odd);
    const terminal = event("run.completed", {
      lifecycle: "succeeded",
      prompt: "not a run.created",
    });
    expect(journaledRunEventCopy(terminal)).toBe(terminal);
  });
});
