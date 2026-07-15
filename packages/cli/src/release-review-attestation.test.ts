import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FROZEN_REVIEW_EVIDENCE_FILES } from "@claudexor/context";
import {
  REQUIRED_RELEASE_REVIEW_SLOTS,
  RELEASE_NATIVE_CHECKLIST_ITEMS,
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

function writeAccessibilityFixture(
  packet: string,
  candidateSha: string,
  candidateTree: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  authority: { keyId: string; algorithm: string; publicKeyPem: string },
  signatureVariant: "valid" | "forged",
  matrixCandidateSha: string = candidateSha,
): string[] {
  const root = join(packet, "manual-accessibility");
  const screenshots = join(root, "screenshots");
  mkdirSync(screenshots, { recursive: true });
  const matrix = `# Manual accessibility\n\n- Candidate: \`${matrixCandidateSha}\`\n- Candidate tree: \`${candidateTree}\`\n- Result: PASS\n`;
  const matrixPath = join(root, "MANUAL_ACCESSIBILITY_MATRIX.md");
  const signaturePath = join(root, "MANUAL_ACCESSIBILITY_MATRIX.ed25519.sig");
  writeFileSync(matrixPath, matrix);
  writeFileSync(signaturePath, sign(null, Buffer.from(matrix), privateKey));
  if (signatureVariant === "forged") writeFileSync(signaturePath, "forged signature");
  for (const name of [
    "keyboard-full-navigation.log",
    "keyboard-shortcuts.log",
    "voiceover-ax-controls.log",
  ]) {
    writeFileSync(join(root, name), `${name} passed\n`);
  }
  for (const name of [
    "dark-reduce-transparency-window.png",
    "dark-wide-window.png",
    "light-compact-window.png",
    "light-increase-contrast-window.png",
    "light-settings-window.png",
  ]) {
    writeFileSync(join(screenshots, name), `${name} fixture\n`);
  }
  writeJson(join(root, "MANUAL_ACCESSIBILITY_SIGNATURE.json"), {
    schemaVersion: 1,
    candidateSha,
    candidateTree,
    appTree: "d".repeat(40),
    matrix: "MANUAL_ACCESSIBILITY_MATRIX.md",
    matrixSha256: sha256File(matrixPath),
    signature: "MANUAL_ACCESSIBILITY_MATRIX.ed25519.sig",
    signatureSha256: sha256File(signaturePath),
    algorithm: "Ed25519",
    keyId: authority.keyId,
    authority: "release/review-attestation-authority.json",
    verified: true,
    performedAt: "2026-07-15T00:00:00.000Z",
  });
  return [
    "manual-accessibility/MANUAL_ACCESSIBILITY_MATRIX.md",
    "manual-accessibility/MANUAL_ACCESSIBILITY_MATRIX.ed25519.sig",
    "manual-accessibility/MANUAL_ACCESSIBILITY_SIGNATURE.json",
    "manual-accessibility/keyboard-full-navigation.log",
    "manual-accessibility/keyboard-shortcuts.log",
    "manual-accessibility/voiceover-ax-controls.log",
    "manual-accessibility/screenshots/dark-reduce-transparency-window.png",
    "manual-accessibility/screenshots/dark-wide-window.png",
    "manual-accessibility/screenshots/light-compact-window.png",
    "manual-accessibility/screenshots/light-increase-contrast-window.png",
    "manual-accessibility/screenshots/light-settings-window.png",
  ];
}

function makeFixture(
  accessibility: "valid" | "missing" | "forged" | "wrong_binding" = "valid",
  gateCommand: "valid" | "missing" | "wrong" = "valid",
) {
  const root = mkdtempSync(join(tmpdir(), "claudexor-signed-review-"));
  roots.push(root);
  const candidateSha = "a".repeat(40);
  const candidateTree = "b".repeat(40);
  const reviewWaveId = "11111111-1111-4111-8111-111111111111";
  const reviewRunId = "triad-run-fixture";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const authority = {
    keyId: "fixture-ed25519",
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
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
    ...(gateCommand === "missing"
      ? {}
      : gateCommand === "wrong"
        ? { program: "node", argv: ["node", "smoke.mjs"] }
        : { program: "pnpm", argv: ["pnpm", "release:verify"] }),
    exitCode: 0,
    candidateUnchanged: true,
    before: { head: candidateSha, tree: candidateTree, status: "" },
    after: { head: candidateSha, tree: candidateTree, status: "" },
    stdout: { path: stdoutPath, sha256: sha256File(stdoutPath) },
    stderr: { path: stderrPath, sha256: sha256File(stderrPath) },
  };
  writeJson(receiptPath, receipt);
  writeJson(join(packet, "FREEZE.json"), {
    baseSha: "c".repeat(40),
    candidateSha,
    candidateTree,
  });
  writeJson(join(packet, "FINGERPRINTS.json"), { candidateSha, candidateTree });
  writeJson(join(packet, "TEST_RESULTS.json"), {
    program: receipt.program,
    argv: receipt.argv,
    exitCode: 0,
    candidateUnchanged: true,
    receiptSha256: sha256File(receiptPath),
  });
  const structuredFiles = new Set(["FREEZE.json", "FINGERPRINTS.json", "TEST_RESULTS.json"]);
  for (const name of FROZEN_REVIEW_EVIDENCE_FILES) {
    if (!structuredFiles.has(name)) writeFileSync(join(packet, name), `${name} sealed\n`);
  }
  writeFileSync(join(packet, "EVIDENCE.txt"), "sealed\n");
  const accessibilityFiles =
    accessibility === "missing"
      ? []
      : writeAccessibilityFixture(
          packet,
          candidateSha,
          candidateTree,
          privateKey,
          authority,
          accessibility === "forged" ? "forged" : "valid",
          accessibility === "wrong_binding" ? "e".repeat(40) : candidateSha,
        );
  const packetFiles = [...FROZEN_REVIEW_EVIDENCE_FILES, "EVIDENCE.txt", ...accessibilityFiles];
  const packetManifestSha256 = writeManifest(packet, packetFiles);

  cpSync(packet, join(tier1, "evidence"), { recursive: true });
  const tier1Progress: unknown[] = [];
  for (const [index, required] of REQUIRED_RELEASE_REVIEW_SLOTS.slice(0, 2).entries()) {
    const dir = join(tier1, `${String(index + 1).padStart(2, "0")}-${required.route}`);
    mkdirSync(dir);
    const startTime = `2026-07-15T00:00:00.${String(index * 100).padStart(3, "0")}Z`;
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
      review_wave_id: reviewWaveId,
      start_time: startTime,
      first_event_time: "2026-07-15T00:00:01.000Z",
      completion_time: "2026-07-15T00:00:02.000Z",
      duration_ms: 2000,
    });
    const response = {
      completion: {
        verdict: "PASS",
        checklist: RELEASE_NATIVE_CHECKLIST_ITEMS.map((item) => ({ item, completed: true })),
        findingCount: 0,
      },
      findings: [],
    };
    writeJson(join(dir, "parsed-json-blocks.json"), [response]);
    writeFileSync(join(dir, "raw-normalized-stream.jsonl"), "{}\n");
    writeFileSync(join(dir, "transcript.md"), "[]\n");
    writeFileSync(join(dir, "prompt.md"), "review\n");
    tier1Progress.push(
      {
        type: "reviewer.started",
        harness_id: required.route,
        requested_model: required.model,
        requested_effort: required.effort,
        review_wave_id: reviewWaveId,
        at: startTime,
      },
      {
        type: "reviewer.completed",
        harness_id: required.route,
        requested_model: required.model,
        requested_effort: required.effort,
        review_wave_id: reviewWaveId,
        at: "2026-07-15T00:00:02.000Z",
      },
    );
  }
  writeFileSync(
    join(tier1, "reviewer-progress.jsonl"),
    `${tier1Progress.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );

  const triadProgress: unknown[] = [];
  writeFileSync(join(triad, "triad-prompt.md"), "triad prompt\n");
  writeFileSync(join(triad, "scope-prompt.md"), "scope prompt\n");
  const promptSha256 = {
    triad: sha256File(join(triad, "triad-prompt.md")),
    scope: sha256File(join(triad, "scope-prompt.md")),
  };
  const triadActors = REQUIRED_TRIAD_MODELS.map((model, index) => {
    const slug = model.replace(/[^a-z0-9.-]+/gi, "_");
    const rows = TRIAD_ITEMS.map((item) => ({
      item,
      verdict: "PASS",
      severity: "advisory",
      reason: `${item} passed`,
    }));
    const startedAt = `2026-07-15T00:00:00.${String(300 + index * 100).padStart(3, "0")}Z`;
    const metadata = {
      candidateSha,
      candidateTree,
      packetManifestSha256,
      promptSha256: promptSha256.triad,
      reviewRunId,
      reviewWaveId,
      model_id: model,
      requested_model: model,
      requested_effort: null,
      observed_model: model,
      finish_reason: "stop",
      status: "responded",
      started_at: startedAt,
      first_event_at: "2026-07-15T00:00:01.000Z",
      completed_at: "2026-07-15T00:00:02.000Z",
      findings: rows.map((row) => ({ ...row, model })),
      slot: index + 1,
    };
    writeJson(join(triad, `triad-${slug}.metadata.json`), metadata);
    writeFileSync(join(triad, `triad-${slug}.raw.txt`), JSON.stringify(rows));
    writeJson(join(triad, `triad-${slug}.parsed-json-blocks.json`), rows);
    triadProgress.push(
      { ts: startedAt, type: "reviewer.started", model, reviewRunId, reviewWaveId },
      {
        ts: "2026-07-15T00:00:02.000Z",
        type: "reviewer.completed",
        model,
        reviewRunId,
        reviewWaveId,
      },
    );
    return metadata;
  });
  const scopeRows = SCOPE_ITEMS.map((item) => ({
    item,
    verdict: "PASS",
    severity: "advisory",
    reason: `${item} passed`,
  }));
  const scopeMetadata = {
    candidateSha,
    candidateTree,
    packetManifestSha256,
    promptSha256: promptSha256.scope,
    reviewRunId,
    reviewWaveId,
    model_id: REQUIRED_SCOPE_MODEL,
    requested_model: REQUIRED_SCOPE_MODEL,
    requested_effort: null,
    observed_model: REQUIRED_SCOPE_MODEL,
    finish_reason: "stop",
    status: "responded",
    started_at: "2026-07-15T00:00:00.600Z",
    first_event_at: "2026-07-15T00:00:01.000Z",
    completed_at: "2026-07-15T00:00:02.000Z",
    findings: scopeRows.map((row) => ({ ...row, model: REQUIRED_SCOPE_MODEL })),
  };
  writeJson(join(triad, "scope.metadata.json"), scopeMetadata);
  writeFileSync(join(triad, "scope.raw.txt"), JSON.stringify(scopeRows));
  writeJson(join(triad, "scope.parsed-json-blocks.json"), scopeRows);
  triadProgress.push(
    {
      ts: "2026-07-15T00:00:00.600Z",
      type: "reviewer.started",
      model: REQUIRED_SCOPE_MODEL,
      role: "scope",
      reviewRunId,
      reviewWaveId,
    },
    {
      ts: "2026-07-15T00:00:02.000Z",
      type: "reviewer.completed",
      model: REQUIRED_SCOPE_MODEL,
      role: "scope",
      reviewRunId,
      reviewWaveId,
    },
  );
  writeFileSync(
    join(triad, "reviewer-progress.jsonl"),
    `${triadProgress.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  writeJson(join(triad, "summary.json"), {
    reviewRunId,
    reviewWaveId,
    promptSha256,
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
  const privateKeyPath = join(root, "private.pem");
  const authorityPath = join(root, "authority.json");
  writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  writeJson(authorityPath, authority);
  return {
    expected: { candidateSha, candidateTree },
    authority,
    packet,
    packetFiles,
    missingArtifact: join(tier1, "01-codex", "transcript.md"),
    nativeParsed: join(tier1, "01-codex", "parsed-json-blocks.json"),
    nativeParseError: join(tier1, "01-codex", "parse-error.json"),
    tier1Progress: join(tier1, "reviewer-progress.jsonl"),
    triadPrompt: join(triad, "triad-prompt.md"),
    triadMetadata: join(
      triad,
      `triad-${REQUIRED_TRIAD_MODELS[0]!.replace(/[^a-z0-9.-]+/gi, "_")}.metadata.json`,
    ),
    triadSummary: join(triad, "summary.json"),
    tier1Metadata: REQUIRED_RELEASE_REVIEW_SLOTS.slice(0, 2).map((required, index) =>
      join(tier1, `${String(index + 1).padStart(2, "0")}-${required.route}`, "metadata.json"),
    ),
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
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/manifest digest mismatch/);
  });

  it("refuses a manifest and packet that omit a mandatory frozen evidence file", () => {
    const fixture = makeFixture();
    rmSync(join(fixture.packet, "USER_INTENT.md"));
    fixture.input.packetManifestSha256 = writeManifest(
      fixture.packet,
      fixture.packetFiles.filter((name) => name !== "USER_INTENT.md"),
    );
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/sealed packet is missing/);
  });

  it("refuses an unsealed extra file beside an otherwise complete packet", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.packet, "UNSEALED.txt"), "not in manifest\n");
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/unsealed packet file/);
  });

  it("refuses a self-consistent packet that omits required manual accessibility evidence", () => {
    const fixture = makeFixture("missing");
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(
      /manual accessibility artifact is missing/,
    );
  });

  it.each(["missing", "wrong"] as const)(
    "refuses a self-consistent full-gate receipt with a %s command",
    (gateCommand) => {
      const fixture = makeFixture("valid", gateCommand);
      expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(
        /full-gate command must be pnpm release:verify/,
      );
    },
  );

  it("refuses a manifest-sealed forged manual accessibility signature", () => {
    const fixture = makeFixture("forged");
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(
      /manual accessibility signature verification failed/,
    );
  });

  it("refuses a validly signed accessibility matrix bound to another candidate", () => {
    const fixture = makeFixture("wrong_binding");
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(
      /manual accessibility matrix is not bound to the candidate/,
    );
  });

  it.each([
    ["empty array", []],
    ["object array", [{}]],
    [
      "missing verdict",
      [
        {
          completion: {
            checklist: RELEASE_NATIVE_CHECKLIST_ITEMS.map((item) => ({ item, completed: true })),
            findingCount: 0,
          },
          findings: [],
        },
      ],
    ],
    ["missing checklist", [{ completion: { verdict: "PASS", findingCount: 0 }, findings: [] }]],
    [
      "incomplete checklist",
      [
        {
          completion: {
            verdict: "PASS",
            checklist: RELEASE_NATIVE_CHECKLIST_ITEMS.slice(0, -1).map((item) => ({
              item,
              completed: true,
            })),
            findingCount: 0,
          },
          findings: [],
        },
      ],
    ],
  ])("refuses native release output with %s", (_name, parsed) => {
    const fixture = makeFixture();
    writeJson(fixture.nativeParsed, parsed);
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/completion/);
  });

  it("accepts byte-identical duplicate native PASS envelopes", () => {
    const fixture = makeFixture();
    const parsed = JSON.parse(readFileSync(fixture.nativeParsed, "utf8"));
    writeJson(fixture.nativeParsed, [parsed[0], parsed[0]]);
    expect(() => sealReleaseReviewAttestation(fixture.input)).not.toThrow();
  });

  it("refuses conflicting duplicate native completion envelopes", () => {
    const fixture = makeFixture();
    const parsed = JSON.parse(readFileSync(fixture.nativeParsed, "utf8"));
    writeJson(fixture.nativeParsed, [
      parsed[0],
      {
        ...parsed[0],
        completion: { ...parsed[0].completion, verdict: "FAIL" },
      },
    ]);
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/conflicting duplicates/);
  });

  it("refuses a native completion whose finding count does not match findings", () => {
    const fixture = makeFixture();
    writeJson(fixture.nativeParsed, [
      {
        completion: {
          verdict: "PASS",
          checklist: RELEASE_NATIVE_CHECKLIST_ITEMS.map((item) => ({ item, completed: true })),
          findingCount: 1,
        },
        findings: [],
      },
    ]);
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/finding count/);
  });

  it("refuses an unknown native envelope field before normalization", () => {
    const fixture = makeFixture();
    const parsed = JSON.parse(readFileSync(fixture.nativeParsed, "utf8"));
    parsed[0].unexpected = true;
    writeJson(fixture.nativeParsed, parsed);
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/unsupported fields/);
  });

  it("refuses an unknown native completion field before normalization", () => {
    const fixture = makeFixture();
    const parsed = JSON.parse(readFileSync(fixture.nativeParsed, "utf8"));
    parsed[0].completion.unexpected = true;
    writeJson(fixture.nativeParsed, parsed);
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/unsupported fields/);
  });

  it("refuses an unknown native checklist field before normalization", () => {
    const fixture = makeFixture();
    const parsed = JSON.parse(readFileSync(fixture.nativeParsed, "utf8"));
    parsed[0].completion.checklist[0].unexpected = true;
    writeJson(fixture.nativeParsed, parsed);
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/unsupported fields/);
  });

  it("refuses an unknown raw finding field before adding trusted metadata", () => {
    const fixture = makeFixture();
    const parsed = JSON.parse(readFileSync(fixture.nativeParsed, "utf8"));
    parsed[0].completion.findingCount = 1;
    parsed[0].findings = [{ severity: "WARN", category: "test_gap", claim: "x", unexpected: true }];
    writeJson(fixture.nativeParsed, parsed);
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/unsupported fields/);
  });

  it("accepts a prompt-shaped advisory and binds reviewer identity from telemetry", () => {
    const fixture = makeFixture();
    writeJson(fixture.nativeParsed, [
      {
        completion: {
          verdict: "PASS",
          checklist: RELEASE_NATIVE_CHECKLIST_ITEMS.map((item) => ({ item, completed: true })),
          findingCount: 1,
        },
        findings: [
          {
            severity: "WARN",
            category: "test_gap",
            claim: "A nonblocking advisory follows the exact reviewer prompt shape.",
            evidence: { files: [{ path: "TESTS.txt", lines: null }] },
            proposed_fix: "Keep this item in the local punch list.",
          },
        ],
      },
    ]);
    expect(() => sealReleaseReviewAttestation(fixture.input)).not.toThrow();
  });

  it("refuses a malformed finding hidden inside an otherwise complete envelope", () => {
    const fixture = makeFixture();
    writeJson(fixture.nativeParsed, [
      {
        completion: {
          verdict: "PASS",
          checklist: RELEASE_NATIVE_CHECKLIST_ITEMS.map((item) => ({ item, completed: true })),
          findingCount: 1,
        },
        findings: [{}],
      },
    ]);
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(
      /violates ReviewFinding contract/,
    );
  });

  it("refuses a native finding outside the exact ReviewFinding category contract", () => {
    const fixture = makeFixture();
    writeJson(fixture.nativeParsed, [
      {
        completion: {
          verdict: "PASS",
          checklist: RELEASE_NATIVE_CHECKLIST_ITEMS.map((item) => ({ item, completed: true })),
          findingCount: 1,
        },
        findings: [
          {
            severity: "WARN",
            category: "release_protocol",
            claim: "The category is not part of the schema-owned review contract.",
            evidence: {
              files: [{ path: "scripts/lib/release-review-attestation.mjs", lines: null }],
              diff_hunks: [],
              commands: [],
              logs: [],
            },
            proposed_fix: null,
          },
        ],
      },
    ]);
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(
      /violates ReviewFinding contract/,
    );
  });

  it("refuses a Tier 1 parse-error artifact beside an otherwise valid response", () => {
    const fixture = makeFixture();
    writeJson(fixture.nativeParseError, { error: "review output contained a malformed block" });
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(
      /parse-error artifact must be absent/,
    );
  });

  it("refuses sequential reviewer starts split across directories", () => {
    const fixture = makeFixture();
    const rows = readFileSync(fixture.tier1Progress, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const [index, metadataPath] of fixture.tier1Metadata.entries()) {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      metadata.start_time = `2026-07-15T00:00:20.${String(index * 100).padStart(3, "0")}Z`;
      metadata.completion_time = "2026-07-15T00:00:22.000Z";
      writeJson(metadataPath, metadata);
    }
    for (const row of rows) {
      if (row.type === "reviewer.started") {
        const index = row.harness_id === "codex" ? 0 : 1;
        row.at = `2026-07-15T00:00:20.${String(index * 100).padStart(3, "0")}Z`;
      }
    }
    writeFileSync(fixture.tier1Progress, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/did not start in one wave/);
  });

  it("refuses triad metadata and summary stamped for a different candidate", () => {
    const fixture = makeFixture();
    const metadata = JSON.parse(readFileSync(fixture.triadMetadata, "utf8"));
    metadata.candidateSha = "c".repeat(40);
    writeJson(fixture.triadMetadata, metadata);
    const summary = JSON.parse(readFileSync(fixture.triadSummary, "utf8"));
    summary.triad.actors[0].candidateSha = "c".repeat(40);
    writeJson(fixture.triadSummary, summary);
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/triad-1 SHA mismatch/);
  });

  it("refuses a prompt changed after per-slot metadata was stamped", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.triadPrompt, "different prompt\n");
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/prompt digests mismatch/);
  });

  it("refuses native and triad artifacts stamped with different wave ids", () => {
    const fixture = makeFixture();
    const different = "22222222-2222-4222-8222-222222222222";
    const summary = JSON.parse(readFileSync(fixture.triadSummary, "utf8"));
    summary.reviewWaveId = different;
    writeJson(fixture.triadSummary, summary);
    expect(() => sealReleaseReviewAttestation(fixture.input)).toThrow(/summary wave mismatch/);
  });
});
