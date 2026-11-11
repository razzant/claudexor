import { describe, expect, it, vi } from "vitest";
import {
  CredentialProfile,
  RunFailure,
  type HarnessEvent,
  type HarnessRunSpec,
  type PoolAttemptFailure,
} from "@claudexor/schema";
import type { AttemptOutputMarkers } from "./attemptOutputMarkers.js";
import {
  PoolAttemptEvidence,
  poolFailure,
  withPoolAttempts,
  withRotationAttempts,
} from "./pool-attempt-evidence.js";
import type { TransientFailureObservation } from "./transientClassify.js";

const secret = "ghp_" + "a".repeat(36);
// Only the try's account, requested model and dispatch gate are read from the spec.
const spec = (profileId: string | null, model: string | null = "model-m", gate?: () => void) =>
  ({
    extra: gate ? { markPhysicalDispatchStarted: gate } : {},
    model_hint: model,
    credential_profile: profileId
      ? CredentialProfile.parse({
          profile_id: profileId,
          harness_id: "stub",
          display_name: `Account ${profileId.toUpperCase()}`,
          credential_kind: "config_dir_login",
          isolation_locator: `/tmp/claudexor-pool-evidence/${profileId}`,
        })
      : null,
  }) as HarnessRunSpec;
/** Open a try and dispatch it, as the admission gate does right before its adapter runs. */
function dispatched(evidence: PoolAttemptEvidence, tried: HarnessRunSpec, tryIndex: number) {
  evidence.begin(tried, tryIndex);
  (tried.extra["markPhysicalDispatchStarted"] as () => void)();
}
const marks = (overrides: Partial<AttemptOutputMarkers> = {}): AttemptOutputMarkers => ({
  sawAgentProgress: false,
  fileChanges: 0,
  sawSessionStart: true,
  ...overrides,
});
const error = (text: string, overrides: Partial<HarnessEvent> = {}): HarnessEvent => ({
  type: "error",
  session_id: "ses",
  ts: "2026-10-13T08:00:00.000Z",
  error: text,
  ...overrides,
});
const transient = (
  category: TransientFailureObservation["category"],
): TransientFailureObservation => ({
  kind: "unknown",
  category,
  retryable: false,
  retryDelayMs: null,
  httpStatus: null,
  signal: null,
  adapterCode: null,
});
/** The try's own completion; an app-server turn carries no OS exit evidence (#414). */
const completed = (payload: Record<string, unknown>): HarnessEvent => ({
  type: "completed",
  session_id: "ses",
  ts: "2026-10-13T08:00:01.000Z",
  payload: { harness_reported_error: true, ...payload },
});
const failed = (overrides: Record<string, unknown> = {}) => ({
  harnessErrored: true,
  aborted: false,
  budgetStopped: false,
  requestRefused: false,
  originalError: null,
  newTransients: [] as TransientFailureObservation[],
  markers: marks(),
  ...overrides,
});

