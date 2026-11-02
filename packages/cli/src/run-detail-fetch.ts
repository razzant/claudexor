/**
 * Run-detail fetch wrappers + terminal projections, split from daemon-run.ts
 * (complexity ratchet): everything here rides GET /runs/:id (or the run's
 * terminal facts) and stays free of daemon lifecycle/enqueue concerns.
 * Callers keep importing from daemon-run.js via its re-exports.
 */
import { controlProblemError } from "./cli-error.js";
import { controlApiFetch, processExitCodeForRunStatus, type ControlApiAddress } from "./live.js";
import { type RunOutcomeFacts, outcomeExitCode } from "@claudexor/schema";
import {
  projectApplyEligibility,
  projectOutcomeBanner,
  type ApplyEligibilityProjection,
} from "./run-detail-projections.js";
import { projectRunOutcomeFacts } from "./daemon-outcome.js";
import { readRunDetailResponse } from "./run-detail-response.js";

/** Daemon job state (= run lifecycle, D8) -> CLI exit code via the ONE
 * projection owner: a succeeded lifecycle is 0 (a "Done · needs review" run
 * included); everything else is 1. When the run's terminal outcome `facts` are
 * available, the D-16 outcome-aware projection is used instead so a
 * needs_input/incomplete work_state exits non-zero on a succeeded lifecycle. */
export function exitCodeForState(state: string, facts?: RunOutcomeFacts | null): number {
  if (facts) return outcomeExitCode(facts);
  return processExitCodeForRunStatus(state);
}

/** Server-derived plan readiness projection (mode=plan runs). */
export async function fetchPlanReadiness(
  addr: ControlApiAddress,
  runId: string,
): Promise<{ state: string; questionCount: number } | null> {
  if (!runId) return null;
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) return null;
    const detail = (await res.json()) as Record<string, unknown>;
    const v = detail["planReadiness"];
    return v && typeof v === "object" ? (v as { state: string; questionCount: number }) : null;
  } catch {
    return null;
  }
}

/** The plan run's open questions (D17), projected from GET /runs/:id — the
 * SAME server artifact readiness derives from, never a client re-parse. Empty
 * for ready/unverified plans and every non-plan run. */
export async function fetchPlanQuestions(
  addr: ControlApiAddress,
  runId: string,
): Promise<import("@claudexor/schema").PlanQuestion[]> {
  if (!runId) return [];
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) return [];
    const detail = (await res.json()) as Record<string, unknown>;
    const v = detail["planQuestions"];
    return Array.isArray(v) ? (v as import("@claudexor/schema").PlanQuestion[]) : [];
  } catch {
    return [];
  }
}

/** Council membership + merge disclosure (INV-031) for a --council plan run;
 * null for solo plans and non-plan runs. Server-projected — the CLI never
 * re-derives membership. */
export async function fetchCouncil(
  addr: ControlApiAddress,
  runId: string,
): Promise<{
  requested: number;
  drafted: number;
  degraded: boolean;
  mergedBy: string | null;
  members: { harnessId: string; role: string; status: string; error: string | null }[];
} | null> {
  if (!runId) return null;
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) return null;
    const detail = (await res.json()) as Record<string, unknown>;
    const v = detail["council"];
    return v && typeof v === "object"
      ? (v as {
          requested: number;
          drafted: number;
          degraded: boolean;
          mergedBy: string | null;
          members: { harnessId: string; role: string; status: string; error: string | null }[];
        })
      : null;
  } catch {
    return null;
  }
}

/**
 * ONE GET /runs/:id for the terminal path (INV-120/122): fetch the run detail
 * once and feed every pure projection below. Three-state semantics:
 * a MISSING detail (404 / legacy run) and a transport-UNAVAILABLE detail both
 * soft-fail to null (a hiccup must never eat a finished run's result), while a
 * typed problem response — especially 500 run_facts_invalid, the server's
 * verdict that the run's canonical receipt cannot be trusted — raises through
 * the typed CLI failure path (controlProblemError -> renderCliFailure,
 * non-zero exit) instead of masquerading as a legacy run. The per-projection
 * `fetch*` wrappers stay for callers that need exactly one projection.
 */
export async function fetchRunDetail(
  addr: ControlApiAddress,
  runId: string,
): Promise<Record<string, unknown> | null> {
  if (!runId) return null;
  let res: Awaited<ReturnType<typeof controlApiFetch>>;
  try {
    res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`);
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    throw controlProblemError(res.status, body, `run detail failed (HTTP ${res.status})`);
  }
  return readRunDetailResponse(res);
}

export async function fetchApplyEligibility(
  addr: ControlApiAddress,
  runId: string,
): Promise<ApplyEligibilityProjection | null> {
  return projectApplyEligibility(await fetchRunDetail(addr, runId));
}

/**
 * The run's terminal outcome facts through fetchRunDetail's THREE-state
 * semantics (INV-120/122): missing/legacy detail and transport loss project
 * null (the lifecycle-only exit stands), while a typed problem response — the
 * server's verdict that the terminal cannot be trusted (500 run_facts_invalid)
 * — raises into the CLI failure path instead of silently exiting as if the
 * facts never existed. Makes the direct-run CLI exit outcome-aware for a
 * work_state veto (callers that need only this one projection).
 */
export async function fetchRunOutcomeFacts(
  addr: ControlApiAddress,
  runId: string,
): Promise<RunOutcomeFacts | null> {
  return projectRunOutcomeFacts(await fetchRunDetail(addr, runId));
}

/**
 * The server-owned outcome banner for a run (D18): the single honest headline,
 * derived by the control-plane projection owner. The CLI PRINTS it verbatim —
 * it never re-derives a headline of its own, so model prose can never outrank
 * the arbitrated truth. Null while the run is not terminal or unavailable.
 */
export async function fetchOutcomeBanner(
  addr: ControlApiAddress,
  runId: string,
): Promise<string | null> {
  return projectOutcomeBanner(await fetchRunDetail(addr, runId));
}

/**
 * Machine-readable reason for a non-clean DAEMON terminal (P2, D8). A
 * needs-decision run (review blocked / checks failed) has a SUCCEEDED lifecycle
 * and no `error`, so key the actionable decision hint on the run FACTS, not on
 * the lifecycle; other non-succeeded lifecycles use the error or a reason
 * label. A clean succeeded run returns undefined (no `summary` key emitted).
 */
export function daemonOutcomeSummary(out: {
  runId: string;
  status: string;
  error?: string;
  outcomeFacts?: RunOutcomeFacts | null;
}): string | undefined {
  const facts = out.outcomeFacts ?? null;
  const needsDecision =
    !!facts &&
    facts.lifecycle === "succeeded" &&
    (facts.review === "blocked" || facts.checks === "failed");
  if (needsDecision) {
    return `run needs a human decision — claudexor decision ${out.runId} --accept-risk | --rerun --feedback "..."`;
  }
  if (out.error) return out.error;
  if (exitCodeForState(out.status, facts) === 0) return undefined;
  return `run ${out.status}${facts?.reason ? ` (${facts.reason})` : ""}`;
}
