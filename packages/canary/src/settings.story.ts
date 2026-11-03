/** Golden Settings contracts kept separate from the general CLI story so the
 * public validation matrix stays readable and below the complexity ratchet. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, cli, makeSandbox } from "./support.js";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.dispose();
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("settings canary golden stories", () => {
  it("[INV-104:settings-write-strict] refuses settings outside an authoritative harness's truth and persists nothing", () => {
    // OpenCode declares authoritative absence and has no model inventory.
    // An explicit model must be refused, never silently persisted.
    const bad = cli(sb, [
      "settings",
      "set",
      "harness.opencode.default_model",
      "ghost-model-9000",
      "--json",
    ]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toBe("");
    expect(JSON.parse(bad.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "invalid_request",
      retryable: false,
    });
    expect(bad.stdout).toContain(
      "harness 'opencode' refused defaultModel 'ghost-model-9000' (truth source: none)",
    );
    expect(bad.stdout).toContain("cannot verify models");

    const invalidGoal = cli(sb, ["settings", "set", "routing_goal", "quality", "--json"]);
    expect(invalidGoal.code).toBe(2);
    expect(invalidGoal.stderr).toBe("");
    expect(JSON.parse(invalidGoal.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "config_error",
      retryable: false,
    });

    const show = cli(sb, ["settings", "show", "--json"]);
    expect(show.stdout).not.toContain("ghost-model-9000");
    expect(show.json()).toMatchObject({ routing: { goal: "auto" } });
    const good = cli(sb, ["settings", "set", "harness.agy.default_model", "gemini-3.7-flash-high"]);
    expect(good.code).toBe(0);
    expect(good.stdout).not.toContain("note:"); // presence is proof: nothing to disclose
    const show2 = cli(sb, ["settings", "show", "--json"]);
    expect(show2.stdout).toContain("gemini-3.7-flash-high");

    // Fakes are test fixtures, never persistable routing targets.
    const fake = cli(sb, ["settings", "set", "harness.fake-success.default_model", "fake-model"]);
    expect(fake.code).toBe(2);
    expect(fake.stdout + fake.stderr).toMatch(/fake-success.*(?:not persistable|not a real)/i);
  });

  it.each([
    { harness: "codex", unknown: "gpt-ghost-9000", listed: "gpt-5.5" },
    {
      harness: "agy",
      unknown: "claude-opus-5-5-high",
      listed: "claude-opus-4-6-thinking",
    },
  ])(
    "[INV-104:settings-write-advisory] $harness persists an unlisted model and says so once",
    ({ harness, unknown, listed }) => {
      // Both adapters return advisory hints without a selected account. Presence
      // admits silently; an unknown explicit id is persisted with one disclosure.
      const setting = `harness.${harness}.default_model`;
      const note =
        `harness '${harness}' defaultModel '${unknown}' (truth source: manifest): ` +
        `model "${unknown}" is not in this harness's manifest known-model list; ` +
        "this harness's list cannot prove a model is absent, so the request is forwarded to the vendor";
      const set = cli(sb, ["settings", "set", setting, unknown, "--json"]);
      expect(set.code).toBe(0);
      expect(set.stderr).toBe("");
      const snapshot = set.json() as {
        notes: string[];
        harnesses: Record<string, { defaultModel: string | null }>;
      };
      expect(snapshot.harnesses[harness]?.defaultModel).toBe(unknown);
      expect(snapshot.notes).toEqual([note]);
      // The human form prints the same note once; a plain read carries none.
      const plain = cli(sb, ["settings", "set", setting, unknown]);
      expect(plain.code).toBe(0);
      expect(plain.stdout).toBe(`updated ${setting}\nnote: ${note}\n`);
      const show = cli(sb, ["settings", "show", "--json"]);
      expect(show.json()).toMatchObject({
        notes: [],
        harnesses: { [harness]: { defaultModel: unknown } },
      });
      // A listed model passes silently: presence is proof.
      const known = cli(sb, ["settings", "set", setting, listed, "--json"]);
      expect(known.code).toBe(0);
      expect((known.json() as { notes: string[] }).notes).toEqual([]);
    },
  );

  it("[INV-103:no-global-model] validates retired local input before daemon bootstrap", () => {
    const r = cli(sb, ["settings", "set", "default_model", "gpt-5.5"]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/harness-scoped|harness\.<id>\.default_model/);
    expect(existsSync(join(sb.configDir, "daemon", "control-api.json"))).toBe(false);

    const invalidBoolean = cli(sb, [
      "settings",
      "set",
      "harness.claude.enabled",
      "maybe",
      "--json",
    ]);
    expect(invalidBoolean.code).toBe(2);
    expect(() => JSON.parse(invalidBoolean.stdout)).not.toThrow();
    expect(existsSync(join(sb.configDir, "daemon", "control-api.json"))).toBe(false);
  });
});
