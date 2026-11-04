import type { HarnessEvent, ReportedCommandOutcomes } from "@claudexor/schema";
import { commandOutcomeRefinement, commandOutcomeUnconfirmed } from "@claudexor/schema";

/** How many reports an attempt keeps; `total` stays the true count. */
const REPORTS_KEPT = 20;

export interface CommandTelemetry {
  /** #546: the vendor's reports about commands handed to a background shell,
   * absent until one arrives and kept across native retries of the attempt.
   * Never a tool error: no recovery, warning, terminal or ranking policy reads
   * this, because a reported word proves neither an exit nor a failed call. */
  reportedCommandOutcomes?: ReportedCommandOutcomes;
}

/** #450: the tool errors a successful result may recover: none when the result
 * does not establish an observed command end. */
export function recoverable<T>(errors: T[], outcome: unknown): T[] {
  return commandOutcomeUnconfirmed(outcome) ? [] : errors;
}

/** Keep one typed report as a fact about its command. Anything else, including a
 * row that claims an exit or an undefined word, records nothing. */
export function observeCommandReport(t: CommandTelemetry, event: HarnessEvent): void {
  const reported = commandOutcomeRefinement(event);
  if (!reported || !event.tool) return;
  const log = (t.reportedCommandOutcomes ??= { total: 0, recent: [] });
  log.total += 1;
  log.recent = [
    ...log.recent,
    {
      tool: event.tool.name,
      target: event.tool.target ?? null,
      tool_use_id: reported.useId,
      command_outcome: reported.outcome,
    },
  ].slice(-REPORTS_KEPT);
}
