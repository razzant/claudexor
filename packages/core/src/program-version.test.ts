import { expect, it } from "vitest";
import { programUpdateAvailable } from "./program-version.js";
it.each([
  ["semver", "1.9.0", "1.10.0", "yes"],
  ["semver", "1.10.0", "1.9.0", "no"],
  ["semver", "2.0.0-beta.9", "2.0.0-beta.10", "yes"],
  ["semver", "2.0.0", "2.0.0-beta.10", "no"],
  ["semver", "2.0.0-beta.10", "2.0.0", "yes"],
  ["semver", "1.0.0+first", "1.0.0+second", "no"],
  ["semver", "next", "2.0.0", "cannot_tell"],
  ["semver", "01.0.0", "2.0.0", "cannot_tell"],
  ["date-hash", "2026.11.11-abc", "2026.11.10-def", "no"],
  ["date-hash", "2026.11.10-abc", "2026.11.11-def", "yes"],
  ["date-hash", "2026.11.10-abc", "2026.11.10-def", "cannot_tell"],
  ["date-hash", "2026.02.30-abc", "2026.03.01-def", "cannot_tell"],
  ["opaque", "abc", "def", "cannot_tell"],
  [undefined, "abc", "abc", "no"],
  ["semver", null, "1.0.0", "cannot_tell"],
] as const)("compares %s %s against %s without guessing", (scheme, selected, newest, expected) => {
  expect(programUpdateAvailable(scheme, selected, newest)).toBe(expected);
});
