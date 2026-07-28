import { describe, expect, it, vi } from "vitest";
import {
  ACP_MAX_REPLAY_TURNS,
  projectTerminalTurnDetail,
  selectReplayTurns,
  typedFetchReason,
} from "./acp-surface-runner.js";

const addr = { baseUrl: "http://127.0.0.1:1", token: "t" } as never;

// The post-terminal detail read DEGRADES: a finished ACP turn must never become
// a JSON-RPC error that loses the runId — the terminal answer survives and the
// typed problem rides the result as detailProblem.
describe("projectTerminalTurnDetail (post-terminal degrade)", () => {
  it("carries a typed detailProblem instead of raising when the detail read fails", async () => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockRejectedValue(
      Object.assign(new Error("canonical RunFacts receipt is invalid"), {
        code: "run_facts_invalid",
        retryable: false,
      }),
    );
    try {
      await expect(projectTerminalTurnDetail(addr, "run-1")).resolves.toEqual({
        applyEligibility: null,
        planReadiness: null,
        planQuestions: [],
        detailProblem: {
          code: "run_facts_invalid",
          message: "canonical RunFacts receipt is invalid",
          retryable: false,
        },
      });
    } finally {
      detailSpy.mockRestore();
    }
  });

  it("projects eligibility, readiness, and questions from ONE detail read", async () => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue({
      applyEligibility: {
        eligible: false,
        state: "needs_review",
        reason: null,
        requiredAction: null,
      },
      planReadiness: { state: "needs_answers", questionCount: 1 },
      planQuestions: [{ id: "q1" }],
    });
    try {
      await expect(projectTerminalTurnDetail(addr, "run-1")).resolves.toEqual({
        applyEligibility: {
          eligible: false,
          state: "needs_review",
          reason: null,
          requiredAction: null,
        },
        planReadiness: { state: "needs_answers", questionCount: 1 },
        planQuestions: [{ id: "q1" }],
      });
      expect(detailSpy).toHaveBeenCalledTimes(1);
    } finally {
      detailSpy.mockRestore();
    }
  });

  it("projects null fields for a missing/legacy detail and skips the read without a runId", async () => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue(null);
    try {
      await expect(projectTerminalTurnDetail(addr, "run-1")).resolves.toEqual({
        applyEligibility: null,
        planReadiness: null,
        planQuestions: [],
      });
      await expect(projectTerminalTurnDetail(addr, "")).resolves.toEqual({
        applyEligibility: null,
        planReadiness: null,
        planQuestions: [],
      });
      expect(detailSpy).toHaveBeenCalledTimes(1);
    } finally {
      detailSpy.mockRestore();
    }
  });
});

// W5: the ACP session/load replay is bounded, and a failed per-turn detail
// fetch discloses a typed reason instead of vanishing.
describe("ACP load-replay bounding (W5)", () => {
  it("keeps every turn when the thread is within the cap", () => {
    const turns = Array.from({ length: 10 }, (_, i) => i);
    const { replayTurns, omittedTurnCount } = selectReplayTurns(turns);
    expect(replayTurns).toEqual(turns);
    expect(omittedTurnCount).toBe(0);
  });

  it("keeps only the most recent N turns and reports the omitted count", () => {
    const total = ACP_MAX_REPLAY_TURNS + 12;
    const turns = Array.from({ length: total }, (_, i) => i);
    const { replayTurns, omittedTurnCount } = selectReplayTurns(turns);
    expect(replayTurns.length).toBe(ACP_MAX_REPLAY_TURNS);
    // The tail (most recent) is kept, in chronological order.
    expect(replayTurns[0]).toBe(12);
    expect(replayTurns.at(-1)).toBe(total - 1);
    expect(omittedTurnCount).toBe(12);
  });
});

describe("typedFetchReason (W5)", () => {
  it("prefers the typed control-API code", () => {
    expect(
      typedFetchReason(
        Object.assign(new Error("gone"), { code: "run_expired_by_retention", status: 410 }),
      ),
    ).toBe("run_expired_by_retention");
  });

  it("falls back to the HTTP status, then a generic marker", () => {
    expect(typedFetchReason(Object.assign(new Error("boom"), { status: 503 }))).toBe("http_503");
    expect(typedFetchReason(new Error("transport blew up"))).toBe("detail_unavailable");
    expect(typedFetchReason(undefined)).toBe("detail_unavailable");
  });
});
