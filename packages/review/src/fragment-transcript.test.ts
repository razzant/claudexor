/** Stream fragments (`payload.delta`, e.g. an Antigravity reviewer) reach the
 * reviewer text and transcript.md exactly — no line break per fragment — while
 * a complete message (typed final, buffered result, whole message) still starts
 * its own line, and the existing failure policy stays: a failed reviewer's
 * parseable JSON is recorded beside a blocking insufficient-evidence finding,
 * never healthy. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { ConformanceReport, HarnessManifest, type HarnessEvent } from "@claudexor/schema";
import { AcpEvents } from "../../harness-acp/src/events.js";
import { parseAgyEvent } from "../../harness-agy/src/parse.js";
import { createClaudeParser } from "../../harness-claude/src/parse.js";
import { reviewCandidate, type ReviewerSpec } from "./reviewEngine.js";
import { sealedReviewTranscriptChunk } from "./sealedReviewEnvelope.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

function workspace() {
  const cwd = scratch("cx-fragment-review-");
  const evidenceDir = join(cwd, ".claudexor-review-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  for (const [name, text] of [
    ["USER_INTENT.md", "review candidate\n"],
    ["FORBIDDEN_FINDINGS.md", "(none)\n"],
    ["PLAN_ACCEPTED.md", "(none)\n"],
    ["TESTS.txt", "(tests not run)\n"],
    ["DECIDED_TRADEOFFS.md", "(none)\n"],
  ] as const)
    writeFileSync(join(evidenceDir, name), text);
  return { cwd, evidenceDir, artifactsDir: scratch("cx-fragment-review-artifacts-") };
}

const finding = {
  severity: "WARN",
  category: "correctness",
  claim: "fragmented finding survives",
  evidence: { files: [{ path: "x.ts", lines: "1" }] },
  proposed_fix: "fix x",
};
const output = JSON.stringify([finding]);
// Split inside a string literal and a key: a newline per fragment breaks JSON.parse.
const fragments = [output.slice(0, 7), output.slice(7, 30), output.slice(30)];

function reviewer(
  id: string,
  family: "openai" | "anthropic",
  tail: (base: Omit<HarnessEvent, "type">) => HarnessEvent[],
): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: { review: true, structured_output: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    async *run(spec) {
      const base = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...base, type: "started", observed_model: `${id}-model` };
      for (const text of fragments)
        yield { ...base, type: "message", text, payload: { delta: true } };
      yield* tail(base);
    },
  };
  return { adapter, providerFamily: family };
}

const clean = (id: string): ReviewerSpec =>
  reviewer(id, "anthropic", (base) => [
    { ...base, type: "message", text: "[]", final: true },
    { ...base, type: "completed" },
  ]);

describe("reviewer stream fragments", () => {
  it("projects a fragment exactly and keeps every other message line-terminated", () => {
    expect(
      sealedReviewTranscriptChunk({ type: "message", text: "ab", payload: { delta: true } }),
    ).toBe("ab");
    expect(
      sealedReviewTranscriptChunk({ type: "message", text: " ", payload: { delta: true } }),
    ).toBe(" ");
    expect(sealedReviewTranscriptChunk({ type: "message", text: "whole" })).toBe("whole\n");
    expect(
      sealedReviewTranscriptChunk({ type: "message", text: "x", payload: { auth_switched: true } }),
    ).toBeNull();
    // After an unterminated fragment run a complete message starts its own line;
    // a fragment still joins exactly.
    expect(sealedReviewTranscriptChunk({ type: "message", text: "whole" }, true)).toBe("\nwhole\n");
    expect(
      sealedReviewTranscriptChunk({ type: "message", text: "b", payload: { delta: true } }, true),
    ).toBe("b");
  });

  it("a failed fragment reviewer keeps its parseable findings, a blocking finding and an unhealthy seat; transcript bytes are exact", async () => {
    const { artifactsDir, ...ws } = workspace();
    const failing = reviewer("fragment-failure", "openai", (base) => [
      { ...base, type: "error", error: "terminal failure after streamed text" },
    ]);
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n",
      ...ws,
      artifactsDir,
      reviewers: [failing, clean("clean-anthropic")],
    });
    expect(res.findings.filter((f) => f.claim === finding.claim)).toHaveLength(1);
    expect(
      res.findings.some(
        (f) =>
          f.severity === "INSUFFICIENT_EVIDENCE" &&
          f.claim.includes("Reviewer failed after parseable JSON output"),
      ),
    ).toBe(true);
    expect(res.healthyProviders).toEqual(["anthropic"]);
    expect(res.crossFamilyVerified).toBe(false);
    expect(readFileSync(join(artifactsDir, "01-fragment-failure", "transcript.md"), "utf8")).toBe(
      output,
    );
  });

  it("control: fragments followed by their identical complete message and final still yield one finding (Cursor/Claude shape)", async () => {
    const { artifactsDir, ...ws } = workspace();
    const flushed = reviewer("fragment-flush", "openai", (base) => [
      { ...base, type: "message", text: output },
      { ...base, type: "message", text: output, final: true },
      { ...base, type: "completed" },
    ]);
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n",
      ...ws,
      artifactsDir,
      reviewers: [flushed, clean("clean-anthropic")],
    });
    expect(res.findings.filter((f) => f.claim === finding.claim)).toHaveLength(1);
    expect(res.findings.some((f) => f.severity === "INSUFFICIENT_EVIDENCE")).toBe(false);
    expect(res.healthyProviders.sort()).toEqual(["anthropic", "openai"]);
    // The complete flush starts its own line after the joined fragments.
    expect(readFileSync(join(artifactsDir, "01-fragment-flush", "transcript.md"), "utf8")).toBe(
      `${output}\n${output}\n${output}\n`,
    );
  });
});

/** SYNTHETIC neutral AGY frames through the actual AGY parser: `text_delta`
 * fragments (strings) and tool calls (`{ tool }`) in order, then the terminal
 * `result`. A bare string or null is a draft before one tool call. */
