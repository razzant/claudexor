import { describe, expect, it, vi } from "vitest";
import type { LiveMessageAdapterResult } from "@claudexor/schema";
import { LiveInputRegistry, type LiveAttemptContext, type LiveInputAdapter } from "./live-input.js";

function adapterWith(
  id: string,
  message?: (
    sessionId: string,
    input: { messageId: string; text: string },
  ) => Promise<LiveMessageAdapterResult>,
): LiveInputAdapter {
  return message ? { id, message } : { id };
}

function attempt(overrides: Partial<LiveAttemptContext> = {}): LiveAttemptContext {
  return {
    runId: "run-1",
    taskId: "task-1",
    attemptId: "a01",
    harnessId: "codex",
    currentSessionId: () => "ses-1",
    liveInput: "mid_turn",
    adapter: adapterWith("codex", async () => ({ outcome: "accepted", nativeTurnId: "turn-9" })),
    threadBound: false,
    ...overrides,
  };
}

function registry(
  pending: readonly { interactionId: string; delivery?: "blocking" | "async" }[] = [],
) {
  return new LiveInputRegistry({ pendingForRun: () => pending });
}

const send = (r: LiveInputRegistry, extra: { expectedAttemptId?: string } = {}) =>
  r.send({ runId: "run-1", text: "use MANGO", messageId: "msg-1", ...extra });

