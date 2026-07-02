import { describe, expect, it } from "vitest";
import { ReviewFinding } from "@claudexor/schema";
import { dedupeFindings, extractJsonBlocks, parseFindingsDetailed } from "./findings.js";

describe("extractJsonBlocks", () => {
  it("accepts a final bare JSON array after explanatory reviewer text", () => {
    expect(
      extractJsonBlocks(
        ["I inspected the evidence packet and found no legitimate defects.", "", "[]"].join("\n"),
      ),
    ).toEqual([[]]);
  });

  it("accepts the last complete JSON block when transcript text follows it", () => {
    expect(
      extractJsonBlocks(`status before
[
  {"severity":"FIX_FIRST","category":"regression","claim":"retry inventory"}
]
duplicated transcript text after json`),
    ).toEqual([[{ severity: "FIX_FIRST", category: "regression", claim: "retry inventory" }]]);
  });

  it("accepts object-shaped review payloads", () => {
    expect(
      extractJsonBlocks(`status before
{"findings":[{"severity":"BLOCK","category":"regression","claim":"legacy object"}]}`),
    ).toEqual([
      { findings: [{ severity: "BLOCK", category: "regression", claim: "legacy object" }] },
    ]);
  });

  it("accepts a single finding object with surrounding reviewer text", () => {
    expect(
      extractJsonBlocks(`status before
{"severity":"FIX_FIRST","category":"regression","claim":"single finding with context"}
status after`),
    ).toEqual([
      { severity: "FIX_FIRST", category: "regression", claim: "single finding with context" },
    ]);
  });

  it("accepts a single finding object inside a json fence", () => {
    expect(
      extractJsonBlocks(`summary
\`\`\`json
{"severity":"BLOCK","category":"correctness","claim":"single fenced finding"}
\`\`\``),
    ).toEqual([
      { severity: "BLOCK", category: "correctness", claim: "single fenced finding" },
    ]);
  });

  it("prefers a later complete array over an earlier object-shaped example", () => {
    expect(
      extractJsonBlocks(`status before
{"findings":[{"severity":"BLOCK","category":"regression","claim":"legacy object"}]}
[
  {"severity":"WARN","category":"test_gap","claim":"array contract"}
]`),
    ).toEqual([[{ severity: "WARN", category: "test_gap", claim: "array contract" }]]);
  });
});

describe("parseFindingsDetailed", () => {
  it("parses object-wrapped and single-object finding payloads", () => {
    const wrapped = parseFindingsDetailed(
      `{"findings":[{"severity":"BLOCK","category":"regression","claim":"wrapped"}]}`,
      { harness_id: "r" },
    );
    expect(wrapped.findings).toHaveLength(1);
    expect(wrapped.findings[0]?.claim).toBe("wrapped");

    const single = parseFindingsDetailed(
      `{"severity":"WARN","category":"correctness","claim":"single"}`,
      { harness_id: "r" },
    );
    expect(single.findings).toHaveLength(1);
    expect(single.findings[0]?.claim).toBe("single");
  });
});

describe("dedupeFindings", () => {
  it("preserves separate insufficient-evidence diagnostics per reviewer", () => {
    const base = {
      id: "f-1",
      severity: "INSUFFICIENT_EVIDENCE",
      category: "correctness",
      claim: "Reviewer produced no parseable JSON findings.",
      evidence: { files: [], logs: [], commands: [], diff_hunks: [] },
      status: "insufficient_evidence",
    } satisfies Partial<ReviewFinding>;
    const findings = [
      ReviewFinding.parse({
        ...base,
        id: "f-1",
        reviewer: {
          harness_id: "claude",
          requested_model: null,
          requested_effort: null,
          observed_model: null,
          route_proof_status: "verified",
        },
      }),
      ReviewFinding.parse({
        ...base,
        id: "f-2",
        reviewer: {
          harness_id: "cursor",
          requested_model: null,
          requested_effort: null,
          observed_model: null,
          route_proof_status: "verified",
        },
      }),
    ];

    expect(dedupeFindings(findings)).toHaveLength(2);
  });
});
