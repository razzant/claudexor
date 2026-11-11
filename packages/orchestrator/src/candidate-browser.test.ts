import { describe, expect, it } from "vitest";
import type { RouteDropStage } from "@claudexor/schema";
import { projectCandidateBrowserPool } from "./candidate-browser.js";
import { RequestRequirementsError, RequestRequirementsResolver } from "./requestRequirements.js";
import { assertCandidatePoolAvailable } from "./route-admission.js";
import type { RoutedAdapter, RunInput } from "./orchestrator.js";
import { CODEX_CAPABILITY_PROFILE } from "../../harness-codex/src/capability-profile.js";
import { CLAUDE_CAPABILITY_PROFILE } from "../../harness-claude/src/capability-profile.js";

const requirements = new RequestRequirementsResolver();
const pool = [
  { harnessId: "codex", profile: CODEX_CAPABILITY_PROFILE },
  { harnessId: "claude", profile: CLAUDE_CAPABILITY_PROFILE },
].map(({ harnessId, profile }) => {
  // The projection reads only identity and the canonical requirement receipt.
  return {
    adapter: { id: harnessId },
    browserRequirement: requirements.resolveBrowser({
      harnessId,
      requested: true,
      manifestCapable: true,
      requiresFullAccess: profile.mcp_injection_requires_full_access,
      access: "workspace_write",
      webPolicy: "auto",
    }),
  } as RoutedAdapter;
});

const input: RunInput = { repoRoot: "/fixture", prompt: "work", browser: true };

describe("resolved Browser projection scope", () => {
  it.each([
    { mode: "ask" as const },
    { mode: "plan" as const },
    { mode: "ask" as const, deepScan: true, n: 1 },
    { mode: "plan" as const, council: true, n: 2 },
    { n: 2 },
    { untilClean: true },
    { attempts: 1 },
    { harnesses: ["codex", "claude"] },
    { harnesses: ["codex"] },
    { credentialProfileId: "chosen" },
    { primaryHarness: "codex", primaryHarnessExplicit: true },
    { browser: false },
  ])("preserves the mixed pool outside ordinary single Auto: %j", (extra) => {
    const drops: unknown[] = [];
    expect(
      projectCandidateBrowserPool({ ...input, ...extra }, pool, requirements, (...drop) =>
        drops.push(drop),
      ),
    ).toEqual(pool);
    expect(drops).toEqual([]);
  });

  it.each([
    {},
    { mode: "agent" as const, n: 1 },
    { harnesses: [], credentialProfileId: null },
    { primaryHarness: "codex", primaryHarnessExplicit: false },
  ])("projects ordinary Auto with resolved defaults: %j", (extra) => {
    const drops: Array<[string, RouteDropStage, string]> = [];
    expect(
      projectCandidateBrowserPool({ ...input, ...extra }, pool, requirements, (...drop) =>
        drops.push(drop),
      ),
    ).toEqual([pool[1]]);
    expect(drops).toEqual([["codex", "access", "codex (browser: access_profile_incompatible)"]]);
  });

  it.each([
    ["manifest_unsupported", "capability"],
    ["web_policy_off", "web"],
  ] as const)("discloses actual %s omission at %s stage", (reason, stage) => {
    const incompatible = {
      ...pool[0]!,
      browserRequirement: { ...pool[0]!.browserRequirement, reason },
    };
    const drops: unknown[] = [];
    projectCandidateBrowserPool(input, [incompatible, pool[1]!], requirements, (...drop) =>
      drops.push(drop),
    );
    expect(drops).toEqual([["codex", stage, `codex (browser: ${reason})`]]);
  });

  it("keeps zero-effective Browser receipts and their typed refusal", () => {
    expect(() =>
      requirements.resolveBrowserPool(true, true, [pool[0]!.browserRequirement]),
    ).toThrow(RequestRequirementsError);
    try {
      requirements.resolveBrowserPool(true, true, [pool[0]!.browserRequirement]);
    } catch (error) {
      expect(error).toMatchObject({
        code: "browser_unavailable",
        resolutions: [pool[0]!.browserRequirement],
      });
    }
  });

  it("preserves an earlier empty ordinary-pool access refusal", () => {
    expect(() =>
      assertCandidatePoolAvailable(
        [],
        "implement",
        [{ harnessId: "codex", stage: "access", detail: "codex cannot enforce access" }],
        new Set(),
      ),
    ).toThrow("no harness can enforce the requested access profile");
  });
});
