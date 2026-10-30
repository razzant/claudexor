/**
 * The pinned publication scanner binary: the Betterleaks release pin (archive
 * and binary digests per platform), where a distribution bundles it, where the
 * provisioner places it, and how the one executable is located and checked
 * (INV-146). `publication-scan.ts` runs it.
 *
 * Self-contained on purpose (Node built-ins, erasable TypeScript only): CI,
 * release staging and the provisioner read this source with Node's type
 * stripping before dependencies are installed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BETTERLEAKS_VERSION = "1.9.0";

export interface ScannerRelease {
  asset: string;
  archiveSha256: string;
  binarySha256: string;
  binary: string;
}

/** Official v1.9.0 assets (github.com/betterleaks/betterleaks, MIT): archive
 * digests from the release API, binary digests from the extracted archives. */
export const BETTERLEAKS_RELEASES: Readonly<Record<string, ScannerRelease>> = {
  "darwin-arm64": {
    asset: "betterleaks_1.9.0_darwin_arm64.tar.gz",
    archiveSha256: "83dd7eaab13d44a1e8e347a17064cdef153a1478db473276d41b38d55613d3f2",
    binarySha256: "70d2103c2915aababa0e1eea121bd3db0ff0da86bee40ddc6f5982181acaf6d0",
    binary: "betterleaks",
  },
  "darwin-x64": {
    asset: "betterleaks_1.9.0_darwin_x64.tar.gz",
    archiveSha256: "68dfd83458d9e7f90663daa7a81c7f944083b170dae82e4f5f8d0581ed519ef1",
    binarySha256: "1581b1ad0d7d640459c728344c9d431339c8855cd2b5ccd35a9a56a7260b071a",
    binary: "betterleaks",
  },
  "linux-arm64": {
    asset: "betterleaks_1.9.0_linux_arm64.tar.gz",
    archiveSha256: "1d39116e0a58dc94574715e2aa12a2dbd5062f193eee3fec011fef6ba06bd13b",
    binarySha256: "488e0aa9f34e4144c70ba58ab83f1cda11fb4a5f84897b513e55b2afe71b7e8a",
    binary: "betterleaks",
  },
  "linux-x64": {
    asset: "betterleaks_1.9.0_linux_x64.tar.gz",
    archiveSha256: "f8b185a39ffcece2a1ca82bf3a4e7435cd81963ffd16b7a9128daf75f35f6de7",
    binarySha256: "0ace40b41652344608f89967fe93c6caf4faae9a4df20423632c7efb02a4d4e1",
    binary: "betterleaks",
  },
  "win32-arm64": {
    asset: "betterleaks_1.9.0_windows_arm64.zip",
    archiveSha256: "3e5b9b6cdbfe8d486ae2dd2fa137473dc9ab42bf50317f051b73561121861816",
    binarySha256: "e0f6c8cac0dabf271b499abdfe43c3b5794db1f36d80f7af2a963d69fac97f89",
    binary: "betterleaks.exe",
  },
  "win32-x64": {
    asset: "betterleaks_1.9.0_windows_x64.zip",
    archiveSha256: "b765daec9fda475b031b5a5159798cbe4294a3f2a50683cbc0471226e376d3da",
    binarySha256: "41a3dc5e75712d52d25aa7203b0b6bc2fa9c796fe5109d3835c60226a9a69352",
    binary: "betterleaks.exe",
  },
};

export const BETTERLEAKS_RELEASE_URL = `https://github.com/betterleaks/betterleaks/releases/download/v${BETTERLEAKS_VERSION}`;

/** Explicit path to a provisioned scanner; it must still match the pin. */
export const SCANNER_PATH_ENV = "CLAUDEXOR_BETTERLEAKS_PATH";

export function scannerReleaseKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

export function scannerRelease(
  platform: string = process.platform,
  arch: string = process.arch,
): ScannerRelease | null {
  return BETTERLEAKS_RELEASES[scannerReleaseKey(platform, arch)] ?? null;
}

function releaseKey(release: ScannerRelease): string {
  return Object.keys(BETTERLEAKS_RELEASES).find((k) => BETTERLEAKS_RELEASES[k] === release) ?? "";
}

