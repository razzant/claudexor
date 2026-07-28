import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { isBlocking, ReviewFinding } from "@claudexor/schema";
import { readTextSafe } from "@claudexor/util";
import type { AnnouncedRunContext } from "./runTerminals.js";

export interface ReviewArtifacts {
  blockerIds: string[];
  reviewerHarnessIds: string[];
}

export function readReviewArtifacts(
  ctx: AnnouncedRunContext,
  terminalAttemptId: string | null,
): ReviewArtifacts {
  const blockerIds = new Set<string>();
  const reviewerHarnessIds = new Set<string>();
  if (!existsSync(ctx.paths.reviewsDir)) return { blockerIds: [], reviewerHarnessIds: [] };
  for (const name of readdirSync(ctx.paths.reviewsDir).sort()) {
    if (![".yaml", ".yml", ".json"].includes(extname(name))) continue;
    const path = join(ctx.paths.reviewsDir, name);
    // Three-state read (parseArtifact symmetry): a file that vanished between
    // readdir and read is a legitimate absence, but a present-yet-unreadable
    // or non-record review artifact could hide an accepted blocker, so it
    // fails loudly (landing in the fail-closed terminal-facts path) exactly
    // like a malformed finding inside a readable file below.
    const value = ctx.store.readYaml<Record<string, unknown>>(path);
    if (value === null) {
      if (readTextSafe(path) === null) continue;
      throw new Error(`review artifact is not readable YAML: ${name}`);
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`review artifact is not a record: ${name}`);
    }
    const artifactAttemptId =
      typeof value["attempt_id"] === "string" && value["attempt_id"].length > 0
        ? value["attempt_id"]
        : null;
    const isTerminalReview = terminalAttemptId !== null && artifactAttemptId === terminalAttemptId;
    const findings = Array.isArray(value["findings"]) ? value["findings"] : [];
    for (const raw of findings) {
      const finding = ReviewFinding.safeParse(raw);
      if (!finding.success) {
        // review.blockers is contract: a malformed finding could hide an
        // accepted blocker, so it fails loudly (landing in the fail-closed
        // terminal-facts path) instead of being silently skipped.
        throw new Error(`review artifact contains an invalid finding: ${name}`);
      }
      reviewerHarnessIds.add(finding.data.reviewer.harness_id);
      // Reviewer participation is run-wide, but blockers describe only the
      // terminal deliverable. A losing race candidate or an earlier
      // convergence iteration must not contaminate the winner's review axis.
      if (isTerminalReview && isBlocking(finding.data)) blockerIds.add(finding.data.id);
    }
    const requests = Array.isArray(value["reviewer_requests"]) ? value["reviewer_requests"] : [];
    for (const raw of requests) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const harnessId = (raw as Record<string, unknown>)["harness_id"];
      if (typeof harnessId === "string" && harnessId.length > 0) {
        reviewerHarnessIds.add(harnessId);
      }
    }
  }
  return {
    blockerIds: [...blockerIds].sort(),
    reviewerHarnessIds: [...reviewerHarnessIds].sort(),
  };
}
