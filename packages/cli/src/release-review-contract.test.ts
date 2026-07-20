import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OWNER_REVIEW_MAX_ROUNDS,
  OWNER_REVIEW_PROTOCOL,
  REQUIRED_SCOPE_MODEL,
  REQUIRED_TRIAD_MODELS,
  TRIAD_ITEMS,
  buildTouchedFilePack,
  completionTermination,
  exactPanelMatch,
  parseChecklistJson,
  pathIsWithin,
  panelLockText,
  blockerContractGaps,
  releaseReviewDecision,
  releaseAttestationSigningBytes,
  livenessFloorMs,
  reviewerLiveness,
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

type ChecklistFinding = ReturnType<typeof validateChecklistResponse>["findings"][number];
type SlotRecord = {
  model_id?: string;
  status: string;
  duration_ms?: number;
  findings?: ChecklistFinding[];
};

/** A full live triad panel: three responded slots with plausible durations. */
function liveTriad(findings: ChecklistFinding[]): SlotRecord[] {
  return REQUIRED_TRIAD_MODELS.map((model) => ({
    model_id: model,
    status: "responded",
    duration_ms: 120_000,
    findings,
  }));
}

function liveScope(findings: ChecklistFinding[] = []): SlotRecord {
  return { status: "responded", duration_ms: 120_000, findings };
}

