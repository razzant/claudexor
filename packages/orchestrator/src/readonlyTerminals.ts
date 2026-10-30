import { join } from "node:path";
import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import type { BudgetLedger } from "@claudexor/budget";
import type { EventLog } from "@claudexor/event-log";
import { makeOutcomeFacts, type ModeKind } from "@claudexor/schema";
import type { OrchestratorResult } from "./orchestrator.js";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import { readOnlyNoSuccessTerminal } from "./attemptFinalize.js";
import { budgetFailureRecord, classifyBudgetFailure, type BudgetDenial } from "./budgetFailure.js";
import { unanimousDeclaredFailure } from "./candidateEvidence.js";
import {
  carryingAttempts,
  resumableTerminal,
  type ContinuityTerminalFacts,
} from "./continuity-terminal.js";
import {
  attemptVendorFailure,
  dominantHarnessFailureCategory,
  harnessFailureNextActions,
} from "./harnessFailure.js";
import { poolFailure } from "./pool-attempt-evidence.js";
import { writeFailure, type declaredFailure } from "./runTerminalResults.js";

/** One read-only (Ask/Plan chain or deep-scan scout) attempt as its terminals see it. */
export interface ReadonlyAttempt extends ContinuityTerminalFacts {
  attemptId: string;
  harnessId: string;
  status: "success" | "failed" | "blocked";
  report: string;
  error: string | null;
  telemetry: AttemptTelemetry;
  /** QA-019: this scout was refused BEFORE spawn by the budget gate — it
   * belongs in the denominator/omissions but never ran the harness, so the
   * all-denied terminal still routes through the QA-050 budget classifier. */
  budgetDenied?: boolean;
  /** D-16 r8: scout ran out of context — a failed omission, never reducer
   * input; ALL-interrupted terminalizes interrupted. */
  interrupted?: boolean;
  /** A5: the typed refusal (exhausted credential pool / spent window) this
   * attempt died on, so the chain terminal can speak it machine-readably. */
  declaredFailure?: ReturnType<typeof declaredFailure>;
}

interface ReadonlyTerminalContext {
  store: ArtifactStore;
  paths: RunPaths;
  log: EventLog;
  runId: string;
  taskId: string;
  mode: ModeKind;
  ledger: BudgetLedger;
  attempts: ReadonlyAttempt[];
  attemptTelemetries: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[];
  budgetStopped: boolean;
  budgetDenial: BudgetDenial | null;
  writeTelemetry(): void;
}

