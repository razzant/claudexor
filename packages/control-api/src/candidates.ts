/**
 * Candidate-card projection: attempts/<id>/attempt.yaml +
 * reviews/<id>.yaml + the decision winner -> ControlCandidate[]. Pure
 * artifact reads — the engine wrote the evidence; this only projects it.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ControlCandidate,
  ReviewFinding,
  isBlocking,
  type DecisionRecord,
} from "@claudexor/schema";

interface RawAttempt {
  attempt_id?: unknown;
  harness_id?: unknown;
  label?: unknown;
  cost_usd?: unknown;
  cost_estimated?: unknown;
  errored?: unknown;
  errors?: unknown;
  gates?: unknown;
  diffstat?: { files?: unknown; additions?: unknown; deletions?: unknown };
}

interface RawReview {
  review_verified?: unknown;
  final_review_clean?: unknown;
  findings?: unknown[];
}

export function candidatesFor(runDir: string, decision: DecisionRecord | null): ControlCandidate[] {
  const attemptsDir = join(runDir, "attempts");
  if (!existsSync(attemptsDir)) return [];
  const out: ControlCandidate[] = [];
  for (const attemptId of safeReaddir(attemptsDir)) {
    const raw = readYamlMaybe<RawAttempt>(join(attemptsDir, attemptId, "attempt.yaml"));
    if (!raw || typeof raw.attempt_id !== "string" || typeof raw.harness_id !== "string") continue;
    const review = readYamlMaybe<RawReview>(join(runDir, "reviews", `${attemptId}.yaml`));
    const rawFindings = Array.isArray(review?.findings) ? review.findings : [];
    // Blocking is the SCHEMA's judgment (isBlocking: accepted
    // BLOCK/FIX_FIRST with evidence, or NEEDS_HUMAN) — never a projection-
    // local severity list that can drift from the contract.
    const blockers = rawFindings.filter((f) => {
      const parsed = ReviewFinding.safeParse(f);
      return parsed.success && isBlocking(parsed.data);
    }).length;
    const gates = Array.isArray(raw.gates) ? (raw.gates as Array<{ status?: unknown }>) : [];
    // QA-028: surface this candidate's row of the decision's ranking scorecard
    // so the candidate card can explain the ranking (the detail-level
    // decision.decisive_axis names which axis actually separated winner from
    // runner-up). Matched by attempt id; null when arbitration produced none.
    const scorecardRow = decision?.ranking_scorecard?.find((r) => r.attempt_id === raw.attempt_id);
    const parsed = ControlCandidate.safeParse({
      attemptId: raw.attempt_id,
      harnessId: raw.harness_id,
      label: typeof raw.label === "string" ? raw.label : null,
      costUsd: typeof raw.cost_usd === "number" ? raw.cost_usd : 0,
      costEstimated: raw.cost_estimated === true,
      errored: raw.errored === true,
      errorReason:
        Array.isArray(raw.errors) && typeof raw.errors[0] === "string" ? raw.errors[0] : null,
      gatesPassed: gates.filter((g) => g.status === "passed").length,
      gatesTotal: gates.length,
      blockers,
      reviewVerified: review?.review_verified === true,
      finalReviewClean:
        raw.errored === true
          ? false
          : typeof review?.final_review_clean === "boolean"
            ? review.final_review_clean
            : null,
      winner: decision?.winner === raw.attempt_id,
      diffstat:
        raw.diffstat && typeof raw.diffstat === "object"
          ? {
              files: numberOr(raw.diffstat.files, 0),
              additions: numberOr(raw.diffstat.additions, 0),
              deletions: numberOr(raw.diffstat.deletions, 0),
            }
          : null,
      rankingAxes: scorecardRow ? scorecardRow.axes : null,
    });
    if (parsed.success) out.push(parsed.data);
  }
  // Stable order: labels (A, B, ...) then attempt ids — matches race lanes.
  return out.sort((a, b) => (a.label ?? a.attemptId).localeCompare(b.label ?? b.attemptId));
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function readYamlMaybe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return (parseYaml(readFileSync(path, "utf8")) ?? null) as T | null;
  } catch {
    return null;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
