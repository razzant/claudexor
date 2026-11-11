// Stage the pinned publication scanner (Betterleaks) into a distribution's
// `native/` resource tree (INV-146), or place one binary at a caller-chosen path.
// Shared by the explicit provisioner, the engine-resource build (macOS app and
// update closure) and the per-target SSH runtime build, so every copy is proved
// against the one pin in packages/delivery/src/publication-scanner-pin.ts by the
// shipped proof in publication-scanner-provision.ts (both read with Node's type
// stripping).
//
// Layout: <native>/betterleaks/<platform-arch>/{betterleaks[.exe],LICENSE,provenance.json}
// `provenance.json` records the upstream archive and binary digests and the
// digest of the bundled bytes (equal to the upstream binary unless a release
// signs it in place; then `refreshProvenance` records the signed digest).
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
import { basename, dirname, join } from "node:path";
import {
  BETTERLEAKS_RELEASES,
  BETTERLEAKS_VERSION,
  bundledScannerLayout,
  scannerArchiveUrl,
} from "../../packages/delivery/src/publication-scanner-pin.ts";
import {
  ScannerProvisionError,
  acquireScannerArchive,
  extractVerifiedScanner,
  sha256File,
} from "../../packages/delivery/src/publication-scanner-provision.ts";

export { sha256File };

export function pinnedRelease(key) {
  const release = BETTERLEAKS_RELEASES[key];
  if (!release) throw new Error(`no pinned Betterleaks ${BETTERLEAKS_VERSION} build for ${key}`);
  return release;
}

/** Download one pinned archive (explicit build/setup step only); the file
 * appears at its name only once its digest matches the pin. */
export async function downloadArchive(key, dir) {
  const release = pinnedRelease(key);
  mkdirSync(dir, { recursive: true });
  const partial = mkdtempSync(join(dir, `.${release.asset}.`));
  try {
    const staged = join(partial, release.asset);
    await acquireScannerArchive({
      key,
      release,
      source: { kind: "download", url: scannerArchiveUrl(release) },
      to: staged,
    });
    const path = join(dir, release.asset);
    renameSync(staged, path);
    return path;
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

/** Extract and verify one archive; returns paths in a scratch directory the
 * caller must remove. Nothing is trusted before both digests match the pin
 * (`release` defaults to the pin; tests pass a synthetic one). */
export async function extractVerified(key, archive, release = pinnedRelease(key)) {
  const work = mkdtempSync(join(tmpdir(), "claudexor-betterleaks-stage-"));
  try {
    const verified = await extractVerifiedScanner({
      key,
      release,
      source: { kind: "file", path: archive },
      work,
    });
    return {
      work,
      binary: verified.binary,
      license: verified.license,
      release,
      archiveDigest: verified.archiveSha256,
    };
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
}

/**
 * One binary at a path the caller chose (CI, a developer's
 * CLAUDEXOR_BETTERLEAKS_PATH) and the `LICENSE` beside it. Whatever is there is
 * replaced, but only after the archive, binary and license proof passed: a
 * refusal, or an interruption before the replacement, leaves the old files.
 * Each name is renamed into place from a unique sibling staging directory, the
 * license first; the pair is not one atomic step, and a concurrent writer of the
 * same path is not fenced. `source` is the proof's archive source; `release` and
 * `tarCommand` are test seams.
 */
export async function provisionAtPath(key, source, dest, options = {}) {
  const { release = pinnedRelease(key), signal, tarCommand } = options;
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true });
  const work = mkdtempSync(join(dir, `.${basename(dest)}.staging-`));
  try {
    const verified = await extractVerifiedScanner({
      key,
      release,
      source,
      work,
      ...(signal ? { signal } : {}),
      ...(tarCommand ? { tarCommand } : {}),
    });
    if (signal?.aborted)
      throw new ScannerProvisionError(
        "scanner_prepare_cancelled",
        `cancelled before ${dest} was replaced; the old files are unchanged`,
      );
    const license = join(dir, "LICENSE");
    renameSync(verified.license, license);
    renameSync(verified.binary, dest);
    return { binary: dest, license, archiveSha256: verified.archiveSha256 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Stage one platform into `<nativeDir>/betterleaks/<key>/`. */
export async function stagePlatform(key, archive, nativeDir, release = pinnedRelease(key)) {
  const extracted = await extractVerified(key, archive, release);
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
          source: scannerArchiveUrl(extracted.release),
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
