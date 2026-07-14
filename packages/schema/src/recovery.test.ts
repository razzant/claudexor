import { describe, expect, it } from "vitest";
import {
  ControlJournalInspection,
  ControlJournalQuarantineRequest,
  ControlJournalValidation,
  ControlProblem,
} from "./index.js";

const fingerprint = "a".repeat(64);
const recoveryInspection = {
  schemaVersion: 1 as const,
  partition: "global" as const,
  generation: 0,
  status: "recovery_required" as const,
  recovery: {
    status: "recovery_required" as const,
    location: { kind: "byte" as const, byteOffset: 11 },
    reason: "unsafe operation metadata",
    discardedTailBytes: 0,
  },
  fingerprint,
  observedAt: "2026-07-14T00:00:00.000Z",
  evidenceRefs: [`recovery:global:${fingerprint}`],
};

describe("recovery and control problem contracts", () => {
  it("represents a recovery state before any journal generation could open", () => {
    expect(ControlJournalInspection.parse(recoveryInspection).generation).toBe(0);
  });

  it("refuses contradictory inspection and validation states", () => {
    expect(
      ControlJournalInspection.safeParse({ ...recoveryInspection, status: "ready" }).success,
    ).toBe(false);
    expect(
      ControlJournalValidation.safeParse({
        ...recoveryInspection,
        status: "ready",
        projectionStatus: [],
      }).success,
    ).toBe(false);
  });

  it("keeps quarantine confirmation and fingerprint strict", () => {
    expect(
      ControlJournalQuarantineRequest.safeParse({
        expectedFingerprint: fingerprint,
        confirmation: "quarantine_and_start_fresh",
      }).success,
    ).toBe(true);
    expect(
      ControlJournalQuarantineRequest.safeParse({
        expectedFingerprint: fingerprint.toUpperCase(),
        confirmation: "quarantine_and_start_fresh",
      }).success,
    ).toBe(false);
    expect(
      ControlJournalQuarantineRequest.safeParse({
        expectedFingerprint: fingerprint,
        confirmation: "yes",
      }).success,
    ).toBe(false);
  });

  it("materializes every machine-readable problem field and rejects aliases", () => {
    expect(
      ControlProblem.parse({
        code: "journal_recovery_required",
        message: "inspect the partition",
        retryable: false,
      }),
    ).toEqual({
      code: "journal_recovery_required",
      message: "inspect the partition",
      retryable: false,
      fieldErrors: {},
      requiredActions: [],
      evidenceRefs: [],
    });
    expect(
      ControlProblem.safeParse({
        code: "bad",
        error: "legacy alias",
        message: "bad",
        retryable: false,
      }).success,
    ).toBe(false);
  });
});
