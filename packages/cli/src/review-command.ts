/**
 * `claudexor review`: thin surface over the engine's scoped review. It accepts
 * either an ad-hoc diff or a SHA-bound sealed packet. FAIL CLOSED: an
 * inconclusive reviewer panel (unhealthy cross-family state or
 * INSUFFICIENT_EVIDENCE findings) never reads as a pass.
 */
import { readFileSync } from "node:fs";
import { Orchestrator } from "@claudexor/orchestrator";
import { isBlocking, type ControlReviewerPanelEntry } from "@claudexor/schema";
import { parseReviewerPanelFlags } from "./run-options.js";
import { type ParsedArgs, flagStr, flagValues } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { buildRegistry } from "./registry.js";

function panelFlags(args: ParsedArgs): ControlReviewerPanelEntry[] | undefined {
  return parseReviewerPanelFlags(flagValues(args, "reviewer-panel"));
}

export async function reviewCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const diffPath = flagStr(args, "diff");
  const evidenceDir = flagStr(args, "evidence-dir");
  const artifactsDir = flagStr(args, "artifacts-dir");
  const candidateSha = flagStr(args, "candidate-sha");
  const candidateTree = flagStr(args, "candidate-tree");
  const packetManifestSha256 = flagStr(args, "packet-manifest-digest");
  const frozenValues = [
    evidenceDir,
    artifactsDir,
    candidateSha,
    candidateTree,
    packetManifestSha256,
  ];
  const frozenRequested = frozenValues.some((value) => value !== undefined);
  const usage =
    'usage: claudexor review --diff <file> [--intent "<text>"] [--tests "<evidence>"] [--reviewer-panel <list>] [--json]\n' +
    "   or: claudexor review --evidence-dir <path> --artifacts-dir <external-path> --candidate-sha <sha> --candidate-tree <tree> --packet-manifest-digest <sha256> [--reviewer-panel <list>] [--json]";
  if ((!diffPath && !frozenRequested) || (frozenRequested && frozenValues.some((v) => !v))) {
    return printUsageError(json, usage);
  }
  if (
    frozenRequested &&
    (diffPath !== undefined ||
      flagStr(args, "intent") !== undefined ||
      flagStr(args, "tests") !== undefined)
  ) {
    return printUsageError(
      json,
      "claudexor review: sealed packet mode cannot be combined with --diff, --intent, or --tests",
    );
  }
  let diffText: string | undefined;
  if (diffPath) {
    try {
      diffText = readFileSync(diffPath, "utf8");
    } catch (err) {
      return printUsageError(
        json,
        `claudexor review: cannot read --diff '${diffPath}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  try {
    const orch = new Orchestrator({
      registry: buildRegistry(),
      reviewerPanel: panelFlags(args),
    });
    const result = await orch.reviewDiff({
      repoRoot: process.cwd(),
      ...(frozenRequested
        ? {
            frozen: {
              evidenceDir: evidenceDir!,
              artifactsDir: artifactsDir!,
              candidateSha: candidateSha!,
              candidateTree: candidateTree!,
              packetManifestSha256: packetManifestSha256!,
            },
          }
        : {
            diff: diffText!,
            userIntent: flagStr(args, "intent"),
            tests: flagStr(args, "tests"),
          }),
    });
    const blockers = result.findings.filter((f) => isBlocking(f));
    // FAIL CLOSED: reviewer setup/parse failures surface as
    // INSUFFICIENT_EVIDENCE findings that isBlocking never counts — an
    // inconclusive panel must NOT read as a pass. The pass bar matches
    // convergence's "clean review": cross-family HEALTHY (parseable findings
    // from >=2 families) AND VERIFIED (stream-observed route proofs).
    const inconclusive =
      !result.crossFamilyHealthy ||
      !result.crossFamilyVerified ||
      result.findings.some((f) => f.severity === "INSUFFICIENT_EVIDENCE");
    const ok = blockers.length === 0 && !inconclusive;
    if (json) {
      printJson({
        ok,
        inconclusive,
        crossFamilyVerified: result.crossFamilyVerified,
        providers: result.distinctProviders,
        blockers: blockers.length,
        findings: result.findings,
        reviewSpendUsd: result.reviewSpendUsd,
        artifactsDir: result.artifactsDir,
      });
    } else {
      print(
        `reviewers: ${result.distinctProviders.join(", ") || "none"} (cross-family verified: ${result.crossFamilyVerified})`,
      );
      for (const f of result.findings) print(`  [${f.severity}] ${f.claim}`);
      print(
        ok
          ? "review: PASS"
          : inconclusive && blockers.length === 0
            ? "review: INCONCLUSIVE (reviewer panel unhealthy) — fail closed"
            : `review: ${blockers.length} blocking finding(s)`,
      );
    }
    return ok ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) printJson({ ok: false, error: message });
    else process.stderr.write(`claudexor review: ${message}\n`);
    return 1;
  }
}
