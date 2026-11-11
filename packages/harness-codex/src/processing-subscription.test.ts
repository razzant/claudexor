import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CredentialProfile, HarnessRunSpec } from "@claudexor/schema";
import { usageAmountKind } from "../../budget/src/usage-evidence.js";
import { clearCodexEffortCache, createCodexAdapter } from "./index.js";
import { readModelListEfforts } from "./effort-probe.js";
import { applyCodexRunProcessing } from "./processing-session.js";
import { codexProcessingCost, legacyCodexProcessing } from "./processing.js";
import { codexAppServerThreadParams } from "./app-server-run.js";

afterEach(() => clearCodexEffortCache());

function profile(id = "one", api = false) {
  return CredentialProfile.parse({
    profile_id: id,
    harness_id: "codex",
    display_name: id,
    credential_kind: api ? "api_key" : "config_dir_login",
    ...(api
      ? { secret_ref: "openai:fixture" }
      : { isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, id) }),
  });
}

function adapter(tiers: string[] = ["priority"]) {
  return createCodexAdapter({
    probeEfforts: async (_bin, env) =>
      readModelListEfforts([
        {
          id: "model",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          serviceTiers: env?.CODEX_HOME?.endsWith("/two") ? [] : tiers.map((id) => ({ id })),
        },
      ]),
  });
}

describe("Codex subscription allowance is native-mode qualified", () => {
  it.each(["fast", "priority"])(
    "selects advertised ordinary %s even when Ultrafast is listed first",
    async (tier) => {
      const native = adapter(["ultrafast", tier]);
      const prepared = await native.prepareProcessing!({
        model: "model",
        effort: "high",
        cwd: "/fixture",
        preference: "fast",
        allowPaid: false,
        credentialProfile: profile(),
      });
      expect(prepared.receipt.submittedNative).toBe(tier);
    },
  );
  it.each(["fast", "priority"])(
    "classifies only ordinary %s as included, independently of observed debit",
    (tier) => {
      const receipt = legacyCodexProcessing(tier);
      const basis = codexProcessingCost(receipt, true);
      expect(basis).toMatchObject({ kind: "included", nativeMode: tier });
      expect(codexProcessingCost(receipt, false).kind).toBe("cash");
      expect(codexProcessingCost(receipt, null).kind).toBe("unknown");
      expect(receipt.observed).toBe("unknown");
      expect(
        usageAmountKind(
          "local_session",
          { kind: "unknown", source: "unobserved-debit" },
          receipt,
          basis,
        ),
      ).toBe("unknown");
    },
  );

  it.each(["ultrafast", "scale", "flex", "future-premium"])(
    "does not infer inclusion for %s",
    (tier) => {
      expect(codexProcessingCost(legacyCodexProcessing(tier), true).kind).toBe("unknown");
    },
  );

  it.each(["fast", "priority", "ultrafast", "scale"])(
    "re-prepares inherited %s under the same no-paid policy",
    async (tier) => {
      const credentialProfile = profile();
      mkdirSync(credentialProfile.isolation_locator!, { recursive: true });
      writeFileSync(
        join(credentialProfile.isolation_locator!, "config.toml"),
        `service_tier = "${tier}"\n`,
      );
      const prepared = await adapter().prepareProcessing!({
        model: "model",
        effort: "high",
        cwd: "/fixture",
        credentialProfile,
        allowPaid: false,
      });
      const ordinaryFast = tier === "fast" || tier === "priority";
      expect(prepared.receipt).toMatchObject({
        requested: null,
        submittedNative: ordinaryFast ? tier : "default",
        observed: "unknown",
      });
      const actual = applyCodexRunProcessing(
        HarnessRunSpec.parse({
          session_id: "s",
          intent: "explain",
          prompt: "test",
          cwd: "/fixture",
          model_hint: "model",
          processing_allow_paid: false,
        }),
        { models: {}, defaultModel: "model" },
        credentialProfile.isolation_locator,
        true,
      );
      expect(actual.processing?.submittedNative).toBe(ordinaryFast ? tier : "default");
    },
  );

  it("prepares advertised Fast again for each account without borrowing inclusion or catalog", async () => {
    const native = adapter();
    const input = {
      model: "model",
      effort: "high",
      cwd: "/fixture",
      preference: "fast" as const,
      allowPaid: false,
    };
    const first = await native.prepareProcessing!({ ...input, credentialProfile: profile() });
    expect(first.receipt.submittedNative).toBe("priority");
    expect(first.costBasis.kind).toBe("included");
    const second = await native.prepareProcessing!({ ...input, credentialProfile: profile("two") });
    expect(second.receipt).toMatchObject({
      submitted: "standard",
      submittedNative: "default",
      reason: "requested_mode_not_advertised; ordinary_service_requested",
    });
    const api = await native.prepareProcessing!({
      ...input,
      credentialProfile: profile("api", true),
    });
    expect(api.receipt.submittedNative).toBe("default");
    expect(api.costBasis.kind).toBe("cash");
    const unknown = await native.prepareProcessing!(input);
    expect(unknown.receipt.submittedNative).toBe("default");
    expect(unknown.costBasis.kind).toBe("unknown");
  });

  it("does not select an unadvertised mode, another model's Fast, or introduce Fast on omission", async () => {
    const native = adapter(["ultrafast"]);
    const input = {
      model: "model",
      effort: "high",
      cwd: "/fixture",
      credentialProfile: profile(),
      allowPaid: false,
    };
    expect(
      (await native.prepareProcessing!({ ...input, preference: "fast" })).receipt.submittedNative,
    ).toBe("default");
    expect(
      (await native.prepareProcessing!({ ...input, model: "unlisted-model", preference: "fast" }))
        .receipt.submittedNative,
    ).toBe("default");
    const omitted = await native.prepareProcessing!(input);
    expect(omitted.receipt.requested).toBeNull();
    expect(omitted.receipt.submitted).not.toBe("fast");
  });

  it.each(["fast", "priority"])(
    "final native preparation preserves %s only on a subscription route",
    (tier) => {
      const catalog = readModelListEfforts([
        {
          id: "model",
          isDefault: true,
          supportedReasoningEfforts: [],
          serviceTiers: [{ id: tier }],
        },
      ])!;
      const spec = HarnessRunSpec.parse({
        session_id: "s",
        intent: "explain",
        prompt: "test",
        cwd: "/fixture",
        model_hint: "model",
        processing_preference: "fast",
        processing_allow_paid: false,
      });
      expect(applyCodexRunProcessing(spec, catalog, null, true)).toMatchObject({
        processing: { submittedNative: tier },
        processing_cost_basis: { kind: "included" },
      });
      for (const resume_session_id of [null, "native-thread"]) {
        const prepared = applyCodexRunProcessing(
          { ...spec, resume_session_id },
          catalog,
          null,
          true,
        );
        expect(codexAppServerThreadParams(prepared, "high").config).toMatchObject({
          service_tier: tier,
          model_reasoning_effort: "high",
        });
      }
      expect(applyCodexRunProcessing(spec, catalog, null, false)).toMatchObject({
        processing: { submittedNative: "default" },
        processing_cost_basis: { kind: "cash" },
      });
    },
  );
});
