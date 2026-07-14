import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessRunSpec } from "@claudexor/schema";
import type { HarnessAdapter } from "./adapter.js";
import { AuthCapabilityVerifier } from "./auth-capability-verifier.js";

const now = () => new Date("2026-07-14T01:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function verifier(
  adapter: HarnessAdapter | undefined,
  lookup = vi.fn(() => adapter),
): { subject: AuthCapabilityVerifier; lookup: typeof lookup; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-auth-verifier-test-")));
  roots.push(root);
  return {
    subject: new AuthCapabilityVerifier(lookup, {
      now,
      receiptId: () => "authcap-receipt",
      scratchRoot: join(root, "auth-smokes"),
    }),
    lookup,
    root,
  };
}

function prepare(subject: AuthCapabilityVerifier) {
  return subject.prepare({
    attemptId: "attempt-1",
    harness: "claude",
    requested: "subscription",
    requiredRoute: "vendor_native",
    requiredSource: "native_session",
  }).binding;
}

function expectedToken(spec: HarnessRunSpec): string {
  const match = /^Return exactly (\S+) and no other text\./.exec(spec.prompt);
  if (!match?.[1]) throw new Error("test adapter received an invalid challenge prompt");
  return match[1];
}

function adapterWith(
  events: (spec: HarnessRunSpec) => AsyncIterable<Record<string, unknown>>,
  capture?: (spec: HarnessRunSpec) => void,
  id = "claude",
): HarnessAdapter {
  return {
    id,
    async discover() {
      throw new Error("discovery must not run during an exact capability smoke");
    },
    async doctor() {
      throw new Error("doctor must not run during an exact capability smoke");
    },
    run(spec) {
      capture?.(spec);
      return events(spec) as ReturnType<HarnessAdapter["run"]>;
    },
  };
}

async function exactEvents(spec: HarnessRunSpec) {
  return [
    {
      type: "started",
      session_id: spec.session_id,
      ts: now().toISOString(),
      credential_route: "vendor_native",
      credential_source: "native_session",
    },
    {
      type: "message",
      session_id: spec.session_id,
      ts: now().toISOString(),
      text: expectedToken(spec),
    },
    { type: "completed", session_id: spec.session_id, ts: now().toISOString() },
  ];
}

async function* yieldExact(spec: HarnessRunSpec) {
  for (const event of await exactEvents(spec)) yield event;
}