describe("LiveInputRegistry decision order (CONTRACT v2)", () => {
  it("answers not_active/no_live_session for a run it never saw, and run_terminal after dropForRun", async () => {
    const r = registry();
    await expect(send(r)).resolves.toMatchObject({
      outcome: "not_active",
      reason: "no_live_session",
    });
    r.register(attempt());
    r.dropForRun("run-1");
    await expect(send(r)).resolves.toMatchObject({ outcome: "not_active", reason: "run_terminal" });
    // A run that was never live but is known terminal answers run_terminal too.
    r.dropForRun("run-2");
    await expect(r.send({ runId: "run-2", text: "x", messageId: "m" })).resolves.toMatchObject({
      outcome: "not_active",
      reason: "run_terminal",
    });
  });

  it("answers unsupported/thread_bound for a thread turn before touching the adapter", async () => {
    const message = vi.fn(async () => ({ outcome: "accepted" }) as LiveMessageAdapterResult);
    const r = registry();
    r.register(attempt({ threadBound: true, adapter: adapterWith("codex", message) }));
    await expect(send(r)).resolves.toMatchObject({
      outcome: "unsupported",
      reason: "thread_bound",
      attemptId: "a01",
      harnessId: "codex",
      liveInput: "mid_turn",
    });
    expect(message).not.toHaveBeenCalled();
  });

  it("rejects multi_attempt without expectedAttemptId and routes by it when given", async () => {
    const first = vi.fn(async () => ({ outcome: "accepted" }) as LiveMessageAdapterResult);
    const second = vi.fn(async () => ({ outcome: "accepted" }) as LiveMessageAdapterResult);
    const r = registry();
    r.register(attempt({ attemptId: "a01", adapter: adapterWith("codex", first) }));
    r.register(attempt({ attemptId: "a02", adapter: adapterWith("codex", second) }));
    const refused = await send(r);
    expect(refused).toMatchObject({ outcome: "rejected", reason: "multi_attempt" });
    expect(refused.message).toContain("a01");
    expect(refused.message).toContain("a02");
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    await expect(send(r, { expectedAttemptId: "a02" })).resolves.toMatchObject({
      outcome: "accepted",
      attemptId: "a02",
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("answers not_active/attempt_mismatch when expectedAttemptId is not the live attempt", async () => {
    const r = registry();
    r.register(attempt());
    await expect(send(r, { expectedAttemptId: "a99" })).resolves.toMatchObject({
      outcome: "not_active",
      reason: "attempt_mismatch",
    });
  });

  it("answers not_active/interaction_pending with NO vendor write while a question is open (INV-048)", async () => {
    const message = vi.fn(async () => ({ outcome: "accepted" }) as LiveMessageAdapterResult);
    const r = registry([{ interactionId: "int-1" }]);
    r.register(attempt({ adapter: adapterWith("codex", message) }));
    await expect(send(r)).resolves.toMatchObject({
      outcome: "not_active",
      reason: "interaction_pending",
      attemptId: "a01",
    });
    expect(message).not.toHaveBeenCalled();
  });

  it("sends a message beside an async question: the agent is still working (#628)", async () => {
    const message = vi.fn(
      async () => ({ outcome: "accepted", nativeTurnId: "turn-9" }) as LiveMessageAdapterResult,
    );
    const r = registry([{ interactionId: "async-1", delivery: "async" }]);
    r.register(attempt({ adapter: adapterWith("codex", message) }));
    await expect(send(r)).resolves.toMatchObject({ outcome: "accepted", nativeTurnId: "turn-9" });
    // The message is ordinary steering; it never answers the open question.
    expect(message).toHaveBeenCalledWith("ses-1", { messageId: "msg-1", text: "use MANGO" });
  });

  it("refuses beside a blocking question even when an async one is also pending", async () => {
    const message = vi.fn(async () => ({ outcome: "accepted" }) as LiveMessageAdapterResult);
    for (const pending of [
      [
        { interactionId: "async-1", delivery: "async" as const },
        { interactionId: "blocking-1", delivery: "blocking" as const },
      ],
      [{ interactionId: "blocking-1", delivery: "blocking" as const }],
    ]) {
      const r = registry(pending);
      r.register(attempt({ adapter: adapterWith("codex", message) }));
      const refused = await send(r);
      expect(refused).toMatchObject({ outcome: "not_active", reason: "interaction_pending" });
      expect(refused.message).toBe(
        "a blocking question is pending; the message was not sent and did not answer it",
      );
    }
    expect(message).not.toHaveBeenCalled();
  });

  it("answers unsupported/no_live_session when the adapter lacks message or the profile is none", async () => {
    const r = registry();
    r.register(attempt({ adapter: adapterWith("cursor"), harnessId: "cursor", liveInput: "none" }));
    await expect(send(r)).resolves.toMatchObject({
      outcome: "unsupported",
      reason: "no_live_session",
      harnessId: "cursor",
      liveInput: "none",
    });
    const message = vi.fn(async () => ({ outcome: "accepted" }) as LiveMessageAdapterResult);
    const declaredNone = registry();
    declaredNone.register(attempt({ adapter: adapterWith("claude", message), liveInput: "none" }));
    await expect(send(declaredNone)).resolves.toMatchObject({
      outcome: "unsupported",
      reason: "no_live_session",
    });
    expect(message).not.toHaveBeenCalled();
  });

  it("answers not_active/no_live_session when the attempt has no native session yet", async () => {
    const message = vi.fn(async () => ({ outcome: "accepted" }) as LiveMessageAdapterResult);
    const r = registry();
    r.register(attempt({ currentSessionId: () => null, adapter: adapterWith("codex", message) }));
    await expect(send(r)).resolves.toMatchObject({
      outcome: "not_active",
      reason: "no_live_session",
    });
    expect(message).not.toHaveBeenCalled();
  });

  it("passes the adapter verdict through 1:1, including delivery_unknown and the native turn id", async () => {
    const seen: { sessionId: string; messageId: string; text: string }[] = [];
    const r = registry();
    r.register(
      attempt({
        adapter: adapterWith("codex", async (sessionId, input) => {
          seen.push({ sessionId, ...input });
          return { outcome: "delivered", nativeTurnId: "turn-42" };
        }),
      }),
    );
    await expect(send(r)).resolves.toEqual({
      outcome: "delivered",
      nativeTurnId: "turn-42",
      attemptId: "a01",
      harnessId: "codex",
      liveInput: "mid_turn",
    });
    expect(seen).toEqual([{ sessionId: "ses-1", messageId: "msg-1", text: "use MANGO" }]);

    const unknown = registry();
    unknown.register(
      attempt({
        adapter: adapterWith("codex", async () => ({
          outcome: "delivery_unknown",
          reason: "response_timeout",
        })),
      }),
    );
    await expect(send(unknown)).resolves.toMatchObject({
      outcome: "delivery_unknown",
      reason: "response_timeout",
    });
  });

  it("maps a throwing adapter to delivery_unknown/transport_lost (the message may have landed)", async () => {
    const r = registry();
    r.register(
      attempt({
        adapter: adapterWith("codex", async () => {
          throw new Error("socket closed");
        }),
      }),
    );
    await expect(send(r)).resolves.toMatchObject({
      outcome: "delivery_unknown",
      reason: "transport_lost",
      message: expect.stringContaining("socket closed"),
    });
  });
});

describe("LiveInputRegistry live session getter and registration ownership", () => {
  it("steers the CURRENT native session after a transient retry minted a new one (live getter)", async () => {
    const sessions: string[] = [];
    let active = "ses-try-0";
    const r = registry();
    r.register(
      attempt({
        currentSessionId: () => active,
        adapter: adapterWith("codex", async (sessionId) => {
          sessions.push(sessionId);
          return { outcome: "accepted" };
        }),
      }),
    );
    await send(r);
    active = "ses-try-1";
    await send(r);
    expect(sessions).toEqual(["ses-try-0", "ses-try-1"]);
  });

  it("a stale release cannot evict a replacement registration for the same attempt id", async () => {
    const r = registry();
    const stale = r.register(attempt({ harnessId: "old" }));
    r.register(attempt({ harnessId: "new" }));
    stale.release();
    await expect(send(r)).resolves.toMatchObject({ outcome: "accepted", harnessId: "new" });
  });

  it("release ends the steering window: the next send answers not_active/no_live_session", async () => {
    const r = registry();
    const live = r.register(attempt());
    await expect(send(r)).resolves.toMatchObject({ outcome: "accepted" });
    live.release();
    await expect(send(r)).resolves.toMatchObject({
      outcome: "not_active",
      reason: "no_live_session",
    });
  });

  it("unregister(runId, attemptId) removes only that attempt", async () => {
    const r = registry();
    r.register(attempt({ attemptId: "a01" }));
    r.register(attempt({ attemptId: "a02" }));
    r.unregister("run-1", "a01");
    await expect(send(r)).resolves.toMatchObject({ outcome: "accepted", attemptId: "a02" });
  });
});
