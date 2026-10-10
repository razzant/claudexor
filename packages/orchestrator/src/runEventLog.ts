import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import type { BudgetLedger } from "@claudexor/budget";
import { EventLog, type TerminalPersistenceHook } from "@claudexor/event-log";
import type { ModeKind, QuotaSnapshot, RunEvent, TaskContract } from "@claudexor/schema";
import { redactSecrets, safeInvoke } from "@claudexor/util";
import { writeContinuationSources } from "@claudexor/workspace";
import type { DelegationBudgetAuthority } from "./delegationBudgetAuthority.js";
import type { RunInput } from "./orchestrator.js";
import { createRootLedger } from "./root-ledger.js";
import { announcedRunContext, type AnnouncedRunContext } from "./runTerminalContext.js";

interface RunEventLogInput {
  threadId?: string;
  onEventPersist?: (event: RunEvent) => void;
  onTerminalPersist?: TerminalPersistenceHook;
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

/** Keep durable-journal and live-observer callback ordering identical at every run entry point. */
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
  );
  if (input.onTerminalPersist) log.setTerminalPersistence(input.onTerminalPersist);
  return log;
}

/**
 * Everything after EventLog construction and before `run.created` persists is
 * still pre-announce: a ledger or durable-sink refusal must escape without the
 * terminal safety net. Release live-writer ownership across that whole window
 * so a failed startup cannot strand the run path behind the duplicate-owner
 * fence.
 */
export function prepareRunAnnouncement<T>(log: EventLog, prepare: () => T): T {
  try {
    return prepare();
  } catch (error) {
    log.dispose();
    throw error;
  }
}

function announcePreparedProjectGitInitialization(input: RunInput, log: EventLog): void {
  const result = input.projectGitInitialization;
  if (!result || (!result.initialized && !result.baselineCommitted)) return;
  log.emit("project.git.initialized", {
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
 * wait until that event reaches the durable sink. Arm the whole-run terminal
 * guard before any later preamble callback/event can fail.
 */
export function beginAnnouncedRun(
  start: RunAnnouncementInput,
  announce: (context: AnnouncedRunContext) => void,
): { store: ArtifactStore; paths: RunPaths; log: EventLog; ledger: BudgetLedger } {
  const { input, contract, quotaSnapshots, store, authority, runId, taskId, mode, phase } = start;
  const paths = store.createRun(runId);
  const log = createRunEventLog(paths.eventsPath, runId, taskId, input);
  const ledger = prepareRunAnnouncement(log, () => {
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
    log.emit("run.created", { mode, prompt: redactSecrets(start.prompt) });
    return preparedLedger;
  });
  announce(
    announcedRunContext(
      { log, store, paths, runId, taskId, mode, phase },
      ledger,
      () => authority?.hasParent(runId) === true,
    ),
  );
  safeInvoke(input.onRunStart, { runId, taskId, runDir: paths.root });
  announcePreparedProjectGitInitialization(input, log);
  return { store, paths, log, ledger };
}
