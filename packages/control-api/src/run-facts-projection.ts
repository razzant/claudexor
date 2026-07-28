import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isTerminalLifecycle,
  validateRunFactsReceipt,
  requiredActionsFor,
  type ApplyEligibility,
  type DecisionRecord,
  type ExpectedRunFactsIdentity,
  type RequiredAction,
  type RunFacts,
  type RunOutcomeFacts,
} from "@claudexor/schema";
import { parse as parseYaml } from "yaml";
import { safeArtifactPath, safeArtifactRoot } from "./artifact-paths.js";

export interface RunFactsDetailProjection {
  runFacts: RunFacts | null;
  outcomeFacts: RunOutcomeFacts | null;
  applyEligibility: ApplyEligibility | null;
  requiredActions: RequiredAction[];
}

export interface EffectiveTerminalFacts {
  runFacts: RunFacts | null;
  outcomeFacts: RunOutcomeFacts | null;
  decision: DecisionRecord | null;
}

/** The shared pure identity contract lives in @claudexor/schema (S2: one
 * validation owner); this alias keeps the control-api surface name stable. */
export type ExpectedRunFacts = ExpectedRunFactsIdentity;

/** Bind a canonical receipt to its daemon record without asserting a racy active lifecycle. */
export function expectedRunFacts(record: {
  id: string;
  state: string;
  runId?: string;
  taskId?: string;
}): ExpectedRunFacts {
  return {
    runId: record.runId ?? record.id,
    ...(record.taskId ? { taskId: record.taskId } : {}),
    ...(isTerminalLifecycle(record.state)
      ? { lifecycle: record.state as RunOutcomeFacts["lifecycle"] }
      : {}),
  };
}

/**
 * Single terminal-facts accessor: a cross-field-valid RunFacts receipt wins;
 * old/in-flight runs with no receipt retain legacy projections. A receipt that
 * is present but invalid fails loudly and can never reopen legacy apply truth.
 */
export function effectiveTerminalFacts(
  runDir: string | undefined,
  legacyOutcomeFacts: RunOutcomeFacts | null,
  legacyDecision: DecisionRecord | null = null,
  expected: ExpectedRunFacts = {},
): EffectiveTerminalFacts {
  const runFacts = readRunFacts(runDir, expected);
  const outcomeFacts = runFacts?.outcome ?? legacyOutcomeFacts;
  return {
    runFacts,
    outcomeFacts,
    decision:
      legacyDecision && outcomeFacts ? { ...legacyDecision, facts: outcomeFacts } : legacyDecision,
  };
}

/**
 * Project terminal compatibility fields from one canonical receipt read.
 * Missing receipts use legacy derivations for in-flight and pre-RunFacts runs.
 * Present-but-invalid receipts fail loudly.
 */
export function projectRunFactsForDetail(
  runDir: string | undefined,
  legacyOutcomeFacts: RunOutcomeFacts | null,
  hasValidOperatorDecision: boolean,
  legacyApplyEligibility: () => ApplyEligibility | null,
  expected: ExpectedRunFacts = {},
): RunFactsDetailProjection {
  const { runFacts, outcomeFacts } = effectiveTerminalFacts(
    runDir,
    legacyOutcomeFacts,
    null,
    expected,
  );
  if (runFacts) {
    // Delivery state and operator decisions are the two legitimate
    // post-terminal overlays. Re-derive only their mutable compatibility
    // fields while keeping the receipt's terminal outcome authoritative.
    const hasMutableOverlay =
      hasValidOperatorDecision || artifactExists(runDir, "final/delivery_state.yaml");
    return {
      runFacts,
      outcomeFacts,
      applyEligibility: hasMutableOverlay ? legacyApplyEligibility() : runFacts.apply.eligibility,
      requiredActions: hasMutableOverlay
        ? requiredActionsFor(runFacts.outcome, hasValidOperatorDecision)
        : runFacts.required_actions,
    };
  }
  return {
    runFacts: null,
    outcomeFacts: legacyOutcomeFacts,
    applyEligibility: legacyApplyEligibility(),
    requiredActions: requiredActionsFor(legacyOutcomeFacts, hasValidOperatorDecision),
  };
}

/** RunFacts is already redacted; avoid a second presentation-redaction pass. */
function readRunFacts(runDir: string | undefined, expected: ExpectedRunFacts): RunFacts | null {
  if (!runDir) return null;
  const root = safeArtifactRoot(runDir);
  if (!root) {
    try {
      lstatSync(runDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    }
    throw invalidRunFacts();
  }
  const finalDir = join(root, "final");
  let finalStat: ReturnType<typeof lstatSync>;
  try {
    finalStat = lstatSync(finalDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw invalidRunFacts();
  }
  if (finalStat.isSymbolicLink() || !finalStat.isDirectory()) {
    throw invalidRunFacts();
  }
  const path = join(finalDir, "run_facts.yaml");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw invalidRunFacts();
  }
  if (stat.isSymbolicLink() || stat.isDirectory() || !stat.isFile()) {
    throw invalidRunFacts();
  }
  try {
    // Shape + cross-axis invariants + identity binding live in the ONE shared
    // pure owner (@claudexor/schema); only YAML/file reading and the HTTP
    // problem mapping below are control-api's own.
    return validateRunFactsReceipt(parseYaml(readFileSync(path, "utf8")), expected);
  } catch {
    throw invalidRunFacts();
  }
}

/** Transport mapping of the shared refusal: HTTP status + typed unblock action. */
function invalidRunFacts(): Error & {
  status: number;
  code: string;
  retryable: boolean;
  requiredActions: string[];
  evidenceRefs: string[];
} {
  return Object.assign(
    new Error(
      "canonical RunFacts receipt is invalid; inspect final/run_facts.yaml before retrying",
    ),
    {
      status: 500,
      code: "run_facts_invalid",
      retryable: false,
      requiredActions: ["inspect_run_artifacts"],
      evidenceRefs: ["final/run_facts.yaml"],
    },
  );
}

function artifactExists(runDir: string | undefined, relativePath: string): boolean {
  try {
    if (!runDir) return false;
    const path = safeArtifactPath(runDir, relativePath);
    if (!path) return false;
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && !stat.isDirectory();
  } catch {
    return false;
  }
}