type AgyStep = string | { tool: number };
function agyReviewer(
  draft: string | null | readonly AgyStep[],
  result: Record<string, unknown>,
): ReviewerSpec {
  const steps: readonly AgyStep[] = Array.isArray(draft)
    ? draft
    : [...(typeof draft === "string" ? [draft] : []), { tool: 1 }];
  const adapter: HarnessAdapter = {
    id: "agy",
    async discover() {
      return HarnessManifest.parse({
        id: "agy",
        display_name: "agy",
        kind: "local_cli",
        provider_family: "google",
        capabilities: { review: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "agy",
        status: "ok",
        enabled_intents: ["review"],
      });
    },
    async *run(spec) {
      const frames = [
        { event: "init", conversation_id: "conv-fixture", init: { model: "gemini-fixture" } },
        ...steps.flatMap((step): Record<string, unknown>[] =>
          typeof step === "string"
            ? [
                {
                  event: "step_update",
                  step_update: { step_type: "agent_response", text_delta: step },
                },
              ]
            : (["ACTIVE", "DONE"] as const).map((state) => ({
                event: "step_update",
                step_update: {
                  step_index: step.tool,
                  step_type: "tool",
                  state,
                  tool_info: {
                    name: "view_file",
                    parameters: { AbsolutePath: "/fixture/x.ts" },
                    ...(state === "DONE" ? { output: "1 line" } : {}),
                  },
                },
              })),
        ),
        { event: "result", result },
      ];
      for (const frame of frames)
        for (const event of parseAgyEvent(frame, spec.session_id) ?? []) yield event;
      yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
    },
  };
  return { adapter, providerFamily: "google" };
}

const blocker = {
  severity: "BLOCK",
  category: "correctness",
  claim: "the final blocker survives its draft",
  evidence: { files: [{ path: "x.ts", lines: "1" }] },
  proposed_fix: "fix x",
};
const blockerText = JSON.stringify([blocker]);
const diff = "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n";

describe("a complete message after a fragment run (actual AGY parser)", () => {
  it.each([
    ["an empty-array draft", "[]"],
    ["a narration draft", "I will inspect the candidate."],
  ])(
    "the typed final after %s is the reviewer's finding, on its own line",
    async (_label, draft) => {
      const { artifactsDir, ...ws } = workspace();
      const res = await reviewCandidate({
        candidateLabel: "Candidate A",
        diff,
        ...ws,
        artifactsDir,
        reviewers: [agyReviewer(draft, { status: "SUCCESS", response: blockerText })],
      });
      expect(
        res.findings.filter((f) => f.claim === blocker.claim && f.severity === "BLOCK"),
      ).toHaveLength(1);
      expect(res.findings.some((f) => f.severity === "INSUFFICIENT_EVIDENCE")).toBe(false);
      expect(res.healthyProviders).toEqual(["google"]);
      expect(readFileSync(join(artifactsDir, "01-agy", "transcript.md"), "utf8")).toBe(
        `${draft}\n${blockerText}\n`,
      );
    },
  );

  it("a failed result's retained response keeps its finding, a blocking finding and an unhealthy seat", async () => {
    const { artifactsDir, ...ws } = workspace();
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff,
      ...ws,
      artifactsDir,
      reviewers: [
        agyReviewer("[]", {
          status: "ERROR",
          error: "fixture vendor failure",
          response: blockerText,
        }),
      ],
    });
    expect(
      res.findings.filter((f) => f.claim === blocker.claim && f.severity === "BLOCK"),
    ).toHaveLength(1);
    expect(
      res.findings.some(
        (f) =>
          f.severity === "INSUFFICIENT_EVIDENCE" &&
          f.claim.includes("Reviewer failed after parseable JSON output"),
      ),
    ).toBe(true);
    expect(res.healthyProviders).toEqual([]);
    expect(readFileSync(join(artifactsDir, "01-agy", "transcript.md"), "utf8")).toBe(
      `[]\n${blockerText}\n`,
    );
  });

  it.each([
    ["no draft", null, `${blockerText}\n`],
    ["a draft that ends its own line", "[]\n", `[]\n${blockerText}\n`],
  ])("control: %s adds no line break", async (_label, draft, transcript) => {
    const { artifactsDir, ...ws } = workspace();
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff,
      ...ws,
      artifactsDir,
      reviewers: [agyReviewer(draft, { status: "SUCCESS", response: blockerText })],
    });
    expect(
      res.findings.filter((f) => f.claim === blocker.claim && f.severity === "BLOCK"),
    ).toHaveLength(1);
    expect(res.healthyProviders).toEqual(["google"]);
    expect(readFileSync(join(artifactsDir, "01-agy", "transcript.md"), "utf8")).toBe(transcript);
  });
});

