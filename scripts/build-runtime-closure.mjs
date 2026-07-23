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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeArchiveName } from "./lib/runtime-manifest-contract.mjs";

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

/** Short release note for the manifest: the CHANGELOG's WHOLE logical entry for
 * this version, so `claudexor release check` and the app chip can show WHAT
 * changed. The changelog wraps one entry across many physical lines (QA-033b);
 * reading a single physical line truncated the note mid-sentence, so this
 * collects every continuation line up to the next `- **vX.Y.Z**` entry, joins
 * them, strips the leading "(date) — " prefix, and bounds the length. Falls
 * back to a neutral line. */
function readNotes(version) {
  try {
    const log = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const lines = log.split(/\r?\n/);
    const header = `- **v${version}**`;
    const start = lines.findIndex((line) => line.startsWith(header));
    if (start >= 0) {
      const collected = [lines[start].slice(header.length)];
      for (let i = start + 1; i < lines.length; i += 1) {
        if (/^- \*\*v\d/.test(lines[i])) break; // next changelog entry
        collected.push(lines[i]);
      }
      const entry = collected
        .join(" ")
        .replace(/^\s*\([^)]*\)\s*[—-]\s*/, "") // drop a leading "(date) — "
        .replace(/^\s*[—-]\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (entry) return entry.slice(0, 400);
    }
  } catch {
    /* fall through to the neutral note */
  }
  return `Claudexor engine runtime ${version}.`;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The deterministic build sha the daemon handshake discloses (QA-002). It is
 * the SAME value build-app.sh stamps into the esbuild bundle via
 * `--define:process.env.CLAUDEXOR_BUILD_SHA`, so the manifest's `buildSha` and
 * the running engine's `engine.sha` agree byte-for-byte. Source of truth:
 * CLAUDEXOR_BUILD_SHA (set by CI / build-app.sh), else `git rev-parse HEAD`.
 */
function resolveBuildSha() {
  const env = (process.env.CLAUDEXOR_BUILD_SHA ?? "").trim();
  if (/^[0-9a-f]{40}$/.test(env)) return env;
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch {
    /* fall through */
  }
  throw new Error(
    "could not resolve a 40-char build sha (set CLAUDEXOR_BUILD_SHA or run inside a git checkout)",
  );
}

/**
 * Native-addon guard (D-2 defense-in-depth): the runtime closure must be pure
 * JS + the standalone process-identity helper. A `.node` C++ addon would be
 * dlopen'd INTO the bundled Node, which ships `disable-library-validation`, so a
 * closure-carried addon would load unsigned native code — the signed sha256 is
 * the only integrity barrier and we do not want a second, weaker one. Refuse if
 * any `.node` file appears anywhere under the staged closure entries.
 */
function assertNoNativeAddons(resources, entries) {
  const offenders = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, name.name);
      const relPath = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) walk(abs, relPath);
      else if (name.name.endsWith(".node")) offenders.push(relPath);
    }
  };
  for (const entry of entries) {
    const abs = join(resources, entry);
    if (statSync(abs).isDirectory()) walk(abs, entry);
    else if (entry.endsWith(".node")) offenders.push(entry);
  }
  if (offenders.length > 0) {
    fail(
      `runtime closure contains native addon(s) forbidden by D-2: ${offenders.join(", ")} ` +
        "(the bundled Node's disable-library-validation would load them unsigned)",
    );
  }
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

  // Native-addon guard runs on the STAGED bundle, before we tar anything.
  assertNoNativeAddons(resources, CLOSURE_ENTRIES);

  const minAppVersion = readMinAppVersion(version);
  const notes = readNotes(version);
  const buildSha = resolveBuildSha();

  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const tarballName = runtimeArchiveName(version);
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

  // The stamped bundle inside the closure MUST carry this exact build sha, so
  // the manifest's buildSha and the running engine's handshake sha agree. A
  // "unknown"/unstamped bundle here means the esbuild define did not run —
  // refuse rather than ship a manifest that lies about the engine identity.
  const bundleText = readFileSync(join(resources, "claudexord.bundle.cjs"), "utf8");
  if (!bundleText.includes(buildSha)) {
    fail(
      `claudexord.bundle.cjs is not stamped with build sha ${buildSha}: run build-app.sh with the ` +
        "esbuild CLAUDEXOR_BUILD_SHA define (bundled + downloaded closures must be stamped identically)",
    );
  }

  // Self-verify: the manifest digest MUST be the digest of the file we ship.
  const sha256 = sha256File(tarballPath);

  // UNSIGNED manifest (D-2): the candidate workflow emits this; the owner signs
  // it OFFLINE (scripts/sign-runtime-manifest.mjs adds keyId/algorithm/
  // signature). The field set is the ONE canonical contract shape. `signature`
  // is intentionally absent until the offline signer seals it.
  const manifest = {
    schemaVersion: 1,
    version,
    sha256,
    minAppVersion,
    archiveName: tarballName,
    buildSha,
    notes,
  };
  const manifestPath = join(out, "runtime-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `Runtime closure built: ${tarballName} (${statSync(tarballPath).size} bytes, sha256 ${sha256})\n` +
      `  minAppVersion=${minAppVersion} buildSha=${buildSha}\n  manifest=${manifestPath} (UNSIGNED — owner signs offline)\n`,
  );
}

main();
