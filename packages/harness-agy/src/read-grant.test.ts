import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGY_READ_ANYWHERE_RULE,
  agyReadsHeldBySettings,
  agySettingsPath,
  ensureAgyReadGrant,
  readAgyProfileSettings,
  type AgyPermissionRules,
  type AgyProfileSettings,
} from "./read-grant.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function profileHome(settings?: string): string {
  const home = mkdtempSync(join(tmpdir(), "agy-read-grant-"));
  homes.push(home);
  if (settings !== undefined) {
    mkdirSync(dirname(agySettingsPath(home)), { recursive: true });
    writeFileSync(agySettingsPath(home), settings, { mode: 0o640 });
    chmodSync(agySettingsPath(home), 0o640);
  }
  return home;
}

const read = (home: string): unknown => JSON.parse(readFileSync(agySettingsPath(home), "utf8"));
const siblings = (home: string): string[] => readdirSync(dirname(agySettingsPath(home))).sort();

describe("agy profile read grant", () => {
  it("creates private settings with the read rule when the profile has none", () => {
    const home = profileHome();
    expect(ensureAgyReadGrant(home)).toEqual({
      state: "added",
      rules: { allow: [AGY_READ_ANYWHERE_RULE], deny: [], ask: [] },
    });
    expect(read(home)).toEqual({ permissions: { allow: [AGY_READ_ANYWHERE_RULE] } });
    expect(statSync(agySettingsPath(home)).mode & 0o777).toBe(0o600);
    expect(siblings(home)).toEqual(["settings.json"]);
  });

  it("adds the rule once and keeps every other key, rule and the file mode", () => {
    const home = profileHome(
      JSON.stringify({
        theme: "dark",
        permissions: { allow: ["command(git status)"], deny: ["command(sudo *)"] },
      }),
    );
    expect(ensureAgyReadGrant(home)).toEqual({
      state: "added",
      rules: {
        allow: ["command(git status)", AGY_READ_ANYWHERE_RULE],
        deny: ["command(sudo *)"],
        ask: [],
      },
    });
    const expected = {
      theme: "dark",
      permissions: {
        allow: ["command(git status)", AGY_READ_ANYWHERE_RULE],
        deny: ["command(sudo *)"],
      },
    };
    expect(read(home)).toEqual(expected);
    expect(statSync(agySettingsPath(home)).mode & 0o777).toBe(0o640);
    const before = readFileSync(agySettingsPath(home), "utf8");
    expect(ensureAgyReadGrant(home)).toEqual({
      state: "present",
      rules: { ...expected.permissions, ask: [] },
    });
    expect(readFileSync(agySettingsPath(home), "utf8")).toBe(before);
    expect(siblings(home)).toEqual(["settings.json"]);
  });

  it.each([
    ["invalid JSON", "{ theme: dark", "not valid JSON"],
    ["a non-object document", "[]", "not a JSON object"],
    [
      "non-object permissions",
      JSON.stringify({ permissions: "allow" }),
      "permissions is not an object",
    ],
    [
      "a non-list allow",
      JSON.stringify({ permissions: { allow: "read_file(*)" } }),
      "allow is not a list",
    ],
    // Every list and its contents are checked before the grant is written.
    [
      "an allow holding a non-rule",
      JSON.stringify({ permissions: { allow: ["command(git status)", 7] } }),
      "permissions.allow is not a list of rules",
    ],
    [
      "a deny that is not a list",
      JSON.stringify({ permissions: { deny: "read_file(/secret/**)" } }),
      "permissions.deny is not a list of rules",
    ],
    [
      "an ask holding a non-rule",
      JSON.stringify({ permissions: { allow: [], ask: [{ rule: "mcp(*)" }] } }),
      "permissions.ask is not a list of rules",
    ],
  ])("never rewrites %s and reports why", (_label, settings, reason) => {
    const home = profileHome(settings);
    const grant = ensureAgyReadGrant(home);
    expect(grant.state).toBe("unavailable");
    expect(grant).toMatchObject({ reason: expect.stringContaining(reason) });
    // Unknown settings carry no rules: nothing can be composed from them.
    expect(grant.rules).toBeUndefined();
    expect(readFileSync(agySettingsPath(home), "utf8")).toBe(settings);
    expect(siblings(home)).toEqual(["settings.json"]);
  });

  it("treats an empty settings file as no settings", () => {
    const home = profileHome("  \n");
    expect(ensureAgyReadGrant(home)).toMatchObject({ state: "added" });
    expect(read(home)).toEqual({ permissions: { allow: [AGY_READ_ANYWHERE_RULE] } });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a failed write and leaves no temp file behind",
    () => {
      const home = profileHome();
      const dir = dirname(agySettingsPath(home));
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o500);
      try {
        const grant = ensureAgyReadGrant(home);
        expect(grant).toMatchObject({
          state: "unavailable",
          reason: expect.stringContaining("could not be written"),
          // The rules as read, with the grant, stay known when saving fails.
          rules: { allow: [AGY_READ_ANYWHERE_RULE], deny: [], ask: [] },
        });
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it("saves the grant from the run's one snapshot, only while the file still holds it", () => {
    const onDisk = JSON.stringify({ theme: "on disk" });
    const home = profileHome(onDisk);
    // An artificial snapshot of these bytes: the write follows its settings,
    // never a second parse of the file.
    const snapshot = {
      state: "read" as const,
      settings: { theme: "snapshot", permissions: { deny: ["command(sudo)"] } },
      rules: {
        state: "valid" as const,
        lists: { allow: [], deny: ["command(sudo)"], ask: [] },
      },
      text: onDisk,
      mode: 0o600,
    };
    const rules = { allow: [AGY_READ_ANYWHERE_RULE], deny: ["command(sudo)"], ask: [] };
    expect(ensureAgyReadGrant(home, snapshot)).toEqual({ state: "added", rules });
    expect(read(home)).toEqual({
      theme: "snapshot",
      permissions: { deny: ["command(sudo)"], allow: [AGY_READ_ANYWHERE_RULE] },
    });
    // The file already holds exactly what this snapshot would write, as after
    // another run saved the same grant from the same settings: left alone.
    const granted = readFileSync(agySettingsPath(home), "utf8");
    expect(ensureAgyReadGrant(home, snapshot)).toEqual({ state: "present", rules });
    expect(readFileSync(agySettingsPath(home), "utf8")).toBe(granted);
    // Settings saved after the snapshot are never replaced by it, and its
    // out-of-date lists are not handed on.
    const newer = JSON.stringify({ theme: "newer", toolPermission: "request-review" });
    writeFileSync(agySettingsPath(home), newer);
    expect(ensureAgyReadGrant(home, snapshot)).toEqual({
      state: "changed",
      reason: "settings.json changed after this run read it; the newer file was left as it is",
    });
    expect(readFileSync(agySettingsPath(home), "utf8")).toBe(newer);
    expect(siblings(home)).toEqual(["settings.json"]);
    // A file that appeared after a snapshot of none, or went away after one
    // was read, is a change too.
    const appeared = profileHome(newer);
    expect(ensureAgyReadGrant(appeared, { ...snapshot, text: null })).toMatchObject({
      state: "changed",
    });
    expect(readFileSync(agySettingsPath(appeared), "utf8")).toBe(newer);
    const removed = profileHome();
    mkdirSync(dirname(agySettingsPath(removed)), { recursive: true });
    expect(ensureAgyReadGrant(removed, snapshot)).toMatchObject({ state: "changed" });
    expect(siblings(removed)).toEqual([]);
    // An invalid snapshot writes nothing, whatever the file holds.
    const before = readFileSync(agySettingsPath(home), "utf8");
    expect(
      ensureAgyReadGrant(home, {
        ...snapshot,
        rules: { state: "invalid", reason: "settings.json permissions.ask is not a list of rules" },
      }),
    ).toEqual({
      state: "unavailable",
      reason: "settings.json permissions.ask is not a list of rules",
    });
    expect(readFileSync(agySettingsPath(home), "utf8")).toBe(before);
  });
});

describe("agy profile settings read without writing", () => {
  it("reads a missing or empty file as no settings and creates nothing", () => {
    const none = { state: "valid", lists: { allow: [], deny: [], ask: [] } };
    const missing = profileHome();
    expect(readAgyProfileSettings(missing)).toEqual({
      state: "read",
      settings: {},
      rules: none,
      text: null,
      mode: 0o600,
    });
    expect(readdirSync(missing)).toEqual([]);
    const empty = profileHome("  \n");
    expect(readAgyProfileSettings(empty)).toEqual({
      state: "read",
      settings: {},
      rules: none,
      text: "  \n",
      mode: 0o640,
    });
    expect(readFileSync(agySettingsPath(empty), "utf8")).toBe("  \n");
  });

  it("returns the settings as saved and never adds the read rule", () => {
    const saved = JSON.stringify({
      toolPermission: "request-review",
      permissions: { allow: ["command(git status)"], deny: ["command(sudo)"] },
    });
    const home = profileHome(saved);
    const before = statSync(agySettingsPath(home));
    expect(readAgyProfileSettings(home)).toEqual({
      state: "read",
      settings: JSON.parse(saved),
      rules: {
        state: "valid",
        lists: { allow: ["command(git status)"], deny: ["command(sudo)"], ask: [] },
      },
      text: saved,
      mode: 0o640,
    });
    expect(readFileSync(agySettingsPath(home), "utf8")).toBe(saved);
    expect(statSync(agySettingsPath(home)).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(agySettingsPath(home)).mode & 0o777).toBe(0o640);
    expect(siblings(home)).toEqual(["settings.json"]);
  });

  it.each([
    ["invalid JSON", "{ theme: dark", "not valid JSON"],
    ["a non-object document", "[]", "not a JSON object"],
  ])("reports %s as unavailable, never as empty", (_label, settings, reason) => {
    const home = profileHome(settings);
    expect(readAgyProfileSettings(home)).toEqual({
      state: "unavailable",
      reason: expect.stringContaining(reason),
    });
    expect(readFileSync(agySettingsPath(home), "utf8")).toBe(settings);
  });

  it("keeps a readable document whose lists are not lists of rules, and says why", () => {
    const saved = JSON.stringify({ toolPermission: "strict", permissions: { ask: "mcp(*)" } });
    const home = profileHome(saved);
    expect(readAgyProfileSettings(home)).toEqual({
      state: "read",
      settings: JSON.parse(saved),
      rules: { state: "invalid", reason: "settings.json permissions.ask is not a list of rules" },
      text: saved,
      mode: 0o640,
    });
    expect(readFileSync(agySettingsPath(home), "utf8")).toBe(saved);
  });
});

describe("agy reads the profile's own settings hold back", () => {
  const snapshotOf = (
    settings: Record<string, unknown>,
    { allow = [], deny = [], ask = [] }: Partial<AgyPermissionRules> = {},
  ): Extract<AgyProfileSettings, { state: "read" }> => ({
    state: "read",
    settings,
    rules: { state: "valid", lists: { allow, deny, ask } },
    text: null,
    mode: 0o600,
  });
  const ASKS = "asks before every read, which a headless run cannot answer";

  it("names strict and the all-files rule in ask or deny, as written", () => {
    expect(agyReadsHeldBySettings(snapshotOf({ toolPermission: "strict" }), false)).toBe(
      `the profile's toolPermission "strict" ${ASKS}`,
    );
    expect(agyReadsHeldBySettings(snapshotOf({}, { ask: [AGY_READ_ANYWHERE_RULE] }), false)).toBe(
      `the profile's ask rule read_file(*) ${ASKS}`,
    );
    const denied = snapshotOf(
      {},
      { allow: [AGY_READ_ANYWHERE_RULE], deny: [AGY_READ_ANYWHERE_RULE] },
    );
    const refused = "the profile's deny rule read_file(*) refuses every read";
    expect(agyReadsHeldBySettings(denied, false)).toBe(refused);
    // Where the run's prompts are approved (full access), only the deny rule holds.
    expect(agyReadsHeldBySettings(denied, true)).toBe(refused);
    const asking = snapshotOf({ toolPermission: "strict" }, { ask: [AGY_READ_ANYWHERE_RULE] });
    expect(agyReadsHeldBySettings(asking, true)).toBeNull();
  });

  it("interprets no other rule or setting, and leaves unknown settings to the grant", () => {
    const invalid = "settings.json permissions.ask is not a list of rules";
    for (const profile of [
      snapshotOf({}),
      snapshotOf({ toolPermission: "request-review" }),
      snapshotOf({}, { allow: [AGY_READ_ANYWHERE_RULE] }),
      snapshotOf({}, { deny: ["read_file(/secret/**)"], ask: ["read_file(**)", "mcp(*)"] }),
      { state: "unavailable", reason: "settings.json is not valid JSON" } as const,
      { ...snapshotOf({ toolPermission: "strict" }), rules: { state: "invalid", reason: invalid } },
    ] satisfies AgyProfileSettings[])
      expect(agyReadsHeldBySettings(profile, false)).toBeNull();
  });

  it("keeps an explicit all-files deny rule when an unrelated list is malformed", () => {
    const invalid = "settings.json permissions.ask is not a list of rules";
    const withRaw = (permissions: unknown) => ({
      ...snapshotOf({ permissions }),
      rules: { state: "invalid", reason: invalid } as const,
    });
    const refused = "the profile's deny rule read_file(*) refuses every read";
    for (const approved of [false, true])
      expect(
        agyReadsHeldBySettings(
          withRaw({ deny: [AGY_READ_ANYWHERE_RULE], ask: "mcp(*)" }),
          approved,
        ),
      ).toBe(refused);
    // Unknown is still not a denial: no new limit where nothing denies every read.
    for (const permissions of [{ ask: "mcp(*)" }, { deny: "read_file(*)" }, "read_file(*)"])
      expect(agyReadsHeldBySettings(withRaw(permissions), true)).toBeNull();
  });
});
