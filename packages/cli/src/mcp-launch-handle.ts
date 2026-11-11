import {
  isTerminalLifecycle,
  acceptedReceiptMetadata,
  taskGroupReceiptMetadata,
  type ModeKind,
  type RunOutcomeFacts,
} from "@claudexor/schema";
import { daemonOutcomeSummary, fetchRunDetail, type DaemonRunOutcome } from "./daemon-run.js";
import {
  describeRunDetailProblem,
  presentRunPrimaryOutput,
  projectRunFailure,
  projectRunPrimaryOutput,
} from "./run-detail-projections.js";
import { primaryOutputForCli } from "./primary-output.js";
import { CliError } from "./cli-error.js";
import type { ControlApiAddress } from "./live.js";
import { projectImmediateRunDetail } from "./mcp-run-projections.js";

/**
 * The MCP projection of one accepted launch or successor: its durable job
 * handle, the bound run once it exists, and the detail facts a deferred
 * handle can already report. A job that is still queued, or that failed
 * before any run started, stays a handle (jobId) instead of an error.
 */
export async function projectLaunchHandle(
  addr: ControlApiAddress,
  out: DaemonRunOutcome,
  opts: { deferred: boolean; mode?: ModeKind },
): Promise<Record<string, unknown>> {
  const terminal = isTerminalLifecycle(out.status);
  // Only a deferred handle addresses an unbound job by its job id; the
  // terminal-waiting belt keeps its bound-run reads.
  const address = out.runId || (opts.deferred ? out.jobId : "");
  try {
    let detail: Record<string, unknown> | null = null;
    let canonicalPrimary: ReturnType<typeof projectRunPrimaryOutput> = null;
    let detailProjection = projectImmediateRunDetail(null, { runId: out.runId });
    let detailProblem: ReturnType<typeof describeRunDetailProblem> | null = null;
    if (!opts.deferred || terminal) {
      try {
        detail = await fetchRunDetail(addr, address);
        detailProjection = projectImmediateRunDetail(detail, {
          runId: address,
          ...(terminal ? { lifecycle: out.status as RunOutcomeFacts["lifecycle"] } : {}),
        });
        canonicalPrimary = projectRunPrimaryOutput(detail);
      } catch (error) {
        detail = null;
        detailProblem = describeRunDetailProblem(error);
        detailProjection = projectImmediateRunDetail(null, { runId: out.runId });
      }
    }
    // Local artifacts remain only the established soft-absence fallback.
    const localFallback =
      (!opts.deferred || terminal) && !detail && !detailProblem && out.runDir && opts.mode
        ? primaryOutputForCli(out.runDir, opts.mode, {
            failure: projectRunFailure(detail),
            lifecycle: terminal ? (out.status as RunOutcomeFacts["lifecycle"]) : undefined,
          })
        : null;
    const primary = canonicalPrimary ?? localFallback;
    const presented = presentRunPrimaryOutput(primary);
    const reason = daemonOutcomeSummary({
      ...out,
      outcomeFacts: detailProjection.outcomeFacts ?? undefined,
    });
    const unbound =
      !out.runId && out.jobId && !terminal
        ? `accepted as job ${out.jobId}; no run has started yet (${out.status || "state unknown"}). Follow it with claudexor_run_wait or claudexor_run_status using runId ${out.jobId}.`
        : null;
    const summary =
      presented ??
      detailProjection.outcomeBanner ??
      unbound ??
      reason ??
      (primary?.kind === "patch" ? "patch produced (see artifacts)" : `run ${out.status}`);
    return {
      runId: out.runId,
      jobId: out.jobId,
      runDir: out.runDir,
      status: out.status,
      summary,
      ...detailProjection,
      ...(out.runId ? {} : taskGroupReceiptMetadata(out.errorContext)),
      ...acceptedReceiptMetadata(out),
      ...(detailProblem ? { detailProblem } : {}),
    };
  } catch (error) {
    // The run's terminal is already durable at this point: mark the throw so
    // the delegation belt keeps the child's slot consumed and reconciles its
    // spend fail-closed instead of treating the child as never-started.
    if (error && typeof error === "object") {
      Object.assign(error, {
        delegationChildTerminal: { runId: out.runId, status: out.status },
      });
    }
    throw error;
  }
}

/** Replay authority stays with the same registered project, never this process's cwd. */
export function keyedLaunchNeedsProject(): CliError {
  return new CliError(
    "usage",
    "idempotencyKey needs an explicit repoPath: a replayable launch names its project instead of following the MCP server's working directory",
    {
      code: "idempotency_repo_path_required",
      retryable: false,
      requiredActions: [
        "Pass repoPath as the absolute project root with idempotencyKey, and keep both identical on every replay.",
      ],
    },
  );
}