describe("release review fail-closed contract", () => {
  it("accepts only full-SHA candidate or stable-tag publish inputs", () => {
    expect(validateReleaseInput("candidate", "a".repeat(40)).ok).toBe(true);
    expect(validateReleaseInput("candidate", "main").ok).toBe(false);
    expect(validateReleaseInput("publish", "v2.0.0").ok).toBe(true);
    expect(validateReleaseInput("publish", "v2.0.0-rc.1").ok).toBe(false);
    expect(validateReleaseInput("publish", "v2.0.0; echo nope").ok).toBe(false);
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
        triadActors: liveTriad(result.findings),
        scope: liveScope(),
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

  it("passes only a FULLY live panel — a failed required slot blocks sealing (v3, no quorum fallback)", () => {
    const findings = validateChecklistResponse(cleanRows(), "model", TRIAD_ITEMS).findings;
    expect(
      releaseReviewDecision({ triadActors: liveTriad(findings), scope: liveScope() }).passed,
    ).toBe(true);
    const [first, second] = liveTriad(findings);
    const decision = releaseReviewDecision({
      triadActors: [first!, second!, { model_id: REQUIRED_TRIAD_MODELS[2], status: "timed_out" }],
      scope: liveScope(),
    });
    expect(decision.passed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("not live");
  });

  it("scales the liveness floor with the submitted prompt size", () => {
    // Megabyte-scale release packets keep the full 30s floor; a small hotfix
    // packet gets a floor a flash-tier reviewer can legitimately clear, and
    // instant/cache artifacts stay rejected at every size.
    expect(livenessFloorMs(2_000_000)).toBe(30_000);
    expect(livenessFloorMs(500_000)).toBe(20_000);
    expect(livenessFloorMs(150_000)).toBe(10_000);
    expect(livenessFloorMs(Number.NaN)).toBe(30_000);
    expect(livenessFloorMs(0)).toBe(30_000);
    expect(
      reviewerLiveness({ status: "responded", duration_ms: 18_000 }, livenessFloorMs(150_000)).live,
    ).toBe(true);
    expect(
      reviewerLiveness({ status: "responded", duration_ms: 900 }, livenessFloorMs(150_000)).live,
    ).toBe(false);
  });

  it("treats an implausibly fast slot as failed — the liveness floor", () => {
    expect(reviewerLiveness({ status: "responded", duration_ms: 120_000 }).live).toBe(true);
    expect(reviewerLiveness({ status: "responded", duration_ms: 900 }).live).toBe(false);
    expect(reviewerLiveness({ status: "responded" }).live).toBe(false);
    const findings = validateChecklistResponse(cleanRows(), "model", TRIAD_ITEMS).findings;
    const triad = liveTriad(findings);
    triad[1] = { ...triad[1]!, duration_ms: 500 };
    const decision = releaseReviewDecision({ triadActors: triad, scope: liveScope() });
    expect(decision.passed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("implausible duration");
  });

  it("accepts blocker-contract fields (invariant, reachable) and rejects malformed ones [INV-139]", () => {
    const rows = cleanRows();
    rows[0] = {
      ...rows[0]!,
      verdict: "FAIL",
      severity: "critical",
      reason: "concrete defect",
      invariant: "INV-042",
      reachable: true,
    } as never;
    const result = validateChecklistResponse(rows, "model", TRIAD_ITEMS);
    expect(result.status).toBe("responded");
    expect(result.findings[0]).toMatchObject({ invariant: "INV-042", reachable: true });
    expect(
      validateChecklistResponse(
        rows.map((row, i) => (i === 0 ? { ...row, invariant: "  " } : row)),
        "model",
        TRIAD_ITEMS,
      ).status,
    ).toBe("parse_failure");
    expect(
      validateChecklistResponse(
        rows.map((row, i) => (i === 0 ? { ...row, reachable: "yes" } : row)),
        "model",
        TRIAD_ITEMS,
      ).status,
    ).toBe("parse_failure");
  });

  it("surfaces blocker-contract gaps for adjudication without softening the block", () => {
    const rows = cleanRows();
    rows[0] = {
      ...rows[0]!,
      verdict: "FAIL",
      severity: "critical",
      reason: "uncited blocker",
    };
    const findings = validateChecklistResponse(rows, "model", TRIAD_ITEMS).findings;
    expect(blockerContractGaps(findings)).toEqual([
      expect.objectContaining({ gaps: ["no invariant/criterion cited"] }),
    ]);
    const clean = validateChecklistResponse(cleanRows(), "model", TRIAD_ITEMS).findings;
    const triad = liveTriad(clean);
    triad[0] = { ...triad[0]!, findings };
    const decision = releaseReviewDecision({ triadActors: triad, scope: liveScope() });
    // Fail-closed: an uncited critical FAIL still blocks the machine decision;
    // the gap is adjudication input (ledger vs fix), never an auto-downgrade.
    expect(decision.passed).toBe(false);
    expect(decision.blockerContractGaps).toHaveLength(1);
  });

  it("preserves advisory FAIL verdicts without blocking a healthy panel", () => {
    const rows = cleanRows();
    rows[1] = { ...rows[1]!, verdict: "FAIL", severity: "advisory", reason: "concrete issue" };
    const findings = validateChecklistResponse(rows, "model", TRIAD_ITEMS).findings;
    const decision = releaseReviewDecision({
      triadActors: liveTriad(findings),
      scope: liveScope(),
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
    const clean = validateChecklistResponse(cleanRows(), "other", TRIAD_ITEMS).findings;
    const triad = liveTriad(clean);
    triad[0] = { ...triad[0]!, findings };
    const decision = releaseReviewDecision({ triadActors: triad, scope: liveScope() });
    expect(decision.passed).toBe(false);
    expect(decision.blockingFindings).toEqual([
      expect.objectContaining({ verdict: "FAIL", severity: "critical" }),
    ]);
    expect(decision.reasons[0]).toContain("critical FAIL");
  });

  it("fails closed when malformed output kills a required slot", () => {
    const findings = validateChecklistResponse(cleanRows(), "model", TRIAD_ITEMS).findings;
    const malformed = validateChecklistResponse([], "malformed", TRIAD_ITEMS);
    const triad = liveTriad(findings);
    triad[1] = { ...triad[1]!, status: malformed.status, findings: malformed.findings };
    const decision = releaseReviewDecision({ triadActors: triad, scope: liveScope() });
    expect(decision.passed).toBe(false);
    expect(decision.responsiveTriad).toBe(2);
    expect(decision.reasons.join(" ")).toContain("not live");
  });

  it("fails closed when the required scope slot is missing or partial", () => {
    const findings = validateChecklistResponse(cleanRows(), "model", TRIAD_ITEMS).findings;
    const decision = releaseReviewDecision({ triadActors: liveTriad(findings), scope: null });
    expect(decision.passed).toBe(false);
    expect(decision.reasons).toContain("scope reviewer is missing");
    expect(
      releaseReviewDecision({
        triadActors: liveTriad(findings),
        scope: { status: "partial", duration_ms: 120_000, findings: [] },
      }).passed,
    ).toBe(false);
  });
});

describe("owner-review attestation (schemaVersion 3, owner protocol)", () => {
  const ownerAttestation = () => {
    const candidateSha = "a".repeat(40);
    const candidateTree = "b".repeat(40);
    const digest = "d".repeat(64);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const authority = {
      keyId: "fixture-key",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const payload: any = {
      contract: "owner-review-v3",
      reviewProtocol: OWNER_REVIEW_PROTOCOL,
      candidateSha,
      candidateTree,
      rounds: 2,
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
      reviews: [
        {
          reviewer: "sol",
          reportSha256: digest,
          verdict: "pass",
          panel: { slot: "triad", model: "openai/gpt-5.6-sol" },
        },
        {
          reviewer: "fable-triad",
          reportSha256: digest,
          verdict: "warn",
          panel: { slot: "triad", model: "anthropic/claude-fable-5" },
        },
        {
          reviewer: "gemini",
          reportSha256: digest,
          verdict: "pass",
          panel: { slot: "triad", model: "google/gemini-3.5-flash" },
        },
        {
          reviewer: "fable-scope",
          reportSha256: digest,
          verdict: "pass",
          panel: { slot: "scope", model: "anthropic/claude-fable-5" },
        },
      ],
      sealedAt: "2026-07-18T00:00:00.000Z",
    };
    const attestation = {
      schemaVersion: 3,
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
    const expected = { candidateSha, candidateTree };
    return { attestation, authority, resign, expected };
  };

  it("accepts a signed attestation binding the exact triad+scope panel on the exact candidate", () => {
    const { attestation, authority, expected } = ownerAttestation();
    expect(validateReleaseAttestation(attestation, authority, expected)).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("rejects an attestation whose reviews do not cover the exact triad panel (B8)", () => {
    const { attestation, authority, resign, expected } = ownerAttestation();
    // Swap the gemini triad slot for an off-panel model — the >=2 floor still
    // passes, but the exact-panel binding must fail closed.
    const offPanel = resign({
      ...attestation,
      payload: {
        ...attestation.payload,
        reviews: [
          attestation.payload.reviews[0],
          attestation.payload.reviews[1],
          {
            reviewer: "impostor",
            reportSha256: "d".repeat(64),
            verdict: "pass",
            panel: { slot: "triad", model: "openai/gpt-4o" },
          },
          attestation.payload.reviews[3],
        ],
      },
    });
    const verdict = validateReleaseAttestation(offPanel, authority, expected);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/exact triad panel/);
  });

  it("rejects an attestation missing the scope panel slot (B8)", () => {
    const { attestation, authority, resign, expected } = ownerAttestation();
    const noScope = resign({
      ...attestation,
      payload: {
        ...attestation.payload,
        reviews: attestation.payload.reviews.slice(0, 3), // three triad slots, no scope
      },
    });
    const verdict = validateReleaseAttestation(noScope, authority, expected);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/scope slot/);
  });

  it("rejects a panel slot with no report digest (B8)", () => {
    const { attestation, authority, resign, expected } = ownerAttestation();
    const noDigest = resign({
      ...attestation,
      payload: {
        ...attestation.payload,
        reviews: [
          { ...attestation.payload.reviews[0], reportSha256: "not-a-digest" },
          attestation.payload.reviews[1],
          attestation.payload.reviews[2],
          attestation.payload.reviews[3],
        ],
      },
    });
    expect(validateReleaseAttestation(noDigest, authority, expected).ok).toBe(false);
  });

  it("accepts extra non-panel internal-critic reviews alongside the exact panel (B8)", () => {
    const { attestation, authority, resign, expected } = ownerAttestation();
    const withCritic = resign({
      ...attestation,
      payload: {
        ...attestation.payload,
        reviews: [
          ...attestation.payload.reviews,
          { reviewer: "internal-critic-engine", reportSha256: "e".repeat(64), verdict: "pass" },
        ],
      },
    });
    expect(validateReleaseAttestation(withCritic, authority, expected)).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("rejects tampering after signing — the signature covers the payload bytes", () => {
    const { attestation, authority, expected } = ownerAttestation();
    const tampered = {
      ...attestation,
      payload: { ...attestation.payload, rounds: 1 },
    };
    expect(validateReleaseAttestation(tampered, authority, expected).ok).toBe(false);
  });

  it("rejects a v2 attestation replayed under schemaVersion 3 without resigning", () => {
    const { attestation, authority, expected } = ownerAttestation();
    expect(
      validateReleaseAttestation({ ...attestation, schemaVersion: 2 }, authority, expected).ok,
    ).toBe(false);
  });

  it("rejects even a properly-signed v2 attestation — the retired contract is removed", () => {
    const { attestation, authority, resign, expected } = ownerAttestation();
    const v2 = resign({ ...attestation, schemaVersion: 2 });
    const verdict = validateReleaseAttestation(v2, authority, expected);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("not accepted");
  });

  it("a blocking verdict can never be sealed shippable (pass/warn only)", () => {
    const { attestation, authority, resign, expected } = ownerAttestation();
    const blocked = resign({
      ...attestation,
      payload: {
        ...attestation.payload,
        reviews: [
          attestation.payload.reviews[0],
          { reviewer: "fable-reviewer-2", reportSha256: "d".repeat(64), verdict: "block" },
        ],
      },
    });
    const result = validateReleaseAttestation(blocked, authority, expected);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/verdict/);
  });

  it("requires two UNIQUE reviewers and at most OWNER_REVIEW_MAX_ROUNDS rounds", () => {
    const { attestation, authority, resign, expected } = ownerAttestation();
    const single = resign({
      ...attestation,
      payload: { ...attestation.payload, reviews: [attestation.payload.reviews[0]] },
    });
    expect(validateReleaseAttestation(single, authority, expected).ok).toBe(false);
    const duplicated = resign({
      ...attestation,
      payload: {
        ...attestation.payload,
        reviews: [attestation.payload.reviews[0], attestation.payload.reviews[0]],
      },
    });
    expect(validateReleaseAttestation(duplicated, authority, expected).ok).toBe(false);
    const overRounds = resign({
      ...attestation,
      payload: { ...attestation.payload, rounds: OWNER_REVIEW_MAX_ROUNDS + 1 },
    });
    expect(validateReleaseAttestation(overRounds, authority, expected).ok).toBe(false);
  });

  it("binds to the exact candidate SHA/tree and a passing unchanged full gate", () => {
    const { attestation, authority, resign, expected } = ownerAttestation();
    expect(
      validateReleaseAttestation(attestation, authority, {
        ...expected,
        candidateSha: "f".repeat(40),
      }).ok,
    ).toBe(false);
    const dirtyGate = resign({
      ...attestation,
      payload: {
        ...attestation.payload,
        fullGate: { ...attestation.payload.fullGate, candidateUnchanged: false },
      },
    });
    expect(validateReleaseAttestation(dirtyGate, authority, expected).ok).toBe(false);
    const failedGate = resign({
      ...attestation,
      payload: {
        ...attestation.payload,
        fullGate: { ...attestation.payload.fullGate, exitCode: 1 },
      },
    });
    expect(validateReleaseAttestation(failedGate, authority, expected).ok).toBe(false);
  });
});
