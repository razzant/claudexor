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

/**
 * The exact panel slots a sealed owner-review attestation must bind. The sealed
 * `reviews[]` carries one entry per panel slot, each with a `panel: {slot,
 * model}` identity and its report digest; extra internal-critic reviews may ride
 * along WITHOUT a `panel` field. Coverage is exact: the three frozen triad
 * models (each once) plus exactly one scope slot for the frozen scope model
 * (which equals a triad model, so the slot tag — not the model alone —
 * distinguishes it). This binds the digests of the precise triad+scope panel
 * into the signature, not merely a >=2 structural floor.
 */
const SUB_WAVE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Distinct sub-wave keys named by the sealed panel slots. A single-wave seal
 * uses no `subWave` field and yields the one anonymous key `""`; a packet-split
 * seal names each sub-wave, and EVERY named group must bind its own full
 * triad+scope panel (validated per group below).
 */
export function panelSubWaves(reviews) {
  const keys = new Set();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const panel = review?.panel;
    if (panel === undefined || panel === null) continue;
    keys.add(typeof panel?.subWave === "string" ? panel.subWave : "");
  }
  return keys;
}

export function validateReviewPanelCoverage(reviews) {
  const reasons = [];
  const list = Array.isArray(reviews) ? reviews : [];
  /** subWave key ("" = single wave) -> {triadModels, scopeModels} */
  const groups = new Map();
  const slotGroup = (key) => {
    if (!groups.has(key)) groups.set(key, { triadModels: [], scopeModels: [] });
    return groups.get(key);
  };
  for (const review of list) {
    const panel = review?.panel;
    // An extra reviewer (e.g. an internal critic) carries no panel slot; it is
    // counted only by the >=2 floor, never toward panel coverage.
    if (panel === undefined || panel === null) continue;
    if (
      typeof panel !== "object" ||
      Array.isArray(panel) ||
      (panel.slot !== "triad" && panel.slot !== "scope")
    ) {
      reasons.push("owner review panel slot must be 'triad' or 'scope'");
      continue;
    }
    if (typeof panel.model !== "string" || panel.model.length === 0) {
      reasons.push(`owner review panel ${panel.slot} slot is missing a model id`);
      continue;
    }
    if (panel.subWave !== undefined && !SUB_WAVE_NAME.test(panel.subWave ?? "")) {
      reasons.push(
        `owner review panel sub-wave name must match ${SUB_WAVE_NAME}; got "${panel.subWave}"`,
      );
      continue;
    }
    if (!SHA256.test(review?.reportSha256 ?? "")) {
      reasons.push(
        `owner review panel slot ${panel.slot}/${panel.model} is missing a report digest`,
      );
    }
    const group = slotGroup(typeof panel.subWave === "string" ? panel.subWave : "");
    if (panel.slot === "triad") group.triadModels.push(panel.model);
    else group.scopeModels.push(panel.model);
  }
  // A packet-split seal must not mix anonymous and named slots: either ONE
  // anonymous full panel, or N named sub-waves EACH carrying a full panel.
  if (groups.size > 1 && groups.has("")) {
    reasons.push(
      "owner review attestation mixes sub-wave-named and anonymous panel slots; name every sub-wave",
    );
  }
  if (groups.size === 0) groups.set("", { triadModels: [], scopeModels: [] });
  const requiredTriadSorted = [...REQUIRED_TRIAD_MODELS].sort();
  for (const [key, group] of groups) {
    const label = key === "" ? "" : ` (sub-wave ${key})`;
    const sortedTriad = [...group.triadModels].sort();
    if (
      group.triadModels.length !== REQUIRED_TRIAD_MODELS.length ||
      sortedTriad.some((model, index) => model !== requiredTriadSorted[index])
    ) {
      reasons.push(
        `owner review attestation must bind the exact triad panel${label} [${REQUIRED_TRIAD_MODELS.join(", ")}]; got [${group.triadModels.join(", ")}]`,
      );
    }
    if (group.scopeModels.length !== 1 || group.scopeModels[0] !== REQUIRED_SCOPE_MODEL) {
      reasons.push(
        `owner review attestation must bind exactly one scope slot${label} for ${REQUIRED_SCOPE_MODEL}; got [${group.scopeModels.join(", ")}]`,
      );
    }
  }
  return reasons;
}

