#!/usr/bin/env node
/**
 * Seal the OWNER-REVIEW release attestation (schemaVersion 3): the owner's
 * offline Ed25519 authority signs the exact candidate identity, the full
 * deterministic gate receipt, and >=2 fable reviewer reports with
 * non-blocking verdicts. This REPLACES the retired six-slot panel sealer for
 * new releases; verify-release-input.mjs accepts either schema.
 *
 * usage:
 *   seal-owner-review-attestation.mjs \
 *     --full-gate-receipt FILE --rounds N \
 *     --review reviewer=FILE:verdict --review reviewer=FILE:verdict [...] \
 *     --private-key FILE --authority FILE --out FILE [--base64-out FILE]
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
    const match = /^([A-Za-z0-9._-]+)=(.+):(pass|warn)$/.exec(entry);
    if (!match) throw new Error(`--review must be reviewer=FILE:pass|warn, got "${entry}"`);
    return { reviewer: match[1], reportSha256: sha256File(match[2]), verdict: match[3] };
  });

  const authority = JSON.parse(readFileSync(options.authority, "utf8"));
  const payload = {
    contract: "owner-review-v3",
    reviewProtocol: OWNER_REVIEW_PROTOCOL,
    candidateSha,
    candidateTree,
    rounds: Number(options.rounds),
    fullGate,
    reviews,
    sealedAt: new Date().toISOString(),
  };
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
    "usage: seal-owner-review-attestation.mjs --full-gate-receipt FILE --rounds N --review reviewer=FILE:pass|warn (x2+) --private-key FILE --authority FILE --out FILE [--base64-out FILE]",
  );
  process.exit(2);
}
