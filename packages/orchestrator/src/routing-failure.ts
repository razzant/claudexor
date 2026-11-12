import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import { makeOutcomeFacts, type QuotaRefusal, type RunFailureCode } from "@claudexor/schema";
import { harnessFailureNextActions } from "./harnessFailure.js";
import { declaredFailure, writeFailure } from "./runTerminalResults.js";

/**
 * Classify typed routing refusal separately from provider availability.
 *
 * Quota admission runs HERE, during routing, so that the account which will
 * actually spawn is the one whose windows are checked (an opt-in default-subject
 * rotation has to pick its ready profile before the budget router filters the
 * exhausted default away). That placement means a typed refusal thrown by the
 * profile preflight — `subscription_window_exhausted` and its `resetsAt` — never
 * reaches the per-slot catch that records a candidate's `declaredFailure`, so
 * the routing terminal is the only place left that can state it. Dropping it
 * here would hand a scheduler `code: null` and leave it parsing prose for the
 * one fact it needs: when to come back.
 */
export function routingFailureClassification(err: unknown): {
  category: "config_error" | "harness_unavailable";
  code: RunFailureCode | null;
  resetsAt: string | null;
  quotaRefusal?: QuotaRefusal;
  nextActions?: string[];
} {
  const isPreflightRefusal =
    !!err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "routing_preflight_refused";
  if (isPreflightRefusal) {
    // `routing_preflight_refused` is deliberately NOT a RunFailureCode: it is a
    // classification marker, not a sub-code, so the terminal keeps `code: null`
    // here exactly as it did before.
    return {
      category: "config_error",
      code: null,
      resetsAt: null,
      nextActions: harnessFailureNextActions("config_error"),
    };
  }
  const declared = declaredFailure(err);
  return {
    // A thrower that declared its own category outranks the default, and the
    // schema validates it, so an unrelated error carrying a stray `category`
    // property cannot smuggle in a bogus classification.
    category: declared.category === "config_error" ? "config_error" : "harness_unavailable",
    code: declared.code,
    resetsAt: declared.resetsAt,
    ...(declared.quotaRefusal ? { quotaRefusal: declared.quotaRefusal } : {}),
  };
}

/**
 * The whole routing-catch terminal, written once instead of per strategy.
 *
 * Every strategy's routing catch wrote the identical twenty-nine lines — the
 * context_error note, the classified failure record, the diagnostic summary and
 * the two lifecycle events — differing only in the mode label printed into the
 * summary. Four copies is four places for the next routing field to be added to
 * three of them, which is exactly how `code`/`resetsAt` reached the terminal
 * late. The caller keeps its own `return`, because the result shape is the one
 * thing that genuinely differs between strategies.
 */
export function writeRoutingFailureTerminal(
  store: ArtifactStore,
  paths: ReturnType<ArtifactStore["runPaths"]>,
  log: EventLog,
  run: { runId: string; modeLabel: string; message: string; err: unknown },
): void {
  store.writeText(
    join(paths.contextDir, "context_error.md"),
    `# Routing Error\n\n${run.message}\n`,
  );
  // A routing preflight refusal is a config_error, not harness_unavailable
  // (A-1/#22): classify identically across every strategy's routing catch.
  const routingFailure = routingFailureClassification(run.err);
  writeFailure(store, paths, {
    phase: "routing",
    category: routingFailure.category,
    code: routingFailure.code,
    resetsAt: routingFailure.resetsAt,
    quotaRefusal: routingFailure.quotaRefusal,
    safeMessage: run.message,
    runDir: paths.root,
    ...(routingFailure.nextActions ? { nextActions: routingFailure.nextActions } : {}),
  });
  store.writeText(
    join(paths.finalDir, "summary.md"),
    `# Run ${run.runId} (${run.modeLabel})\n\n- Lifecycle: failed\n- Phase: routing\n\n${run.message}\n`,
  );
  log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  log.emit("run.failed", {
    lifecycle: "failed",
    facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
    reason: "harness_failed",
    phase: "routing",
    error: run.message,
    failure_ref: "final/failure.yaml",
  });
}