describe("AuthCapabilityVerifier", () => {
  it("proves only an exact same-harness native-session readonly round trip", async () => {
    let captured: HarnessRunSpec | undefined;
    const adapter = adapterWith(yieldExact, (spec) => {
      captured = spec;
    });
    const { subject, lookup, root } = verifier(adapter);
    const binding = prepare(subject);

    const receipt = await subject.verify({ binding, startedAt: now().toISOString() });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("claude");
    expect(receipt).toMatchObject({
      verification: "passed",
      availability: "available",
      effective: "vendor_native",
      effectiveSource: "native_session",
      selectionReason: "exact_requested_route",
      billingKnowledge: "unknown",
      costKnowledge: "unknown",
      responseDigest: binding.challengeDigest,
      scratchBeforeDigest: receipt.scratchAfterDigest,
    });
    expect(receipt).not.toHaveProperty("costUsd");
    expect(captured).toMatchObject({
      intent: "explain",
      access: "readonly",
      external_context_policy: "off",
      auth_preference: "subscription",
      evidence_policy: "stream_only",
      attachments: [],
      browser: null,
      max_turns: 1,
      env_inheritance: "clean",
    });
    expect(captured!.cwd.startsWith(root)).toBe(true);
    expect(existsSync(captured!.cwd)).toBe(true);
    subject.cleanup(binding.attemptId);
    expect(existsSync(captured!.cwd)).toBe(false);
  });

  it.each([
    ["route missing", undefined, "native_session", "route_missing"],
    ["paid-key route substitution", "managed_api_key", "api_key_env", "route_mismatch"],
    ["source missing", "vendor_native", undefined, "source_missing"],
    ["OAuth source substitution", "vendor_native", "oauth_token_env", "source_mismatch"],
  ] as const)("fails closed for %s", async (_label, route, source, reason) => {
    const adapter = adapterWith(async function* (spec) {
      yield {
        type: "started",
        session_id: spec.session_id,
        ts: now().toISOString(),
        ...(route ? { credential_route: route } : {}),
        ...(source ? { credential_source: source } : {}),
      };
      yield {
        type: "message",
        session_id: spec.session_id,
        ts: now().toISOString(),
        text: expectedToken(spec),
      };
      yield { type: "completed", session_id: spec.session_id, ts: now().toISOString() };
    });
    const { subject } = verifier(adapter);
    await expect(
      subject.verify({ binding: prepare(subject), startedAt: now().toISOString() }),
    ).resolves.toMatchObject({ verification: "failed", selectionReason: reason });
  });

  it("refuses a registry key/adapter identity mismatch without running it", async () => {
    const run = vi.fn();
    const wrong = adapterWith(
      async function* () {
        run();
      },
      undefined,
      "codex",
    );
    const { subject } = verifier(wrong);
    const receipt = await subject.verify({
      binding: prepare(subject),
      startedAt: now().toISOString(),
    });
    expect(run).not.toHaveBeenCalled();
    expect(receipt.selectionReason).toBe("adapter_identity_mismatch");
  });

  it.each([
    [
      "harness error",
      async function* (spec: HarnessRunSpec) {
        yield {
          type: "started",
          session_id: spec.session_id,
          ts: now().toISOString(),
          credential_route: "vendor_native",
          credential_source: "native_session",
        };
        yield {
          type: "error",
          session_id: spec.session_id,
          ts: now().toISOString(),
          error: "redacted failure",
        };
        yield { type: "completed", session_id: spec.session_id, ts: now().toISOString() };
      },
      "harness_error",
    ],
    [
      "missing completion",
      async function* (spec: HarnessRunSpec) {
        yield {
          type: "started",
          session_id: spec.session_id,
          ts: now().toISOString(),
          credential_route: "vendor_native",
          credential_source: "native_session",
        };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts: now().toISOString(),
          text: expectedToken(spec),
        };
      },
      "missing_completion",
    ],
    [
      "wrong response",
      async function* (spec: HarnessRunSpec) {
        yield {
          type: "started",
          session_id: spec.session_id,
          ts: now().toISOString(),
          credential_route: "vendor_native",
          credential_source: "native_session",
        };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts: now().toISOString(),
          text: "not the nonce",
        };
        yield { type: "completed", session_id: spec.session_id, ts: now().toISOString() };
      },
      "response_mismatch",
    ],
    [
      "interaction",
      async function* (spec: HarnessRunSpec) {
        yield {
          type: "started",
          session_id: spec.session_id,
          ts: now().toISOString(),
          credential_route: "vendor_native",
          credential_source: "native_session",
        };
        yield {
          type: "interaction_requested",
          session_id: spec.session_id,
          ts: now().toISOString(),
          interaction: { interaction_id: "i", questions: [] },
        };
        yield { type: "completed", session_id: spec.session_id, ts: now().toISOString() };
      },
      "harness_error",
    ],
    [
      "event after completion",
      async function* (spec: HarnessRunSpec) {
        yield* yieldExact(spec);
        yield {
          type: "message",
          session_id: spec.session_id,
          ts: now().toISOString(),
          text: "late",
        };
      },
      "protocol_violation",
    ],
  ])("rejects %s", async (_label, events, reason) => {
    const { subject } = verifier(adapterWith(events));
    await expect(
      subject.verify({ binding: prepare(subject), startedAt: now().toISOString() }),
    ).resolves.toMatchObject({ verification: "failed", selectionReason: reason });
  });

  it("fails when the supposedly readonly smoke changes its owned scratch", async () => {
    const adapter = adapterWith(async function* (spec) {
      writeFileSync(join(spec.cwd, "sentinel"), "changed");
      yield* yieldExact(spec);
    });
    const { subject } = verifier(adapter);
    const receipt = await subject.verify({
      binding: prepare(subject),
      startedAt: now().toISOString(),
    });
    expect(receipt.selectionReason).toBe("scratch_mutated");
    subject.cleanup(receipt.attemptId);
  });

  it("does not pass if cancellation races with terminal completion", async () => {
    const controller = new AbortController();
    const adapter = adapterWith(async function* (spec) {
      yield* yieldExact(spec);
      controller.abort();
    });
    const { subject } = verifier(adapter);
    await expect(
      subject.verify({
        binding: prepare(subject),
        startedAt: now().toISOString(),
        abortSignal: controller.signal,
      }),
    ).resolves.toMatchObject({ verification: "failed", selectionReason: "cancelled" });
  });

  it("turns adapter exceptions into redacted failed receipts", async () => {
    const { subject } = verifier(
      adapterWith(async function* () {
        throw new Error("secret-bearing vendor output");
      }),
    );
    const receipt = await subject.verify({
      binding: prepare(subject),
      startedAt: now().toISOString(),
    });
    expect(receipt).toMatchObject({ verification: "failed", selectionReason: "adapter_error" });
    expect(JSON.stringify(receipt)).not.toContain("secret-bearing");
  });

  it("does not call any unrelated adapter when the selected harness is absent", async () => {
    const { subject, lookup } = verifier(undefined);
    const receipt = await subject.verify({
      binding: prepare(subject),
      startedAt: now().toISOString(),
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(receipt).toMatchObject({
      availability: "unavailable",
      verification: "failed",
      selectionReason: "adapter_unavailable",
    });
  });

  it("binds the request before execution and refuses a changed digest", async () => {
    const run = vi.fn();
    const { subject } = verifier(
      adapterWith(async function* () {
        run();
      }),
    );
    const binding = { ...prepare(subject), requestDigest: "f".repeat(64) };
    const receipt = await subject.verify({ binding, startedAt: now().toISOString() });
    expect(run).not.toHaveBeenCalled();
    expect(receipt.selectionReason).toBe("request_mismatch");
  });

  it("discloses possible quota use and unknown billing before the call", () => {
    const { subject } = verifier(undefined);
    expect(prepare(subject).disclosure).toMatchObject({
      requiredSource: "native_session",
      networkScope: "selected_harness_only",
      billingKnowledge: "unknown",
      incrementalCostKnowledge: "unknown",
      mayConsumeQuota: true,
    });
  });
});