const fencedFindings = [
  {
    severity: "WARN",
    category: "correctness",
    claim: "fenced warn",
    evidence: { files: [{ path: "x.ts", lines: "1" }] },
    proposed_fix: "fix",
  },
  {
    severity: "NEEDS_HUMAN",
    category: "correctness",
    claim: "fenced human gate",
    evidence: { files: [{ path: "x.ts", lines: "2" }] },
    proposed_fix: "ask",
  },
];
const fenced = "```json\n" + JSON.stringify(fencedFindings, null, 2) + "\n```";
const tokens = (text: string) =>
  Array.from({ length: Math.ceil(text.length / 9) }, (_, i) => text.slice(i * 9, i * 9 + 9));

/** A generic reviewer streaming `chunks` as fragments, then the events `tail`. */
function streamingReviewer(
  chunks: readonly string[],
  tail: readonly Omit<HarnessEvent, "session_id" | "ts">[],
): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id: "fenced",
    async discover() {
      return HarnessManifest.parse({
        id: "fenced",
        display_name: "fenced",
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { review: true, structured_output: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "fenced",
        status: "ok",
        enabled_intents: ["review"],
      });
    },
    async *run(spec) {
      const base = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...base, type: "started", observed_model: "fenced-model" };
      for (const text of chunks) yield { ...base, type: "message", text, payload: { delta: true } };
      for (const event of tail) yield { ...base, ...event } as HarnessEvent;
    },
  };
  return { adapter, providerFamily: "openai" };
}

