import { join } from "node:path";
import { readTextSafe, writeText } from "@claudexor/util";

/**
 * The `.adversarial-review/` evidence packet that bridges clean-context
 * reviewers (generalized from cursor-multimodel-review). Critics read these
 * files before producing findings; missing/empty mandatory files => fail closed.
 */
export interface EvidencePacket {
  userIntent: string;
  forbiddenFindings?: string;
  planAccepted?: string;
  diff: string;
  filesToReadWhole?: string[];
  tests?: string;
  decidedTradeoffs?: string;
  runtime?: string;
}

export const MANDATORY_EVIDENCE_FILES = [
  "USER_INTENT.md",
  "FORBIDDEN_FINDINGS.md",
  "PLAN_ACCEPTED.md",
  "DIFF.patch",
  "TESTS.txt",
  "DECIDED_TRADEOFFS.md",
];

export function writeEvidencePacket(dir: string, packet: EvidencePacket): void {
  writeText(join(dir, "USER_INTENT.md"), packet.userIntent.trim() + "\n");
  writeText(
    join(dir, "FORBIDDEN_FINDINGS.md"),
    (packet.forbiddenFindings ?? "(none — no approaches explicitly rejected)").trim() + "\n",
  );
  writeText(
    join(dir, "PLAN_ACCEPTED.md"),
    (packet.planAccepted ?? "(no formal plan — see USER_INTENT.md for requirements)").trim() + "\n",
  );
  writeText(join(dir, "DIFF.patch"), packet.diff.endsWith("\n") ? packet.diff : packet.diff + "\n");
  writeText(join(dir, "FILES_TO_READ_WHOLE.txt"), (packet.filesToReadWhole ?? []).join("\n") + "\n");
  writeText(join(dir, "TESTS.txt"), (packet.tests ?? "(tests not run)").trim() + "\n");
  writeText(join(dir, "DECIDED_TRADEOFFS.md"), (packet.decidedTradeoffs ?? "(none)").trim() + "\n");
  if (packet.runtime !== undefined) writeText(join(dir, "RUNTIME.md"), packet.runtime.trim() + "\n");
}

export interface PreflightResult {
  ok: boolean;
  missing: string[];
  empty: string[];
}

/** Fail-closed pre-flight: all mandatory evidence files must exist and be non-empty. */
export function preflightEvidence(dir: string): PreflightResult {
  const missing: string[] = [];
  const empty: string[] = [];
  for (const file of MANDATORY_EVIDENCE_FILES) {
    const text = readTextSafe(join(dir, file));
    if (text === null) missing.push(file);
    else if (text.trim().length === 0) empty.push(file);
  }
  return { ok: missing.length === 0 && empty.length === 0, missing, empty };
}

export function readRound(dir: string): number {
  const text = readTextSafe(join(dir, "round.txt"));
  if (!text) return 0;
  const n = Number.parseInt(text.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

export function incrementRound(dir: string): number {
  const next = readRound(dir) + 1;
  writeText(join(dir, "round.txt"), String(next) + "\n");
  return next;
}
