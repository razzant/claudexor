import { describe, expect, it } from "vitest";
import {
  REQUIRED_SCOPE_MODEL,
  REQUIRED_TRIAD_MODELS,
  TRIAD_ITEMS,
  completionTermination,
  exactPanelMatch,
  releaseReviewDecision,
  validateChecklistResponse,
} from "../../../scripts/lib/release-review-contract.mjs";

function cleanRows() {
  return TRIAD_ITEMS.map((item) => ({
    item,
    verdict: "PASS",
    severity: "advisory",
    reason: `${item} checked`,
  }));
}

describe("release review fail-closed contract", () => {
  it("accepts only the exact ordered model panel", () => {
    expect(exactPanelMatch(REQUIRED_TRIAD_MODELS, REQUIRED_SCOPE_MODEL)).toBe(true);
    expect(exactPanelMatch([...REQUIRED_TRIAD_MODELS].reverse(), REQUIRED_SCOPE_MODEL)).toBe(false);
    expect(exactPanelMatch(REQUIRED_TRIAD_MODELS, "anthropic/nearest-model")).toBe(false);
    expect(exactPanelMatch(REQUIRED_TRIAD_MODELS.slice(0, 2), REQUIRED_SCOPE_MODEL)).toBe(false);
  });

  it.each([null, "length", "max_tokens", "tool_calls"])(
    "rejects non-terminal or truncated finish reason %s",
    (finishReason) => {
      expect(completionTermination(finishReason).complete).toBe(false);
    },
  );

  it("accepts only the terminal stop finish reason", () => {
    expect(completionTermination("stop")).toEqual({ complete: true, error: null });
  });

  it.each([
    ["empty array", []],
    ["malformed row", [{ item: "review_protocol", verdict: "PASS" }]],
    ["unknown checklist item", [{ item: "not_a_check", verdict: "PASS", severity: "advisory", reason: "x" }]],
  ])("makes %s quorum-unusable", (_name, value) => {
    expect(validateChecklistResponse(value, "model", TRIAD_ITEMS).status).not.toBe("responded");
  });

  it("makes a missing checklist item partial rather than silently clean", () => {
    const result = validateChecklistResponse(cleanRows().slice(0, 2), "model", TRIAD_ITEMS);
    expect(result.status).toBe("partial");
    expect(result.missingItems).toEqual(["security_and_secrets"]);
  });

  it("passes only complete PASS responses from quorum plus scope", () => {
    const findings = validateChecklistResponse(cleanRows(), "model", TRIAD_ITEMS).findings;
    expect(releaseReviewDecision({
      triadActors: [
        { status: "responded", findings },
        { status: "responded", findings },
        { status: "timed_out" },
      ],
      scope: { status: "responded", findings: [] },
    }).passed).toBe(true);
  });

  it("fails closed on any FAIL verdict even when quorum and scope are healthy", () => {
    const rows = cleanRows();
    rows[1] = { ...rows[1]!, verdict: "FAIL", severity: "advisory", reason: "concrete issue" };
    const findings = validateChecklistResponse(rows, "model", TRIAD_ITEMS).findings;
    const decision = releaseReviewDecision({
      triadActors: [
        { status: "responded", findings },
        { status: "responded", findings: validateChecklistResponse(cleanRows(), "other", TRIAD_ITEMS).findings },
      ],
      scope: { status: "responded", findings: [] },
    });
    expect(decision.passed).toBe(false);
    expect(decision.blockingFindings).toHaveLength(1);
    expect(decision.reasons[0]).toContain("FAIL");
  });
});
