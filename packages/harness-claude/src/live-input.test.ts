import { describe, expect, it, vi } from "vitest";
import { runCliHarness, type ChildStdin, type LiveMessageResult } from "@claudexor/core";
import { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { createClaudeAdapter } from "./index.js";
import {
  CLAUDE_LIVE_ACCEPT_DEADLINE_MS,
  FOREIGN_RESULT,
  LIVE_INPUT_ACCEPTED,
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

function openSession(
  deadlineMs = 50,
  promptUuid?: string,
): {
  live: ClaudeLiveInput;
  written: string[];
  observe: (obj: unknown) => HarnessEvent[];
} {
  const live = createClaudeLiveInput({ acceptDeadlineMs: deadlineMs });
  const { io, written } = fakeIo();
  live.onIo(io, SESSION, promptUuid);
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
    const initial = result(["initial"]);
    live.observe(initial, [], SESSION);
    expect(live.closeStdinOn(SESSION, initial)).toBe(true);
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
    expect(observe(lifecycle(MSG, "queued"))).toEqual([]);
    expect(observe(lifecycle(MSG, "started"))).toEqual([]);
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

  it.each(["cancelled", "discarded", "refused"])(
    "releases the started command on %s and keeps its earlier acceptance",
    async (state) => {
      const { live, observe } = openSession();
      const receipt = live.message(SESSION, { messageId: MSG, text: "x" });
      observe(lifecycle(MSG, "queued"));
      observe(lifecycle(MSG, "started"));
      observe(result([]));
      const terminal = lifecycle(MSG, state);
      expect(observe(terminal)).toEqual([]);
      expect(live.closeStdinOn(SESSION, terminal)).toBe(true);
      await expect(receipt).resolves.toEqual({ outcome: "accepted" });
    },
  );
});

describe("Claude live input through the adapter and CLI run loop", () => {
  it.each([
    { active: false, closesOn: "the unacknowledged write's deadline" },
    { active: true, closesOn: "cancellation of the remaining started command" },
  ])("after the prompt result, closes stdin on $closesOn", async ({ active }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { io, written } = fakeIo();
      const end = vi.fn();
      const stdout = (frame: unknown) => ({ type: "stdout" as const, line: JSON.stringify(frame) });
      let openAfterResult: boolean | undefined;
      let openAfterDeadline: boolean | undefined;
      let unacknowledged: Promise<LiveMessageResult> | undefined;
      let started: Promise<LiveMessageResult> | undefined;
      let afterClose: Promise<LiveMessageResult> | undefined;
      const adapter = createClaudeAdapter({
        anthropicApiKey: () => "fixture",
        probeEffortLevels: async () => ({ levels: [], live: true }),
        runCliHarness: (loop) =>
          runCliHarness({
            ...loop,
            program: undefined,
            spawn: async function* (_bin, _args, options) {
              options?.onSpawn?.({ ...io, end });
              const prompt = JSON.parse(written[0]!.trimEnd().split("\n")[1]!);
              yield stdout({ type: "system", subtype: "init", session_id: SESSION });
              if (active) yield stdout(lifecycle("active", "started"));
              yield stdout(result([prompt.uuid]));
              // The loop is waiting for stdout again. No frame wakes it at the deadline.
              openAfterResult = end.mock.calls.length === 0;
              vi.advanceTimersByTime(CLAUDE_LIVE_ACCEPT_DEADLINE_MS);
              openAfterDeadline = end.mock.calls.length === 0;
              if (active) yield stdout(lifecycle("active", "cancelled"));
              // Only EOF allows a clean exit. This also checks the adapter before loop cleanup.
              afterClose = adapter.message!(SESSION, {
                messageId: "after-eof",
                text: "Any notes?",
              });
              yield { type: "exit", code: end.mock.calls.length === 1 ? 0 : 1, signal: null };
            },
          }),
      });
      const spec = HarnessRunSpec.parse({
        session_id: SESSION,
        intent: "implement",
        prompt: "Review the note.",
        cwd: process.cwd(),
        access: "full",
        auth_preference: "api_key",
        processing_preference: "standard",
        extra: { interactionChannel: { request: async () => null } },
      });
      const events: HarnessEvent[] = [];
      for await (const event of adapter.run(spec)) {
        events.push(event);
        if (event.type === "started") {
          unacknowledged = adapter.message!(SESSION, { messageId: MSG, text: "Check the title." });
          if (active)
            started = adapter.message!(SESSION, { messageId: "active", text: "Read the summary." });
        }
      }
      expect(openAfterResult).toBe(true);
      expect(openAfterDeadline).toBe(active);
      expect(await unacknowledged).toEqual({
        outcome: "delivery_unknown",
        reason: "response_timeout",
      });
      expect(await started).toEqual(active ? { outcome: "delivered" } : undefined);
      expect(await afterClose).toEqual({ outcome: "not_active", reason: "no_live_session" });
      expect(
        events.filter((event) => event.payload?.["message_id"]).map((event) => event.payload),
      ).toEqual(active ? [{ code: LIVE_INPUT_DELIVERED, message_id: "active" }] : []);
      expect(writtenUuids(written.slice(1))).toEqual(active ? [MSG, "active"] : [MSG]);
      expect(end).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ type: "completed", payload: { exit_code: 0 } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("claude live input: the current prompt's own result (#536)", () => {
  const PROMPT = "prompt-uuid-1";

  /** A session whose initial prompt frame carried PROMPT as its uuid. */
  function openWithPrompt(): {
    live: ClaudeLiveInput;
    observe: (obj: unknown) => HarnessEvent[];
  } {
    const live = createClaudeLiveInput({ acceptDeadlineMs: 1_000 });
    const { io } = fakeIo();
    live.onIo(io, SESSION, PROMPT);
    return { live, observe: (obj) => live.observe(obj, [], SESSION) ?? [] };
  }

  it("holds on a result that does not name the prompt once Claude Code reported the prompt, and closes on the result that names it", () => {
    const { live, observe } = openWithPrompt();
    observe(lifecycle(PROMPT, "queued"));
    // A resumed session's earlier turn, then results with no attribution at all.
    for (const frame of [result(["previous-turn"]), result([]), { type: "result" }]) {
      observe(frame);
      expect(live.closeStdinOn(SESSION, frame)).toBe(false);
    }
    observe(lifecycle(PROMPT, "started"));
    expect(live.closeStdinOn(SESSION, { type: "system", subtype: "init" })).toBe(false);
    observe(result([PROMPT]));
    expect(live.closeStdinOn(SESSION, result([PROMPT]))).toBe(true);
  });

  it("ends the hold on the prompt's own terminal lifecycle state when no result names it, without a receipt", () => {
    for (const state of ["completed", "cancelled", "discarded", "refused"]) {
      const { live, observe } = openWithPrompt();
      observe(lifecycle(PROMPT, "queued"));
      observe(result([]));
      expect(live.closeStdinOn(SESSION, result([]))).toBe(false);
      expect(observe(lifecycle(PROMPT, state))).toEqual([]);
      expect(live.closeStdinOn(SESSION, lifecycle(PROMPT, state))).toBe(true);
    }
  });

  it("keeps the old rule while Claude Code names no command: the first result closes", () => {
    const quiet = openWithPrompt();
    quiet.observe({ type: "result", subtype: "success" });
    expect(quiet.live.closeStdinOn(SESSION, { type: "result" })).toBe(true);
    // The replay echo alone promises no completion signal, so it starts no hold.
    const echoed = openWithPrompt();
    echoed.observe(replay(PROMPT));
    echoed.observe(result([]));
    expect(echoed.live.closeStdinOn(SESSION, result([]))).toBe(true);
    // Lifecycle frames for another uuid are not this prompt's.
    const other = openWithPrompt();
    other.observe(lifecycle("recorded-prompt", "queued"));
    other.observe(result([]));
    expect(other.live.closeStdinOn(SESSION, result([]))).toBe(true);
  });

  it("holds on a result that names only commands this session never sent, even before Claude Code reports the prompt, and closes on the prompt's own result", () => {
    for (const earlier of [
      result(["previous-turn"]),
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        user_message_uuids: ["previous-turn"],
      },
    ]) {
      const { live, observe } = openWithPrompt();
      // A resumed session's earlier turn (successful or not) before the prompt's lifecycle.
      observe(earlier);
      expect(live.closeStdinOn(SESSION, earlier)).toBe(false);
      for (const frame of [lifecycle(PROMPT, "queued"), lifecycle(PROMPT, "started"), result([])]) {
        observe(frame);
        expect(live.closeStdinOn(SESSION, frame)).toBe(false);
      }
      observe(result([PROMPT]));
      expect(live.closeStdinOn(SESSION, result([PROMPT]))).toBe(true);
    }
  });

  it("never counts this session's own live message as a foreign command", async () => {
    const { live, observe } = openWithPrompt();
    const receipt = live.message(SESSION, { messageId: MSG, text: "x" });
    observe(lifecycle(MSG, "queued"));
    await expect(receipt).resolves.toEqual({ outcome: "accepted" });
    // A CLI that names only the message keeps the first-result rule once it is consumed.
    observe(result([MSG]));
    expect(live.closeStdinOn(SESSION, result([MSG]))).toBe(true);
  });

  it("ends a prompt Claude Code reported on an error result that names no command, as the first result always did (no wait for a signal an error turn may never send)", () => {
    for (const failed of [
      { type: "result", subtype: "error_during_execution", is_error: true },
      // A success-labelled error result (prompt_too_long), with an empty list.
      { type: "result", subtype: "success", is_error: true, user_message_uuids: [] },
    ]) {
      const { live, observe } = openWithPrompt();
      observe(lifecycle(PROMPT, "queued"));
      observe(lifecycle(PROMPT, "started"));
      expect(observe(failed)).toEqual([]);
      expect(live.closeStdinOn(SESSION, failed)).toBe(true);
    }
    // An unattributed success result does not end it: its own result or lifecycle will.
    const { live, observe } = openWithPrompt();
    observe(lifecycle(PROMPT, "queued"));
    observe(result([]));
    expect(live.closeStdinOn(SESSION, result([]))).toBe(false);
  });

  it("after the prompt's own result, keeps the existing holds: a queued live message and an explicit background claim hold, a monitor task without the claim does not", async () => {
    const queued = openWithPrompt();
    const receipt = queued.live.message(SESSION, { messageId: MSG, text: "x" });
    queued.observe(lifecycle(PROMPT, "queued"));
    queued.observe(lifecycle(MSG, "queued"));
    await expect(receipt).resolves.toEqual({ outcome: "accepted" });
    queued.observe(result([PROMPT]));
    expect(queued.live.closeStdinOn(SESSION, result([PROMPT]))).toBe(false);
    queued.observe(result([MSG]));
    expect(queued.live.closeStdinOn(SESSION, result([MSG]))).toBe(true);

    const bg = openWithPrompt();
    bg.observe(lifecycle(PROMPT, "queued"));
    bg.observe({ type: "system", subtype: "task_started", task_id: "bg", is_backgrounded: true });
    bg.observe(result([PROMPT]));
    expect(bg.live.closeStdinOn(SESSION, result([PROMPT]))).toBe(false);
    bg.observe({ type: "system", subtype: "task_notification", task_id: "bg" });
    expect(bg.live.closeStdinOn(SESSION, { type: "system", subtype: "task_notification" })).toBe(
      true,
    );

    const monitor = openWithPrompt();
    monitor.observe(lifecycle(PROMPT, "queued"));
    monitor.observe({
      type: "system",
      subtype: "task_started",
      task_id: "m1",
      task_type: "monitor",
    });
    monitor.observe(result([PROMPT]));
    expect(monitor.live.closeStdinOn(SESSION, result([PROMPT]))).toBe(true);
  });

  describe("a result that answered another turn decides nothing about this run", () => {
    const earlierFailure = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      user_message_uuids: ["previous-turn"],
    };
    const base = { session_id: SESSION, ts: "2026-11-10T00:00:00.000Z" };

    it("keeps its usage and rebuilds everything else it reports as a status with no outcome field", () => {
      const { live } = openWithPrompt();
      const usage: HarnessEvent = { ...base, type: "usage", usage: { cost_usd: 0 } };
      const out = live.observe(
        earlierFailure,
        [
          usage,
          { ...base, type: "status", text: "partial", payload: { non_success_result: true } },
          {
            ...base,
            type: "status",
            text: "entitlement: denied",
            status: { kind: "api_retry", error_category: "oauth_org_not_allowed" },
            payload: { entitlement_denied: true },
          },
          {
            ...base,
            type: "error",
            error: "API Error: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
            payload: { api_error_status: 400 },
            request_refusal: {
              kind: "vendor_cli_too_old",
              native_code: "claude_code_version_too_old",
              source: "claude_stdout",
              binary_path: null,
              installed_version: null,
            },
          },
          {
            ...base,
            type: "error",
            error: "max-turns limit reached",
            turn_limit: { native_code: "error_max_turns", num_turns: 3 },
          },
          {
            ...base,
            type: "context",
            context: {
              kind: "capacity_exhausted",
              cause: "prompt_too_long",
              native_code: "prompt_too_long",
              trigger: null,
              pre_tokens: null,
            },
          },
          {
            ...base,
            type: "thinking",
            text: "retries exhausted",
            payload: { structured_output_retries_exhausted: true },
          },
          {
            ...base,
            type: "message",
            text: "the earlier answer",
            final: true,
            payload: { final_source: "result", work_report_side_tool: { state: "completed" } },
          },
        ],
        SESSION,
      )!;
      expect(out[0]).toBe(usage);
      expect(out.slice(1).map((e) => [e.payload?.["event_type"], e.text])).toEqual([
        ["status", "partial"],
        ["status", "entitlement: denied"],
        ["error", "API Error: Authorization: [redacted]"],
        ["error", "max-turns limit reached"],
        ["context", "prompt_too_long"],
        ["thinking", "retries exhausted"],
        ["message", "the earlier answer"],
      ]);
      for (const event of out.slice(1)) {
        // Rebuilt, not filtered: nothing but the diagnostic survives.
        expect(Object.keys(event).sort()).toEqual(["payload", "session_id", "text", "ts", "type"]);
        expect(() => HarnessEvent.parse(event)).not.toThrow();
        expect(event.type).toBe("status");
        expect(event.payload).toEqual({
          code: FOREIGN_RESULT,
          event_type: event.payload?.["event_type"],
          user_message_uuids: ["previous-turn"],
        });
      }
    });

    it("leaves every other result's events untouched: the prompt's own, a live message's, one naming no command, and any result once the prompt has ended", async () => {
      const events: HarnessEvent[] = [{ ...base, type: "error", error: "result subtype: x" }];
      const failing = (uuids?: string[]) => ({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        ...(uuids ? { user_message_uuids: uuids } : {}),
      });
      for (const uuids of [[PROMPT], [PROMPT, "previous-turn"], [], undefined]) {
        const { live } = openWithPrompt();
        expect(live.observe(failing(uuids), events, SESSION)).toEqual(events);
      }

      const withMessage = openWithPrompt();
      const receipt = withMessage.live.message(SESSION, { messageId: MSG, text: "x" });
      withMessage.observe(lifecycle(MSG, "queued"));
      await receipt;
      // The result names the message, so it is receipted beside the kept error.
      expect(withMessage.live.observe(failing([MSG]), events, SESSION)).toEqual([
        ...events,
        expect.objectContaining({ payload: { code: LIVE_INPUT_DELIVERED, message_id: MSG } }),
      ]);
      expect(withMessage.live.observe(failing([MSG, "previous-turn"]), events, SESSION)).toEqual(
        events,
      );

      const ended = openWithPrompt();
      ended.observe(result([PROMPT]));
      expect(ended.live.observe(failing(["later-turn"]), events, SESSION)).toEqual(events);
    });

    it("cannot decide ownership without the prompt's identity, so a session that has none keeps every result's events", () => {
      const live = createClaudeLiveInput({ acceptDeadlineMs: 1_000 });
      const { io } = fakeIo();
      live.onIo(io, SESSION);
      const events: HarnessEvent[] = [{ ...base, type: "error", error: "result subtype: x" }];
      expect(live.observe(earlierFailure, events, SESSION)).toEqual(events);
      expect(live.observe(earlierFailure, events, "unknown-session")).toEqual(events);
    });
  });
});

/** A rate-limit frame: only its status refuses; allowed frames still carry ratios. */
const rateLimit = (status: string, rateLimitType = "seven_day") => ({
  type: "rate_limit_event",
  rate_limit_info: { status, rateLimitType, utilization: 1, resetsAt: 1_900_000_000 },
});

/** The failed result of a request the API refused, with its typed HTTP status. */
const refusedRequest = (uuids: string[], fields: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 429,
  user_message_uuids: uuids,
  ...fields,
});

const nativeTurn = { type: "system", subtype: "init" };

function writtenUuids(written: string[]): string[] {
  return written.map((line) => (JSON.parse(line) as { uuid: string }).uuid);
}

describe("claude live input: the quota refusal of its own command closes the input once (#627)", () => {
  const PROMPT = "prompt-627";

  /** A running prompt Claude Code identified, a queued live message and an open
   * background task: every ordinary hold is in place. */
  async function heldSession(): Promise<{
    live: ClaudeLiveInput;
    observe: (obj: unknown) => HarnessEvent[];
  }> {
    const live = createClaudeLiveInput({ acceptDeadlineMs: 1_000 });
    live.onIo(fakeIo().io, SESSION, PROMPT);
    const observe = (obj: unknown) => live.observe(obj, [], SESSION) ?? [];
    observe(lifecycle(PROMPT, "queued"));
    observe({ type: "system", subtype: "task_started", task_id: "bg", is_backgrounded: true });
    const queued = live.message(SESSION, { messageId: MSG, text: "x" });
    observe(lifecycle(MSG, "queued"));
    await expect(queued).resolves.toEqual({ outcome: "accepted" });
    return { live, observe };
  }

  /** Whether the run loop, asking on the last of these frames, closes stdin. */
  async function closesOn(frames: unknown[]): Promise<boolean> {
    const { live, observe } = await heldSession();
    for (const frame of frames) observe(frame);
    return live.closeStdinOn(SESSION, frames.at(-1));
  }

  const closing: Array<[string, unknown[]]> = [
    ["the prompt's own 429", [rateLimit("rejected"), refusedRequest([PROMPT])]],
    ["an error result naming no command mid-prompt", [rateLimit("blocked"), refusedRequest([])]],
    [
      "a live message's own 429 after the prompt succeeded",
      [result([PROMPT]), nativeTurn, replay(MSG), rateLimit("rejected"), refusedRequest([MSG])],
    ],
  ];

  it.each(closing)("closes it on %s after this turn's refusal", async (_case, frames) => {
    expect(await closesOn(frames)).toBe(true);
  });

  it("keeps the prompt's refusal across an earlier turn's named result", async () => {
    const { live, observe } = await heldSession();
    observe(rateLimit("rejected"));
    const earlier = result(["previous-turn"]);
    observe(earlier);
    expect(live.closeStdinOn(SESSION, earlier)).toBe(false);
    const current = refusedRequest([PROMPT]);
    observe(current);
    expect(live.closeStdinOn(SESSION, current)).toBe(true);
  });

  const holding: Array<[string, unknown[]]> = [
    ["a warning-only frame at full use", [rateLimit("allowed_warning"), refusedRequest([PROMPT])]],
    [
      "a family refusal that a later frame of the same turn allows",
      [
        rateLimit("rejected", "seven_day_opus"),
        rateLimit("allowed", "five_hour"),
        refusedRequest([PROMPT]),
      ],
    ],
    ["a 429 without a refusal in its turn", [refusedRequest([PROMPT])]],
    [
      "an overloaded failure after a refusal",
      [rateLimit("rejected"), refusedRequest([PROMPT], { api_error_status: 529 })],
    ],
    [
      "a failure with no API status after a refusal",
      [
        rateLimit("rejected"),
        refusedRequest([PROMPT], { subtype: "error_during_execution", api_error_status: null }),
      ],
    ],
    ["a success after a refusal", [rateLimit("rejected"), result([PROMPT])]],
    [
      "a queued message's 429 after the prompt's own success consumed the refusal",
      [rateLimit("rejected"), result([PROMPT]), refusedRequest([MSG])],
    ],
    [
      "a refusal before the native turn changed",
      [rateLimit("rejected"), nativeTurn, refusedRequest([PROMPT])],
    ],
    [
      "a 429 in the turn after a refused but served one",
      [rateLimit("rejected"), result([PROMPT]), nativeTurn, replay(MSG), refusedRequest([MSG])],
    ],
    ["another turn's result", [rateLimit("rejected"), refusedRequest(["previous-turn"])]],
    [
      "a result naming no command once the prompt ended",
      [result([PROMPT]), nativeTurn, rateLimit("rejected"), refusedRequest([])],
    ],
  ];

  it.each(holding)("keeps every hold on %s", async (_case, frames) => {
    expect(await closesOn(frames)).toBe(false);
  });

  it("keeps result ownership after the refusal closed stdin while the prompt still runs", async () => {
    const { live, observe } = await heldSession();
    // An earlier turn consumed the live message and was refused: the input closes.
    observe(rateLimit("rejected"));
    const refused = refusedRequest(["previous-turn", MSG]);
    observe(refused);
    expect(live.closeStdinOn(SESSION, refused)).toBe(true);
    live.onIo(null, SESSION);
    const answer: HarnessEvent = {
      type: "message",
      session_id: SESSION,
      ts: "2026-01-01T00:00:00.000Z",
      text: "another turn's answer",
      final: true,
    };
    // The CLI drains another turn: its answer never becomes this run's.
    const foreign = live.observe(result(["another-turn"]), [answer], SESSION)!;
    expect(foreign.map((event) => [event.type, event.payload?.["code"]])).toEqual([
      ["status", FOREIGN_RESULT],
    ]);
    // The prompt's own result keeps its meaning and ends it; later work is the run's.
    expect(live.observe(result([PROMPT]), [answer], SESSION)).toEqual([answer]);
    expect(live.observe(result(["background-report"]), [answer], SESSION)).toEqual([answer]);
  });
});

describe("claude live input: a late acceptance after delivery_unknown", () => {
  const accepted = (events: HarnessEvent[]) =>
    events.filter((event) => event.payload?.["code"] === LIVE_INPUT_ACCEPTED);
  const delivered = (events: HarnessEvent[]) =>
    events.filter((event) => event.payload?.["code"] === LIVE_INPUT_DELIVERED);

  it.each(["response_timeout", "transport_lost"] as const)(
    "reports a queued frame after %s once, as acceptance only and without another write",
    async (reason) => {
      const { live, written, observe } = openSession(20);
      const receipt = live.message(SESSION, { messageId: MSG, text: "x" });
      if (reason === "transport_lost") live.onIo(null, SESSION);
      await expect(receipt).resolves.toEqual({ outcome: "delivery_unknown", reason });
      const late = observe(lifecycle(MSG, "queued"));
      expect(late.map((event) => event.payload)).toEqual([
        { code: LIVE_INPUT_ACCEPTED, message_id: MSG },
      ]);
      expect(delivered(late)).toEqual([]);
      expect(observe(lifecycle(MSG, "queued"))).toEqual([]);
      expect(written).toHaveLength(1);
      const initial = result(["initial"]);
      observe(initial);
      expect(live.closeStdinOn(SESSION, initial)).toBe(reason === "transport_lost");
      // Consumption is still its own, single receipt.
      expect(delivered(observe(lifecycle(MSG, "started")))).toHaveLength(1);
      expect(accepted(observe(result([MSG])))).toEqual([]);
      expect(live.closeStdinOn(SESSION, result([MSG]))).toBe(true);
      await expect(receipt).resolves.toEqual({ outcome: "delivery_unknown", reason });
      expect(written).toHaveLength(1);
    },
  );

  it("holds stdin for a late started command without queued, through the prompt's own result", async () => {
    const prompt = "current-prompt";
    const { live, written, observe } = openSession(20, prompt);
    const receipt = live.message(SESSION, { messageId: MSG, text: "Review the note." });
    await expect(receipt).resolves.toEqual({
      outcome: "delivery_unknown",
      reason: "response_timeout",
    });
    expect(observe(lifecycle(MSG, "started")).map((event) => event.payload)).toEqual([
      { code: LIVE_INPUT_DELIVERED, message_id: MSG },
    ]);
    expect(observe(lifecycle(MSG, "queued"))).toEqual([]);
    const answer: HarnessEvent = {
      type: "message",
      session_id: SESSION,
      ts: "2026-11-17T00:00:00.000Z",
      text: "Review finished.",
      final: true,
    };
    const earlier = live.observe(result(["earlier-prompt"]), [answer], SESSION);
    expect(earlier?.[0]?.payload?.["code"]).toBe(FOREIGN_RESULT);
    const own = result([prompt]);
    expect(live.observe(own, [answer], SESSION)).toEqual([answer]);
    expect(live.closeStdinOn(SESSION, own)).toBe(false);
    const done = result([MSG]);
    expect(live.observe(done, [answer], SESSION)).toEqual([answer]);
    expect(live.closeStdinOn(SESSION, done)).toBe(true);
    expect(writtenUuids(written)).toEqual([MSG]);
  });

  it("adds nothing once the message was already consumed or accepted in time", async () => {
    const { live, observe } = openSession(20);
    const receipt = live.message(SESSION, { messageId: MSG, text: "x" });
    await expect(receipt).resolves.toMatchObject({ outcome: "delivery_unknown" });
    expect(delivered(observe(replay(MSG)))).toHaveLength(1);
    expect(observe(lifecycle(MSG, "queued"))).toEqual([]);

    const timely = openSession(1_000);
    const inTime = timely.live.message(SESSION, { messageId: MSG, text: "x" });
    expect(timely.observe(lifecycle(MSG, "queued"))).toEqual([]);
    await expect(inTime).resolves.toEqual({ outcome: "accepted" });
  });
});

describe("claude live input: the session lives until the run's stream ends", () => {
  const PROMPT = "prompt-stream";
  const status = (text: string): HarnessEvent => ({
    type: "status",
    session_id: SESSION,
    ts: "2026-01-01T00:00:00.000Z",
    text,
  });

  async function drain(events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
    const out: HarnessEvent[] = [];
    for await (const event of events) out.push(event);
    return out;
  }

  it("closing stdin ends writing only: messages already written keep their late echo and lifecycle refusal as receipts, a new one is not written, and the stream's end forgets the session", async () => {
    const live = createClaudeLiveInput({ acceptDeadlineMs: 1_000 });
    const { io, written } = fakeIo();
    const receipts: Array<Promise<LiveMessageResult>> = [];
    let afterClose: LiveMessageResult | undefined;
    async function* run(): AsyncGenerator<HarnessEvent> {
      live.onIo(io, SESSION, PROMPT);
      for (const id of ["echoed", "refused-late", "unreceipted"])
        receipts.push(live.message(SESSION, { messageId: id, text: id }));
      // The run loop closed stdin; the CLI goes on draining what it read.
      live.onIo(null, SESSION);
      afterClose = await live.message(SESSION, { messageId: "after-close", text: "x" });
      yield* live.observe(replay("echoed"), [], SESSION) ?? [];
      yield* live.observe(lifecycle("refused-late", "refused"), [], SESSION) ?? [];
    }
    const events = await drain(live.stream(SESSION, PROMPT, run()));
    expect(events.map((event) => event.payload)).toEqual([
      { code: LIVE_INPUT_DELIVERED, message_id: "echoed" },
      { code: LIVE_INPUT_REFUSED, message_id: "refused-late", state: "refused" },
    ]);
    // The requests were answered when stdin closed; the receipts above came later.
    const lost = { outcome: "delivery_unknown", reason: "transport_lost" };
    await expect(Promise.all(receipts)).resolves.toEqual([lost, lost, lost]);
    expect(afterClose).toEqual({ outcome: "not_active", reason: "no_live_session" });
    expect(writtenUuids(written)).toEqual(["echoed", "refused-late", "unreceipted"]);
    // The stream ended: nothing correlates any more.
    expect(live.observe(replay("unreceipted"), [], SESSION)).toEqual([]);
    await expect(live.message(SESSION, { messageId: "later", text: "x" })).resolves.toEqual({
      outcome: "not_active",
      reason: "no_live_session",
    });
  });

  it("forgets the session when its consumer stops early or its producer throws", async () => {
    const lost = { outcome: "delivery_unknown", reason: "transport_lost" };
    const stopped = createClaudeLiveInput({ acceptDeadlineMs: 1_000 });
    let pending: Promise<LiveMessageResult> | undefined;
    async function* working(): AsyncGenerator<HarnessEvent> {
      stopped.onIo(fakeIo().io, SESSION, PROMPT);
      pending = stopped.message(SESSION, { messageId: MSG, text: "x" });
      yield status("working");
      yield status("never read");
    }
    for await (const _event of stopped.stream(SESSION, PROMPT, working())) break;
    await expect(pending).resolves.toEqual(lost);
    expect(stopped.observe(replay(MSG), [], SESSION)).toEqual([]);

    const broken = createClaudeLiveInput({ acceptDeadlineMs: 1_000 });
    async function* failing(): AsyncGenerator<HarnessEvent> {
      broken.onIo(fakeIo().io, SESSION, PROMPT);
      pending = broken.message(SESSION, { messageId: MSG, text: "x" });
      yield status("working");
      throw new Error("stream broke");
    }
    await expect(drain(broken.stream(SESSION, PROMPT, failing()))).rejects.toThrow("stream broke");
    await expect(pending).resolves.toEqual(lost);
    expect(broken.observe(replay(MSG), [], SESSION)).toEqual([]);
  });

  it("never ends a later run's session registered under the same id", async () => {
    const live = createClaudeLiveInput({ acceptDeadlineMs: 1_000 });
    const first = fakeIo();
    const later = fakeIo();
    async function* superseded(): AsyncGenerator<HarnessEvent> {
      live.onIo(first.io, SESSION, PROMPT);
      live.onIo(later.io, SESSION, "prompt-later");
      yield status("working");
    }
    await drain(live.stream(SESSION, PROMPT, superseded()));
    const receipt = live.message(SESSION, { messageId: MSG, text: "x" });
    expect(first.written).toEqual([]);
    expect(writtenUuids(later.written)).toEqual([MSG]);
    live.observe(lifecycle(MSG, "queued"), [], SESSION);
    await expect(receipt).resolves.toEqual({ outcome: "accepted" });
  });
});
