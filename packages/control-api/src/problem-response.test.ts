import { describe, expect, it } from "vitest";
import {
  controlProblemError,
  normalizeRequestValidationError,
  revertRefusedProblem,
} from "./problem-response.js";

describe("controlProblemError context projection", () => {
  it("keeps explicit context flat and merges legacy top-level recovery ids", () => {
    const error = controlProblemError(503, {
      code: "git_missing",
      message: "Git unavailable",
      retryable: true,
      context: { turnId: "tn-1", capability: "git" },
      threadId: "th-1",
    });
    expect(error.context).toEqual({
      threadId: "th-1",
      turnId: "tn-1",
      capability: "git",
    });
    expect(error.context).not.toHaveProperty("context");
  });
});

describe("request validation bounds", () => {
  it("bounds a huge attacker-controlled issue path without quadratic truncation", () => {
    const started = performance.now();
    const error = normalizeRequestValidationError({
      issues: [
        {
          code: "custom",
          path: ["x".repeat(10 * 1024 * 1024)],
          message: "invalid",
        },
      ],
    }) as Error & { fieldErrors: Record<string, string[]> };
    const elapsed = performance.now() - started;
    const [pointer] = Object.keys(error.fieldErrors);
    expect(Buffer.byteLength(pointer ?? "", "utf8")).toBeLessThanOrEqual(256);
    expect(elapsed).toBeLessThan(2_000);
  });
});

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

  // #535 R5 E1: an object revert's typed cause rides along; a fixed remedy is named.
  it("names a typed cause with a remedy, and keeps the code as context", () => {
    const sparse = revertRefusedProblem(
      "3 path(s) this revert must change are outside ...",
      "reverse_apply_failed",
      "delivery_outside_sparse_checkout",
    );
    expect(sparse.message).toContain("git sparse-checkout add");
    expect(sparse.context).toMatchObject({
      reason: "reverse_apply_failed",
      refusalCode: "delivery_outside_sparse_checkout",
    });
    const other = revertRefusedProblem("EACCES ...", "reverse_apply_failed", "git_failed");
    expect(other.message).toBe("Revert could not be applied to the current project tree.");
    expect(other.context.refusalCode).toBe("git_failed");
    const diverged = revertRefusedProblem("overlap", "postimage_diverged", "revert_conflict");
    expect(diverged.message).toContain("changed after this turn");
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
