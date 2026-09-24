/**
 * Claude Opus 5.5 on the pinned Claude CLI (2.1.280).
 *
 * Claude Code 2.1.280 released it as `claude-opus-5-5` and made it the default
 * Opus; the vendor's model overview publishes the same id as both the Claude
 * API ID and the alias. `known_models` is STRICT (INV-104), so until the id is
 * listed here an explicit `--model claude-opus-5-5` is refused at
 * settings-write and run preflight — the PR #54 defect shape, where the newest
 * Opus was unpinnable while the bare `opus` alias silently floated.
 *
 * What this file holds still:
 * 1. the new id is admitted and the older full ids are NOT displaced;
 * 2. it reaches the vendor as itself — the adapter maps no families;
 * 3. the quota projection gains it from the known-model list ALONE, with no
 *    second alias table to keep in sync (INV-138: derived, not hand-kept);
 * 4. the effort ladder the pinned binary advertises is unchanged, so this bump
 *    re-verified the snapshot rather than inheriting it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateModel } from "@claudexor/core";
import { HarnessRunSpec, knownModelIdsForRoute, type HarnessEvent } from "@claudexor/schema";
import {
  CLAUDE_KNOWN_MODELS,
  CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST,
  claudeQuotaModelAliases,
} from "./capability-profile.js";
import { CLAUDE_EFFORT_SNAPSHOT, parseClaudeEffortHelp } from "./effort-probe.js";
import { CLAUDE_VENDOR_CLI_VERSION } from "./vendor-cli-version.js";
import { createClaudeAdapter } from "./index.js";

function stubAdapter(capture?: { args?: string[] }): ReturnType<typeof createClaudeAdapter> {
  return createClaudeAdapter({
    detectVersion: async () => `${CLAUDE_VENDOR_CLI_VERSION} (Claude Code)`,
    probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
    probeAuthStatus: async () => ({
      loggedIn: true,
      authed: true,
      authMethod: "claude.ai",
      probeError: null,
    }),
    anthropicApiKey: () => null,
    claudeOAuthToken: () => null,
    probeEffortLevels: async () => ({ levels: [...CLAUDE_EFFORT_SNAPSHOT], live: true }),
    runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
      if (capture) capture.args = options.args;
      yield { type: "completed", session_id: options.spec.session_id, ts: "2026-09-23T00:00:00Z" };
    },
  });
}

describe("the pinned Claude CLI vouches for the model list it stamps", () => {
  it("pins 2.1.280 and re-reads the effort ladder from THAT binary's help", () => {
    expect(CLAUDE_VENDOR_CLI_VERSION).toBe("2.1.280");
    // One constant feeds the freshness stamp and the installer pin, so a bump
    // cannot re-verify one and leave the other claiming the old build.
    expect(CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST).toBe(CLAUDE_VENDOR_CLI_VERSION);
    // The ladder is unchanged from 2.1.261 — but it is unchanged because the
    // 2.1.280 capture SAYS so, not because nobody looked.
    const help = readFileSync(new URL("../fixtures/help-2.1.280.txt", import.meta.url), "utf8");
    expect(parseClaudeEffortHelp(help)).toEqual([...CLAUDE_EFFORT_SNAPSHOT]);
  });
});

describe("Claude Opus 5.5 is admitted without displacing anything", () => {
  it("accepts claude-opus-5-5 through the truth owner and keeps every older id", async () => {
    const manifest = await stubAdapter().discover();
    const known = knownModelIdsForRoute(manifest.capabilities.known_models, "local_session");
    expect(validateModel("claude-opus-5-5", known, "manifest").status).toBe("ok");
    // Added, never substituted: the previous generations stay admissible, and
    // so do the stable aliases the owner's saved defaults may already use.
    for (const id of [
      "opus",
      "sonnet",
      "haiku",
      "fable",
      "best",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ])
      expect(validateModel(id, known, "manifest").status).toBe("ok");
    // Strictness is intact: a plausible id the vendor never published is refused.
    const rejected = validateModel("claude-opus-5-6", known, "manifest");
    expect(rejected.status).toBe("rejected");
    expect(rejected.message).toContain("manifest known-model list");
  });

  it("forwards the exact model id to the vendor CLI, with no family rewrite", async () => {
    const captured: { args?: string[] } = {};
    const events: HarnessEvent[] = [];
    const spec = HarnessRunSpec.parse({
      session_id: "opus-5-5-identity",
      intent: "explain",
      prompt: "Return the requested short answer.",
      cwd: "/repo",
      access: "readonly",
      model_hint: "claude-opus-5-5",
      auth_preference: "subscription",
    });
    for await (const event of stubAdapter(captured).run(spec)) events.push(event);
    expect(captured.args?.[captured.args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("gains the id in the quota projection from the known-model list alone", () => {
    // INV-138: the family projection is DERIVED. If this ever needed a second
    // mapping edited by hand, that table would be the defect.
    const opus = claudeQuotaModelAliases("Opus");
    expect(opus).toContain("claude-opus-5-5");
    expect(opus).toEqual(
      CLAUDE_KNOWN_MODELS.filter(
        (model) => model === "opus" || model.startsWith("claude-opus-"),
      ).concat("best"),
    );
    // Neighbouring families are untouched by the addition.
    expect(claudeQuotaModelAliases("Sonnet")).not.toContain("claude-opus-5-5");
  });
});