describe("PoolAttemptEvidence (per-try account attribution)", () => {
  it("keeps one row per actual failed try, in order, with each account's own text", () => {
    const evidence = new PoolAttemptEvidence("stub", "att-1");
    dispatched(evidence, spec("a"), 0);
    evidence.observe(error("You're out of usage.\n  Switch to Auto. "));
    evidence.observe(error("a later error is not the try's refusal"));
    evidence.settle(failed());
    evidence.settle(failed()); // a repeated settlement never duplicates the try
    dispatched(evidence, spec("b"), 1);
    evidence.observe(error("You have an unpaid invoice"));
    evidence.settle(failed());
    const rows = evidence.snapshot();
    expect(rows.map((row) => [row.profileId, row.tryIndex, row.error])).toEqual([
      ["a", 0, "You're out of usage.\n  Switch to Auto. "],
      ["b", 1, "You have an unpaid invoice"],
    ]);
    expect(rows[0]).toMatchObject({
      harnessId: "stub",
      attemptId: "att-1",
      profileDisplayName: "Account A",
      requestedModel: "model-m",
      observedAt: "2026-10-13T08:00:00.000Z",
      phase: "pre_progress",
      category: "unknown_harness_error",
      vendorFailure: null,
    });
    // Every row is a valid wire record inside RunFailure.
    expect(RunFailure.parse({ safeMessage: "x", poolAttempts: rows }).poolAttempts).toEqual(rows);
  });

  it.each([
    ["a cancelled try", { aborted: true }],
    ["a budget stop", { budgetStopped: true }],
    ["a request refusal", { requestRefused: true }],
    ["a successful try", { harnessErrored: false }],
  ])("records nothing for %s", (_label, facts) => {
    const evidence = new PoolAttemptEvidence("stub", "att-1");
    dispatched(evidence, spec("a"), 0);
    evidence.observe(error("boom"));
    evidence.settle(failed(facts));
    expect(evidence.snapshot()).toEqual([]);
  });

  it("never attributes a try whose own events name another account", () => {
    const evidence = new PoolAttemptEvidence("stub", "att-1");
    dispatched(evidence, spec("a"), 0);
    evidence.observe(error("refused", { credential_profile_id: "b" }));
    evidence.settle(failed());
    expect(evidence.snapshot()).toEqual([]);
  });

  it("a selected successor that never settled has no row", () => {
    const evidence = new PoolAttemptEvidence("stub", "att-1");
    dispatched(evidence, spec("a"), 0);
    evidence.observe(error("refused"));
    evidence.settle(failed());
    evidence.begin(spec("b"), 1); // chosen, then the lane stopped before it ran
    expect(evidence.snapshot().map((row) => row.profileId)).toEqual(["a"]);
  });

  it("only a dispatched try is physical; the gate's own callback fires once and is restored", () => {
    const gate = vi.fn();
    const evidence = new PoolAttemptEvidence("stub", "att-1");
    const first = spec("a", "model-m", gate);
    dispatched(evidence, first, 0);
    evidence.observe(error("refused"));
    evidence.settle(failed());
    expect(gate).toHaveBeenCalledTimes(1);
    // A successor copies the gate itself, never the settled try's observer.
    expect(first.extra["markPhysicalDispatchStarted"]).toBe(gate);
    // Its account's model inventory failed before the send was admitted.
    evidence.begin({ ...spec("b", "model-m"), extra: { ...first.extra } }, 1);
    const early = { markers: marks({ sawSessionStart: false }) };
    evidence.settle(failed({ ...early, originalError: "account model inventory unavailable" }));
    // An adapter that failed on entry after its dispatch did run on that account.
    dispatched(evidence, spec("c", "model-m", gate), 2);
    evidence.settle(failed({ ...early, originalError: "spawn ENOENT" }));
    expect(gate).toHaveBeenCalledTimes(2);
    expect(evidence.snapshot().map((row) => [row.profileId, row.tryIndex, row.phase])).toEqual([
      ["a", 0, "pre_progress"],
      ["c", 2, "pre_start"],
    ]);
  });

  it("names how far the try got, its typed category and its own vendor evidence, redacted", () => {
    const evidence = new PoolAttemptEvidence("stub", "att-1");
    dispatched(evidence, spec(null, null), 0);
    evidence.settle(failed({ markers: marks({ sawSessionStart: false }), originalError: secret }));
    dispatched(evidence, spec("a"), 1);
    evidence.observe(error(`token ${secret} rejected`));
    evidence.observe(
      completed({ vendor_failure: { code: secret, message: `bad ${secret}`, source: "x" } }),
    );
    evidence.settle(
      failed({
        markers: marks({ sawAgentProgress: true }),
        newTransients: [transient("timeout"), transient("auth_failed"), transient("process_crash")],
      }),
    );
    // A later try's completion speaks only for that try: a signal kill carries none.
    dispatched(evidence, spec("b"), 2);
    evidence.observe(
      completed({
        exit_signal: "SIGKILL",
        vendor_failure: { code: "x", message: null, source: "x" },
      }),
    );
    evidence.settle(failed());
    const [first, second, third] = evidence.snapshot();
    expect(first).toMatchObject({
      profileId: null,
      profileDisplayName: null,
      requestedModel: null,
      phase: "pre_start",
      category: "unknown_harness_error",
    });
    expect(first!.error).not.toContain(secret);
    expect(second).toMatchObject({ phase: "after_progress", category: "auth_failed" });
    expect(second!.error).toMatch(/^token .* rejected$/);
    expect(JSON.stringify(second)).not.toContain(secret);
    expect(second!.vendorFailure?.source).toBe("x");
    expect(first!.vendorFailure).toBeNull();
    expect(third!.vendorFailure).toBeNull();
  });

  it("keeps the vendor's last error line bounded and redacted on the pool terminal", () => {
    const evidence = new PoolAttemptEvidence("claude", "a01");
    dispatched(evidence, spec("a"), 0);
    evidence.observe(error("an earlier diagnostic"));
    evidence.observe(error(`API rejected this client.\nUpdate this program. token=${secret}`));
    evidence.settle(failed());
    const terminal = poolFailure("Credential pool exhausted", [
      { poolAttempts: evidence.snapshot() },
    ]);
    expect(terminal.poolAttempts[0]!.lastVendorError).toContain("Update this program.");
    expect(terminal.message).toContain("Update this program.");
    expect(terminal.message).toContain("an earlier diagnostic");
    expect(terminal.message).not.toContain(secret);
    expect(terminal.poolAttempts[0]!.lastVendorError!.length).toBeLessThanOrEqual(1000);
  });
  it.each(["An unpaid invoice\n  (team account)", "A single refusal."])(
    "keeps the complete original refusal without repeating its final line: %s",
    (message) => {
      const evidence = new PoolAttemptEvidence("cursor", "a01");
      dispatched(evidence, spec("a"), 0);
      evidence.observe(error(message));
      evidence.settle(failed());
      const terminal = poolFailure("Credential pool exhausted", [
        { poolAttempts: evidence.snapshot() },
      ]);
      expect(terminal.message).toContain(message);
      expect(terminal.message).not.toContain("Last vendor diagnostic:");
    },
  );
  it("takes each try's vendor failure from its own settled terminal, a zero exit included", () => {
    const evidence = new PoolAttemptEvidence("agy", "a01");
    const completed = (vendor_failure?: unknown): HarnessEvent => ({
      type: "completed",
      session_id: "ses",
      ts: "2026-10-13T08:00:00.000Z",
      payload: {
        exit_code: 0,
        harness_reported_error: true,
        ...(vendor_failure ? { vendor_failure } : {}),
      },
    });
    dispatched(evidence, spec("a"), 0);
    evidence.observe(error("first"));
    evidence.observe(completed({ code: "ERROR", message: "first", source: "agy_result" }));
    evidence.settle(failed());
    dispatched(evidence, spec("a"), 1);
    evidence.observe(error("second"));
    evidence.observe(completed());
    evidence.settle(failed());
    expect(evidence.snapshot().map((row) => row.vendorFailure)).toEqual([
      { code: "ERROR", message: "first", source: "agy_result" },
      null,
    ]);
  });

  it("a malformed event time falls back to the settlement clock instead of failing", () => {
    const evidence = new PoolAttemptEvidence(
      "stub",
      "att-1",
      () => new Date("2026-10-13T09:00:00.000Z"),
    );
    dispatched(evidence, spec("a"), 0);
    evidence.observe(error("refused", { ts: "not a time" }));
    expect(() => evidence.settle(failed())).not.toThrow();
    expect(evidence.snapshot()[0]!.observedAt).toBe("2026-10-13T09:00:00.000Z");
    // A thrown error has no error event: the lane's own text is the record.
    dispatched(evidence, spec("b"), 1);
    evidence.settle(failed({ originalError: "harness process exited (code 1)" }));
    expect(evidence.snapshot()[1]!.error).toBe("harness process exited (code 1)");
  });
});

