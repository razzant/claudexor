#!/usr/bin/env node
// Historical signed-review tooling. Current releases use the independent
// report/disposition and maintainer confirmation in verify-release-input.mjs.
/** Seal schema-v7 evidence from a frozen two-model-family owner review wave. */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
  OWNER_REVIEW_PROTOCOL,
  OWNER_REVIEW_SCOPES,
  OWNER_REVIEW_VERDICTS,
  RELEASE_REVIEW_ATTESTATION_ALGORITHM,
  RELEASE_REVIEW_MIN_PLAUSIBLE_MS,
  OWNER_REVIEW_PANEL,
  decodeReviewUtf8,
  hasExactKeys,
  pathIsWithin,
  releaseAttestationSigningBytes,
  validateFullGateEvidence,
  validateFullGateReceipt,
  validateOwnerReviewModelIdentity,
  validateReleaseAttestation,
} from "./lib/release-review-contract.mjs";
import { readPrivateSigningKey } from "./lib/private-signing-key.mjs";
import {
  readVerifiedReleaseReviewRuntime,
  releaseReviewRuntimeArtifactRoot,
} from "./lib/release-review-runtime.mjs";

const options = parseArgs(process.argv.slice(2));

try {
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }).trim();
  const candidateSha = git("rev-parse", "HEAD");
  const candidateTree = git("rev-parse", "HEAD^{tree}");
  const candidateRoot = realpathSync(git("rev-parse", "--show-toplevel"));
  const candidateVersion = parseJson(
    readStable(join(candidateRoot, "package.json"), "candidate package.json"),
    "candidate package.json",
  ).version;
  if (typeof candidateVersion !== "string" || candidateVersion.length === 0) {
    throw new Error("candidate package.json has no version");
  }
  if (git("status", "--porcelain=v1", "--untracked-files=all")) {
    throw new Error("candidate worktree is dirty; only a committed tree can be sealed");
  }

  const evidenceDir = realDirectory(options["evidence-dir"], "evidence directory");
  const artifactsDir = realDirectory(options["review-artifacts"], "review artifacts directory");
  if (
    pathIsWithin(candidateRoot, evidenceDir) ||
    pathIsWithin(candidateRoot, artifactsDir) ||
    pathsOverlap(evidenceDir, artifactsDir)
  ) {
    throw new Error("candidate, evidence and review artifacts must be separate directories");
  }
  const outputs = [options.out, options["base64-out"]]
    .filter(Boolean)
    .map((output) => canonicalFuturePath(output));
  if (new Set(outputs).size !== outputs.length) {
    throw new Error("attestation JSON and base64 outputs must be different paths");
  }
  for (const target of outputs) {
    if (
      pathIsWithin(candidateRoot, target) ||
      pathIsWithin(evidenceDir, target) ||
      pathIsWithin(artifactsDir, target) ||
      existsSync(target)
    ) {
      throw new Error("attestation output must be a new path outside candidate and evidence");
    }
  }

  const receiptPath = resolve(options["full-gate-receipt"]);
  const runtimeRoot = releaseReviewRuntimeArtifactRoot(receiptPath);
  if ([candidateRoot, evidenceDir, artifactsDir].some((root) => pathsOverlap(root, runtimeRoot))) {
    throw new Error(
      "full-gate receipt and review runtime artifacts must be external and non-overlapping",
    );
  }
  const receiptBytes = readStable(receiptPath, "full-gate receipt");
  const receipt = parseJson(receiptBytes, "full-gate receipt");
  const receiptReasons = validateFullGateReceipt(receipt, { candidateSha, candidateTree });
  if (receiptReasons.length > 0) throw new Error(receiptReasons.join("; "));
  const stdoutBytes = readReceiptLog(
    runtimeRoot,
    receipt.stdout.path,
    receipt.stdout.sha256,
    "full-gate stdout",
  );
  const stderrBytes = readReceiptLog(
    runtimeRoot,
    receipt.stderr.path,
    receipt.stderr.sha256,
    "full-gate stderr",
  );
  const runtime = readVerifiedReleaseReviewRuntime(runtimeRoot, receipt.reviewRuntimeArtifacts);
  const fullGate = {
    receiptSha256: sha256(receiptBytes),
    program: receipt.program,
    argv: receipt.argv,
    exitCode: receipt.exitCode,
    candidateUnchanged: receipt.candidateUnchanged,
    beforeSha: receipt.before?.head,
    beforeTree: receipt.before?.tree,
    afterSha: receipt.after?.head,
    afterTree: receipt.after?.tree,
    stdoutSha256: sha256(stdoutBytes),
    stderrSha256: sha256(stderrBytes),
  };
  const gateReasons = validateFullGateEvidence(fullGate, { candidateSha, candidateTree });
  if (gateReasons.length > 0) throw new Error(gateReasons.join("; "));

  // Execute only the full-gate receipt's verified, self-contained candidate
  // verifier bytes. Mutable workspace dist is never release authority.
  const verifierUrl = `data:text/javascript;base64,${runtime.verifierBytes.toString("base64")}`;
  const { verifySealedEvidencePacket } = await import(verifierUrl);

  const packet = verifySealedEvidencePacket({ evidenceDir, candidateSha, candidateTree });
  const freeze = parseJson(
    readStable(join(evidenceDir, "FREEZE.json"), "FREEZE.json"),
    "FREEZE.json",
  );
  if (!isUuidV4(freeze.waveId)) throw new Error("FREEZE.json has no UUID-v4 review wave");
  const actualDiff = execFileSync(
    "git",
    ["diff", "--binary", `${packet.baseSha}..${candidateSha}`],
    {
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  const packetDiff = readStable(join(evidenceDir, "DIFF.patch"), "sealed diff");
  if (!packetDiff.equals(actualDiff))
    throw new Error("DIFF.patch is not the exact base..candidate diff");
  const packetReceipt = readStable(
    join(evidenceDir, "context/gates/FULL_GATE_RECEIPT.json"),
    "packet full-gate receipt",
  );
  if (!packetReceipt.equals(receiptBytes)) {
    throw new Error("review packet did not contain the exact supplied full-gate receipt");
  }

  const reviewerEntries = readdirSync(artifactsDir, { withFileTypes: true }).filter((entry) =>
    /^\d{2}-/.test(entry.name),
  );
  if (
    reviewerEntries.length !== OWNER_REVIEW_PANEL.length ||
    reviewerEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())
  ) {
    throw new Error("review artifacts must contain exactly two real reviewer directories");
  }
  const artifacts = reviewerEntries.map((entry) =>
    readReviewerArtifact(realDirectory(join(artifactsDir, entry.name), `reviewer ${entry.name}`)),
  );
  const reviews = OWNER_REVIEW_PANEL.map((required) => {
    const matches = artifacts.filter((artifact) => artifact.metadata.slot === required.slot);
    if (matches.length !== 1)
      throw new Error(`expected exactly one ${required.slot} reviewer artifact`);
    return validateReviewerArtifact(matches[0], required, {
      candidateSha,
      candidateTree,
      manifestSha256: packet.manifestSha256,
      diffSha256: sha256(packetDiff),
      reviewWaveId: freeze.waveId,
    });
  });

  validateReviewerOverlap(reviews);

  const authority = parseJson(readStable(resolve(options.authority), "authority"), "authority");
  if (authority.algorithm !== RELEASE_REVIEW_ATTESTATION_ALGORITHM) {
    throw new Error("authority algorithm is not Ed25519");
  }
  const attestation = {
    schemaVersion: OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
    keyId: authority.keyId,
    algorithm: RELEASE_REVIEW_ATTESTATION_ALGORITHM,
    payload: {
      contract: "owner-review-v7",
      reviewProtocol: OWNER_REVIEW_PROTOCOL,
      candidateSha,
      candidateTree,
      candidateVersion,
      evidence: {
        manifestSha256: packet.manifestSha256,
        diffSha256: sha256(packetDiff),
        reviewWaveId: freeze.waveId,
      },
      fullGate,
      reviews,
      sealedAt: new Date().toISOString(),
    },
  };
  const key = createPrivateKey(readPrivateSigningKey(options["private-key"]));
  attestation.signature = sign(null, releaseAttestationSigningBytes(attestation), key).toString(
    "base64",
  );
  const verified = validateReleaseAttestation(attestation, authority, {
    candidateSha,
    candidateTree,
    candidateVersion,
  });
  if (!verified.ok) throw new Error(`self-verification failed: ${verified.reasons.join("; ")}`);

  const json = `${JSON.stringify(attestation, null, 2)}\n`;
  atomicWrite(outputs[0], json);
  if (options["base64-out"]) {
    atomicWrite(outputs[1], `${Buffer.from(json.trim()).toString("base64")}\n`);
  }
  console.log(`signed operator owner-review attestation sealed: ${options.out}`);
} catch (error) {
  console.error(
    `owner-review attestation refused: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

/** Reviewer sources are read exactly (INV-146): their text never enters the
 * attestation, only their digests and the validated metadata fields do. */
function readReviewerArtifact(dir) {
  const read = (name, label) => readArtifact(join(dir, name), label);
  const metadataBytes = read("metadata.json", "reviewer metadata");
  const reportBytes = read("report.md", "reviewer report");
  return {
    dir,
    metadata: parseJson(metadataBytes, "reviewer metadata"),
    metadataBytes,
    reportBytes,
  };
}

/** One operator reviewer artifact = markdown report + metadata binding the
 * declared approved model family, actual model and harness, exact ISO start/finish,
 * pass|warn verdict, the mandatory full review scope, and the report digest
 * to the exact sealed packet. The on-disk metadata is an exact-key shape: a
 * missing, extra, or unknown key refuses, so a contradictory field can never
 * be silently ignored (fail-closed on anything missing, malformed, or
 * mismatched). */
function validateReviewerArtifact(artifact, required, expected) {
  const metadata = artifact.metadata;
  if (
    !hasExactKeys(metadata, [
      "slot",
      "model_family",
      "model",
      "harness",
      "candidate_sha",
      "candidate_tree",
      "packet_manifest_sha256",
      "review_wave_id",
      "diff_sha256",
      "started_at",
      "completed_at",
      "verdict",
      "review_scope",
      "report_sha256",
    ])
  ) {
    throw new Error(`${required.slot} reviewer metadata shape is invalid`);
  }
  requireIdentity(metadata, expected, `${required.slot} reviewer metadata`);
  if (metadata.slot !== required.slot) {
    throw new Error(`${required.slot} metadata slot mismatch`);
  }
  const identityReasons = validateOwnerReviewModelIdentity({
    modelFamily: metadata.model_family,
    model: metadata.model,
    harness: metadata.harness,
  });
  if (identityReasons.length > 0) throw new Error(`${required.slot} ${identityReasons.join("; ")}`);
  if (!OWNER_REVIEW_VERDICTS.includes(metadata.verdict)) {
    throw new Error(
      `${required.slot} verdict ${JSON.stringify(metadata.verdict ?? null)} is not pass or warn`,
    );
  }
  if (!OWNER_REVIEW_SCOPES.includes(metadata.review_scope)) {
    throw new Error(
      `${required.slot} review scope ${JSON.stringify(metadata.review_scope ?? null)} is not full`,
    );
  }
  const startedMs = exactIsoMs(metadata.started_at, `${required.slot} started_at`);
  const completedMs = exactIsoMs(metadata.completed_at, `${required.slot} completed_at`);
  if (completedMs < startedMs || completedMs - startedMs < RELEASE_REVIEW_MIN_PLAUSIBLE_MS) {
    throw new Error(`${required.slot} reviewer timestamps are implausible`);
  }
  const reportSha256 = sha256(artifact.reportBytes);
  if (metadata.report_sha256 !== reportSha256) {
    throw new Error(`${required.slot} report digest does not match its metadata binding`);
  }
  return {
    slot: required.slot,
    modelFamily: metadata.model_family,
    model: metadata.model,
    harness: metadata.harness,
    startedAt: metadata.started_at,
    completedAt: metadata.completed_at,
    verdict: metadata.verdict,
    reviewScope: metadata.review_scope,
    reportSha256,
    metadataSha256: sha256(artifact.metadataBytes),
  };
}

function validateReviewerOverlap(reviews) {
  if (new Set(reviews.map((review) => review.modelFamily)).size !== reviews.length) {
    throw new Error("owner review model families must be distinct");
  }
  const starts = reviews.map((review) => exactIsoMs(review.startedAt, `${review.slot} start`));
  const completions = reviews.map((review) =>
    exactIsoMs(review.completedAt, `${review.slot} completion`),
  );
  if (Math.max(...starts) >= Math.min(...completions)) {
    throw new Error("operator reviewer executions did not overlap");
  }
  if (new Set(reviews.map((review) => review.reportSha256)).size !== reviews.length) {
    throw new Error("operator reviewer reports are not distinct");
  }
}

function requireIdentity(metadata, expected, label) {
  for (const [field, value] of [
    ["candidate_sha", expected.candidateSha],
    ["candidate_tree", expected.candidateTree],
    ["packet_manifest_sha256", expected.manifestSha256],
    ["review_wave_id", expected.reviewWaveId],
    ["diff_sha256", `sha256:${expected.diffSha256}`],
  ]) {
    if (metadata?.[field] !== value) throw new Error(`${label} ${field} mismatch`);
  }
}

function readArtifact(path, label) {
  const bytes = readStable(path, label);
  decodeReviewUtf8(bytes, label); // strict UTF-8, or the artifact refuses
  return bytes;
}

function readStable(path, label, allowEmpty = false) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} is not a regular file`);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      if (before[key] !== after[key]) throw new Error(`${label} changed while it was read`);
    }
    if ((!allowEmpty && bytes.length === 0) || BigInt(bytes.length) !== before.size) {
      throw new Error(`${label} has an invalid byte length`);
    }
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readReceiptLog(root, rawPath, expectedSha256, label) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error(`${label} path is missing from the full-gate receipt`);
  }
  const lexical = resolve(root, rawPath);
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a regular file`);
  const canonical = realpathSync(lexical);
  if (!pathIsWithin(root, canonical)) {
    throw new Error(`${label} escapes the full-gate receipt directory`);
  }
  const bytes = readStable(canonical, label, true);
  if (sha256(bytes) !== expectedSha256) {
    throw new Error(`${label} digest does not match the full-gate receipt`);
  }
  return bytes;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(decodeReviewUtf8(bytes, label));
  } catch (error) {
    throw new Error(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function realDirectory(path, label) {
  const lexical = resolve(path);
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`${label} must be a real directory`);
  return realpathSync(lexical);
}

function canonicalFuturePath(path) {
  const lexical = resolve(path);
  const parent = realDirectory(dirname(lexical), "attestation output directory");
  return join(parent, basename(lexical));
}

function exactIsoMs(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is not an exact ISO timestamp`);
  }
  const date = new Date(value);
  if (date.toISOString() !== value) throw new Error(`${label} is not an exact ISO timestamp`);
  return date.getTime();
}

function pathsOverlap(left, right) {
  return pathIsWithin(left, right) || pathIsWithin(right, left);
}

function isUuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? "");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function parseArgs(argv) {
  const required = [
    "full-gate-receipt",
    "evidence-dir",
    "review-artifacts",
    "private-key",
    "authority",
    "out",
  ];
  const allowed = new Set([...required, "base64-out"]);
  const parsed = {};
  if (argv.length % 2 !== 0) usage();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = flag?.startsWith("--") ? flag.slice(2) : "";
    if (!allowed.has(key) || parsed[key] !== undefined || !argv[index + 1]) usage();
    parsed[key] = argv[index + 1];
  }
  if (required.some((key) => !parsed[key])) usage();
  return parsed;
}

function usage() {
  console.error(
    "usage: seal-owner-review-attestation.mjs --full-gate-receipt FILE --evidence-dir DIR --review-artifacts DIR --private-key FILE --authority FILE --out FILE [--base64-out FILE]",
  );
  process.exit(2);
}