/** A read-only chain with no successful attempt (QA-036/QA-050/A5). */
export function readOnlyChainFailureResult(
  input: ReadonlyTerminalContext & { fallbackOpen: boolean },
): OrchestratorResult {
  const { store, paths, log, runId, taskId, mode, ledger, attempts, attemptTelemetries } = input;
  const { budgetStopped, budgetDenial } = input;
  const last = attempts[attempts.length - 1];
  const webBlocked = attempts.some((a) => a.status === "blocked");
  // QA-050: a budget refusal is a BUDGET failure, not a harness one — route
  // it through the shared classifier so phase/category/code/route and the
  // remediation are budget-typed (never auth/setup) across every mode.
  const budgetMapping =
    budgetStopped && !webBlocked
      ? classifyBudgetFailure({ denial: budgetDenial, terminal: ledger.terminal() })
      : null;
  const { message: singleError, poolAttempts } = poolFailure(
    budgetMapping?.safeMessage ??
      last?.error ??
      (budgetStopped ? "budget exhausted before any attempt" : "harness failed"),
    attempts,
  );
  if (input.fallbackOpen || webBlocked) {
    log.emit("route.fallback.exhausted", {
      harness_id: last?.harnessId ?? null,
      attempt_id: last?.attemptId ?? null,
      reason: "web_evidence_unsatisfied",
      error: singleError,
    });
  }
  const partialReport = [...attempts].reverse().find((a) => a.report)?.report ?? "";
  input.writeTelemetry();
  store.writeText(
    join(paths.contextDir, "context_error.md"),
    `# ${budgetMapping ? "Budget Denied" : "Harness Error"}\n\n${singleError}\n`,
  );
  const roEventRefs = attempts.map((a) => `attempts/${a.attemptId}/events.jsonl`);
  if (budgetMapping) {
    writeFailure(store, paths, {
      ...budgetFailureRecord(budgetMapping, { eventRefs: roEventRefs, runDir: paths.root }),
      safeMessage: singleError,
      poolAttempts,
    });
  } else {
    // #31: classify the harness cause across the read-only attempts so auth
    // guidance appears only on a real auth failure.
    const roCategory = dominantHarnessFailureCategory(
      attemptTelemetries.flatMap((a) => a.telemetry.transientFailures),
    );
    // A5: the terminal already speaks with the LAST attempt's message; its
    // typed refusal rides along machine-readably instead of reducing to it.
    const roDeclared = webBlocked ? undefined : last?.declaredFailure;
    writeFailure(store, paths, {
      phase: "harness",
      category: webBlocked ? "policy" : (roDeclared?.category ?? "harness_error"),
      code: roDeclared?.code ?? null,
      harnessId: last?.harnessId,
      attemptId: last?.attemptId,
      safeMessage: singleError,
      eventRefs: roEventRefs,
      runDir: paths.root,
      resetsAt: roDeclared?.resetsAt ?? null,
      requestRefusal: roDeclared?.requestRefusal,
      quotaRefusal: roDeclared?.quotaRefusal,
      vendorFailure: attemptVendorFailure(attemptTelemetries, last?.attemptId),
      poolAttempts,
      nextActions: harnessFailureNextActions(roCategory),
    });
  }
  // QA-036: re-check the DELIVERABLE through the shared finalizer helper —
  // a blocked Ask that produced NO answer can no longer read as a succeeded
  // "Needs review" run (exit 0); it is an honest failure (exit 1).
  const roTerminal = readOnlyNoSuccessTerminal({
    webBlocked,
    hasDeliverable: partialReport.trim().length > 0,
    budgetStopped,
    attemptsCount: attempts.length,
  });
  const terminalFacts = makeOutcomeFacts(roTerminal.lifecycle, {
    ...(roTerminal.review ? { review: roTerminal.review } : {}),
    reason: budgetMapping?.reason ?? roTerminal.reason,
  });
  const terminalHarnessId = budgetMapping?.harnessId ?? last?.harnessId;
  store.writeText(
    join(paths.finalDir, "summary.md"),
    `# Run ${runId} (${mode})\n\n- Harness: ${terminalHarnessId ?? "none"}\n- Lifecycle: ${terminalFacts.lifecycle}${terminalFacts.reason ? ` (${terminalFacts.reason})` : ""}\n\n${singleError}\n`,
  );
  log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  if (terminalFacts.lifecycle === "succeeded") {
    log.emit("run.blocked", {
      lifecycle: terminalFacts.lifecycle,
      facts: terminalFacts,
      harness_id: terminalHarnessId,
      error: singleError,
      pool_attempts: poolAttempts,
      failure_ref: "final/failure.yaml",
      ...resumableTerminal(store, paths, carryingAttempts(attempts, paths.root), true),
    });
  } else {
    log.emit("run.failed", {
      lifecycle: terminalFacts.lifecycle,
      facts: terminalFacts,
      reason: terminalFacts.reason,
      phase: budgetMapping?.phase,
      harness_id: terminalHarnessId,
      error: singleError,
      pool_attempts: poolAttempts,
      failure_ref: "final/failure.yaml",
      ...resumableTerminal(store, paths, carryingAttempts(attempts, paths.root), true),
    });
  }
  return {
    spendUsd: ledger.spend(),
    runId,
    taskId,
    mode,
    lifecycle: terminalFacts.lifecycle,
    facts: terminalFacts,
    winner: null,
    runDir: paths.root,
    summary: singleError,
    candidates: attempts.map((a) => ({
      attemptId: a.attemptId,
      harnessId: a.harnessId,
      status: a.status,
    })),
  };
}

