import { describe, expect, it } from "vitest";
import {
  attemptTelemetryRecord,
  classifyAdapterThrow,
  createAttemptTelemetry,
  observeAttemptTelemetry,
} from "./attemptTelemetry.js";
import { RunTelemetry, type HarnessEvent } from "@claudexor/schema";

// GH #31: the typed harness-failure taxonomy classifies every adapter/stream
// transient failure at the adapter→orchestrator boundary. These tests pin the
// classification (timeout, rate_limited ±Retry-After, auth, signal-kill, config)
// and the `retryable` verdict the centralized retry policy reads.

const ts = "2026-07-23T00:00:00.000Z";

function ev(partial: Record<string, unknown> & { type: string }): HarnessEvent {
  return { session_id: "s", ts, ...partial } as unknown as HarnessEvent;
}

function fresh() {
  return createAttemptTelemetry("auto", false);
}

describe("transient failure taxonomy (GH #31)", () => {
  it("classifies a typed transient timeout as timeout (retryable)", () => {
    const t = fresh();
    observeAttemptTelemetry(t, ev({ type: "status", transient: { kind: "timeout" } }));
    expect(t.transientFailures).toHaveLength(1);
    expect(t.transientFailures[0]?.category).toBe("timeout");
    expect(t.transientFailures[0]?.retryable).toBe(true);
  });

  it("classifies a generic transient (network) as unknown_harness_error (retryable)", () => {
    const t = fresh();
    observeAttemptTelemetry(t, ev({ type: "status", transient: { kind: "network" } }));
    expect(t.transientFailures[0]?.category).toBe("unknown_harness_error");
    expect(t.transientFailures[0]?.retryable).toBe(true);
  });

  it("classifies a rate_limit signal as rate_limited AND records it as a transient (not only in rateLimits)", () => {
    const t = fresh();
    observeAttemptTelemetry(t, ev({ type: "status", rate_limit: { retry_delay_ms: 4000 } }));
    // Rate limits still feed the W5.4 rotation predicate…
    expect(t.rateLimits).toHaveLength(1);
    // …AND now also land as a first-class transient failure (GH #31).
    expect(t.transientFailures).toHaveLength(1);
    expect(t.transientFailures[0]?.category).toBe("rate_limited");
    expect(t.transientFailures[0]?.retryable).toBe(true);
    expect(t.transientFailures[0]?.retryDelayMs).toBe(4000);
  });

  it("a cursor-shaped A1 vendor-limit ERROR event arms the rotation predicate (rateLimits grows)", () => {
    // Exact shape harness-cursor emits since A1 for the live incident stderr
    // ("ActionRequiredError: You've hit your usage limit… resets … 9/12/2026"):
    // a terminal error event carrying the typed rate_limit signal, model-scoped
    // to the requested model, resets_at honestly null (day-granular vendor
    // date rides as payload evidence only).
    const t = fresh();
    observeAttemptTelemetry(
      t,
      ev({
        type: "error",
        error: "ActionRequiredError: You've hit your usage limit",
        rate_limit: {
          resets_at: null,
          retry_delay_ms: null,
          applies_to_models: ["gemini-3.7-flash-high"],
        },
        status: { kind: "api_retry", error_category: "rate_limit" },
        payload: { cursor_vendor_limit: true, vendor_reset_day: "2026-09-12" },
      }),
    );
    // Feeds the W5.4 reactive-rotation predicate (sawTypedLimit)…
    expect(t.rateLimits).toHaveLength(1);
    expect(t.rateLimits[0]?.resetsAt).toBeNull();
    // …and lands exactly ONE transient observation (rate_limit error_category
    // is deliberately NOT double-counted through classifyStatusError).
    expect(t.transientFailures).toHaveLength(1);
    expect(t.transientFailures[0]?.category).toBe("rate_limited");
  });

  it("a claude-shaped A1 entitlement status classifies capability_refused (NOT retryable)", () => {
    // Exact shape harness-claude emits since A1 for the org-disabled plain
    // prose ("Your organization has disabled Claude subscription access…").
    const t = fresh();
    observeAttemptTelemetry(
      t,
      ev({
        type: "status",
        text: "entitlement: Your organization has disabled Claude subscription access for Claude Code",
        status: { kind: "api_retry", error_category: "oauth_org_not_allowed" },
        payload: { entitlement_denied: true },
      }),
    );
    expect(t.transientFailures).toHaveLength(1);
    expect(t.transientFailures[0]?.category).toBe("capability_refused");
    expect(t.transientFailures[0]?.retryable).toBe(false);
    expect(t.rateLimits).toHaveLength(0);
  });

  it("rate_limited classification is stable with OR without a Retry-After (delay preserved when present)", () => {
    const withDelay = fresh();
    observeAttemptTelemetry(
      withDelay,
      ev({ type: "status", rate_limit: { retry_delay_ms: 2500 } }),
    );
    const noDelay = fresh();
    observeAttemptTelemetry(noDelay, ev({ type: "status", rate_limit: {} }));
    expect(withDelay.transientFailures[0]?.category).toBe("rate_limited");
    expect(noDelay.transientFailures[0]?.category).toBe("rate_limited");
    expect(withDelay.transientFailures[0]?.retryDelayMs).toBe(2500);
    expect(noDelay.transientFailures[0]?.retryDelayMs).toBe(null);
  });

  it("classifies a vendor authentication_failed status as auth_failed (NOT retryable) and preserves the adapter code", () => {
    const t = fresh();
    observeAttemptTelemetry(
      t,
      ev({
        type: "status",
        status: { kind: "api_retry", error_category: "authentication_failed" },
      }),
    );
    expect(t.transientFailures[0]?.category).toBe("auth_failed");
    expect(t.transientFailures[0]?.retryable).toBe(false);
    expect(t.transientFailures[0]?.adapterCode).toBe("authentication_failed");
  });

  it("persists a normalized fractional-vendor delay through final telemetry", () => {
    const t = fresh();
    observeAttemptTelemetry(
      t,
      ev({
        type: "status",
        status: {
          kind: "api_retry",
          error_category: "authentication_failed",
          retry_delay_ms: 573,
        },
      }),
    );
    const attempt = attemptTelemetryRecord("a01", "claude", t);
    expect(attempt.transient_failures[0]?.retry_delay_ms).toBe(573);
    expect(() =>
      RunTelemetry.parse({
        schema_version: 2,
        run_id: "run-fractional-final",
        task_id: "task-fractional-final",
        mode: "ask",
        requested_access: "readonly",
        effective_access: "readonly",
        external_context_policy: "auto",
        effective_web_mode: "auto",
        web_required: false,
        web: {},
        attempts: [attempt],
        final_attempt_id: "a01",
        generated_at: "2026-07-28T00:00:00Z",
      }),
    ).not.toThrow();
  });

  it("classifies invalid_request as config_error and model_not_found as capability_refused (both non-retryable)", () => {
    const cfg = fresh();
    observeAttemptTelemetry(
      cfg,
      ev({ type: "status", status: { kind: "api_retry", error_category: "invalid_request" } }),
    );
    expect(cfg.transientFailures[0]?.category).toBe("config_error");
    expect(cfg.transientFailures[0]?.retryable).toBe(false);

    const cap = fresh();
    observeAttemptTelemetry(
      cap,
      ev({ type: "status", status: { kind: "api_retry", error_category: "model_not_found" } }),
    );
    expect(cap.transientFailures[0]?.category).toBe("capability_refused");
    expect(cap.transientFailures[0]?.retryable).toBe(false);
  });

  it("does NOT surface vendor-driven overloaded/server_error retries as our failures", () => {
    const t = fresh();
    observeAttemptTelemetry(
      t,
      ev({ type: "status", status: { kind: "api_retry", error_category: "overloaded" } }),
    );
    expect(t.transientFailures).toHaveLength(0);
  });

  it("classifies a non-aborted signal kill as process_crash and preserves the signal", () => {
    const t = fresh();
    observeAttemptTelemetry(t, ev({ type: "completed", payload: { exit_signal: "SIGKILL" } }));
    expect(t.transientFailures[0]?.category).toBe("process_crash");
    expect(t.transientFailures[0]?.signal).toBe("SIGKILL");
    // A crashed child is settled, not auto-replayed here.
    expect(t.transientFailures[0]?.retryable).toBe(false);
  });

  it("classifies a spawn failure as config_error, and an aborted completion as neither", () => {
    const spawn = fresh();
    observeAttemptTelemetry(spawn, ev({ type: "completed", payload: { spawn_failed: true } }));
    expect(spawn.transientFailures[0]?.category).toBe("config_error");

    // An aborted completion (our watchdog/cancel) is never a crash.
    const aborted = fresh();
    observeAttemptTelemetry(
      aborted,
      ev({ type: "completed", payload: { aborted: true, exit_signal: "SIGKILL" } }),
    );
    expect(aborted.transientFailures).toHaveLength(0);
  });

  it("classifyAdapterThrow maps the inactivity watchdog to timeout and any other throw to process_crash — neither auto-retried", () => {
    const timeout = classifyAdapterThrow({ errorName: "HarnessInactivityTimeoutError" });
    expect(timeout.category).toBe("timeout");
    expect(timeout.retryable).toBe(false);

    const crash = classifyAdapterThrow({ errorName: "TypeError" });
    expect(crash.category).toBe("process_crash");
    expect(crash.retryable).toBe(false);
  });

  it("serializes the typed category/retryable/metadata onto the attempt telemetry record", () => {
    const t = fresh();
    observeAttemptTelemetry(
      t,
      ev({
        type: "status",
        status: { kind: "api_retry", error_category: "authentication_failed" },
      }),
    );
    const record = attemptTelemetryRecord("a01", "codex", t);
    expect(record.transient_failures[0]?.category).toBe("auth_failed");
    expect(record.transient_failures[0]?.retryable).toBe(false);
    expect(record.transient_failures[0]?.adapter_code).toBe("authentication_failed");
  });
});

