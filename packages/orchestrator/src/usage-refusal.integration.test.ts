import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import { RunFailure, type HarnessEvent } from "@claudexor/schema";
import { RESET, limit, run, seedSession } from "./inrun-continuity.test-support.js";

/**
 * #558 / #414 through the real orchestrator, the in-run continuation owner and
 * the terminal writers. The scripted harness yields exactly what the Codex
 * app-server translation yields for a failed turn: the synthetic systemError
 * error, then a `completed` with no OS exit evidence that carries the rollout's
 * `vendor_failure` and, for the typed usage refusal, the unknown-reopening limit.
 */
const CREDITS = {
  code: "usage_limit_exceeded",
  message:
    "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
  source: "codex_rollout",
};
const OVERLOADED = {
  code: "server_overloaded",
  message: "Selected model is at capacity. Please try a different model.",
  source: "codex_rollout",
};
const REFUSAL = {
  applies_to_request_kinds: ["text" as const],
  resets_at: null,
  retry_delay_ms: null,
  reopening: "unknown" as const,
};
const WINDOW = "2026-11-04T06:38:13.000Z";

type Emit = (ev: Partial<HarnessEvent>) => HarnessEvent;
/** A failed app-server turn: no exit code, no signal. */
function appServerFailure(
  emit: Emit,
  vendor: Record<string, unknown> | null,
  rateLimit?: HarnessEvent["rate_limit"],
) {
  return [
    emit({ type: "error", error: "Codex app-server thread settled in systemError" }),
    emit({
      type: "completed",
      ...(rateLimit ? { rate_limit: rateLimit } : {}),
      payload: {
        harness_reported_error: true,
        native_session_id: "sid-usage",
        ...(vendor ? { vendor_failure: vendor } : {}),
      },
    }),
  ];
}
const progress = (emit: Emit) => emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
const failureOf = (o: Awaited<ReturnType<typeof run>>) =>
  RunFailure.parse(
    new ArtifactStore(o.root).readYaml(join(o.result.runDir, "final", "failure.yaml")),
  );

describe("typed usage refusal: never a same-account retry (#558)", () => {
  it("before progress under limit_action fail: one try, no fresh same-account replays", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a"],
      limitAction: "fail",
      maxRetries: 2,
      script: function* ({ emit }) {
        yield emit({ type: "started", payload: { native_session_id: "sid-usage" } });
        yield* appServerFailure(emit, CREDITS, REFUSAL);
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a"]);
    expect(o.result.lifecycle).toBe("failed");
    const failure = failureOf(o);
    expect(failure.vendorFailure).toEqual(CREDITS);
    expect(failure.code).toBeNull(); // no RunFailureCode is invented for an unpinned stop
    expect(o.resumable).toMatchObject({
      cause: "vendor_limit",
      limitCode: "vendor_limit_rejected",
      resetsAt: null,
      limitEvidence: "unspecified",
    });
    expect(
      failure.poolAttempts.map((row) => [row.profileId, row.category, row.vendorFailure]),
    ).toEqual([["a", "rate_limited", CREDITS]]);
  });

  it("control: a typed limit WITH a vendor window keeps today's same-account retry under fail", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a"],
      limitAction: "fail",
      maxRetries: 2,
      script: function* ({ emit }) {
        yield emit({ type: "started", payload: { native_session_id: "sid-window" } });
        yield* appServerFailure(emit, null, {
          applies_to_request_kinds: ["text"],
          resets_at: WINDOW,
          retry_delay_ms: null,
        });
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "a", "a"]);
  });

  it("pinned after progress: the typed terminal at once, with no reset and the vendor's own cause", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      pinned: "a",
      script: function* ({ emit, spec }) {
        seedSession(spec.cwd, "a", "sid-usage");
        yield emit({ type: "started", payload: { native_session_id: "sid-usage" } });
        yield progress(emit);
        yield* appServerFailure(emit, CREDITS, REFUSAL);
      },
    });
    expect(o.spawns.map((s) => [s.profile, s.resume])).toEqual([["a", null]]);
    const failure = failureOf(o);
    // This run changed the tree (its session store), so the arbitration record speaks.
    expect(failure).toMatchObject({
      phase: "arbitration",
      code: null,
      category: "harness_unavailable",
      resetsAt: null,
      quotaRefusal: { basis: "provider_cooldown", usedRatio: null },
      vendorFailure: CREDITS,
    });
    expect(failure.poolAttempts).toEqual([
      expect.objectContaining({ profileId: "a", phase: "after_progress", vendorFailure: CREDITS }),
    ]);
    expect(o.resumable).toMatchObject({
      cause: "pinned_limit",
      limitCode: "vendor_limit_rejected",
      resetsAt: null,
      limitEvidence: "unspecified",
    });
  });

  it.each(["agent", "ask", "plan"] as const)(
    "pinned %s before progress: no timer-healing code in the record, and no second try",
    async (mode) => {
      const o = await run({
        mode,
        profiles: ["a", "b"],
        pinned: "a",
        capabilities: { plan: true },
        script: function* ({ emit }) {
          yield emit({ type: "started", payload: { native_session_id: "sid-usage" } });
          yield* appServerFailure(emit, CREDITS, REFUSAL);
        },
      });
      expect(o.spawns.map((s) => s.profile)).toEqual(["a"]);
      expect(failureOf(o)).toMatchObject({
        code: null,
        category: "harness_unavailable",
        resetsAt: null,
        quotaRefusal: { basis: "provider_cooldown" },
        vendorFailure: CREDITS,
      });
    },
  );

  it.each([true, false])(
    "Auto (limit_action auto) moves to the next account (after progress=%s)",
    async (acted) => {
      const o = await run({
        mode: "agent",
        profiles: ["a", "b"],
        script: function* ({ emit, profile, spec }) {
          if (profile === "a") seedSession(spec.cwd, "a", "sid-usage");
          yield emit({ type: "started", payload: { native_session_id: "sid-usage" } });
          if (profile === "a") {
            if (acted) yield progress(emit);
            yield* appServerFailure(emit, CREDITS, REFUSAL);
          } else {
            yield emit({ type: "message", text: "done", final: true });
            yield emit({ type: "completed" });
          }
        },
      });
      expect(o.result.lifecycle).toBe("succeeded");
      expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
      if (acted) expect(o.receipts).toEqual([expect.objectContaining({ cause: "vendor_limit" })]);
    },
  );
});

