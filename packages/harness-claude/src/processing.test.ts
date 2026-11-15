import { describe, expect, it } from "vitest";
import { HarnessRunSpec, ProcessingPreference, type HarnessEvent } from "@claudexor/schema";
import { claudeArgsForSpec, createClaudeAdapter } from "./index.js";
import {
  claudeProcessingCost,
  claudeProcessingObserver,
  prepareClaudeProcessing,
  prepareClaudeSessionProcessing,
} from "./processing.js";

const event = (): HarnessEvent => ({ type: "usage", session_id: "s", ts: "2026-09-12T00:00:00Z" });
const message = (id: string, speed?: string) => ({
  type: "assistant",
  message: { id, model: "claude-opus-5", usage: { speed } },
});

describe("Claude processing", () => {
  it("preserves model and effort for true/false settings on fresh and resume", () => {
    for (const preference of ["standard", "fast", "ultrafast", "economy"] as const)
      for (const resume_session_id of [null, "native-session"]) {
        const spec = HarnessRunSpec.parse({
          session_id: "s",
          intent: "implement",
          prompt: "test",
          cwd: "/repo",
          access: "workspace_write",
          model_hint: "claude-fable-5-1",
          effort_hint: "high",
          processing_preference: preference,
          resume_session_id,
        });
        const args = claudeArgsForSpec(spec, false, true);
        expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({
          fastMode: preference === "fast",
        });
        expect(args[args.indexOf("--model") + 1]).toBe("claude-fable-5-1");
        expect(args[args.indexOf("--effort") + 1]).toBe("high");
      }
  });
  it("does not write settings for old callers", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "s",
      intent: "implement",
      prompt: "test",
      cwd: "/repo",
      access: "workspace_write",
    });
    expect(claudeArgsForSpec(spec, false, true)).not.toContain("--settings");
    spec.processing = prepareClaudeProcessing(undefined, true);
    expect(claudeArgsForSpec(spec, false, true)).not.toContain("--settings");
    expect(spec.processing).toMatchObject({
      requested: null,
      submitted: "fast",
      reason: "native_explicit",
    });
  });
  it("answers Ultrafast with ordinary service and its reason, never Fast", async () => {
    for (const allowPaid of [true, false])
      for (const inheritedFast of [undefined, false])
        expect(prepareClaudeProcessing("ultrafast", inheritedFast, allowPaid)).toMatchObject({
          requested: "ultrafast",
          submitted: "standard",
          submittedNative: "fastMode=false",
          reason: "ultrafast_not_supported; ordinary_service_requested",
        });
    // Session preparation gives the same answer on API and subscription routes.
    for (const authPreference of ["api_key", "subscription"] as const) {
      const prepared = await prepareClaudeSessionProcessing({
        preference: "ultrafast",
        model: "claude-fable-5-1",
        effort: null,
        cwd: "/repo",
        authPreference,
        allowPaid: true,
      });
      expect(prepared.receipt).toMatchObject({
        submitted: "standard",
        submittedNative: "fastMode=false",
        reason: "ultrafast_not_supported; ordinary_service_requested",
      });
    }
  });
  it("declares every preference it answers with a receipt, not the service it provides", async () => {
    const manifest = await createClaudeAdapter({
      detectVersion: async () => "2.1.165 (Claude Code)",
      probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
      probeAuthStatus: async () => ({
        loggedIn: false,
        authed: false,
        authMethod: null,
        probeError: null,
      }),
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
      probeEffortLevels: async () => ({ levels: ["high"], live: true }),
    }).discover();
    const declared = manifest.capabilities.processing_preferences ?? [];
    expect([...declared].sort()).toEqual([...ProcessingPreference.options].sort());
    for (const preference of declared)
      expect(prepareClaudeProcessing(preference).requested).toBe(preference);
    // Listing Ultrafast does not make it a submitted mode.
    expect(prepareClaudeProcessing("ultrafast").submitted).toBe("standard");
  });
  it("no-paid policy supplies ordinary settings without changing the model", () => {
    expect(prepareClaudeProcessing("fast", true, false)).toMatchObject({
      requested: "fast",
      submitted: "standard",
      submittedNative: "fastMode=false",
    });
  });
  it("keeps a saved explicit ordinary setting included without rewriting legacy input", () => {
    const ordinary = prepareClaudeProcessing(undefined, false);
    expect(ordinary).toMatchObject({
      requested: null,
      submitted: "standard",
      submittedNative: "fastMode=false",
      reason: "native_explicit",
      observed: "unknown",
    });
    expect(claudeProcessingCost(ordinary, true).kind).toBe("included");
    const unknown = prepareClaudeProcessing(undefined, undefined);
    expect(unknown.submitted).toBeNull();
    expect(claudeProcessingCost(unknown, true).kind).toBe("unknown");
    const spec = HarnessRunSpec.parse({
      session_id: "s",
      intent: "implement",
      prompt: "test",
      cwd: "/repo",
      processing: ordinary,
    });
    expect(claudeArgsForSpec(spec, false, true)).not.toContain("--settings");
  });
  it("uses message_delta speed instead of interpreting service_tier as speed", () => {
    const receipt = prepareClaudeProcessing("fast");
    const observe = claudeProcessingObserver(receipt, claudeProcessingCost(receipt, true));
    observe(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m", model: "opus", usage: { service_tier: "standard" } },
        },
      },
      [],
      "s",
    );
    expect(
      observe(
        { type: "stream_event", event: { type: "message_delta", usage: { speed: "fast" } } },
        [event()],
        "s",
      )?.[0].processing?.observed,
    ).toBe("fast");
  });
  it("does not make subscription Fast free or turn a native flag into observed speed", () => {
    const receipt = prepareClaudeProcessing("fast");
    const cost = claudeProcessingCost(receipt, true);
    expect(cost.kind).toBe("paid_credits");
    const observe = claudeProcessingObserver(receipt, cost);
    expect(
      observe({ type: "system", subtype: "init", fast_mode_state: "on" }, [event()], "s")?.[0]
        .processing?.observed,
    ).toBe("unknown");
  });
  it("does not turn a list valuation into a paid-credit debit", () => {
    const receipt = prepareClaudeProcessing("fast");
    const observe = claudeProcessingObserver(receipt, claudeProcessingCost(receipt, true));
    observe(message("one", "fast"), [], "s");
    const result = observe(
      { type: "result", modelUsage: { opus: { costUSD: 1, costBasis: "list" } } },
      [{ ...event(), usage: { cost_usd: 1 } }],
      "s",
    )?.[0];
    expect(result?.usage).toMatchObject({
      cost_usd: 1,
      estimated: true,
      cost_basis: { kind: "valuation" },
    });
    expect(result?.processing_cost_basis?.kind).toBe("paid_credits");
    const unproven = observe(
      { type: "result" },
      [{ ...event(), usage: { cost_usd: 1 } }],
      "s",
    )?.[0];
    expect(unproven?.usage).toMatchObject({ cost_basis: { kind: "unknown" } });
  });
  it("retains proven ordinary billing independently of unavailable observed speed", () => {
    const receipt = prepareClaudeProcessing("standard");
    const observe = claudeProcessingObserver(receipt, claudeProcessingCost(receipt, true));
    const unknown = observe({ type: "result" }, [{ ...event(), usage: { cost_usd: 1 } }], "s")?.[0];
    expect(unknown?.processing?.observed).toBe("unknown");
    expect(unknown?.processing_cost_basis?.kind).toBe("included");
    expect(unknown?.usage).toMatchObject({ cost_basis: { kind: "unknown" } });
    const mismatch = observe(message("premium", "fast"), [event()], "s")?.[0];
    expect(mismatch?.processing_cost_basis?.kind).toBe("unknown");
  });
  it("keeps a mixed session mixed when its terminal aggregate reports only Standard", () => {
    const receipt = prepareClaudeProcessing("fast");
    const observe = claudeProcessingObserver(receipt, claudeProcessingCost(receipt, true));
    observe(message("one", "fast"), [event()], "s");
    observe(message("two", "standard"), [event()], "s");
    const final = observe({ type: "result", usage: { speed: "standard" } }, [event()], "s")?.[0];
    expect(final?.processing).toMatchObject({
      observed: "mixed",
      observedNative: ["fast", "standard"],
    });
  });
  it("keeps missing per-message speed unknown and enriches repeated partial frames", () => {
    const receipt = prepareClaudeProcessing("fast");
    const observe = claudeProcessingObserver(receipt, claudeProcessingCost(receipt, true));
    observe(message("one"), [event()], "s");
    expect(observe(message("two", "fast"), [event()], "s")?.[0].processing?.observed).toBe(
      "unknown",
    );
    expect(observe(message("one", "fast"), [event()], "s")?.[0].processing?.observed).toBe("fast");
  });
  it("retains native fallback notifications", () => {
    const receipt = prepareClaudeProcessing("fast");
    const observe = claudeProcessingObserver(receipt, claudeProcessingCost(receipt, true));
    expect(
      observe(
        {
          type: "system",
          subtype: "notification",
          key: "fast-mode-overage-rejected",
          text: "Fast mode disabled",
        },
        [],
        "s",
      )?.[0],
    ).toMatchObject({
      type: "status",
      text: "Fast mode disabled",
      processing: { observed: "unknown" },
    });
  });
});
