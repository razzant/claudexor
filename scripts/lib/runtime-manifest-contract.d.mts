export const RUNTIME_MANIFEST_SCHEMA_VERSION: 1;
export const RUNTIME_MANIFEST_ALGORITHM: "Ed25519";
export const RUNTIME_RELEASE_REPO: string;

export interface SignedRuntimeManifest {
  schemaVersion: 1;
  version: string;
  sha256: string;
  minAppVersion: string;
  archiveName: string;
  archiveUrl: string;
  buildSha: string;
  notes: string;
  keyId: string;
  algorithm: "Ed25519";
  signature: string;
}

export interface RuntimeUpdateAuthority {
  schemaVersion: number;
  keyId: string;
  algorithm: "Ed25519";
  role?: string;
  publicKeyPem: string;
}

export function isSemver(value: unknown): value is string;
export function runtimeArchiveName(version: string): string;
export function runtimeArchiveUrl(version: string): string;
export function canonicalJson(value: unknown): string;
export function runtimeManifestSignedFields(manifest: any): Record<string, unknown>;
export function runtimeManifestSigningBytes(manifest: any): Buffer;
export function validateRuntimeManifestShape(
  manifest: any,
  opts?: { expectVersion?: string },
): { ok: boolean; reasons: string[] };
export function verifyRuntimeManifest(
  manifest: any,
  authority: any,
  opts?: { expectVersion?: string },
): { ok: boolean; reasons: string[] };
export function signRuntimeManifest(
  unsigned: {
    version: string;
    sha256: string;
    minAppVersion: string;
    archiveName: string;
    archiveUrl?: string;
    buildSha: string;
    notes?: string;
  },
  privateKeyPem: string,
  authority: RuntimeUpdateAuthority,
): SignedRuntimeManifest;
export function sha256Hex(buffer: Buffer | Uint8Array | string): string;
