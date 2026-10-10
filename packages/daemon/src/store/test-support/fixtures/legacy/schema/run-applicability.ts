import { z } from "zod/v3";
import { GitCapability } from "./git-capability.js";

/** One server-authored answer to this run shape's Git prerequisite only. */
export const RunGitApplicabilityCell = z
  .object({
    applicable: z
      .boolean()
      .describe(
        "Whether the current Git capability admits this shape; other run preconditions are out of scope.",
      ),
    requiresGit: z
      .boolean()
      .describe("Whether this run/workspace shape crosses a Git-backed engine boundary."),
    code: z
      .enum(["git_missing", "git_developer_tools_stub", "git_failed"])
      .nullable()
      .describe("Stable refusal code when not applicable; null when applicable."),
    reason: z
      .string()
      .nullable()
      .describe("Human causal explanation when not applicable; null when applicable."),
    remediation: z
      .string()
      .nullable()
      .describe("Exact recovery action when not applicable; null when applicable."),
  })
  .strict()
  .describe("Git applicability for one semantic run shape in one thread workspace mode.");
export type RunGitApplicabilityCell = z.infer<typeof RunGitApplicabilityCell>;

const RunGitApplicabilityWorkspace = z
  .object({
    read_only: RunGitApplicabilityCell.describe("Ask or Plan."),
    agent_convergence: RunGitApplicabilityCell.describe(
      "Agent with an actual attempts cap or until-clean flag on the wire.",
    ),
    agent_other: RunGitApplicabilityCell.describe(
      "Plain Agent, Best-of, Create, or any other Agent wire shape.",
    ),
  })
  .strict();

/**
 * The complete 3 x 2 matrix lets thin clients select the exact cell from the
 * outgoing wire without copying the engine's Git/worktree predicate.
 */
export const RunGitApplicabilityMatrix = z
  .object({
    in_place: RunGitApplicabilityWorkspace.describe("An in-place thread workspace."),
    isolated: RunGitApplicabilityWorkspace.describe("A persistent isolated thread worktree."),
  })
  .strict()
  .describe("Root-scoped Git applicability for every composer run/workspace shape.");
export type RunGitApplicabilityMatrix = z.infer<typeof RunGitApplicabilityMatrix>;

export const ControlRunApplicabilityResponse = z
  .object({
    repoRoot: z
      .string()
      .min(1)
      .describe("Exact absolute project root for which this projection was computed."),
    git: GitCapability.describe("Live Git readiness used for every applicability cell."),
    matrix: RunGitApplicabilityMatrix,
  })
  .strict()
  .describe(
    "Root-scoped Git applicability projected by the engine; this is not total run readiness.",
  );
export type ControlRunApplicabilityResponse = z.infer<typeof ControlRunApplicabilityResponse>;
