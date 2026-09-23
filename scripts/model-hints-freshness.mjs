#!/usr/bin/env node
/**
 * Model-hints freshness gate (INV-104 freshness note).
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
import { compareRecordedEfforts } from "./lib/model-hints-effort-drift.mjs";

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
    console.log(
      `model-hints: ${adapter.id} — vendor CLI not discoverable here; hints verified against ${verified} (unchecked)`,
    );
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

/**
 * Effort-ladder freshness (same discipline, second hint set).
 *
 * The adapters read their ladders from a LIVE vendor probe and fall back to a
 * recorded snapshot when it cannot answer. Both failure modes are freshness
 * smells worth surfacing and neither is a build breaker:
 *   - the probe answered but disagrees with the committed snapshot → the vendor
 *     moved and the snapshot should be re-recorded. Only meaningful where the
 *     snapshot is version-pinned AND that version is installed (`snapshotVersion`
 *     below), since a per-version ladder disagrees with any other version by
 *     design and "re-record it" would be advice no snapshot can satisfy;
 *   - the probe could not answer → the manifest is running on the snapshot.
 * The recorded snapshots are imported here (like the registry above) because
 * only the adapter that owns a vendor knows what its snapshot is.
 */
const EFFORT_SNAPSHOTS = {
  codex: {
    module: "packages/harness-codex/dist/effort-snapshot.js",
    accountScoped: true,
    read: (m) =>
      Object.fromEntries(
        Object.entries(m.CODEX_EFFORT_SNAPSHOT.models).map(([id, v]) => [
          id,
          `${v.levels.join(",")}|${v.default ?? ""}`,
        ]),
      ),
    live: (caps) =>
      Object.fromEntries(
        Object.entries(caps.model_effort_levels ?? {}).map(([id, v]) => [
          id,
          `${v.levels.join(",")}|${v.default ?? ""}`,
        ]),
      ),
  },
  claude: {
    module: "packages/harness-claude/dist/effort-probe.js",
    read: (m) => ({ "*": m.CLAUDE_EFFORT_SNAPSHOT.join(",") }),
    live: (caps) => ({ "*": (caps.effort_levels ?? []).join(",") }),
    // The claude ladder is a property of the INSTALLED binary (2.1.89 stops at
    // `max`, 2.1.165 adds `xhigh`) while the snapshot is pinned to ONE version, so
    // a live ladder from any OTHER version legitimately disagrees with it. Drift
    // is therefore only a real signal on the pinned version; comparing elsewhere
    // demanded a re-record that cannot exist, since no single snapshot can be
    // fresh for both versions and both are legitimate installs.
    snapshotVersion: (m) => m.CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST,
  },
};

for (const [id, spec] of Object.entries(EFFORT_SNAPSHOTS)) {
  const adapter = buildRegistry({ includeFakes: false }).get(id);
  if (!adapter) continue;
  let manifest;
  try {
    manifest = await adapter.discover();
  } catch {
    continue; // vendor CLI absent here — nothing to compare
  }
  let mod;
  try {
    mod = await import(pathToFileURL(join(root, spec.module)).href);
  } catch {
    continue;
  }
  const snapshot = spec.read(mod);
  const caps = manifest.capabilities ?? {};
  const stamped = caps.effort_levels_verified_against ?? null;
  const installed = semver(manifest.version);
  if (installed !== null && semver(stamped) !== installed) {
    warnings.push(
      `${id}: effort ladders came from the recorded snapshot (verified against ${stamped}), not a live probe on CLI ${installed} — the vendor probe did not answer`,
    );
    continue;
  }
  // A snapshot pinned to one vendor version can only be drift-compared ON that
  // version (see `snapshotVersion`); elsewhere the live ladder is the truth and
  // there is nothing actionable to say.
  const pinned = spec.snapshotVersion ? semver(spec.snapshotVersion(mod)) : null;
  if (pinned !== null && installed !== null && installed !== pinned) {
    console.log(
      `model-hints: ${id} — effort ladders read live from CLI ${installed}; the recorded snapshot is pinned to ${pinned} (a fallback for that version, not a target for every version), so no drift compare`,
    );
    continue;
  }
  const live = spec.live(caps);
  const comparison = compareRecordedEfforts(snapshot, live, {
    accountScoped: spec.accountScoped === true,
  });
  const drifted = comparison.drifted;
  if (spec.accountScoped === true && comparison.recordedOnly.length > 0) {
    console.log(
      `model-hints: ${id} — recorded fallback also covers account-scoped models absent from this route: ${comparison.recordedOnly.join(", ")}`,
    );
  }
  if (drifted.length > 0) {
    warnings.push(
      `${id}: live effort ladders disagree with the recorded snapshot for ${drifted.join(", ")} — re-record the snapshot from the current CLI`,
    );
  } else {
    console.log(`model-hints: ${id} — effort ladders fresh (CLI ${installed ?? "unknown"})`);
  }
}

for (const w of warnings) console.warn(`model-hints WARNING: ${w}`);
for (const f of failures) console.error(`model-hints FAILURE: ${f}`);
if (failures.length > 0 || (strict && warnings.length > 0)) process.exit(1);
console.log(
  "model-hints freshness gate passed" +
    (warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""),
);
