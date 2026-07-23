import { describe, expect, it } from "vitest";
import { EffortHint } from "@claudexor/schema";
import { normalizeEffort } from "./effort.js";

describe("normalizeEffort", () => {
  it("passes an exactly-supported level through unchanged", () => {
    expect(normalizeEffort("high", ["low", "medium", "high"])).toBe("high");
    expect(normalizeEffort("low", ["low", "medium", "high"])).toBe("low");
  });

  it("clamps a too-strong request DOWN to the strongest supported level", () => {
    // xhigh is above the ceiling of [low,medium,high] -> high (the claude bug fix).
    expect(normalizeEffort("xhigh", ["low", "medium", "high"])).toBe("high");
    // max above a [..,xhigh] ceiling -> xhigh (the codex max->xhigh behavior).
    expect(normalizeEffort("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
  });

  it("clamps a too-weak request UP to the weakest supported level", () => {
    expect(normalizeEffort("low", ["high", "xhigh"])).toBe("high");
  });

  it("clamps an interior gap to the nearest rank (ties -> the cheaper level)", () => {
    // medium (rank 1) is equidistant from low (0) and high (2) -> the lower wins.
    expect(normalizeEffort("medium", ["low", "high"])).toBe("low");
    // xhigh (rank 3) between high(2) and max(4) is a tie -> high (cheaper).
    expect(normalizeEffort("xhigh", ["high", "max"])).toBe("high");
  });

  it("returns null when effort is not a tunable surface (empty supported)", () => {
    expect(normalizeEffort("high", [])).toBeNull();
    expect(normalizeEffort("max", [])).toBeNull();
  });

  it("returns null when nothing was requested", () => {
    expect(normalizeEffort(null, ["low", "medium", "high"])).toBeNull();
    expect(normalizeEffort(undefined, ["low", "medium", "high"])).toBeNull();
  });
});

describe("expanded vocabulary: minimal and ultra (official vendor ladders)", () => {
  it("orders the full vocabulary weakest -> strongest", () => {
    // Declaration order IS rank (EFFORT_LADDER = EffortHintSchema.options);
    // this pins the wire-contract ordering after adding the two new levels.
    expect(EffortHint.options).toEqual([
      "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
    ]);
  });

  it("xhigh passes through a claude-shaped ladder unchanged (regression: the old 4-level ladder silently downgraded xhigh to high)", () => {
    const CLAUDE = ["low", "medium", "high", "xhigh", "max"] as const;
    expect(normalizeEffort("xhigh", CLAUDE)).toBe("xhigh");
  });

  it("ultra clamps DOWN to max on a ladder without ultra (claude)", () => {
    const CLAUDE = ["low", "medium", "high", "xhigh", "max"] as const;
    expect(normalizeEffort("ultra", CLAUDE)).toBe("max");
  });

  it("max and ultra pass through a codex-shaped ladder (regression: the old ladder clamped max to xhigh, under-driving models that accept max/ultra)", () => {
    const CODEX = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
    expect(normalizeEffort("max", CODEX)).toBe("max");
    expect(normalizeEffort("ultra", CODEX)).toBe("ultra");
  });

  it("minimal clamps UP to low on ladders that exclude it (gpt-5.6-sol rejects minimal with unsupported_value)", () => {
    const CODEX = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
    expect(normalizeEffort("minimal", CODEX)).toBe("low");
  });
});
