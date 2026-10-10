import { lstatSync } from "node:fs";
import { TextDecoder } from "node:util";
import { POST_TERMINAL_AUDIT_EVENT_TYPES } from "./journaled-run-events.js";
import {
  needsOperatorAttention,
  RunEvent as RunEventSchema,
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
  if (
    typeof terminal.seq !== "number" ||
    !Number.isSafeInteger(terminal.seq) ||
    terminal.seq <= 0
  ) {
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

/** The same canonical tail validation for legacy recovery and SQL file obligations. */
export function normalizedTerminalEvents(
  eventsBytes: Buffer,
  terminal: RunEvent,
  terminalSeq: number,
): string {
  const normalizedLines: string[] = [];
  let terminalOccurrences = 0;
  let previousSeq = 0;
  const rawLines = splitLines(eventsBytes);
  const finalNonEmptyIndex = rawLines.findLastIndex((line) => !isAsciiWhitespace(line));
  const canonicalTerminalLine = JSON.stringify(terminal);
  const canonicalTerminalBytes = Buffer.from(canonicalTerminalLine, "utf8");
  const endsWithNewline = eventsBytes.at(-1) === 0x0a;
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (const [index, lineBytes] of rawLines.entries()) {
    if (isAsciiWhitespace(lineBytes)) continue;
    let event: RunEvent;
    try {
      const line = utf8.decode(lineBytes);
      event = RunEventSchema.parse(JSON.parse(line));
    } catch {
      const tornFinalLine =
        index === finalNonEmptyIndex &&
        !endsWithNewline &&
        terminalOccurrences === 0 &&
        isBufferPrefix(canonicalTerminalBytes, lineBytes);
      if (tornFinalLine) break;
      throw new Error("per-run event log contains malformed committed evidence");
    }
    if (event.run_id !== terminal.run_id || event.task_id !== terminal.task_id) {
      throw new Error("per-run event identity conflicts with durable terminal authority");
    }
    if (typeof event.seq !== "number" || !Number.isSafeInteger(event.seq) || event.seq <= 0) {
      throw new Error("per-run event has no valid sequence");
    }
    const eventSeq = event.seq;
    if (eventSeq <= previousSeq) {
      throw new Error("per-run event sequence is duplicate or non-monotonic");
    }
    const sameEvent = hashJson(event) === hashJson(terminal);
    if (terminalOccurrences === 0 && !sameEvent && eventSeq >= terminalSeq) {
      throw new Error("per-run event sequence conflicts with durable terminal authority");
    }
    if (terminalOccurrences > 0 && !sameEvent && !isPostTerminalControlAudit(event.type)) {
      throw new Error("per-run event appears after terminal authority");
    }
    const eventIsTerminal =
      event.type === "run.completed" || event.type === "run.failed" || event.type === "run.blocked";
    if (eventIsTerminal) {
      if (!sameEvent) {
        throw new Error("per-run terminal event conflicts with durable journal authority");
      }
      terminalOccurrences += 1;
      if (terminalOccurrences > 1) {
        throw new Error("per-run event log contains multiple terminal events");
      }
    }
    previousSeq = eventSeq;
    normalizedLines.push(JSON.stringify(event));
  }
  if (terminalOccurrences === 0) {
    normalizedLines.push(JSON.stringify(terminal));
  }
  const normalizedEvents = normalizedLines.length > 0 ? `${normalizedLines.join("\n")}\n` : "";
  return normalizedEvents;
}

function splitLines(bytes: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    lines.push(bytes.subarray(start, index));
    start = index + 1;
  }
  lines.push(bytes.subarray(start));
  return lines;
}

function isAsciiWhitespace(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte !== 0x09 && byte !== 0x0b && byte !== 0x0c && byte !== 0x0d && byte !== 0x20) {
      return false;
    }
  }
  return true;
}

function isBufferPrefix(whole: Buffer, prefix: Buffer): boolean {
  return prefix.length <= whole.length && whole.subarray(0, prefix.length).equals(prefix);
}

function isPostTerminalControlAudit(type: string): boolean {
  return POST_TERMINAL_AUDIT_EVENT_TYPES.has(type);
}

export function terminalResultMatches(
  result: unknown,
  expected: {
    lifecycle: RunFacts["outcome"]["lifecycle"];
    facts: RunFacts["outcome"];
    runId: string;
    taskId: string;
    runDir: string;
  },
): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const value = result as Record<string, unknown>;
  return (
    value["lifecycle"] === expected.lifecycle &&
    value["runId"] === expected.runId &&
    value["taskId"] === expected.taskId &&
    value["runDir"] === expected.runDir &&
    hashJson(value["facts"]) === hashJson(expected.facts)
  );
}
