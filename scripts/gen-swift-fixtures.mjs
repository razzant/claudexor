#!/usr/bin/env node
/**
 * TS↔Swift wire-fixture generator + freshness gate (D13, INV-138: derived,
 * never hand-maintained). Emits one canonical JSON file per fixture into the
 * Swift test bundle; `--check` fails when the committed files drift from the
 * regenerated set (same discipline as `pnpm schema:gen` + git diff).
 *
 * The Swift round-trip test decodes each file into its DTO, re-encodes, and
 * compares CANONICALIZED JSON (sorted keys, normalized numbers) — byte
 * comparison is a trap (Swift JSONEncoder will never reproduce these bytes).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWireFixtures } from "./lib/wire-fixtures.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "apps/macos/ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/wire");

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

const fixtures = buildWireFixtures();
const check = process.argv.includes("--check");
const manifest = {};
let drift = 0;

mkdirSync(outDir, { recursive: true });
for (const fixture of fixtures) {
  const file = join(outDir, `${fixture.name}.json`);
  const body = `${JSON.stringify({ schema: fixture.schema, value: fixture.value }, null, 2)}\n`;
  manifest[fixture.name] = fixture.schema;
  if (check) {
    const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (existing === null || canonical(JSON.parse(existing)) !== canonical(JSON.parse(body))) {
      console.error(`wire-fixture drift: ${fixture.name}.json (regenerate: pnpm fixtures:swift)`);
      drift += 1;
    }
  } else {
    writeFileSync(file, body);
  }
}
// Stale files (a fixture renamed/deleted upstream) fail the check too.
const expected = new Set(fixtures.map((f) => `${f.name}.json`));
expected.add("manifest.json");
for (const name of existsSync(outDir) ? readdirSync(outDir) : []) {
  if (!expected.has(name)) {
    if (check) {
      console.error(`stale wire fixture: ${name} (regenerate: pnpm fixtures:swift)`);
      drift += 1;
    }
  }
}
const manifestFile = join(outDir, "manifest.json");
const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
if (check) {
  const existing = existsSync(manifestFile) ? readFileSync(manifestFile, "utf8") : null;
  if (
    existing === null ||
    canonical(JSON.parse(existing)) !== canonical(JSON.parse(manifestBody))
  ) {
    console.error("wire-fixture drift: manifest.json");
    drift += 1;
  }
  if (drift > 0) process.exit(1);
  console.log(`wire fixtures fresh (${fixtures.length})`);
} else {
  writeFileSync(manifestFile, manifestBody);
  console.log(`wrote ${fixtures.length} wire fixtures + manifest to ${outDir}`);
}
