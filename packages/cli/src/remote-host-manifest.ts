/**
 * The signed SSH-runtime manifest as the npm CLI reads it.
 *
 * One wire contract with three carriers bound by tests: the release tooling
 * (`scripts/lib/remote-runtime-manifest-contract.mjs`), the macOS app
 * (`ClaudexorKit/RemoteRuntime.swift`) and this module, which the
 * controller-side `remote preflight` / `remote install` use. The npm CLI ships
 * without the repository's `scripts/` and `release/` directories, so it carries
 * its own copy of the verifier and the pinned runtime-update authority from
 * `@claudexor/util` (the key that also signs the engine runtime manifest; the
 * signed `kind` keeps the two manifests apart).
 */
import { createPublicKey, verify } from "node:crypto";
import {
  RUNTIME_MANIFEST_ALGORITHM,
  RUNTIME_MANIFEST_SCHEMA_VERSION,
  RUNTIME_RELEASE_REPO,
  RUNTIME_UPDATE_AUTHORITY,
  canonicalJson,
  isRuntimeSemver,
  type RuntimeUpdateAuthority,
} from "@claudexor/util";

export const REMOTE_RUNTIME_MANIFEST_KIND = "claudexor-remote-runtime";
export const REMOTE_RUNTIME_PROTOCOL_MAJOR = 3;
export const REMOTE_RUNTIME_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
] as const;
export type RemoteRuntimeTarget = (typeof REMOTE_RUNTIME_TARGETS)[number];

export interface RemoteRuntimeAsset {
  target: RemoteRuntimeTarget;
  platform: string;
  arch: string;
  nodeVersion: string;
  archiveName: string;
  archiveUrl: string;
  sha256: string;
}

export interface RemoteRuntimeManifest {
  schemaVersion: 1;
  kind: typeof REMOTE_RUNTIME_MANIFEST_KIND;
  version: string;
  buildSha: string;
  protocolMajor: number;
  minAppVersion: string;
  notes: string;
  assets: RemoteRuntimeAsset[];
  keyId: string;
  algorithm: "Ed25519";
  signature: string;
}

export type RemoteRuntimeManifestCheck =
  { ok: true; manifest: RemoteRuntimeManifest } | { ok: false; reasons: string[] };

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA_HEX = /^[0-9a-f]{40}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MANIFEST_FIELDS = new Set([
  "algorithm",
  "assets",
  "buildSha",
  "keyId",
  "kind",
  "minAppVersion",
  "notes",
  "protocolMajor",
  "schemaVersion",
  "signature",
  "version",
]);
/** Exactly the seven asset fields every carrier signs (and refuses beyond). */
const ASSET_FIELDS = new Set([
  "arch",
  "archiveName",
  "archiveUrl",
  "nodeVersion",
  "platform",
  "sha256",
  "target",
]);

export function remoteRuntimeArchiveName(version: string, target: RemoteRuntimeTarget): string {
  return `claudexor-remote-runtime-${version}-${target}.tar.gz`;
}

export function remoteRuntimeArchiveUrl(version: string, target: RemoteRuntimeTarget): string {
  return `https://github.com/${RUNTIME_RELEASE_REPO}/releases/download/v${version}/${remoteRuntimeArchiveName(version, target)}`;
}

/** The manifest published beside the archives of one exact release tag. */
export function remoteRuntimeManifestUrl(version: string): string {
  return `https://github.com/${RUNTIME_RELEASE_REPO}/releases/download/v${version}/remote-runtime-manifest.json`;
}

export function isRemoteRuntimeTarget(value: unknown): value is RemoteRuntimeTarget {
  return (REMOTE_RUNTIME_TARGETS as readonly unknown[]).includes(value);
}

/** The canonical bytes the signature covers: every field but `signature`,
 * with each asset projected onto exactly the seven signed fields. */
export function remoteRuntimeManifestSigningBytes(manifest: Record<string, unknown>): Buffer {
  const assets = Array.isArray(manifest["assets"])
    ? (manifest["assets"] as Record<string, unknown>[]).map((asset) => ({
        arch: asset["arch"],
        archiveName: asset["archiveName"],
        archiveUrl: asset["archiveUrl"],
        nodeVersion: asset["nodeVersion"],
        platform: asset["platform"],
        sha256: asset["sha256"],
        target: asset["target"],
      }))
    : manifest["assets"];
  return Buffer.from(
    canonicalJson({
      schemaVersion: manifest["schemaVersion"],
      kind: manifest["kind"],
      version: manifest["version"],
      buildSha: manifest["buildSha"],
      protocolMajor: manifest["protocolMajor"],
      minAppVersion: manifest["minAppVersion"],
      notes: manifest["notes"],
      assets,
      keyId: manifest["keyId"],
      algorithm: manifest["algorithm"],
    }),
    "utf8",
  );
}

