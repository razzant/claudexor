import { describe, expect, it } from "vitest";
import { retainedOutput } from "@claudexor/event-log";
import type { RunEvent } from "@claudexor/schema";
import {
  buildContinuation,
  planContinuation,
  PER_TURN_BUDGET_BYTES,
  TOTAL_BUDGET_BYTES,
  type ContinuityRequest,
  type ContinuityTurn,
} from "./continuity.js";

const LANE_A = { harness: "claude", profileId: null };
const LANE_B = { harness: "codex", profileId: null };

function turn(id: string, prompt: string, outputText = `output of ${id}`): ContinuityTurn {
  return { id, prompt, outputText };
}

function req(overrides: Partial<ContinuityRequest>): ContinuityRequest {
  return {
    lane: LANE_A,
    priorTurns: [],
    laneCheckpointTurnId: null,
    nativeResumeAvailable: false,
    priorHeadLane: null,
    activePlan: null,
    anchor: null,
    ...overrides,
  };
}

describe("continuity checkpoint math (INV-137)", () => {
  it("a thread's first turn is fresh — no packet, no delta", () => {
    const r = buildContinuation(req({ priorTurns: [] }));
    expect(r.disclosure.kind).toBe("fresh");
    expect(r.disclosure.packetTurns).toBe(0);
    expect(r.packetMarkdown).toBeNull();
  });

  it("in-lane native resume with checkpoint == head-1 gets NO packet", () => {
    // priorTurns excludes the current turn; its last entry IS head-1.
    const prior = [turn("t1", "one"), turn("t2", "two")];
    const r = buildContinuation(
      req({
        priorTurns: prior,
        laneCheckpointTurnId: "t2",
        nativeResumeAvailable: true,
      }),
    );
    expect(r.disclosure.kind).toBe("native_resume");
    expect(r.disclosure.packetTurns).toBe(0);
    expect(r.packetMarkdown).toBeNull();
  });

  it("a gap (checkpoint older than head) carries only the delta as a packet", () => {
    const prior = [turn("t1", "one"), turn("t2", "two"), turn("t3", "three")];
    const r = buildContinuation(
      req({
        priorTurns: prior,
        laneCheckpointTurnId: "t1",
        nativeResumeAvailable: true,
      }),
    );
    expect(r.disclosure.kind).toBe("packet");
    // delta = turns AFTER t1 = [t2, t3]
    expect(r.disclosure.packetTurns).toBe(2);
    expect(r.packetMarkdown).toContain("two");
    expect(r.packetMarkdown).toContain("three");
    expect(r.packetMarkdown).not.toContain("### Turn 1\n\n**User asked:**\n\none");
  });

  it("a lane that never ran (no checkpoint, no native resume) carries the whole prior conversation", () => {
    const prior = [turn("t1", "one"), turn("t2", "two")];
    const r = buildContinuation(
      req({ priorTurns: prior, laneCheckpointTurnId: null, nativeResumeAvailable: false }),
    );
    expect(r.disclosure.kind).toBe("packet");
    expect(r.disclosure.packetTurns).toBe(2);
    expect(r.packetMarkdown).toContain("one");
    expect(r.packetMarkdown).toContain("two");
  });

  it("without a reachable native session the stale checkpoint is ignored — full packet", () => {
    // A→B→A degenerate: lane A's checkpoint says t2, but its session is gone
    // (nativeResumeAvailable=false) so the whole conversation must be re-sent.
    const prior = [turn("t1", "one"), turn("t2", "two"), turn("t3", "three")];
    const r = buildContinuation(
      req({
        priorTurns: prior,
        laneCheckpointTurnId: "t2",
        nativeResumeAvailable: false,
      }),
    );
    expect(r.disclosure.kind).toBe("packet");
    expect(r.disclosure.packetTurns).toBe(3);
  });

  it("names the lane switched away from when the prior head ran on another lane", () => {
    const prior = [turn("t1", "one"), turn("t2", "two")];
    const r = buildContinuation(
      req({
        lane: LANE_A,
        priorTurns: prior,
        laneCheckpointTurnId: null,
        nativeResumeAvailable: false,
        priorHeadLane: LANE_B,
      }),
    );
    expect(r.disclosure.kind).toBe("packet");
    expect(r.disclosure.laneSwitchedFrom).toEqual(LANE_B);
  });

  it("does NOT report a lane switch for an in-lane continuation", () => {
    const prior = [turn("t1", "one"), turn("t2", "two")];
    const r = buildContinuation(
      req({
        lane: LANE_A,
        priorTurns: prior,
        laneCheckpointTurnId: null,
        nativeResumeAvailable: false,
        priorHeadLane: LANE_A,
      }),
    );
    expect(r.disclosure.laneSwitchedFrom).toBeNull();
  });
});

