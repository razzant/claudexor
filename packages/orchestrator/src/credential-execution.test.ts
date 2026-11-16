import { describe, expect, it } from "vitest";
import {
  HarnessRunSpec,
  type HarnessEvent,
  type CredentialUnusableObservation,
} from "@claudexor/schema";
import { observeCredentialExecution, type CredentialExecutionSubject } from "@claudexor/core";
import { CredentialGeneration } from "../../daemon/src/credential-generation.js";
import { CredentialUnusableLedger } from "../../daemon/src/credential-unusable-ledger.js";
import { createCredentialExecutionObserver } from "./credential-execution.js";

function observerFactory(ledger: CredentialUnusableLedger) {
  return (subject: CredentialExecutionSubject) =>
    createCredentialExecutionObserver(ledger, ledger.bind(subject));
}

const subject: CredentialExecutionSubject = {
  harnessId: "claude",
  profileId: "work",
  route: "vendor_native",
  requestedModel: "model-a",
};
const event = (over: Partial<HarnessEvent>): HarnessEvent => ({
  type: "status",
  session_id: "session-1",
  ts: new Date().toISOString(),
  credential_route: "vendor_native",
  credential_profile_id: "work",
  ...over,
});
const auth = () =>
  event({ status: { kind: "api_retry", error_category: "authentication_failed" } });
const failed = () => event({ type: "completed", payload: { exit_code: 1 } });
const served = (model?: string) =>
  event({
    type: "usage",
    usage: { input_tokens: 10, output_tokens: 2 },
    ...(model ? { observed_model: model } : {}),
  });
const observation = (
  over: Partial<CredentialUnusableObservation> = {},
): CredentialUnusableObservation => ({
  harness_id: "claude",
  profile_id: "work",
  credential_route: "vendor_native",
  model: null,
  code: "auth_revoked",
  source: "attempt_stream",
  detail: "authentication_failed",
  observed_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  ...over,
});

