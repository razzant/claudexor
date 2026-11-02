/**
 * #318 through the real Orchestrator on a scripted fake harness: a typed
 * provider limit on a strict pin, before or after progress, reaches
 * failure.yaml with its code, reset and machine-readable basis in every mode
 * whose terminal writer owns it (ordinary Ask, Agent attempts, Plan, and the
 * multi-candidate reduction). Successes stay successes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  ConformanceReport,
  HarnessManifest,
  RunFailure,
  type HarnessEvent,
  type QuotaSnapshot,
} from "@claudexor/schema";
import type { ReviewerSpec } from "@claudexor/review";
import { RESET, crash, run } from "./inrun-continuity.test-support.js";
import { createClaudeParser } from "../../harness-claude/src/parse.js";
import {
  withClaudeApiFailureParser,
  withClaudeVendorFailure,
} from "../../harness-claude/src/vendor-failure.js";

type Emit = (ev: Partial<HarnessEvent>) => HarnessEvent;

const LATER = "2026-10-07T21:00:00.000Z";

/** A typed vendor limit naming its window, then the try's end. */
const namedLimit = (emit: Emit, constraintId: string, resetsAt = RESET) => [
  emit({
    type: "status",
    status: { kind: "api_retry", error_category: "rate_limit" },
    rate_limit: { resets_at: resetsAt, retry_delay_ms: null, constraint_id: constraintId },
  }),
  emit({ type: "error", error: "usage limit reached" }),
  emit({ type: "completed" }),
];

