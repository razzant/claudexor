/**
 * Run-support helpers: transient retry pacing, gate-derived protected paths,
 * prompt constraints, harness-event redaction/payload projection, and the
 * run summary/findings renderers. Pure functions — no orchestrator state.
 */
import type { HarnessEvent, ModeKind, ProtectedPathApproval, ReviewFinding } from "@claudexor/schema";
import { isBlocking } from "@claudexor/schema";
import type { CandidateEvidence } from "@claudexor/arbitration";
import { redactSecrets } from "@claudexor/util";

export interface TransientRetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export function transientRetryDelayMs(
  nativeDelayMs: number | null,
  policy: TransientRetryPolicy,
  retryIndex: number,
): number {
  const fallback = policy.initialDelayMs * 2 ** retryIndex;
  const delay = nativeDelayMs ?? fallback;
  return Math.min(delay, policy.maxDelayMs);
}


export function gateProtectedPaths(commands: string[]): string[] {
  if (commands.length === 0) return [];
  const paths = new Set([
    "package.json",
    "**/package.json",
    "test/**",
    "tests/**",
    "__tests__/**",
    "**/*.test.*",
    "**/*.spec.*",
  ]);
  for (const command of commands) {
    for (const raw of command.split(/\s+/)) {
      const token = raw.trim().replace(/^['"]|['"]$/g, "");
      if (
        !token ||
        token.startsWith("-") ||
        token.includes("=") ||
        token.includes("://") ||
        token.startsWith("/")
      )
        continue;
      if (!token.includes("/") && !token.includes(".")) continue;
      const clean = token.replace(/^[./]+/, "").replace(/[),;]+$/g, "");
      if (!clean || clean === "package.json") continue;
      const testish =
        clean.startsWith("test/") ||
        clean.startsWith("tests/") ||
        clean.startsWith("__tests__/") ||
        clean.includes(".test.") ||
        clean.includes(".spec.");
      if (testish) paths.add(clean.endsWith("/") ? `${clean}**` : clean);
    }
  }
  return [...paths];
}


export function promptWithProtectedPathConstraint(
  prompt: string,
  protectedPaths: string[],
  autoProtectedPaths: string[] = [],
  approvals: ProtectedPathApproval[] = [],
): string {
  if (protectedPaths.length === 0 && autoProtectedPaths.length === 0) return prompt;
  const specLines = protectedPaths.length
    ? [
        "",
        "Engine constraint: do not edit spec/config protected paths unless the frozen task contract explicitly asks for it. Protected paths:",
        ...protectedPaths.slice(0, 20).map((p) => `- ${p}`),
      ]
    : [];
  const approvalLines = approvals.length
    ? [
        "",
        "Approved auto-protected gate/test path changes for this run:",
        ...approvals.slice(0, 20).map((a) => `- ${a.path}${a.reason ? ` (${a.reason})` : ""}`),
      ]
    : [];
  const autoLines = autoProtectedPaths.length
    ? [
        "",
        "Engine constraint: do not edit auto-protected gate/test paths, test commands, or package test scripts unless the user explicitly asked to change tests. Auto-protected paths:",
        ...autoProtectedPaths.slice(0, 20).map((p) => `- ${p}`),
        ...approvalLines,
      ]
    : [];
  return [
    prompt,
    ...specLines,
    ...autoLines,
  ].join("\n");
}


export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export function redactHarnessEvent(ev: HarnessEvent): HarnessEvent {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(ev))) as HarnessEvent;
  } catch {
    return {
      ...ev,
      text: ev.text ? redactSecrets(ev.text) : undefined,
      error: ev.error ? redactSecrets(ev.error) : undefined,
      payload: ev.payload ? { redacted: true } : undefined,
    };
  }
}


export function harnessEventPayload(
  harnessId: string,
  attemptId: string,
  ev: HarnessEvent,
): Record<string, unknown> {
  const safe = redactHarnessEvent(ev);
  const title =
    safe.error ??
    safe.text ??
    (safe.usage
      ? `usage: ${safe.usage.input_tokens ?? 0} in / ${safe.usage.output_tokens ?? 0} out`
      : safe.type);
  return {
    harness_id: harnessId,
    attempt_id: attemptId,
    session_id: safe.session_id,
    type: safe.type,
    title: String(title).slice(0, 500),
    text: safe.text,
    error: safe.error,
    usage: safe.usage,
    observed_model: safe.observed_model,
    tool: safe.tool,
    interaction: safe.interaction,
    payload: safe.payload,
  };
}

/**
 * Deduplicate the known "final result repeats the last streamed message" shape
 * (adjacent only). Legitimately repeated earlier messages are preserved — a
 * whole-array dedupe would silently merge real output.
 */

export function pushUniqueText(parts: string[], text: string): void {
  const normalized = text.trim();
  if (!normalized) return;
  const last = parts[parts.length - 1]?.trim();
  if (last === normalized) return;
  parts.push(normalized);
}


export function formatFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "(no findings recorded)";
  return findings
    .map(
      (f) =>
        `- [${f.severity}/${f.status}] ${f.claim}` +
        (f.evidence.files.length > 0
          ? ` (${f.evidence.files.map((x) => x.path).join(", ")})`
          : "") +
        (f.proposed_fix ? ` -> fix: ${f.proposed_fix}` : ""),
    )
    .join("\n");
}


export function renderSummary(
  runId: string,
  mode: ModeKind,
  decision: {
    winner: string | null;
    status: string;
    outcome?: string;
    why_winner: string;
    apply_recommendation: string;
  },
  evidences: CandidateEvidence[],
  synthReason: string,
  reviewVerified: boolean,
): string {
  return (
    [
      `# Run ${runId} (${mode})`,
      "",
      `- Status: ${decision.status}`,
      `- Outcome: ${decision.outcome ?? "unknown"}`,
      `- Winner: ${decision.winner ?? "none"}`,
      `- Apply: ${decision.apply_recommendation}`,
      `- Review verified (cross-family): ${reviewVerified}`,
      `- Synthesis: ${synthReason}`,
      "",
      "## Candidates",
      ...evidences.map(
        (e) =>
          `- ${e.label} (${e.attemptId}): gates ${e.testsPassed}/${e.testsTotal}, blockers ${e.findings.filter((f) => isBlocking(f)).length}, cleanReview ${e.finalReviewClean}`,
      ),
      "",
      "## Why winner",
      decision.why_winner,
    ].join("\n") + "\n"
  );
}