async function review(spec: ReviewerSpec, dir: string) {
  const { artifactsDir, ...ws } = workspace();
  const res = await reviewCandidate({
    candidateLabel: "Candidate A",
    diff,
    ...ws,
    artifactsDir,
    reviewers: [spec],
  });
  const read = (name: string) => readFileSync(join(artifactsDir, dir, name), "utf8");
  return {
    res,
    blocks: JSON.parse(read("parsed-json-blocks.json")) as unknown[],
    transcript: read("transcript.md"),
  };
}

const claims = (res: { findings: { severity: string; claim: string }[] }) =>
  res.findings.map((f) => `${f.severity}:${f.claim}`).sort();

describe("an exact adjacent repetition is parsed once; the transcript keeps every copy", () => {
  it("fenced fragments repeated by their typed final", async () => {
    const out = await review(
      streamingReviewer(tokens(fenced), [
        { type: "message", text: fenced, final: true },
        { type: "completed" },
      ]),
      "01-fenced",
    );
    expect(out.blocks).toHaveLength(1);
    expect(claims(out.res)).toEqual(["NEEDS_HUMAN:fenced human gate", "WARN:fenced warn"]);
    expect(out.transcript).toBe(`${fenced}\n${fenced}\n`);
  });

  it("fenced fragments, their complete flush and the final repeating it (Cursor/Claude shape)", async () => {
    const out = await review(
      streamingReviewer(tokens(fenced), [
        { type: "message", text: fenced },
        { type: "message", text: fenced, final: true },
        { type: "completed" },
      ]),
      "01-fenced",
    );
    expect(out.blocks).toHaveLength(1);
    expect(claims(out.res)).toEqual(["NEEDS_HUMAN:fenced human gate", "WARN:fenced warn"]);
    expect(out.transcript).toBe(`${fenced}\n${fenced}\n${fenced}\n`);
  });

  it("AGY narration, tools and a fenced answer, then the result repeating all of it", async () => {
    const steps: AgyStep[] = [
      "I will read x.ts. ",
      { tool: 1 },
      "Checked.\n",
      { tool: 2 },
      ...tokens(fenced),
    ];
    const whole = steps.filter((step): step is string => typeof step === "string").join("");
    const out = await review(agyReviewer(steps, { status: "SUCCESS", response: whole }), "01-agy");
    expect(out.blocks).toHaveLength(1);
    expect(claims(out.res)).toEqual(["NEEDS_HUMAN:fenced human gate", "WARN:fenced warn"]);
    expect(out.res.healthyProviders).toEqual(["google"]);
    expect(out.transcript).toBe(`${whole}\n${whole}\n`);
  });

  it("a failed AGY result's buffered copy of the fenced answer: one copy parsed, one blocking finding", async () => {
    const out = await review(
      agyReviewer([...tokens(fenced), { tool: 1 }], {
        status: "ERROR",
        error: "fixture vendor failure",
        response: fenced,
      }),
      "01-agy",
    );
    expect(out.blocks).toHaveLength(1);
    expect(claims(out.res)).toEqual([
      "INSUFFICIENT_EVIDENCE:Reviewer failed after parseable JSON output: Reviewer emitted error event: fixture vendor failure",
      "NEEDS_HUMAN:fenced human gate",
      "WARN:fenced warn",
    ]);
    expect(out.res.healthyProviders).toEqual([]);
    expect(out.transcript).toBe(`${fenced}\n${fenced}\n`);
  });

  it("control: a typed final that differs from its draft is parsed too", async () => {
    const draft = "```json\n[]\n```";
    const out = await review(
      streamingReviewer(tokens(draft), [
        { type: "message", text: fenced, final: true },
        { type: "completed" },
      ]),
      "01-fenced",
    );
    expect(out.blocks).toEqual([[], fencedFindings]);
    expect(claims(out.res)).toEqual(["NEEDS_HUMAN:fenced human gate", "WARN:fenced warn"]);
    expect(out.transcript).toBe(`${draft}\n${fenced}\n`);
  });
});

/** An ACP reviewer (e.g. Copilot) through the actual translator: its final is
 * the answer streamed after its last tool call. */
