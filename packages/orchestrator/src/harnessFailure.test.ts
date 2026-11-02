import { describe, expect, it } from "vitest";
import { attemptVendorFailure, harnessFailureNextActions } from "./harnessFailure.js";
import { classifyCompletedCrash, type TransientFailureObservation } from "./transientClassify.js";
import { createAttemptTelemetry, observeAttemptTelemetry } from "./attemptTelemetry.js";
import { beginNativeRetry } from "./native-retry-telemetry.js";

const overloaded = { code: "server_overloaded", message: "at capacity", source: "codex_rollout" };
const limited = { code: "usage_limit_exceeded", message: "limit", source: "codex_rollout" };

function voiced(vendor_failure?: unknown): TransientFailureObservation {
  const obs = classifyCompletedCrash({
    exit_code: 1,
    harness_reported_error: true,
    ...(vendor_failure === undefined ? {} : { vendor_failure }),
  });
  if (!obs) throw new Error("expected an exit observation");
  return obs;
}

/** One try's completion: a voiced exit, or (#414) a voiced app-server turn with no exit evidence. */
const exitTry = (vendor_failure?: unknown) => ({
  exit_code: 1,
  harness_reported_error: true,
  ...(vendor_failure === undefined ? {} : { vendor_failure }),
});
const appServerTry = (vendor_failure?: unknown) => ({
  harness_reported_error: true,
  ...(vendor_failure === undefined ? {} : { vendor_failure }),
});

/** An attempt's real telemetry after its tries settled in order (A3 per-try reset between them). */
const attempt = (attemptId: string, tries: Record<string, unknown>[]) => {
  const telemetry = createAttemptTelemetry("off", false);
  tries.forEach((payload, index) => {
    if (index > 0) beginNativeRetry(telemetry);
    observeAttemptTelemetry(telemetry, {
      type: "completed",
      session_id: `s${index}`,
      ts: "2026-10-29T21:02:44.000Z",
      payload,
    });
  });
  return { attemptId, telemetry };
};

describe("harnessFailureNextActions", () => {
  it("never says 'crash' for a harness that reported its own error", () => {
    const category = voiced().category;
    expect(category).toBe("unknown_harness_error");
    const actions = harnessFailureNextActions(category);
    expect(actions).toEqual(["Open diagnostics", "Retry the run"]);
    expect(actions.join(" ")).not.toMatch(/crash/i);
  });

  it("keeps the crash guidance byte-identical for a real crash", () => {
    const crash = classifyCompletedCrash({ exit_signal: "SIGKILL", harness_reported_error: true });
    expect(harnessFailureNextActions(crash?.category ?? null)).toEqual([
      "The harness process crashed; open diagnostics for the exit detail",
      "Retry the run",
    ]);
    const silent = classifyCompletedCrash({ exit_code: 1 });
    expect(harnessFailureNextActions(silent?.category ?? null)[0]).toBe(
      "The harness process crashed; open diagnostics for the exit detail",
    );
  });
});

describe("attemptVendorFailure", () => {
  it.each([
    ["a voiced exit", exitTry],
    ["a voiced app-server turn without exit evidence (#414)", appServerTry],
  ])("returns the named attempt's vendor failure (%s)", (_name, tryOf) => {
    const attempts = [attempt("a01", [tryOf(overloaded)]), attempt("a02", [tryOf(limited)])];
    expect(attemptVendorFailure(attempts, "a01")).toEqual(overloaded);
    expect(attemptVendorFailure(attempts, "a02")).toEqual(limited);
  });

  it("falls back to the last attempt when no attempt is named or the name is unknown", () => {
    const attempts = [
      attempt("a01", [exitTry(overloaded)]),
      attempt("a02", [appServerTry(limited)]),
    ];
    expect(attemptVendorFailure(attempts, undefined)).toEqual(limited);
    expect(attemptVendorFailure(attempts, null)).toEqual(limited);
    expect(attemptVendorFailure(attempts, "a99")).toEqual(limited);
  });

  it("speaks only for the attempt's LAST try: an earlier try's evidence is never borrowed", () => {
    // Try A (before a profile rotation) had vendor evidence; the last try died without any.
    const rotated = [attempt("a01", [exitTry(overloaded), appServerTry(limited), appServerTry()])];
    expect(attemptVendorFailure(rotated, "a01")).toBeNull();
    // A later signal kill or cancel is never explained by an earlier try's cause.
    for (const later of [
      { exit_signal: "SIGKILL", harness_reported_error: true },
      { aborted: true, harness_reported_error: true },
    ])
      expect(
        attemptVendorFailure([attempt("a01", [appServerTry(limited), later])], "a01"),
      ).toBeNull();
    // The still-working direction: when the last try carries evidence, it is the one returned.
    const last = [attempt("a01", [exitTry(overloaded), exitTry(), appServerTry(limited)])];
    expect(attemptVendorFailure(last, "a01")).toEqual(limited);
  });

  it("is null when the named attempt carries none — never borrowed from another attempt", () => {
    const attempts = [attempt("a01", [exitTry(overloaded)]), attempt("a02", [exitTry()])];
    expect(attemptVendorFailure(attempts, "a02")).toBeNull();
    expect(attemptVendorFailure([attempt("a01", [])], "a01")).toBeNull();
    expect(attemptVendorFailure([], "a01")).toBeNull();
  });
});
