import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_KEYCHAIN_BRIDGE_ENV, claudeNativeHomeEnv } from "./native-home.js";

const roots: string[] = [];

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Claude-only macOS Keychain bridge (INV-067)", () => {
  it("bridges only a disposable Claude child HOME and is idempotent", () => {
    const real = root("claudexor-real-home-");
    const scoped = root("claudexor-scoped-home-");
    const source = join(real, "Library", "Keychains");
    mkdirSync(source, { recursive: true });

    const first = claudeNativeHomeEnv(
      { HOME: scoped, CLAUDE_CONFIG_DIR: "/profile/a" },
      { platform: "darwin", userHome: real },
    );
    const child = join(scoped, ".claudexor-claude-native");
    const bridge = join(child, "Library", "Keychains");
    expect(first.HOME).toBe(child);
    expect(first.CLAUDE_CONFIG_DIR).toBe("/profile/a");
    expect(first[CLAUDE_KEYCHAIN_BRIDGE_ENV]).toBe("ready");
    expect(lstatSync(bridge).isSymbolicLink()).toBe(true);
    expect(realpathSync(bridge)).toBe(realpathSync(source));
    // The generic scoped HOME remains unbridged; other harnesses never see it.
    expect(existsSync(join(scoped, "Library", "Keychains"))).toBe(false);

    const second = claudeNativeHomeEnv(first, { platform: "darwin", userHome: real });
    expect(second).toEqual(first);
  });

  it("does not bridge non-macOS or the real host HOME", () => {
    const real = root("claudexor-real-home-");
    const scoped = root("claudexor-scoped-home-");
    mkdirSync(join(real, "Library", "Keychains"), { recursive: true });
    expect(claudeNativeHomeEnv({ HOME: scoped }, { platform: "linux", userHome: real })).toEqual({
      HOME: scoped,
    });
    expect(claudeNativeHomeEnv({ HOME: real }, { platform: "darwin", userHome: real })).toEqual({
      HOME: real,
    });
  });

  it("fails closed on an unexpected pre-existing bridge target", () => {
    const real = root("claudexor-real-home-");
    const scoped = root("claudexor-scoped-home-");
    mkdirSync(join(real, "Library", "Keychains"), { recursive: true });
    mkdirSync(join(scoped, ".claudexor-claude-native", "Library", "Keychains"), {
      recursive: true,
    });
    expect(() =>
      claudeNativeHomeEnv({ HOME: scoped }, { platform: "darwin", userHome: real }),
    ).toThrow(/unexpected Claude Keychain bridge target/);
  });

  it("marks a missing user Keychain as unavailable without copying credentials", () => {
    const real = root("claudexor-real-home-");
    const scoped = root("claudexor-scoped-home-");
    const result = claudeNativeHomeEnv({ HOME: scoped }, { platform: "darwin", userHome: real });
    expect(result.HOME).toBe(scoped);
    expect(result[CLAUDE_KEYCHAIN_BRIDGE_ENV]).toBe("unavailable");
  });
});
