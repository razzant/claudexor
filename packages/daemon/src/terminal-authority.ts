import { lstatSync } from "node:fs";
import {
  needsOperatorAttention,
  validateRunFactsInvariants,
  type RunEvent,
  type RunFacts,
} from "@claudexor/schema";
import { hashJson } from "@claudexor/util";
import type { JobRecord } from "./server.js";

/**
 * Pure (no filesystem) validation binding a durable terminal event's RunFacts
 * payload to the command's run identity and the terminal envelope. Both the
 * already-reconciled fast path and full artifact recovery MUST share this
 * check so a skipped repair never skips authority validation.
 */
export function recoveredTerminalFacts(
  record: JobRecord,
  terminal: RunEvent,
): { facts: RunFacts; terminalSeq: number } {
  if (!record.runId || !record.taskId || !record.runDir) {
    throw new Error("durable terminal recovery is missing the command run identity or directory");
  }
  const facts = validateRunFactsInvariants(terminal.payload["run_facts"]);
  if (typeof terminal.seq !== "number" || !Number.isSafeInteger(terminal.seq) || terminal.seq <= 0) {
    throw new Error("durable terminal event has no valid sequence");
  }
  const expectedTerminalType =
    facts.outcome.lifecycle !== "succeeded"
      ? "run.failed"
      : needsOperatorAttention(facts.outcome, false)
        ? "run.blocked"
        : "run.completed";
  if (
    facts.run_id !== terminal.run_id ||
    facts.task_id !== terminal.task_id ||
    facts.run_id !== record.runId ||
    facts.task_id !== record.taskId ||
    hashJson(facts.outcome) !== hashJson(terminal.payload["facts"]) ||
    terminal.type !== expectedTerminalType ||
    terminal.payload["lifecycle"] !== facts.outcome.lifecycle ||
    terminal.payload["reason"] !== facts.outcome.reason
  ) {
    throw new Error("durable terminal RunFacts identity, envelope, or outcome mismatch");
  }
  return { facts, terminalSeq: terminal.seq };
}

/** The durable terminal command result derived from validated RunFacts. */
export function terminalCommandResult(record: JobRecord, facts: RunFacts) {
  return {
    lifecycle: facts.outcome.lifecycle,
    facts: facts.outcome,
    runId: facts.run_id,
    taskId: facts.task_id,
    runDir: record.runDir!,
  };
}

/** ENOENT-tolerant lstat: retention may have legitimately reclaimed the path. */
export function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
