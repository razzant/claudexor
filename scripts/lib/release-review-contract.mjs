/**
 * Pure, fail-closed contract for the cumulative release reviewer panel.
 * Transport and artifact persistence live in triad-scope-review.mjs; this
 * module owns the exact panel and response semantics so fixtures can exercise
 * them without network access.
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import { relative, resolve, sep } from "node:path";

export const REQUIRED_TRIAD_MODELS = Object.freeze([
  "openai/gpt-5.6-sol",
  "anthropic/claude-fable-5",
  "google/gemini-3.5-flash",
]);

export const REQUIRED_SCOPE_MODEL = "anthropic/claude-fable-5";

export const REQUIRED_RELEASE_REVIEW_SLOTS = Object.freeze([
  Object.freeze({ slot: "tier1-codex", route: "codex", model: "gpt-5.6-sol", effort: "xhigh" }),
  Object.freeze({ slot: "tier1-claude", route: "claude", model: "claude-fable-5", effort: "max" }),
  ...REQUIRED_TRIAD_MODELS.map((model, index) =>
    Object.freeze({ slot: `triad-${index + 1}`, route: "openrouter", model, effort: null }),
  ),
  Object.freeze({ slot: "scope", route: "openrouter", model: REQUIRED_SCOPE_MODEL, effort: null }),
]);

export const RELEASE_NATIVE_CHECKLIST_ITEMS = Object.freeze([
  "sealed_evidence",
  "intent_and_scope",
  "runtime_and_security",
  "tests_and_release",
]);

export const MAX_RELEASE_REVIEW_START_SKEW_MS = 10_000;

export const TRIAD_ITEMS = Object.freeze([
  "review_protocol",
  "runtime_behavior_changes",
  "security_and_secrets",
]);

export const SCOPE_ITEMS = Object.freeze([
  "intent_alignment",
  "forgotten_touchpoints",
  "cross_surface_consistency",
  "regression_surface",
  "prompt_doc_sync",
  "architecture_fit",
  "cross_module_bugs",
  "implicit_contracts",
]);

export function exactPanelMatch(triadModels, scopeModel) {
  return (
    Array.isArray(triadModels) &&
    triadModels.length === REQUIRED_TRIAD_MODELS.length &&
    triadModels.every((model, index) => model === REQUIRED_TRIAD_MODELS[index]) &&
    scopeModel === REQUIRED_SCOPE_MODEL
  );
}

/** Canonical external lock for one exact frozen reviewer panel. */
export function panelLockText({ candidateSha, candidateTree, packetManifestSha256 }) {
  return [
    `triad: ${REQUIRED_TRIAD_MODELS.join(",")}`,
    `scope: ${REQUIRED_SCOPE_MODEL}`,
    `candidate_sha: ${candidateSha}`,
    `candidate_tree: ${candidateTree}`,
    `packet_manifest_sha256: ${packetManifestSha256}`,
    "",
  ].join("\n");
}

/** A release review may start only with a pre-created lock bound to its freeze. */
export function validatePanelLock(lock, { candidateSha, candidateTree, packetManifestSha256 }) {
  const reasons = [];
  if (!lock) return { ok: false, reasons: ["panel lock is missing"] };
  if (lock.triad?.trim() !== REQUIRED_TRIAD_MODELS.join(",")) {
    reasons.push("triad panel does not match the exact ordered release panel");
  }
  if (lock.scope?.trim() !== REQUIRED_SCOPE_MODEL) {
    reasons.push("scope reviewer does not match the exact release model");
  }
  if (lock.candidate_sha?.trim() !== candidateSha) reasons.push("candidate SHA is not locked");
  if (lock.candidate_tree?.trim() !== candidateTree) reasons.push("candidate tree is not locked");
  if (lock.packet_manifest_sha256?.trim() !== packetManifestSha256) {
    reasons.push("packet manifest digest is not locked");
  }
  return { ok: reasons.length === 0, reasons };
}

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const RELEASE_REVIEW_ATTESTATION_SCHEMA_VERSION = 2;
export const RELEASE_REVIEW_ATTESTATION_ALGORITHM = "Ed25519";

