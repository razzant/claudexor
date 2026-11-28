import { describe, expect, it } from "vitest";
import { deliveryEffectsStatement } from "./delivery.js";

describe("what a delivery that did not apply did", () => {
  const refusal = { code: "space_insufficient", paths: ["dir"] };

  it("never says nothing was written of a target that changed with no path completed", () => {
    const text = deliveryEffectsStatement({
      applied: false,
      appliedPaths: [],
      treeMutated: true,
      detail: "file apply ran out of space",
      refusal,
    });
    expect(text).toBe(
      "file apply ran out of space Refusal: space_insufficient at dir. No path completed, but the target changed at dir: inspect it.",
    );
    expect(text).not.toContain("Nothing was written");
  });

  it("names completed writes apart from the path it stopped at", () => {
    expect(
      deliveryEffectsStatement({
        applied: false,
        appliedPaths: ["a.txt"],
        treeMutated: true,
        refusal,
      }),
    ).toBe(
      "Refusal: space_insufficient at dir. Completed before it stopped: a.txt. Where it stopped, the target may already be changed.",
    );
  });

  it("says nothing was written only of an unchanged target", () => {
    expect(
      deliveryEffectsStatement({ applied: false, appliedPaths: [], treeMutated: false, refusal }),
    ).toBe("Refusal: space_insufficient at dir. Nothing was written.");
    expect(deliveryEffectsStatement({ applied: true, detail: "done" })).toBe("done");
  });
});
