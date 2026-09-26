import { describe, expect, it } from "vitest";
import type { ChildStdin } from "@claudexor/core";
import type { HarnessEvent } from "@claudexor/schema";
import {
  LIVE_INPUT_DELIVERED,
  LIVE_INPUT_REFUSED,
  createClaudeLiveInput,
  type ClaudeLiveInput,
} from "./live-input.js";

function fakeIo(): { io: ChildStdin; written: string[] } {
  const written: string[] = [];
  return {
    written,
    io: { write: (data) => written.push(data), end: () => {}, closed: new Promise(() => {}) },
  };
}

const SESSION = "ses-live";
const MSG = "live-msg-1";

function openSession(deadlineMs = 50): {
  live: ClaudeLiveInput;
  written: string[];
  observe: (obj: unknown) => HarnessEvent[];
} {
  const live = createClaudeLiveInput({ acceptDeadlineMs: deadlineMs });
  const { io, written } = fakeIo();
  live.onIo(io, SESSION);
  return { live, written, observe: (obj) => live.observe(obj, [], SESSION) ?? [] };
}

const lifecycle = (uuid: string, state: string) => ({
  type: "command_lifecycle",
  command_uuid: uuid,
  state,
});
const replay = (uuid: string) => ({
  type: "user",
  isReplay: true,
  uuid,
  message: { role: "user", content: [{ type: "text", text: "hi" }] },
});
const result = (uuids: string[]) => ({
  type: "result",
  subtype: "success",
  user_message_uuids: uuids,
});

describe("claude live input: message()", () => {
  it("answers not_active/no_live_session without a live session and after stdin closed", async () => {
    const live = createClaudeLiveInput({ acceptDeadlineMs: 50 });
    await expect(live.message(SESSION, { messageId: MSG, text: "x" })).resolves.toEqual({
      outcome: "not_active",
      reason: "no_live_session",
    });
    const { io } = fakeIo();
    live.onIo(io, SESSION);
    live.onIo(null, SESSION);
    await expect(live.message(SESSION, { messageId: MSG, text: "x" })).resolves.toEqual({
      outcome: "not_active",
      reason: "no_live_session",
    });
  });

  it("writes the verified user frame (uuid = message id) and settles accepted on the queued lifecycle frame", async () => {
    const { live, written, observe } = openSession();
    const receipt = live.message(SESSION, { messageId: MSG, text: "Also say MANGO." });
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!)).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Also say MANGO." }] },
      parent_tool_use_id: null,
      uuid: MSG,
    });
    // A foreign uuid's queued frame is not ours (two-sided guard).
    expect(observe(lifecycle("someone-else", "queued"))).toEqual([]);
    expect(observe(lifecycle(MSG, "queued"))).toEqual([]);
    await expect(receipt).resolves.toEqual({ outcome: "accepted" });
  });

  it("answers delivery_unknown/response_timeout when no queued frame arrives within the deadline", async () => {
    const { live } = openSession(20);
    await expect(live.message(SESSION, { messageId: MSG, text: "x" })).resolves.toEqual({
      outcome: "delivery_unknown",
      reason: "response_timeout",
    });
  });

  it("answers delivery_unknown/transport_lost when the write throws or the session closes first", async () => {
    const live = createClaudeLiveInput({ acceptDeadlineMs: 1_000 });
    live.onIo(
      {
        write: () => {
          throw new Error("EPIPE");
        },
        end: () => {},
        closed: Promise.resolve(),
      },
      SESSION,
    );
    await expect(live.message(SESSION, { messageId: MSG, text: "x" })).resolves.toEqual({
      outcome: "delivery_unknown",
      reason: "transport_lost",
    });
    const { live: other } = openSession(1_000);
    const receipt = other.message(SESSION, { messageId: MSG, text: "x" });
    other.onIo(null, SESSION);
    await expect(receipt).resolves.toEqual({
      outcome: "delivery_unknown",
      reason: "transport_lost",
    });
  });
});

