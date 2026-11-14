import { randomUUID } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { emitBestEffort, writeRetainedOutput } from "@claudexor/event-log";
import { redactSecrets } from "@claudexor/util";
import type { AnnouncedRunContext } from "./runTerminalContext.js";

/** A readable projection is independent of acceptance and never masks the original
 * terminal. Returns the path it announced (`output.ready`), else null. A failed
 * terminal's record then names it (a cancellation keeps its own): an optional
 * step after the announcement, whose own failure cannot undo it. */
export function publishRetainedOutput(
  context: AnnouncedRunContext,
  succeeded: boolean,
  failed = false,
): string | null {
  let path: string | null;
  try {
    const source = context.log.readAll();
    path = writeRetainedOutput(context.paths.root, source, succeeded);
    if (!path) return null;
    const lastOutput = source.events.findLast((event) => event.type === "output.ready");
    // Aside, as `status` below: best-effort, never another line's failure (#704).
    emitBestEffort(context.log, "output.ready", {
      kind: "report",
      path,
      state: succeeded && lastOutput?.payload["state"] !== "diagnostic" ? "ready" : "diagnostic",
    });
  } catch (error) {
    status(
      context,
      "Retained output could not be saved",
      `Retained output could not be saved: ${String(error)}`,
      {
        retained_output_failed: true,
      },
    );
    return null;
  }
  if (failed) {
    try {
      referenceFromFailure(context, path);
    } catch (error) {
      status(
        context,
        "Failure record not updated",
        `The failure record could not name ${path}: ${String(error)}; the original record is unchanged.`,
      );
    }
  }
  return path;
}

/** A failure record's message and references once they name the retained
 * output at `path`. The notice that the file holds retained text, not an
 * accepted final answer, follows the message's first line (the cause route
 * health groups by) and precedes the rest of the original message, such as its
 * account attempts, so a reader that bounds the message after a cause line of
 * ordinary length still meets it; a very long cause line can still push it past
 * such a bound. The original text is otherwise unchanged around it, and
 * `logRefs` (run-relative, beside `runDir`) is the address. Only the failure
 * record carries it: the terminal's event error and summaries keep their own
 * text. */
export function namingRetainedOutput(
  safeMessage: string,
  logRefs: readonly string[],
  path: string,
): { safeMessage: string; logRefs: string[] } {
  const notice = `The assistant text this run retained (not an accepted final answer) is in ${path}.`;
  const lineEnd = safeMessage.search(/\r?\n/);
  const cause = lineEnd < 0 ? safeMessage : safeMessage.slice(0, lineEnd);
  const rest = lineEnd < 0 ? "" : safeMessage.slice(lineEnd);
  return {
    safeMessage: safeMessage ? `${cause}\n\n${notice}${rest}` : notice,
    logRefs: logRefs.includes(path) ? [...logRefs] : [...logRefs, path],
  };
}

/**
 * The failure record the terminal wrote before this publication names the
 * written projection (`namingRetainedOutput`), once. The record is replaced
 * atomically, through a temporary file and a rename as the projection itself is
 * published, so a failed write or rename leaves the original record whole.
 */
function referenceFromFailure(context: AnnouncedRunContext, path: string): void {
  const file = join(context.paths.finalDir, "failure.yaml");
  const failure = context.store.readYaml<Record<string, unknown>>(file);
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return;
  const logRefs = Array.isArray(failure["logRefs"])
    ? failure["logRefs"].filter((ref): ref is string => typeof ref === "string")
    : [];
  if (logRefs.includes(path)) return;
  const message = typeof failure["safeMessage"] === "string" ? failure["safeMessage"] : "";
  const temporary = join(context.paths.finalDir, `.failure-${randomUUID()}.tmp`);
  try {
    context.store.writeYaml(temporary, {
      ...failure,
      ...namingRetainedOutput(message, logRefs, path),
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function status(
  context: AnnouncedRunContext,
  title: string,
  text: string,
  payload?: Record<string, unknown>,
): void {
  try {
    emitBestEffort(context.log, "harness.event", {
      type: "status",
      title,
      text: redactSecrets(text),
      ...(payload ? { payload } : {}),
    });
  } catch {
    /* Preserve the original terminal even when its log is unwritable. */
  }
}