// A harness that VOICED its own error and then exited non-zero did not crash.
// The relabel is behaviour-neutral: exit evidence never becomes a retry signal
// (the explicit `retryable: false` in classifyCompletedCrash — `unknown_harness_error`
// is `true` in the category table, so removing that override turns these red),
// and the vendor's code is opaque evidence that feeds no other telemetry input.
describe("harness-reported terminal error (exit evidence)", () => {
  const vendorFailure = {
    code: "server_overloaded",
    message: "Selected model is at capacity. Please try a different model.",
    source: "codex_rollout",
  };
  const completed = (payload: Record<string, unknown>) => {
    const t = fresh();
    observeAttemptTelemetry(t, ev({ type: "completed", payload }));
    return t;
  };

  it("labels a voiced non-zero exit unknown_harness_error, never retryable, exit code preserved", () => {
    const t = completed({ exit_code: 1, harness_reported_error: true });
    expect(t.transientFailures).toHaveLength(1);
    expect(t.transientFailures[0]?.category).toBe("unknown_harness_error");
    expect(t.transientFailures[0]?.retryable).toBe(false);
    expect(t.transientFailures[0]?.adapterCode).toBe("exit_1");
    expect(t.vendorFailure).toBeNull();
  });

  it("carries the adapter-attached vendor failure as the try's evidence, verbatim", () => {
    const t = completed({
      exit_code: 1,
      harness_reported_error: true,
      vendor_failure: vendorFailure,
    });
    expect(t.vendorFailure).toEqual(vendorFailure);
    expect(t.transientFailures[0]?.category).toBe("unknown_harness_error");
  });

  it("#414: keeps the vendor failure of a voiced completion with NO exit evidence, deciding nothing", () => {
    const t = completed({ harness_reported_error: true, vendor_failure: vendorFailure });
    expect(t.vendorFailure).toEqual(vendorFailure);
    expect(t.transientFailures).toHaveLength(0);
    expect(t.rateLimits).toHaveLength(0);
  });

  it("#414: a signal kill, a cancel or an unvoiced completion carries no vendor evidence", () => {
    for (const payload of [
      { exit_signal: "SIGKILL", harness_reported_error: true, vendor_failure: vendorFailure },
      { aborted: true, harness_reported_error: true, vendor_failure: vendorFailure },
      { exit_code: 1, vendor_failure: vendorFailure },
    ])
      expect(completed(payload).vendorFailure, JSON.stringify(payload)).toBeNull();
  });

  it("keeps a SILENT non-zero exit a process_crash (unchanged)", () => {
    const t = completed({ exit_code: 1 });
    expect(t.transientFailures[0]?.category).toBe("process_crash");
    expect(t.transientFailures[0]?.retryable).toBe(false);
    expect(t.transientFailures[0]?.adapterCode).toBe("exit_1");
  });

  it("keeps a signal kill a process_crash whatever the harness said before it", () => {
    const t = completed({ exit_signal: "SIGKILL", harness_reported_error: true });
    expect(t.transientFailures[0]?.category).toBe("process_crash");
    expect(t.transientFailures[0]?.signal).toBe("SIGKILL");
    expect(t.transientFailures[0]?.retryable).toBe(false);
  });

  it("classifies nothing for an aborted or a clean completion, voiced or not", () => {
    expect(
      completed({ aborted: true, exit_code: 1, harness_reported_error: true }).transientFailures,
    ).toHaveLength(0);
    expect(
      completed({ exit_code: 0, harness_reported_error: true }).transientFailures,
    ).toHaveLength(0);
  });

  it("drops a malformed vendor_failure to null without changing the classification", () => {
    for (const bad of [
      42,
      "server_overloaded",
      { code: "x".repeat(129), source: "codex_rollout" },
    ]) {
      const t = completed({ exit_code: 1, harness_reported_error: true, vendor_failure: bad });
      expect(t.transientFailures).toHaveLength(1);
      expect(t.transientFailures[0]?.category).toBe("unknown_harness_error");
      expect(t.transientFailures[0]?.retryable).toBe(false);
      expect(t.vendorFailure).toBeNull();
    }
  });

  it("never retries on exit evidence: every exit payload shape is retryable:false", () => {
    const shapes: Record<string, unknown>[] = [
      { exit_code: 1 },
      { exit_code: 1, harness_reported_error: true },
      { exit_code: 1, harness_reported_error: true, vendor_failure: vendorFailure },
      { exit_signal: "SIGKILL" },
      { exit_signal: "SIGKILL", harness_reported_error: true },
      { spawn_failed: true },
    ];
    for (const payload of shapes) {
      const t = completed(payload);
      expect(t.transientFailures, JSON.stringify(payload)).toHaveLength(1);
      expect(t.transientFailures[0]?.retryable, JSON.stringify(payload)).toBe(false);
    }
  });

  it("a vendor code that NAMES a limit feeds no rate-limit input and adds no second observation", () => {
    const t = completed({
      exit_code: 1,
      harness_reported_error: true,
      vendor_failure: { ...vendorFailure, code: "usage_limit_exceeded" },
    });
    expect(t.rateLimits).toHaveLength(0);
    expect(t.transientFailures).toHaveLength(1);
    expect(t.transientFailures[0]?.category).toBe("unknown_harness_error");
  });

  it("keeps the vendor failure OUT of the persisted attempt telemetry record", () => {
    const t = completed({
      exit_code: 1,
      harness_reported_error: true,
      vendor_failure: vendorFailure,
    });
    const record = attemptTelemetryRecord("a01", "codex", t);
    expect(record.transient_failures[0]?.category).toBe("unknown_harness_error");
    expect(JSON.stringify(record)).not.toContain("server_overloaded");
    expect(record.transient_failures[0]).not.toHaveProperty("vendorFailure");
  });
});