/** Validate the only two release workflow entry modes before any ref is fetched. */
export function validateReleaseInput(mode, ref) {
  const reasons = [];
  if (mode !== "candidate" && mode !== "publish") reasons.push("mode must be candidate or publish");
  if (mode === "candidate" && !SHA1.test(ref)) {
    reasons.push("candidate ref must be a full lowercase 40-character commit SHA");
  }
  if (mode === "publish" && !SEMVER_TAG.test(ref)) {
    reasons.push("publish ref must be an exact stable vMAJOR.MINOR.PATCH tag");
  }
  return { ok: reasons.length === 0, reasons };
}

/** Stable JSON is the byte contract signed by the offline review authority. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function releaseAttestationSigningBytes(attestation) {
  return Buffer.from(
    canonicalJson({
      schemaVersion: attestation.schemaVersion,
      keyId: attestation.keyId,
      algorithm: attestation.algorithm,
      payload: attestation.payload,
    }),
    "utf8",
  );
}

export function releaseReviewConcurrencyDigest(concurrency) {
  const { evidenceSha256: _evidenceSha256, ...evidence } = concurrency ?? {};
  return createHash("sha256").update(canonicalJson(evidence)).digest("hex");
}

/** Verify authority before trusting any caller-supplied review semantics. */
export function verifyReleaseAttestationSignature(attestation, authority) {
  const reasons = [];
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    return { ok: false, reasons: ["review attestation is not an object"] };
  }
  if (attestation.schemaVersion !== RELEASE_REVIEW_ATTESTATION_SCHEMA_VERSION) {
    reasons.push(
      `review attestation schemaVersion must be ${RELEASE_REVIEW_ATTESTATION_SCHEMA_VERSION}`,
    );
  }
  if (!authority || typeof authority !== "object") {
    reasons.push("review attestation authority is missing");
  } else if (attestation.keyId !== authority.keyId) {
    reasons.push("review attestation keyId is unknown");
  }
  if (attestation.algorithm !== RELEASE_REVIEW_ATTESTATION_ALGORITHM) {
    reasons.push(`review attestation algorithm must be ${RELEASE_REVIEW_ATTESTATION_ALGORITHM}`);
  }
  if (!attestation.payload || typeof attestation.payload !== "object") {
    reasons.push("review attestation payload is missing");
  }
  if (typeof attestation.signature !== "string" || !BASE64.test(attestation.signature)) {
    reasons.push("review attestation signature is missing or malformed");
  }
  if (reasons.length > 0) return { ok: false, reasons };
  try {
    const key = createPublicKey(authority.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") {
      return { ok: false, reasons: ["review attestation authority is not an Ed25519 key"] };
    }
    const signature = Buffer.from(attestation.signature, "base64");
    if (
      signature.length !== 64 ||
      !verify(null, releaseAttestationSigningBytes(attestation), key, signature)
    ) {
      return { ok: false, reasons: ["review attestation signature is invalid"] };
    }
  } catch {
    return { ok: false, reasons: ["review attestation signature is invalid"] };
  }
  return { ok: true, reasons: [] };
}

/**
 * Semantic validation runs only after signature verification. Publication
 * accepts the exact reviewed SHA/tree, sealed evidence, full gate, and panel.
 */
