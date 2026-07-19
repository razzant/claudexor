#!/usr/bin/env node
/**
 * Version-parity bar for the release workflow: the ROOT manifest (the version
 * SSOT), every workspace manifest, and the generated runtime version must
 * carry one identical version,
 * and that version must equal the expected one (the release tag).
 *
 * Usage: node scripts/verify-version-parity.mjs <expected-version>
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";

const expected = process.argv[2];
if (!expected) {
  console.error("usage: node scripts/verify-version-parity.mjs <expected-version>");
  process.exit(2);
}

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const versions = new Map();
const record = (path, version) => {
  if (!versions.has(version)) versions.set(version, []);
  versions.get(version).push(path);
};

record("package.json", read("./package.json").version);
for (const dir of readdirSync("packages")) {
  const mp = `packages/${dir}/package.json`;
  if (!existsSync(mp)) continue;
  const m = read(mp);
  record(mp, m.version);
}
record("benchmarks/runner/package.json", read("benchmarks/runner/package.json").version);
const generated = readFileSync("packages/util/src/version.ts", "utf8").match(
  /CLAUDEXOR_VERSION = "([^"]+)"/,
)?.[1];
record("packages/util/src/version.ts", generated);

if (versions.size !== 1) {
  console.error("version drift across root + workspaces + generated runtime:");
  for (const [version, paths] of versions) {
    console.error(`  ${version}: ${paths.join(", ")}`);
  }
  process.exit(1);
}

const [actual] = versions.keys();
if (actual !== expected) {
  console.error(`manifest version ${actual} does not match expected ${expected}`);
  process.exit(1);
}

// M7 app-vs-engine skew: the engine runtime closure the app auto-updates to
// carries a `minAppVersion` floor (the oldest Claudexor.app that can run it).
// It is deliberately NOT part of the lockstep set — it is a floor, not the
// release version — but it must be a valid semver no newer than this release,
// or the app that just shipped could never run its own engine closure.
const semver = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
const cmp = (a, b) => {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
const floorFile = "release/runtime-min-app-version.json";
let minAppVersion;
try {
  minAppVersion = JSON.parse(readFileSync(floorFile, "utf8")).minAppVersion;
} catch (error) {
  console.error(`${floorFile}: unreadable (${error.message})`);
  process.exit(1);
}
const minParsed = semver(minAppVersion);
if (!minParsed) {
  console.error(`${floorFile}: minAppVersion '${minAppVersion}' is not a valid semver`);
  process.exit(1);
}
if (cmp(minParsed, semver(expected)) > 0) {
  console.error(
    `${floorFile}: minAppVersion ${minAppVersion} is newer than the release version ${expected}`,
  );
  process.exit(1);
}

console.log(
  `version parity OK: root + workspaces + generated runtime all at ${actual} (runtime minAppVersion floor ${minAppVersion})`,
);