describe("claude live input: consumption receipts", () => {
  it("fires ONE live_input_delivered status on the replay echo of a pending id and none for a foreign uuid", async () => {
    const { live, observe } = openSession(1_000);
    const receipt = live.message(SESSION, { messageId: MSG, text: "x" });
    observe(lifecycle(MSG, "queued"));
    await expect(receipt).resolves.toEqual({ outcome: "accepted" });
    // The initial prompt's own echo (a uuid this session never sent through
    // message()) yields nothing — the guard's quiet side.
    expect(observe(replay("initial-prompt-uuid"))).toEqual([]);
    const events = observe(replay(MSG));
    expect(events).toEqual([
      expect.objectContaining({
        type: "status",
        session_id: SESSION,
        text: `live message ${MSG} consumed by the running turn`,
        payload: { code: LIVE_INPUT_DELIVERED, message_id: MSG },
      }),
    ]);
    // started / completed / the result's uuid list never re-announce it.
    expect(observe(lifecycle(MSG, "started"))).toEqual([]);
    expect(observe(lifecycle(MSG, "completed"))).toEqual([]);
    expect(observe(result([MSG]))).toEqual([]);
  });

  it("settles a still-open message as delivered when the echo beats queued, and a later queued frame changes nothing", async () => {
    const { live, observe } = openSession(1_000);
    const receipt = live.message(SESSION, { messageId: MSG, text: "x" });
    const events = observe(replay(MSG));
    expect(events.map((e) => e.payload?.["code"])).toEqual([LIVE_INPUT_DELIVERED]);
    await expect(receipt).resolves.toEqual({ outcome: "delivered" });
    expect(observe(lifecycle(MSG, "queued"))).toEqual([]);
    expect(live.closeStdinOn(SESSION, result([MSG]))).toBe(false); // no result seen yet
  });

  it("receipts through the started lifecycle frame or the result's user_message_uuids when the echo is missing", async () => {
    const byStarted = openSession(1_000);
    const r1 = byStarted.live.message(SESSION, { messageId: MSG, text: "x" });
    expect(byStarted.observe(lifecycle(MSG, "started")).map((e) => e.payload?.["code"])).toEqual([
      LIVE_INPUT_DELIVERED,
    ]);
    await expect(r1).resolves.toEqual({ outcome: "delivered" });
    const byResult = openSession(1_000);
    const r2 = byResult.live.message(SESSION, { messageId: MSG, text: "x" });
    byResult.observe(lifecycle(MSG, "queued"));
    await expect(r2).resolves.toEqual({ outcome: "accepted" });
    expect(byResult.observe(result(["initial", MSG])).map((e) => e.payload?.["code"])).toEqual([
      LIVE_INPUT_DELIVERED,
    ]);
  });

  it("types a cancelled/discarded/refused lifecycle state as live_input_refused without failing the run", async () => {
    const { live, observe } = openSession(1_000);
    const receipt = live.message(SESSION, { messageId: MSG, text: "x" });
    const events = observe(lifecycle(MSG, "refused"));
    expect(events).toEqual([
      expect.objectContaining({
        type: "status",
        payload: { code: LIVE_INPUT_REFUSED, message_id: MSG, state: "refused" },
      }),
    ]);
    expect(events.some((e) => e.type === "error")).toBe(false);
    await expect(receipt).resolves.toEqual({ outcome: "rejected", reason: "rpc_refused" });
    // A refused message never receipts as delivered afterwards.
    expect(observe(replay(MSG))).toEqual([]);
    expect(live.closeStdinOn(SESSION, result([]))).toBe(false);
    observe(result([]));
    expect(live.closeStdinOn(SESSION, {})).toBe(true);
  });

  it("passes parser events through untouched and returns null for an unrecognized frame when nothing correlates", () => {
    const { live } = openSession();
    const parsed: HarnessEvent[] = [
      { type: "message", session_id: SESSION, ts: new Date().toISOString(), text: "x" },
    ];
    expect(live.observe({ type: "assistant" }, parsed, SESSION)).toBe(parsed);
    expect(live.observe({ type: "weird" }, null, SESSION)).toBeNull();
    expect(live.observe({ type: "weird" }, null, "unknown-session")).toBeNull();
  });
});