describe("dispatch-bound credential intake", () => {
  it("failed native result usage before error never heals its typed auth refusal", () => {
    const ledger = new CredentialUnusableLedger();
    const observer = createCredentialExecutionObserver(ledger, ledger.bind(subject));
    observer.observe(auth());
    observer.observe(served("model-a"));
    observer.observe(event({ type: "error", error: "result failed" }));
    observer.observe(failed());
    observer.finish();
    expect(ledger.live()).toMatchObject([{ code: "auth_revoked" }]);
    expect(ledger.honored()).toEqual([]);
  });
  it("old catalog proof never clears or restamps newer refusal", () => {
    const ledger = new CredentialUnusableLedger();
    const negative = observation();
    ledger.record(negative);
    const binding = ledger.bind(subject);
    ledger.honorBound(
      binding,
      null,
      new Date(Date.parse(negative.observed_at) - 1000).toISOString(),
    );
    expect(ledger.live()).toHaveLength(1);
    expect(ledger.honored()).toEqual([]);
    ledger.honorBound(
      binding,
      null,
      new Date(Date.parse(negative.observed_at) + 1000).toISOString(),
    );
    expect(ledger.live()).toEqual([]);
  });
  it("retains received typed refusal on stream failure, without classifying the exception", async () => {
    const ledger = new CredentialUnusableLedger();
    const spec = HarnessRunSpec.parse({
      session_id: "session-1",
      intent: "explain",
      prompt: "fixture",
      cwd: "/tmp",
      auth_preference: "subscription",
    });
    const factory = observerFactory(ledger);
    const failure = new Error("transport fixture");
    async function* source(withAuth: boolean): AsyncGenerator<HarnessEvent> {
      if (withAuth) yield { ...auth(), credential_profile_id: undefined };
      throw failure;
    }
    async function consume(withAuth: boolean) {
      for await (const _event of observeCredentialExecution(
        "claude",
        spec,
        source(withAuth),
        factory,
      )) {
      }
    }
    await expect(consume(false)).rejects.toBe(failure);
    expect(ledger.live()).toEqual([]);
    await expect(consume(true)).rejects.toBe(failure);
    expect(ledger.live()).toMatchObject([{ profile_id: null, code: "auth_revoked" }]);
  });
  it("retains a typed failure before the consumer returns, with no rotation dependency", async () => {
    const ledger = new CredentialUnusableLedger();
    const spec = HarnessRunSpec.parse({
      session_id: "session-1",
      intent: "implement",
      prompt: "fixture",
      cwd: "/tmp",
      credential_profile: {
        profile_id: "work",
        harness_id: "claude",
        credential_kind: "config_dir_login",
        display_name: "Work",
        isolation_locator: "/tmp/work",
        enabled: true,
      },
      model_hint: "model-a",
    });
    async function* source() {
      yield auth();
      yield event({ type: "error", error: "typed failure" });
      throw new Error("consumer must not reach this");
    }
    for await (const value of observeCredentialExecution(
      "claude",
      spec,
      source(),
      observerFactory(ledger),
    ))
      if (value.type === "error") break;
    expect(ledger.live()).toMatchObject([
      { profile_id: "work", credential_route: "vendor_native", code: "auth_revoked" },
    ]);
  });

  it("does not poison a recovered native retry, or infer rejection from cancellation", () => {
    const ledger = new CredentialUnusableLedger();
    const recovered = createCredentialExecutionObserver(ledger, ledger.bind(subject));
    recovered.observe(auth());
    recovered.observe(served());
    recovered.observe(event({ type: "completed", payload: { exit_code: 0 } }));
    recovered.finish();
    expect(ledger.live()).toEqual([]);
    const cancelled = createCredentialExecutionObserver(ledger, ledger.bind(subject));
    cancelled.observe(event({ type: "completed", payload: { aborted: true } }));
    cancelled.finish();
    expect(ledger.live()).toEqual([]);
    const rejected = createCredentialExecutionObserver(ledger, ledger.bind(subject));
    rejected.observe(auth());
    rejected.observe(failed());
    rejected.finish();
    expect(ledger.live()).toHaveLength(1);
  });

  it("a verification hold is recorded account-wide only from a failed terminal, never a recovered or cancelled try", () => {
    const held = () =>
      event({
        status: { kind: "api_retry", error_category: "verification_required" },
        payload: { entitlement_denied: true },
      });
    const ledger = new CredentialUnusableLedger();
    const recovered = createCredentialExecutionObserver(ledger, ledger.bind(subject));
    recovered.observe(held());
    recovered.observe(served());
    recovered.observe(event({ type: "completed", payload: { exit_code: 0 } }));
    recovered.finish();
    expect(ledger.live()).toEqual([]);
    const cancelled = createCredentialExecutionObserver(ledger, ledger.bind(subject));
    cancelled.observe(held());
    cancelled.observe(event({ type: "completed", payload: { aborted: true } }));
    cancelled.finish();
    expect(ledger.live()).toEqual([]);
    const refused = createCredentialExecutionObserver(ledger, ledger.bind(subject));
    refused.observe(held());
    refused.observe(event({ type: "error", error: "held" }));
    refused.observe(failed());
    refused.finish();
    expect(ledger.live()).toMatchObject([
      {
        profile_id: "work",
        credential_route: "vendor_native",
        model: null,
        code: "capability_refused",
        detail: "verification_required",
      },
    ]);
    // Served usage reported before the failed result is no recovery.
    expect(ledger.honored()).toEqual([]);
  });

  it("unknown served model clears auth but never clears model-specific capability", () => {
    const ledger = new CredentialUnusableLedger();
    ledger.record(observation());
    ledger.record(observation({ model: "model-a", code: "capability_refused" }));
    const observer = createCredentialExecutionObserver(ledger, ledger.bind(subject));
    observer.observe(served());
    observer.finish();
    expect(ledger.live()).toMatchObject([{ code: "capability_refused", model: "model-a" }]);
    const actual = createCredentialExecutionObserver(ledger, ledger.bind(subject));
    actual.observe(event({ type: "started", observed_model: "model-a" }));
    actual.observe(served());
    actual.finish();
    expect(ledger.live()).toEqual([]);
  });

  it("uses managed generation for both late refusal and late success, including default/API", () => {
    const credentials = new CredentialGeneration();
    const ledger = new CredentialUnusableLedger(undefined, undefined, credentials);
    for (const route of ["vendor_native", "managed_api_key"] as const) {
      const binding = ledger.bind({ ...subject, profileId: null, route });
      credentials.clearSubject("claude", null);
      ledger.recordBound(binding, observation({ profile_id: null, credential_route: route }));
      expect(ledger.live()).toEqual([]);
      ledger.record(observation({ profile_id: null, credential_route: route }));
      ledger.honorBound(binding, null);
      expect(ledger.live()).toHaveLength(1);
      ledger.clearSubject("claude", null);
    }
  });

  it("equal-time older concurrent results cannot overwrite or clear the newer dispatch refusal", () => {
    const ledger = new CredentialUnusableLedger();
    const older = ledger.bind(subject),
      newer = ledger.bind(subject);
    // Equal observation times isolate dispatch order from later-contact provenance.
    const refusal = observation();
    ledger.recordBound(newer, { ...refusal, detail: "newer" });
    ledger.recordBound(older, { ...refusal, detail: "older" });
    ledger.honorBound(older, null);
    expect(ledger.live()[0].detail).toBe("newer");
    ledger.honorBound(ledger.bind(subject), null);
    expect(ledger.live()).toEqual([]);
  });

  it("a late old failure cannot recreate refusal after newer success", () => {
    const ledger = new CredentialUnusableLedger();
    const older = ledger.bind(subject),
      newer = ledger.bind(subject);
    const delayedAuth = observation(),
      delayedCapability = observation({ model: "model-a", code: "capability_refused" });
    ledger.honorBound(newer, "model-a");
    ledger.recordBound(older, delayedAuth);
    ledger.recordBound(older, delayedCapability);
    expect(ledger.live()).toEqual([]);
    ledger.recordBound(ledger.bind(subject), observation());
    expect(ledger.live()).toHaveLength(1);
  });
  it("positive view contains only the managed generation that actually served", () => {
    const ledger = new CredentialUnusableLedger();
    const binding = ledger.bind(subject);
    ledger.honorBound(binding, "model-a");
    expect(ledger.honored()).toMatchObject([
      { profile_id: "work", credential_route: "vendor_native", model: null },
      { model: "model-a" },
    ]);
    ledger.clearSubject("claude", "work");
    ledger.honorBound(binding, "model-a");
    expect(ledger.honored()).toEqual([]);
  });
  it("success on another model or route does not recover the refused scope", () => {
    const ledger = new CredentialUnusableLedger();
    const scoped = createCredentialExecutionObserver(ledger, ledger.bind(subject));
    scoped.observe(event({ status: { kind: "api_retry", error_category: "model_not_found" } }));
    scoped.observe(served("model-b"));
    scoped.observe(event({ type: "completed", payload: { exit_code: 0 } }));
    scoped.finish();
    expect(ledger.live()).toMatchObject([{ model: "model-a", code: "capability_refused" }]);
    ledger.noteCredentialChange();
    const fallback = createCredentialExecutionObserver(
      ledger,
      ledger.bind({ ...subject, route: null }),
    );
    fallback.observe(auth());
    fallback.observe({ ...served("model-a"), credential_route: "managed_api_key" });
    fallback.observe(
      event({ type: "completed", credential_route: "managed_api_key", payload: { exit_code: 0 } }),
    );
    fallback.finish();
    expect(ledger.live()).toMatchObject([
      { credential_route: "vendor_native", code: "auth_revoked" },
    ]);
  });
});
