import { describe, expect, it } from "vitest";
import {
  buildContinuationPacket,
  CONTINUATION_ELIGIBLE_CAUSES,
  CONTINUATION_PACKET_SENTINEL,
  decideContinuation,
  synthesizeContinuationRequest,
} from "./continuation.js";

const eligibleBase = {
  contextExhausted: true,
  contextExhaustedCause: "repeated_refill" as const,
  workStateCompleted: false,
  continuationCount: 0,
  runKind: "read_only" as const,
};

describe("decideContinuation (D-16d eligibility)", () => {
  it("eligible: repeated_refill exhaustion, no completed report, first try, read-only", () => {
    expect(decideContinuation(eligibleBase)).toEqual({ eligible: true, reason: "eligible" });
  });

  it("prompt_too_long is NOT eligible (the packet may be irreducible)", () => {
    const d = decideContinuation({ ...eligibleBase, contextExhaustedCause: "prompt_too_long" });
    expect(d.eligible).toBe(false);
    expect(d.reason).toMatch(/prompt_too_long is not continuation-eligible/);
    // Guard the eligible-set membership directly too.
    expect(CONTINUATION_ELIGIBLE_CAUSES.has("prompt_too_long")).toBe(false);
    expect(CONTINUATION_ELIGIBLE_CAUSES.has("repeated_refill")).toBe(true);
  });

  it("not eligible without a terminal exhaustion", () => {
    expect(decideContinuation({ ...eligibleBase, contextExhausted: false }).eligible).toBe(false);
  });

  it("not eligible when a completed WorkReport was produced", () => {
    const d = decideContinuation({ ...eligibleBase, workStateCompleted: true });
    expect(d.eligible).toBe(false);
    expect(d.reason).toMatch(/completed WorkReport/);
  });

  it("strictly one-shot: a prior continuation blocks another", () => {
    const d = decideContinuation({ ...eligibleBase, continuationCount: 1 });
    expect(d.eligible).toBe(false);
    expect(d.reason).toMatch(/one-shot/);
  });

  it("in-place runs are excluded", () => {
    const d = decideContinuation({ ...eligibleBase, runKind: "in_place" });
    expect(d.eligible).toBe(false);
    expect(d.reason).toMatch(/in-place/);
  });

  it("enveloped runs are eligible (not just read-only)", () => {
    expect(decideContinuation({ ...eligibleBase, runKind: "enveloped" }).eligible).toBe(true);
  });

  it("a null/unknown cause is not eligible", () => {
    expect(decideContinuation({ ...eligibleBase, contextExhaustedCause: null }).eligible).toBe(
      false,
    );
  });
});

describe("synthesizeContinuationRequest / buildContinuationPacket", () => {
  it("always requests a FRESH session (nativeResumeAvailable:false)", () => {
    const req = synthesizeContinuationRequest({
      harness: "claude",
      profileId: "p1",
      priorPrompt: "do the migration",
      priorOutput: "partial work before exhaustion",
    });
    expect(req.nativeResumeAvailable).toBe(false);
    expect(req.lane).toEqual({ harness: "claude", profileId: "p1" });
    expect(req.priorTurns).toHaveLength(1);
    expect(req.priorTurns[0]?.outputText).toContain("partial work");
  });

  it("builds a mechanical checkpoint packet whose pointer carries the sentinel", () => {
    const req = synthesizeContinuationRequest({
      harness: "claude",
      profileId: null,
      priorPrompt: "do the migration",
      priorOutput: "partial work before exhaustion",
    });
    const packet = buildContinuationPacket(req);
    expect(packet.pointerLine).toContain(CONTINUATION_PACKET_SENTINEL);
    expect(packet.continuity.disclosure.kind).toBe("packet");
    expect(packet.continuity.disclosure.packetTurns).toBe(1);
    expect(packet.continuity.packetMarkdown).toBeTruthy();
  });
});
