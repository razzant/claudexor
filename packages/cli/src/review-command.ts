/**
 * `claudexor review --diff <file>`: thin surface over the engine's
 * scoped diff review — the per-commit gate's PRIMARY route. FAIL CLOSED: an
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
  if (!diffPath) {
    return printUsageError(
      json,
      'usage: claudexor review --diff <file> [--intent "<text>"] [--tests "<evidence>"] [--reviewer-panel <list>] [--json]',
    );
  }
  let diffText: string;
  try {
    diffText = readFileSync(diffPath, "utf8");
  } catch (err) {
    return printUsageError(
      json,
      `claudexor review: cannot read --diff '${diffPath}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const orch = new Orchestrator({
      registry: buildRegistry(),
      reviewerPanel: panelFlags(args),
    });
    const result = await orch.reviewDiff({
      repoRoot: process.cwd(),
      diff: diffText,
      userIntent: flagStr(args, "intent"),
      tests: flagStr(args, "tests"),
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
