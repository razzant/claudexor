/**
 * A2: typed per-attempt output markers for the STRUCTURAL rotation predicate.
 *
 * `sawAgentProgress` proves the agent demonstrably started working under the
 * current credential — after that, a credential rotation would silently replay
 * work (and any external side effects a tool call already performed), so the
 * structural branch must never fire. The policy is deliberately NARROWER than
 * the inactivity watchdog's `countsAsAgentProgress`: `message` and `error`
 * events do NOT count, because a vendor's limit/failure prose arriving as a
 * message must never block the structural branch (the exact incident class
 * this predicate exists to close), and `status` events are lifecycle/failure
 * disclosures, never model work.
 *
 * `fileChanges` counts typed `file_change` events WITHOUT requiring a tool ref
 * (adapters legitimately emit tool-less file_change frames), so the mutation
 * guard sees every disclosed write even when the workspace diff is empty or —
 * in the read-only lane — no workspace exists at all.
 */
import type { HarnessEvent } from "@claudexor/schema";

export interface AttemptOutputMarkers {
  /** The agent demonstrably produced work under this credential (thinking /
   * tool activity / file or patch output / a completed compaction). */
  sawAgentProgress: boolean;
  /** Count of typed `file_change` events observed this attempt (tool-less
   * frames included). */
  fileChanges: number;
  /** The adapter reported a typed `started` event: the vendor session came up
   * under this credential. An adapter's own pre-spawn refusal (a readiness
   * probe that could not confirm the login, a bad flag) never emits one.
   * Absent reads as false: missing evidence never marks an account. */
  sawSessionStart?: boolean;
}

export function newAttemptOutputMarkers(): AttemptOutputMarkers {
  return { sawAgentProgress: false, fileChanges: 0, sawSessionStart: false };
}

/**
 * The closed event policy: thinking (non-empty), tool_call, tool_result,
 * file_change, patch_produced, and a completed compaction mark agent progress.
 * Everything else — message, error, status, started, usage, lifecycle — does
 * not.
 */
export function marksAgentProgress(ev: HarnessEvent): boolean {
  switch (ev.type) {
    case "thinking":
      return (ev.text?.trim().length ?? 0) > 0;
    case "tool_call":
    case "tool_result":
    case "file_change":
    case "patch_produced":
      return true;
    case "context":
      return ev.context?.kind === "compaction_completed";
    default:
      return false;
  }
}

export function observeAttemptOutputMarkers(m: AttemptOutputMarkers, ev: HarnessEvent): void {
  if (ev.type === "file_change") m.fileChanges += 1;
  if (ev.type === "started") m.sawSessionStart = true;
  if (!m.sawAgentProgress && marksAgentProgress(ev)) m.sawAgentProgress = true;
}
