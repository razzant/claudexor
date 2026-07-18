export interface PublishedProvenanceInput {
  metadata: Record<string, any>;
  attestationDocument: Record<string, any>;
  packageName: string;
  version: string;
  integrity: string;
  sha512Hex: string;
  candidateSha: string;
  repository: string;
  workflowPath: string;
  ref: string;
  /** Already-published skip path: anchor on npm's signed provenance instead
   * of local byte-identity (builds are not byte-reproducible across runs). */
  allowSameSourceRebuild?: boolean;
}

export function validatePublishedProvenance(input: PublishedProvenanceInput): {
  ok: boolean;
  reasons: string[];
};
