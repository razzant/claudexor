import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_SCOPE_MODEL,
  REQUIRED_RELEASE_REVIEW_SLOTS,
  REQUIRED_TRIAD_MODELS,
  MAX_RELEASE_REVIEW_START_SKEW_MS,
  TRIAD_ITEMS,
  buildTouchedFilePack,
  canonicalJson,
  completionTermination,
  exactPanelMatch,
  parseChecklistJson,
  pathIsWithin,
  panelLockText,
  releaseReviewDecision,
  releaseAttestationSigningBytes,
  releaseReviewConcurrencyDigest,
  validateFrozenReviewBinding,
  validateNewReviewOutput,
  validatePanelLock,
  validateReleaseAttestation,
  validateReleaseInput,
  validateChecklistResponse,
} from "../../../scripts/lib/release-review-contract.mjs";

function cleanRows() {
  return TRIAD_ITEMS.map((item) => ({
    item,
    verdict: "PASS",
    severity: "advisory",
    reason: `${item} checked`,
  }));
}

describe("release review fail-closed contract", () => {
  const releaseAttestation = () => {
    const candidateSha = "a".repeat(40);
    const candidateTree = "b".repeat(40);
    const packetManifestSha256 = "c".repeat(64);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const authority = {
      keyId: "fixture-key",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const digest = "d".repeat(64);
    const payload: any = {
      candidateSha,
      candidateTree,
      packetManifestSha256,
      evidenceManifestSha256: packetManifestSha256,
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
      panelLock: {
        triad: REQUIRED_TRIAD_MODELS.join(","),
        scope: REQUIRED_SCOPE_MODEL,
        candidate_sha: candidateSha,
        candidate_tree: candidateTree,
        packet_manifest_sha256: packetManifestSha256,
      },
      slots: REQUIRED_RELEASE_REVIEW_SLOTS.map(({ slot, route, model, effort }) => ({
        slot,
        route,
        requestedModel: model,
        observedModel: model,
        effort,
        status: "responded",
        result: "passed",
        telemetrySha256: digest,
        resultSha256: digest,
        artifactManifestSha256: digest,
        artifacts: [{ name: "result.json", sha256: digest }],
      })),
      evidence: {
        tier1ProgressSha256: digest,
        triadProgressSha256: digest,
      },
      concurrency: (() => {
        const evidence = {
          reviewRunId: "triad-run-fixture",
          reviewWaveId: "11111111-1111-4111-8111-111111111111",
          promptSha256: { triad: digest, scope: digest },
          maxStartSkewMs: MAX_RELEASE_REVIEW_START_SKEW_MS,
          observedStartSkewMs: 500,
          firstStartAt: "2026-07-15T00:00:00.000Z",
          lastStartAt: "2026-07-15T00:00:00.500Z",
          firstCompletionAt: "2026-07-15T00:00:02.000Z",
          tier1ProgressSha256: digest,
          triadProgressSha256: digest,
          slots: REQUIRED_RELEASE_REVIEW_SLOTS.map(({ slot }, index) => ({
            slot,
            startedAt: `2026-07-15T00:00:00.${String(index * 100).padStart(3, "0")}Z`,
          })),
        };
        return { ...evidence, evidenceSha256: releaseReviewConcurrencyDigest(evidence) };
      })(),
      decision: { status: "passed", quorum: 2, responsiveTriad: 3, blockingFindings: 0 },
      openBlockers: [],
    };
    const attestation = {
      schemaVersion: 2,
      keyId: authority.keyId,
      algorithm: "Ed25519",
      payload,
      signature: "",
    };
    attestation.signature = sign(
      null,
      releaseAttestationSigningBytes(attestation),
      privateKey,
    ).toString("base64");
    const resign = (next: typeof attestation) => ({
      ...next,
      signature: sign(null, releaseAttestationSigningBytes(next), privateKey).toString("base64"),
    });
    return { attestation, authority, privateKey, resign };
  };

  it("accepts only full-SHA candidate or stable-tag publish inputs", () => {
    expect(validateReleaseInput("candidate", "a".repeat(40)).ok).toBe(true);
    expect(validateReleaseInput("candidate", "main").ok).toBe(false);
    expect(validateReleaseInput("publish", "v2.0.0").ok).toBe(true);
    expect(validateReleaseInput("publish", "v2.0.0-rc.1").ok).toBe(false);
    expect(validateReleaseInput("publish", "v2.0.0; echo nope").ok).toBe(false);
  });

  it("binds publication to the exact reviewed SHA, tree, manifest, and six slots", () => {
    const fixture = releaseAttestation();
    const { attestation: valid, authority, resign } = fixture;
    const expected = {
      candidateSha: valid.payload.candidateSha,
      candidateTree: valid.payload.candidateTree,
    };
    expect(validateReleaseAttestation(valid, authority, expected)).toEqual({
      ok: true,
      reasons: [],
    });
    const quorumPayload = {
      ...valid.payload,
      slots: valid.payload.slots.map((slot: any) =>
        slot.slot === "triad-3" ? { ...slot, status: "timed_out", observedModel: null } : slot,
      ),
      decision: { ...valid.payload.decision, responsiveTriad: 2 },
    };
    const quorum = resign({ ...valid, payload: quorumPayload });
    expect(validateReleaseAttestation(quorum, authority, expected).ok).toBe(true);
    const wrongGate = resign({
      ...valid,
      payload: {
        ...valid.payload,
        fullGate: { ...valid.payload.fullGate, program: "node", argv: ["node", "smoke.mjs"] },
      },
    });
    expect(validateReleaseAttestation(wrongGate, authority, expected).ok).toBe(false);
    expect(
      validateReleaseAttestation(
        { ...valid, payload: { ...valid.payload, candidateTree: "d".repeat(40) } },
        authority,
        expected,
      ).ok,
    ).toBe(false);
    expect(
      validateReleaseAttestation(
        {
          ...valid,
          payload: {
            ...valid.payload,
            slots: valid.payload.slots.map((slot: any, i: number) =>
              i ? slot : { ...slot, observedModel: "wrong" },
            ),
          },
        },
        authority,
        expected,
      ).ok,
    ).toBe(false);
    expect(
      validateReleaseAttestation(
        { ...valid, payload: { ...valid.payload, openBlockers: ["still open"] } },
        authority,
        expected,
      ).ok,
    ).toBe(false);
  });

  it("rejects forged schema 1, unsigned, unknown-key, and tampered attestations", () => {
    const { attestation, authority } = releaseAttestation();
    const expected = {
      candidateSha: attestation.payload.candidateSha,
      candidateTree: attestation.payload.candidateTree,
    };
    expect(
      validateReleaseAttestation(
        { schemaVersion: 1, ...attestation.payload, decision: "passed", openBlockers: [] },
        authority,
        expected,
      ).ok,
    ).toBe(false);
    expect(
      validateReleaseAttestation({ ...attestation, signature: "" }, authority, expected).ok,
    ).toBe(false);
    expect(
      validateReleaseAttestation({ ...attestation, keyId: "attacker-key" }, authority, expected).ok,
    ).toBe(false);
    const tampered = validateReleaseAttestation(
      {
        ...attestation,
        payload: {
          ...attestation.payload,
          slots: attestation.payload.slots.map((slot: any, index: number) =>
            index ? slot : { ...slot, resultSha256: "e".repeat(64) },
          ),
        },
      },
      authority,
      expected,
    );
    expect(tampered).toEqual({
      ok: false,
      reasons: ["review attestation signature is invalid"],
    });
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("accepts only the exact ordered model panel", () => {
    expect(exactPanelMatch(REQUIRED_TRIAD_MODELS, REQUIRED_SCOPE_MODEL)).toBe(true);
    expect(exactPanelMatch([...REQUIRED_TRIAD_MODELS].reverse(), REQUIRED_SCOPE_MODEL)).toBe(false);
    expect(exactPanelMatch(REQUIRED_TRIAD_MODELS, "anthropic/nearest-model")).toBe(false);
    expect(exactPanelMatch(REQUIRED_TRIAD_MODELS.slice(0, 2), REQUIRED_SCOPE_MODEL)).toBe(false);
  });

  it("requires a pre-created panel lock bound to the exact frozen candidate", () => {
    const expected = {
      candidateSha: "a".repeat(40),
      candidateTree: "b".repeat(40),
      packetManifestSha256: "c".repeat(64),
    };
    expect(validatePanelLock(null, expected)).toEqual({
      ok: false,
      reasons: ["panel lock is missing"],
    });
    const parsed = Object.fromEntries(
      panelLockText(expected)
        .trim()
        .split("\n")
        .map((line) => line.split(/:\s+/, 2)),
    );
    expect(validatePanelLock(parsed, expected)).toEqual({ ok: true, reasons: [] });
    expect(validatePanelLock({ ...parsed, candidate_tree: "d".repeat(40) }, expected)).toEqual({
      ok: false,
      reasons: ["candidate tree is not locked"],
    });
  });

  it("distinguishes candidate/packet descendants from external review artifacts", () => {
    expect(pathIsWithin("/candidate", "/candidate")).toBe(true);
    expect(pathIsWithin("/candidate", "/candidate/reviews/round-1")).toBe(true);
    expect(pathIsWithin("/candidate", "/candidate-sibling/reviews")).toBe(false);
    expect(pathIsWithin("/packet", "/external/reviews/round-1")).toBe(false);
    expect(
      validateNewReviewOutput("/candidate", "/packet", "/external/reviews/round-1", true),
    ).toMatchObject({ ok: false, reasons: ["review output already exists"] });
  });

  it("binds a clean worktree and sealed packet to the exact candidate SHA and tree", () => {
    const candidateSha = "a".repeat(40);
    const candidateTree = "b".repeat(40);
    const clean = {
      candidateSha,
      candidateTree,
      actualSha: candidateSha,
      actualTree: candidateTree,
      dirty: false,
    };
    expect(validateFrozenReviewBinding(clean)).toEqual({ ok: true, reasons: [] });
    expect(validateFrozenReviewBinding({ ...clean, dirty: true }).ok).toBe(false);
    expect(validateFrozenReviewBinding({ ...clean, actualTree: "c".repeat(40) }).ok).toBe(false);
  });

  it("builds touched-file context from Git blobs without following tracked symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-review-pack-"));
    const repo = join(root, "repo");
    const outside = join(root, "outside.txt");
    const sentinel = "OUTSIDE_SENTINEL_NOT_IN_GIT";
    mkdirSync(repo);
    writeFileSync(outside, sentinel);
    writeFileSync(join(repo, "regular.txt"), "committed regular content\n");
    symlinkSync(outside, join(repo, "leak.txt"));
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      });
    try {
      git(["init", "-q"]);
      git(["add", "regular.txt", "leak.txt"]);
      git(["commit", "-qm", "fixture"]);
      expect(git(["ls-files", "-s", "--", "leak.txt"])).toMatch(/^120000 /);
      const pack = buildTouchedFilePack(["regular.txt", "leak.txt"], git, 200_000, 3_000_000);
      expect(pack).toContain("committed regular content");
      expect(pack).toContain(outside);
      expect(pack).not.toContain(sentinel);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([null, "length", "max_tokens", "tool_calls"])(
    "rejects non-terminal or truncated finish reason %s",
    (finishReason) => {
      expect(completionTermination(finishReason).complete).toBe(false);
    },
  );

  it("accepts only the terminal stop finish reason", () => {
    expect(completionTermination("stop")).toEqual({ complete: true, error: null });
  });

  it("parses a whole JSON-array response with at most one exact json fence", () => {
    expect(parseChecklistJson(JSON.stringify(cleanRows()))).toEqual(cleanRows());
    expect(parseChecklistJson(`\`\`\`json\n${JSON.stringify(cleanRows())}\n\`\`\``)).toEqual(
      cleanRows(),
    );
    expect(parseChecklistJson(`review:\n${JSON.stringify(cleanRows())}`)).toBeNull();
    expect(
      parseChecklistJson(`before\n\`\`\`json\n${JSON.stringify(cleanRows())}\n\`\`\``),
    ).toBeNull();
    expect(
      parseChecklistJson(
        `\`\`\`json\n${JSON.stringify(cleanRows())}\n\`\`\`\n\`\`\`json\n[]\n\`\`\``,
      ),
    ).toBeNull();
  });

  it.each([
    ["empty array", []],
    ["malformed row", [{ item: "review_protocol", verdict: "PASS" }]],
    [
      "unknown checklist item",
      [{ item: "not_a_check", verdict: "PASS", severity: "advisory", reason: "x" }],
    ],
  ])("makes %s quorum-unusable", (_name, value) => {
    expect(validateChecklistResponse(value, "model", TRIAD_ITEMS).status).not.toBe("responded");
  });

  it.each([
    [
      "an unknown row field",
      cleanRows().map((row, index) => (index === 0 ? { ...row, unexpected: true } : row)),
    ],
  ])("makes a checklist with %s quorum-unusable", (_name, value) => {
    expect(validateChecklistResponse(value, "model", TRIAD_ITEMS).status).toBe("parse_failure");
  });

  it("accepts MULTIPLE rows per item — one row per distinct finding (round-16 protocol root-cause)", () => {
    // The prompt instructs "report every distinct problem as a separate
    // entry"; the validator must accept exactly that instead of
    // disqualifying the most thorough reviewers.
    const rows = [
      ...cleanRows(),
      {
        item: TRIAD_ITEMS[0],
        verdict: "FAIL",
        severity: "advisory",
        reason: "second distinct finding on the same item",
      },
      {
        item: TRIAD_ITEMS[0],
        verdict: "FAIL",
        severity: "critical",
        reason: "third distinct finding on the same item",
      },
    ];
    const result = validateChecklistResponse(rows, "model", TRIAD_ITEMS);
    expect(result.status).toBe("responded");
    expect(result.findings).toHaveLength(rows.length);
    // Every per-finding row survives into the decision input: the critical
    // FAIL among the repeats still blocks.
    expect(
      releaseReviewDecision({
        triadActors: [
          { status: "responded", findings: result.findings },
          { status: "responded", findings: result.findings },
        ],
        scope: { status: "responded", findings: [] },
      }).passed,
    ).toBe(false);
  });

  it("refuses only a RUNAWAY row count, not a deep review", () => {
    const runaway = Array.from({ length: TRIAD_ITEMS.length * 16 + 1 }, () => ({
      item: TRIAD_ITEMS[0],
      verdict: "FAIL",
      severity: "advisory",
      reason: "spam",
    }));
    expect(validateChecklistResponse(runaway, "model", TRIAD_ITEMS).status).toBe("parse_failure");
  });

  it("makes a missing checklist item partial rather than silently clean", () => {
    const result = validateChecklistResponse(cleanRows().slice(0, 2), "model", TRIAD_ITEMS);
    expect(result.status).toBe("partial");
    expect(result.missingItems).toEqual(["security_and_secrets"]);
  });

  it("passes only complete PASS responses from quorum plus scope", () => {
    const findings = validateChecklistResponse(cleanRows(), "model", TRIAD_ITEMS).findings;
    expect(
      releaseReviewDecision({
        triadActors: [
          { status: "responded", findings },
          { status: "responded", findings },
          { status: "timed_out" },
        ],
        scope: { status: "responded", findings: [] },
      }).passed,
    ).toBe(true);
  });

  it("preserves advisory FAIL verdicts without blocking a healthy panel", () => {
    const rows = cleanRows();
    rows[1] = { ...rows[1]!, verdict: "FAIL", severity: "advisory", reason: "concrete issue" };
    const findings = validateChecklistResponse(rows, "model", TRIAD_ITEMS).findings;
    const decision = releaseReviewDecision({
      triadActors: [
        { status: "responded", findings },
        {
          status: "responded",
          findings: validateChecklistResponse(cleanRows(), "other", TRIAD_ITEMS).findings,
        },
      ],
      scope: { status: "responded", findings: [] },
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ verdict: "FAIL", severity: "advisory" }),
    );
    expect(decision.passed).toBe(true);
    expect(decision.blockingFindings).toEqual([]);
    expect(decision.reasons).toEqual([]);
  });

  it("fails closed on a critical FAIL verdict even when quorum and scope are healthy", () => {
    const rows = cleanRows();
    rows[1] = { ...rows[1]!, verdict: "FAIL", severity: "critical", reason: "release blocker" };
    const findings = validateChecklistResponse(rows, "model", TRIAD_ITEMS).findings;
    const decision = releaseReviewDecision({
      triadActors: [
        { status: "responded", findings },
        {
          status: "responded",
          findings: validateChecklistResponse(cleanRows(), "other", TRIAD_ITEMS).findings,
        },
      ],
      scope: { status: "responded", findings: [] },
    });
    expect(decision.passed).toBe(false);
    expect(decision.blockingFindings).toEqual([
      expect.objectContaining({ verdict: "FAIL", severity: "critical" }),
    ]);
    expect(decision.reasons[0]).toContain("critical FAIL");
  });

  it("fails closed when malformed output prevents quorum", () => {
    const findings = validateChecklistResponse(cleanRows(), "model", TRIAD_ITEMS).findings;
    const malformed = validateChecklistResponse([], "malformed", TRIAD_ITEMS);
    const decision = releaseReviewDecision({
      triadActors: [
        { status: "responded", findings },
        { status: malformed.status, findings: malformed.findings },
      ],
      scope: { status: "responded", findings: [] },
    });
    expect(decision.passed).toBe(false);
    expect(decision.responsiveTriad).toBe(1);
    expect(decision.reasons).toContain("triad quorum not met: 1/2");
  });

  it("fails closed when the required scope slot is missing", () => {
    const findings = validateChecklistResponse(cleanRows(), "model", TRIAD_ITEMS).findings;
    const decision = releaseReviewDecision({
      triadActors: [
        { status: "responded", findings },
        { status: "responded", findings },
      ],
      scope: null,
    });
    expect(decision.passed).toBe(false);
    expect(decision.reasons).toContain("scope reviewer is missing");
  });
});
