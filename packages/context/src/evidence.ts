import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
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

/** One sealed packet contract shared by the cumulative Tier-1 and Tier-2 reviewers. */
export const FROZEN_REVIEW_EVIDENCE_FILES = [
  "USER_INTENT.md",
  "FORBIDDEN_FINDINGS.md",
  "PLAN_ACCEPTED.md",
  "DECIDED_TRADEOFFS.md",
  "AUTHORIZATION.json",
  "FREEZE.json",
  "DIFF.patch",
  "DIFF_SUMMARY.md",
  "PHASE_DELTA.md",
  "COMMITS.tsv",
  "TRACEABILITY.md",
  "TESTS.txt",
  "TEST_RESULTS.json",
  "FINGERPRINTS.json",
  "RUNTIME.md",
  "FILES_TO_READ_WHOLE.txt",
  "RELEASE_PREFLIGHT.md",
] as const;

export interface PacketManifestFile {
  path: string;
  sha256: string;
}

export interface PacketManifestValidation {
  ok: boolean;
  reasons: string[];
  files: string[];
}

export interface SealedEvidencePacketInput {
  evidenceDir: string;
  candidateSha: string;
  candidateTree: string;
  expectedManifestSha256?: string;
}

export interface SealedEvidencePacket {
  evidenceDir: string;
  baseSha: string;
  candidateSha: string;
  candidateTree: string;
  diff: string;
  manifestSha256: string;
  files: string[];
}

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

/** Validate the relative-path SHA-256 manifest against the exact packet file set. */
export function validatePacketManifest(
  manifestText: string,
  actualFiles: readonly PacketManifestFile[],
): PacketManifestValidation {
  const reasons: string[] = [];
  const expected = new Map<string, string>();
  const lines = String(manifestText).split(/\r?\n/).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) {
      reasons.push(`invalid manifest line ${index + 1}`);
      continue;
    }
    const path = match[2]!.replace(/^\.\//, "");
    if (!path || path === "MANIFEST.sha256" || isAbsolute(path) || path.split("/").includes("..")) {
      reasons.push(`invalid manifest path '${path}'`);
      continue;
    }
    if (expected.has(path)) {
      reasons.push(`duplicate manifest path '${path}'`);
      continue;
    }
    expected.set(path, match[1]!);
  }
  const actual = new Map(actualFiles.map((file) => [file.path, file.sha256]));
  for (const [path, digest] of expected) {
    if (!actual.has(path)) reasons.push(`manifest file missing: ${path}`);
    else if (actual.get(path) !== digest) reasons.push(`manifest digest mismatch: ${path}`);
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) reasons.push(`unsealed packet file: ${path}`);
  }
  if (expected.size === 0) reasons.push("packet manifest is empty");
  return { ok: reasons.length === 0, reasons, files: [...expected.keys()] };
}

/**
 * Verify an immutable cumulative-review packet before any reviewer sees it.
 * Live git SHA/tree/cleanliness and base..candidate diff checks remain caller
 * responsibilities because this module owns evidence bytes, not repositories.
 */
export function verifySealedEvidencePacket(input: SealedEvidencePacketInput): SealedEvidencePacket {
  assertLowerHex(input.candidateSha, 40, "candidate SHA");
  assertLowerHex(input.candidateTree, 40, "candidate tree");
  const evidenceDir = realpathSync(input.evidenceDir);
  const manifestPath = join(evidenceDir, "MANIFEST.sha256");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("MANIFEST.sha256 must be a regular file");
  }
  const manifestBytes = readFileSync(manifestPath);
  const manifestSha256 = hashBytes(manifestBytes);
  if (input.expectedManifestSha256 !== undefined) {
    const expected = normalizeSha256(input.expectedManifestSha256);
    if (manifestSha256 !== expected) {
      throw new Error(
        `packet manifest identity mismatch (expected ${expected}, got ${manifestSha256})`,
      );
    }
  }

  const actualFiles = collectPacketFiles(evidenceDir);
  const manifest = validatePacketManifest(manifestBytes.toString("utf8"), actualFiles);
  if (!manifest.ok) throw new Error(`packet manifest failed: ${manifest.reasons.join("; ")}`);
  for (const file of actualFiles) {
    const text = readFileSync(join(evidenceDir, file.path), "utf8");
    if (containsSecretLikeToken(file.path) || containsSecretLikeToken(text)) {
      throw new Error(`sealed packet contains a secret-like token: ${file.path}`);
    }
  }
  const missing = FROZEN_REVIEW_EVIDENCE_FILES.filter((file) => !manifest.files.includes(file));
  if (missing.length > 0) throw new Error(`sealed packet is missing: ${missing.join(", ")}`);
  const empty = FROZEN_REVIEW_EVIDENCE_FILES.filter(
    (file) => readFileSync(join(evidenceDir, file)).length === 0,
  );
  if (empty.length > 0) throw new Error(`sealed packet contains empty files: ${empty.join(", ")}`);

  let freeze: unknown;
  try {
    freeze = JSON.parse(readFileSync(join(evidenceDir, "FREEZE.json"), "utf8"));
  } catch (error) {
    throw new Error(
      `invalid FREEZE.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!freeze || typeof freeze !== "object" || Array.isArray(freeze)) {
    throw new Error("invalid FREEZE.json: expected an object");
  }
  const fields = freeze as Record<string, unknown>;
  if (fields["candidateSha"] !== input.candidateSha) {
    throw new Error("FREEZE.json candidate SHA does not match the requested candidate");
  }
  if (fields["candidateTree"] !== input.candidateTree) {
    throw new Error("FREEZE.json candidate tree does not match the requested candidate");
  }
  const baseSha = fields["baseSha"];
  if (typeof baseSha !== "string") throw new Error("FREEZE.json must contain baseSha");
  assertLowerHex(baseSha, 40, "FREEZE.json base SHA");

  const preflight = preflightEvidence(evidenceDir);
  if (!preflight.ok) {
    throw new Error(
      `sealed packet evidence preflight failed (missing: ${preflight.missing.join(", ")}; empty: ${preflight.empty.join(", ")})`,
    );
  }
  return {
    evidenceDir,
    baseSha,
    candidateSha: input.candidateSha,
    candidateTree: input.candidateTree,
    diff: readFileSync(join(evidenceDir, "DIFF.patch"), "utf8"),
    manifestSha256,
    files: manifest.files,
  };
}

function collectPacketFiles(root: string, current = root): PacketManifestFile[] {
  const files: PacketManifestFile[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`sealed packet must not contain symlinks: ${relative(root, absolute)}`);
    }
    if (entry.isDirectory()) {
      files.push(...collectPacketFiles(root, absolute));
    } else if (entry.isFile() && entry.name !== "MANIFEST.sha256") {
      files.push({
        path: relative(root, absolute).split(sep).join("/"),
        sha256: hashBytes(readFileSync(absolute)),
      });
    } else if (!entry.isFile()) {
      throw new Error(`sealed packet contains a non-regular file: ${relative(root, absolute)}`);
    }
  }
  return files;
}

function normalizeSha256(value: string): string {
  const normalized = value.startsWith("sha256:") ? value.slice(7) : value;
  assertLowerHex(normalized, 64, "packet manifest SHA-256");
  return normalized;
}

function assertLowerHex(value: string, length: number, label: string): void {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new Error(`${label} must be exactly ${length} lowercase hex characters`);
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
