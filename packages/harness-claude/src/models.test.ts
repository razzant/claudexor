import { describe, expect, it } from "vitest";
import { validateModel } from "@claudexor/core";
import { claudeQuotaFamilyScope, knownModelIdsForRoute } from "@claudexor/schema";
import { CLAUDE_KNOWN_MODELS, CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST } from "./capability-profile.js";
import { createClaudeAdapter } from "./index.js";
import { claudeModelRows } from "./model-probe.js";

/**
 * Manifest model-truth pinning (INV-104): `known_models` is the frozen hint
 * list the manifest advertises, judged under the harness's own absence
 * declaration (Claude declares `advisory`: a foreign id is forwarded with a
 * note, never refused up front). These tests pin the CURRENT catalog entries
 * end to end: the manifest advertises the id, the stamp names the exact
 * installed CLI the list was verified against, and the truth owner
 * (`validateModel`) accepts the id round-trip and judges a foreign one by the
 * declaration. A model added to the vendor catalog but missing here is the
 * PR #54 defect shape: the newest Opus was unpinnable while the bare `opus`
 * alias silently floated.
 */
const stubAdapter = (probeModels?: () => Promise<never[]>) =>
  createClaudeAdapter({
    ...(probeModels ? { probeModels } : {}),
    detectVersion: async () => "2.1.165 (Claude Code)",
    probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
    probeAuthStatus: async () => ({
      loggedIn: true,
      authed: true,
      authMethod: "claude.ai",
      probeError: null,
    }),
    anthropicApiKey: () => null,
    claudeOAuthToken: () => null,
    probeEffortLevels: async () => ({
      levels: ["low", "medium", "high", "xhigh", "max"],
      live: true,
    }),
  });

describe("the claude manifest model truth source", () => {
  it("advertises the newest Fable (claude-fable-5-1) AND the current Opus generation — claude-opus-5 plus the still-active claude-opus-4-5", async () => {
    const manifest = await stubAdapter().discover();
    const known = manifest.capabilities.known_models;
    expect(known).toContain("claude-fable-5-1");
    expect(known).toContain("claude-opus-5");
    expect(known).toContain("claude-opus-4-5");
  });

  it("declares its live inventory ADVISORY on every route (no model_inventory_routes)", async () => {
    // The initialize picker proves presence only (it accepts ids it does not
    // list and echoes local config as rows), and it answers on every route,
    // logged out included — so the declaration is advisory and unscoped.
    const manifest = await stubAdapter().discover();
    expect(manifest.capabilities.model_inventory_absence).toBe("advisory");
    expect(manifest.capabilities.model_inventory_routes).toBeUndefined();
  });

  it("discover() never spawns the model probe; models() is the one consumer", async () => {
    let calls = 0;
    const adapter = stubAdapter(async () => {
      calls += 1;
      return [];
    });
    await adapter.discover();
    await adapter.doctor({ cwd: "/repo", fresh: true });
    expect(calls).toBe(0);
    await adapter.models?.({ cwd: "/repo" });
    expect(calls).toBe(1);
  });

  it("the known-model stamp is a frozen literal (2.1.261), never re-stamped by a pin bump", () => {
    expect(CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST).toBe("2.1.261");
    // And the frozen list is exactly the hint floor every models() answer carries.
    expect(claudeModelRows(null).map((row) => row.id)).toEqual([...CLAUDE_KNOWN_MODELS]);
  });

  it("stamps known_models_verified_against with the declared stamp constant", async () => {
    // The strict freshness gate compares this stamp against the INSTALLED
    // CLI; this test pins the wiring — the manifest exposes exactly the
    // declared constant, so re-verification is a one-place edit.
    const manifest = await stubAdapter().discover();
    expect(manifest.capabilities.known_models_verified_against).toBe(
      CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST,
    );
  });

  it("round-trips through the truth owner: validateModel accepts a manifest id and judges a foreign one by the declaration", async () => {
    // The EXACT production path (modelGovernance.ts): the schema's one owner
    // flattens the route-scoped list, then `validateModel` judges against it.
    const manifest = await stubAdapter().discover();
    const known = knownModelIdsForRoute(manifest.capabilities.known_models, "local_session");
    const absence = manifest.capabilities.model_inventory_absence ?? "authoritative";
    expect(validateModel("claude-fable-5-1", known, "manifest", absence).status).toBe("ok");
    expect(validateModel("claude-opus-5", known, "manifest", absence).status).toBe("ok");
    expect(validateModel("claude-opus-4-5", known, "manifest", absence).status).toBe("ok");
    // Outside the list: judged under the harness's own declaration, which the
    // manifest carries (both directions pinned here so the declaration is a
    // fact of this file, never a default the gate assumed).
    const foreign = validateModel("claude-opus-9-9", known, "manifest", absence);
    expect(foreign.message).toContain("manifest known-model list");
    expect(foreign.status).toBe(absence === "advisory" ? "ok" : "rejected");
    expect(validateModel("claude-opus-9-9", known, "manifest", "authoritative").status).toBe(
      "rejected",
    );
  });

  it("scopes vendor quota families by their declared id prefix, never by the frozen hints", () => {
    // A future full id joins its family; `best` and other families never do.
    expect(claudeQuotaFamilyScope(" Opus ")).toEqual({
      applies_to_models: ["opus"],
      applies_to_model_prefixes: ["claude-opus-"],
    });
    expect(claudeQuotaFamilyScope("Fable")?.applies_to_model_prefixes).toEqual(["claude-fable-"]);
    expect(CLAUDE_KNOWN_MODELS).not.toContain("claude-opus-5-5");
    // An empty or multi-word name is not a family: producers keep it diagnostic.
    expect(claudeQuotaFamilyScope("   ")).toBeNull();
    expect(claudeQuotaFamilyScope("Opus 4.8")).toBeNull();
  });
});