describe("continuity packet budget + fallback (INV-137)", () => {
  it("collapses older turns to one-liners past the total budget and marks summarized", () => {
    // Each turn ~10 KiB verbatim; 6 turns blow the 24 KiB budget.
    const big = "x".repeat(6 * 1024);
    const prior = Array.from({ length: 6 }, (_, i) => turn(`t${i + 1}`, `prompt ${i + 1}`, big));
    const r = buildContinuation(
      req({ priorTurns: prior, laneCheckpointTurnId: null, nativeResumeAvailable: false }),
    );
    expect(r.disclosure.kind).toBe("packet");
    expect(r.disclosure.packetTurns).toBe(6);
    expect(r.disclosure.summarized).toBe(true);
    expect(r.packetMarkdown).toContain("condensed");
    // The oldest turn is a one-liner (prompt truncated), the newest verbatim.
    expect(r.packetMarkdown).toMatch(/- Turn 1 — user: prompt 1/);
    expect(Buffer.byteLength(r.packetMarkdown ?? "", "utf8")).toBeGreaterThan(0);
  });

  it("ends each one-line entry on a whole character within its 200-unit allowance (#577)", () => {
    // UTF-16 unit 200 cuts an emoji in half in `split`, falls between two
    // emoji in `aligned`, and is the exact end of `fits`.
    const split = `a${"😀".repeat(150)}`;
    const aligned = "😀".repeat(150);
    const fits = "😀".repeat(100);
    const big = "x".repeat(6 * 1024);
    const prior = [
      turn("t1", split, fits),
      turn("t2", aligned, "ok"),
      ...Array.from({ length: 4 }, (_, i) => turn(`t${i + 3}`, big, big)),
    ];
    const packet = buildContinuation(req({ priorTurns: prior })).packetMarkdown;
    expect(packet).toContain(`- Turn 1 — user: a${"😀".repeat(99)}… · assistant: ${fits}\n`);
    expect(packet).toContain(`- Turn 2 — user: ${"😀".repeat(100)}… · assistant: ok\n`);
    expect(packet).not.toMatch(/\p{Surrogate}/u);
  });

  it("keeps every turn verbatim and NOT summarized when under budget", () => {
    const prior = [turn("t1", "one", "short a"), turn("t2", "two", "short b")];
    const r = buildContinuation(
      req({ priorTurns: prior, laneCheckpointTurnId: null, nativeResumeAvailable: false }),
    );
    expect(r.disclosure.summarized).toBe(false);
    expect(r.packetMarkdown).toContain("**User asked:**");
    expect(r.packetMarkdown).not.toContain("condensed");
  });

  it("bounds a single oversized turn's verbatim content", () => {
    const huge = "y".repeat(TOTAL_BUDGET_BYTES * 2);
    const r = buildContinuation(
      req({
        priorTurns: [turn("t1", "big", huge)],
        laneCheckpointTurnId: null,
        nativeResumeAvailable: false,
      }),
    );
    expect(r.packetMarkdown).toContain("[truncated]");
  });

  it("appends the active plan pointer and workspace anchor sections", () => {
    const prior = [turn("t1", "one", "a")];
    const r = buildContinuation(
      req({
        priorTurns: prior,
        laneCheckpointTurnId: null,
        nativeResumeAvailable: false,
        activePlan: { path: "/runs/run-1/final/plan.md", readiness: "ready", planRunId: "run-1" },
        anchor: { headSha: "abc1234", dirtyCount: 2 },
      }),
    );
    expect(r.packetMarkdown).toContain("## Active plan");
    expect(r.packetMarkdown).toContain("/runs/run-1/final/plan.md");
    expect(r.packetMarkdown).toContain("readiness: ready");
    expect(r.packetMarkdown).toContain("## Workspace anchor");
    expect(r.packetMarkdown).toContain("abc1234");
    expect(r.packetMarkdown).toContain("2 file(s)");
  });
});