/**
 * Re-derive a slot's verdict from its RAW report text (gate-8): the sealer
 * must never trust the record's mutable verdict claim — the raw bytes are
 * digest-bound, so parsing THEM is tamper-evident. Returns the same ladder
 * the wave transport derives: error (unparseable/incomplete), blocked (any
 * critical FAIL), warn (any FAIL), pass.
 */
export function deriveSlotVerdict(rawText, panelSlot) {
  const items = panelSlot === "scope" ? SCOPE_ITEMS : TRIAD_ITEMS;
  const arr = parseChecklistJson(rawText);
  if (arr === null) return "error";
  const validation = validateChecklistResponse(arr, "(seal-recheck)", items);
  if (validation.status !== "responded") return "error";
  const findings = validation.findings;
  if (findings.some((f) => f.verdict === "FAIL" && f.severity === "critical")) return "blocked";
  if (findings.some((f) => f.verdict === "FAIL")) return "warn";
  return "pass";
}

/**
 * Typed slot-attestation record validation (gate-6): the sealer derives panel
 * identity from the wave transport's metadata records and REFUSES anything a
 * caller could forge — status/liveness, derived verdict, candidate/tree
 * binding, observed==requested==recorded model, membership in the frozen
 * panel for the claimed slot, wave-id consistency, and the sealed-packet
 * manifest binding. The report-digest disk recompute stays in the sealer
 * (filesystem); everything checkable from the record alone lives here.
 */
export function validateSlotRecord(record, expected) {
  const reasons = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return ["slot record is not an object"];
  }
  if (record.status !== "responded" || record.error) {
    reasons.push(`slot is not a live responded review (status ${record.status ?? "(missing)"})`);
  }
  if (record.live !== true) {
    reasons.push("slot record carries no wave liveness verdict (live !== true)");
  }
  if (!Number.isFinite(record.duration_ms) || record.duration_ms <= 0) {
    reasons.push("slot record duration is missing or implausible");
  } else if (
    Number.isFinite(record.liveness_floor_ms) &&
    record.duration_ms < record.liveness_floor_ms
  ) {
    reasons.push(
      `slot duration ${record.duration_ms}ms is below its own recorded liveness floor ${record.liveness_floor_ms}ms`,
    );
  }
  if (!["pass", "warn"].includes(record.verdict)) {
    reasons.push(`derived verdict "${record.verdict}" cannot seal`);
  }
  if (
    record.candidateSha !== expected.candidateSha ||
    record.candidateTree !== expected.candidateTree
  ) {
    reasons.push("slot record is bound to a different candidate/tree than the sealed one");
  }
  if (
    !record.observed_model ||
    record.observed_model !== record.requested_model ||
    record.model_id !== record.observed_model
  ) {
    reasons.push(
      `slot record models do not agree (model_id ${record.model_id}, requested ${record.requested_model}, observed ${record.observed_model})`,
    );
  }
  if (record.panel_slot === "triad") {
    if (!REQUIRED_TRIAD_MODELS.includes(record.model_id)) {
      reasons.push(`"${record.model_id}" is not a frozen triad panel model`);
    }
  } else if (record.panel_slot === "scope") {
    if (record.model_id !== REQUIRED_SCOPE_MODEL) {
      reasons.push(`"${record.model_id}" is not the frozen scope model`);
    }
  } else {
    reasons.push("panel_slot must be triad|scope");
  }
  if (!SHA256.test(record.report_sha256 ?? "")) {
    reasons.push("slot record is missing its report digest");
  }
  if (!SHA256.test(record.promptSha256 ?? "")) {
    reasons.push("slot record is missing its prompt digest");
  }
  if (
    expected.packetManifestSha256 &&
    record.packetManifestSha256 !== expected.packetManifestSha256
  ) {
    reasons.push("slot record reviewed a different sealed packet");
  }
  if (expected.waveId && record.reviewWaveId !== expected.waveId) {
    reasons.push(`slot record mixes wave ${record.reviewWaveId} into wave ${expected.waveId}`);
  }
  return reasons;
}

