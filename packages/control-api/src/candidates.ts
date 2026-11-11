/**
 * Candidate-card projection: attempts/<id>/attempt.yaml +
 * reviews/<id>.yaml + the decision winner -> ControlCandidate[]. Pure
 * artifact reads — the engine wrote the evidence; this only projects it.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { redactSecrets } from "@claudexor/util";
import { projectionRead } from "./projection-context.js";
import {
  type AppliedConfinementRecord,
  ControlCandidate,
  type ControlCandidateConfinement,
  confinementBoundaryProven,
  ReviewFinding,
  isBlocking,
  RecordedAppliedAttemptFacts,
  type DecisionRecord,
} from "@claudexor/schema";

interface RawAttempt extends AppliedConfinementRecord {
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
    const raw = readYamlMaybe<RawAttempt>(runDir, `attempts/${attemptId}/attempt.yaml`);
    if (!raw || typeof raw.attempt_id !== "string" || typeof raw.harness_id !== "string") continue;
    const review = readYamlMaybe<RawReview>(runDir, `reviews/${attemptId}.yaml`);
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
      // Redact the first error reason: this projection reads the attempt.yaml
      // artifact directly, so it bypasses any serve-time redaction — a raw
      // harness error string can carry a token. The protocol rule is to expose
      // the first REDACTED error reason, never the raw one.
      errorReason:
        Array.isArray(raw.errors) && typeof raw.errors[0] === "string"
          ? redactSecrets(raw.errors[0])
          : null,
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
      // Unknown is not zero: a Git result with no rendered patch has no line counts.
      diffstat:
        raw.diffstat &&
        typeof raw.diffstat === "object" &&
        typeof raw.diffstat.files === "number" &&
        typeof raw.diffstat.additions === "number" &&
        typeof raw.diffstat.deletions === "number"
          ? {
              files: numberOr(raw.diffstat.files, 0),
              additions: numberOr(raw.diffstat.additions, 0),
              deletions: numberOr(raw.diffstat.deletions, 0),
            }
          : null,
      rankingAxes: scorecardRow ? scorecardRow.axes : null,
      confinement: confinementCard(
        RecordedAppliedAttemptFacts.safeParse(raw).success
          ? RecordedAppliedAttemptFacts.parse(raw)
          : raw,
      ),
    });
    if (parsed.success) out.push(parsed.data);
  }
  // Stable order: labels (A, B, ...) then attempt ids — matches race lanes.
  return out.sort((a, b) => (a.label ?? a.attemptId).localeCompare(b.label ?? b.attemptId));
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * The applied-boundary card, third and last place the absence of a boundary is
 * disclosed (the attempt record and the child's prompt are the other two).
 *
 * `proven` comes from the shared owner rather than from a second reading of the
 * same two fields, so this projection cannot drift into calling an unproven
 * mechanism name a boundary. Null only for an attempt whose record carries
 * neither half — a run that never asked for a boundary at all.
 */
function confinementCard(raw: RawAttempt): ControlCandidateConfinement | null {
  const mechanism = stringOrNull(raw.confinement_mechanism);
  const unavailableReason = stringOrNull(raw.confinement_unavailable_reason);
  if (!mechanism && !unavailableReason) return null;
  return {
    proven: confinementBoundaryProven(raw),
    mechanism,
    verifiedDeniedPath: stringOrNull(raw.confinement_verified_denied_path),
    unavailableReason,
  };
}

function readYamlMaybe<T>(runDir: string, relative: string): T | null {
  return projectionRead(runDir, `candidates:yaml:${relative}`, () => {
    try {
      const raw = projectionRead<string | null>(runDir, `candidates:raw:${relative}`, () => {
        const path = join(runDir, relative);
        return existsSync(path) ? readFileSync(path, "utf8") : null;
      });
      return raw === null ? null : ((parseYaml(raw) ?? null) as T | null);
    } catch {
      return null;
    }
  });
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
