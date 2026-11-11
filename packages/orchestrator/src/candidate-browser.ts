import type { RouteDropStage } from "@claudexor/schema";
import type { RoutedAdapter, RunInput } from "./orchestrator.js";
import type { RequestRequirementsResolver } from "./requestRequirements.js";

/** Resolved strategy and routing controls define the narrow Auto path; prompt
 * wording and a configured primary ordering bias do not define eligibility. */
export function projectCandidateBrowserPool(
  input: RunInput,
  pool: RoutedAdapter[],
  requirements: RequestRequirementsResolver,
  dropLane: (id: string, stage: RouteDropStage, detail: string) => void,
): RoutedAdapter[] {
  const singleAuto =
    (input.mode ?? "agent") === "agent" &&
    (input.n ?? 1) === 1 &&
    input.untilClean !== true &&
    input.attempts == null &&
    !input.harnesses?.length &&
    input.credentialProfileId == null &&
    input.primaryHarnessExplicit !== true;
  const projection = requirements.resolveBrowserPool(
    input.browser === true,
    singleAuto,
    pool.map((lane) => lane.browserRequirement),
  );
  for (const receipt of projection.rejected) {
    const stage =
      receipt.reason === "access_profile_incompatible"
        ? "access"
        : receipt.reason === "web_policy_off"
          ? "web"
          : "capability";
    dropLane(receipt.harness_id, stage, `${receipt.harness_id} (browser: ${receipt.reason})`);
  }
  const admitted = new Set(projection.admittedHarnessIds);
  return pool.filter((lane) => admitted.has(lane.adapter.id));
}
