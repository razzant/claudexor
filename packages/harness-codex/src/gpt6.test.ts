/**
 * GPT-6 Sol and GPT-6 Luna on the pinned Codex CLI (codex-cli 0.156.1).
 *
 * Sibling of astra.test.ts, which checks Astra against the same CLI capture.
 * The two vendor facts this file exists to hold still:
 *
 * 1. The pin, the recorded catalog capture, the effort snapshot and the raw
 *    HTTP client_version are ONE value. A bump that re-records only some of
 *    them is the drift `vendor-cli-version.ts` was created to make impossible.
 * 2. Presence in a list ADMITS; absence from the account catalog still
 *    REFUSES on the raw model route. Adding two model ids must not have
 *    loosened the exact-account check the /responses path makes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CredentialProfile, HarnessRunSpec, ModelCallRequest } from "@claudexor/schema";
import { knownModelIdsForRoute, type HarnessEvent } from "@claudexor/schema";
import { validateModel } from "@claudexor/core";
import { CODEX_VENDOR_CLI_VERSION, clearCodexEffortCache, createCodexAdapter } from "./index.js";
import { readModelListEfforts } from "./effort-probe.js";
import { CODEX_EFFORT_SNAPSHOT } from "./effort-snapshot.js";
import { createCodexModelAdapter } from "./model.js";

const capture = JSON.parse(
  readFileSync(new URL("../fixtures/models-0.156.1.json", import.meta.url), "utf8"),
) as { provenance: Record<string, unknown>; data: unknown[] };
const capturedCatalog = readModelListEfforts(capture.data);

/** Adapter wired to a stub vendor so discovery runs without a real codex. */
function adapterFor(
  source: "live" | "snapshot",
  capture?: { args?: string[] },
): ReturnType<typeof createCodexAdapter> {
  return createCodexAdapter({
    detectVersion: async () => `codex-cli ${CODEX_VENDOR_CLI_VERSION}`,
    probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
    hasApiKey: () => false,
    probeEfforts: async () => (source === "live" ? capturedCatalog : null),
    runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
      if (capture) capture.args = options.args;
      yield { type: "completed", session_id: options.spec.session_id, ts: "2026-09-23T00:00:00Z" };
    },
  });
}

describe("the vendor pin, its capture, and the raw client_version are one value", () => {
  it("re-records every hint set against the SAME CLI the installer pins", () => {
    expect(CODEX_VENDOR_CLI_VERSION).toBe("0.156.1");
    // The capture is not a hand-written list: it declares which binary
    // produced it, and that binary is the pinned one.
    expect(capture.provenance["cli_version"]).toBe(CODEX_VENDOR_CLI_VERSION);
    expect(capture.provenance["source"]).toBe("recorded");
    // ...and it is HONEST about what it is: the CLI's bundled catalog, taken
    // with no login, never advertised as one account's entitlements.
    expect(capture.provenance["authentication"]).toBe("none");
    expect(String(capture.provenance["scope"])).toContain("BUNDLED");
    expect(capturedCatalog).not.toBeNull();
  });

  it("carries the pin into the raw model route's catalog GET", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ models: [] }));
    const profile = CredentialProfile.parse({
      profile_id: "work",
      harness_id: "codex",
      display_name: "Work",
      credential_kind: "config_dir_login",
      isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "work"),
    });
    const adapter = createCodexModelAdapter({
      fetch: fetcher,
      readAuthFile: async () =>
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: "account-one",
            access_token: `fixture.${Buffer.from(JSON.stringify({ exp: 2100000000 })).toString("base64url")}.signature`,
            refresh_token: "do-not-export",
            id_token: `fixture.${Buffer.from('{"sub":"user-one"}').toString("base64url")}.signature`,
          },
        }),
      now: () => 1900000000000,
    });
    await expect(
      adapter.catalog!({ profile, signal: new AbortController().signal }),
    ).resolves.toBeDefined();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      `/models?client_version=${CODEX_VENDOR_CLI_VERSION}`,
    );
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("client_version=0.156.1");
  });
});

describe("GPT-6 Sol and GPT-6 Luna are admitted with their own advertised ladders", () => {
  it.each(["live", "snapshot"] as const)(
    "admits both new ids and RETAINS every older one with the %s catalog",
    async (source) => {
      clearCodexEffortCache();
      const manifest = await adapterFor(source).discover();
      const known = knownModelIdsForRoute(manifest.capabilities.known_models, "local_session");
      for (const id of ["gpt-6-sol", "gpt-6-luna"])
        expect(validateModel(id, known, "manifest").status).toBe("ok");
      // The bump ADDS; it never retires. These predate 0.156.1 and stay
      // admissible for accounts that still serve them (INV-104: a truth
      // source refuses only what it can prove).
      for (const id of [
        "gpt-6-astra",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex-spark",
        "gpt-5.2",
      ])
        expect(validateModel(id, known, "manifest").status).toBe("ok");
      // Strict manifest consumers refuse an unlisted id. Native-session
      // admission retains its separate advisory-absence policy (INV-104).
      expect(validateModel("gpt-6-terra", known, "manifest").status).toBe("rejected");
      clearCodexEffortCache();
    },
  );

  it.each(["live", "snapshot"] as const)(
    "publishes the per-model effort data the vendor advertises with the %s catalog",
    async (source) => {
      clearCodexEffortCache();
      const ladders = (await adapterFor(source).discover()).capabilities.model_effort_levels;
      // Sol carries the full ladder through `ultra`; Luna stops at `max`.
      // A harness-wide union would be wrong for one of them either way.
      expect(ladders["gpt-6-sol"]).toEqual({
        levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        default: "medium",
      });
      expect(ladders["gpt-6-luna"]).toEqual({
        levels: ["low", "medium", "high", "xhigh", "max"],
        default: "medium",
      });
      clearCodexEffortCache();
    },
  );

  it("keeps the recorded snapshot equal to the pinned capture for every model it lists", () => {
    // The snapshot may cover MORE (retained historical ladders); it may never
    // DISAGREE with the pinned CLI about a model they share.
    expect(CODEX_EFFORT_SNAPSHOT.models).toMatchObject(capturedCatalog!.models);
    expect(CODEX_EFFORT_SNAPSHOT.defaultModel).toBe(capturedCatalog!.defaultModel);
  });
});

