import { describe, expect, it } from "vitest";
import { ReviewFinding } from "@claudexor/schema";
import {
  dedupeFindings,
  extractJsonBlocks,
  parseFindingsDetailed,
  parseSealedReviewEnvelopeDetailed,
} from "./findings.js";
import { RELEASE_NATIVE_CHECKLIST_ITEMS } from "./reviewPrompt.js";

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
    ).toEqual([{ severity: "BLOCK", category: "correctness", claim: "single fenced finding" }]);
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

  it("returns no payload for a long unclosed fence", () => {
    expect(extractJsonBlocks("```" + " ".repeat(128 * 1024))).toEqual([]);
  });

  it("bounds fallback work across many unclosed line-start candidates", () => {
    expect(extractJsonBlocks(Array.from({ length: 4_096 }, () => "[").join("\n"))).toEqual([]);
  });

  it("still finds the newest valid payload inside the fallback candidate budget", () => {
    const text = [
      ...Array.from({ length: 4_096 }, () => "["),
      '[{"severity":"WARN","category":"correctness","claim":"late payload"}]',
    ].join("\n");
    expect(extractJsonBlocks(text)).toEqual([
      [{ severity: "WARN", category: "correctness", claim: "late payload" }],
    ]);
  });
});

describe("payloads glued on the chosen line (a draft and its answer, `[][...]`)", () => {
  const warn = { severity: "WARN", category: "test_gap", claim: "glued warning" };
  const block = { severity: "BLOCK", category: "correctness", claim: "glued blocker" };
  const W = JSON.stringify([warn]);
  const B = JSON.stringify([block]);
  const claims = (text: string) => {
    const parsed = parseFindingsDetailed(text, { harness_id: "r" });
    return {
      claims: parsed.findings.map((f) => `${f.severity}:${f.claim}`),
      malformed: parsed.malformed,
    };
  };

  it("reads every payload that follows with only spaces or tabs between, in either order", () => {
    expect(extractJsonBlocks(`[]${B}`)).toEqual([[], [block]]);
    expect(extractJsonBlocks(`${W}${B}`)).toEqual([[warn], [block]]);
    expect(extractJsonBlocks(`${B}[]`)).toEqual([[block], []]);
    expect(extractJsonBlocks(`status before\n[] \t${B}\n`)).toEqual([[], [block]]);
    expect(extractJsonBlocks(`[]{"findings":[${JSON.stringify(block)}]}`)).toEqual([
      [],
      { findings: [block] },
    ]);
    expect(claims(`[]${B}`)).toEqual({ claims: ["BLOCK:glued blocker"], malformed: 0 });
    expect(claims(`${B}[]`)).toEqual({ claims: ["BLOCK:glued blocker"], malformed: 0 });
    expect(claims(`${W}${B}`)).toEqual({
      claims: ["WARN:glued warning", "BLOCK:glued blocker"],
      malformed: 0,
    });
  });

  it("keeps the newest line, pretty JSON, prose and fences as before", () => {
    // A payload on a later line is still the newest one; a line break ends a run.
    expect(extractJsonBlocks(`[]\n${B}`)).toEqual([[block]]);
    expect(extractJsonBlocks(`${B}\n[]`)).toEqual([[]]);
    // A pretty payload glued to a draft is read whole; a pretty latest payload alone too.
    const pretty = JSON.stringify([block], null, 2);
    expect(extractJsonBlocks(`[] ${pretty}`)).toEqual([[], [block]]);
    expect(extractJsonBlocks(`[]\n${pretty}`)).toEqual([[block]]);
    // Prose after the chosen payload ends the run: a finding in it is not read, and
    // since words cannot tell an example from a late answer, the review is not clean.
    const example = `I checked it.\n[] means clean; a finding looks like ${B}`;
    expect(extractJsonBlocks(example)).toEqual([[]]);
    expect(claims(example)).toEqual({ claims: [], malformed: 1 });
    // Fenced payloads keep their own rule: every complete fence is read.
    expect(extractJsonBlocks("```json\n[]\n```\n```json\n" + B + "\n```")).toEqual([[], [block]]);
  });

  it("an incomplete, unparseable or unread glued payload is malformed, never a clean review", () => {
    for (const tail of ["[", '[{"severity":"BLOCK"', '{"verdict":"clean"}', "[1]"])
      expect(claims(`[] ${tail}`).malformed).toBeGreaterThan(0);
    // Valid findings before a bad tail are kept beside the malformed count.
    expect(claims(`${B} [`)).toEqual({ claims: ["BLOCK:glued blocker"], malformed: 1 });
    // At most 64 glued payloads are read; one past that bound is not clean.
    const many = (count: number) => "[]".repeat(count);
    expect(extractJsonBlocks(many(64))).toHaveLength(64);
    expect(claims(many(64))).toEqual({ claims: [], malformed: 0 });
    expect(extractJsonBlocks(many(65))).toHaveLength(64);
    expect(claims(many(65))).toEqual({ claims: [], malformed: 1 });
    expect(claims(`${many(64)}${B}`)).toEqual({ claims: [], malformed: 1 });
    expect(claims(`${many(63)}${B}`)).toEqual({ claims: ["BLOCK:glued blocker"], malformed: 0 });
  });

  it("an inner line-start payload of an enclosing multiline chain is never the newest one", () => {
    // `[]{"findings":` then `[]}` + B: the inner `[]` begins a line but lies inside
    // the first line's chain, which is read whole.
    expect(claims(`[]{"findings":\n[]}${B}`)).toEqual({
      claims: ["BLOCK:glued blocker"],
      malformed: 0,
    });
    // A glued payload that never closes holds the rest: its inner `[]` is not clean.
    expect(claims('[][{\n"evidence":\n[]')).toEqual({ claims: [], malformed: 1 });
    // So does a line-start payload that never closes before the one read.
    expect(claims('[{\n"evidence":\n[]').malformed).toBe(1);
    // A multiline payload after prose whose inner array begins a line: that inner
    // `[]` was read as the newest payload (a clean review); the enclosing one is.
    const nested =
      '[\n  {"severity":"BLOCK","category":"correctness","claim":"glued blocker",' +
      '"evidence":{"files":\n[]}}\n]';
    expect(claims(`Findings:\n${nested}\ntrailing words`)).toEqual({
      claims: ["BLOCK:glued blocker"],
      malformed: 0,
    });
    // Either bracket encloses: an object line holds the inner `[]` line, so that
    // `[]` is not the newest payload and the object after the first `[]` is unread.
    expect(
      claims(
        '[]\n{"findings":[{"severity":"BLOCK","category":"correctness","claim":"x","evidence":\n[]}]}',
      ),
    ).toEqual({ claims: [], malformed: 1 });
    // Structure is read before any bound: 65 inner line-start `[]` stay nested in
    // the glued object, whose finding is kept beside its 65 unreadable items.
    const inner = Array.from({ length: 65 }, () => "[]").join(",\n");
    expect(claims(`[]{"findings":[${JSON.stringify(block)},\n${inner}]}`)).toEqual({
      claims: ["BLOCK:glued blocker"],
      malformed: 65,
    });
  });

  it("text after the payload read that could still hold the answer is never a clean review", () => {
    const object = JSON.stringify(block);
    for (const text of [
      // A later payload that never closes (a cut-off answer).
      "[]\n[",
      '[]\n[{"severity":"BLOCK","claim":"x"',
      // A later finding the newest-line choice does not read: an object line after
      // an array line, a finding after prose, after a fence, or inside an unclosed one.
      `[]\n${object}`,
      `[]\n{"findings":${B}}`,
      `[]After checking: ${B}`,
      "```json\n[]\n```\n" + B,
      "```json\n[]\n```\n```json\n" + B,
      // A later payload that opens like JSON but does not parse, or one in prose.
      '[]\n[{"severity":"BLOCK","claim":"x",}]',
      '[]\n{"severity":"BLOCK",}',
      `[]\n[see ${object}]`,
      // JSON of the wrong schema never leaves the empty answer trusted: an unknown
      // object, a finding without a severity, another answer's shape.
      '[]\n{"verdict":"clean"}',
      '[]After checking: {"note":"looked fine"}',
      '[]After checking: [{"category":"correctness","claim":"x"}]',
      // A closed fence that does not hold a review payload beside one that does.
      "```json\n[]\n```\n```json\n" + '[{"severity":"BLOCK","claim":"x"}' + "\n```",
      "```json\n[]\n```\n```json\n" + '{"verdict":"clean"}' + "\n```",
      // A JSON-looking value that closes on the wrong bracket, bare or after a fence.
      '[]\n{"severity":"BLOCK"]',
      "```json\n[]\n```\n" + '{"severity":"BLOCK"]',
      '[]After checking: [{"severity":"BLOCK"}}',
    ])
      expect(claims(text), text).toMatchObject({ claims: [], malformed: 1 });
    expect(claims(`${B}\n{"severity":"BLOCK"]`)).toEqual({
      claims: ["BLOCK:glued blocker"],
      malformed: 1,
    });
    // A finding read is kept beside what makes the reading malformed.
    for (const tail of ['{"note":"x"}', '{"findings":[]}', "[]"])
      expect(claims(`${B}\nNotes: ${tail}`), tail).toEqual({
        claims: ["BLOCK:glued blocker"],
        malformed: 1,
      });
    // A truncated pretty array is not read as its last complete object.
    expect(claims(`[\n  ${object},\n  ${object}`).malformed).toBe(1);
    // A tail the bound cannot examine is not proof of a clean review.
    expect(claims(`[]\n${"[x] ".repeat(65)}`).malformed).toBe(1);
  });

  it("keeps the latest line, bracketed prose and exact copies of the answer clean", () => {
    for (const text of [
      `${B}\n[]`,
      "[]\nreview notes after the JSON block []",
      "[]\nSee [the diff](https://example.invalid/a?b=[1]) and [x] done.",
      // Bracketed prose that closes on the wrong bracket is still prose.
      "[]\nNote [x} and {y] are typos.",
      "[]\n[INFO] review complete [1/1]",
      "```json\n[]\n```\nNo further notes.",
      `${"[x] ".repeat(64)}\n[]`,
    ])
      expect(claims(text), text).toEqual({ claims: [], malformed: 0 });
    // The newest line-start array still wins, and an earlier one is not counted.
    expect(claims(`[]\n${B}`)).toEqual({ claims: ["BLOCK:glued blocker"], malformed: 0 });
    // Array lines are still preferred over object lines, but a later object line
    // is not trusted away: the finding stays and the reading is malformed.
    expect(claims(`${B}\n{"findings":[]}`)).toEqual({
      claims: ["BLOCK:glued blocker"],
      malformed: 1,
    });
    // An exact copy of the answer after it (duplicated status text) is no other payload.
    expect(claims(`${B}\nFinal: ${B}`)).toEqual({ claims: ["BLOCK:glued blocker"], malformed: 0 });
  });

  it("a JSON example before the first fence read is not counted; after it, it is", () => {
    const config = '```json\n{"name": "demo", "version": "1.0.0"}\n```\n';
    const fenced = (payload: string) => "```json\n" + payload + "\n```\n";
    // Before the answer it is an example, as an earlier value is on the bare path.
    expect(claims(`Looking at the config:\n${config}Findings:\n${fenced(B)}`)).toEqual({
      claims: ["BLOCK:glued blocker"],
      malformed: 0,
    });
    expect(claims(`Config:\n${config}${fenced("[]")}`)).toEqual({ claims: [], malformed: 0 });
    expect(claims(`Looking at the config:\n${config}Findings:\n${B}\n`)).toEqual({
      claims: ["BLOCK:glued blocker"],
      malformed: 0,
    });
    // After the first payload read, words cannot tell it from a late answer.
    expect(claims(`${fenced("[]")}${config}`)).toEqual({ claims: [], malformed: 1 });
    expect(claims(`${fenced(B)}${config}`)).toEqual({
      claims: ["BLOCK:glued blocker"],
      malformed: 1,
    });
  });

  it("the strict sealed parser keeps its one-object boundary", () => {
    const parsed = parseSealedReviewEnvelopeDetailed(`[]${B}`, { harness_id: "release-reviewer" });
    expect(parsed.error).toMatch(/exactly one JSON object/);
    expect(parsed.findings).toEqual([]);
    expect(parsed.blocks).toEqual([]);
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

  it("keeps consuming findings from the sealed release completion envelope", () => {
    const parsed = parseFindingsDetailed(
      JSON.stringify({
        completion: {
          verdict: "PASS",
          checklist: [{ item: "sealed_evidence", completed: true }],
          findingCount: 1,
        },
        findings: [{ severity: "WARN", category: "test_gap", claim: "wrapped release finding" }],
      }),
      { harness_id: "release-reviewer" },
    );
    expect(parsed.malformed).toBe(0);
    expect(parsed.findings.map((finding) => finding.claim)).toEqual(["wrapped release finding"]);
  });
});

function sealedEnvelope(
  findings: unknown[] = [],
  verdict: "PASS" | "FAIL" = findings.some(
    (finding) =>
      !!finding &&
      typeof finding === "object" &&
      ["BLOCK", "FIX_FIRST", "NEEDS_HUMAN", "INSUFFICIENT_EVIDENCE"].includes(
        String((finding as { severity?: unknown }).severity),
      ),
  )
    ? "FAIL"
    : "PASS",
) {
  return {
    completion: {
      verdict,
      checklist: RELEASE_NATIVE_CHECKLIST_ITEMS.map((item) => ({ item, completed: true })),
      findingCount: findings.length,
    },
    findings,
  };
}

const sealedReviewer = { harness_id: "release-reviewer" };

describe("parseSealedReviewEnvelopeDetailed", () => {
  it("accepts an exact clean envelope and an optional checklist note", () => {
    const envelope = sealedEnvelope();
    envelope.completion.checklist[0] = {
      ...envelope.completion.checklist[0]!,
      note: "manifest verified",
    } as (typeof envelope.completion.checklist)[number];
    const parsed = parseSealedReviewEnvelopeDetailed(JSON.stringify(envelope), sealedReviewer);
    expect(parsed).toMatchObject({ findings: [], malformed: 0, error: null });
  });

  it("accepts a FAIL envelope whose count and verdict match a blocker", () => {
    const parsed = parseSealedReviewEnvelopeDetailed(
      JSON.stringify(
        sealedEnvelope([{ severity: "BLOCK", category: "correctness", claim: "real blocker" }]),
      ),
      sealedReviewer,
    );
    expect(parsed.error).toBeNull();
    expect(parsed.findings.map((finding) => finding.claim)).toEqual(["real blocker"]);
  });

  it("rejects repeated semantically identical envelopes", () => {
    const envelope = sealedEnvelope([
      { severity: "WARN", category: "test_gap", claim: "same warning" },
    ]);
    const reordered = { findings: envelope.findings, completion: envelope.completion };
    const parsed = parseSealedReviewEnvelopeDetailed(
      `${JSON.stringify(envelope)}\n${JSON.stringify(reordered)}`,
      sealedReviewer,
    );
    expect(parsed.error).toMatch(/exactly one JSON object/);
    expect(parsed.blocks).toEqual([]);
    expect(parsed.findings).toEqual([]);
  });

  it("rejects divergent or mixed payloads at the one-object boundary", () => {
    const envelope = sealedEnvelope();
    expect(
      parseSealedReviewEnvelopeDetailed(
        `${JSON.stringify(envelope)}\n${JSON.stringify(sealedEnvelope([{ severity: "WARN", claim: "later" }]))}`,
        sealedReviewer,
      ).error,
    ).toMatch(/exactly one JSON object/);
    expect(
      parseSealedReviewEnvelopeDetailed(`${JSON.stringify(envelope)}\n[]`, sealedReviewer).error,
    ).toMatch(/exactly one JSON object/);
  });

  it.each([
    ["missing row", (value: ReturnType<typeof sealedEnvelope>) => value.completion.checklist.pop()],
    [
      "wrong order",
      (value: ReturnType<typeof sealedEnvelope>) => value.completion.checklist.reverse(),
    ],
    [
      "incomplete row",
      (value: ReturnType<typeof sealedEnvelope>) => {
        value.completion.checklist[0]!.completed = false;
      },
    ],
    [
      "unknown row field",
      (value: ReturnType<typeof sealedEnvelope>) => {
        Object.assign(value.completion.checklist[0]!, { extra: true });
      },
    ],
  ])("rejects a %s in the exact checklist", (_name, mutate) => {
    const envelope = sealedEnvelope();
    mutate(envelope);
    expect(
      parseSealedReviewEnvelopeDetailed(JSON.stringify(envelope), sealedReviewer).error,
    ).toMatch(/exact completed items/);
  });

  it.each([
    ["negative", -1],
    ["fractional", 0.5],
    ["mismatched", 2],
  ])("rejects a %s findingCount", (_name, findingCount) => {
    const envelope = sealedEnvelope();
    envelope.completion.findingCount = findingCount;
    expect(
      parseSealedReviewEnvelopeDetailed(JSON.stringify(envelope), sealedReviewer).error,
    ).toMatch(/findingCount/);
  });

  it("rejects PASS with a blocker and FAIL without one", () => {
    const mismatched = parseSealedReviewEnvelopeDetailed(
      JSON.stringify(
        sealedEnvelope(
          [{ severity: "FIX_FIRST", category: "regression", claim: "must fix" }],
          "PASS",
        ),
      ),
      sealedReviewer,
    );
    expect(mismatched.error).toMatch(/must be FAIL/);
    expect(mismatched.findings.map((finding) => finding.claim)).toEqual(["must fix"]);
    expect(
      parseSealedReviewEnvelopeDetailed(JSON.stringify(sealedEnvelope([], "FAIL")), sealedReviewer)
        .error,
    ).toMatch(/must be PASS/);
  });

  it("rejects malformed findings and extra envelope fields", () => {
    const malformed = sealedEnvelope([
      { severity: "WARN", category: "test_gap", claim: "retained warning" },
      { category: "correctness", claim: "missing severity" },
    ]);
    const parsed = parseSealedReviewEnvelopeDetailed(JSON.stringify(malformed), sealedReviewer);
    expect(parsed.error).toMatch(/malformed/);
    expect(parsed.malformed).toBe(1);
    expect(parsed.findings.map((finding) => finding.claim)).toEqual(["retained warning"]);

    const extra = { ...sealedEnvelope(), explanation: "not part of the contract" };
    expect(parseSealedReviewEnvelopeDetailed(JSON.stringify(extra), sealedReviewer).error).toMatch(
      /envelope shape/,
    );
  });

  it.each([
    ["unknown severity", { severity: "CRITICAL", claim: "bad severity" }],
    ["unknown category", { severity: "WARN", category: "style", claim: "bad category" }],
    [
      "malformed file evidence",
      { severity: "WARN", claim: "bad evidence", evidence: { files: [{ path: 42 }] } },
    ],
    ["malformed proposed fix", { severity: "WARN", claim: "bad fix", proposed_fix: 42 }],
  ])("rejects %s before a sealed decision is trusted", (_name, finding) => {
    const parsed = parseSealedReviewEnvelopeDetailed(
      JSON.stringify(sealedEnvelope([finding])),
      sealedReviewer,
    );
    expect(parsed.error).toMatch(/malformed/);
    expect(parsed.findings).toEqual([]);
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