function acpReviewer(updates: readonly unknown[]): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id: "copilot",
    async discover() {
      return HarnessManifest.parse({
        id: "copilot",
        display_name: "copilot",
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { review: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "copilot",
        status: "ok",
        enabled_intents: ["review"],
      });
    },
    async *run(spec) {
      const acp = new AcpEvents(spec.session_id);
      for (const update of updates) yield* acp.update(update);
      yield* acp.finish("end_turn");
      yield acp.event("completed");
    },
  };
  return { adapter, providerFamily: "openai" };
}

describe("a complete message repeating fragments that later events split", () => {
  it.each(["SUCCESS", "ERROR"] as const)(
    "AGY: a draft, a tool, a fenced answer split by a second tool inside its JSON, then the answer again (status=%s)",
    async (status) => {
      const chunks = tokens(fenced);
      const middle = Math.floor(chunks.length / 2);
      const out = await review(
        agyReviewer(
          ["[]", { tool: 1 }, ...chunks.slice(0, middle), { tool: 2 }, ...chunks.slice(middle)],
          {
            status,
            response: fenced,
            ...(status === "ERROR" ? { error: "fixture vendor failure" } : {}),
          },
        ),
        "01-agy",
      );
      expect(out.blocks).toHaveLength(1);
      expect(claims(out.res)).toEqual([
        ...(status === "ERROR"
          ? [
              "INSUFFICIENT_EVIDENCE:Reviewer failed after parseable JSON output: Reviewer emitted error event: fixture vendor failure",
            ]
          : []),
        "NEEDS_HUMAN:fenced human gate",
        "WARN:fenced warn",
      ]);
      expect(out.res.healthyProviders).toEqual(status === "SUCCESS" ? ["google"] : []);
      expect(out.transcript).toBe(`[]${fenced}\n${fenced}\n`);
    },
  );

  it("ACP: a draft, a tool, then a fenced final split by a thought chunk", async () => {
    const chunk = (text: string) => ({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
    const middle = Math.floor(fenced.length / 2);
    const out = await review(
      acpReviewer([
        chunk("Draft: []\n"),
        {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "read",
          kind: "read",
          status: "completed",
        },
        chunk(fenced.slice(0, middle)),
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "checking" } },
        chunk(fenced.slice(middle)),
      ]),
      "01-copilot",
    );
    expect(out.blocks).toHaveLength(1);
    expect(claims(out.res)).toEqual(["NEEDS_HUMAN:fenced human gate", "WARN:fenced warn"]);
    expect(out.res.healthyProviders).toEqual(["openai"]);
    expect(out.transcript).toBe(`Draft: []\n${fenced}\n${fenced}\n`);
  });
});

describe("a complete response repeating only the latest streamed message", () => {
  it.each([
    ["SUCCESS", false],
    ["SUCCESS", true],
    ["ERROR", false],
    ["ERROR", true],
  ] as const)("keeps the BLOCK after a draft (status=%s, fenced=%s)", async (status, fence) => {
    const answer = fence ? `\`\`\`json\n${blockerText}\n\`\`\`` : blockerText;
    const out = await review(
      agyReviewer(["[]", { tool: 1 }, ...tokens(answer)], {
        status,
        response: answer,
        ...(status === "ERROR" ? { error: "fixture vendor failure" } : {}),
      }),
      "01-agy",
    );
    expect(out.blocks).toEqual([[blocker]]);
    expect(out.res.findings.filter((f) => f.claim === blocker.claim)).toHaveLength(1);
    expect(out.res.findings.some((f) => f.severity === "INSUFFICIENT_EVIDENCE")).toBe(
      status === "ERROR",
    );
    expect(out.res.healthyProviders).toEqual(status === "SUCCESS" ? ["google"] : []);
    // Parser-only boundary insertion must not rewrite the captured stream.
    expect(out.transcript).toBe(`[]${answer}\n${answer}\n`);
  });

  it("keeps a whole response split inside JSON by a tool event parseable", async () => {
    const middle = blockerText.indexOf("survives") + 3;
    const out = await review(
      agyReviewer([blockerText.slice(0, middle), { tool: 1 }, blockerText.slice(middle)], {
        status: "SUCCESS",
        response: blockerText,
      }),
      "01-agy",
    );
    expect(out.blocks).toEqual([[blocker]]);
    expect(out.res.healthyProviders).toEqual(["google"]);
    expect(out.transcript).toBe(`${blockerText}\n${blockerText}\n`);
  });
});