export function validateReleaseAttestationPayload(payload, expected) {
  const reasons = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reasons: ["review attestation payload is not an object"] };
  }
  if (payload.candidateSha !== expected.candidateSha || !SHA1.test(payload.candidateSha ?? "")) {
    reasons.push("review attestation candidate SHA mismatch");
  }
  if (payload.candidateTree !== expected.candidateTree || !SHA1.test(payload.candidateTree ?? "")) {
    reasons.push("review attestation candidate tree mismatch");
  }
  if (!SHA256.test(payload.packetManifestSha256 ?? "")) {
    reasons.push("review attestation packet manifest SHA-256 is missing or malformed");
  }
  if (
    payload.evidenceManifestSha256 !== payload.packetManifestSha256 ||
    !SHA256.test(payload.evidenceManifestSha256 ?? "")
  ) {
    reasons.push("review attestation evidence manifest digest mismatch");
  }
  const gate = payload.fullGate;
  if (
    !gate ||
    !SHA256.test(gate.receiptSha256 ?? "") ||
    gate.program !== "pnpm" ||
    canonicalJson(gate.argv) !== canonicalJson(["pnpm", "release:verify"]) ||
    gate.exitCode !== 0 ||
    gate.candidateUnchanged !== true ||
    gate.beforeSha !== expected.candidateSha ||
    gate.afterSha !== expected.candidateSha ||
    gate.beforeTree !== expected.candidateTree ||
    gate.afterTree !== expected.candidateTree ||
    !SHA256.test(gate.stdoutSha256 ?? "") ||
    !SHA256.test(gate.stderrSha256 ?? "")
  ) {
    reasons.push("review attestation full deterministic gate is invalid");
  }
  const lock = validatePanelLock(payload.panelLock ?? null, {
    candidateSha: expected.candidateSha,
    candidateTree: expected.candidateTree,
    packetManifestSha256: payload.packetManifestSha256 ?? "",
  });
  reasons.push(...lock.reasons);

  const slots = Array.isArray(payload.slots) ? payload.slots : [];
  let responsiveTriad = 0;
  if (slots.length !== REQUIRED_RELEASE_REVIEW_SLOTS.length) {
    reasons.push(
      `review attestation must contain exactly ${REQUIRED_RELEASE_REVIEW_SLOTS.length} slots`,
    );
  } else {
    for (const required of REQUIRED_RELEASE_REVIEW_SLOTS) {
      const actual = slots.find((slot) => slot?.slot === required.slot);
      if (!actual) {
        reasons.push(`review slot ${required.slot} is missing`);
        continue;
      }
      const triad = required.slot.startsWith("triad-");
      if (actual.status === "responded" && actual.result === "passed" && triad) {
        responsiveTriad += 1;
      }
      if (!triad && (actual.status !== "responded" || actual.result !== "passed")) {
        reasons.push(`review slot ${required.slot} did not pass`);
      }
      if (
        actual.route !== required.route ||
        actual.requestedModel !== required.model ||
        (actual.status === "responded" && actual.observedModel !== required.model) ||
        (actual.observedModel && actual.observedModel !== required.model)
      ) {
        reasons.push(`review slot ${required.slot} model mismatch`);
      }
      if (required.effort && actual.effort !== required.effort)
        reasons.push(`review slot ${required.slot} effort mismatch`);
      if (
        !SHA256.test(actual.telemetrySha256 ?? "") ||
        !SHA256.test(actual.resultSha256 ?? "") ||
        !SHA256.test(actual.artifactManifestSha256 ?? "") ||
        !Array.isArray(actual.artifacts) ||
        actual.artifacts.length === 0 ||
        actual.artifacts.some(
          (artifact) =>
            !artifact || typeof artifact.name !== "string" || !SHA256.test(artifact.sha256 ?? ""),
        )
      ) {
        reasons.push(`review slot ${required.slot} artifact digests are invalid`);
      }
    }
    const unique = new Set(slots.map((slot) => slot?.slot));
    if (unique.size !== slots.length) reasons.push("review attestation contains duplicate slots");
    if (responsiveTriad < 2) {
      reasons.push(`review attestation triad quorum not met: ${responsiveTriad}/2`);
    }
  }
  if (
    payload.decision?.status !== "passed" ||
    payload.decision?.quorum !== 2 ||
    payload.decision?.responsiveTriad !== responsiveTriad ||
    payload.decision?.blockingFindings !== 0
  ) {
    reasons.push("review attestation decision is not passed");
  }
  const concurrency = payload.concurrency;
  if (!concurrency || typeof concurrency !== "object" || Array.isArray(concurrency)) {
    reasons.push("review attestation concurrency evidence is missing");
  } else {
    const starts = Array.isArray(concurrency.slots) ? concurrency.slots : [];
    const startTimes = starts.map((entry) => Date.parse(entry?.startedAt ?? ""));
    const firstStart = Date.parse(concurrency.firstStartAt ?? "");
    const lastStart = Date.parse(concurrency.lastStartAt ?? "");
    const firstCompletion = Date.parse(concurrency.firstCompletionAt ?? "");
    if (
      !UUID_V4.test(concurrency.reviewWaveId ?? "") ||
      typeof concurrency.reviewRunId !== "string" ||
      concurrency.reviewRunId.length === 0 ||
      !SHA256.test(concurrency.promptSha256?.triad ?? "") ||
      !SHA256.test(concurrency.promptSha256?.scope ?? "") ||
      concurrency.maxStartSkewMs !== MAX_RELEASE_REVIEW_START_SKEW_MS ||
      !Number.isFinite(concurrency.observedStartSkewMs) ||
      concurrency.observedStartSkewMs < 0 ||
      concurrency.observedStartSkewMs > MAX_RELEASE_REVIEW_START_SKEW_MS ||
      starts.length !== REQUIRED_RELEASE_REVIEW_SLOTS.length ||
      starts.some(
        (entry, index) =>
          entry?.slot !== REQUIRED_RELEASE_REVIEW_SLOTS[index]?.slot ||
          !Number.isFinite(startTimes[index]),
      ) ||
      !Number.isFinite(firstStart) ||
      !Number.isFinite(lastStart) ||
      !Number.isFinite(firstCompletion) ||
      Math.min(...startTimes) !== firstStart ||
      Math.max(...startTimes) !== lastStart ||
      lastStart - firstStart !== concurrency.observedStartSkewMs ||
      lastStart >= firstCompletion ||
      !SHA256.test(concurrency.tier1ProgressSha256 ?? "") ||
      !SHA256.test(concurrency.triadProgressSha256 ?? "") ||
      payload.evidence?.tier1ProgressSha256 !== concurrency.tier1ProgressSha256 ||
      payload.evidence?.triadProgressSha256 !== concurrency.triadProgressSha256 ||
      !SHA256.test(concurrency.evidenceSha256 ?? "") ||
      releaseReviewConcurrencyDigest(concurrency) !== concurrency.evidenceSha256
    ) {
      reasons.push("review attestation concurrency evidence is invalid");
    }
  }
  if (!Array.isArray(payload.openBlockers) || payload.openBlockers.length !== 0) {
    reasons.push("review attestation has open blockers");
  }
  return { ok: reasons.length === 0, reasons };
}

