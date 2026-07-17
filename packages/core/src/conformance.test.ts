import { describe, expect, it } from "vitest";
import { streamExpectationViolations } from "./conformance.js";

const ts = "2026-07-17T00:00:00.000Z";
const session = "ses-1";
const message = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  session_id: session,
  ts,
  text,
  ...extra,
});

/**
 * The expectation checker is the ONE owner every adapter's conformance test
 * asserts through (W3.8), so its own semantics need pins — a hole here is
 * invisible in all four harness suites at once.
 */
describe("streamExpectationViolations", () => {
  it("counts the typed final and reports it as the last message", () => {
    const events = [message("narrating"), message("the answer", { final: true })];
    expect(
      streamExpectationViolations(events, { final_messages: 1, final_is_last_message: true }),
    ).toEqual([]);
  });

  it("a display delta AFTER the final means the final was not the last word", () => {
    // Counts alone cannot see this: one final, one delta, both as declared —
    // only the position moved (triad round 2, sol #1).
    const events = [
      message("chunk", { payload: { delta: true } }),
      message("the answer", { final: true }),
      message("late chunk", { payload: { delta: true } }),
    ];
    expect(
      streamExpectationViolations(events, {
        final_messages: 1,
        delta_messages: 2,
        final_is_last_message: true,
      }),
    ).toEqual(["final_is_last_message: expected true, got false"]);
  });

  it("a markerless stream honestly declares no final", () => {
    const events = [message("part one"), message("part two")];
    expect(
      streamExpectationViolations(events, { final_messages: 0, final_is_last_message: false }),
    ).toEqual([]);
  });

  it("retry_class asserts the CLASS, not the mere presence of a signal", () => {
    const withCategory = [
      {
        type: "status",
        session_id: session,
        ts,
        status: { kind: "api_retry", error_category: "overloaded" },
      },
    ];
    // Declared rate_limit, but the stream classified it overloaded.
    expect(streamExpectationViolations(withCategory, { retry_class: "rate_limit" })).toEqual([
      "retry_class: expected rate_limit, got [overloaded]",
    ]);
    expect(streamExpectationViolations(withCategory, { retry_class: "overloaded" })).toEqual([]);
  });

  it("retry_class is not a restatement of typed_rate_limit", () => {
    // A rate_limit signal alone carries no classification: deriving one from
    // its presence would make retry_class true exactly when typed_rate_limit
    // is, and unable to fail on its own (triad round 2, fable #1).
    const limited = [{ type: "status", session_id: session, ts, rate_limit: { resets_at: ts } }];
    expect(streamExpectationViolations(limited, { typed_rate_limit: true })).toEqual([]);
    expect(streamExpectationViolations(limited, { retry_class: "rate_limit" })).toEqual([
      "retry_class: expected rate_limit, got [none]",
    ]);
  });
});
