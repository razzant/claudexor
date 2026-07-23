import { describe, expect, it } from "vitest";
import { revertRefusedProblem } from "./problem-response.js";

// W3 / QA-051: the revert-refusal CLASS comes from the producer's typed
// reasonCode, not from regexing the English message.
describe("revertRefusedProblem — typed reason from the producer (W3)", () => {
  it("uses the producer's typed reasonCode even when the message text disagrees", () => {
    // A localized/rewritten message that would NOT match the legacy regex; the
    // typed code still classifies it correctly.
    const p = revertRefusedProblem("git: локальная ошибка stderr", "postimage_diverged");
    expect(p.context.reason).toBe("postimage_diverged");
    expect(p.message).toContain("affected files changed after this turn");
    // The raw (redacted, bounded) vendor stderr rides as evidence, not as the message.
    expect(p.context.detail).toContain("stderr");
  });

  it("classifies reverse_apply_failed from the typed code", () => {
    const p = revertRefusedProblem("anything at all", "reverse_apply_failed");
    expect(p.context.reason).toBe("reverse_apply_failed");
    expect(p.message).toContain("could not be applied");
  });

  it("falls back to the English-prefix regex for a legacy result with no typed code", () => {
    expect(revertRefusedProblem("turn-owned postimage no longer matches; ...").context.reason).toBe(
      "postimage_diverged",
    );
    expect(revertRefusedProblem("reverse apply failed after preflight: ...").context.reason).toBe(
      "reverse_apply_failed",
    );
    expect(revertRefusedProblem(undefined).context.reason).toBe("reverse_apply_failed");
  });
});
