import { z } from "zod/v3";
import { WorkspaceKind, WorkspaceScopePath } from "./files-manifest.js";

export const RunExecution = z
  .object({
    isolation: z
      .enum(["envelope", "live"])
      .default("envelope")
      .describe(
        "Run isolation: envelope (isolated worktree in the external per-project runtime namespace, the default) or live (the project tree itself).",
      ),
    delegated: z
      .boolean()
      .default(false)
      .describe(
        "Marks a run driven by an EXTERNAL orchestrator that owns the workspace, not by the operator at a surface. Such a run uses a scoped harness HOME even under isolation='live' (an in-place delegated attempt therefore cannot resume a native vendor session stored under the real HOME). Unrelated to the `delegate` belt flag and to `delegatedFromRunId` (belt-child provenance).",
      ),
    workspaceRoot: z
      .string()
      .optional()
      .describe(
        "Absolute existing execution workspace for a project-scoped delegated run: the live tree of an agent run (or the source of its directory execution), and the read-only tree of a delegated thread's Ask/Plan turn. The stable project identity remains scope.root.",
      ),
    workspaceKind: WorkspaceKind.optional().describe(
      "Explicit directory execution needs no Git initialization; omission preserves existing clients.",
    ),
    scopePaths: z
      .array(WorkspaceScopePath)
      .optional()
      .describe(
        "Agent-selected input footprint. Directory copies materialize this entire selection; direct runs need no whole-tree baseline.",
      ),
  })
  .strict()
  .describe("Execution isolation and delegation settings for a run.");
export type RunExecution = z.infer<typeof RunExecution>;