/**
 * Candidate-bound full-text coverage receipt (audit A-8): the JSON emitted by
 * review-coverage-check --receipt, embedded into the sealed payload. Required
 * whenever the panel is packet-split (more than one named sub-wave) — it is
 * the only artifact proving the UNION of the sub-wave packs covered every
 * changed file, so a seal listing one sub-wave cannot silently omit the rest.
 */
export function validateCoverageReceipt(receipt, expected, { required, namedSubWaves = [] }) {
  const reasons = [];
  if (receipt === undefined || receipt === null) {
    if (required) {
      reasons.push(
        "packet-split owner review attestation requires a coverageReceipt binding the union of sub-wave packs",
      );
    }
    return reasons;
  }
  if (typeof receipt !== "object" || Array.isArray(receipt)) {
    return ["owner review coverageReceipt is not an object"];
  }
  if (receipt.ok !== true) reasons.push("owner review coverageReceipt did not pass (ok !== true)");
  if (!SHA1.test(receipt.base ?? "")) {
    reasons.push("owner review coverageReceipt is missing a full base SHA");
  }
  if (receipt.candidate !== expected.candidateSha || !SHA1.test(receipt.candidate ?? "")) {
    reasons.push("owner review coverageReceipt candidate SHA mismatch");
  }
  if (!SHA256.test(receipt.receiptSha256 ?? "")) {
    reasons.push("owner review coverageReceipt is missing the receipt file digest");
  }
  const packs = Array.isArray(receipt.packs) ? receipt.packs : [];
  if (
    packs.length === 0 ||
    packs.some((pack) => !SHA256.test(pack?.sha256 ?? "") || typeof pack?.subWave !== "string")
  ) {
    reasons.push(
      "owner review coverageReceipt must map every reviewed pack's sub-wave name to its SHA-256",
    );
  }
  // One pack per label: duplicate sub-wave labels make the slot↔pack binding
  // ambiguous (two different pack digests could each claim the same slots).
  const labels = packs.map((pack) => pack?.subWave).filter((label) => typeof label === "string");
  if (new Set(labels).size !== labels.length) {
    reasons.push("owner review coverageReceipt lists duplicate sub-wave labels");
  }
  // The receipt's sub-wave labels must EQUAL the panel's named sub-waves in
  // both directions: a slot reviewing an unlisted pack, or a listed pack no
  // slot reviewed, means reviewer reports and coverage proof describe
  // DIFFERENT prompts (the report/receipt swap sol flagged).
  if (namedSubWaves.length > 0 && packs.length > 0) {
    const receiptWaves = new Set(packs.map((pack) => pack.subWave));
    for (const name of namedSubWaves) {
      if (!receiptWaves.has(name)) {
        reasons.push(`owner review coverageReceipt lists no pack for panel sub-wave "${name}"`);
      }
    }
    for (const name of receiptWaves) {
      if (!namedSubWaves.includes(name)) {
        reasons.push(`owner review coverageReceipt pack sub-wave "${name}" has no panel slots`);
      }
    }
  }
  return reasons;
}

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
export const RELEASE_REVIEW_ATTESTATION_ALGORITHM = "Ed25519";

// Owner-review attestation (schemaVersion 3): the signed publishing proof.
// The retired schemaVersion-2 six-slot contract was removed in v3.0.0;
// already-sealed v2 artifacts remain archived with valid signatures, but
// the publish workflow no longer accepts them as input.
export const OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION = 4;
export const OWNER_REVIEW_PROTOCOL = "owner-fable-subagents-v1";
export const OWNER_REVIEW_MIN_REVIEWS = 2;
export const OWNER_REVIEW_MAX_ROUNDS = 10;
export const OWNER_REVIEW_VERDICTS = Object.freeze(["pass", "warn"]);

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