describe("claude live input: closeStdinOn (the hold)", () => {
  it("is false before any result, true on a quiet result, and the default isResultFrame for an unknown session", () => {
    const { live, observe } = openSession();
    expect(live.closeStdinOn(SESSION, { type: "assistant" })).toBe(false);
    expect(live.closeStdinOn(SESSION, result([]))).toBe(false); // not observed yet
    observe(result(["initial"]));
    expect(live.closeStdinOn(SESSION, result(["initial"]))).toBe(true);
    expect(live.closeStdinOn("never-opened", { type: "result" })).toBe(true);
    expect(live.closeStdinOn("never-opened", { type: "assistant" })).toBe(false);
  });

  it("holds stdin open while a message is queued|started and closes once the result consumed it", async () => {
    const { live, observe } = openSession(1_000);
    const receipt = live.message(SESSION, { messageId: MSG, text: "x" });
    observe(lifecycle(MSG, "queued"));
    await receipt;
    // result#1 consumed only the initial prompt: the queued message runs as the
    // next native turn, so stdin must stay open (the CONTRACT hold).
    observe(result(["initial"]));
    expect(live.closeStdinOn(SESSION, result(["initial"]))).toBe(false);
    observe(lifecycle(MSG, "started"));
    expect(live.closeStdinOn(SESSION, { type: "system", subtype: "init" })).toBe(false);
    // result#2 lists the message: nothing keeps the session open any more.
    observe(result([MSG]));
    expect(live.closeStdinOn(SESSION, result([MSG]))).toBe(true);
  });

  it("holds stdin open for a run-owned BACKGROUND task until its notification, never for a foreground tool or a task that omits the claim", () => {
    const { live, observe } = openSession();
    observe({ type: "system", subtype: "task_started", task_id: "fg", is_backgrounded: false });
    // monitor/workflow-style tasks carry no is_backgrounded field at all: no hold.
    observe({ type: "system", subtype: "task_started", task_id: "m1", task_type: "monitor" });
    observe(result(["initial"]));
    expect(live.closeStdinOn(SESSION, result(["initial"]))).toBe(true);
    const bg = openSession();
    bg.observe({ type: "system", subtype: "task_started", task_id: "bg", is_backgrounded: true });
    bg.observe(result(["initial"]));
    expect(bg.live.closeStdinOn(SESSION, result(["initial"]))).toBe(false);
    bg.observe({
      type: "system",
      subtype: "task_notification",
      task_id: "bg",
      status: "completed",
    });
    expect(bg.live.closeStdinOn(SESSION, { type: "system", subtype: "task_notification" })).toBe(
      true,
    );
  });

  it("holds stdin open from the write until queued, and releases the hold once the acceptance deadline passes", async () => {
    const { live, observe } = openSession(30);
    const receipt = live.message(SESSION, { messageId: MSG, text: "x" });
    // A result that lands in the write→queued gap must not close the session.
    observe(result(["initial"]));
    expect(live.closeStdinOn(SESSION, result(["initial"]))).toBe(false);
    await expect(receipt).resolves.toEqual({
      outcome: "delivery_unknown",
      reason: "response_timeout",
    });
    // Unknown: nothing keeps the session open any more.
    expect(live.closeStdinOn(SESSION, { type: "system", subtype: "init" })).toBe(true);
    // A late echo still receipts the message exactly once.
    const late = observe({ type: "user", isReplay: true, uuid: MSG, message: {} });
    expect((late ?? []).filter((e) => e.payload?.["code"] === "live_input_delivered")).toHaveLength(
      1,
    );
  });

  it("ignores a cancelled lifecycle frame that arrives AFTER the message was consumed", async () => {
    const { live, observe } = openSession();
    const receipt = live.message(SESSION, { messageId: MSG, text: "x" });
    observe(lifecycle(MSG, "queued"));
    await receipt;
    observe(lifecycle(MSG, "started"));
    const after = observe(lifecycle(MSG, "cancelled"));
    expect((after ?? []).filter((e) => e.payload?.["code"] === "live_input_refused")).toHaveLength(
      0,
    );
  });
});
