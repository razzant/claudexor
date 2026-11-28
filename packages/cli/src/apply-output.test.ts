import { describe, expect, it } from "vitest";
import { applyCheckRefusal, deliveryEffects } from "./apply-output.js";

describe("claudexor apply's human output", () => {
  it("states a refused delivery's stopped path and completed writes", () => {
    expect(
      deliveryEffects({
        mode: "apply",
        applied: false,
        appliedPaths: ["a.txt"],
        treeMutated: true,
        detail: "file apply ran out of space",
        refusal: { code: "space_insufficient", message: "no room", paths: ["big.bin"] },
      }),
    ).toBe(
      "file apply ran out of space Refusal: space_insufficient at big.bin. Completed before it stopped: a.txt. Where it stopped, the target may already be changed.",
    );
  });

  it("does not call a verification copy without room a conflict", () => {
    expect(
      applyCheckRefusal({
        ok: false,
        code: 1,
        stderr: "final verification ran out of space",
        refusal: { code: "space_insufficient", paths: [] },
      }),
    ).toBe("not confirmed (space_insufficient): final verification ran out of space");
    expect(applyCheckRefusal({ ok: false, code: 1, stderr: "conflict" })).toBe(
      "patch does not apply",
    );
  });
});
