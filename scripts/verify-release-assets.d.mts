export interface ReleaseAssetVerification {
  ok: boolean;
  reasons: string[];
}

export function verifyReleaseAssetNames(
  expectedNames: Iterable<string>,
  remoteNames: Iterable<string>,
  phase: "before" | "after",
): ReleaseAssetVerification;
