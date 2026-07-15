import type { DiffEvidence } from "@claudexor/context";

const RELEASE_NATIVE_CHECKLIST_ITEMS = [
  "sealed_evidence",
  "intent_and_scope",
  "runtime_and_security",
  "tests_and_release",
] as const;

export function buildReviewPrompt(
  label: string,
  candidateRoot: string,
  evidenceDir: string,
  patch: DiffEvidence,
  sealed = false,
): string {
  const responseContract = sealed
    ? [
        "Output ONLY one JSON object with this exact release-review envelope:",
        '{"completion":{"verdict":"PASS","checklist":[{"item":"...","completed":true}],"findingCount":0},"findings":[]}',
        `The completion.checklist must contain exactly these items in this order: ${RELEASE_NATIVE_CHECKLIST_ITEMS.join(", ")}.`,
        "Every checklist row must set completed=true. findingCount must exactly equal findings.length.",
        "Use completion.verdict=FAIL for BLOCK, FIX_FIRST, NEEDS_HUMAN, or INSUFFICIENT_EVIDENCE; otherwise PASS.",
        "findings uses the finding schema below. A clean review is the completed envelope with findings=[], never a bare [] or [{}].",
      ]
    : ["Output ONLY a JSON array of findings."];
  return [
    "You are an adversarial code reviewer.",
    `Candidate root: ${candidateRoot}.`,
    sealed
      ? `First verify MANIFEST.sha256 and read every file it seals in ${evidenceDir}, including FREEZE.json and DECIDED_TRADEOFFS.md. If the manifest or a sealed file is missing, return INSUFFICIENT_EVIDENCE.`
      : `First read the evidence packet in ${evidenceDir} (USER_INTENT.md, FORBIDDEN_FINDINGS.md, PLAN_ACCEPTED.md, DECIDED_TRADEOFFS.md, TESTS.txt, DIFF.patch, DIFF_SUMMARY.md). If a mandatory file is missing, return INSUFFICIENT_EVIDENCE.`,
    `Review ${label}'s change from the file-backed patch artifact, not from this prompt. Full patch: ${patch.diffPath}. Summary: ${patch.summaryPath}. Patch digest: ${patch.diffSha256}.`,
    "All code/file evidence must come from Candidate root or the evidence packet. Do not inspect or cite sibling/base repository paths outside Candidate root; if required evidence is unavailable there, return INSUFFICIENT_EVIDENCE.",
    "Treat TESTS.txt as the gate evidence. Do not rerun full build/test gates from the review; run only small targeted commands when needed to verify a concrete finding.",
    "In finding evidence, cite candidate files with paths relative to Candidate root. Cite evidence packet files by their evidence filename (for example DIFF.patch or TESTS.txt). Do not cite absolute Candidate root, reviewer workspace, or evidenceDir paths; those are disposable transport paths and will be rejected as evidence.",
    ...responseContract,
    `Each finding: {"severity":"BLOCK|FIX_FIRST|WARN|NIT|OUT_OF_SCOPE|INSUFFICIENT_EVIDENCE|NEEDS_HUMAN","category":"correctness|regression|security|performance|maintainability|test_gap|spec_gap|deploy|architecture|ux","claim":"...","evidence":{"files":[{"path":"...","lines":"..."}]},"proposed_fix":"..."}.`,
    "Rules: no evidence => do NOT use BLOCK. Do not relitigate FORBIDDEN_FINDINGS or DECIDED_TRADEOFFS.",
    "",
    "Patch summary (not a replacement for reading DIFF.patch):",
    patch.summary,
  ].join("\n");
}