describe("continuity summary plan + injection (INV-137, V9c)", () => {
  const big = "x".repeat(6 * 1024);
  const collapsing = (): ContinuityTurn[] =>
    Array.from({ length: 6 }, (_, i) => turn(`t${i + 1}`, `prompt ${i + 1}`, big));

  it("planContinuation exposes the collapse boundary + collapsed prefix", () => {
    const plan = planContinuation(
      req({ priorTurns: collapsing(), laneCheckpointTurnId: null, nativeResumeAvailable: false }),
    );
    expect(plan.kind).toBe("packet");
    expect(plan.delta).toHaveLength(6);
    expect(plan.collapsedPrefix.length).toBeGreaterThan(0);
    // The boundary is the LAST collapsed turn's id — the summary cache key.
    expect(plan.summaryUpToTurnId).toBe(plan.collapsedPrefix[plan.collapsedPrefix.length - 1].id);
  });

  it("planContinuation reports no boundary when nothing collapses", () => {
    const plan = planContinuation(
      req({
        priorTurns: [turn("t1", "one", "short"), turn("t2", "two", "short")],
        laneCheckpointTurnId: null,
        nativeResumeAvailable: false,
      }),
    );
    expect(plan.summaryUpToTurnId).toBeNull();
    expect(plan.collapsedPrefix).toHaveLength(0);
  });

  it("planContinuation matches the boundary buildContinuation actually renders", () => {
    const request = req({
      priorTurns: collapsing(),
      laneCheckpointTurnId: null,
      nativeResumeAvailable: false,
    });
    const plan = planContinuation(request);
    // The mechanical packet collapses EXACTLY the planned prefix as one-liners.
    const mech = buildContinuation(request);
    expect(mech.disclosure.summarized).toBe(true);
    for (const t of plan.collapsedPrefix) {
      expect(mech.packetMarkdown).toContain(`user: ${t.prompt}`);
    }
  });

  it("a cached summary matching the boundary REPLACES the one-liner collapse", () => {
    const request = req({
      priorTurns: collapsing(),
      laneCheckpointTurnId: null,
      nativeResumeAvailable: false,
    });
    const plan = planContinuation(request);
    const r = buildContinuation({
      ...request,
      cachedSummary: {
        upToTurnId: plan.summaryUpToTurnId as string,
        text: "SUMMARY: decisions X, state Y, open item Z.",
      },
    });
    expect(r.disclosure.kind).toBe("packet");
    expect(r.disclosure.summarized).toBe(true);
    expect(r.packetMarkdown).toContain("## Earlier conversation (summary)");
    expect(r.packetMarkdown).toContain("SUMMARY: decisions X, state Y, open item Z.");
    expect(r.packetMarkdown).toContain("cached conversation summary below");
    // The collapsed prefix's one-liners are GONE (replaced by prose); the most
    // recent turn stays verbatim.
    expect(r.packetMarkdown).not.toMatch(/- Turn 1 — user: prompt 1/);
    expect(r.packetMarkdown).toContain("## Recent turns");
  });

  it("a STALE summary (boundary moved) is ignored — mechanical one-liners render", () => {
    const request = req({
      priorTurns: collapsing(),
      laneCheckpointTurnId: null,
      nativeResumeAvailable: false,
    });
    const r = buildContinuation({
      ...request,
      cachedSummary: { upToTurnId: "some-other-turn", text: "stale summary text" },
    });
    expect(r.packetMarkdown).not.toContain("stale summary text");
    expect(r.packetMarkdown).toMatch(/- Turn 1 — user: prompt 1/);
    expect(r.packetMarkdown).toContain("was unavailable");
  });

  it("a summary is never applied when the packet does not collapse", () => {
    const request = req({
      priorTurns: [turn("t1", "one", "short"), turn("t2", "two", "short")],
      laneCheckpointTurnId: null,
      nativeResumeAvailable: false,
    });
    const r = buildContinuation({
      ...request,
      cachedSummary: { upToTurnId: "t1", text: "should not appear" },
    });
    expect(r.disclosure.summarized).toBe(false);
    expect(r.packetMarkdown).not.toContain("should not appear");
    expect(r.packetMarkdown).not.toContain("(summary)");
  });
});

