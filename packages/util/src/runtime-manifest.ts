/**
 * The engine-runtime-update SIGNED manifest contract for the TS runtime (D-2).
 *
 * This is the ONE in-package definition consumed by `claudexor release check`
 * (packages/cli/src/release.ts). It replaces that file's ad-hoc
 * `parseRuntimeManifest` and is byte-for-byte compatible with the release-tooling
 * mirror `scripts/lib/runtime-manifest-contract.mjs` (a binding test asserts the
 * two produce identical canonical signing bytes and cross-verify) and with the
 * Swift updater (locked by the cross-language fixtures). See that mjs file for the
 * full wire-shape documentation.
 *
 * `claudexor release check` verifies FAIL-CLOSED against the PINNED authority
 * below: an unsigned, unknown-key, tampered, or malformed manifest is refused,
 * never trusted as an available update.
 */
import { createPublicKey, verify } from "node:crypto";

export const RUNTIME_MANIFEST_SCHEMA_VERSION = 1 as const;
export const RUNTIME_MANIFEST_ALGORITHM = "Ed25519" as const;
export const RUNTIME_MANIFEST_ASSET_NAME = "runtime-manifest.json" as const;

/**
 * The PINNED runtime-update authority (public half). This constant is bound to
 * release/runtime-update-authority.json by a unit test (they can never drift).
 * It is embedded here because the npm CLI ships per-package dist WITHOUT the
 * repo's release/ dir, so the CLI must carry its own copy of the pinned key —
 * exactly as the macOS app compiles in its own copy.
 */
export interface RuntimeUpdateAuthority {
  keyId: string;
  algorithm: "Ed25519";
  publicKeyPem: string;
}

export const RUNTIME_UPDATE_AUTHORITY: RuntimeUpdateAuthority = {
  keyId: "claudexor-runtime-update-v3.1.0-ed25519-ce7f15e6187e137d",
  algorithm: "Ed25519",
  publicKeyPem:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA0AKwkzFo7g4oHTXn2hCyhNIWNV8wBqK4aGX8+Y6mfN0=\n-----END PUBLIC KEY-----\n",
};

export interface SignedRuntimeManifest {
  schemaVersion: 1;
  version: string;
  sha256: string;
  minAppVersion: string;
  archiveName: string;
  buildSha: string;
  notes: string;
  keyId: string;
  algorithm: "Ed25519";
  signature: string;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA_HEX = /^[0-9a-f]{40}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isRuntimeSemver(value: unknown): value is string {
  return typeof value === "string" && SEMVER.test(value);
}

export function runtimeArchiveName(version: string): string {
  return `claudexor-runtime-${version}.tar.gz`;
}

/** Deterministic sorted-key JSON — identical output to the mjs canonicalJson. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** The exact field subset the signature covers: everything but `signature`. */
export function runtimeManifestSignedFields(
  manifest: SignedRuntimeManifest,
): Record<string, unknown> {
  return {
    schemaVersion: manifest.schemaVersion,
    version: manifest.version,
    sha256: manifest.sha256,
    minAppVersion: manifest.minAppVersion,
    archiveName: manifest.archiveName,
    buildSha: manifest.buildSha,
    notes: manifest.notes,
    keyId: manifest.keyId,
    algorithm: manifest.algorithm,
  };
}

export function runtimeManifestSigningBytes(manifest: SignedRuntimeManifest): Buffer {
  return Buffer.from(canonicalJson(runtimeManifestSignedFields(manifest)), "utf8");
}

export interface RuntimeManifestCheck {
  ok: boolean;
  reasons: string[];
}

/**
 * Full fail-closed verification: shape + pinned authority + Ed25519 signature.
 * A malformed value never throws — it returns `{ ok: false }` with reasons.
 */
export function verifyRuntimeManifest(
  value: unknown,
  authority: RuntimeUpdateAuthority = RUNTIME_UPDATE_AUTHORITY,
  opts: { expectVersion?: string } = {},
): RuntimeManifestCheck {
  const reasons: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reasons: ["manifest is not an object"] };
  }
  const m = value as Record<string, unknown>;
  if (m.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION) {
    reasons.push(`schemaVersion must be ${RUNTIME_MANIFEST_SCHEMA_VERSION}`);
  }
  if (!isRuntimeSemver(m.version)) reasons.push("version must be an x.y.z semver");
  if (typeof m.sha256 !== "string" || !SHA256_HEX.test(m.sha256)) {
    reasons.push("sha256 must be 64 lowercase hex chars");
  }
  if (!isRuntimeSemver(m.minAppVersion)) reasons.push("minAppVersion must be an x.y.z semver");
  if (typeof m.buildSha !== "string" || !GIT_SHA_HEX.test(m.buildSha)) {
    reasons.push("buildSha must be a 40-char lowercase hex git sha");
  }
  if (typeof m.notes !== "string") reasons.push("notes must be a string");
  if (m.algorithm !== RUNTIME_MANIFEST_ALGORITHM) {
    reasons.push(`algorithm must be ${RUNTIME_MANIFEST_ALGORITHM}`);
  }
  if (isRuntimeSemver(m.version) && m.archiveName !== runtimeArchiveName(m.version)) {
    reasons.push(`archiveName must be ${runtimeArchiveName(m.version as string)}`);
  }
  if (opts.expectVersion !== undefined && m.version !== opts.expectVersion) {
    reasons.push(`version ${String(m.version)} does not match the expected ${opts.expectVersion}`);
  }
  if (authority.algorithm !== RUNTIME_MANIFEST_ALGORITHM) {
    reasons.push("authority algorithm must be Ed25519");
  }
  if (m.keyId !== authority.keyId) {
    reasons.push("manifest keyId is not the pinned runtime-update authority");
  }
  if (typeof m.signature !== "string" || !BASE64.test(m.signature)) {
    reasons.push("signature is missing or not base64");
  }
  if (reasons.length > 0) return { ok: false, reasons };
  try {
    const key = createPublicKey(authority.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") {
      return { ok: false, reasons: ["authority public key is not Ed25519"] };
    }
    const signature = Buffer.from(m.signature as string, "base64");
    if (
      signature.length !== 64 ||
      !verify(
        null,
        runtimeManifestSigningBytes(m as unknown as SignedRuntimeManifest),
        key,
        signature,
      )
    ) {
      return { ok: false, reasons: ["signature is invalid for the pinned key"] };
    }
  } catch {
    return { ok: false, reasons: ["signature verification failed"] };
  }
  return { ok: true, reasons: [] };
}

export function compareRuntimeSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Monotonic anti-replay: the target version must be strictly greater than every
 * version the app already trusts. Because `version` is signed, an old valid
 * manifest cannot be replayed to force a downgrade.
 */
export function isMonotonicRuntimeUpgrade(
  targetVersion: string,
  floorVersions: readonly string[],
): boolean {
  if (!isRuntimeSemver(targetVersion)) return false;
  return floorVersions
    .filter((v) => isRuntimeSemver(v))
    .every((v) => compareRuntimeSemver(targetVersion, v) > 0);
}
