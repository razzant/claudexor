import { describe, expect, it } from "vitest";
import {
  createAttemptTelemetry,
  observeAttemptTelemetry,
  attemptTelemetryRecord,
} from "./attemptTelemetry.js";
import type { HarnessEvent, ProcessingReceipt } from "@claudexor/schema";

const receipt = (observed: ProcessingReceipt["observed"]): ProcessingReceipt => ({
  requested: "fast",
  submitted: "fast",
  submittedNative: "priority",
  observed,
  observedNative: observed === "unknown" ? [] : [observed],
  reason: null,
  source: "fixture.provider-usage",
});
const event = (type: HarnessEvent["type"], processing?: ProcessingReceipt): HarnessEvent => ({
  type,
  ts: "2026-09-13T00:00:00Z",
  session_id: "s",
  ...(processing ? { processing } : {}),
});
describe("persisted processing observations", () => {
  it("keeps submission unknown until the provider reports execution", () => {
    const t = createAttemptTelemetry("auto", false);
    observeAttemptTelemetry(t, event("started", receipt("unknown")));
    expect(attemptTelemetryRecord("a", "codex", t).processing?.observed).toBe("unknown");
    observeAttemptTelemetry(t, event("completed", receipt("standard")));
    expect(attemptTelemetryRecord("a", "codex", t).processing).toMatchObject({
      requested: "fast",
      submitted: "fast",
      observed: "standard",
    });
  });
  it("preserves mixed native retry intervals instead of replacing the first one", () => {
    const t = createAttemptTelemetry("auto", false);
    for (const mode of ["fast", "standard"] as const) {
      observeAttemptTelemetry(t, event("started", receipt("unknown")));
      observeAttemptTelemetry(t, event("completed", receipt(mode)));
    }
    expect(attemptTelemetryRecord("a", "claude", t).processing).toMatchObject({
      observed: "mixed",
      observedNative: ["fast", "standard"],
    });
  });
  it("a retry missing service evidence makes the overall service unknown", () => {
    const t = createAttemptTelemetry("auto", false);
    observeAttemptTelemetry(t, event("started", receipt("unknown")));
    observeAttemptTelemetry(t, event("completed", receipt("fast")));
    observeAttemptTelemetry(t, event("started"));
    observeAttemptTelemetry(t, event("completed"));
    expect(attemptTelemetryRecord("a", "cursor", t).processing?.observed).toBe("unknown");
  });
});

it("keeps each native invocation's program and the authoritative startup version", () => {
  const t = createAttemptTelemetry("auto", false);
  const probe = { path: "/vendor/tool", version: "1.0.0", versionSource: "version_probe" as const };
  const stream = { ...probe, version: "2.0.0", versionSource: "vendor_stream" as const };
  observeAttemptTelemetry(t, { ...event("started"), program: probe });
  observeAttemptTelemetry(t, { ...event("status"), program: stream });
  observeAttemptTelemetry(t, { ...event("completed"), program: stream });
  const next = { ...probe, path: "/vendor/new", version: "3.0.0" };
  observeAttemptTelemetry(t, { ...event("started"), program: next });
  observeAttemptTelemetry(t, { ...event("completed"), program: next });
  expect(attemptTelemetryRecord("a", "codex", t).programs).toEqual([stream, next]);
});