describe("an errored winner keeps its typed refusal on the arbitration failure record", () => {
  it("a pinned typed limit after a file change keeps its code, known reset and remedy", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      pinned: "a",
      script: function* ({ emit, spec }) {
        yield emit({ type: "started", payload: { native_session_id: "sid-edit" } });
        writeFileSync(join(spec.cwd, "part1.txt"), "half done\n");
        yield emit({ type: "file_change", payload: { path: "part1.txt" } });
        yield* limit(emit);
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a"]);
    const failure = failureOf(o);
    expect(failure).toMatchObject({
      phase: "arbitration",
      category: "harness_unavailable",
      code: "subscription_window_exhausted",
      resetsAt: RESET,
      quotaRefusal: { basis: "provider_cooldown" },
    });
    expect(failure.nextActions).toContain("Inspect candidate artifacts");
    expect(failure.nextActions.join("\n")).not.toMatch(/narrower prompt|wait for the window/);
    expect(o.resumable).toMatchObject({ cause: "pinned_limit", resetsAt: RESET });
  });
});

describe("vendor failure without OS exit evidence (#414)", () => {
  it("reaches the try's account row and the failure record of a no-exit completion", async () => {
    const o = await run({
      mode: "ask",
      profiles: ["a"],
      maxRetries: 0,
      script: function* ({ emit }) {
        yield emit({ type: "started", payload: { native_session_id: "sid-overloaded" } });
        yield* appServerFailure(emit, OVERLOADED);
      },
    });
    const failure = failureOf(o);
    expect(failure.vendorFailure).toEqual(OVERLOADED);
    expect(failure.poolAttempts.map((row) => row.vendorFailure)).toEqual([OVERLOADED]);
    // Evidence only: the category stays the harness's own classification.
    expect(failure.category).toBe("harness_error");
  });

  it.each([
    [
      "a signal kill",
      (emit: Emit) => [
        emit({ type: "error", error: "killed" }),
        emit({
          type: "completed",
          payload: {
            exit_signal: "SIGKILL",
            harness_reported_error: true,
            vendor_failure: CREDITS,
          },
        }),
      ],
    ],
    ["a later failure without vendor evidence", (emit: Emit) => appServerFailure(emit, null)],
  ] as const)(
    "never lends an earlier try's evidence to a later try that ended in %s",
    async (_name, later) => {
      const o = await run({
        mode: "agent",
        profiles: ["a", "b"],
        script: function* ({ emit, profile }) {
          yield emit({ type: "started", payload: { native_session_id: `sid-${profile}` } });
          if (profile === "a") yield* appServerFailure(emit, CREDITS, REFUSAL);
          else yield* later(emit);
        },
      });
      expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
      const failure = failureOf(o);
      expect(failure.vendorFailure).toBeNull();
      expect(failure.poolAttempts.map((row) => [row.profileId, row.vendorFailure])).toEqual([
        ["a", CREDITS],
        ["b", null],
      ]);
    },
  );
});