/** Verify authority before trusting any caller-supplied review semantics. */
export function verifyReleaseAttestationSignature(
  attestation,
  authority,
  expectedSchemaVersion = OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
) {
  const reasons = [];
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    return { ok: false, reasons: ["review attestation is not an object"] };
  }
  if (attestation.schemaVersion !== expectedSchemaVersion) {
    reasons.push(`review attestation schemaVersion must be ${expectedSchemaVersion}`);
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

/** ONE owner for the signed full-deterministic-gate evidence shape, shared by
 * the v2 panel attestation and the v3 owner-review attestation. */
export function validateFullGateEvidence(gate, expected) {
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
    return ["review attestation full deterministic gate is invalid"];
  }
  return [];
}

/**
 * Owner-review payload semantics (schemaVersion 3): exact candidate binding,
 * the shared full-gate evidence, and >=2 uniquely-named reviewer reports each
 * digest-bound and carrying a non-blocking verdict. A "block" verdict can
 * never be signed into a shippable attestation — sealing one is the ship
 * decision itself (owner protocol, <=10 convergence rounds — raised from 3 by owner decision for v3.0.0: owner scope injections mid-review legitimately extend convergence).
 */
export function validateOwnerReviewAttestationPayload(payload, expected) {
  const reasons = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reasons: ["review attestation payload is not an object"] };
  }
  if (payload.reviewProtocol !== OWNER_REVIEW_PROTOCOL) {
    reasons.push(`owner review attestation protocol must be ${OWNER_REVIEW_PROTOCOL}`);
  }
  if (payload.candidateSha !== expected.candidateSha || !SHA1.test(payload.candidateSha ?? "")) {
    reasons.push("review attestation candidate SHA mismatch");
  }
  if (payload.candidateTree !== expected.candidateTree || !SHA1.test(payload.candidateTree ?? "")) {
    reasons.push("review attestation candidate tree mismatch");
  }
  if (
    !Number.isInteger(payload.rounds) ||
    payload.rounds < 1 ||
    payload.rounds > OWNER_REVIEW_MAX_ROUNDS
  ) {
    reasons.push(`owner review rounds must be an integer in 1..${OWNER_REVIEW_MAX_ROUNDS}`);
  }
  reasons.push(...validateFullGateEvidence(payload.fullGate, expected));
  const reviews = Array.isArray(payload.reviews) ? payload.reviews : [];
  if (reviews.length < OWNER_REVIEW_MIN_REVIEWS) {
    reasons.push(
      `owner review attestation requires at least ${OWNER_REVIEW_MIN_REVIEWS} reviewer reports`,
    );
  }
  for (const review of reviews) {
    if (
      !review ||
      typeof review.reviewer !== "string" ||
      review.reviewer.length === 0 ||
      !SHA256.test(review.reportSha256 ?? "")
    ) {
      reasons.push("owner review entry is missing a reviewer name or report digest");
      continue;
    }
    if (!OWNER_REVIEW_VERDICTS.includes(review.verdict)) {
      reasons.push(
        `owner review verdict for ${review.reviewer} must be one of: ${OWNER_REVIEW_VERDICTS.join(", ")}`,
      );
    }
  }
  const names = new Set(reviews.map((review) => review?.reviewer));
  if (names.size !== reviews.length) {
    reasons.push("owner review attestation contains duplicate reviewer names");
  }
  // Bind the EXACT triad+scope panel (B8): the sealed reviews must cover the
  // three frozen triad slots and the scope slot, each digest-bound — a >=2
  // structural floor alone let an off-panel pair seal. Packet-split waves
  // bind one full panel PER named sub-wave.
  reasons.push(...validateReviewPanelCoverage(reviews));
  // A packet-split seal must additionally prove the union of its sub-wave
  // packs covered every changed file (audit A-8): the coverage receipt is
  // signature-bound so one sub-wave's report can never stand in for all.
  // ANY named sub-wave forces the receipt — by construction a named
  // sub-wave's pack covers only a SUBSET, so even a single-named seal
  // without union proof is the exact evasion X115 closed.
  const namedSubWaves = [...panelSubWaves(reviews)].filter((key) => key !== "");
  reasons.push(
    ...validateCoverageReceipt(payload.coverageReceipt, expected, {
      required: namedSubWaves.length > 0,
      namedSubWaves,
    }),
  );
  // Bind each triad slot to the EXACT pack bytes its reviewer consumed: the
  // slot record's prompt digest must equal its sub-wave's recomputed pack
  // digest in the receipt — reviewer reports from one set of prompts can
  // never seal with a coverage proof computed over different packs.
  const receiptPacks = new Map(
    (payload.coverageReceipt?.packs ?? []).map((pack) => [pack.subWave, pack.sha256]),
  );
  if (receiptPacks.size > 0) {
    for (const review of reviews) {
      const panel = review?.panel;
      if (!panel || panel.slot !== "triad" || typeof panel.subWave !== "string") continue;
      const expectedDigest = receiptPacks.get(panel.subWave);
      if (!SHA256.test(review.promptSha256 ?? "")) {
        reasons.push(
          `owner review triad slot ${panel.model} (sub-wave ${panel.subWave}) carries no prompt digest to bind against the coverage receipt`,
        );
      } else if (expectedDigest && review.promptSha256 !== expectedDigest) {
        reasons.push(
          `owner review triad slot ${panel.model} (sub-wave ${panel.subWave}) reviewed prompt ${review.promptSha256.slice(0, 12)}… but the coverage receipt binds pack ${expectedDigest.slice(0, 12)}…`,
        );
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function validateReleaseAttestation(attestation, authority, expected) {
  // The signature covers schemaVersion itself, so an old payload can never be
  // replayed into the current contract without breaking the Ed25519 check.
  if (attestation?.schemaVersion !== OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION) {
    return {
      ok: false,
      reasons: [
        `review attestation schemaVersion ${attestation?.schemaVersion ?? "(missing)"} is not accepted: this verifier requires v${OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION} (v2's six-slot panel was retired in v3.0.0, v3 lacked the packet-split coverage receipt; sealed old artifacts remain archived)`,
      ],
    };
  }
  const signature = verifyReleaseAttestationSignature(
    attestation,
    authority,
    OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
  );
  if (!signature.ok) return signature;
  return validateOwnerReviewAttestationPayload(attestation.payload, expected);
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

/**
 * The exact per-file section a covered file gets inside a touched-file pack.
 * The deterministic coverage checker (scripts/review-coverage-check.mjs)
 * matches this byte-for-byte to prove a file's COMPLETE current text reached
 * reviewers — so this format is a contract, not an implementation detail.
 */
export function touchedFileSection(path, text) {
  return `### ${path}\n\n\`\`\`\n${text}\n\`\`\``;
}

/** Stable prefix of a touched-file section header (used to spot truncated sections). */
export function touchedFileHeader(path) {
  return `### ${path}\n`;
}

export const TOUCHED_FILE_OMISSION_MARKER = "⚠️ OMISSION NOTE:";

/**
 * Build changed-file context from committed Git objects, never live paths.
 *
 * By default a file past the per-file cap or the pack budget is dropped with a
 * disclosed OMISSION NOTE. Audit A-8 proved a disclosed omission is not a
 * full-context guarantee: on a large phase reviewers silently did NOT get every
 * changed file's full text. Pass `{ onOmission: "throw" }` (the release
 * transport does) so a would-be omission FAILS LOUDLY instead — the operator
 * must then split the wave into packet-split sub-waves (docs/CHECKLISTS.md)
 * small enough that every hand-written file fits in full.
 */
export function buildTouchedFilePack(paths, git, maxFileBytes, maxPackBytes, options = {}) {
  const onOmission = options.onOmission ?? "note";
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
    // Budgets count the UTF-8 bytes the transport actually submits — string
    // .length counts UTF-16 code units and undercounts multibyte text — and
    // the FULL section (header + fences + separators), not the bare file.
    const fileBytes = Buffer.byteLength(text, "utf8");
    if (fileBytes > maxFileBytes) {
      omitted.push(`${path} (${fileBytes}B > per-file cap; review via diff)`);
      continue;
    }
    const section = touchedFileSection(path, text);
    const sectionBytes = Buffer.byteLength(section, "utf8") + 2; // + "\n\n" joiner
    if (total + sectionBytes > maxPackBytes) {
      omitted.push(`${path} (pack budget reached)`);
      continue;
    }
    total += sectionBytes;
    out.push(section);
  }
  if (omitted.length > 0 && onOmission === "throw") {
    throw new Error(
      `touched-file pack would drop ${omitted.length} hand-written file(s) past the byte budget — ` +
        `split this wave into smaller packet-split sub-waves so every file fits in full: ${omitted.join(", ")}`,
    );
  }
  let pack = out.join("\n\n");
  if (omitted.length > 0) {
    pack += `\n\n${TOUCHED_FILE_OMISSION_MARKER} ${omitted.length} file(s) omitted from direct context: ${omitted.join(", ")}`;
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
 *
 * MULTIPLE rows per checklist item are the contract (release wave round-16
 * protocol root-cause): the prompt instructs "report every distinct problem
 * as a separate entry", so a deep review legitimately repeats an item id once
 * per finding. The old one-row-per-item cap disqualified exactly the most
 * thorough reviewers — the deeper the review, the likelier the slot died.
 * Only a runaway row count (beyond any plausible finding list) is refused.
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
  const maxRows = requiredItems.length * 16;
  if (items.length > maxRows) {
    return invalidRow(maxRows, requiredItems, `checklist has a runaway row count (> ${maxRows})`);
  }

  const findings = [];
  for (const [index, entry] of items.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return invalidRow(index, requiredItems, "row is not an object");
    }
    const requiredKeys = ["item", "reason", "severity", "verdict"];
    // Blocker-contract fields [INV-139]: a critical FAIL should cite the
    // violated invariant/criterion and state default-config reachability.
    const optionalKeys = ["invariant", "reachable"];
    const keys = Object.keys(entry);
    if (
      keys.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key)) ||
      requiredKeys.some((key) => !keys.includes(key))
    ) {
      return invalidRow(index, requiredItems, "row has unsupported or missing fields");
    }
    if ("invariant" in entry && (typeof entry.invariant !== "string" || !entry.invariant.trim())) {
      return invalidRow(index, requiredItems, "invariant must be a non-empty string when present");
    }
    if ("reachable" in entry && typeof entry.reachable !== "boolean") {
      return invalidRow(index, requiredItems, "reachable must be a boolean when present");
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
    findings.push({
      item,
      verdict,
      severity,
      reason,
      model,
      ...("invariant" in entry ? { invariant: entry.invariant.trim() } : {}),
      ...("reachable" in entry ? { reachable: entry.reachable } : {}),
    });
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

/**
 * Blocker-contract accounting [INV-139]: a blocking finding must cite a
 * violated invariant/owner criterion and be reachable in the default
 * configuration. Gaps never soften the machine decision (a critical FAIL
 * still blocks — fail-closed); they are surfaced for the adjudication step,
 * where an uncited or unreachable blocker is ledgered rather than fixed.
 */
export function blockerContractGaps(findings) {
  return blockingFindings(findings).flatMap((finding) => {
    const gaps = [];
    if (!finding.invariant) gaps.push("no invariant/criterion cited");
    // INV-139 requires an explicit reachability claim on every blocker: an
    // OMITTED field is itself a gap (silently treating it as reachable let a
    // contract-incomplete row block; treating it as fine hid the omission).
    if (finding.reachable === false) gaps.push("reviewer marked it unreachable in default config");
    else if (finding.reachable !== true) gaps.push("no reachable:true/false claim");
    return gaps.length > 0 ? [{ finding, gaps }] : [];
  });
}

/**
 * Liveness floor [INV-125/CHECKLISTS]: a slot counts only with a parsed typed
 * verdict AND a plausible duration. A multi-megabyte review prompt cannot be
 * genuinely reviewed in seconds — an instant "responded" is an infrastructure
 * or cache artifact, treated exactly like a failed slot.
 */
export const REVIEWER_MIN_PLAUSIBLE_MS = 30_000;

/**
 * Prompt-size-aware liveness floor. The 30s ceiling was calibrated for the
 * megabyte-scale v3.0.0 release packets; a flash-tier reviewer legitimately
 * clears a sub-200KB hotfix packet in ~20s, which made the protocol
 * structurally unsatisfiable for small deltas (v3.0.1 wave, rounds 5-6).
 * The floor scales with the ACTUAL submitted prompt so liveness still
 * rejects instant/cache/transport artifacts at every size; it never rises
 * above REVIEWER_MIN_PLAUSIBLE_MS and never falls below 10s.
 */
export function livenessFloorMs(promptChars) {
  if (!Number.isFinite(promptChars) || promptChars <= 0) return REVIEWER_MIN_PLAUSIBLE_MS;
  if (promptChars >= 1_000_000) return REVIEWER_MIN_PLAUSIBLE_MS;
  if (promptChars >= 300_000) return 20_000;
  return 10_000;
}

export function reviewerLiveness(actor, minPlausibleMs = REVIEWER_MIN_PLAUSIBLE_MS) {
  if (actor?.status !== "responded") {
    return { live: false, reason: `status is ${actor?.status ?? "(missing)"}` };
  }
  const duration = actor.duration_ms ?? actor.durationMs;
  if (!Number.isFinite(duration)) {
    return { live: false, reason: "duration is missing from the slot record" };
  }
  if (duration < minPlausibleMs) {
    return {
      live: false,
      reason: `implausible duration ${duration}ms (< ${minPlausibleMs}ms floor)`,
    };
  }
  return { live: true, reason: null };
}

/**
 * v3 protocol: EVERY required slot (all three triad reviewers + scope) must be
 * live — a failed required slot blocks sealing (CHECKLISTS "Reviewer
 * liveness"; the transport gets one same-SHA retry before a slot is final).
 * `responsiveTriad` stays as accounting, but partial panels never pass.
 */
export function releaseReviewDecision({ triadActors, scope, minPlausibleMs }) {
  const reasons = [];
  const liveTriad = [];
  for (const actor of triadActors) {
    const liveness = reviewerLiveness(actor, minPlausibleMs);
    if (liveness.live) liveTriad.push(actor);
    else
      reasons.push(
        `required reviewer slot ${actor.model_id ?? "(unknown)"} is not live: ${liveness.reason}`,
      );
  }
  if (triadActors.length !== REQUIRED_TRIAD_MODELS.length) {
    reasons.push(
      `triad has ${triadActors.length} slot(s); the exact panel requires ${REQUIRED_TRIAD_MODELS.length}`,
    );
  }
  if (!scope) {
    reasons.push("scope reviewer is missing");
  } else {
    const liveness = reviewerLiveness(
      { ...scope, duration_ms: scope.metadata?.duration_ms ?? scope.duration_ms },
      minPlausibleMs,
    );
    if (!liveness.live) reasons.push(`scope reviewer is not live: ${liveness.reason}`);
  }
  const allFindings = [
    ...liveTriad.flatMap((actor) => actor.findings ?? []),
    ...(scope?.status === "responded" ? (scope.findings ?? []) : []),
  ];
  const failures = blockingFindings(allFindings);
  if (failures.length > 0) {
    reasons.push(`reviewers returned ${failures.length} critical FAIL verdict(s)`);
  }
  return {
    passed: reasons.length === 0,
    responsiveTriad: liveTriad.length,
    blockingFindings: failures,
    blockerContractGaps: blockerContractGaps(allFindings),
    reasons,
  };
}
