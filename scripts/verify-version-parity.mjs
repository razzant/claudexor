#!/usr/bin/env node
/**
 * Version-parity bar for the release workflow: the ROOT manifest (the version
 * SSOT) and every PUBLIC workspace manifest must carry one identical version,
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
  if (!m.private) record(mp, m.version);
}

if (versions.size !== 1) {
  console.error("version drift across root + public manifests:");
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
console.log(`version parity OK: root + public manifests all at ${actual}`);
