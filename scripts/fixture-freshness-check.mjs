#!/usr/bin/env node
/**
 * Fixture provenance + freshness gate (Tier7 #49).
 *
 * Structural rules (exit 1 — an unexplained fixture is a governance hole):
 * - every `packages/harness-<x>/fixtures/` directory has a `manifest.yaml`;
 * - every `*.jsonl` fixture is covered by a manifest entry with a `source`;
 * - `source: recorded` entries carry a `cli_version`;
 * - stale manifest entries (file gone) fail too.
 *
 * Freshness rules (warnings, exit 0):
 * - DRIFT: a recorded fixture's `cli_version` differs from the INSTALLED CLI
 *   (the recording no longer proves the installed CLI's stream shape) —
 *   `--strict` escalates THESE to failures (release use: re-record).
 * - DISCLOSURE: a harness has NO recorded fixture at all (synthetic-only
 *   coverage) — always warning-grade, NEVER strict-fatal: recording is gated
 *   on live route availability, not on the release calendar.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");

/** Minimal YAML reader for the manifest's flat shape (no deps in scripts). */
function parseManifest(text) {
  const lines = text.split("\n");
  const out = { cli: null, fixtures: {} };
  let current = null;
  for (const line of lines) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const cli = /^cli:\s*(\S+)/.exec(line);
    if (cli) {
      out.cli = cli[1];
      continue;
    }
    if (/^fixtures:/.test(line)) continue;
    const entry = /^ {2}(\S[^:]*?):\s*$/.exec(line);
    if (entry) {
      current = entry[1];
      out.fixtures[current] = {};
      continue;
    }
    // Quotes are all-or-nothing: a half-quoted value simply does not match
    // this pattern, leaving the field undefined — recorded entries then fail
    // the downstream semver structural check instead of passing garbage.
    const field = /^ {4}(\w+):\s*(?:"([^"\n]*)"|([^"\s][^\n]*?))\s*$/.exec(line);
    if (field && current) out.fixtures[current][field[1]] = field[2] ?? field[3];
  }
  return out;
}

/** First semver-looking token (same extraction rule as
 * model-hints-freshness.mjs — both gates must agree on what "the installed
 * version" means for a vendor CLI banner like "codex-cli 0.137.0"). */
const semver = (s) => /(\d+\.\d+\.\d+)/.exec(s ?? "")?.[1] ?? null;

