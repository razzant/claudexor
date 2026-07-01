import { describe, expect, it } from "vitest";
import { assertCliRunParamsHaveNoInlineSecrets } from "./run-secret-scan.js";

describe("assertCliRunParamsHaveNoInlineSecrets", () => {
  it("rejects secret-like reviewer panel models before CLI run artifacts can persist them", () => {
    const secret = "sk-" + "a".repeat(24);

    expect(() =>
      assertCliRunParamsHaveNoInlineSecrets({
        reviewerPanel: [{ harness: "claude", model: secret }],
      }),
    ).toThrow(/CLI run params/);
  });

  it("rejects secret-like protected path approvals before TaskContract persistence", () => {
    const secret = "sk-or-v1-" + "b".repeat(40);

    expect(() =>
      assertCliRunParamsHaveNoInlineSecrets({
        protectedPathApprovals: [{ path: secret }],
      }),
    ).toThrow(/CLI run params/);
  });
});
