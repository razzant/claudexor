// Stage the pinned publication scanner (Betterleaks) into a distribution's
// `native/` resource tree (INV-146). Shared by the explicit provisioner, the
// engine-resource build (macOS app and update closure) and the per-target SSH
// runtime build, so every bundled copy is checked against the one pin in
// packages/delivery/src/publication-scanner-pin.ts (read with Node's type stripping).
//
// Layout: <native>/betterleaks/<platform-arch>/{betterleaks[.exe],LICENSE,provenance.json}
// `provenance.json` records the upstream archive and binary digests and the
// digest of the bundled bytes (equal to the upstream binary unless a release
// signs it in place; then `refreshProvenance` records the signed digest).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BETTERLEAKS_RELEASE_URL,
  BETTERLEAKS_RELEASES,
  BETTERLEAKS_VERSION,
  bundledScannerLayout,
} from "../../packages/delivery/src/publication-scanner-pin.ts";

export const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function pinnedRelease(key) {
  const release = BETTERLEAKS_RELEASES[key];
  if (!release) throw new Error(`no pinned Betterleaks ${BETTERLEAKS_VERSION} build for ${key}`);
  return release;
}

/** Download one pinned archive (explicit build/setup step only). */
export async function downloadArchive(key, dir) {
  const release = pinnedRelease(key);
  const response = await fetch(`${BETTERLEAKS_RELEASE_URL}/${release.asset}`);
  if (!response.ok) throw new Error(`download of ${release.asset} failed: HTTP ${response.status}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, release.asset);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  return path;
}

/** Extract and verify one archive; returns paths in a scratch directory the
 * caller must remove. Nothing is trusted before both digests match the pin
 * (`release` defaults to the pin; tests pass a synthetic one). */
export function extractVerified(key, archive, release = pinnedRelease(key)) {
  const archiveDigest = sha256File(archive);
  if (archiveDigest !== release.archiveSha256)
    throw new Error(
      `${key} archive digest ${archiveDigest} is not the pinned ${release.archiveSha256}`,
    );
  const work = mkdtempSync(join(tmpdir(), "claudexor-betterleaks-stage-"));
  try {
    // bsdtar (macOS, Windows) reads both formats; GNU tar only meets .tar.gz.
    execFileSync("tar", ["-xf", archive, "-C", work, release.binary, "LICENSE"], {
      stdio: "ignore",
    });
    const binary = join(work, release.binary);
    const binaryDigest = sha256File(binary);
    if (binaryDigest !== release.binarySha256)
      throw new Error(
        `${key} binary digest ${binaryDigest} is not the pinned ${release.binarySha256}`,
      );
    if (!readFileSync(join(work, "LICENSE"), "utf8").includes("MIT License"))
      throw new Error(`${key} archive LICENSE is not the expected MIT license`);
    return { work, binary, license: join(work, "LICENSE"), release, archiveDigest };
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
}

/** Stage one platform into `<nativeDir>/betterleaks/<key>/`. */
export function stagePlatform(key, archive, nativeDir, release = pinnedRelease(key)) {
  const extracted = extractVerified(key, archive, release);
  try {
    const layout = bundledScannerLayout(nativeDir, key);
    rmSync(layout.dir, { recursive: true, force: true });
    mkdirSync(layout.dir, { recursive: true, mode: 0o755 });
    const staged = `${layout.binary}.partial`;
    copyFileSync(extracted.binary, staged);
    chmodSync(staged, 0o755);
    renameSync(staged, layout.binary);
    copyFileSync(extracted.license, layout.license);
    writeFileSync(
      layout.provenance,
      `${JSON.stringify(
        {
          name: "betterleaks",
          version: BETTERLEAKS_VERSION,
          platform: key,
          license: "MIT",
          source: `${BETTERLEAKS_RELEASE_URL}/${extracted.release.asset}`,
          archiveSha256: extracted.archiveDigest,
          upstreamBinarySha256: extracted.release.binarySha256,
          bundledSha256: extracted.release.binarySha256,
        },
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    );
    return layout;
  } finally {
    rmSync(extracted.work, { recursive: true, force: true });
  }
}

/** After a release signs the bundled binaries in place, record their digests. */
export function refreshProvenance(nativeDir, pinned = pinnedRelease) {
  const root = join(nativeDir, "betterleaks");
  const refreshed = [];
  for (const key of existsSync(root) ? readdirSync(root) : []) {
    const layout = bundledScannerLayout(nativeDir, key);
    const provenance = JSON.parse(readFileSync(layout.provenance, "utf8"));
    if (provenance.upstreamBinarySha256 !== pinned(key).binarySha256)
      throw new Error(`${key} provenance does not name the pinned upstream binary`);
    provenance.bundledSha256 = sha256File(layout.binary);
    writeFileSync(layout.provenance, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o644 });
    refreshed.push(key);
  }
  return refreshed;
}

/** Every staged platform key under `<nativeDir>/betterleaks`. */
export function stagedPlatforms(nativeDir) {
  const root = join(nativeDir, "betterleaks");
  return existsSync(root) ? readdirSync(root).sort() : [];
}
