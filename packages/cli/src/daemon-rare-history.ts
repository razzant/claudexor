/**
 * The bounded rare-event history (#707): event-loop stalls and Stop stages kept
 * beside the canonical daemon log, so ordinary quota traffic rotating that log
 * cannot push them out before someone reads them after a restart. It reuses
 * the private post-authority writer with its own two generations (256 KiB each,
 * 512 KiB together); newer rare events displace older ones, never by age.
 */
import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logPath } from "@claudexor/daemon";
import type { DaemonLoopFacts } from "@claudexor/schema";
import { processTiming, safeProblemMessage } from "@claudexor/util";
import { readDaemonDiagnosticTail } from "./startup-diagnostics.js";

/** Caller-typed stages mirrored into the rare history; message text is never classified. */
export const RARE_DIAGNOSTIC_STAGES = [
  "loop_stall",
  "shutdown",
  "shutdown_signal",
  "shutdown_complete",
] as const;
export type RareDiagnosticStage = (typeof RARE_DIAGNOSTIC_STAGES)[number];

export function isRareDiagnosticStage(stage: string): stage is RareDiagnosticStage {
  return (RARE_DIAGNOSTIC_STAGES as readonly string[]).includes(stage);
}

export function rareHistoryPath(canonical: string = logPath()): string {
  return join(dirname(canonical), "claudexord.rare.log");
}

const rounded = (value: number) => Math.round(value * 1_000) / 1_000;

/**
 * Measured facts of one delayed loop window. `worstSyncInWindow` lists the
 * process's lifetime-worst synchronous sections (top 32) that ended inside the
 * window. The timestamps alone do not establish a cause. The window updates
 * only if the event loop returns to its timer. Unobserved measurements stay null.
 */
export function loopStallMessage(facts: DaemonLoopFacts, expectedMs: number): string {
  const end = Date.parse(facts.windowEndedAt);
  const start = end - facts.windowMs;
  const worstSyncInWindow = processTiming.worstSync().filter((sample) => {
    const at = Date.parse(sample.at);
    return at >= start && at <= end;
  });
  const { rss, heapUsed } = process.memoryUsage();
  return `loop window delayed ${JSON.stringify({
    expectedMs,
    windowMs: facts.windowMs,
    lateMs: Math.max(0, rounded(facts.windowMs - expectedMs)),
    windowEndedAt: facts.windowEndedAt,
    delay: facts.delay,
    utilization: facts.utilization,
    gc: facts.gc,
    memory: { rssBytes: rss, heapUsedBytes: heapUsed },
    worstSyncInWindow,
  })}`;
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function readGeneration(path: string, lines: number) {
  try {
    if (!present(path)) return null;
    const tail = readDaemonDiagnosticTail({ path, lines });
    return { text: tail.text, hasEvents: tail.kind === "retained" && tail.text.trim() !== "" };
  } catch (error) {
    return {
      text: `[rare daemon history unavailable (${safeProblemMessage(basename(path))}): ${safeProblemMessage(error)}]\n`,
      hasEvents: false,
    };
  }
}

/**
 * Read each generation independently so a rejected file cannot hide its sibling.
 * Only retained, nonempty lines count as events when the main log is unavailable.
 */
export function readDaemonRareHistory(
  options: { path?: string; lines?: number } = {},
): { text: string; hasEvents: boolean } | null {
  const path = options.path ?? rareHistoryPath();
  const lines = options.lines ?? 40;
  const current = readGeneration(path, lines);
  const missing = lines - (current?.hasEvents ? lineCount(current.text) : 0);
  const older = missing > 0 ? readGeneration(`${path}.1`, missing) : null;
  if (!current && !older) return null;
  const head = older?.text ?? "";
  const separator = head && !head.endsWith("\n") ? "\n" : "";
  return {
    text: head + separator + (current?.text ?? ""),
    hasEvents: Boolean(older?.hasEvents || current?.hasEvents),
  };
}

/** Show a mirrored JSON record once in text. Both tails stay available in JSON. */
export function withRareHistory(tail: string, rare: string, path: string = rareHistoryPath()) {
  const rareLines = rare.split("\n");
  for (const line of tail.split("\n")) {
    if (!line.startsWith('{"timestamp":')) continue;
    const copy = rareLines.indexOf(line);
    if (copy >= 0) rareLines.splice(copy, 1);
  }
  const extra = rareLines.join("\n");
  if (!extra) return tail;
  const separator = tail && !tail.endsWith("\n") ? "\n" : "";
  return `${tail}${separator}--- rare daemon events (${path}) ---\n${extra}`;
}