/** Where `claudexor`'s provisioner places the pinned binary under a config root. */
export function provisionedScannerPath(
  configDir: string,
  release: ScannerRelease | null = scannerRelease(),
): string | null {
  if (!release) return null;
  return join(
    configDir,
    "tools",
    "betterleaks",
    BETTERLEAKS_VERSION,
    releaseKey(release),
    release.binary,
  );
}

/** A distribution's bundled copy for one platform, under its `native/` tree:
 * the macOS app and its update closure carry darwin-arm64 and darwin-x64; each
 * SSH runtime carries only its own target. */
export function bundledScannerLayout(nativeDir: string, key: string) {
  const dir = join(nativeDir, "betterleaks", key);
  const binary = join(dir, BETTERLEAKS_RELEASES[key]?.binary ?? "betterleaks");
  return {
    dir,
    binary,
    license: join(dir, "LICENSE"),
    provenance: join(dir, "provenance.json"),
  };
}

/** The `native/` directory beside the running engine bundle (the app, update
 * closure and SSH runtime layouts); null when this module is not bundled. */
export function defaultBundledNativeDir(): string | null {
  try {
    return fileURLToPath(new URL("./native/", import.meta.url));
  } catch {
    return null;
  }
}

export type ScannerLocation = { ok: true; path: string } | { ok: false; reason: string };

const digestOf = (path: string): string | null => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
};

/** A bundled binary is the pinned build, or the release's signed copy of it
 * recorded in its provenance (its integrity is the enclosing signed app,
 * update closure or runtime archive, as for every other bundled resource). */
function bundledMatches(release: ScannerRelease, layout: ReturnType<typeof bundledScannerLayout>) {
  const digest = digestOf(layout.binary);
  if (digest === null) return false;
  if (digest === release.binarySha256) return true;
  try {
    const provenance = JSON.parse(readFileSync(layout.provenance, "utf8")) as Record<
      string,
      unknown
    >;
    return (
      provenance["version"] === BETTERLEAKS_VERSION &&
      provenance["upstreamBinarySha256"] === release.binarySha256 &&
      provenance["bundledSha256"] === digest
    );
  } catch {
    return false;
  }
}

/** Find the pinned executable. No download ever happens here: a missing or
 * mismatched binary is `unavailable`, never a silent clean result. Order: an
 * explicit path (and only it, when set), the copy bundled with this
 * distribution, the copy provisioned under the config root. */
export function locateScanner(input: {
  env?: NodeJS.ProcessEnv;
  configDir?: string | null;
  release?: ScannerRelease | null;
  bundledNativeDir?: string | null;
}): ScannerLocation {
  const release = input.release === undefined ? scannerRelease() : input.release;
  if (!release)
    return {
      ok: false,
      reason: `no pinned Betterleaks ${BETTERLEAKS_VERSION} build for ${process.platform}-${process.arch}`,
    };
  const explicit = input.env?.[SCANNER_PATH_ENV]?.trim();
  if (explicit) {
    if (!existsSync(explicit))
      return { ok: false, reason: `${SCANNER_PATH_ENV} does not name an existing file` };
    return digestOf(explicit) === release.binarySha256
      ? { ok: true, path: explicit }
      : {
          ok: false,
          reason: `the scanner at ${explicit} is not the pinned Betterleaks ${BETTERLEAKS_VERSION} build`,
        };
  }
  const nativeDir =
    input.bundledNativeDir === undefined ? defaultBundledNativeDir() : input.bundledNativeDir;
  const bundled = nativeDir ? bundledScannerLayout(nativeDir, releaseKey(release)) : null;
  if (bundled && existsSync(bundled.binary)) {
    return bundledMatches(release, bundled)
      ? { ok: true, path: bundled.binary }
      : {
          ok: false,
          reason: `the bundled scanner at ${bundled.binary} is not the pinned Betterleaks ${BETTERLEAKS_VERSION} build`,
        };
  }
  const provisioned = input.configDir ? provisionedScannerPath(input.configDir, release) : null;
  if (!provisioned || !existsSync(provisioned))
    return {
      ok: false,
      reason: `Betterleaks ${BETTERLEAKS_VERSION} is not bundled or provisioned`,
    };
  return digestOf(provisioned) === release.binarySha256
    ? { ok: true, path: provisioned }
    : {
        ok: false,
        reason: `the scanner at ${provisioned} is not the pinned Betterleaks ${BETTERLEAKS_VERSION} build`,
      };
}
