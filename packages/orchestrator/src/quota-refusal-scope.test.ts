import { describe, expect, it } from "vitest";
import { credentialPoolExhausted } from "./credential-cooldown.js";
import { quotaRefusalWithScope } from "./quota-refusal-scope.js";

describe("known request scope beside typed quota refusal", () => {
  it("retains exact model, request kind, subject and constraint without parsing prose", () => {
    const error = quotaRefusalWithScope(
      Object.assign(new Error("opaque vendor-independent message"), {
        code: "subscription_window_exhausted",
        resetsAt: null,
      }),
      {
        harness: "agy",
        profileId: "fixture",
        model: "model-that-must-not-change",
        requestKind: "image",
        constraintId: "3p-weekly",
      },
    );
    expect((error as any).problem.context).toEqual({
      resetsAt: null,
      subject: { harness: "agy", profile_id: "fixture" },
      model: "model-that-must-not-change",
      requestKind: "image",
      constraint_id: "3p-weekly",
    });
    expect(error.message).toBe("opaque vendor-independent message");
  });
  it("pool scope stays request-local and does not borrow a healthy sibling model", () => {
    const error = credentialPoolExhausted({
      harnessId: "agy",
      profileId: "fixture",
      model: "claude-opus-future",
      requestKind: "text",
      reason: "profile_headroom_preflight",
      subjectLimit: null,
      candidates: [],
    });
    expect((error as any).problem.context).toMatchObject({
      model: "claude-opus-future",
      requestKind: "text",
      subject: { harness: "agy", profile_id: "fixture" },
    });
  });
});
