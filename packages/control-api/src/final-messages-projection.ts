/**
 * #307: a run's final-messages outcome, as its terminal recorded it. Detail
 * reads take it from the event fold they already make and check a recorded
 * document with one lstat; nothing walks the log again or hashes the document.
 * Only the artifact transfer verifies the digest, on the bytes it sends.
 */
import { lstatSync } from "node:fs";
import { terminalTypeOf } from "@claudexor/event-log";
import { FinalMessagesOutcome, type FinalMessagesPointer, RunEvent } from "@claudexor/schema";
import type { ArtifactReadResult } from "./artifact-read.js";
import { safeArtifactPath } from "./artifact-paths.js";

/** The first terminal's recorded outcome: later rows (control audits) never replace it.
 * No terminal yet, or one that recorded none (an older engine), is unknown. */
export interface FinalMessagesFold {
  terminal: "legacy" | "recorded" | null;
  outcome: FinalMessagesOutcome | null;
}

export function emptyFinalMessagesFold(): FinalMessagesFold {
  return { terminal: null, outcome: null };
}

export function addFinalMessagesEvent(fold: FinalMessagesFold, ev: Record<string, unknown>): void {
  if (fold.terminal || !terminalTypeOf(ev["type"])) return;
  // The producer's event-file reader skips invalid RunEvents. Apply its schema
  // to terminal candidates here, inside the same incremental fold.
  const event = RunEvent.safeParse(ev);
  if (!event.success) return;
  const { payload, seq } = event.data;
  fold.terminal = Object.hasOwn(payload, "final_messages") ? "recorded" : "legacy";
  const parsed = FinalMessagesOutcome.safeParse(payload["final_messages"]);
  if (!parsed.success) return;
  const outcome = parsed.data;
  // A document's coverage precedes the terminal that records it.
  const covered =
    outcome.state === "unavailable" || seq === undefined || outcome.throughEventSeq < seq;
  fold.outcome = covered ? outcome : null;
}

/** The recorded document's confined real path while it has the recorded size. */
function documentPath(runDir: string | undefined, pointer: FinalMessagesPointer): string | null {
  if (!runDir) return null;
  try {
    const path = safeArtifactPath(runDir, pointer.path);
    if (!path) return null;
    const stat = lstatSync(path);
    return stat.isFile() && stat.size === pointer.bytes ? path : null;
  } catch {
    // An unreadable document is a gap; the run's primary output stays readable.
    return null;
  }
}

/** What a result surface publishes: the recorded pointer while its document still
 * has that size, otherwise a typed gap, never a dangling address; null when no
 * outcome is known. */
export function projectedFinalMessages(
  runDir: string | undefined,
  outcome: FinalMessagesOutcome | null,
): FinalMessagesOutcome | null {
  if (!outcome || outcome.state === "unavailable") return outcome;
  return documentPath(runDir, outcome)
    ? outcome
    : { state: "unavailable", reason: "artifact_unavailable" };
}

export function finalMessagesUnavailable(
  reason: Extract<FinalMessagesOutcome, { state: "unavailable" }>["reason"],
) {
  return {
    kind: "error" as const,
    status: 409,
    body: {
      code: "final_messages_unavailable",
      error: `Final messages unavailable: ${reason}`,
      reason,
    },
  };
}

/** Only a legacy terminal without a declaration uses the ordinary capped
 * artifact reader. A declared document is served by the verified transfer. */
export function readFinalMessagesArtifact(
  runDir: string,
  { terminal, outcome }: FinalMessagesFold,
): ArtifactReadResult | null {
  if (terminal === "legacy") return null;
  if (!outcome) {
    return {
      kind: "error",
      status: terminal ? 409 : 404,
      body: terminal
        ? {
            code: "final_messages_invalid",
            error: "The terminal's final-messages record is invalid.",
          }
        : { code: "final_messages_unknown", error: "No terminal has recorded final messages." },
    };
  }
  if (outcome.state === "unavailable") return finalMessagesUnavailable(outcome.reason);
  const path = documentPath(runDir, outcome);
  if (!path) return finalMessagesUnavailable("artifact_unavailable");
  return {
    kind: "files",
    transfer: {
      path,
      expectedHash: outcome.sha256,
      expectedSize: outcome.bytes,
      contentType: "text/plain; charset=utf-8",
      kind: "final_messages",
    },
  };
}
