/**
 * Candidate-card projection (D13): attempts/<id>/attempt.yaml +
 * reviews/<id>.yaml + the decision winner -> ControlCandidate[]. Pure
 * artifact reads — the engine wrote the evidence; this only projects it.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ControlCandidate, type DecisionRecord } from "@claudexor/schema";

interface RawAttempt {
  attempt_id?: unknown;
  harness_id?: unknown;
  label?: unknown;
  cost_usd?: unknown;
  cost_estimated?: unknown;
  errored?: unknown;
  gates?: unknown;
  diffstat?: { files?: unknown; additions?: unknown; deletions?: unknown };
}

interface RawReview {
  review_verified?: unknown;
  findings?: Array<{ severity?: unknown; status?: unknown }>;
}

export function candidatesFor(runDir: string, decision: DecisionRecord | null): ControlCandidate[] {
  const attemptsDir = join(runDir, "attempts");
  if (!existsSync(attemptsDir)) return [];
  const out: ControlCandidate[] = [];
  for (const attemptId of safeReaddir(attemptsDir)) {
    const raw = readYamlMaybe<RawAttempt>(join(attemptsDir, attemptId, "attempt.yaml"));
    if (!raw || typeof raw.attempt_id !== "string" || typeof raw.harness_id !== "string") continue;
    const review = readYamlMaybe<RawReview>(join(runDir, "reviews", `${attemptId}.yaml`));
    const findings = Array.isArray(review?.findings) ? review.findings : [];
    // Blocking = accepted FAIL/NEEDS_HUMAN findings (mirror of isBlocking's
    // severity set; status field distinguishes revalidation-accepted ones).
    const blockers = findings.filter(
      (f) => (f.severity === "FAIL" || f.severity === "NEEDS_HUMAN") && f.status !== "rejected",
    ).length;
    const gates = Array.isArray(raw.gates) ? (raw.gates as Array<{ status?: unknown }>) : [];
    const parsed = ControlCandidate.safeParse({
      attemptId: raw.attempt_id,
      harnessId: raw.harness_id,
      label: typeof raw.label === "string" ? raw.label : null,
      costUsd: typeof raw.cost_usd === "number" ? raw.cost_usd : 0,
      costEstimated: raw.cost_estimated === true,
      errored: raw.errored === true,
      gatesPassed: gates.filter((g) => g.status === "passed").length,
      gatesTotal: gates.length,
      blockers,
      reviewVerified: review?.review_verified === true,
      finalReviewClean: review ? blockers === 0 : null,
      winner: decision?.winner === raw.attempt_id,
      diffstat:
        raw.diffstat && typeof raw.diffstat === "object"
          ? {
              files: numberOr(raw.diffstat.files, 0),
              additions: numberOr(raw.diffstat.additions, 0),
              deletions: numberOr(raw.diffstat.deletions, 0),
            }
          : null,
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
