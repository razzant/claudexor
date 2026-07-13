/** Type declarations for the shared OpenRouter review-panel client. */
export interface PanelActor {
  model: string;
  observedModel?: string | null;
  status: "responded" | "error" | "timed_out";
  raw: string;
  error?: string;
  ms?: number;
  findings?: unknown[] | null;
  parseError?: string | null;
}
export function callOpenRouterModel(
  model: string,
  prompt: string,
  opts?: { maxTokens?: number; timeoutMs?: number },
): Promise<PanelActor>;
export function exactObservedModelMatch(requestedModel: unknown, observedModel: unknown): boolean;
export function isFindingShaped(item: unknown): boolean;
export function isBlockingSeverity(severity: unknown): boolean;
export function parseFindingsArray(raw: string): { findings: unknown[] | null; error: string | null };
export function runOpenRouterPanel(
  models: string[],
  prompt: string,
  opts?: { quorum?: number; maxTokens?: number; timeoutMs?: number },
): Promise<{ actors: PanelActor[]; quorumMet: boolean; responsiveCount: number; findings: Array<Record<string, unknown>> }>;
