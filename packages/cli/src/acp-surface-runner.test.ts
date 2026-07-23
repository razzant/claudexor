import { describe, expect, it } from "vitest";
import { ACP_MAX_REPLAY_TURNS, selectReplayTurns, typedFetchReason } from "./acp-surface-runner.js";

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
