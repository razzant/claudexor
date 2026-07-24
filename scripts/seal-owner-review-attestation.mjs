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
 *     --review reviewer=FILE:verdict[:triad|scope[@subwave]=model] [...] \
 *     [--coverage-receipt FILE   # required when slots name sub-waves] \
 *     --private-key FILE --authority FILE --out FILE [--base64-out FILE]
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bindCoverageReceipt } from "./review-coverage-check.mjs";
import {
  OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
  OWNER_REVIEW_PROTOCOL,
  RELEASE_REVIEW_ATTESTATION_ALGORITHM,
  releaseAttestationSigningBytes,
  validateReleaseAttestation,
} from "./lib/release-review-contract.mjs";

const options = { review: [] };
const argv = process.argv.slice(2);
if (argv.length % 2 !== 0) usage();
for (let index = 0; index < argv.length; index += 2) {
  if (!argv[index].startsWith("--")) usage();
  const key = argv[index].slice(2);
  if (key === "review") options.review.push(argv[index + 1]);
  else options[key] = argv[index + 1];
}
for (const name of ["full-gate-receipt", "rounds", "private-key", "authority", "out"]) {
  if (!options[name]) usage(`missing --${name}`);
}
if (options.review.length < 2) usage("at least two --review reviewer=FILE:verdict entries");

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
  const reviews = options.review.map((entry) => {
    // reviewer=FILE:verdict[:slot[@subwave]=model] — the optional trailing
    // slot=model binds this report to a triad/scope panel slot (B8); a
    // packet-split wave names each sub-wave (slot@subwave=model) and must
    // bind a FULL panel per sub-wave plus a --coverage-receipt. Panel-less
    // entries are extra internal-critic reviews (counted only by the >=2
    // floor).
    const match =
      /^([A-Za-z0-9._-]+)=(.+):(pass|warn)(?::(triad|scope)(?:@([a-z0-9-]+))?=([^:]+))?$/.exec(
        entry,
      );
    if (!match) {
      throw new Error(
        `--review must be reviewer=FILE:pass|warn[:triad|scope[@subwave]=model], got "${entry}"`,
      );
    }
    const review = { reviewer: match[1], reportSha256: sha256File(match[2]), verdict: match[3] };
    if (match[4]) {
      review.panel = { slot: match[4], model: match[6] };
      if (match[5]) review.panel.subWave = match[5];
    }
    return review;
  });

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
    // sealer NEVER trusts the caller's receipt: it re-runs the coverage
    // computation over the receipt's referenced packs against the receipt's
    // base and THIS candidate, recomputes every pack digest from disk, and
    // refuses on any mismatch — a hand-authored ok:true cannot seal. Only
    // the RECOMPUTED result is embedded (signature-bound). Trust boundary:
    // the verifier (no pack files at publish time) checks the signature and
    // structure; the recomputation lives here, before signing.
    const receipt = JSON.parse(readFileSync(options["coverage-receipt"], "utf8"));
    payload.coverageReceipt = {
      receiptSha256: sha256File(options["coverage-receipt"]),
      ...bindCoverageReceipt(receipt, candidateSha),
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
    "usage: seal-owner-review-attestation.mjs --full-gate-receipt FILE --rounds N --review reviewer=FILE:pass|warn[:triad|scope[@subwave]=model] (must cover the exact triad+scope panel, per sub-wave when packet-split) [--coverage-receipt FILE (required for packet-split panels)] --private-key FILE --authority FILE --out FILE [--base64-out FILE]",
  );
  process.exit(2);
}
