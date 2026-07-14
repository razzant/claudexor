export const REQUIRED_TRIAD_MODELS: readonly string[];
export const REQUIRED_SCOPE_MODEL: string;
export const TRIAD_ITEMS: readonly string[];
export const SCOPE_ITEMS: readonly string[];

export interface ChecklistFinding {
  item: string;
  verdict: "PASS" | "FAIL";
  severity: "critical" | "advisory";
  reason: string;
  model: string;
}

export interface ChecklistValidation {
  status: "responded" | "partial" | "parse_failure" | "empty_response";
  findings: ChecklistFinding[];
  missingItems: string[];
  error: string | null;
}

export function exactPanelMatch(triadModels: readonly string[], scopeModel: string): boolean;
export function completionTermination(finishReason: unknown): { complete: boolean; error: string | null };
export function validateChecklistResponse(
  items: unknown,
  model: string,
  requiredItems: readonly string[],
): ChecklistValidation;
export function blockingFindings(findings: readonly ChecklistFinding[]): ChecklistFinding[];
export function releaseReviewDecision(input: {
  triadActors: Array<{ status: string; findings?: ChecklistFinding[] }>;
  scope: { status: string; findings?: ChecklistFinding[] } | null;
  quorum?: number;
}): {
  passed: boolean;
  responsiveTriad: number;
  blockingFindings: ChecklistFinding[];
  reasons: string[];
};
