#!/usr/bin/env node
/**
 * Model-hints freshness gate (T2#6d, INV-104 freshness note).
 *
 * Data-driven: every harness manifest that declares `known_models` also
 * records `known_models_verified_against` — the vendor CLI version the hint
 * set was last verified against. This gate discovers those manifests through
 * the real adapter registry (no hardcoded harness/model lists in logic), asks
 * each installed vendor CLI for its version, and WARNS (exit 0) when the
 * installed version differs — stale hints are a freshness smell, not a build
 * breaker. Exit 1 only for structural violations: a non-empty `known_models`
 * with NO recorded verification version (an unverifiable hint set).
 *
 * Usage: node scripts/model-hints-freshness.mjs [--strict]
 *   --strict  escalate version-mismatch warnings to failures (release use).
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");

const { buildRegistry } = await import(
  pathToFileURL(join(root, "packages/cli/dist/registry.js")).href
);

// First semver-looking token ("codex-cli 0.137.0" / "2.1.165 (Claude Code)").
const semver = (s) => /(\d+\.\d+\.\d+)/.exec(s ?? "")?.[1] ?? null;

const warnings = [];
const failures = [];
for (const adapter of buildRegistry({ includeFakes: false }).values()) {
  let manifest;
  try {
    manifest = await adapter.discover();
  } catch {
    continue;
  }
  const caps = manifest.capabilities ?? {};
  const known = caps.known_models ?? [];
  const verified = caps.known_models_verified_against ?? null;
  if (typeof adapter.models === "function") continue; // live inventory is the truth source
  if (known.length === 0) continue; // no hint set to keep fresh
  if (!verified) {
    failures.push(
      `${adapter.id}: known_models has ${known.length} entr${known.length === 1 ? "y" : "ies"} but no known_models_verified_against — record the vendor CLI version the list was checked with`,
    );
    continue;
  }
  // The adapter's own discover() already reports the installed vendor CLI
  // version — compare against that instead of re-spawning binaries.
  const installed = semver(manifest.version);
  if (installed === null) {
    console.log(`model-hints: ${adapter.id} — vendor CLI not discoverable here; hints verified against ${verified} (unchecked)`);
    continue;
  }
  if (installed !== semver(verified)) {
    warnings.push(
      `${adapter.id}: installed CLI ${installed} != known_models verified against ${verified} — re-verify the manifest hint set against the current CLI`,
    );
  } else {
    console.log(`model-hints: ${adapter.id} — hints fresh (CLI ${installed})`);
  }
}

for (const w of warnings) console.warn(`model-hints WARNING: ${w}`);
for (const f of failures) console.error(`model-hints FAILURE: ${f}`);
if (failures.length > 0 || (strict && warnings.length > 0)) process.exit(1);
console.log("model-hints freshness gate passed" + (warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""));
