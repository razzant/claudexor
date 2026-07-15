import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUIRED_RELEASE_REVIEW_SLOTS,
  REQUIRED_SCOPE_MODEL,
  REQUIRED_TRIAD_MODELS,
  SCOPE_ITEMS,
  TRIAD_ITEMS,
  panelLockText,
  validateReleaseAttestation,
} from "../../../scripts/lib/release-review-contract.mjs";
import {
  sealReleaseReviewAttestation,
  sha256File,
} from "../../../scripts/lib/release-review-attestation.mjs";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeManifest(packet: string, names: string[]): string {
  const text = `${names.map((name) => `${sha256File(join(packet, name))}  ${name}`).join("\n")}\n`;
  writeFileSync(join(packet, "MANIFEST.sha256"), text);
  return sha256(text);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "claudexor-signed-review-"));
  roots.push(root);
  const candidateSha = "a".repeat(40);
  const candidateTree = "b".repeat(40);
  const packet = join(root, "packet");
  const verification = join(root, "verification");
  const tier1 = join(root, "tier1");
  const triad = join(root, "triad");
  mkdirSync(packet, { recursive: true });
  mkdirSync(verification, { recursive: true });
  mkdirSync(tier1, { recursive: true });
  mkdirSync(triad, { recursive: true });

  const stdoutPath = join(verification, "stdout.log");
  const stderrPath = join(verification, "stderr.log");
  writeFileSync(stdoutPath, "green\n");
  writeFileSync(stderrPath, "");
  const receiptPath = join(verification, "full-gate.receipt.json");
  const receipt = {
    exitCode: 0,
    candidateUnchanged: true,
    before: { head: candidateSha, tree: candidateTree, status: "" },
    after: { head: candidateSha, tree: candidateTree, status: "" },
    stdout: { path: stdoutPath, sha256: sha256File(stdoutPath) },
    stderr: { path: stderrPath, sha256: sha256File(stderrPath) },
  };
  writeJson(receiptPath, receipt);
  writeJson(join(packet, "FREEZE.json"), { candidateSha, candidateTree });
  writeJson(join(packet, "FINGERPRINTS.json"), { candidateSha, candidateTree });
  writeJson(join(packet, "TEST_RESULTS.json"), {
    exitCode: 0,
    candidateUnchanged: true,
    receiptSha256: sha256File(receiptPath),
  });
  writeFileSync(join(packet, "EVIDENCE.txt"), "sealed\n");
  const packetManifestSha256 = writeManifest(packet, [
    "EVIDENCE.txt",
    "FINGERPRINTS.json",
    "FREEZE.json",
    "TEST_RESULTS.json",
  ]);

  cpSync(packet, join(tier1, "evidence"), { recursive: true });
  writeFileSync(join(tier1, "reviewer-progress.jsonl"), '{"type":"reviewer.completed"}\n');
  for (const [index, required] of REQUIRED_RELEASE_REVIEW_SLOTS.slice(0, 2).entries()) {
    const dir = join(tier1, `${String(index + 1).padStart(2, "0")}-${required.route}`);
    mkdirSync(dir);
    writeJson(join(dir, "metadata.json"), {
      status: "completed",
      route_proof_status: "verified",
      harness_id: required.route,
      requested_model: required.model,
      observed_model: required.model,
      requested_effort: required.effort,
      candidate_sha: candidateSha,
      candidate_tree: candidateTree,
      packet_manifest_sha256: packetManifestSha256,
      start_time: "2026-07-15T00:00:00.000Z",
      first_event_time: "2026-07-15T00:00:01.000Z",
      completion_time: "2026-07-15T00:00:02.000Z",
      duration_ms: 2000,
    });
    writeJson(join(dir, "parsed-json-blocks.json"), [[]]);
    writeFileSync(join(dir, "raw-normalized-stream.jsonl"), "{}\n");
    writeFileSync(join(dir, "transcript.md"), "[]\n");
    writeFileSync(join(dir, "prompt.md"), "review\n");
  }

  writeFileSync(join(triad, "reviewer-progress.jsonl"), '{"type":"reviewer.completed"}\n');
  const triadActors = REQUIRED_TRIAD_MODELS.map((model, index) => {
    const slug = model.replace(/[^a-z0-9.-]+/gi, "_");
    const rows = TRIAD_ITEMS.map((item) => ({
      item,
      verdict: "PASS",
      severity: "advisory",
      reason: `${item} passed`,
    }));
    const metadata = {
      requested_model: model,
      requested_effort: null,
      observed_model: model,
      finish_reason: "stop",
      status: "responded",
      started_at: "2026-07-15T00:00:00.000Z",
      first_event_at: "2026-07-15T00:00:01.000Z",
      completed_at: "2026-07-15T00:00:02.000Z",
      findings: rows.map((row) => ({ ...row, model })),
    };
    writeJson(join(triad, `triad-${slug}.metadata.json`), metadata);
    writeFileSync(join(triad, `triad-${slug}.raw.txt`), JSON.stringify(rows));
    writeJson(join(triad, `triad-${slug}.parsed-json-blocks.json`), rows);
    return { ...metadata, slot: index + 1 };
  });
  const scopeRows = SCOPE_ITEMS.map((item) => ({
    item,
    verdict: "PASS",
    severity: "advisory",
    reason: `${item} passed`,
  }));
  const scopeMetadata = {
    requested_model: REQUIRED_SCOPE_MODEL,
    requested_effort: null,
    observed_model: REQUIRED_SCOPE_MODEL,
    finish_reason: "stop",
    status: "responded",
    started_at: "2026-07-15T00:00:00.000Z",
    first_event_at: "2026-07-15T00:00:01.000Z",
    completed_at: "2026-07-15T00:00:02.000Z",
    findings: scopeRows.map((row) => ({ ...row, model: REQUIRED_SCOPE_MODEL })),
  };
  writeJson(join(triad, "scope.metadata.json"), scopeMetadata);
  writeFileSync(join(triad, "scope.raw.txt"), JSON.stringify(scopeRows));
  writeJson(join(triad, "scope.parsed-json-blocks.json"), scopeRows);
  writeJson(join(triad, "summary.json"), {
    candidate_sha: candidateSha,
    candidate_tree: candidateTree,
    packet_manifest_sha256: packetManifestSha256,
    panel: { triad: REQUIRED_TRIAD_MODELS, scope: REQUIRED_SCOPE_MODEL },
    triad: { actors: triadActors },
    scope: { metadata: scopeMetadata },
    decision: { passed: true, blockingFindings: [] },
  });

  const panelLock = join(root, "panel.lock");
  writeFileSync(panelLock, panelLockText({ candidateSha, candidateTree, packetManifestSha256 }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(root, "private.pem");
  const authorityPath = join(root, "authority.json");
  writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  const authority = {
    keyId: "fixture-ed25519",
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  writeJson(authorityPath, authority);
  return {
    expected: { candidateSha, candidateTree },
    authority,
    missingArtifact: join(tier1, "01-codex", "transcript.md"),
    input: {
      packetDir: packet,
      packetManifestSha256,
      fullGateReceipt: receiptPath,
      tier1Dir: tier1,
      triadDir: triad,
      panelLock,
      privateKeyPath,
      authorityPath,
    },
  };
}

describe("signed release review attestation sealer", () => {
  it("seals only complete exact artifacts and produces verifiable schema v2", () => {
    const fixture = makeFixture();
    const attestation = sealReleaseReviewAttestation(fixture.input);
    expect(attestation.schemaVersion).toBe(2);
    expect(attestation.payload.slots).toHaveLength(6);
    expect(attestation.payload.slots[0].artifacts).toContainEqual({
      name: "transcript.md",
      sha256: sha256File(fixture.missingArtifact),
    });
    expect(validateReleaseAttestation(attestation, fixture.authority, fixture.expected)).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("refuses to seal an incomplete reviewer artifact set", () => {
    const fixture = makeFixture();
    rmSync(fixture.missingArtifact);
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/artifact is missing/);
  });

  it("refuses packet bytes changed after the evidence manifest was sealed", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.input.packetDir, "EVIDENCE.txt"), "changed\n");
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/evidence digest mismatch/);
  });
});
