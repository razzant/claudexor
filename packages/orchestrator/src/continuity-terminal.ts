/**
 * The terminal `resumable` block (INTERFACES §2): present on every terminal
 * whose WORK is unfinished and can be continued — non-success lifecycles and
 * `succeeded` runs whose work state is `needs_input`/`incomplete`. The attempt
 * loop decides it (`InRunContinuity.finish`); this owner materializes it as
 * `final/resumable.yaml` and the payload fragment every terminal event carries,
 * so no lane re-derives the block.
 */
import { join } from "node:path";
import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import { readRunEvents } from "@claudexor/event-log";
import type { PoolAttemptFailure, ResumableCause, RunResumable } from "@claudexor/schema";
import { runExecutionFacts } from "@claudexor/workspace";

export interface ContinuityTerminalFacts {
  /** Every failed try of the attempt with its own account (diagnostic). */
  poolAttempts?: PoolAttemptFailure[];
  /** Some try of the attempt started with an accepted handshake. */
  started?: boolean;
  resumable?: RunResumable;
  /** Internal snapshot used only if gates/review/arbitration later leave work unfinished. */
  resumableOnFailure?: RunResumable;
}

/** Execution roots without an isolated envelope survive this run (Agent and Ask). */
export function continuityWorkspace(
  envelope: { worktree_path: string; repo_root: string } | null,
  cwd: string,
): RunResumable["workspace"] {
  return !envelope || envelope.worktree_path === envelope.repo_root
    ? { kind: "in_place", root: cwd }
    : { kind: "none", root: null };
}

/**
 * A serial Ask chain: a completed winner speaks alone, so no failed attempt's
 * block survives it. Otherwise the newest started attempt whose own recorded
 * activity shows progress (the run log's facts, the successor planner's rule),
 * else the newest started one, carries the run's latest work. A block's
 * `packet` carrier is no such fact: a continued run's later attempt inherits
 * the chain's `acted`. So a fallback that never started, or started and did
 * nothing, cannot evict an earlier carrier. Concurrent candidates keep the
 * first-declared rule below.
 */
export function carryingAttempts<
  T extends ContinuityTerminalFacts & { attemptId: string; status?: string },
>(items: readonly T[], runDir: string): T[] {
  const winner = items.findLast((item) => item.status === "success");
  if (winner) return [winner];
  const { progressed } = runExecutionFacts(readRunEvents(join(runDir, "events.jsonl")).events);
  const started = items.filter((item) => item.started);
  const carrier = started.findLast((item) => progressed.has(item.attemptId)) ?? started.at(-1);
  return carrier ? [carrier] : [...items];
}

/** The first attempt that declared continuation facts speaks for the run. */
export function resumableOf(
  items: ReadonlyArray<ContinuityTerminalFacts>,
  cause?: ResumableCause,
): RunResumable | null {
  const declared = items.find((item) => item.resumable)?.resumable;
  if (declared) return declared;
  if (!cause) return null;
  const completed = items.find((item) => item.resumableOnFailure)?.resumableOnFailure;
  return completed ? { ...completed, cause } : null;
}

/** Write `final/resumable.yaml` when present and return the terminal payload fragment. */
export function resumableTerminal(
  store: ArtifactStore,
  paths: Pick<RunPaths, "finalDir">,
  items: ReadonlyArray<ContinuityTerminalFacts>,
  nonSuccess = false,
): { resumable: RunResumable } | Record<never, never> {
  const resumable = resumableOf(items, nonSuccess ? "other" : undefined);
  if (!resumable) return {};
  store.writeYaml(join(paths.finalDir, "resumable.yaml"), resumable);
  return { resumable };
}
