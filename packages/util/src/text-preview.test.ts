import { describe, expect, it } from "vitest";
import { displayPreview } from "./text-preview.js";

describe("displayPreview: a bounded label with a visible cut (#651)", () => {
  it("keeps text that fits exactly", () => {
    expect(displayPreview("Which rollout?", 500)).toBe("Which rollout?");
    expect(displayPreview("x".repeat(500), 500)).toBe("x".repeat(500));
  });

  it("marks a cut with an ellipsis inside the bound", () => {
    const preview = displayPreview("x".repeat(501), 500);
    expect(preview).toBe(`${"x".repeat(499)}…`);
    expect(preview).toHaveLength(500);
  });

  it("never splits a surrogate pair at the cut", () => {
    // The rocket straddles the 499-unit prefix: it is dropped whole.
    const straddling = displayPreview(`${"x".repeat(498)}🚀${"y".repeat(10)}`, 500);
    expect(straddling).toBe(`${"x".repeat(498)}…`);
    expect(straddling).not.toMatch(/\p{Surrogate}/u);
    // Ending exactly at the prefix boundary, it is kept whole.
    expect(displayPreview(`${"x".repeat(497)}🚀${"y".repeat(10)}`, 500)).toBe(
      `${"x".repeat(497)}🚀…`,
    );
  });
});
