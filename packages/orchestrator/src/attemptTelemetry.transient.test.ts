import { describe, expect, it } from "vitest";
import {
  attemptTelemetryRecord,
  classifyAdapterThrow,
  createAttemptTelemetry,
  observeAttemptTelemetry,
} from "./attemptTelemetry.js";
import type { HarnessEvent } from "@claudexor/schema";

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