const row = (profileId: string | null, error: string, tryIndex = 0): PoolAttemptFailure => ({
  harnessId: "stub",
  profileId,
  profileDisplayName: profileId,
  requestedModel: null,
  attemptId: "att-1",
  tryIndex,
  observedAt: "2026-10-13T08:00:00.000Z",
  phase: "pre_progress",
  category: "unknown_harness_error",
  error,
  vendorFailure: null,
});

describe("one rendering and one list for every failure terminal", () => {
  it("keeps the terminal message and appends every failed try in order", () => {
    expect(withPoolAttempts("harness failed", [])).toBe("harness failed");
    const text = withPoolAttempts("harness failed", [
      row("a", "out of usage"),
      row("b", "invoice", 1),
    ]);
    expect(text.split("\n")).toEqual([
      "harness failed",
      "",
      "Account attempts:",
      "- stub/a · default model · att-1 try 1 · pre progress · unknown_harness_error: out of usage",
      "- stub/b · default model · att-1 try 2 · pre progress · unknown_harness_error: invoice",
    ]);
    const joined = poolFailure("why", [
      { poolAttempts: [row("a", "x")] },
      {},
      { poolAttempts: [row("b", "y", 1)] },
    ]);
    expect(joined.poolAttempts.map((r) => r.profileId)).toEqual(["a", "b"]);
    expect(joined.message).toContain("stub/b");
  });

  it("an in-run rotation exhaustion names each candidate's own failed tries once", () => {
    const payload = withRotationAttempts(
      {
        harness_id: "stub",
        candidates: [
          { profile_id: "a", rejected: "already_tried" },
          { profile_id: "c", rejected: "not_ready" },
        ],
      },
      [row("a", "refused"), row("deleted", "gone mid-run", 1)],
    );
    expect(payload["candidates"]).toEqual([
      { profile_id: "a", rejected: "already_tried", attempt_failures: [row("a", "refused")] },
      { profile_id: "c", rejected: "not_ready", attempt_failures: [] },
    ]);
    // A row deleted mid-run keeps its failure in the ordered list, not as a fake candidate.
    expect(payload["pool_attempts"]).toEqual([
      row("a", "refused"),
      row("deleted", "gone mid-run", 1),
    ]);
  });
});