/** Best-of requires review; every candidate fails before a diff exists. */
const reviewer: ReviewerSpec = {
  providerFamily: "openai",
  adapter: {
    id: "unused-reviewer",
    async discover() {
      return HarnessManifest.parse({
        id: "unused-reviewer",
        display_name: "unused reviewer",
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { review: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "unused-reviewer",
        status: "ok",
        enabled_intents: ["review"],
      });
    },
    async *run() {
      throw new Error("no candidate produced a diff to review");
    },
  },
};

const planCapable = { plan: true };

function failureOf(o: Awaited<ReturnType<typeof run>>): RunFailure {
  return RunFailure.parse(
    new ArtifactStore(o.root).readYaml(join(o.result.runDir, "final", "failure.yaml")),
  );
}

const providerLimit = (constraintId: string | null, resetsAt: string | null = RESET) => ({
  code: "subscription_window_exhausted",
  category: "harness_unavailable",
  resetsAt,
  quotaRefusal: { basis: "provider_cooldown", constraintId, usedRatio: null, threshold: null },
});

describe("pinned typed limit terminals carry the quota basis", () => {
  const cases = [
    { mode: "ask" as const, input: {} },
    { mode: "agent" as const, input: { attempts: 1 } },
    { mode: "plan" as const, input: {} },
  ];
  for (const { mode, input } of cases) {
    for (const progress of [false, true]) {
      it(`${mode}${"attempts" in input ? " --attempts" : ""} ${progress ? "after" : "before"} progress`, async () => {
        const o = await run({
          mode,
          profiles: ["a", "b"],
          pinned: "a",
          capabilities: planCapable,
          input,
          script: function* ({ emit }) {
            yield emit({ type: "started", payload: { native_session_id: "sid-pin" } });
            if (progress) yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
            yield* namedLimit(emit, "five_hour");
          },
        });
        expect(o.result.lifecycle, JSON.stringify(failureOf(o).safeMessage)).toBe("failed");
        expect(failureOf(o).phase, failureOf(o).safeMessage).not.toBe("routing");
        // A pin never rotates.
        expect(o.spawns.every((spawn) => spawn.profile === "a")).toBe(true);
        expect(failureOf(o)).toMatchObject(providerLimit("five_hour"));
      });
    }
  }

  it("a pinned Plan that succeeds stays a success", async () => {
    const o = await run({
      mode: "plan",
      profiles: ["a"],
      pinned: "a",
      capabilities: planCapable,
      script: function* ({ emit }) {
        yield emit({ type: "started", payload: { native_session_id: "sid-plan" } });
        yield emit({ type: "message", text: "1. Build the dashboard", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle).toBe("succeeded");
  });

  it("an unpinned Plan limit keeps its previous harness terminal", async () => {
    const o = await run({
      mode: "plan",
      profiles: ["a"],
      capabilities: planCapable,
      script: function* ({ emit }) {
        yield emit({ type: "started", payload: { native_session_id: "sid-plan" } });
        yield* namedLimit(emit, "five_hour");
      },
    });
    expect(failureOf(o).phase).toBe("harness");
    expect(failureOf(o).quotaRefusal).toBeUndefined();
  });

  it("Plan initial admission refuses a pin at the owner's reserve before any spawn", async () => {
    const weeklyReset = new Date(Date.now() + 86_400_000).toISOString();
    const reserve: QuotaSnapshot = {
      subject: {
        harness: "fake",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "a",
      },
      source: "codex_app_server",
      observed_at: new Date().toISOString(),
      freshness: "fresh",
      constraints: [
        {
          id: "weekly",
          label: "weekly",
          used_ratio: 0.95,
          window_seconds: 604_800,
          resets_at: weeklyReset,
          cooldown_until: null,
        },
      ],
    };
    const o = await run({
      mode: "plan",
      profiles: ["a"],
      pinned: "a",
      capabilities: planCapable,
      headroomThreshold: 0.9,
      snapshots: [reserve],
      script: function* () {
        throw new Error("a refused pin must not spawn");
      },
    });
    expect(o.spawns).toHaveLength(0);
    expect(failureOf(o)).toMatchObject({
      code: "subscription_window_exhausted",
      resetsAt: weeklyReset,
      quotaRefusal: { basis: "owner_reserve", constraintId: "weekly", usedRatio: 0.95 },
    });
  });

  it("a multi-candidate pinned failure keeps only details every candidate shares", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a"],
      pinned: "a",
      input: { n: 2, review: true },
      reviewers: [reviewer],
      script: function* ({ emit, tryOfProfile }) {
        yield emit({ type: "started", payload: { native_session_id: `sid-${tryOfProfile}` } });
        yield* tryOfProfile === 1
          ? namedLimit(emit, "five_hour", RESET)
          : namedLimit(emit, "weekly", LATER);
      },
    });
    const failure = failureOf(o);
    // The run's reset is the latest; no single candidate's window is paired with it.
    expect(failure).toMatchObject(providerLimit(null, LATER));
  });

  /** Recorded Claude stream frames, mapped by the real Claude parser. */
  const frames = (file: string) =>
    readFileSync(new URL(`../../harness-claude/fixtures/${file}`, import.meta.url), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const retryFrames = frames("session-resume-rate-limit.jsonl");
  const apiRetry = retryFrames.find((frame) => frame["subtype"] === "api_retry")!;
  const claude = (emit: Emit, raw: Record<string, unknown>[]) => {
    const parse = withClaudeApiFailureParser(createClaudeParser(), "/fixture/claude");
    return raw.flatMap((frame) =>
      (parse(frame, "sid-claude") ?? []).map((event) => emit({ ...event })),
    );
  };
  const pinnedPlan = (
    script: (emit: Emit) => Iterable<HarnessEvent> | AsyncIterable<HarnessEvent>,
  ) =>
    run({
      mode: "plan",
      profiles: ["a", "b"],
      pinned: "a",
      capabilities: planCapable,
      script: async function* ({ emit }: { emit: Emit }) {
        yield emit({ type: "started", payload: { native_session_id: "sid-claude" } });
        yield* script(emit);
      } as never,
    });

  it("a Plan whose Claude retry recovered and then died of transport keeps that terminal", async () => {
    // Real Claude frames: the native api_retry rate limit, then the stream
    // recovers with tool work; the process then dies of a transport error.
    const o = await pinnedPlan((emit) => [
      ...claude(emit, retryFrames.slice(0, 4)),
      ...crash(emit),
    ]);
    expect(o.result.lifecycle).toBe("failed");
    expect(o.spawns.map((spawn) => spawn.profile)).toEqual(["a"]);
    const failure = failureOf(o);
    expect(failure.phase).toBe("harness");
    expect(failure.code).not.toBe("subscription_window_exhausted");
    expect(failure.quotaRefusal).toBeUndefined();
    expect(failure.resetsAt).toBeNull();
  });

  it("a Plan retry followed by Claude's vendor_cli_too_old keeps the request refusal", async () => {
    const tooOld = frames("signals/vendor-cli-too-old-2.1.288.jsonl");
    const o = await pinnedPlan(async function* (emit) {
      async function* native() {
        yield* claude(emit, [apiRetry, ...tooOld]);
        yield emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
      }
      yield* withClaudeVendorFailure(native());
    });
    const failure = failureOf(o);
    expect(failure.code).toBe("vendor_cli_too_old");
    expect(failure.requestRefusal).toMatchObject({ kind: "vendor_cli_too_old" });
    expect(failure.quotaRefusal).toBeUndefined();
  });

  it("an unrecovered Claude retry limit on a pinned Plan stays a typed provider limit", async () => {
    // The limit is still the last word: no agent work after it before the end.
    const o = await pinnedPlan((emit) => [...claude(emit, [apiRetry]), ...crash(emit)]);
    expect(o.spawns.map((spawn) => spawn.profile)).toEqual(["a"]);
    expect(failureOf(o)).toMatchObject(providerLimit(null, null));
  });

  it("a Plan adapter that throws after an unrecovered limit keeps the thrown terminal", async () => {
    const o = await pinnedPlan(async function* (emit) {
      yield* claude(emit, [apiRetry]);
      throw new Error("adapter stream broke");
    });
    expect(o.result.lifecycle).toBe("failed");
    expect(failureOf(o).quotaRefusal).toBeUndefined();
    expect(failureOf(o).code).not.toBe("subscription_window_exhausted");
  });

  // The second review's shapes: an overload/429 api_retry frame (mapped to a
  // rate limit with only a retry delay), with or without later work, then a
  // terminal that is not the limit. None of them is a quota refusal.
  const overload = { ...apiRetry, error: "overloaded_error: Overloaded", retry_delay_ms: 1000 };
  const work = (emit: Emit) => emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
  for (const recovered of [false, true]) {
    const after = (emit: Emit) => [...claude(emit, [overload]), ...(recovered ? [work(emit)] : [])];
    it(`a Plan overload retry${recovered ? " then work" : ""} then context exhaustion stays interrupted`, async () => {
      const o = await pinnedPlan((emit) => [
        ...after(emit),
        emit({
          type: "context",
          context: {
            kind: "capacity_exhausted",
            cause: "prompt_too_long",
            native_code: null,
            trigger: null,
            pre_tokens: null,
          },
        }),
        emit({ type: "completed" }),
      ]);
      expect(o.result.lifecycle).toBe("interrupted");
      expect(failureOf(o).quotaRefusal).toBeUndefined();
      expect(failureOf(o).code).not.toBe("subscription_window_exhausted");
    });
    it(`a Plan overload retry${recovered ? " then work" : ""} then no plan text keeps the empty-plan failure`, async () => {
      const o = await pinnedPlan((emit) => [...after(emit), emit({ type: "completed" })]);
      expect(o.result.lifecycle).toBe("failed");
      expect(failureOf(o).quotaRefusal).toBeUndefined();
      expect(failureOf(o).safeMessage).toContain("planner produced no plan text");
    });
    it(`a Plan overload retry${recovered ? " then work" : ""} then a work_report contract failure keeps it`, async () => {
      const o = await run({
        mode: "plan",
        profiles: ["a", "b"],
        pinned: "a",
        capabilities: {
          read_files: true,
          plan: true,
          work_report_transport: "constrained",
          json_schema_output: true,
          structured_output_channel: "final_message",
        },
        script: function* ({ emit }) {
          yield emit({ type: "started", payload: { native_session_id: "sid-claude" } });
          yield* after(emit);
          yield emit({ type: "message", text: "not the constrained envelope", final: true });
          yield emit({ type: "completed" });
        },
      });
      expect(o.result.lifecycle).toBe("failed");
      expect(failureOf(o).quotaRefusal).toBeUndefined();
      expect(failureOf(o).safeMessage).toContain("work_report contract");
    });
  }

  // The third review's shape: a retry limit, then Claude's own typed API
  // failure as the try's terminal with no agent work between them.
  const tooOldResult = frames("signals/vendor-cli-too-old-2.1.288.jsonl").find(
    (frame) => frame["type"] === "result",
  )!;
  const apiFailure = (status: number) => ({
    ...tooOldResult,
    api_error_status: status,
    api_error_code: undefined,
    api_error: status === 401 ? "authentication_error" : "rate_limit_error",
    result:
      status === 401
        ? 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}'
        : 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
  });
  const nativeEnd = (emit: Emit, raw: Record<string, unknown>[], tail: HarnessEvent[] = []) =>
    withClaudeVendorFailure(
      (async function* () {
        yield* claude(emit, raw);
        yield* tail;
        yield emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
      })(),
    );
  for (const retry of [overload, apiRetry]) {
    it(`a Plan ${retry === overload ? "overload" : "rate-limit"} retry then Claude's HTTP 401 keeps the authentication terminal`, async () => {
      const o = await pinnedPlan((emit) => nativeEnd(emit, [retry, apiFailure(401)]));
      expect(o.spawns.map((spawn) => spawn.profile)).toEqual(["a"]);
      const failure = failureOf(o);
      expect(failure.phase).toBe("harness");
      expect(failure.code).not.toBe("subscription_window_exhausted");
      expect(failure.quotaRefusal).toBeUndefined();
      expect(failure.resetsAt).toBeNull();
      expect(failure.vendorFailure).toMatchObject({ source: "claude_stdout" });
    });
  }

  it("a pinned Plan's Claude HTTP 401 without a retry stays a harness failure", async () => {
    const o = await pinnedPlan((emit) => nativeEnd(emit, [apiFailure(401)]));
    expect(failureOf(o).phase).toBe("harness");
    expect(failureOf(o).quotaRefusal).toBeUndefined();
  });

  it("a Plan retry limit ending in Claude's own HTTP 429 stays a typed provider limit", async () => {
    const o = await pinnedPlan((emit) => nativeEnd(emit, [apiRetry, apiFailure(429)]));
    expect(o.spawns.map((spawn) => spawn.profile)).toEqual(["a"]);
    expect(failureOf(o)).toMatchObject(providerLimit(null, null));
  });

  it("a limit renewed after Claude's HTTP 401 keeps the renewed window", async () => {
    const o = await pinnedPlan((emit) =>
      nativeEnd(emit, [overload, apiFailure(401)], namedLimit(emit, "weekly", LATER).slice(0, 2)),
    );
    expect(failureOf(o)).toMatchObject(providerLimit("weekly", LATER));
  });

  it("a pinned Plan limit followed by the vendor's limit prose as a message stays typed", async () => {
    const o = await pinnedPlan((emit) => [
      ...namedLimit(emit, "five_hour").slice(0, 1),
      emit({ type: "message", text: "You've hit your usage limit." }),
      emit({ type: "error", error: "usage limit reached" }),
      emit({ type: "completed" }),
    ]);
    expect(o.spawns.map((spawn) => spawn.profile)).toEqual(["a"]);
    expect(failureOf(o)).toMatchObject(providerLimit("five_hour"));
  });

  it("a Plan whose Claude retry recovered and finished stays a success", async () => {
    const o = await pinnedPlan((emit) => [
      ...claude(emit, [apiRetry]),
      emit({ type: "message", text: "1. Build the dashboard", final: true }),
      emit({ type: "completed" }),
    ]);
    expect(o.result.lifecycle).toBe("succeeded");
  });
});
