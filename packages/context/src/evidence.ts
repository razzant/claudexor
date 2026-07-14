import { join } from "node:path";
import { parseUnifiedDiff } from "@claudexor/core";
import {
  containsSecretLikeToken,
  readTextSafe,
  redactSecrets,
  sha256,
  writeText,
} from "@claudexor/util";

/**
 * The `.adversarial-review/` evidence packet that bridges clean-context
 * reviewers: parent context is written to files on disk so critics with no
 * chat history can read it. Critics read these files before producing
 * findings; missing/empty mandatory files => fail closed.
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
  "DIFF_SUMMARY.md",
  "TESTS.txt",
  "DECIDED_TRADEOFFS.md",
];

export interface DiffEvidence {
  diffPath: string;
  summaryPath: string;
  diffSha256: string;
  summary: string;
}

export function writeEvidencePacket(dir: string, packet: EvidencePacket): void {
  writeText(join(dir, "USER_INTENT.md"), evidenceProse("USER_INTENT.md", packet.userIntent));
  writeText(
    join(dir, "FORBIDDEN_FINDINGS.md"),
    evidenceProse(
      "FORBIDDEN_FINDINGS.md",
      packet.forbiddenFindings,
      "(none — no approaches explicitly rejected)",
    ),
  );
  writeText(
    join(dir, "PLAN_ACCEPTED.md"),
    evidenceProse(
      "PLAN_ACCEPTED.md",
      packet.planAccepted,
      "(no formal plan — see USER_INTENT.md for requirements)",
    ),
  );
  writeDiffEvidence(dir, packet.diff);
  writeText(
    join(dir, "FILES_TO_READ_WHOLE.txt"),
    redactSecrets((packet.filesToReadWhole ?? []).join("\n")) + "\n",
  );
  writeText(join(dir, "TESTS.txt"), evidenceProse("TESTS.txt", packet.tests, "(tests not run)"));
  writeText(
    join(dir, "DECIDED_TRADEOFFS.md"),
    evidenceProse("DECIDED_TRADEOFFS.md", packet.decidedTradeoffs, "(none)"),
  );
  if (packet.runtime !== undefined)
    writeText(join(dir, "RUNTIME.md"), evidenceProse("RUNTIME.md", packet.runtime));
}

function evidenceProse(fileName: string, value: string | undefined, fallback = ""): string {
  const raw = (value ?? fallback).trim();
  const redacted = redactSecrets(raw);
  if (containsSecretLikeToken(redacted)) {
    throw new Error(
      `${fileName} evidence contains a secret-like token after redaction; refusing to persist evidence packet`,
    );
  }
  return `${redacted}\n`;
}

export function writeDiffEvidence(dir: string, diff: string): DiffEvidence {
  const normalizedDiff = diff || "(empty diff)\n";
  const diffText = normalizedDiff.endsWith("\n") ? normalizedDiff : `${normalizedDiff}\n`;
  if (containsSecretLikeToken(diffText)) {
    throw new Error(
      "diff evidence contains a secret-like token; refusing to persist raw DIFF.patch",
    );
  }
  const diffPath = join(dir, "DIFF.patch");
  const summaryPath = join(dir, "DIFF_SUMMARY.md");
  const diffSha256 = sha256(diffText);
  const summary = summarizeDiff(diffText, redactSecrets(diffText));
  writeText(diffPath, diffText);
  writeText(summaryPath, `# Diff Summary\n\nDigest: ${diffSha256}\n\n${summary}\n`);
  writeText(join(dir, "DIFF_SHA256.txt"), `${diffSha256}\n`);
  return { diffPath, summaryPath, diffSha256, summary };
}

function summarizeDiff(diff: string, displayDiff = diff): string {
  // ONE parser owns diff structure (git-anchored AND plain GNU documents):
  // counts come from the shared parseUnifiedDiff, never from local line
  // scans — a `diff -ruN` patch must not summarize as "Files: 0" while the
  // gates see its files.
  const parsed = parseUnifiedDiff(diff);
  const display = parseUnifiedDiff(displayDiff);
  const fileLabel = (f: { oldPath: string | null; newPath: string | null }): string =>
    `${f.oldPath ?? "/dev/null"} -> ${f.newPath ?? "/dev/null"}`;
  const allFiles = parsed.files.filter((f) => f.oldPath || f.newPath);
  const displayFiles = display.files.filter((f) => f.oldPath || f.newPath).map(fileLabel);
  const files = displayFiles.slice(0, 80);
  const lines = diff.split(/\r?\n/);
  const fallbackHeaders = displayDiff
    .split(/\r?\n/)
    .filter(
      (line) => /^#{1,6}\s+\S/.test(line) || line.startsWith("### ") || line.startsWith("## "),
    )
    .slice(0, 40);
  const body = [
    `- Patch bytes: ${Buffer.byteLength(diff, "utf8")}`,
    `- Patch lines: ${lines.length}`,
    `- Files: ${allFiles.length}`,
    `- Hunks: ${parsed.hunks}`,
    `- Additions: ${parsed.additions}`,
    `- Deletions: ${parsed.deletions}`,
  ];
  if (files.length) {
    body.push("", "Files:", ...files.map((file) => `- ${file}`));
    if (allFiles.length > files.length) {
      body.push(`- ... ${allFiles.length - files.length} more file(s) omitted`);
    }
  } else if (fallbackHeaders.length) {
    body.push(
      "",
      "Text sections:",
      ...fallbackHeaders.map((line) => `- ${line.replace(/^#+\s*/, "")}`),
    );
  } else {
    body.push("", "- No unified diff headers detected. Read DIFF.patch for the candidate content.");
  }
  return body.join("\n");
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
