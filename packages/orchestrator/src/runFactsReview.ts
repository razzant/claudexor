import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { isBlocking, ReviewFinding } from "@claudexor/schema";
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
    const value = ctx.store.readYaml<Record<string, unknown>>(join(ctx.paths.reviewsDir, name));
    if (!value || Array.isArray(value)) continue;
    const artifactAttemptId =
      typeof value["attempt_id"] === "string" && value["attempt_id"].length > 0
        ? value["attempt_id"]
        : null;
    const isTerminalReview = terminalAttemptId !== null && artifactAttemptId === terminalAttemptId;
    const findings = Array.isArray(value["findings"]) ? value["findings"] : [];
    for (const raw of findings) {
      const finding = ReviewFinding.safeParse(raw);
      if (!finding.success) continue;
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
