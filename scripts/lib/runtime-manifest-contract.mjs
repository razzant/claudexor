/**
 * ONE canonical definition of the SIGNED engine-runtime-update manifest (D-2).
 *
 * This module replaces the three ad-hoc manifest shapes the plan review found
 * scattered across build-runtime-closure.mjs, RuntimeUpdate.swift, and
 * release.ts. Every JS-side producer/consumer (the closure builder, the offline
 * signer, `claudexor release check`, release-workflow-check, and the node test
 * vectors) derives its field set, canonical signed bytes, and fail-closed
 * verification from HERE. The Swift updater is a faithful mirror locked to this
 * module by the cross-language test vectors under
 * apps/macos/.../Fixtures/runtime-update/.
 *
 * Wire shape of `runtime-manifest.json` (flat, so an old 3.0 check that only
 * reads {version,sha256,minAppVersion} still parses it; the signing fields are
 * additive and 3.1+ verifies them fail-closed):
 *
 *   {
 *     "schemaVersion": 1,
 *     "version":       "3.1.0",
 *     "sha256":        "<64 lowercase hex of claudexor-runtime-<version>.tar.gz>",
 *     "minAppVersion": "2.1.0",
 *     "archiveName":   "claudexor-runtime-3.1.0.tar.gz",
 *     "buildSha":      "<40 lowercase hex git sha of the build>",
 *     "notes":         "…",
 *     "keyId":         "claudexor-runtime-update-…",
 *     "algorithm":     "Ed25519",
 *     "signature":     "<base64 Ed25519 over the canonical signed bytes>"
 *   }
 *
 * The signature covers EVERY field except `signature` itself (notes included, so
 * display text cannot be tampered either). Anti-replay is the signed `version`
 * field plus the installer's strict monotonic check (never install version <=
 * the running/last-known-good version). The signed `archiveName` binds the
 * manifest to one exact archive filename; the signed `sha256` binds its bytes.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/** The only accepted manifest schema version. Bumping it is a wire break. */
export const RUNTIME_MANIFEST_SCHEMA_VERSION = 1;
/** The only accepted signature algorithm. */
export const RUNTIME_MANIFEST_ALGORITHM = "Ed25519";

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA_HEX = /^[0-9a-f]{40}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isSemver(value) {
  return typeof value === "string" && SEMVER.test(value);
}

/** The conventional archive filename bound into (and signed by) the manifest. */
export function runtimeArchiveName(version) {
  return `claudexor-runtime-${version}.tar.gz`;
}