describe("#405 a turn without a final answer, past the output allowance", () => {
  const SOURCE = "/runs/run-1/final/retained-output.md";
  const LATEST = "LATEST-STATE: the deadline check belongs in retry.ts";
  const STEPS = Array.from({ length: 300 }, (_, i) => `step ${i}: nothing new.`);
  const LONG = `${STEPS.join("\n")}\n${LATEST}`;
  const NO_BROKEN_CHAR = /\uFFFD|\p{Surrogate}/u;
  const row = (seq: number, payload: Record<string, unknown>): RunEvent =>
    ({ seq, ts: "t", run_id: "r", task_id: "k", type: "harness.event", payload }) as RunEvent;
  /** The retained file event-log writes for one attempt that said `speech`. */
  const retainedFile = (speech: string): string => {
    const meta = { attempt_id: "a01", harness_id: "claude", session_id: "s1" };
    const events = [
      row(1, { ...meta, type: "started" }),
      row(2, { ...meta, type: "message", text: speech }),
    ];
    return retainedOutput(events) ?? "";
  };
  const unfinished = (outputText: string): ContinuityTurn => ({
    id: "t1",
    prompt: "audit the retry loop",
    outputText,
    noFinalAnswer: "ended",
    outputSource: SOURCE,
  });
  const big = "x".repeat(6 * 1024);
  const collapsing = (first: ContinuityTurn): ContinuityTurn[] => [
    first,
    ...Array.from({ length: 5 }, (_, i) => turn(`t${i + 2}`, big, big)),
  ];
  const packetOf = (priorTurns: ContinuityTurn[]): string =>
    buildContinuation(req({ priorTurns })).packetMarkdown ?? "";
  const line1 = (packet: string) => packet.split("\n").find((l) => l.startsWith("- Turn 1 "));

  it("keeps the newest end of its output in a verbatim entry and names the file holding it whole", () => {
    const whole = retainedFile(LONG).trim();
    const packet = packetOf([unfinished(retainedFile(LONG))]);
    const size = Buffer.byteLength(whole, "utf8");
    const mark = `[earlier output truncated; the whole output is ${size} bytes, complete in ${SOURCE}]\n…`;
    expect(packet).toContain(mark);
    const kept = packet.slice(packet.indexOf(mark) + mark.length).trimEnd();
    expect(whole.endsWith(kept)).toBe(true);
    expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(PER_TURN_BUDGET_BYTES / 2);
    expect(kept).toContain(LATEST);
    // The retained file's fixed preamble no longer spends the allowance.
    expect(packet).not.toContain("Attempts and physical sessions are kept separate.");
  });

  it("starts the kept end on a whole UTF-8 character", () => {
    for (const char of ["Ж", "中", "😀"]) {
      // Trailing ASCII moves where the kept end begins inside the wide characters.
      for (let pad = 0; pad < 4; pad += 1) {
        const text = `${char.repeat(3000)}${"a".repeat(pad)}`;
        const packet = packetOf([unfinished(text)]);
        const kept = packet.split(`complete in ${SOURCE}]\n…`)[1]!.trimEnd();
        const keptBytes = Buffer.byteLength(kept, "utf8");
        expect(text.endsWith(kept)).toBe(true);
        expect(keptBytes).toBeLessThanOrEqual(PER_TURN_BUDGET_BYTES / 2);
        expect(keptBytes).toBeGreaterThan(PER_TURN_BUDGET_BYTES / 2 - Buffer.byteLength(char));
        expect(packet).not.toMatch(NO_BROKEN_CHAR);
      }
    }
  });

  it("an answer keeps its start and names its file where cut; without a file the mark is unchanged", () => {
    const answer = `ANSWER-HEAD ${"z".repeat(9000)} ANSWER-END`;
    const file = "/runs/run-2/final/answer.md";
    const named = packetOf([{ ...turn("t1", "q", answer), outputSource: file }]);
    const size = Buffer.byteLength(answer, "utf8");
    expect(named).toContain("**The assistant answered:**\n\nANSWER-HEAD ");
    expect(named).toContain(
      `z\n…[truncated; the whole output is ${size} bytes, complete in ${file}]\n`,
    );
    expect(named).not.toContain("ANSWER-END");
    expect(packetOf([turn("t1", "q", answer)])).toContain("z\n…[truncated]\n");
  });

  it("a collapsed entry keeps the end of its output, not the retained file's preamble, and names the file", () => {
    const speech = `PARTIAL-SPEECH the retry loop ignores the deadline. ${LATEST}`;
    const line = line1(packetOf(collapsing(unfinished(retainedFile(speech)))));
    expect(line).toContain("assistant (ended without a final answer): …");
    expect(line).toContain(speech);
    expect(line).not.toContain("# Retained output");
    expect(line?.endsWith(` (whole output: ${SOURCE})`)).toBe(true);
    // An unfinished output that fits is shown whole, with no address.
    expect(line1(packetOf(collapsing(unfinished("short partial"))))).toBe(
      "- Turn 1 — user: audit the retry loop · assistant (ended without a final answer): short partial",
    );
    // An answered line is unchanged: its start, and no address.
    const answered = {
      ...turn("t1", "q", "y".repeat(500)),
      outputSource: "/runs/run-2/final/answer.md",
    };
    expect(line1(packetOf(collapsing(answered)))).toBe(
      `- Turn 1 — user: q · assistant: ${"y".repeat(200)}…`,
    );
  });

  it("a collapsed entry's kept end starts on a whole character", () => {
    const text = `${"😀".repeat(150)}b`; // its last 200 UTF-16 units begin with a low surrogate
    const packet = packetOf(collapsing(unfinished(text)));
    expect(line1(packet)).toBe(
      `- Turn 1 — user: audit the retry loop · assistant (ended without a final answer): …${"😀".repeat(99)}b (whole output: ${SOURCE})`,
    );
    expect(packet).not.toMatch(NO_BROKEN_CHAR);
  });
});
