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
export function keyedLaunchNeedsProject(mode: ModeKind): CliError {
  const askOnly = mode === "ask" ? ", or noProject: true for an Ask without a project" : "";
  return new CliError(
    "usage",
    `idempotencyKey needs an explicit repoPath${askOnly}: a replayable launch names its scope instead of following the MCP server's working directory`,
    {
      code: "idempotency_repo_path_required",
      retryable: false,
      requiredActions: [
        mode === "ask"
          ? "Pass repoPath as the absolute project root, or noProject: true for a general question, with idempotencyKey, and keep the arguments identical on every replay."
          : "Pass repoPath as the absolute project root with idempotencyKey, and keep both identical on every replay.",
      ],
    },
  );
}

/**
 * The public Ask's explicit no-project request: true selects the engine's
 * existing `scope: {kind: "none"}`; false or omission keeps the project scope.
 * It never moves a Delegate child off its parent's project, and it refuses a
 * repoPath beside it instead of silently preferring one scope. `execution`
 * passes through unchanged: the shared run-start normalizer alone admits it.
 */
export function requestsNoProjectAsk(
  p: Record<string, unknown> | null | undefined,
  mode: ModeKind,
  beltContext: boolean,
): boolean {
  const value = p?.["noProject"];
  if (value === undefined) return false;
  const refuse = (code: string, message: string, action: string) =>
    new CliError("usage", message, { code, retryable: false, requiredActions: [action] });
  if (beltContext)
    throw refuse(
      "delegation_scope_fixed",
      "noProject is not a Delegate argument: a child always runs in its parent's project",
      "Omit noProject; ask a no-project question from the parent's own MCP client instead.",
    );
  if (typeof value !== "boolean" || mode !== "ask")
    throw refuse(
      "no_project_invalid",
      "noProject is a boolean accepted only by a public Ask launch",
      "Pass noProject as true or false on claudexor_ask only.",
    );
  if (!value) return false;
  if (p?.["repoPath"] !== undefined)
    throw refuse(
      "no_project_scope_conflict",
      "noProject: true and repoPath name two different scopes",
      "Pass either repoPath for a project Ask or noProject: true for a general question, not both.",
    );
  return true;
}
