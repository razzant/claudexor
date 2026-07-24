#!/usr/bin/env node
/**
 * Seal the OWNER-REVIEW release attestation (schemaVersion 4): the owner's
 * offline Ed25519 authority signs the exact candidate identity, the full
 * deterministic gate receipt, the panel reviewer report digests with
 * non-blocking verdicts, and — for packet-split panels — the RECOMPUTED
 * union-coverage receipt (one full triad+scope panel per named sub-wave).
 * Older schemas are archival only; the verifier accepts exactly the current
 * schema for new seals.
 *
 * usage:
 *   seal-owner-review-attestation.mjs \
 *     --full-gate-receipt FILE --rounds N \
 *     --slot-record FILE [...]  # typed wave metadata, one per panel slot \
 *     [--review reviewer=FILE:verdict [...]]  # non-panel critic reports \
 *     [--packet DIR]             # sealed packet: FREEZE base authority \
 *     [--coverage-receipt FILE   # required when slots name sub-waves] \
 *     --private-key FILE --authority FILE --out FILE [--base64-out FILE]
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bindCoverageReceipt } from "./review-coverage-check.mjs";
import {
  OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
  OWNER_REVIEW_PROTOCOL,
  RELEASE_REVIEW_ATTESTATION_ALGORITHM,
  releaseAttestationSigningBytes,
  validateReleaseAttestation,
} from "./lib/release-review-contract.mjs";

const options = { review: [], slotRecord: [] };
const argv = process.argv.slice(2);
if (argv.length % 2 !== 0) usage();
for (let index = 0; index < argv.length; index += 2) {
  if (!argv[index].startsWith("--")) usage();
  const key = argv[index].slice(2);
  if (key === "review") options.review.push(argv[index + 1]);
  else if (key === "slot-record") options.slotRecord.push(argv[index + 1]);
  else options[key] = argv[index + 1];
}
for (const name of ["full-gate-receipt", "rounds", "private-key", "authority", "out"]) {
  if (!options[name]) usage(`missing --${name}`);
}
if (options.slotRecord.length === 0 && options.review.length < 2) {
  usage("at least two --slot-record FILE (wave metadata records) or --review entries");
}

try {
  if (existsSync(options.out) || (options["base64-out"] && existsSync(options["base64-out"]))) {
    throw new Error("attestation output already exists; sealed evidence is never overwritten");
  }
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const candidateSha = git("rev-parse", "HEAD");
  const candidateTree = git("rev-parse", "HEAD^{tree}");
  if (git("status", "--porcelain") !== "") {
    throw new Error("candidate worktree is dirty; the attestation binds a committed tree only");
  }

  const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const receipt = JSON.parse(readFileSync(options["full-gate-receipt"], "utf8"));
  const fullGate = {
    receiptSha256: sha256File(options["full-gate-receipt"]),
    program: receipt.program,
    argv: receipt.argv,
    exitCode: receipt.exitCode,
    candidateUnchanged: receipt.candidateUnchanged,
    beforeSha: receipt.before?.head,
    beforeTree: receipt.before?.tree,
    afterSha: receipt.after?.head,
    afterTree: receipt.after?.tree,
    stdoutSha256: receipt.stdout?.sha256,
    stderrSha256: receipt.stderr?.sha256,
  };
  // Non-panel reviews (the owner's fable-subagent reports, internal critics):
  // reviewer=FILE:verdict. These carry NO panel identity — panel slots come
  // ONLY from typed --slot-record wave metadata below, so a CLI label can
  // never impersonate the triad/scope panel (gate-5 critical).
  const reviews = options.review.map((entry) => {
    const match = /^([A-Za-z0-9._-]+)=(.+):(pass|warn)$/.exec(entry);
    if (!match) {
      throw new Error(
        `--review must be reviewer=FILE:pass|warn (panel slots seal ONLY via --slot-record), got "${entry}"`,
      );
    }
    return { reviewer: match[1], reportSha256: sha256File(match[2]), verdict: match[3] };
  });

  // Panel slots: PARSED from the wave transport's typed slot-attestation
  // records (triad-scope-review.mjs metadata) — the sealer derives reviewer
  // identity, verdict, sub-wave, and report digest, verifying every binding
  // from disk instead of trusting caller prose.
  const packetDir = options.packet ?? null;
  const packetManifestSha256 = packetDir ? sha256File(join(packetDir, "MANIFEST.sha256")) : null;
  let waveId = null;
  for (const recordPath of options.slotRecord) {
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    const where = `slot record ${recordPath}`;
    if (record.status !== "responded" || record.error) {
      throw new Error(`${where}: slot is not a live responded review (status ${record.status})`);
    }
    if (!["pass", "warn"].includes(record.verdict)) {
      throw new Error(`${where}: derived verdict "${record.verdict}" cannot seal`);
    }
    if (record.candidateSha !== candidateSha || record.candidateTree !== candidateTree) {
      throw new Error(`${where}: bound to a different candidate/tree than the sealed one`);
    }
    if (!record.observed_model || record.observed_model !== record.requested_model) {
      throw new Error(
        `${where}: observed model "${record.observed_model}" does not prove the requested "${record.requested_model}"`,
      );
    }
    if (!["triad", "scope"].includes(record.panel_slot)) {
      throw new Error(`${where}: panel_slot must be triad|scope`);
    }
    if (waveId === null) waveId = record.reviewWaveId;
    else if (record.reviewWaveId !== waveId) {
      throw new Error(`${where}: mixes wave ${record.reviewWaveId} into wave ${waveId}`);
    }
    if (packetManifestSha256 && record.packetManifestSha256 !== packetManifestSha256) {
      throw new Error(`${where}: reviewed a different sealed packet than --packet`);
    }
    const reportDigest = sha256File(join(dirname(recordPath), record.raw_file));
    if (reportDigest !== record.report_sha256) {
      throw new Error(
        `${where}: raw report bytes (${reportDigest.slice(0, 12)}…) do not match the recorded digest`,
      );
    }
    const review = {
      reviewer: `${record.panel_slot}${record.sub_wave ? `@${record.sub_wave}` : ""}:${record.model_id}`,
      reportSha256: record.report_sha256,
      verdict: record.verdict,
      promptSha256: record.promptSha256,
      panel: { slot: record.panel_slot, model: record.model_id },
    };
    if (record.sub_wave) review.panel.subWave = record.sub_wave;
    reviews.push(review);
  }

  const authority = JSON.parse(readFileSync(options.authority, "utf8"));
  const payload = {
    contract: `owner-review-v${OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION}`,
    reviewProtocol: OWNER_REVIEW_PROTOCOL,
    candidateSha,
    candidateTree,
    rounds: Number(options.rounds),
    fullGate,
    reviews,
    sealedAt: new Date().toISOString(),
  };
  if (options["coverage-receipt"]) {
    // The union-coverage proof for a packet-split panel (audit A-8). The
    // sealer NEVER trusts the caller's receipt: the review BASE and the
    // whole-file list come from the sealed packet's OWN FREEZE.json and
    // FILES_TO_READ_WHOLE.txt (--packet, required here), the coverage is
    // re-run over the receipt's referenced packs against THIS candidate,
    // and every pack digest is recomputed from disk — a hand-authored
    // ok:true (or a shrunken base≈candidate) cannot seal. Only the
    // RECOMPUTED result is embedded (signature-bound). Trust boundary: the
    // verifier (no pack files at publish time) checks the signature and
    // structure; the recomputation lives here, before signing.
    if (!packetDir) {
      throw new Error("--coverage-receipt requires --packet (the FREEZE base authority)");
    }
    const freeze = JSON.parse(readFileSync(join(packetDir, "FREEZE.json"), "utf8"));
    if (freeze.candidateSha !== candidateSha) {
      throw new Error(
        `sealed packet FREEZE binds candidate ${freeze.candidateSha}, not the sealed ${candidateSha}`,
      );
    }
    const wholeFileListPath = join(packetDir, "FILES_TO_READ_WHOLE.txt");
    const receipt = JSON.parse(readFileSync(options["coverage-receipt"], "utf8"));
    payload.coverageReceipt = {
      receiptSha256: sha256File(options["coverage-receipt"]),
      ...bindCoverageReceipt(receipt, candidateSha, {
        baseSha: freeze.baseSha,
        wholeFileListPath: existsSync(wholeFileListPath) ? wholeFileListPath : null,
      }),
    };
  }
  const attestation = {
    schemaVersion: OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
    keyId: authority.keyId,
    algorithm: RELEASE_REVIEW_ATTESTATION_ALGORITHM,
    payload,
  };
  const key = createPrivateKey(readFileSync(options["private-key"], "utf8"));
  attestation.signature = sign(null, releaseAttestationSigningBytes(attestation), key).toString(
    "base64",
  );

  // Self-check with the EXACT verifier publish runs — a sealed attestation
  // that would not publish must never be written.
  const verified = validateReleaseAttestation(attestation, authority, {
    candidateSha,
    candidateTree,
  });
  if (!verified.ok) {
    throw new Error(`sealed attestation fails its own verifier: ${verified.reasons.join("; ")}`);
  }

  const json = `${JSON.stringify(attestation, null, 2)}\n`;
  atomicWrite(options.out, json, 0o600);
  if (options["base64-out"]) {
    atomicWrite(options["base64-out"], Buffer.from(json.trim(), "utf8").toString("base64"), 0o600);
  }
  console.log(`signed owner-review attestation sealed: ${options.out}`);
} catch (error) {
  console.error(`owner-review attestation refused: ${String(error)}`);
  process.exit(1);
}

function atomicWrite(path, data, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp-${process.pid}`, data, { mode, flag: "wx" });
  execFileSync("mv", [`${path}.tmp-${process.pid}`, path]);
}

function usage(detail = "") {
  if (detail) console.error(detail);
  console.error(
    "usage: seal-owner-review-attestation.mjs --full-gate-receipt FILE --rounds N --slot-record FILE (one per panel slot: the wave's typed metadata record; the sealer derives reviewer/verdict/sub-wave and verifies candidate, observed model, report digest) [--review reviewer=FILE:pass|warn (non-panel critic reports only)] [--packet DIR (sealed packet; REQUIRED with --coverage-receipt: FREEZE base + whole-file-list authority)] [--coverage-receipt FILE (required for packet-split panels)] --private-key FILE --authority FILE --out FILE [--base64-out FILE]",
  );
  process.exit(2);
}
