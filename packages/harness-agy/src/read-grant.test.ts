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
import { AGY_READ_ANYWHERE_RULE, agySettingsPath, ensureAgyReadGrant } from "./read-grant.js";

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
    expect(ensureAgyReadGrant(home)).toEqual({ state: "added" });
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
    expect(ensureAgyReadGrant(home)).toEqual({ state: "added" });
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
    expect(ensureAgyReadGrant(home)).toEqual({ state: "present" });
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
  ])("never rewrites %s and reports why", (_label, settings, reason) => {
    const home = profileHome(settings);
    const grant = ensureAgyReadGrant(home);
    expect(grant.state).toBe("unavailable");
    expect(grant).toMatchObject({ reason: expect.stringContaining(reason) });
    expect(readFileSync(agySettingsPath(home), "utf8")).toBe(settings);
    expect(siblings(home)).toEqual(["settings.json"]);
  });

  it("treats an empty settings file as no settings", () => {
    const home = profileHome("  \n");
    expect(ensureAgyReadGrant(home)).toEqual({ state: "added" });
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
        });
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );
});