describe("which complete messages the parser input drops (shared StreamEcho rule)", () => {
  it("a final equal to a suffix that begins inside one run is parsed on its own line", async () => {
    // Split inside the last string; nothing interrupts the run. No producer sends
    // such a final, so it is not an echo: no line break is inserted into the JSON.
    const cut = blockerText.indexOf("fix x");
    const out = await review(
      streamingReviewer(
        [blockerText.slice(0, cut), blockerText.slice(cut)],
        [{ type: "message", text: blockerText.slice(cut), final: true }, { type: "completed" }],
      ),
      "01-fenced",
    );
    expect(claims(out.res)).toEqual([`BLOCK:${blocker.claim}`]);
    expect(out.res.healthyProviders).toEqual(["openai"]);
    expect(out.transcript).toBe(`${blockerText}\n${blockerText.slice(cut)}\n`);
    // Cut earlier, the repeated suffix holds a JSON value that is no copy of the
    // answer read: the finding stays and that seat is not healthy.
    const early = blockerText.indexOf("survives");
    const partial = await review(
      streamingReviewer(
        [blockerText.slice(0, early), blockerText.slice(early)],
        [{ type: "message", text: blockerText.slice(early), final: true }, { type: "completed" }],
      ),
      "01-fenced",
    );
    expect(claims(partial.res)).toEqual([
      `BLOCK:${blocker.claim}`,
      "INSUFFICIENT_EVIDENCE:Reviewer produced 1 malformed finding item(s).",
    ]);
    expect(partial.res.healthyProviders).toEqual([]);
  });

  it("keyed text is parsed as captured; an equal unkeyed final is parsed too, once newest", async () => {
    const keyed = (text: string) => ({
      type: "message" as const,
      text,
      payload: { delta: true },
      speech: { key: "k1", op: "fragment" as const },
    });
    const out = await review(
      streamingReviewer(
        [],
        [
          ...tokens(blockerText).map(keyed),
          { type: "message", text: blockerText, final: true },
          { type: "completed" },
        ],
      ),
      "01-fenced",
    );
    expect(out.blocks).toEqual([[blocker]]);
    expect(claims(out.res)).toEqual([`BLOCK:${blocker.claim}`]);
    expect(out.res.healthyProviders).toEqual(["openai"]);
    expect(out.transcript).toBe(`${blockerText}\n${blockerText}\n`);
  });
});

/** The recorded Claude 2.1.311 lifecycle `recorded-partial-replay.jsonl` through
 * the actual Claude parser, with only its text changed to reviewer words: the CLI
 * abandons the first response's keyed fragments (`abandoned`), retries the
 * request, narrates, calls a tool, then streams, completes and returns `answer`. */
