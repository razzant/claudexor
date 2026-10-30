import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FROZEN_REVIEW_EVIDENCE_FILES } from "../../context/src/evidence.js";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { describe, expect, it } from "vitest";
import {
  ARCHIVED_OWNER_REVIEW_SCHEMA_VERSIONS,
  OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
  OWNER_REVIEW_MODEL_FAMILIES,
  OWNER_REVIEW_PANEL,
  OWNER_REVIEW_PROTOCOL,
  decodeReviewUtf8,
  pathIsWithin,
  releaseAttestationSigningBytes,
  validateFullGateReceipt,
  validateReleaseAttestation,
  validateReleaseInput,
  verifyArchivedReleaseAttestationSignature,
} from "../../../scripts/lib/release-review-contract.mjs";
import { bundleReleaseReviewVerifier } from "../../../scripts/lib/release-review-runtime.mjs";

const candidateSha = "a".repeat(40);
const candidateTree = "b".repeat(40);
const digest = "d".repeat(64);
const expected = { candidateSha, candidateTree, candidateVersion: CLAUDEXOR_VERSION };
const repoRoot = resolve(import.meta.dirname, "../../..");
const sealer = resolve(repoRoot, "scripts/seal-owner-review-attestation.mjs");
const fullGateReceiptRunner = resolve(repoRoot, "scripts/run-full-gate-receipt.mjs");

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function write(path: string, contents: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const authority = {
    schemaVersion: 1,
    keyId: "fixture-key",
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const reviews = OWNER_REVIEW_PANEL.map((required, index) => ({
    slot: required.slot,
    modelFamily: index === 0 ? "grok-4.6" : "opus-5",
    model: index === 0 ? "cursor-grok-4.6-xhigh" : "claude-opus-5",
    harness: index === 0 ? "cursor" : "claude",
    startedAt: `2026-08-06T00:00:0${index}.000Z`,
    completedAt: `2026-08-06T00:00:0${index + 5}.000Z`,
    verdict: index === 0 ? "pass" : "warn",
    reviewScope: "full",
    reportSha256: (index === 0 ? "d" : "e").repeat(64),
    metadataSha256: digest,
  }));
  const payload = {
    contract: "owner-review-v7",
    reviewProtocol: OWNER_REVIEW_PROTOCOL,
    candidateSha,
    candidateTree,
    candidateVersion: CLAUDEXOR_VERSION,
    evidence: {
      manifestSha256: digest,
      diffSha256: digest,
      reviewWaveId: "11111111-1111-4111-8111-111111111111",
    },
    fullGate: {
      receiptSha256: digest,
      program: "pnpm",
      argv: ["pnpm", "release:verify"],
      exitCode: 0,
      candidateUnchanged: true,
      beforeSha: candidateSha,
      beforeTree: candidateTree,
      afterSha: candidateSha,
      afterTree: candidateTree,
      stdoutSha256: digest,
      stderrSha256: digest,
    },
    reviews,
    sealedAt: "2026-08-06T00:00:00.000Z",
  };
  const resign = (unsigned: any) => ({
    ...unsigned,
    signature: sign(null, releaseAttestationSigningBytes(unsigned), privateKey).toString("base64"),
  });
  const attestation = resign({
    schemaVersion: OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
    keyId: authority.keyId,
    algorithm: "Ed25519",
    payload,
  });
  return { attestation, authority, resign };
}

describe("operator owner-review publishing contract", () => {
  it("requires the exact successful full-gate receipt shape", () => {
    const receipt = {
      program: "pnpm",
      argv: ["pnpm", "release:verify"],
      exitCode: 0,
      gateExitCode: 0,
      candidateUnchanged: true,
      before: { head: candidateSha, tree: candidateTree, status: "" },
      after: { head: candidateSha, tree: candidateTree, status: "" },
      stdout: { path: "/external/full-gate.stdout.log", sha256: digest },
      stderr: { path: "/external/full-gate.stderr.log", sha256: digest },
      reviewRuntimeArtifacts: [
        { path: "release-review-verifier.mjs", bytes: 1, sha256: digest },
        { path: "claudexor.bundle.cjs", bytes: 1, sha256: digest },
      ],
      reviewRuntimeArtifactError: null,
      finishedAt: "2026-07-30T00:00:00.000Z",
    };
    const identity = { candidateSha, candidateTree };
    expect(validateFullGateReceipt(receipt, identity)).toEqual([]);
    for (const mutate of [
      (value: any) => delete value.gateExitCode,
      (value: any) => (value.gateExitCode = 1),
      (value: any) => (value.before.status = " M package.json"),
      (value: any) => (value.reviewRuntimeArtifactError = "bundle failed"),
      (value: any) => delete value.stdout.path,
      (value: any) => (value.finishedAt = "today"),
      (value: any) => value.reviewRuntimeArtifacts.pop(),
      (value: any) => (value.extra = true),
    ]) {
      const invalid = structuredClone(receipt);
      mutate(invalid);
      expect(validateFullGateReceipt(invalid, identity)).not.toEqual([]);
    }
  });

  it("freezes two neutral slots and the owner-approved families in signed v7 evidence", () => {
    expect(OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION).toBe(7);
    expect(OWNER_REVIEW_PROTOCOL).toBe("owner-review-two-model-families-v1");
    expect(OWNER_REVIEW_PANEL).toEqual([{ slot: "reviewer-1" }, { slot: "reviewer-2" }]);
    expect(OWNER_REVIEW_MODEL_FAMILIES).toEqual([
      "grok-4.6",
      "fable-5",
      "opus-5",
      "gpt-5.6-sol",
      "kimi-k3",
    ]);
    const { attestation, authority } = fixture();
    expect(validateReleaseAttestation(attestation, authority, expected)).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("accepts any two distinct approved families with route-specific slugs on any harness", () => {
    const { attestation, authority, resign } = fixture();
    for (const first of OWNER_REVIEW_MODEL_FAMILIES) {
      for (const second of OWNER_REVIEW_MODEL_FAMILIES) {
        if (first === second) continue;
        const alternate = structuredClone(attestation);
        for (const [index, modelFamily] of [first, second].entries()) {
          Object.assign(alternate.payload.reviews[index], {
            modelFamily,
            model: `vendor/${modelFamily}-thinking-high`,
            harness: "another-harness",
          });
        }
        expect(validateReleaseAttestation(resign(alternate), authority, expected)).toEqual({
          ok: true,
          reasons: [],
        });
      }
    }
  });

  it.each([
    ["unapproved family", (a: any) => (a.payload.reviews[0].modelFamily = "other-model")],
    ["missing family", (a: any) => delete a.payload.reviews[0].modelFamily],
    [
      "two tiers of the same family on different harnesses",
      (a: any) => {
        a.payload.reviews[1].modelFamily = "grok-4.6";
        a.payload.reviews[1].model = "vendor/grok-4.6-high";
      },
    ],
    ["missing model", (a: any) => delete a.payload.reviews[0].model],
    ["blank model", (a: any) => (a.payload.reviews[0].model = "  ")],
    ["non-string model", (a: any) => (a.payload.reviews[0].model = false)],
    ["missing harness", (a: any) => delete a.payload.reviews[0].harness],
    ["blank harness", (a: any) => (a.payload.reviews[0].harness = "\n")],
    ["non-string harness", (a: any) => (a.payload.reviews[0].harness = 1)],
    ["swapped slot label", (a: any) => (a.payload.reviews[1].slot = "reviewer-1")],
    ["missing report digest", (a: any) => delete a.payload.reviews[0].reportSha256],
    ["malformed report digest", (a: any) => (a.payload.reviews[1].reportSha256 = "bad")],
    ["malformed metadata digest", (a: any) => (a.payload.reviews[0].metadataSha256 = "bad")],
    ["blocking verdict", (a: any) => (a.payload.reviews[1].verdict = "block")],
    ["missing verdict", (a: any) => delete a.payload.reviews[0].verdict],
    ["delta review scope", (a: any) => (a.payload.reviews[1].reviewScope = "delta")],
    ["missing review scope", (a: any) => delete a.payload.reviews[0].reviewScope],
    ["boolean review scope", (a: any) => (a.payload.reviews[0].reviewScope = false)],
    ["non-ISO start", (a: any) => (a.payload.reviews[0].startedAt = "yesterday")],
    [
      "implausible wall time",
      (a: any) => (a.payload.reviews[0].completedAt = a.payload.reviews[0].startedAt),
    ],
    [
      "non-overlapping execution",
      (a: any) => {
        a.payload.reviews[1].startedAt = "2026-08-06T00:00:10.000Z";
        a.payload.reviews[1].completedAt = "2026-08-06T00:00:15.000Z";
      },
    ],
    [
      "zero overlap boundary",
      (a: any) => {
        a.payload.reviews[1].startedAt = "2026-08-06T00:00:05.000Z";
        a.payload.reviews[1].completedAt = "2026-08-06T00:00:10.000Z";
      },
    ],
    [
      "copied report bytes",
      (a: any) => (a.payload.reviews[1].reportSha256 = a.payload.reviews[0].reportSha256),
    ],
    ["evidence manifest", (a: any) => (a.payload.evidence.manifestSha256 = "bad")],
    ["review wave", (a: any) => (a.payload.evidence.reviewWaveId = "wave-1")],
    [
      "retired evidence metadata field",
      (a: any) => (a.payload.evidence.metadataSha256 = "d".repeat(64)),
    ],
    ["failed full gate", (a: any) => (a.payload.fullGate.exitCode = 1)],
    ["changed candidate", (a: any) => (a.payload.candidateSha = "c".repeat(40))],
    ["changed candidate version", (a: any) => (a.payload.candidateVersion = "0.0.0")],
    ["missing candidate version", (a: any) => delete a.payload.candidateVersion],
    ["wrong protocol", (a: any) => (a.payload.reviewProtocol = "native-fable-full-sol-delta-v2")],
    ["extra retired field", (a: any) => (a.payload.coverageReceipt = {})],
    [
      "retired native entry field",
      (a: any) => (a.payload.reviews[0].routeProofStatus = "verified"),
    ],
  ])("rejects a freshly signed semantic forgery: %s", (_label, mutate) => {
    const { attestation, authority, resign } = fixture();
    const forged = structuredClone(attestation);
    mutate(forged);
    expect(validateReleaseAttestation(resign(forged), authority, expected).ok).toBe(false);
  });

  it("requires exactly the two ordered independent reviewer slots", () => {
    const { attestation, authority, resign } = fixture();
    for (const reviews of [
      attestation.payload.reviews.slice(0, 1),
      [...attestation.payload.reviews, attestation.payload.reviews[0]],
      [...attestation.payload.reviews].reverse(),
    ]) {
      const changed = structuredClone(attestation);
      changed.payload.reviews = reviews;
      expect(validateReleaseAttestation(resign(changed), authority, expected).ok).toBe(false);
    }
  });

  it("detects post-signature tampering", () => {
    const { attestation, authority } = fixture();
    attestation.payload.reviews[0].verdict = "warn";
    expect(validateReleaseAttestation(attestation, authority, expected).reasons).toContain(
      "review attestation signature is invalid",
    );
  });

  it("verifies schemas 2-6 only as historical signed bytes and never publishes them", () => {
    const { attestation, authority, resign } = fixture();
    expect(ARCHIVED_OWNER_REVIEW_SCHEMA_VERSIONS).toEqual([2, 3, 4, 5, 6]);
    for (const schemaVersion of ARCHIVED_OWNER_REVIEW_SCHEMA_VERSIONS) {
      const archived = resign({ ...attestation, schemaVersion, payload: { historical: true } });
      expect(verifyArchivedReleaseAttestationSignature(archived, authority)).toEqual({
        ok: true,
        reasons: [],
      });
      expect(validateReleaseAttestation(archived, authority, expected).reasons.join(" ")).toContain(
        "archive-signature-only",
      );
    }
    expect(verifyArchivedReleaseAttestationSignature(attestation, authority).ok).toBe(false);
  });

  it("verifies the REAL published v3.2.0 schema-5 attestation bytes with the pinned authority", () => {
    // Immutable fixture: the exact REVIEW_ATTESTATION.json asset published on
    // GitHub release v3.2.0 (sha256 b3760d68ee9196bae883a198887f1f86e8bf2f28
    // cf5bfaf960e43d8ba22c661e), verified against the tracked production
    // authority — not a synthetic re-signed shape. This pins archive
    // compatibility to real released bytes: a canonicalization or dispatch
    // drift that a fixture-key round-trip would survive fails here.
    const attestation = JSON.parse(
      readFileSync(
        resolve(repoRoot, "packages/cli/fixtures/review-attestation-v3.2.0-schema5.json"),
        "utf8",
      ),
    );
    const authority = JSON.parse(
      readFileSync(resolve(repoRoot, "release/review-attestation-authority.json"), "utf8"),
    );
    expect(attestation.schemaVersion).toBe(5);
    expect(verifyArchivedReleaseAttestationSignature(attestation, authority)).toEqual({
      ok: true,
      reasons: [],
    });
    expect(
      validateReleaseAttestation(attestation, authority, expected).reasons.join(" "),
    ).toContain("archive-signature-only");
    // Any byte-level tamper of the published archive breaks its signature.
    const tampered = structuredClone(attestation);
    tampered.payload.candidateSha = "f".repeat(40);
    expect(verifyArchivedReleaseAttestationSignature(tampered, authority).ok).toBe(false);
  });

  it("keeps input, path and strict UTF-8 checks small and fail-closed", () => {
    expect(validateReleaseInput("candidate", candidateSha).ok).toBe(true);
    expect(validateReleaseInput("candidate", "main").ok).toBe(false);
    expect(validateReleaseInput("publish", `v${CLAUDEXOR_VERSION}`).ok).toBe(true);
    expect(validateReleaseInput("publish", `v${CLAUDEXOR_VERSION}-rc.1`).ok).toBe(false);
    expect(pathIsWithin("/candidate", "/candidate/evidence")).toBe(true);
    expect(pathIsWithin("/candidate", "/candidate-sibling")).toBe(false);
    expect(() => decodeReviewUtf8(Buffer.from([0xc3, 0x28]))).toThrow(/not valid UTF-8/);
  });

  it("requires the full-gate receipt output directory argument", () => {
    const result = spawnSync(process.execPath, [fullGateReceiptRunner], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("OUT_DIR");
  });

  it("refuses an in-candidate full-gate output before creating it", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-gate-boundary-"));
    const candidate = join(root, "candidate");
    const outDir = join(candidate, "ignored-gate");
    try {
      mkdirSync(candidate);
      execFileSync("git", ["init", "-q"], { cwd: candidate });
      const result = spawnSync(process.execPath, [fullGateReceiptRunner, outDir], {
        cwd: candidate,
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must be external");
      expect(existsSync(outDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("operator owner-review sealer", () => {
  it("derives a signed pass/warn pair from clean on-disk artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-v7-sealer-"));
    const candidate = join(root, "candidate");
    const evidence = join(root, "evidence");
    const artifacts = join(root, "artifacts");
    const gateDir = join(root, "gate");
    const gatePath = join(gateDir, "full-gate-receipt.json");
    const authorityPath = join(root, "authority.json");
    const privateKeyPath = join(root, "private.pem");
    const out = join(root, "attestation.json");
    const wave = "11111111-1111-4111-8111-111111111111";
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: candidate, encoding: "utf8" }).trim();
    try {
      mkdirSync(candidate);
      git("init", "-q");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "user.name", "fixture");
      write(join(candidate, "file.txt"), "base\n");
      write(join(candidate, "package.json"), json({ version: CLAUDEXOR_VERSION }));
      git("add", "file.txt");
      git("add", "package.json");
      git("commit", "-qm", "base");
      const baseSha = git("rev-parse", "HEAD");
      write(join(candidate, "file.txt"), "candidate\n");
      git("add", "file.txt");
      git("commit", "-qm", "candidate");
      const sha = git("rev-parse", "HEAD");
      const tree = git("rev-parse", "HEAD^{tree}");
      const diff = execFileSync("git", ["diff", "--binary", `${baseSha}..${sha}`], {
        cwd: candidate,
      });
      const verifierPath = join(gateDir, "release-review-verifier.mjs");
      const cliPath = join(gateDir, "claudexor.bundle.cjs");
      const verifierBuild = await bundleReleaseReviewVerifier(repoRoot, verifierPath);
      write(verifierPath, Buffer.from(verifierBuild.contents));
      // The packaged-CLI artifact still travels with the gate receipt; the
      // operator transport never executes it, so any candidate-stamped bytes
      // satisfy the digest binding here.
      write(cliPath, `#!/usr/bin/env node\n// Candidate ${sha}\n`);
      const reviewRuntimeArtifacts = [verifierPath, cliPath].map((path) => ({
        path: path.endsWith(".mjs") ? "release-review-verifier.mjs" : "claudexor.bundle.cjs",
        bytes: readFileSync(path).length,
        sha256: hash(readFileSync(path)),
      }));
      const gateStdoutPath = join(gateDir, "full-gate.stdout.log");
      const gateStderrPath = join(gateDir, "full-gate.stderr.log");
      write(gateStdoutPath, "release gate passed\n");
      write(gateStderrPath, "");
      const gate = {
        program: "pnpm",
        argv: ["pnpm", "release:verify"],
        exitCode: 0,
        gateExitCode: 0,
        candidateUnchanged: true,
        before: { head: sha, tree, status: "" },
        after: { head: sha, tree, status: "" },
        stdout: { path: gateStdoutPath, sha256: hash(readFileSync(gateStdoutPath)) },
        stderr: { path: gateStderrPath, sha256: hash(readFileSync(gateStderrPath)) },
        reviewRuntimeArtifacts,
        reviewRuntimeArtifactError: null,
        finishedAt: "2026-08-06T00:00:00.000Z",
      };
      const gateBytes = json(gate);
      write(gatePath, gateBytes);

      for (const file of FROZEN_REVIEW_EVIDENCE_FILES) write(join(evidence, file), "fixture\n");
      write(
        join(evidence, "FREEZE.json"),
        json({ candidateSha: sha, candidateTree: tree, baseSha, waveId: wave }),
      );
      write(join(evidence, "DIFF.patch"), diff);
      write(join(evidence, "context/gates/FULL_GATE_RECEIPT.json"), gateBytes);
      const packetFiles = [
        ...FROZEN_REVIEW_EVIDENCE_FILES,
        "context/gates/FULL_GATE_RECEIPT.json",
      ].sort();
      write(
        join(evidence, "MANIFEST.sha256"),
        packetFiles
          .map((file) => `${hash(readFileSync(join(evidence, file)))}  ${file}`)
          .join("\n") + "\n",
      );
      const manifestSha256 = hash(readFileSync(join(evidence, "MANIFEST.sha256")));
      const diffSha256 = hash(diff);

      // Operator-attested artifacts preserve actual models/harnesses without
      // making the sealer a vendor model inventory or execution verifier.
      const reviewerDirs = {
        fable: join(artifacts, "01-reviewer-1"),
        sol: join(artifacts, "02-reviewer-2"),
      };
      const reports = {
        fable: "# First review\n\nNo blocking findings. PASS.\n",
        sol: "# Second review\n\nOne non-blocking observation. WARN.\n",
      };
      const metadataFor = (slot: "fable" | "sol") => ({
        slot: slot === "fable" ? "reviewer-1" : "reviewer-2",
        model_family: slot === "fable" ? "fable-5" : "gpt-5.6-sol",
        model: slot === "fable" ? "claude-fable-5-thinking-max" : "gpt-5.6-sol-medium",
        harness: slot === "fable" ? "cursor" : "codex",
        candidate_sha: sha,
        candidate_tree: tree,
        packet_manifest_sha256: manifestSha256,
        review_wave_id: wave,
        diff_sha256: `sha256:${diffSha256}`,
        started_at: slot === "fable" ? "2026-08-06T00:00:00.000Z" : "2026-08-06T00:00:01.000Z",
        completed_at: slot === "fable" ? "2026-08-06T00:10:00.000Z" : "2026-08-06T00:09:00.000Z",
        verdict: slot === "fable" ? "pass" : "warn",
        review_scope: "full",
        report_sha256: hash(reports[slot]),
      });
      for (const slot of ["fable", "sol"] as const) {
        write(join(reviewerDirs[slot], "report.md"), reports[slot]);
        write(join(reviewerDirs[slot], "metadata.json"), json(metadataFor(slot)));
      }

      const keys = generateKeyPairSync("ed25519");
      write(
        authorityPath,
        json({
          schemaVersion: 1,
          keyId: "fixture-key",
          algorithm: "Ed25519",
          publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        }),
      );
      write(privateKeyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
      chmodSync(privateKeyPath, 0o600);
      const runSealer = (output: string, receipt = gatePath, base64Out?: string) =>
        spawnSync(
          process.execPath,
          [
            sealer,
            "--full-gate-receipt",
            receipt,
            "--evidence-dir",
            evidence,
            "--review-artifacts",
            artifacts,
            "--private-key",
            privateKeyPath,
            "--authority",
            authorityPath,
            "--out",
            output,
            ...(base64Out ? ["--base64-out", base64Out] : []),
          ],
          { cwd: candidate, encoding: "utf8" },
        );
      const result = runSealer(out);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
        schemaVersion: 7,
        payload: {
          candidateSha: sha,
          candidateVersion: CLAUDEXOR_VERSION,
          reviewProtocol: "owner-review-two-model-families-v1",
          reviews: [
            {
              slot: "reviewer-1",
              modelFamily: "fable-5",
              model: "claude-fable-5-thinking-max",
              harness: "cursor",
              verdict: "pass",
              reviewScope: "full",
              reportSha256: hash(reports.fable),
            },
            {
              slot: "reviewer-2",
              modelFamily: "gpt-5.6-sol",
              model: "gpt-5.6-sol-medium",
              harness: "codex",
              verdict: "warn",
              reviewScope: "full",
              reportSha256: hash(reports.sol),
            },
          ],
        },
      });

      const partialGatePath = join(gateDir, "partial-full-gate-receipt.json");
      const partialGate = structuredClone(gate) as any;
      delete partialGate.gateExitCode;
      write(partialGatePath, json(partialGate));
      const partialGateRefused = runSealer(
        join(root, "partial-gate-refused.json"),
        partialGatePath,
      );
      expect(partialGateRefused.status).toBe(1);
      expect(partialGateRefused.stderr).toContain("full-gate receipt shape is invalid");

      write(gateStdoutPath, "tampered gate output\n");
      const logDriftRefused = runSealer(join(root, "log-drift-refused.json"));
      expect(logDriftRefused.status).toBe(1);
      expect(logDriftRefused.stderr).toContain("digest does not match");
      write(gateStdoutPath, "release gate passed\n");

      const inTreeGate = join(candidate, ".git", "review-gate");
      const inTreeReceipt = join(inTreeGate, "full-gate-receipt.json");
      write(inTreeReceipt, readFileSync(gatePath));
      write(join(inTreeGate, "release-review-verifier.mjs"), readFileSync(verifierPath));
      write(join(inTreeGate, "claudexor.bundle.cjs"), readFileSync(cliPath));
      const inTreeGateRefused = runSealer(join(root, "in-tree-gate-refused.json"), inTreeReceipt);
      expect(inTreeGateRefused.status).toBe(1);
      expect(inTreeGateRefused.stderr).toContain("must be external and non-overlapping");
      const verifierBytes = readFileSync(verifierPath);
      write(verifierPath, Buffer.concat([verifierBytes, Buffer.from("\n// drift\n")]));
      const runtimeDriftRefused = runSealer(join(root, "runtime-drift-refused.json"));
      expect(runtimeDriftRefused.status).toBe(1);
      expect(runtimeDriftRefused.stderr).toContain("drifted after full gate");
      write(verifierPath, verifierBytes);
      const sameOutput = join(root, "same-output.json");
      const sameOutputRefused = spawnSync(
        process.execPath,
        [
          sealer,
          "--full-gate-receipt",
          gatePath,
          "--evidence-dir",
          evidence,
          "--review-artifacts",
          artifacts,
          "--private-key",
          privateKeyPath,
          "--authority",
          authorityPath,
          "--out",
          sameOutput,
          "--base64-out",
          `${root}/unused/../same-output.json`,
        ],
        { cwd: candidate, encoding: "utf8" },
      );
      expect(sameOutputRefused.status).toBe(1);
      expect(sameOutputRefused.stderr).toContain("must be different paths");

      // Tampered report bytes: the metadata digest binding refuses.
      const solReportPath = join(reviewerDirs.sol, "report.md");
      write(solReportPath, reports.sol + "drift\n");
      const reportDriftRefused = runSealer(join(root, "report-drift-refused.json"));
      expect(reportDriftRefused.status).toBe(1);
      expect(reportDriftRefused.stderr).toContain("does not match its metadata binding");
      write(solReportPath, reports.sol);

      // A verdict outside pass|warn refuses (fail-closed blocking verdicts).
      const solMetadataPath = join(reviewerDirs.sol, "metadata.json");
      write(solMetadataPath, json({ ...metadataFor("sol"), verdict: "block" }));
      const blockingRefused = runSealer(join(root, "blocking-refused.json"));
      expect(blockingRefused.status).toBe(1);
      expect(blockingRefused.stderr).toContain("is not pass or warn");

      // A family outside the approved set refuses without guessing from slugs.
      write(solMetadataPath, json({ ...metadataFor("sol"), model_family: "other-model" }));
      const substituteRefused = runSealer(join(root, "substitute-refused.json"));
      expect(substituteRefused.status).toBe(1);
      expect(substituteRefused.stderr).toContain("outside the owner-approved set");

      write(
        solMetadataPath,
        json({ ...metadataFor("sol"), model_family: "fable-5", model: "vendor/fable-5" }),
      );
      const duplicateFamilyRefused = runSealer(join(root, "duplicate-family-refused.json"));
      expect(duplicateFamilyRefused.status).toBe(1);
      expect(duplicateFamilyRefused.stderr).toContain("model families must be distinct");

      for (const field of ["model", "harness"] as const) {
        write(solMetadataPath, json({ ...metadataFor("sol"), [field]: "  " }));
        const blankRefused = runSealer(join(root, `blank-${field}-refused.json`));
        expect(blankRefused.status).toBe(1);
        expect(blankRefused.stderr).toContain(`${field} must be a nonempty string`);
      }

      // Non-overlapping executions refuse: the pair must run concurrently.
      write(
        solMetadataPath,
        json({
          ...metadataFor("sol"),
          started_at: "2026-08-06T00:20:00.000Z",
          completed_at: "2026-08-06T00:30:00.000Z",
        }),
      );
      const overlapRefused = runSealer(join(root, "overlap-refused.json"));
      expect(overlapRefused.status).toBe(1);
      expect(overlapRefused.stderr).toContain("did not overlap");

      // A delta review scope refuses: both slots must review the full context.
      write(solMetadataPath, json({ ...metadataFor("sol"), review_scope: "delta" }));
      const deltaScopeRefused = runSealer(join(root, "delta-scope-refused.json"));
      expect(deltaScopeRefused.status).toBe(1);
      expect(deltaScopeRefused.stderr).toContain("is not full");

      // A boolean review scope refuses the same way.
      write(solMetadataPath, json({ ...metadataFor("sol"), review_scope: false }));
      const falseScopeRefused = runSealer(join(root, "false-scope-refused.json"));
      expect(falseScopeRefused.status).toBe(1);
      expect(falseScopeRefused.stderr).toContain("is not full");

      // A missing review_scope refuses on the exact-key metadata shape.
      const { review_scope: _omitted, ...withoutScope } = metadataFor("sol");
      write(solMetadataPath, json(withoutScope));
      const missingScopeRefused = runSealer(join(root, "missing-scope-refused.json"));
      expect(missingScopeRefused.status).toBe(1);
      expect(missingScopeRefused.stderr).toContain("metadata shape is invalid");

      // An extra unknown metadata key refuses: nothing is silently ignored.
      write(solMetadataPath, json({ ...metadataFor("sol"), full_context: true }));
      const extraKeyRefused = runSealer(join(root, "extra-key-refused.json"));
      expect(extraKeyRefused.status).toBe(1);
      expect(extraKeyRefused.stderr).toContain("metadata shape is invalid");
      write(solMetadataPath, json(metadataFor("sol")));

      // A report quoting credential-shaped synthetic fixtures (review evidence
      // about auth code; assembled at runtime) seals exactly (INV-146): its
      // digest is bound and signed, and neither output carries any report text.
      const fixtureBearer = ["fixture", "token", "not", "a", "credential"].join("-");
      const fixtureKey = `${["sk", "ant", "api03"].join("-")}-${"a".repeat(93)}`;
      const fixtureReport =
        `${reports.sol}\nQuoted fixtures:\n` +
        `- Authorization: ${["Bear", "er"].join("")} ${fixtureBearer}\n- ${fixtureKey}\n`;
      write(solReportPath, fixtureReport);
      write(solMetadataPath, json({ ...metadataFor("sol"), report_sha256: hash(fixtureReport) }));
      const fixtureOut = join(root, "fixture-report-attestation.json");
      const fixtureBase64 = join(root, "fixture-report-attestation.b64");
      const fixtureSealed = runSealer(fixtureOut, gatePath, fixtureBase64);
      expect(fixtureSealed.stderr).toBe("");
      expect(fixtureSealed.status).toBe(0);
      const sealedJson = readFileSync(fixtureOut, "utf8");
      expect(JSON.parse(sealedJson).payload.reviews[1]).toMatchObject({
        slot: "reviewer-2",
        reportSha256: hash(fixtureReport),
      });
      const sealedBase64 = Buffer.from(readFileSync(fixtureBase64, "utf8").trim(), "base64");
      for (const published of [sealedJson, sealedBase64.toString("utf8")])
        for (const fragment of ["Quoted fixtures", fixtureBearer, fixtureKey])
          expect(published).not.toContain(fragment);

      // Strict UTF-8 still refuses report bytes that are not text, even bound.
      const invalidUtf8 = Buffer.concat([Buffer.from(reports.sol), Buffer.from([0xc3, 0x28])]);
      write(solReportPath, invalidUtf8);
      write(solMetadataPath, json({ ...metadataFor("sol"), report_sha256: hash(invalidUtf8) }));
      const invalidUtf8Refused = runSealer(join(root, "invalid-utf8-refused.json"));
      expect(invalidUtf8Refused.status).toBe(1);
      expect(invalidUtf8Refused.stderr).toContain("reviewer report is not valid UTF-8");
      write(solReportPath, reports.sol);
      write(solMetadataPath, json(metadataFor("sol")));

      // A missing report file refuses: both artifacts are mandatory.
      rmSync(join(reviewerDirs.fable, "report.md"));
      const missingRefused = runSealer(join(root, "missing-refused.json"));
      expect(missingRefused.status).toBe(1);
      write(join(reviewerDirs.fable, "report.md"), reports.fable);

      // Different slugs, families and harnesses seal without an alias catalog.
      const fableMetadataPath = join(reviewerDirs.fable, "metadata.json");
      write(
        fableMetadataPath,
        json({ ...metadataFor("fable"), model: "claude-fable-5-thinking-medium" }),
      );
      write(
        solMetadataPath,
        json({
          ...metadataFor("sol"),
          model_family: "kimi-k3",
          model: "moonshot/kimi-k3",
          harness: "another-harness",
        }),
      );
      const alternateOut = join(root, "alternate-model-attestation.json");
      const alternateResult = runSealer(alternateOut);
      expect(alternateResult.stderr).toBe("");
      expect(alternateResult.status).toBe(0);
      expect(
        JSON.parse(readFileSync(alternateOut, "utf8")).payload.reviews.map((review: any) => [
          review.modelFamily,
          review.model,
          review.harness,
        ]),
      ).toEqual([
        ["fable-5", "claude-fable-5-thinking-medium", "cursor"],
        ["kimi-k3", "moonshot/kimi-k3", "another-harness"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
