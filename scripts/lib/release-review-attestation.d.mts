export interface SealReleaseReviewAttestationInput {
  packetDir: string;
  packetManifestSha256?: string;
  fullGateReceipt: string;
  tier1Dir: string;
  triadDir: string;
  panelLock: string;
  privateKeyPath: string;
  authorityPath: string;
}

export function sha256Bytes(value: string | Uint8Array): string;
export function sha256File(path: string): string;
export function verifyEvidenceManifest(packetDir: string): {
  manifestSha256: string;
  entries: Array<{ name: string; sha256: string }>;
};
export function sealReleaseReviewAttestation(input: SealReleaseReviewAttestationInput): any;
