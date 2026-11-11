import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CredentialProfile, HarnessRunSpec, type ProcessingReceipt } from "@claudexor/schema";
import { clearCodexEffortCache, createCodexAdapter } from "./index.js";
import { readModelListEfforts } from "./effort-probe.js";
import { codexAppServerThreadParams } from "./app-server-run.js";
import { codexProcessingArgs } from "./processing-session.js";
import { codexProcessingCost, legacyCodexProcessing } from "./processing.js";

afterEach(() => clearCodexEffortCache());

let homes = 0;
function account(id: string, tier?: string) {
  const profile = CredentialProfile.parse({
    profile_id: id,
    harness_id: "codex",
    display_name: id,
    credential_kind: "config_dir_login",
    isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "retention", `${++homes}`, id),
  });
  mkdirSync(profile.isolation_locator!, { recursive: true });
  if (tier)
    writeFileSync(join(profile.isolation_locator!, "config.toml"), `service_tier = "${tier}"\n`);
  return profile;
}

/** Each account advertises its own tiers; `/plain` advertises none. */
function adapter(tiers: Record<string, string[]>) {
  return createCodexAdapter({
    probeEfforts: async (_bin, env) =>
      readModelListEfforts([
        {
          id: "model",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          serviceTiers: (tiers[env?.CODEX_HOME?.split("/").pop() ?? ""] ?? []).map((id) => ({
            id,
          })),
        },
      ]),
  });
}

const base = { model: "model", effort: "high", cwd: "/fixture" };