/** Deterministic sorted-key JSON — the byte contract the Ed25519 key signs. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

/** The exact field subset the signature covers: everything but `signature`. */
export function runtimeManifestSignedFields(manifest) {
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

/** Canonical bytes the offline key signs / the verifier checks. */
export function runtimeManifestSigningBytes(manifest) {
  return Buffer.from(canonicalJson(runtimeManifestSignedFields(manifest)), "utf8");
}

/**
 * Shape-validate the signed portion of a manifest (everything but the
 * signature). Returns { ok, reasons }. Fail-closed: any malformed field is a
 * hard refusal, never a lenient coercion. `expectVersion` (optional) binds the
 * manifest to the release version being built/verified.
 */
export function validateRuntimeManifestShape(manifest, { expectVersion } = {}) {
  const reasons = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, reasons: ["manifest is not an object"] };
  }
  if (manifest.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION) {
    reasons.push(`schemaVersion must be ${RUNTIME_MANIFEST_SCHEMA_VERSION}`);
  }
  if (!isSemver(manifest.version)) reasons.push("version must be an x.y.z semver");
  if (typeof manifest.sha256 !== "string" || !SHA256_HEX.test(manifest.sha256)) {
    reasons.push("sha256 must be 64 lowercase hex chars");
  }
  if (!isSemver(manifest.minAppVersion)) reasons.push("minAppVersion must be an x.y.z semver");
  if (typeof manifest.buildSha !== "string" || !GIT_SHA_HEX.test(manifest.buildSha)) {
    reasons.push("buildSha must be a 40-char lowercase hex git sha");
  }
  if (typeof manifest.notes !== "string") reasons.push("notes must be a string");
  if (typeof manifest.keyId !== "string" || manifest.keyId.length === 0) {
    reasons.push("keyId must be a non-empty string");
  }
  if (manifest.algorithm !== RUNTIME_MANIFEST_ALGORITHM) {
    reasons.push(`algorithm must be ${RUNTIME_MANIFEST_ALGORITHM}`);
  }
  // archiveName is BOUND to version — a valid manifest can never point at a
  // differently named archive, so a signed manifest cannot be retargeted.
  if (isSemver(manifest.version) && manifest.archiveName !== runtimeArchiveName(manifest.version)) {
    reasons.push(`archiveName must be ${runtimeArchiveName(manifest.version)}`);
  }
  if (expectVersion !== undefined && manifest.version !== expectVersion) {
    reasons.push(`version ${manifest.version} does not match the expected ${expectVersion}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * FULL fail-closed verification: shape + pinned authority + Ed25519 signature.
 * `authority` is the pinned release/runtime-update-authority.json record. This
 * is the exact gate the Swift updater and `claudexor release check` mirror.
 */
export function verifyRuntimeManifest(manifest, authority, opts = {}) {
  const shape = validateRuntimeManifestShape(manifest, opts);
  const reasons = [...shape.reasons];
  if (!authority || typeof authority !== "object") {
    reasons.push("runtime-update authority is missing");
  } else {
    if (authority.algorithm !== RUNTIME_MANIFEST_ALGORITHM) {
      reasons.push(`authority algorithm must be ${RUNTIME_MANIFEST_ALGORITHM}`);
    }
    if (manifest && manifest.keyId !== authority.keyId) {
      reasons.push("manifest keyId is not the pinned runtime-update authority");
    }
  }
  if (typeof manifest?.signature !== "string" || !BASE64.test(manifest.signature)) {
    reasons.push("signature is missing or not base64");
  }
  if (reasons.length > 0) return { ok: false, reasons };
  try {
    const key = createPublicKey(authority.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") {
      return { ok: false, reasons: ["authority public key is not Ed25519"] };
    }
    const signature = Buffer.from(manifest.signature, "base64");
    if (
      signature.length !== 64 ||
      !verify(null, runtimeManifestSigningBytes(manifest), key, signature)
    ) {
      return { ok: false, reasons: ["signature is invalid for the pinned key"] };
    }
  } catch {
    return { ok: false, reasons: ["signature verification failed"] };
  }
  return { ok: true, reasons: [] };
}

// NOTE: monotonic anti-replay (compare running/last-known-good/current against
// the signed target) is enforced by the INSTALLER — the Swift updater and the
// TS contract in @claudexor/util (isMonotonicRuntimeUpgrade). The release
// tooling here only produces/verifies signatures, so it deliberately carries no
// version-ordering logic.

/**
 * Sign an unsigned manifest with the OFFLINE private key. Refuses to sign a
 * manifest with an unset/placeholder field (an "unknown" buildSha, a missing
 * sha256) so a half-built manifest can never be promoted into a signed one.
 * Returns the manifest with `keyId`, `algorithm`, and `signature` populated.
 */
export function signRuntimeManifest(unsigned, privateKeyPem, authority) {
  const withKey = {
    schemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
    version: unsigned.version,
    sha256: unsigned.sha256,
    minAppVersion: unsigned.minAppVersion,
    archiveName: unsigned.archiveName,
    buildSha: unsigned.buildSha,
    notes: typeof unsigned.notes === "string" ? unsigned.notes : "",
    keyId: authority.keyId,
    algorithm: RUNTIME_MANIFEST_ALGORITHM,
  };
  const shape = validateRuntimeManifestShape(withKey);
  if (!shape.ok) {
    throw new Error(`refusing to sign a malformed manifest: ${shape.reasons.join("; ")}`);
  }
  if (withKey.buildSha === "unknown" || !GIT_SHA_HEX.test(withKey.buildSha)) {
    throw new Error("refusing to sign a manifest with an unstamped buildSha");
  }
  const key = createPrivateKey(privateKeyPem);
  const signature = sign(null, runtimeManifestSigningBytes(withKey), key).toString("base64");
  const signed = { ...withKey, signature };
  // Self-check with the exact verifier every consumer runs.
  const verified = verifyRuntimeManifest(signed, authority);
  if (!verified.ok) {
    throw new Error(`sealed manifest fails its own verifier: ${verified.reasons.join("; ")}`);
  }
  return signed;
}

/** sha256 hex of a file's bytes (shared by the builder and the signer). */
export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
