import { describe, expect, it } from "vitest";
import { ControlHarnessSettingsPatch, ControlSettingsUpdateRequest } from "@claudexor/schema";
import { GLOBAL_SETTING_FIELDS, HARNESS_SETTING_FIELDS, settingPatch } from "./settings-command.js";

/**
 * Settings-coverage sweep (D28 / M6 item 3): every global/per-harness setting
 * the daemon HONORS (the ControlSettingsUpdateRequest + ControlHarnessSettingsPatch
 * schemas) must be reachable through the CLI settings surface. These sweeps are
 * self-enforcing: a NEW settable schema field with no CLI mapping FAILS here.
 */
describe("settings coverage sweep", () => {
  it("every global settable field is reachable via a CLI key", () => {
    const reachable = new Set<string>(Object.values(GLOBAL_SETTING_FIELDS));
    // `harnesses` is the per-harness container, covered by the harness sweep.
    const schemaKeys = Object.keys(ControlSettingsUpdateRequest.shape).filter(
      (k) => k !== "harnesses",
    );
    for (const key of schemaKeys) {
      expect(reachable.has(key), `global setting '${key}' has no CLI key`).toBe(true);
    }
  });

  it("every per-harness settable field is reachable via a CLI key", () => {
    const reachable = new Set<string>(Object.values(HARNESS_SETTING_FIELDS));
    for (const key of Object.keys(ControlHarnessSettingsPatch.shape)) {
      expect(reachable.has(key), `harness setting '${key}' has no CLI key`).toBe(true);
    }
  });

  it("no CLI mapping points at a field that no longer exists (no stale keys)", () => {
    const globalSchema = new Set(Object.keys(ControlSettingsUpdateRequest.shape));
    for (const field of Object.values(GLOBAL_SETTING_FIELDS)) {
      expect(globalSchema.has(field), `stale global mapping to '${field}'`).toBe(true);
    }
    const harnessSchema = new Set(Object.keys(ControlHarnessSettingsPatch.shape));
    for (const field of Object.values(HARNESS_SETTING_FIELDS)) {
      expect(harnessSchema.has(field), `stale harness mapping to '${field}'`).toBe(true);
    }
  });
});

describe("settingPatch", () => {
  it("maps the newly-covered global auth_preference", () => {
    expect(settingPatch("auth_preference", "api_key")).toEqual({ authPreference: "api_key" });
  });

  it("maps per-harness typed fields (boolean/number/array/enum)", () => {
    expect(settingPatch("harness.claude.enabled", "false")).toEqual({
      harnesses: { claude: { enabled: false } },
    });
    expect(settingPatch("harness.claude.max_turns", "12")).toEqual({
      harnesses: { claude: { maxTurns: 12 } },
    });
    expect(settingPatch("harness.claude.max_rounds", "none")).toEqual({
      harnesses: { claude: { maxRounds: null } },
    });
    expect(settingPatch("harness.claude.tools_allow", "read, write")).toEqual({
      harnesses: { claude: { toolsAllow: ["read", "write"] } },
    });
    expect(settingPatch("harness.codex.web", "off")).toEqual({
      harnesses: { codex: { web: "off" } },
    });
    expect(settingPatch("harness.codex.auth_preference", "subscription")).toEqual({
      harnesses: { codex: { authPreference: "subscription" } },
    });
    expect(settingPatch("harness.codex.profile_limit_action", "rotate")).toEqual({
      harnesses: { codex: { profileLimitAction: "rotate" } },
    });
  });

  it("refuses an unknown key loudly", () => {
    expect(() => settingPatch("nonsense_key", "x")).toThrow(/unknown setting/);
  });

  it("refuses a bad typed value loudly (enabled must be boolean-like)", () => {
    expect(() => settingPatch("harness.claude.enabled", "maybe")).toThrow(/true or false/);
  });

  it("refuses an out-of-enum value loudly (web policy)", () => {
    expect(() => settingPatch("harness.claude.web", "bogus")).toThrow();
  });
});
