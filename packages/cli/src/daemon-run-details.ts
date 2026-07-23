import type { PlanQuestion } from "@claudexor/schema";
import { controlApiFetch, type ControlApiAddress } from "./live.js";

/** Server-derived plan readiness projection (mode=plan runs). */
export async function fetchPlanReadiness(
  addr: ControlApiAddress,
  runId: string,
): Promise<{ state: string; questionCount: number } | null> {
  if (!runId) return null;
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
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
): Promise<PlanQuestion[]> {
  if (!runId) return [];
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
    if (!res.ok) return [];
    const detail = (await res.json()) as Record<string, unknown>;
    const v = detail["planQuestions"];
    return Array.isArray(v) ? (v as PlanQuestion[]) : [];
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
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
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
 * The sub-run's settled cash spend (USD) as projected by the control-plane
 * budget owner (`GET /runs/:id` → `summary.spendUsd`). Single producer of the
 * real drawn amount the delegation belt reconciles its reservation against;
 * null when the run has no known settled cost yet. Soft-fail — a detail hiccup
 * yields null, never an inflated commit.
 */
export async function fetchRunSpendUsd(
  addr: ControlApiAddress,
  runId: string,
): Promise<number | null> {
  if (!runId) return null;
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
    if (!res.ok) return null;
    const detail = (await res.json()) as Record<string, unknown>;
    const summary = detail["summary"];
    const spend =
      summary && typeof summary === "object"
        ? (summary as { spendUsd?: unknown }).spendUsd
        : undefined;
    return typeof spend === "number" && Number.isFinite(spend) ? spend : null;
  } catch {
    return null;
  }
}

export async function fetchApplyEligibility(
  addr: ControlApiAddress,
  runId: string,
): Promise<{
  eligible: boolean;
  state: string | null;
  reason: string | null;
  requiredAction: string | null;
} | null> {
  if (!runId) return null;
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
    if (!res.ok) return null;
    const detail = (await res.json()) as Record<string, unknown>;
    const v = detail["applyEligibility"];
    return v && typeof v === "object"
      ? (v as {
          eligible: boolean;
          state: string | null;
          reason: string | null;
          requiredAction: string | null;
        })
      : null;
  } catch {
    return null;
  }
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
  if (!runId) return null;
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
    if (!res.ok) return null;
    const detail = (await res.json()) as Record<string, unknown>;
    const banner = detail["outcomeBanner"];
    return typeof banner === "string" && banner.length > 0 ? banner : null;
  } catch {
    return null;
  }
}
