import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import type { HarnessAdapter } from "./adapter.js";
import { AuthCapabilityVerifier } from "./auth-capability-verifier.js";

const ts = "2026-09-28T06:00:00.000Z";
const roots: string[] = [];
type Event = Record<string, unknown>;
const omission = {
  requested: null,
  submitted: null,
  parameter: "--effort",
  resolution: "omitted",
  source: "live_probe",
  observed: null,
  observedSource: null,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function preparation(spec: HarnessRunSpec, patch: Event = {}): Event {
  return { type: "status", session_id: spec.session_id, ts, effort_resolution: omission, ...patch };
}

function lifecycle(spec: HarnessRunSpec): Event[] {
  const token = spec.prompt.split(" ")[2]!;
  return [
    {
      type: "started",
      session_id: spec.session_id,
      ts,
      credential_route: "vendor_native",
      credential_source: "native_session",
    },
    { type: "message", session_id: spec.session_id, ts, text: token, final: true },
    { type: "completed", session_id: spec.session_id, ts },
  ];
}

async function verify(events: (spec: HarnessRunSpec) => Event[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cap-prep-")));
  roots.push(root);
  const adapter: HarnessAdapter = {
    id: "claude",
    async discover() {
      throw new Error("unexpected discovery");
    },
    async doctor() {
      throw new Error("unexpected doctor");
    },
    run: async function* (spec) {
      expect(spec).toMatchObject({ effort_hint: null, credential_profile: null });
      yield* events(spec) as unknown as HarnessEvent[];
    },
  };
  const subject = new AuthCapabilityVerifier(() => adapter, {
    scratchRoot: join(root, "smokes"),
    now: () => new Date(ts),
    receiptId: () => "cap-prep-receipt",
  });
  const { binding } = subject.prepare({
    attemptId: "cap-prep",
    harness: "claude",
    requested: "subscription",
    requiredRoute: "vendor_native",
    requiredSource: "native_session",
  });
  return subject.verify({ binding, startedAt: ts });
}

describe("auth capability preparation versus vendor lifecycle", () => {
  it.each(["live_probe", "versioned_snapshot"])(
    "accepts one silent %s omission before the native start and retains its evidence",
    async (source) => {
      const receipt = await verify((spec) => [
        preparation(spec, { effort_resolution: { ...omission, source } }),
        ...lifecycle(spec),
      ]);
      expect(receipt).toMatchObject({
        verification: "passed",
        selectionReason: "exact_requested_route",
        stream: { startedEvents: 1, completedEvents: 1, errorEvents: 0 },
      });
      expect(receipt.evidenceRefs).toContain("event:effort_prepared");
      const bare = await verify(lifecycle);
      expect(bare.verification).toBe("passed");
      expect(receipt.streamDigest).not.toBe(bare.streamDigest);
      const different = await verify((spec) => [
        preparation(spec, { effort_resolution: { ...omission, source, parameter: null } }),
        ...lifecycle(spec),
      ]);
      expect(receipt.streamDigest).not.toBe(different.streamDigest);
    },
  );

  it.each([
    ["generic status", { effort_resolution: undefined }],
    ["rejected effort", { effort_resolution: { ...omission, resolution: "rejected" } }],
    ["non-omission effort", { effort_resolution: { ...omission, resolution: "exact" } }],
    ["different requested effort", { effort_resolution: { ...omission, requested: "high" } }],
    ["submitted effort", { effort_resolution: { ...omission, submitted: "high" } }],
    ["provider observation", { effort_resolution: { ...omission, observed: "high" } }],
    ["observation source", { effort_resolution: { ...omission, observedSource: "vendor" } }],
    ["mixed error", { error: "failure" }],
    ["mixed tool", { tool: { name: "shell" } }],
    ["mixed final", { final: true }],
    ["mixed retry", { status: { kind: "api_retry", error_category: "authentication_failed" } }],
    ["mixed text", { text: "preparation is not an answer" }],
    ["mixed payload", { payload: { code: "failure" } }],
    ["mixed route", { credential_route: "vendor_native" }],
    ["mixed source", { credential_source: "native_session" }],
  ] as const)("rejects prestart %s", async (_label, patch) => {
    const receipt = await verify((spec) => [preparation(spec, patch), ...lifecycle(spec)]);
    expect(receipt).toMatchObject({
      verification: "failed",
      selectionReason: "protocol_violation",
    });
  });

  it("rejects a malformed receipt through schema validation", async () => {
    const receipt = await verify((spec) => [
      preparation(spec, { effort_resolution: { ...omission, source: "untrusted" } }),
      ...lifecycle(spec),
    ]);
    expect(receipt).toMatchObject({ verification: "failed", selectionReason: "adapter_error" });
  });

  it.each(["message", "tool_call", "tool_result", "error", "completed"])(
    "still rejects prestart %s even with an effort receipt",
    async (type) => {
      const receipt = await verify((spec) => [
        preparation(spec),
        preparation(spec, { type }),
        ...lifecycle(spec),
      ]);
      expect(receipt).toMatchObject({
        verification: "failed",
        selectionReason: "protocol_violation",
      });
    },
  );

  it("rejects repeated preparation", async () => {
    const receipt = await verify((spec) => [
      preparation(spec),
      preparation(spec),
      ...lifecycle(spec),
    ]);
    expect(receipt).toMatchObject({
      verification: "failed",
      selectionReason: "protocol_violation",
    });
  });

  it("rejects wrong-session preparation", async () => {
    const receipt = await verify((spec) => [
      preparation(spec, { session_id: "wrong-session" }),
      ...lifecycle(spec),
    ]);
    expect(receipt).toMatchObject({
      verification: "failed",
      selectionReason: "harness_error",
      stream: { sessionMismatchEvents: 1 },
    });
  });

  it("does not substitute preparation for the mandatory native start", async () => {
    const receipt = await verify((spec) => [preparation(spec), ...lifecycle(spec).slice(1)]);
    expect(receipt).toMatchObject({
      verification: "failed",
      selectionReason: "route_missing",
      effective: null,
      effectiveSource: null,
      stream: { startedEvents: 0 },
    });
  });

  it.each([
    ["missing route", { credential_route: undefined }, "route_missing"],
    ["wrong route", { credential_route: "managed_api_key" }, "route_mismatch"],
    ["missing source", { credential_source: undefined }, "source_missing"],
    ["wrong source", { credential_source: "oauth_token_env" }, "source_mismatch"],
  ] as const)("cannot rescue a %s on started", async (_label, patch, selectionReason) => {
    const receipt = await verify((spec) => {
      const [start, ...rest] = lifecycle(spec);
      return [preparation(spec), { ...start, ...patch }, ...rest];
    });
    expect(receipt).toMatchObject({ verification: "failed", selectionReason });
  });

  it("still rejects repeated start", async () => {
    const receipt = await verify((spec) => [
      preparation(spec),
      lifecycle(spec)[0]!,
      ...lifecycle(spec),
    ]);
    expect(receipt).toMatchObject({
      verification: "failed",
      selectionReason: "protocol_violation",
    });
  });

  it.each([
    ["wrong challenge", "response_mismatch"],
    ["native error", "harness_error"],
    ["missing completion", "missing_completion"],
  ] as const)("preparation cannot rescue %s", async (failure, selectionReason) => {
    const receipt = await verify((spec) => {
      const [start, answer, end] = lifecycle(spec);
      return [
        preparation(spec),
        start!,
        failure === "native error"
          ? { type: "error", session_id: spec.session_id, ts, error: "failure" }
          : { ...answer, ...(failure === "wrong challenge" ? { text: "wrong" } : {}) },
        ...(failure === "missing completion" ? [] : [end!]),
      ];
    });
    expect(receipt).toMatchObject({ verification: "failed", selectionReason });
  });

  it.each(["status", "message", "tool_call", "error", "completed"])(
    "rejects %s after completion",
    async (type) => {
      const receipt = await verify((spec) => [
        preparation(spec),
        ...lifecycle(spec),
        preparation(spec, { type }),
      ]);
      expect(receipt).toMatchObject({
        verification: "failed",
        selectionReason: "protocol_violation",
        stream: { eventsAfterCompleted: 1 },
      });
    },
  );
});
