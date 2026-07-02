#!/usr/bin/env node
/**
 * Gate: every generated JSON Schema must compile under its declared dialect
 * (draft-07). Catches generator regressions like the historical invalid
 * "jsonSchema2020-12" target that silently emitted a draft-4/7 hybrid
 * (boolean `exclusiveMinimum`) no modern validator accepts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const here = dirname(fileURLToPath(import.meta.url));
const genDir = join(here, "..", "packages", "schema", "generated");

const files = readdirSync(genDir).filter((f) => f.endsWith(".schema.json"));
if (files.length === 0) {
  console.error("validate-generated-schemas: no generated schemas found");
  process.exit(1);
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const failures = [];
for (const file of files) {
  const raw = JSON.parse(readFileSync(join(genDir, file), "utf8"));
  if (raw.$schema !== "http://json-schema.org/draft-07/schema#") {
    failures.push(`${file}: missing/unexpected $schema declaration (${raw.$schema ?? "none"})`);
    continue;
  }
  try {
    ajv.compile(raw);
  } catch (err) {
    failures.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failures.length > 0) {
  console.error(`validate-generated-schemas: ${failures.length} schema(s) failed to compile:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`validate-generated-schemas: ${files.length} schemas compile clean (draft-07)`);