export function validateReleaseAttestation(attestation, authority, expected) {
  const signature = verifyReleaseAttestationSignature(attestation, authority);
  if (!signature.ok) return signature;
  return validateReleaseAttestationPayload(attestation.payload, expected);
}

export function pathIsWithin(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function validateNewReviewOutput(candidateRoot, packetRoot, outDir, exists) {
  const reasons = [];
  if (pathIsWithin(candidateRoot, outDir)) reasons.push("review output is inside candidate");
  if (pathIsWithin(packetRoot, outDir)) reasons.push("review output is inside sealed packet");
  if (exists) reasons.push("review output already exists");
  return { ok: reasons.length === 0, reasons };
}

export function validateFrozenReviewBinding(input) {
  const reasons = [];
  for (const [label, expected, actual] of [
    ["candidate SHA", input.candidateSha, input.actualSha],
    ["candidate tree", input.candidateTree, input.actualTree],
  ]) {
    if (expected !== actual) reasons.push(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
  if (input.dirty) reasons.push("candidate worktree is dirty");
  return { ok: reasons.length === 0, reasons };
}

/** Build changed-file context from committed Git objects, never live paths. */
export function buildTouchedFilePack(paths, git, maxFileBytes, maxPackBytes) {
  let total = 0;
  const out = [];
  const omitted = [];
  for (const path of paths) {
    let text;
    try {
      text = git(["show", `HEAD:${path}`]);
    } catch {
      out.push(`### ${path}\n\n(deleted by this diff)`);
      continue;
    }
    if (text.length > maxFileBytes) {
      omitted.push(`${path} (${text.length}B > per-file cap; review via diff)`);
      continue;
    }
    if (total + text.length > maxPackBytes) {
      omitted.push(`${path} (pack budget reached)`);
      continue;
    }
    total += text.length;
    out.push(`### ${path}\n\n\`\`\`\n${text}\n\`\`\``);
  }
  let pack = out.join("\n\n");
  if (omitted.length > 0) {
    pack += `\n\n⚠️ OMISSION NOTE: ${omitted.length} file(s) omitted from direct context: ${omitted.join(", ")}`;
  }
  return pack || "(no touched files could be read)";
}

export function completionTermination(finishReason) {
  return finishReason === "stop"
    ? { complete: true, error: null }
    : {
        complete: false,
        error: `review completion is truncated or non-terminal (finish_reason=${String(finishReason)})`,
      };
}

/** Parse only the complete reviewer response; one exact JSON fence is tolerated. */
export function parseChecklistJson(raw) {
  const text = String(raw ?? "").trim();
  const fenced = text.startsWith("```json\n") && text.endsWith("\n```");
  const json = fenced ? text.slice("```json\n".length, -"\n```".length).trim() : text;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate one reviewer's complete checklist response. Invalid rows are never
 * discarded: one malformed/unknown row makes the entire slot unusable.
 */
export function validateChecklistResponse(items, model, requiredItems) {
  if (!Array.isArray(items)) {
    return {
      status: "parse_failure",
      findings: [],
      missingItems: [...requiredItems],
      error: "reviewer output is not a JSON array",
    };
  }
  if (items.length === 0) {
    return {
      status: "empty_response",
      findings: [],
      missingItems: [...requiredItems],
      error: "reviewer returned an empty checklist",
    };
  }
  if (items.length > requiredItems.length) {
    return invalidRow(requiredItems.length, requiredItems, "checklist has extra rows");
  }

  const findings = [];
  const seenItems = new Set();
  for (const [index, entry] of items.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return invalidRow(index, requiredItems, "row is not an object");
    }
    const keys = Object.keys(entry).sort();
    const expectedKeys = ["item", "reason", "severity", "verdict"];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])
    ) {
      return invalidRow(index, requiredItems, "row has unsupported fields");
    }
    const item = String(entry.item ?? "");
    const verdict = String(entry.verdict ?? "").toUpperCase();
    const severity = String(entry.severity ?? "").toLowerCase();
    const reason = String(entry.reason ?? "").trim();
    if (!requiredItems.includes(item)) {
      return invalidRow(index, requiredItems, `unknown checklist item '${item}'`);
    }
    if (seenItems.has(item)) {
      return invalidRow(index, requiredItems, `duplicate checklist item '${item}'`);
    }
    seenItems.add(item);
    if (verdict !== "PASS" && verdict !== "FAIL") {
      return invalidRow(index, requiredItems, `invalid verdict '${verdict}'`);
    }
    if (severity !== "critical" && severity !== "advisory") {
      return invalidRow(index, requiredItems, `invalid severity '${severity}'`);
    }
    if (!reason) {
      return invalidRow(index, requiredItems, "reason is empty");
    }
    findings.push({ item, verdict, severity, reason, model });
  }

  const covered = new Set(findings.map((finding) => finding.item));
  const missingItems = requiredItems.filter((item) => !covered.has(item));
  return {
    status: missingItems.length === 0 ? "responded" : "partial",
    findings,
    missingItems,
    error: missingItems.length === 0 ? null : `missing checklist items: ${missingItems.join(", ")}`,
  };
}

