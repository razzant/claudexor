#!/usr/bin/env node
/**
 * M7 engine-runtime UPDATE unit builder (D22).
 *
 * The update unit shipped by the macOS app's auto-updater is the RUNTIME
 * CLOSURE — everything apps/macos/scripts/build-app.sh stages into the signed
 * app's Contents/Resources EXCEPT Node (Node stays app-owned; a Node bump ships
 * a new DMG). We build the tarball straight from the already-signed, already-
 * verified app bundle so the update closure is byte-identical to the closure
 * the release gates smoke-tested — never a re-staged, unverified copy.
 *
 *   node scripts/build-runtime-closure.mjs \
 *     --app-bundle apps/macos/dist/Claudexor.app \
 *     --version 3.0.0 \
 *     --out "$RUNNER_TEMP/runtime-closure"
 *
 * Emits into --out:
 *   claudexor-runtime-<version>.tar.gz   the closure
 *   runtime-manifest.json                {version, sha256, minAppVersion,
 *                                         signature: null (reserved), notes}
 *
 * The manifest's sha256 is the digest of the emitted tarball; this script
 * re-reads the tarball it just wrote and self-verifies the digest before
 * writing the manifest, so a torn write can never ship a lying manifest.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/**
 * The closure entries, relative to Contents/Resources. This is the exact set
 * build-app.sh stages for the engine runtime, minus `node`. The SwiftPM UI
 * resource bundle and AppIcon.icns are app-owned (they ship in the DMG), so
 * they are deliberately NOT part of the update closure.
 */
const CLOSURE_ENTRIES = [
  "claudexord.bundle.cjs",
  "setup-login-runner.cjs",
  "browser-mcp-runtime",
  "native",
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error(`invalid argument: ${key ?? ""}`);
    out[key.slice(2)] = value;
  }
  return out;
}

function fail(message) {
  console.error(`build-runtime-closure failed: ${message}`);
  process.exit(1);
}

function readGeneratedVersion() {
  const text = readFileSync(join(ROOT, "packages/util/src/version.ts"), "utf8");
  const match = /CLAUDEXOR_VERSION = "([^"]+)"/.exec(text);
  if (!match) throw new Error("could not read CLAUDEXOR_VERSION from packages/util/src/version.ts");
  return match[1];
}

function readMinAppVersion(releaseVersion) {
  const file = join(ROOT, "release/runtime-min-app-version.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const min = parsed.minAppVersion;
  if (typeof min !== "string" || !isSemver(min)) {
    throw new Error(
      `release/runtime-min-app-version.json: minAppVersion '${min}' is not a valid semver`,
    );
  }
  if (compareSemver(min, releaseVersion) > 0) {
    throw new Error(
      `release/runtime-min-app-version.json: minAppVersion ${min} is newer than the release version ${releaseVersion}`,
    );
  }
  return min;
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Short release note for the manifest: the CHANGELOG's first line for this
 * version, so `claudexor release check` and the app chip can show WHAT changed
 * without shipping the whole entry. Falls back to a neutral line. */
function readNotes(version) {
  try {
    const log = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const escaped = version.replace(/\./g, "\\.");
    const re = new RegExp(String.raw`^- \*\*v${escaped}\*\*[^\n]*\n?([^\n]*)`, "m");
    const match = re.exec(log);
    const firstLine = (match?.[1] ?? "").trim();
    if (firstLine) return firstLine.replace(/\s+/g, " ").slice(0, 400);
  } catch {
    /* fall through to the neutral note */
  }
  return `Claudexor engine runtime ${version}.`;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
  const appBundle = options["app-bundle"];
  const version = options.version;
  const outDir = options.out;
  if (!appBundle || !version || !outDir) {
    fail("usage: build-runtime-closure.mjs --app-bundle DIR --version X.Y.Z --out DIR");
  }
  if (!isSemver(version)) fail(`--version '${version}' is not a valid semver`);

  const generated = readGeneratedVersion();
  if (version !== generated) {
    fail(`--version ${version} does not match the generated CLAUDEXOR_VERSION ${generated}`);
  }

  const resources = resolve(appBundle, "Contents/Resources");
  if (!existsSync(resources) || !statSync(resources).isDirectory()) {
    fail(`app bundle has no Contents/Resources: ${resources}`);
  }
  for (const entry of CLOSURE_ENTRIES) {
    const path = join(resources, entry);
    if (!existsSync(path))
      fail(`closure entry missing from the app bundle: Contents/Resources/${entry}`);
  }
  // Node MUST stay app-owned: refuse to ship it inside the update closure even
  // if a future build-app.sh change accidentally routed it here.
  if (CLOSURE_ENTRIES.includes("node"))
    fail("node must never be part of the runtime update closure");

  const minAppVersion = readMinAppVersion(version);
  const notes = readNotes(version);

  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const tarballName = `claudexor-runtime-${version}.tar.gz`;
  const tarballPath = join(out, tarballName);
  rmSync(tarballPath, { force: true });

  // Tar the closure entries at the ROOT of the archive (no leading ./ dir), so
  // unpacking into versions/<v>/ yields versions/<v>/claudexord.bundle.cjs etc.
  // — exactly the layout DaemonLauncher and browser-mcp adjacency expect.
  execFileSync("tar", ["-czf", tarballPath, "-C", resources, ...CLOSURE_ENTRIES], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (!existsSync(tarballPath) || statSync(tarballPath).size === 0) {
    fail(`tar produced no runtime closure at ${tarballPath}`);
  }

  // Self-verify: the manifest digest MUST be the digest of the file we ship.
  const sha256 = sha256File(tarballPath);

  const manifest = {
    version,
    sha256,
    minAppVersion,
    signature: null,
    notes,
  };
  const manifestPath = join(out, "runtime-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `Runtime closure built: ${tarballName} (${statSync(tarballPath).size} bytes, sha256 ${sha256})\n` +
      `  minAppVersion=${minAppVersion}\n  manifest=${manifestPath}\n`,
  );
}

main();
