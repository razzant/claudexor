import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { userConfigDir } from "@claudexor/util";
import {
  CONFIG_DIR_LOGIN_HARNESSES,
  canonicalProfileLoginDir,
  configDirLoginHarnessList,
  isConfigDirLoginHarness,
} from "./config-dir-login-harnesses.js";

// The ONE owner of "this harness has an isolated config-dir/HOME login"
// (INV-122). Registration, the CLI profile-login gate, and that gate's
// canonical login-dir resolution all read it, so a wrong answer here either
// invents a profile store for a harness that has none or refuses a real one.
describe("config-dir login harness membership", () => {
  it("accepts exactly the harnesses whose native login relocates into a profile dir", () => {
    for (const harness of ["claude", "codex", "cursor", "agy", "grok"]) {
      expect(isConfigDirLoginHarness(harness)).toBe(true);
    }
    expect([...CONFIG_DIR_LOGIN_HARNESSES]).toEqual(["claude", "codex", "cursor", "agy", "grok"]);
  });

  it("refuses non-members, near-misses, and path-ish strings", () => {
    for (const value of [
      "opencode",
      "fake",
      "raw-api",
      "",
      "agyX",
      "agy ",
      "AGY",
      "Claude",
      "agy,claude",
      "/usr/local/bin/agy",
      "../agy",
      "harness-agy",
    ]) {
      expect(isConfigDirLoginHarness(value)).toBe(false);
    }
  });

  it("renders the human list the registration and login errors quote", () => {
    expect(configDirLoginHarnessList()).toBe("claude, codex, cursor, agy, grok");
    expect(configDirLoginHarnessList()).toBe(CONFIG_DIR_LOGIN_HARNESSES.join(", "));
  });

  it("resolves every member's canonical login dir through its own harness resolver", () => {
    const profiles = join(userConfigDir(), "profiles");
    mkdirSync(profiles, { recursive: true });
    // realpath: the canonicalizers resolve the macOS /var → /private/var
    // symlink, so the expected path must use the resolved spelling.
    const locator = realpathSync(mkdtempSync(join(profiles, "login-dir-")));
    try {
      for (const harness of CONFIG_DIR_LOGIN_HARNESSES) {
        expect(canonicalProfileLoginDir(harness, locator)).toBe(locator);
        // No member silently accepts a locator outside the owned root, and no
        // member falls through to another harness's (more permissive) branch.
        expect(() => canonicalProfileLoginDir(harness, "relative/path")).toThrow(
          /must be absolute/,
        );
      }
    } finally {
      rmSync(locator, { recursive: true, force: true });
    }
  });
});
