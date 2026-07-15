/**
 * Pure, fail-closed contract for the cumulative release reviewer panel.
 * Transport and artifact persistence live in triad-scope-review.mjs; this
 * module owns the exact panel and response semantics so fixtures can exercise
 * them without network access.
 */

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

/**
 * Compact release authority. Publication accepts only the exact six-slot
 * reviewed panel bound to the checked-out SHA, tree and sealed packet digest.
 */
export function validateReleaseAttestation(attestation, expected) {
  const reasons = [];
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    return { ok: false, reasons: ["review attestation is not an object"] };
  }
  if (attestation.schemaVersion !== 1) reasons.push("review attestation schemaVersion must be 1");
  if (
    attestation.candidateSha !== expected.candidateSha ||
    !SHA1.test(attestation.candidateSha ?? "")
  ) {
    reasons.push("review attestation candidate SHA mismatch");
  }
  if (
    attestation.candidateTree !== expected.candidateTree ||
    !SHA1.test(attestation.candidateTree ?? "")
  ) {
    reasons.push("review attestation candidate tree mismatch");
  }
  if (!SHA256.test(attestation.packetManifestSha256 ?? "")) {
    reasons.push("review attestation packet manifest SHA-256 is missing or malformed");
  }
  const lock = validatePanelLock(attestation.panelLock ?? null, {
    candidateSha: expected.candidateSha,
    candidateTree: expected.candidateTree,
    packetManifestSha256: attestation.packetManifestSha256 ?? "",
  });
  reasons.push(...lock.reasons);

  const slots = Array.isArray(attestation.slots) ? attestation.slots : [];
  if (slots.length !== REQUIRED_RELEASE_REVIEW_SLOTS.length) {
    reasons.push(
      `review attestation must contain exactly ${REQUIRED_RELEASE_REVIEW_SLOTS.length} slots`,
    );
  } else {
    let responsiveTriad = 0;
    for (const required of REQUIRED_RELEASE_REVIEW_SLOTS) {
      const actual = slots.find((slot) => slot?.slot === required.slot);
      if (!actual) {
        reasons.push(`review slot ${required.slot} is missing`);
        continue;
      }
      const triad = required.slot.startsWith("triad-");
      if (actual.status === "responded" && triad) responsiveTriad += 1;
      if (!triad && actual.status !== "responded") {
        reasons.push(`review slot ${required.slot} did not respond`);
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
    }
    const unique = new Set(slots.map((slot) => slot?.slot));
    if (unique.size !== slots.length) reasons.push("review attestation contains duplicate slots");
    if (responsiveTriad < 2) {
      reasons.push(`review attestation triad quorum not met: ${responsiveTriad}/2`);
    }
  }
  if (attestation.decision !== "passed") reasons.push("review attestation decision is not passed");
  if (!Array.isArray(attestation.openBlockers) || attestation.openBlockers.length !== 0) {
    reasons.push("review attestation has open blockers");
  }
  return { ok: reasons.length === 0, reasons };
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

  const findings = [];
  for (const [index, entry] of items.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return invalidRow(index, requiredItems, "row is not an object");
    }
    const item = String(entry.item ?? "");
    const verdict = String(entry.verdict ?? "").toUpperCase();
    const severity = String(entry.severity ?? "").toLowerCase();
    const reason = String(entry.reason ?? "").trim();
    if (!requiredItems.includes(item)) {
      return invalidRow(index, requiredItems, `unknown checklist item '${item}'`);
    }
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
