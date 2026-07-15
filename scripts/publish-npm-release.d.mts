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
}

export function validatePublishedProvenance(input: PublishedProvenanceInput): {
  ok: boolean;
  reasons: string[];
};
