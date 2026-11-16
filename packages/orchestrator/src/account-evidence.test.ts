import { describe, expect, it } from "vitest";
import type {
  CredentialProfileStatus,
  CredentialUnusableObservation,
  QuotaSnapshot,
} from "@claudexor/schema";
import { composeCredentialProfileEvidence } from "./account-evidence.js";

const status: CredentialProfileStatus = {
  profile_id: "work",
  harness_id: "claude",
  availability: "available",
  verification: "passed",
  verification_source: "local_store",
  last_verified_at: null,
};
function refusal(over: Partial<CredentialUnusableObservation> = {}): CredentialUnusableObservation {
  return {
    harness_id: "claude",
    profile_id: "work",
    credential_route: "vendor_native",
    model: null,
    code: "auth_revoked",
    source: "attempt_stream",
    detail: "rejected",
    observed_at: new Date(Date.now() - 10000).toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    ...over,
  };
}
const evidence = (unusable: CredentialUnusableObservation[]) => ({
  unusable,
  route: "vendor_native" as const,
});
describe("shared account evidence composition", () => {
  it("current bound vendor success covers older poll rejection without changing quota data", () => {
    const negative = refusal();
    const quota = {
      snapshots: [],
      absences: [
        {
          subject: {
            harness: "claude",
            subject_id: "work",
            credential_route: "vendor_native" as const,
            plan_label: null,
          },
          reason: "auth_revoked" as const,
          observed_at: negative.observed_at,
          detail: "old poll rejection",
        },
      ],
      honored: [
        {
          harness_id: "claude",
          profile_id: "work",
          credential_route: "vendor_native" as const,
          model: null,
          observed_at: new Date().toISOString(),
        },
      ],
    };
    expect(
      composeCredentialProfileEvidence(status, { ...evidence([negative]), quota }).verification,
    ).toBe("passed");
    expect(quota.absences).toHaveLength(1);
    expect(
      composeCredentialProfileEvidence(status, {
        ...evidence([negative]),
        quota: {
          ...quota,
          honored: quota.honored.map((item) => ({
            ...item,
            credential_route: "managed_api_key" as const,
          })),
        },
      }).verification,
    ).toBe("failed");
    expect(
      composeCredentialProfileEvidence(
        { ...status, verification: "failed", verification_source: "local_store" },
        { ...evidence([]), quota },
      ).verification,
    ).toBe("failed");
  });
  it("applies credential-wide evidence to Accounts while preserving local provenance", () => {
    expect(composeCredentialProfileEvidence(status, evidence([refusal()]))).toMatchObject({
      verification: "failed",
      verification_source: "vendor",
    });
    expect(
      composeCredentialProfileEvidence(
        status,
        evidence([refusal({ source: "local_probe", code: "verification_failed" })]),
      ),
    ).toMatchObject({ verification: "failed", verification_source: "local_store" });
  });
  it("model-only and route-only refusals do not poison unrelated choices", () => {
    const scoped = evidence([refusal({ model: "model-a", code: "capability_refused" })]);
    expect(composeCredentialProfileEvidence(status, scoped).verification).toBe("passed");
    expect(
      composeCredentialProfileEvidence(status, { ...scoped, model: "model-a" }).verification,
    ).toBe("failed");
    expect(
      composeCredentialProfileEvidence(status, { ...scoped, model: "model-b" }).verification,
    ).toBe("passed");
    expect(
      composeCredentialProfileEvidence(status, {
        ...evidence([refusal()]),
        route: "managed_api_key",
      }).verification,
    ).toBe("passed");
  });
  it("the production composition ignores expired and other-subject refusals", () => {
    for (const observation of [
      refusal({ expires_at: new Date(Date.now() - 1).toISOString() }),
      refusal({ profile_id: "other" }),
      refusal({ harness_id: "codex" }),
    ])
      expect(composeCredentialProfileEvidence(status, evidence([observation])).verification).toBe(
        "passed",
      );
    expect(composeCredentialProfileEvidence(status, evidence([refusal()])).verification).toBe(
      "failed",
    );
  });
  it("full authenticated matching newer quota covers auth independently of numeric freshness", () => {
    const snapshot: QuotaSnapshot = {
      subject: {
        harness: "claude",
        credential_route: "vendor_native",
        subject_id: "work",
        plan_label: null,
      },
      constraints: [],
      source: "claude_oauth_usage",
      observed_at: new Date().toISOString(),
      freshness: "fresh",
    };
    const composed = (over: Partial<QuotaSnapshot>) =>
      composeCredentialProfileEvidence(status, {
        ...evidence([refusal()]),
        quota: { snapshots: [{ ...snapshot, ...over }], absences: [] },
      });
    expect(composed({}).verification).toBe("passed");
    expect(composed({ freshness: "stale" }).verification).toBe("passed");
    expect(composed({ source: "claude_statusline" }).verification).toBe("failed");
    expect(composed({ source: "claude_rate_limit_event" }).verification).toBe("failed");
    expect(composed({ source: "codex_app_server_event" }).verification).toBe("failed");
    expect(
      composeCredentialProfileEvidence(status, {
        ...evidence([refusal({ model: "model-a", code: "capability_refused" })]),
        model: "model-a",
        quota: { snapshots: [snapshot], absences: [] },
      }).verification,
    ).toBe("failed");
  });
  it("newer authenticated quota lifts only an auth rejection, never a vendor verification hold", () => {
    const hold = refusal({ code: "capability_refused", detail: "verification_required" });
    const later = new Date().toISOString();
    const quota = {
      snapshots: [
        {
          subject: {
            harness: "claude",
            credential_route: "vendor_native" as const,
            subject_id: "work",
            plan_label: null,
          },
          constraints: [],
          source: "claude_oauth_usage" as const,
          observed_at: later,
          freshness: "fresh" as const,
        },
      ],
      absences: [],
      honored: [
        {
          harness_id: "claude",
          profile_id: "work",
          credential_route: "vendor_native" as const,
          model: null,
          observed_at: later,
        },
      ],
    };
    expect(composeCredentialProfileEvidence(status, { ...evidence([hold]), quota })).toMatchObject({
      verification: "failed",
      detail: "verification_required",
    });
    // The same evidence recovers an auth rejection (its own rule); the hold ends
    // only by expiry, a credential change, or service the ledger itself covers.
    expect(
      composeCredentialProfileEvidence(status, { ...evidence([refusal()]), quota }).verification,
    ).toBe("passed");
  });
});