describe("the new ids reach the vendor as themselves", () => {
  it("forwards the exact model id, byte-identical, with no rewrite or family mapping", async () => {
    clearCodexEffortCache();
    const captured: { args?: string[] } = {};
    const spec = HarnessRunSpec.parse({
      session_id: "gpt6-sol-identity",
      intent: "explain",
      prompt: "Return the requested short answer.",
      cwd: "/repo",
      access: "readonly",
      model_hint: "gpt-6-sol",
      effort_hint: "ultra",
      auth_preference: "subscription",
    });
    const events: HarnessEvent[] = [];
    for await (const event of adapterFor("live", captured).run(spec)) events.push(event);
    expect(captured.args?.[captured.args.indexOf("-m") + 1]).toBe("gpt-6-sol");
    // Sol advertises `ultra`, so it rides through verbatim and nothing is
    // disclosed as changed.
    expect(captured.args).toContain('model_reasoning_effort="ultra"');
    expect(
      events.find((event) => Array.isArray(event.payload?.["ignored_settings"])),
    ).toBeUndefined();
    clearCodexEffortCache();
  });

  it("does not quietly promote Luna to a level it never advertised (INV-105)", async () => {
    clearCodexEffortCache();
    const captured: { args?: string[] } = {};
    const spec = HarnessRunSpec.parse({
      session_id: "gpt6-luna-ceiling",
      intent: "explain",
      prompt: "Return the requested short answer.",
      cwd: "/repo",
      access: "readonly",
      model_hint: "gpt-6-luna",
      effort_hint: "ultra",
      auth_preference: "subscription",
    });
    const events: HarnessEvent[] = [];
    for await (const event of adapterFor("live", captured).run(spec)) events.push(event);
    expect(captured.args?.[captured.args.indexOf("-m") + 1]).toBe("gpt-6-luna");
    // `ultra` sits above Luna's ceiling in the merged vendor order, so the run
    // sends `max` — and SAYS it moved the setting.
    expect(captured.args).toContain('model_reasoning_effort="max"');
    expect(
      events.find((event) => Array.isArray(event.payload?.["ignored_settings"]))?.payload?.[
        "ignored_settings"
      ],
    ).toEqual([expect.stringContaining("effort=ultra")]);
    clearCodexEffortCache();
  });
});

describe("the raw model route still refuses what the ACCOUNT catalog lacks", () => {
  it("refuses a manifest-known model the account does not carry, before any dispatch", async () => {
    const onDispatch = vi.fn(async () => {});
    // This account serves only gpt-5.6-sol. gpt-6-sol is a perfectly real,
    // manifest-known id — and is still refused here, because the raw route's
    // truth source is THIS account's catalog, not the manifest hint set.
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).not.toBe("POST");
      return Response.json({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6-Sol",
            priority: 1,
            visibility: "list",
            supported_reasoning_levels: [{ effort: "medium" }],
            default_reasoning_level: "medium",
            input_modalities: ["text"],
          },
        ],
      });
    });
    const profile = CredentialProfile.parse({
      profile_id: "work",
      harness_id: "codex",
      display_name: "Work",
      credential_kind: "config_dir_login",
      isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "work"),
    });
    const adapter = createCodexModelAdapter({
      fetch: fetcher,
      readAuthFile: async () =>
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: "account-one",
            access_token: `fixture.${Buffer.from(JSON.stringify({ exp: 2100000000 })).toString("base64url")}.signature`,
            refresh_token: "do-not-export",
            id_token: `fixture.${Buffer.from('{"sub":"user-one"}').toString("base64url")}.signature`,
          },
        }),
      now: () => 1900000000000,
    });
    const result = await adapter.invoke(
      ModelCallRequest.parse({
        source: "codex",
        model: "gpt-6-sol",
        account: { mode: "pin", profileId: "work" },
        messages: [{ role: "user", content: "hello" }],
      }),
      { profile, onDispatch, signal: new AbortController().signal },
    );
    expect(result.problem?.code).toBe("model_unavailable");
    expect(result.outcome).toBe("failed");
    // Never sent: no /responses POST, so nothing was spent and nothing is unknown.
    expect(onDispatch).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });
});