function assetReasons(assets: unknown, version: unknown): string[] {
  if (!Array.isArray(assets)) return ["assets must be an array"];
  const reasons: string[] = [];
  const seen: unknown[] = [];
  for (const asset of assets as unknown[]) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      reasons.push("every asset must be an object");
      continue;
    }
    const a = asset as Record<string, unknown>;
    const unknownKeys = Object.keys(a).filter((key) => !ASSET_FIELDS.has(key));
    if (unknownKeys.length > 0) {
      reasons.push(
        `asset ${String(a["target"])} has unknown field(s) ${unknownKeys.sort().join(", ")}`,
      );
    }
    const target = a["target"];
    if (!isRemoteRuntimeTarget(target)) {
      reasons.push(`unsupported asset target ${String(target)}`);
      continue;
    }
    if (seen.includes(target)) reasons.push(`duplicate asset target ${target}`);
    seen.push(target);
    const [platform, arch] = target.split("-");
    if (a["platform"] !== platform) reasons.push(`${target} platform must be ${platform}`);
    if (a["arch"] !== arch) reasons.push(`${target} arch must be ${arch}`);
    if (!isRuntimeSemver(a["nodeVersion"])) reasons.push(`${target} nodeVersion must be semver`);
    if (typeof a["sha256"] !== "string" || !SHA256_HEX.test(a["sha256"])) {
      reasons.push(`${target} sha256 must be 64 lowercase hex chars`);
    }
    if (isRuntimeSemver(version)) {
      if (a["archiveName"] !== remoteRuntimeArchiveName(version, target)) {
        reasons.push(`${target} archiveName must be ${remoteRuntimeArchiveName(version, target)}`);
      }
      if (a["archiveUrl"] !== remoteRuntimeArchiveUrl(version, target)) {
        reasons.push(`${target} archiveUrl must be ${remoteRuntimeArchiveUrl(version, target)}`);
      }
    }
  }
  for (const target of REMOTE_RUNTIME_TARGETS) {
    if (!seen.includes(target)) reasons.push(`missing asset target ${target}`);
  }
  if (
    seen.length === REMOTE_RUNTIME_TARGETS.length &&
    seen.some((target, index) => target !== REMOTE_RUNTIME_TARGETS[index])
  ) {
    reasons.push(`assets must be ordered: ${REMOTE_RUNTIME_TARGETS.join(", ")}`);
  }
  return reasons;
}

function shapeReasons(m: Record<string, unknown>, expectVersion: string | undefined): string[] {
  const reasons: string[] = [];
  const unknownKeys = Object.keys(m).filter((key) => !MANIFEST_FIELDS.has(key));
  if (unknownKeys.length > 0) {
    reasons.push(`manifest has unknown field(s) ${unknownKeys.sort().join(", ")}`);
  }
  if (m["schemaVersion"] !== RUNTIME_MANIFEST_SCHEMA_VERSION) {
    reasons.push(`schemaVersion must be ${RUNTIME_MANIFEST_SCHEMA_VERSION}`);
  }
  if (m["kind"] !== REMOTE_RUNTIME_MANIFEST_KIND) {
    reasons.push(`kind must be ${REMOTE_RUNTIME_MANIFEST_KIND}`);
  }
  if (!isRuntimeSemver(m["version"])) reasons.push("version must be an x.y.z semver");
  if (typeof m["buildSha"] !== "string" || !GIT_SHA_HEX.test(m["buildSha"])) {
    reasons.push("buildSha must be a 40-char lowercase hex git sha");
  }
  if (m["protocolMajor"] !== REMOTE_RUNTIME_PROTOCOL_MAJOR) {
    reasons.push(`protocolMajor must be ${REMOTE_RUNTIME_PROTOCOL_MAJOR}`);
  }
  if (!isRuntimeSemver(m["minAppVersion"])) reasons.push("minAppVersion must be an x.y.z semver");
  if (typeof m["notes"] !== "string") reasons.push("notes must be a string");
  if (typeof m["keyId"] !== "string" || m["keyId"].length === 0) {
    reasons.push("keyId must be a non-empty string");
  }
  if (m["algorithm"] !== RUNTIME_MANIFEST_ALGORITHM) {
    reasons.push(`algorithm must be ${RUNTIME_MANIFEST_ALGORITHM}`);
  }
  reasons.push(...assetReasons(m["assets"], m["version"]));
  if (expectVersion !== undefined && m["version"] !== expectVersion) {
    reasons.push(`version ${String(m["version"])} does not match the expected ${expectVersion}`);
  }
  return reasons;
}

/**
 * Fail-closed verification: shape, pinned authority and Ed25519 signature.
 * `authority` is a TEST-ONLY seam; production callers never pass it, so the
 * check is always pinned to RUNTIME_UPDATE_AUTHORITY. Never throws.
 */
export function verifyRemoteRuntimeManifest(
  value: unknown,
  authority: RuntimeUpdateAuthority = RUNTIME_UPDATE_AUTHORITY,
  opts: { expectVersion?: string } = {},
): RemoteRuntimeManifestCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reasons: ["manifest is not an object"] };
  }
  const m = value as Record<string, unknown>;
  const reasons = shapeReasons(m, opts.expectVersion);
  if (authority.algorithm !== RUNTIME_MANIFEST_ALGORITHM) {
    reasons.push(`authority algorithm must be ${RUNTIME_MANIFEST_ALGORITHM}`);
  }
  if (m["keyId"] !== authority.keyId) {
    reasons.push("manifest keyId is not the pinned runtime-update authority");
  }
  if (typeof m["signature"] !== "string" || !BASE64.test(m["signature"])) {
    reasons.push("signature is missing or not base64");
  }
  if (reasons.length > 0) return { ok: false, reasons };
  try {
    const key = createPublicKey(authority.publicKeyPem);
    const signature = Buffer.from(m["signature"] as string, "base64");
    if (
      key.asymmetricKeyType !== "ed25519" ||
      signature.length !== 64 ||
      !verify(null, remoteRuntimeManifestSigningBytes(m), key, signature)
    ) {
      return { ok: false, reasons: ["signature is invalid for the pinned key"] };
    }
  } catch {
    return { ok: false, reasons: ["signature verification failed"] };
  }
  return { ok: true, manifest: m as unknown as RemoteRuntimeManifest };
}
