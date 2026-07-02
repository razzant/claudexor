#!/usr/bin/env node
/**
 * Complexity ratchet — readability only goes up (owner decision D20, v0.15).
 *
 * Records a committed baseline of per-file line counts for TS + Swift sources
 * and fails CI when any tracked file GROWS beyond its baseline (plus a small
 * slack), or when a new file exceeds the hard cap for new code. Shrinking a
 * file below its baseline (or deleting it) auto-tightens the baseline: run
 * with --update after a refactor to commit the lower bar. The bar can never be
 * raised by --update; raising requires editing the baseline by hand in a
 * reviewed commit that explains why.
 *
 * This is deliberately a LINE ratchet, not a cyclomatic metric: the failure
 * mode it exists to stop is the observed one — god-files (orchestrator.ts
 * 6.7k lines) absorbing every fix because appending is cheapest. Line counts
 * are language-agnostic, diff-stable, and impossible to game without actually
 * splitting the file.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "scripts", "complexity-baseline.json");

/** Files above this size are ratcheted individually; smaller files are governed by NEW_FILE_CAP only. */
const TRACK_THRESHOLD = 600;
/** A brand-new source file may not exceed this. Split it before it is born big. */
const NEW_FILE_CAP = 1000;
/** Growth slack per tracked file, so a one-line bugfix in a legacy giant never blocks. */
const SLACK = 40;

const update = process.argv.includes("--update");

const tracked = execFileSync("git", ["ls-files", "packages", "apps", "benchmarks"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(
    (f) =>
      (f.endsWith(".ts") || f.endsWith(".swift")) &&
      !f.endsWith(".test.ts") &&
      !f.includes("/generated/") &&
      !f.includes("/fixtures/") &&
      !f.includes("/Tests/"),
  );

const counts = new Map();
for (const f of tracked) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  counts.set(f, readFileSync(p, "utf8").split("\n").length);
}

if (!existsSync(baselinePath)) {
  const baseline = {};
  for (const [f, n] of [...counts].sort()) if (n >= TRACK_THRESHOLD) baseline[f] = n;
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`complexity-ratchet: baseline seeded with ${Object.keys(baseline).length} files >= ${TRACK_THRESHOLD} lines`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const failures = [];
const improvements = [];

for (const [f, cap] of Object.entries(baseline)) {
  const now = counts.get(f);
  if (now === undefined) {
    improvements.push([f, null]); // deleted or renamed — drop from baseline on --update
    continue;
  }
  if (now > cap + SLACK) {
    failures.push(`${f}: ${now} lines (baseline ${cap} + slack ${SLACK}). Split or shrink it — the ratchet only goes down.`);
  } else if (now < cap) {
    improvements.push([f, now]);
  }
}

for (const [f, n] of counts) {
  if (f in baseline) continue;
  if (n > NEW_FILE_CAP) {
    failures.push(`${f}: ${n} lines is over the ${NEW_FILE_CAP}-line cap for files outside the legacy baseline. Split it.`);
  }
}

if (update && improvements.length > 0) {
  for (const [f, n] of improvements) {
    if (n === null) delete baseline[f];
    else baseline[f] = n;
  }
  const sorted = Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`complexity-ratchet: baseline tightened for ${improvements.length} file(s)`);
}

if (failures.length > 0) {
  console.error("complexity-ratchet FAILED:\n");
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "\nThe readability ratchet only moves down (owner-locked). Split the file or move logic to a\n" +
      "smaller owner. If a baseline raise is genuinely justified, edit scripts/complexity-baseline.json\n" +
      "in a reviewed commit that explains why.",
  );
  process.exit(1);
}

const better = improvements.filter(([, n]) => n !== null).length;
console.log(
  `complexity-ratchet: OK (${Object.keys(baseline).length} tracked, ${better} below baseline${update ? "" : better > 0 ? " — run with --update to tighten" : ""})`,
);