/** A deep scan whose every explorer failed: no synthesizable deliverable (QA-036). */
export function deepScanFailureResult(input: ReadonlyTerminalContext): OrchestratorResult {
  const { store, paths, log, runId, taskId, mode, ledger, attempts, attemptTelemetries } = input;
  const { budgetStopped, budgetDenial } = input;
  const blocked = attempts.some((a) => a.status === "blocked");
  // QA-050/QA-019: only a pure-denial scan may claim a budget failure.
  const scanBudgetMapping =
    budgetStopped && !blocked && attempts.every((a) => a.budgetDenied === true)
      ? classifyBudgetFailure({ denial: budgetDenial, terminal: ledger.terminal() })
      : null;
  // D-16 r8: ALL scouts out of context → the aggregate is interrupted.
  const allInterrupted = attempts.length > 0 && attempts.every((a) => a.interrupted === true);
  const scanFailFacts = allInterrupted
    ? makeOutcomeFacts("interrupted", { reason: "context_capacity_exhausted" })
    : makeOutcomeFacts("failed", {
        reason: scanBudgetMapping ? scanBudgetMapping.reason : "harness_failed",
      });
  const { message, poolAttempts } = poolFailure(
    scanBudgetMapping
      ? scanBudgetMapping.safeMessage
      : attempts.map((a) => `${a.attemptId}/${a.harnessId}: ${a.error ?? "failed"}`).join("\n"),
    attempts,
  );
  input.writeTelemetry();
  if (scanBudgetMapping) {
    writeFailure(store, paths, {
      ...budgetFailureRecord(scanBudgetMapping, {
        eventRefs: attempts.map((a) => `attempts/${a.attemptId}/events.jsonl`),
        runDir: paths.root,
      }),
      safeMessage: message,
      poolAttempts,
    });
  } else {
    // Mixed causes stay generic; only unanimous evidence may name the scan's cause.
    const declared = blocked ? null : unanimousDeclaredFailure(attempts);
    const scanCategory = dominantHarnessFailureCategory(
      attemptTelemetries.flatMap((a) => a.telemetry.transientFailures),
    );
    writeFailure(store, paths, {
      phase: "harness",
      category: blocked ? "policy" : (declared?.category ?? "harness_error"),
      code: declared?.code,
      resetsAt: declared?.resetsAt,
      requestRefusal: declared?.requestRefusal,
      quotaRefusal: declared?.quotaRefusal,
      safeMessage: message || "all explorers failed",
      eventRefs: attempts.map((a) => `attempts/${a.attemptId}/events.jsonl`),
      runDir: paths.root,
      poolAttempts,
      nextActions: [
        ...harnessFailureNextActions(scanCategory).filter((a) => !a.startsWith("Retry")),
        "Reduce explore width",
        "Retry after setup",
      ],
    });
  }
  // QA-036: no successful explorer means no synthesizable deliverable.
  store.writeText(
    join(paths.finalDir, "summary.md"),
    `# Run ${runId} (${mode})\n\n- Lifecycle: ${scanFailFacts.lifecycle}${scanFailFacts.reason ? ` (${scanFailFacts.reason})` : ""}\n\n${message}\n`,
  );
  log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  log.emit("run.failed", {
    lifecycle: scanFailFacts.lifecycle,
    facts: scanFailFacts,
    reason: scanFailFacts.reason,
    phase: scanBudgetMapping ? scanBudgetMapping.phase : "harness",
    error: message,
    pool_attempts: poolAttempts,
    failure_ref: "final/failure.yaml",
    ...resumableTerminal(store, paths, attempts, true),
  });
  return {
    spendUsd: ledger.spend(),
    runId,
    taskId,
    mode,
    lifecycle: scanFailFacts.lifecycle,
    facts: scanFailFacts,
    winner: null,
    runDir: paths.root,
    summary: message,
    candidates: attempts.map((a) => ({
      attemptId: a.attemptId,
      harnessId: a.harnessId,
      status: a.status,
    })),
  };
}
