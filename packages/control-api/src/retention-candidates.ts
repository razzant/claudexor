import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { isTerminalLifecycle, type GcKeepCounts } from "@claudexor/schema";
import { holdsRetainedSources } from "@claudexor/workspace";
import type { RetentionRunRecord } from "./retention.js";

/** The same guards judge an inventory candidate and its final deletion recheck. */
export function runKeepReason(
  root: string,
  runId: string,
  record: RetentionRunRecord | undefined,
  referenced: ReadonlySet<string>,
  cutoff: number,
  report: (error: unknown) => void,
): Exclude<keyof GcKeepCounts, "recent"> | null {
  if (record && !isTerminalLifecycle(record.state)) return "active";
  if (referenced.has(runId)) return "referenced";
  try {
    if (hasActionableWorkProduct(root) || holdsRetainedSources(root, runId, report))
      return "actionable";
  } catch (error) {
    report(error);
    return "actionable";
  }
  if (!record && !hasTerminalEvidence(root)) return "unknown_state";
  if (ageStampOf(root, record) > cutoff) return "young";
  return null;
}

function hasTerminalEvidence(runRoot: string): boolean {
  // Terminality is proven by TYPED terminal artifacts (D8/V8): the arbitration
  // decision (carries facts), the typed failure record, or the work product —
  // never the diagnostic summary.md (its authority role was retired).
  return (
    existsSync(join(runRoot, "arbitration", "decision.yaml")) ||
    existsSync(join(runRoot, "final", "failure.yaml")) ||
    existsSync(join(runRoot, "final", "work_product.yaml"))
  );
}

/** True when the run's tree is still the operator's to act on (D8): an
 * undelivered/applyable patch, OR a needs-decision terminal (decision.facts
 * review blocked / checks failed) with a work product present. */
function document(path: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`retention evidence ${path}: ${String(error)}`, { cause: error });
  }
  try {
    return (yamlParse(text) ?? {}) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`retention evidence ${path}: ${String(error)}`, { cause: error });
  }
}
function hasActionableWorkProduct(runRoot: string): boolean {
  const delivery = document(join(runRoot, "final", "delivery_state.yaml"));
  if (delivery?.applyState === "discarded") return false;
  const decision = document(join(runRoot, "arbitration", "decision.yaml"));
  const facts = decision?.facts as Record<string, unknown> | undefined;
  if (facts?.lifecycle === "succeeded" && (facts.review === "blocked" || facts.checks === "failed"))
    return true;
  const doc = document(join(runRoot, "final", "work_product.yaml"));
  if (doc === null) return false;
  const meta = (doc.meta ?? {}) as Record<string, unknown>;
  if (
    doc.kind !== "patch" &&
    doc.kind !== "files" &&
    doc.kind !== "new_repo" &&
    meta.result_kind !== "patch"
  )
    return false;
  // Non-success Git drafts cannot be applied; ordinary age/reference guards remain.
  if (
    doc.kind !== "files" &&
    ["cancelled", "failed", "interrupted"].includes(String(meta.lifecycle))
  )
    return false;
  // A producer-declared complete Git capture whose trees agree has no
  // actionable result. The fact is deliberately exact: legacy rows without
  // it, refused/missing captures, and directory results remain held.
  if (doc.kind === "patch" && meta.capturedNoGitChange === true) return false;
  const applyState = delivery?.applyState ?? meta.apply_state;
  return applyState !== "applied" && applyState !== "reverted" && applyState !== "discarded";
}

export function ageStampOf(runRoot: string, record: RetentionRunRecord | undefined): number {
  const finished = Date.parse(record?.finishedAt ?? "");
  if (Number.isFinite(finished)) return finished;
  try {
    return statSync(runRoot).mtimeMs;
  } catch {
    return Date.now();
  }
}