describe("Codex keeps the first account's speed intent on a later try", () => {
  it.each([true, false])(
    "never adopts Fast from the next account's own setting (allowPaid=%s)",
    async (allowPaid) => {
      const native = adapter({ first: ["priority"], second: ["priority"] });
      const first = await native.prepareProcessing!({
        ...base,
        credentialProfile: account("first"),
        allowPaid,
      });
      expect(first.receipt.requested).toBeNull();
      expect(first.receipt.submitted).not.toBe("fast");
      const second = await native.prepareProcessing!({
        ...base,
        credentialProfile: account("second", "fast"),
        allowPaid,
        chosen: first.receipt,
      });
      expect(second.receipt).toMatchObject({
        requested: null,
        submitted: "standard",
        submittedNative: "default",
        reason: "initial_processing_retained",
        source: "codex.service_tier",
      });
      expect(second.costBasis).toMatchObject({ kind: "included", debit: "unobserved" });
      // Both native transports send the retained ordinary tier explicitly.
      const spec = HarnessRunSpec.parse({
        session_id: "s",
        intent: "explain",
        prompt: "test",
        cwd: "/fixture",
        model_hint: "model",
        processing_allow_paid: allowPaid,
        processing: second.receipt,
      });
      expect(codexProcessingArgs(spec)).toEqual(["-c", 'service_tier="default"']);
      expect(codexAppServerThreadParams(spec, "high").config).toMatchObject({
        service_tier: "default",
      });
    },
  );

  it("keeps an inherited Fast intent on an account that advertises ordinary Fast", async () => {
    const native = adapter({ first: ["priority"], second: ["ultrafast", "priority"] });
    const first = await native.prepareProcessing!({
      ...base,
      credentialProfile: account("first", "fast"),
      allowPaid: false,
    });
    expect(first.receipt).toMatchObject({
      submitted: "fast",
      submittedNative: "fast",
      source: "codex.managed_config",
    });
    const second = await native.prepareProcessing!({
      ...base,
      credentialProfile: account("second"),
      allowPaid: false,
      chosen: first.receipt,
    });
    // Same mode, ordinary id; Ultrafast listed first is never adopted.
    expect(second.receipt).toMatchObject({
      requested: null,
      submitted: "fast",
      submittedNative: "priority",
      reason: "initial_processing_retained",
    });
    expect(second.costBasis.kind).toBe("included");
  });

  it("falls back to ordinary service with a reason when the next account lacks the intent", async () => {
    const native = adapter({ first: ["priority"], second: ["ultrafast"] });
    const chosen = legacyCodexProcessing("priority");
    const second = await native.prepareProcessing!({
      ...base,
      credentialProfile: account("second"),
      allowPaid: true,
      chosen,
    });
    expect(second.receipt).toMatchObject({
      requested: null,
      submittedNative: "default",
      reason: "initial_processing_unavailable; ordinary_service_requested",
    });
  });

  it("keeps the same native premium choice only within the paid policy", async () => {
    const native = adapter({ second: ["ultrafast", "priority"] });
    const chosen: ProcessingReceipt = legacyCodexProcessing("ultrafast");
    const paid = await native.prepareProcessing!({
      ...base,
      credentialProfile: account("second"),
      allowPaid: true,
      chosen,
    });
    expect(paid.receipt.submittedNative).toBe("ultrafast");
    expect(paid.costBasis.kind).toBe("unknown");
    const noPaid = await native.prepareProcessing!({
      ...base,
      credentialProfile: account("second"),
      allowPaid: false,
      chosen,
    });
    expect(noPaid.receipt).toMatchObject({
      submittedNative: "default",
      reason: "paid_processing_disallowed; ordinary_service_requested",
    });
  });

  it("leaves the same account's native setting and an explicit preference untouched", async () => {
    const native = adapter({ first: ["priority"] });
    const profile = account("first", "fast");
    const first = await native.prepareProcessing!({ ...base, credentialProfile: profile });
    const retry = await native.prepareProcessing!({
      ...base,
      credentialProfile: profile,
      chosen: first.receipt,
    });
    expect(retry.receipt).toEqual(first.receipt);
    const explicit = await native.prepareProcessing!({
      ...base,
      credentialProfile: account("second", "fast"),
      preference: "standard",
      chosen: first.receipt,
    });
    expect(explicit.receipt).toMatchObject({ requested: "standard", submittedNative: "default" });
  });

  it("keeps the reason of a tier it already chose when this account resolves to the same tier", async () => {
    // Exact Retry's routing already fell back from an unavailable Fast intent;
    // the spawn's own preparation must not relabel that as a paid-policy choice.
    const native = adapter({ only: [] });
    const profile = account("only");
    const routed = await native.prepareProcessing!({
      ...base,
      credentialProfile: profile,
      allowPaid: false,
      chosen: legacyCodexProcessing("fast"),
    });
    expect(routed.receipt).toMatchObject({
      submittedNative: "default",
      reason: "initial_processing_unavailable; ordinary_service_requested",
    });
    // An earlier session's observation never rides into the next one.
    const spawned = await native.prepareProcessing!({
      ...base,
      credentialProfile: profile,
      allowPaid: false,
      chosen: { ...routed.receipt, observed: "standard", observedNative: ["default"] },
    });
    expect(spawned.receipt).toEqual(routed.receipt);
  });

  it("keeps a later account's own matching setting as a new run there would", async () => {
    // The intent and the next account's own setting agree, so nothing is
    // adopted or overridden and no explicit tier is forced: Codex reads that
    // account's setting exactly as a run starting there would, without the
    // catalog check an override needs (an advisory model/list is not proof).
    const native = adapter({ first: ["priority"], second: [] });
    const first = await native.prepareProcessing!({
      ...base,
      credentialProfile: account("first", "fast"),
      allowPaid: true,
    });
    const second = await native.prepareProcessing!({
      ...base,
      credentialProfile: account("second", "fast"),
      allowPaid: true,
      chosen: first.receipt,
    });
    expect(second.receipt).toEqual(first.receipt);
    expect(second.receipt.source).toBe("codex.managed_config");
    const spec = HarnessRunSpec.parse({
      session_id: "s",
      intent: "explain",
      prompt: "test",
      cwd: "/fixture",
      model_hint: "model",
      processing: second.receipt,
    });
    expect(codexProcessingArgs(spec)).toEqual([]);
  });

  it.each([
    ["fast", "priority"],
    ["priority", "fast"],
  ])(
    "keeps ordinary Fast when the next account spells it %s→%s and advertises nothing",
    async (firstTier, secondTier) => {
      const native = adapter({ first: [], second: [] });
      const first = await native.prepareProcessing!({
        ...base,
        credentialProfile: account("first", firstTier),
        allowPaid: false,
      });
      for (const allowPaid of [true, false]) {
        const second = await native.prepareProcessing!({
          ...base,
          credentialProfile: account("second", secondTier),
          allowPaid,
          chosen: first.receipt,
        });
        // The account's own ordinary-Fast setting serves the intent: no catalog
        // downgrade, no fallback reason, and no relabelled source.
        expect(second.receipt).toMatchObject({
          requested: null,
          submitted: "fast",
          submittedNative: secondTier,
          source: "codex.managed_config",
        });
        expect(second.receipt.reason).toBe("native_explicit");
        const spec = HarnessRunSpec.parse({
          session_id: "s",
          intent: "explain",
          prompt: "test",
          cwd: "/fixture",
          model_hint: "model",
          processing_allow_paid: allowPaid,
          processing: second.receipt,
        });
        expect(codexProcessingArgs(spec)).toEqual(
          allowPaid ? [] : ["-c", `service_tier="${secondTier}"`],
        );
      }
    },
  );

  it("keeps a tier the engine already chose when the spawn's account spells ordinary Fast differently", async () => {
    const native = adapter({ only: [] });
    const chosen: ProcessingReceipt = {
      ...legacyCodexProcessing("priority"),
      reason: "initial_processing_retained",
      source: "codex.service_tier",
    };
    const spawned = await native.prepareProcessing!({
      ...base,
      credentialProfile: account("only", "fast"),
      allowPaid: false,
      chosen,
    });
    expect(spawned.receipt).toMatchObject({
      submitted: "fast",
      submittedNative: "priority",
      reason: "initial_processing_retained",
      source: "codex.service_tier",
    });
    expect(spawned.costBasis.kind).toBe("included");
  });

  it("never reads Ultrafast or Economy as the next account's ordinary Fast alias", async () => {
    const native = adapter({ second: [] });
    for (const chosen of [legacyCodexProcessing("ultrafast"), legacyCodexProcessing("flex")]) {
      const second = await native.prepareProcessing!({
        ...base,
        credentialProfile: account("second", "priority"),
        allowPaid: true,
        chosen,
      });
      // Not the same intent: the retained path runs and, with nothing
      // advertised, falls back to ordinary service with its reason.
      expect(second.receipt).toMatchObject({
        requested: null,
        submittedNative: "default",
        reason: "initial_processing_unavailable; ordinary_service_requested",
        source: "codex.service_tier",
      });
    }
    // An ordinary-Fast intent is likewise not served by the next account's
    // Ultrafast setting.
    const ultra = await native.prepareProcessing!({
      ...base,
      credentialProfile: account("second", "ultrafast"),
      allowPaid: true,
      chosen: legacyCodexProcessing("fast"),
    });
    expect(ultra.receipt).toMatchObject({
      submittedNative: "default",
      reason: "initial_processing_unavailable; ordinary_service_requested",
    });
  });

  it("declares the unobserved debit only on a verified subscription route", () => {
    for (const tier of ["default", "fast", "priority", "ultrafast"]) {
      const receipt = legacyCodexProcessing(tier);
      expect(codexProcessingCost(receipt, true).debit).toBe("unobserved");
      expect(codexProcessingCost(receipt, false).debit).toBeUndefined();
      expect(codexProcessingCost(receipt, null).debit).toBeUndefined();
    }
    expect(codexProcessingCost(legacyCodexProcessing(), true)).toMatchObject({
      kind: "unknown",
      debit: "unobserved",
    });
  });
});
