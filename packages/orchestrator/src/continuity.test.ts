import { describe, expect, it } from "vitest";
import {
  buildContinuation,
  planContinuation,
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
