import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@claudexor/config";
import { noProjectRepoRoot } from "@claudexor/util";
import { parseArgs } from "./args.js";
import { profilesCommand } from "./credential-commands.js";
import { removeProfileFromRegistry } from "./profile-registration.js";

// `profiles add` is the ONLY subcommand that does not talk to the daemon —
// it writes the durable registry through the locked global-config owner. The
// test drives it against a scoped CLAUDEXOR_CONFIG_DIR (the hermetic root).
describe("claudexor profiles add (INV-135)", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-profiles-add-"));
    prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers a config_dir_login profile through the locked global-config owner", async () => {
    const code = await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    expect(code).toBe(0);
    const config = loadConfig(noProjectRepoRoot()).global.credential_profiles;
    expect(config).toHaveLength(1);
    expect(config[0]).toMatchObject({
      profile_id: "work",
      harness_id: "claude",
      credential_kind: "config_dir_login",
      enabled: true,
    });
    // The locator lives under the confinement root (the scoped config dir).
    expect(config[0]?.isolation_locator).toContain(dir);
    expect(config[0]?.isolation_locator).toContain("claude-work");
  });

  it("appends without clobbering an existing registry entry", async () => {
    await profilesCommand(parseArgs(["profiles", "add", "claude", "a"]), true);
    await profilesCommand(parseArgs(["profiles", "add", "codex", "b"]), true);
    const ids = loadConfig(noProjectRepoRoot()).global.credential_profiles.map(
      (p) => `${p.harness_id}/${p.profile_id}`,
    );
    expect(ids).toEqual(["claude/a", "codex/b"]);
  });

  it("refuses a duplicate (harness, profile) id loudly, leaving the registry intact", async () => {
    await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    const code = await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    expect(code).not.toBe(0);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(1);
  });

  it("refuses a non-claude/codex harness and a malformed id", async () => {
    expect(await profilesCommand(parseArgs(["profiles", "add", "cursor", "x"]), true)).not.toBe(0);
    expect(
      await profilesCommand(parseArgs(["profiles", "add", "claude", "Bad Id"]), true),
    ).not.toBe(0);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(0);
  });
});

describe("removeProfileFromRegistry (INV-135 removal owner)", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-profiles-remove-"));
    prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes exactly the named entry and returns it", async () => {
    await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    await profilesCommand(parseArgs(["profiles", "add", "codex", "work"]), true);
    const removed = removeProfileFromRegistry("claude", "work");
    expect(removed).toMatchObject({ harness_id: "claude", profile_id: "work" });
    const left = loadConfig(noProjectRepoRoot()).global.credential_profiles;
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ harness_id: "codex", profile_id: "work" });
  });

  it("refuses an unknown id with a typed 404, leaving the registry intact", async () => {
    await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    expect(() => removeProfileFromRegistry("claude", "ghost")).toThrow(/no credential profile/);
    try {
      removeProfileFromRegistry("codex", "work");
      expect.unreachable("cross-harness removal must refuse");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(404);
    }
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(1);
  });
});
