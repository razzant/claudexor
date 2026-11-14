import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import type { BudgetLedger } from "@claudexor/budget";
import {
  EventLog,
  type TerminalPersistenceHook,
  type TerminalStagingHook,
} from "@claudexor/event-log";
import type { ModeKind, QuotaSnapshot, RunEvent, TaskContract } from "@claudexor/schema";
import { safeInvoke } from "@claudexor/util";
import { writeContinuationSources } from "@claudexor/workspace";
import type { DelegationBudgetAuthority } from "./delegationBudgetAuthority.js";
import type { RunInput } from "./orchestrator.js";
import { createRootLedger } from "./root-ledger.js";
import { announcedRunContext, type AnnouncedRunContext } from "./runTerminalContext.js";

interface RunEventLogInput {
  threadId?: string;
  onEventPersist?: (event: RunEvent) => void;
  onTerminalPersist?: TerminalPersistenceHook;
  onTerminalStage?: TerminalStagingHook;
  onEvent?: (event: RunEvent) => void;
}

interface RunAnnouncementInput {
  input: RunInput;
  contract: TaskContract;
  quotaSnapshots: readonly QuotaSnapshot[];
  store: ArtifactStore;
  authority?: DelegationBudgetAuthority;
  runId: string;
  taskId: string;
  mode: ModeKind;
  phase: "race" | "convergence" | "plan" | "report";
  prompt: string;
}

/** Keep durable-journal and live-observer callback ordering identical at every
 * run entry point. A run's log queues its lines on the ordered appender: each
 * line's `onEventPersist` and `onEvent` run when it lands. */
export function createRunEventLog(
  eventsPath: string,
  runId: string,
  taskId: string,
  input: RunEventLogInput,
): EventLog {
  const log = new EventLog(
    eventsPath,
    runId,
    taskId,
    input.onEventPersist,
    input.threadId,
    input.onEvent,
    { queued: true },
  );
  if (input.onTerminalPersist) log.setTerminalPersistence(input.onTerminalPersist);
  if (input.onTerminalStage) log.setTerminalStaging(input.onTerminalStage);
  return log;
}

/**
 * Everything after EventLog construction and before `run.created` persists is
 * still pre-announce: a ledger or durable-sink refusal must escape without the
 * terminal safety net. Release live-writer ownership across that whole window
 * so a failed startup cannot strand the run path behind the duplicate-owner
 * fence. `prepare` awaits the landing of `run.created`, its durable sink
 * included, inside this window.
 */
export async function prepareRunAnnouncement<T>(
  log: EventLog,
  prepare: () => T | Promise<T>,
): Promise<T> {
  try {
    return await prepare();
  } catch (error) {
    log.dispose();
    throw error;
  }
}

async function announcePreparedProjectGitInitialization(
  input: RunInput,
  log: EventLog,
): Promise<void> {
  const result = input.projectGitInitialization;
  if (!result || (!result.initialized && !result.baselineCommitted)) return;
  await log.emitLanded("project.git.initialized", {
    repo_root: input.repoRoot,
    initialized: result.initialized,
    baseline_committed: result.baselineCommitted,
    gitignore_seeded: result.gitignoreSeeded,
    head_sha: result.headSha,
  });
}

/**
 * One startup boundary for every run strategy. A delegated ledger must be
 * attached before run.created (X339), while caller-visible publication must
 * wait until that event lands and reaches the durable sink. Arm the whole-run
 * terminal guard before any later preamble callback/event can fail; a refused
 * `project.git.initialized` landing then rejects out of here, after announce.
 */
export async function beginAnnouncedRun(
  start: RunAnnouncementInput,
  announce: (context: AnnouncedRunContext) => void,
): Promise<{
  store: ArtifactStore;
  paths: RunPaths;
  log: EventLog;
  ledger: BudgetLedger;
  runContext: AnnouncedRunContext;
}> {
  const { input, contract, quotaSnapshots, store, authority, runId, taskId, mode, phase } = start;
  const paths = store.createRun(runId);
  const log = createRunEventLog(paths.eventsPath, runId, taskId, input);
  const ledger = await prepareRunAnnouncement(log, async () => {
    const preparedLedger = createRootLedger({
      input,
      contract,
      log,
      authority,
      quotaSnapshots,
    });
    if (input.continuation?.from) {
      const from = input.continuation.from;
      writeContinuationSources(paths.root, [from, ...(from.ancestors ?? [])]);
    }
    await log.emitLanded("run.created", { mode, prompt: start.prompt });
    return preparedLedger;
  });
  const runContext = announcedRunContext(
    { log, store, paths, runId, taskId, mode, phase },
    ledger,
    () => authority?.hasParent(runId) === true,
  );
  announce(runContext);
  safeInvoke(input.onRunStart, { runId, taskId, runDir: paths.root });
  await announcePreparedProjectGitInitialization(input, log);
  return { store, paths, log, ledger, runContext };
}