function claudeReplayReviewer(abandoned: readonly [string, string], answer: string): ReviewerSpec {
  const fixture = new URL(
    "../../harness-claude/fixtures/recorded-partial-replay.jsonl",
    import.meta.url,
  );
  const frames = readFileSync(fileURLToPath(fixture), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  [frames[4].event.delta.text, frames[5].event.delta.text] = abandoned;
  frames[27].event.delta.text = answer.slice(0, 1);
  frames[28].event.delta.text = answer.slice(1);
  frames[29].message.content[0].text = answer;
  frames[33].result = answer;
  const adapter: HarnessAdapter = {
    id: "claude",
    async discover() {
      return HarnessManifest.parse({
        id: "claude",
        display_name: "claude",
        kind: "local_cli",
        provider_family: "anthropic",
        capabilities: { review: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "claude",
        status: "ok",
        enabled_intents: ["review"],
      });
    },
    async *run(spec) {
      const parse = createClaudeParser();
      for (const frame of frames) yield* parse(frame, spec.session_id) ?? [];
      yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
    },
  };
  return { adapter, providerFamily: "anthropic" };
}

describe("a speech the harness abandoned (recorded Claude replay, actual parser)", () => {
  it.each([
    ["a BLOCK answer", blockerText, [`BLOCK:${blocker.claim}`]],
    ["a clean answer", "[]", []],
  ] as const)(
    "its unfinished JSON never holds the retried response's %s; the transcript keeps it",
    async (_label, answer, kept) => {
      const out = await review(claudeReplayReviewer(["[{", '"severity":'], answer), "01-claude");
      expect(claims(out.res)).toEqual(kept);
      expect(out.res.healthyProviders).toEqual(["anthropic"]);
      expect(out.transcript).toBe(
        `[{"severity":Checking the file first.\nChecking the file first.\n${answer}\n${answer}\n${answer}\n`,
      );
    },
  );

  it("a malformed tail within the retried response stays malformed", async () => {
    const out = await review(
      claudeReplayReviewer(["Checking", " the"], '[]\n[{"severity":'),
      "01-claude",
    );
    expect(claims(out.res)).toEqual([
      "INSUFFICIENT_EVIDENCE:Reviewer produced 1 malformed finding item(s).",
    ]);
    expect(out.res.healthyProviders).toEqual([]);
  });
});

describe("a draft glued to its answer on one line (`[]` then `[BLOCK]`)", () => {
  it.each(["SUCCESS", "ERROR"] as const)(
    "an AGY result repeating its `[]` draft and BLOCK answer keeps the BLOCK (status=%s)",
    async (status) => {
      // The result is the exact concatenation of the frames across the tool.
      const whole = `[]${blockerText}`;
      const out = await review(
        agyReviewer(["[]", { tool: 1 }, ...tokens(blockerText)], {
          status,
          response: whole,
          ...(status === "ERROR" ? { error: "fixture vendor failure" } : {}),
        }),
        "01-agy",
      );
      expect(out.blocks).toEqual([[], [blocker]]);
      expect(
        out.res.findings.filter((f) => f.claim === blocker.claim && f.severity === "BLOCK"),
      ).toHaveLength(1);
      expect(out.res.findings.some((f) => f.severity === "INSUFFICIENT_EVIDENCE")).toBe(
        status === "ERROR",
      );
      expect(out.res.healthyProviders).toEqual(status === "SUCCESS" ? ["google"] : []);
      expect(out.transcript).toBe(`${whole}\n${whole}\n`);
    },
  );

  it.each([
    ["an incomplete payload after the draft", "[] ["],
    ["a payload past the 64-payload bound", `${"[]".repeat(64)}${blockerText}`],
  ])("%s is malformed: an unhealthy seat, never a clean review", async (_label, text) => {
    const out = await review(
      streamingReviewer([], [{ type: "message", text, final: true }, { type: "completed" }]),
      "01-fenced",
    );
    expect(out.res.healthyProviders).toEqual([]);
    expect(claims(out.res)).toEqual([
      "INSUFFICIENT_EVIDENCE:Reviewer produced 1 malformed finding item(s).",
    ]);
    expect(out.transcript).toBe(`${text}\n`);
  });

  it.each([
    // The inner `[]` begins a line inside the first line's chain: the chain is read.
    ['[]{"findings":\n[]}', `[]{"findings":\n[]}${blockerText}`, true, true],
    // A glued payload that never closes holds the rest: no clean inner `[]`.
    ["[][{\n", '[][{\n"evidence":\n[]', false, false],
    // A finding after prose is not read, and the review is not clean either.
    ["[]After checking: ", `[]After checking: ${blockerText}`, false, false],
  ] as const)(
    "an AGY result `%s…` reads its enclosing chain or is malformed, never a clean `[]`",
    async (head, whole, blocks, healthy) => {
      const out = await review(
        agyReviewer([head, { tool: 1 }, whole.slice(head.length)], {
          status: "SUCCESS",
          response: whole,
        }),
        "01-agy",
      );
      expect(
        out.res.findings.some((f) => f.claim === blocker.claim && f.severity === "BLOCK"),
      ).toBe(blocks);
      expect(out.res.healthyProviders).toEqual(healthy ? ["google"] : []);
      if (!healthy)
        expect(claims(out.res)).toContain(
          "INSUFFICIENT_EVIDENCE:Reviewer produced 1 malformed finding item(s).",
        );
      expect(out.transcript).toBe(`${whole}\n${whole}\n`);
    },
  );

  const block = (claim: string) => ({ severity: "BLOCK", category: "correctness", claim });
  it.each([
    // An object line encloses the inner `[]` line: that `[]` is no newest answer.
    [
      "an object line holding an inner `[]` line",
      '[]\n{"findings":[{"severity":"BLOCK","category":"correctness","claim":"hidden","evidence":\n[]}]}',
      [],
    ],
    // Structure is read before any bound: 65 inner `[]` lines stay nested.
    [
      "65 inner `[]` lines in a glued object",
      `[]{"findings":[${JSON.stringify(block("kept"))},\n${Array.from({ length: 65 }, () => "[]").join(",\n")}]}`,
      ["BLOCK:kept"],
    ],
    // A closed fence that cannot be read beside a clean one.
    [
      "a closed fence cut inside its array",
      "```json\n[]\n```\n```json\n" + JSON.stringify([block("cut")]).slice(0, -1) + "\n```",
      [],
    ],
    // A JSON-looking value closed on the wrong bracket, bare or after a clean fence.
    ["a wrong closer after `[]`", '[]\n{"severity":"BLOCK"]', []],
    ["a wrong closer after a clean fence", "```json\n[]\n```\n" + '{"severity":"BLOCK"]', []],
    [
      "a wrong closer after a finding",
      `${JSON.stringify([block("kept")])}\n{"severity":"BLOCK"]`,
      ["BLOCK:kept"],
    ],
    // JSON of the wrong schema after the answer, and a finding kept beside it.
    ["an unknown object after `[]`", '[]\n{"verdict":"clean"}', []],
    ["a finding without a severity after `[]`", '[]Also: [{"claim":"no severity"}]', []],
    [
      "an unknown object after a finding",
      `${JSON.stringify([block("kept")])}\n{"note":"x"}`,
      ["BLOCK:kept"],
    ],
  ] as const)(
    "an AGY result with %s is never a clean review; read findings stay",
    async (_label, whole, kept) => {
      const out = await review(
        agyReviewer([whole.slice(0, 2), { tool: 1 }, whole.slice(2)], {
          status: "SUCCESS",
          response: whole,
        }),
        "01-agy",
      );
      expect(out.res.healthyProviders).toEqual([]);
      const found = claims(out.res);
      expect(found.filter((claim) => !claim.startsWith("INSUFFICIENT_EVIDENCE:"))).toEqual(kept);
      expect(
        found.some((claim) => /^INSUFFICIENT_EVIDENCE:Reviewer produced \d+ malformed/.test(claim)),
      ).toBe(true);
      expect(out.transcript).toBe(`${whole}\n${whole}\n`);
    },
  );

  it("control: a sealed review keeps its strict one-object boundary", async () => {
    const { artifactsDir, cwd, evidenceDir } = workspace();
    execFileSync(
      "git",
      ["-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", "init", "-q"],
      {
        cwd,
      },
    );
    writeFileSync(join(evidenceDir, "DIFF.patch"), diff);
    writeFileSync(join(evidenceDir, "DIFF_SUMMARY.md"), "one file changed\n");
    const res = await reviewCandidate({
      candidateLabel: "Release candidate",
      diff,
      cwd,
      evidenceDir,
      evidenceReadOnly: true,
      artifactsDir,
      reviewers: [
        streamingReviewer(
          [],
          [{ type: "message", text: `[]${blockerText}`, final: true }, { type: "completed" }],
        ),
      ],
    });
    expect(res.healthyProviders).toEqual([]);
    expect(res.findings.map((f) => f.severity)).toEqual(["INSUFFICIENT_EVIDENCE"]);
    const read = (name: string) => readFileSync(join(artifactsDir, "01-fenced", name), "utf8");
    expect(JSON.parse(read("parsed-json-blocks.json"))).toEqual([]);
    expect(JSON.parse(read("parse-error.json"))).toMatchObject({
      error: "invalid_sealed_review_envelope",
    });
  });
});