function invalidRow(index, requiredItems, detail) {
  return {
    status: "parse_failure",
    findings: [],
    missingItems: [...requiredItems],
    error: `invalid reviewer row ${index}: ${detail}`,
  };
}

export function blockingFindings(findings) {
  return findings.filter(
    (finding) => finding.verdict === "FAIL" && finding.severity === "critical",
  );
}

export function releaseReviewDecision({ triadActors, scope, quorum = 2 }) {
  const responsiveTriad = triadActors.filter((actor) => actor.status === "responded");
  const allFindings = [
    ...responsiveTriad.flatMap((actor) => actor.findings ?? []),
    ...(scope?.status === "responded" ? (scope.findings ?? []) : []),
  ];
  const failures = blockingFindings(allFindings);
  const reasons = [];
  if (responsiveTriad.length < quorum) {
    reasons.push(`triad quorum not met: ${responsiveTriad.length}/${quorum}`);
  }
  if (!scope) {
    reasons.push("scope reviewer is missing");
  } else if (scope.status !== "responded") {
    reasons.push(`scope reviewer status is ${scope.status}`);
  }
  if (failures.length > 0) {
    reasons.push(`reviewers returned ${failures.length} critical FAIL verdict(s)`);
  }
  return {
    passed: reasons.length === 0,
    responsiveTriad: responsiveTriad.length,
    blockingFindings: failures,
    reasons,
  };
}
