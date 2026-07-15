import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  RELEASE_REVIEW_ATTESTATION_ALGORITHM,
  RELEASE_REVIEW_ATTESTATION_SCHEMA_VERSION,
  REQUIRED_RELEASE_REVIEW_SLOTS,
  REQUIRED_SCOPE_MODEL,
  REQUIRED_TRIAD_MODELS,
  SCOPE_ITEMS,
  TRIAD_ITEMS,
  canonicalJson,
  releaseAttestationSigningBytes,
  validatePanelLock,
  validateReleaseAttestation,
  validateReleaseAttestationPayload,
  validateChecklistResponse,
} from "./release-review-contract.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const TIER1_BLOCKING = new Set(["BLOCK", "FIX_FIRST", "NEEDS_HUMAN", "INSUFFICIENT_EVIDENCE"]);

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  assertRegularFile(path);
  return sha256Bytes(readFileSync(path));
}

function assertRegularFile(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`required review artifact is missing: ${path}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`review artifact is not a regular file: ${path}`);
  }
}

function readJson(path) {
  assertRegularFile(path);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`review artifact is not valid JSON: ${path}: ${String(error)}`);
  }
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function within(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export function verifyEvidenceManifest(packetDir) {
  const manifestPath = join(packetDir, "MANIFEST.sha256");
  assertRegularFile(manifestPath);
  const entries = [];
  const seen = new Set();
  for (const line of readFileSync(manifestPath, "utf8").trim().split("\n")) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    requireValue(match, `invalid evidence manifest row: ${line}`);
    const [, digest, name] = match;
    requireValue(!isAbsolute(name) && !name.includes("\\"), `unsafe evidence path: ${name}`);
    const path = join(packetDir, name);
    requireValue(within(packetDir, path), `unsafe evidence path: ${name}`);
    requireValue(!seen.has(name), `duplicate evidence manifest path: ${name}`);
    seen.add(name);
    const actual = sha256File(path);
    requireValue(actual === digest, `evidence digest mismatch: ${name}`);
    entries.push({ name, sha256: digest });
  }
  requireValue(entries.length > 0, "evidence manifest is empty");
  return {
    manifestSha256: sha256File(manifestPath),
    entries,
  };
}

function parsePanelLock(path) {
  assertRegularFile(path);
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf(":");
        requireValue(index > 0, `invalid panel lock row: ${line}`);
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

function artifactDigests(root, names) {
  const artifacts = names.map((name) => ({ name, sha256: sha256File(join(root, name)) }));
  return {
    artifacts,
    artifactManifestSha256: sha256Bytes(canonicalJson(artifacts)),
  };
}

function flattenFindings(value, out = []) {
  if (Array.isArray(value)) {
    for (const entry of value) flattenFindings(entry, out);
  } else if (value && typeof value === "object") {
    out.push(value);
  } else {
    throw new Error("review result contains a non-object finding");
  }
  return out;
}

function tier1Slot(root, required, index, expected) {
  const name = `${String(index + 1).padStart(2, "0")}-${required.route}`;
  const dir = join(root, name);
  const metadata = readJson(join(dir, "metadata.json"));
  requireValue(metadata.status === "completed", `${required.slot} is not terminal-completed`);
  requireValue(metadata.route_proof_status === "verified", `${required.slot} route is unverified`);
  requireValue(metadata.harness_id === required.route, `${required.slot} route mismatch`);
  requireValue(
    metadata.requested_model === required.model,
    `${required.slot} requested model mismatch`,
  );
  requireValue(
    metadata.observed_model === required.model,
    `${required.slot} observed model mismatch`,
  );
  requireValue(metadata.requested_effort === required.effort, `${required.slot} effort mismatch`);
  requireValue(metadata.candidate_sha === expected.candidateSha, `${required.slot} SHA mismatch`);
  requireValue(
    metadata.candidate_tree === expected.candidateTree,
    `${required.slot} tree mismatch`,
  );
  requireValue(
    metadata.packet_manifest_sha256 === expected.packetManifestSha256,
    `${required.slot} evidence digest mismatch`,
  );
  for (const field of ["start_time", "first_event_time", "completion_time"]) {
    requireValue(typeof metadata[field] === "string", `${required.slot} ${field} is missing`);
  }
  requireValue(Number.isFinite(metadata.duration_ms), `${required.slot} duration is missing`);
  const parsed = readJson(join(dir, "parsed-json-blocks.json"));
  requireValue(Array.isArray(parsed), `${required.slot} parsed result is not an array`);
  const findings = flattenFindings(parsed);
  const blockers = findings.filter((finding) => TIER1_BLOCKING.has(finding.severity));
  requireValue(blockers.length === 0, `${required.slot} has blocking or inconclusive findings`);
  const names = [
    "metadata.json",
    "parsed-json-blocks.json",
    "raw-normalized-stream.jsonl",
    "transcript.md",
    "prompt.md",
  ];
  const digests = artifactDigests(dir, names);
  return {
    slot: required.slot,
    route: required.route,
    requestedModel: required.model,
    observedModel: metadata.observed_model,
    effort: required.effort,
    status: "responded",
    result: "passed",
    telemetrySha256: sha256File(join(dir, "metadata.json")),
    resultSha256: sha256File(join(dir, "parsed-json-blocks.json")),
    ...digests,
  };
}

function triadSlot(root, required, metadataName, rawName, parsedName, requiredItems) {
  const metadata = readJson(join(root, metadataName));
  requireValue(
    metadata.requested_model === required.model,
    `${required.slot} requested model mismatch`,
  );
  requireValue(metadata.requested_effort === null, `${required.slot} effort mismatch`);
  const responded = metadata.status === "responded";
  if (responded) {
    requireValue(
      metadata.observed_model === required.model,
      `${required.slot} observed model mismatch`,
    );
    requireValue(metadata.finish_reason === "stop", `${required.slot} completion is not terminal`);
    for (const field of ["started_at", "first_event_at", "completed_at"]) {
      requireValue(typeof metadata[field] === "string", `${required.slot} ${field} is missing`);
    }
  }
  const resultName = responded
    ? parsedName
    : parsedName.replace("parsed-json-blocks", "parse-error");
  const result = readJson(join(root, resultName));
  requireValue(
    Array.isArray(result) || !responded,
    `${required.slot} parsed result is not an array`,
  );
  const validation = responded
    ? validateChecklistResponse(result, required.model, requiredItems)
    : null;
  requireValue(
    !responded || validation.status === "responded",
    `${required.slot} checklist incomplete`,
  );
  const findings = validation?.findings ?? [];
  requireValue(
    !responded || canonicalJson(metadata.findings) === canonicalJson(findings),
    `${required.slot} result differs from terminal telemetry`,
  );
  const critical = findings.filter(
    (finding) => finding.verdict === "FAIL" && finding.severity === "critical",
  );
  const names = [metadataName, rawName, resultName];
  const digests = artifactDigests(root, names);
  return {
    slot: required.slot,
    route: required.route,
    requestedModel: required.model,
    observedModel: metadata.observed_model ?? null,
    effort: null,
    status: responded ? "responded" : metadata.status,
    result: responded && critical.length === 0 ? "passed" : responded ? "failed" : "unavailable",
    telemetrySha256: sha256File(join(root, metadataName)),
    resultSha256: sha256File(join(root, resultName)),
    ...digests,
  };
}

function validateFullGate(receiptPath, testResults, expected) {
  const receiptSha256 = sha256File(receiptPath);
  requireValue(testResults.receiptSha256 === receiptSha256, "full-gate receipt digest mismatch");
  const receipt = readJson(receiptPath);
  requireValue(receipt.exitCode === 0, "full deterministic gate did not pass");
  requireValue(receipt.candidateUnchanged === true, "full deterministic gate changed candidate");
  for (const side of ["before", "after"]) {
    requireValue(receipt[side]?.head === expected.candidateSha, `full-gate ${side} SHA mismatch`);
    requireValue(receipt[side]?.tree === expected.candidateTree, `full-gate ${side} tree mismatch`);
    requireValue(receipt[side]?.status === "", `full-gate ${side} tree is dirty`);
  }
  requireValue(SHA256.test(receipt.stdout?.sha256 ?? ""), "full-gate stdout digest is missing");
  requireValue(SHA256.test(receipt.stderr?.sha256 ?? ""), "full-gate stderr digest is missing");
  requireValue(
    sha256File(receipt.stdout.path) === receipt.stdout.sha256,
    "full-gate stdout changed",
  );
  requireValue(
    sha256File(receipt.stderr.path) === receipt.stderr.sha256,
    "full-gate stderr changed",
  );
  return {
    receiptSha256,
    exitCode: 0,
    candidateUnchanged: true,
    beforeSha: receipt.before.head,
    beforeTree: receipt.before.tree,
    afterSha: receipt.after.head,
    afterTree: receipt.after.tree,
    stdoutSha256: receipt.stdout.sha256,
    stderrSha256: receipt.stderr.sha256,
  };
}

export function sealReleaseReviewAttestation(input) {
  const evidence = verifyEvidenceManifest(input.packetDir);
  requireValue(
    !input.packetManifestSha256 || input.packetManifestSha256 === evidence.manifestSha256,
    "packet manifest digest differs from expected digest",
  );
  const freeze = readJson(join(input.packetDir, "FREEZE.json"));
  const fingerprints = readJson(join(input.packetDir, "FINGERPRINTS.json"));
  const testResults = readJson(join(input.packetDir, "TEST_RESULTS.json"));
  const expected = {
    candidateSha: freeze.candidateSha,
    candidateTree: freeze.candidateTree,
    packetManifestSha256: evidence.manifestSha256,
  };
  requireValue(fingerprints.candidateSha === expected.candidateSha, "fingerprint SHA mismatch");
  requireValue(fingerprints.candidateTree === expected.candidateTree, "fingerprint tree mismatch");
  requireValue(testResults.exitCode === 0, "sealed TEST_RESULTS did not pass");
  requireValue(testResults.candidateUnchanged === true, "sealed TEST_RESULTS changed candidate");
  const fullGate = validateFullGate(input.fullGateReceipt, testResults, expected);

  const tier1Evidence = verifyEvidenceManifest(join(input.tier1Dir, "evidence"));
  requireValue(
    tier1Evidence.manifestSha256 === evidence.manifestSha256,
    "Tier 1 evidence copy does not match sealed packet",
  );
  const tier1ProgressSha256 = sha256File(join(input.tier1Dir, "reviewer-progress.jsonl"));
  const slots = REQUIRED_RELEASE_REVIEW_SLOTS.slice(0, 2).map((required, index) =>
    tier1Slot(input.tier1Dir, required, index, expected),
  );

  const summaryPath = join(input.triadDir, "summary.json");
  const summary = readJson(summaryPath);
  requireValue(summary.candidate_sha === expected.candidateSha, "triad summary SHA mismatch");
  requireValue(summary.candidate_tree === expected.candidateTree, "triad summary tree mismatch");
  requireValue(
    summary.packet_manifest_sha256 === evidence.manifestSha256,
    "triad summary evidence digest mismatch",
  );
  requireValue(
    JSON.stringify(summary.panel?.triad) === JSON.stringify(REQUIRED_TRIAD_MODELS) &&
      summary.panel?.scope === REQUIRED_SCOPE_MODEL,
    "triad summary panel mismatch",
  );
  requireValue(summary.decision?.passed === true, "review panel decision did not pass");
  requireValue(
    Array.isArray(summary.decision?.blockingFindings) &&
      summary.decision.blockingFindings.length === 0,
    "review panel has blocking findings",
  );
  const triadProgressSha256 = sha256File(join(input.triadDir, "reviewer-progress.jsonl"));
  for (const [index, model] of REQUIRED_TRIAD_MODELS.entries()) {
    const slug = model.replace(/[^a-z0-9.-]+/gi, "_");
    slots.push(
      triadSlot(
        input.triadDir,
        REQUIRED_RELEASE_REVIEW_SLOTS[index + 2],
        `triad-${slug}.metadata.json`,
        `triad-${slug}.raw.txt`,
        `triad-${slug}.parsed-json-blocks.json`,
        TRIAD_ITEMS,
      ),
    );
  }
  slots.push(
    triadSlot(
      input.triadDir,
      REQUIRED_RELEASE_REVIEW_SLOTS[5],
      "scope.metadata.json",
      "scope.raw.txt",
      "scope.parsed-json-blocks.json",
      SCOPE_ITEMS,
    ),
  );

  const responsiveTriad = slots
    .slice(2, 5)
    .filter((slot) => slot.status === "responded" && slot.result === "passed").length;
  requireValue(responsiveTriad >= 2, `review panel triad quorum not met: ${responsiveTriad}/2`);
  requireValue(
    slots[5].status === "responded" && slots[5].result === "passed",
    "scope reviewer did not pass",
  );
  const panelLock = parsePanelLock(input.panelLock);
  const lock = validatePanelLock(panelLock, expected);
  requireValue(lock.ok, lock.reasons.join("; "));
  const payload = {
    candidateSha: expected.candidateSha,
    candidateTree: expected.candidateTree,
    packetManifestSha256: evidence.manifestSha256,
    evidenceManifestSha256: evidence.manifestSha256,
    fullGate,
    panelLock,
    evidence: {
      files: evidence.entries,
      tier1ProgressSha256,
      triadProgressSha256,
      reviewDecisionSha256: sha256File(summaryPath),
    },
    slots,
    decision: {
      status: "passed",
      quorum: 2,
      responsiveTriad,
      blockingFindings: 0,
    },
    openBlockers: [],
  };
  const semantic = validateReleaseAttestationPayload(payload, expected);
  requireValue(semantic.ok, semantic.reasons.join("; "));

  const authority = readJson(input.authorityPath);
  requireValue(authority.algorithm === RELEASE_REVIEW_ATTESTATION_ALGORITHM, "authority mismatch");
  assertRegularFile(input.privateKeyPath);
  const privateKey = createPrivateKey(readFileSync(input.privateKeyPath));
  requireValue(privateKey.asymmetricKeyType === "ed25519", "release authority is not Ed25519");
  const pinned = createPublicKey(authority.publicKeyPem).export({ type: "spki", format: "der" });
  const derived = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  requireValue(
    Buffer.from(pinned).equals(Buffer.from(derived)),
    "private key does not match authority",
  );
  const attestation = {
    schemaVersion: RELEASE_REVIEW_ATTESTATION_SCHEMA_VERSION,
    keyId: authority.keyId,
    algorithm: RELEASE_REVIEW_ATTESTATION_ALGORITHM,
    payload,
    signature: "",
  };
  attestation.signature = sign(
    null,
    releaseAttestationSigningBytes(attestation),
    privateKey,
  ).toString("base64");
  const verified = validateReleaseAttestation(attestation, authority, expected);
  requireValue(verified.ok, verified.reasons.join("; "));
  return attestation;
}