function installedVersion(cliName) {
  const candidates = {
    codex: [join(homedir(), ".claudex", "node", "bin", "codex"), "codex"],
    claude: [join(homedir(), ".claudex", "node", "bin", "claude"), "claude"],
    cursor: [join(homedir(), ".local", "bin", "cursor-agent"), "cursor-agent"],
    opencode: ["opencode"],
  }[cliName] ?? [cliName];
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
      const v = semver(out);
      if (v) return v;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const failures = [];
const driftWarnings = []; // strict-escalatable: recorded fixture vs installed CLI
const disclosures = []; // never strict-fatal: synthetic-only coverage notes

// A harness package with NO fixtures dir must be EXEMPT with a reason —
// silently skipping it would let a new adapter ship with zero stream proof.
const NO_FIXTURES_EXEMPT = {
  "harness-fake": "the fake harnesses ARE the deterministic synthetic sources other suites consume",
  "harness-raw-api": "no native CLI stream exists to record; the adapter consumes the OpenAI-compatible HTTP API shape directly (unit-tested in-package)",
};
const packagesDir = join(root, "packages");
const allHarnessPkgs = readdirSync(packagesDir).filter((d) => d.startsWith("harness-"));
for (const pkg of allHarnessPkgs) {
  if (!existsSync(join(packagesDir, pkg, "fixtures")) && !(pkg in NO_FIXTURES_EXEMPT)) {
    failures.push(`packages/${pkg}: no fixtures/ directory and no NO_FIXTURES_EXEMPT entry — new adapters need stream fixtures or a justified exemption`);
  }
}
for (const exempt of Object.keys(NO_FIXTURES_EXEMPT)) {
  if (!allHarnessPkgs.includes(exempt)) failures.push(`NO_FIXTURES_EXEMPT lists '${exempt}' which is not a harness package — stale exemption`);
  else if (existsSync(join(packagesDir, exempt, "fixtures"))) failures.push(`NO_FIXTURES_EXEMPT lists '${exempt}' but it HAS a fixtures dir — drop the stale exemption`);
}
const harnessDirs = allHarnessPkgs.filter((d) => existsSync(join(packagesDir, d, "fixtures")));
for (const pkg of harnessDirs) {
  const fixturesDir = join(packagesDir, pkg, "fixtures");
  const manifestPath = join(fixturesDir, "manifest.yaml");
  const relDir = relative(root, fixturesDir);
  if (!existsSync(manifestPath)) {
    failures.push(`${relDir}: missing manifest.yaml (every fixture needs declared provenance)`);
    continue;
  }
  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  if (!manifest.cli) {
    failures.push(`${relDir}/manifest.yaml: missing top-level 'cli:'`);
    continue;
  }
  // Collect every .jsonl under the fixtures dir (one level of subdirs is enough today).
  const files = [];
  for (const entry of readdirSync(fixturesDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entry.name);
    if (entry.isDirectory()) {
      for (const sub of readdirSync(join(fixturesDir, entry.name), { withFileTypes: true })) {
        if (sub.isFile() && sub.name.endsWith(".jsonl")) files.push(`${entry.name}/${sub.name}`);
      }
    }
  }
  for (const file of files) {
    const entry = manifest.fixtures[file];
    if (!entry) {
      failures.push(`${relDir}/${file}: not covered by manifest.yaml`);
      continue;
    }
    if (entry.source !== "synthetic" && entry.source !== "recorded") {
      failures.push(`${relDir}/${file}: source must be 'synthetic' or 'recorded' (got '${entry.source ?? ""}')`);
    }
    if (entry.source === "recorded" && !semver(entry.cli_version)) {
      failures.push(`${relDir}/${file}: recorded fixture without a semver cli_version`);
    }
  }
  for (const declared of Object.keys(manifest.fixtures)) {
    if (!files.includes(declared)) failures.push(`${relDir}/manifest.yaml declares '${declared}' but the file is gone — stale entry`);
  }
  const recorded = Object.entries(manifest.fixtures).filter(([, e]) => e.source === "recorded");
  if (recorded.length === 0) {
    disclosures.push(`${manifest.cli}: SYNTHETIC-ONLY fixtures (no recorded real stream) — record one when a live route is available`);
    continue;
  }
  const installed = installedVersion(manifest.cli);
  if (!installed) {
    // Recorded fixtures EXIST but cannot be validated here — drift-grade:
    // a release machine (--strict) must have the vendor CLI to prove the
    // recordings still match; a dev machine just sees the warning.
    driftWarnings.push(`${manifest.cli}: CLI not installed/answering here; recorded fixtures cannot be freshness-checked on this machine`);
    continue;
  }
  for (const [file, entry] of recorded) {
    if (semver(entry.cli_version) !== installed) {
      driftWarnings.push(`${manifest.cli}: ${file} recorded against ${entry.cli_version}, installed CLI is ${installed} — re-record to keep stream-shape proof current`);
    }
  }
}

for (const w of disclosures) console.warn(`fixture-freshness NOTE: ${w}`);
for (const w of driftWarnings) console.warn(`fixture-freshness DRIFT: ${w}`);
if (failures.length > 0) {
  console.error("fixture-freshness check FAILED:\n");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
if (strict && driftWarnings.length > 0) {
  console.error(`fixture-freshness: ${driftWarnings.length} drift warning(s) escalated by --strict — re-record against the installed CLIs`);
  process.exit(1);
}
console.log(`fixture-freshness check passed (${harnessDirs.length} harness fixture sets, ${driftWarnings.length} drift, ${disclosures.length} notes)`);
