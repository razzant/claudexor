import { AuxiliaryWritableRootsRequest, WorkspaceKind } from "@claudexor/schema";

/** Shared by the run tools and the thread-turn tool (a per-turn grant). */
export const auxiliaryWritableRootsSchema = {
  type: "array",
  items: { type: "string", minLength: 1 },
  description: AuxiliaryWritableRootsRequest.description,
};

/** Public ControlRunStartRequest.execution spelling; semantic checks use RunExecution. */
export const runExecutionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    isolation: { type: "string", enum: ["envelope", "live"] },
    delegated: { type: "boolean" },
    workspaceRoot: {
      type: "string",
      description:
        "Actual existing delegated execution directory; stable project identity remains repoPath.",
    },
    workspaceKind: {
      type: "string",
      enum: WorkspaceKind.options,
      description: "directory needs no Git initialization.",
    },
    scopePaths: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description:
        "Selected relative files/directories; '.' selects the whole folder. No implicit whole-folder claim.",
    },
    auxiliaryWritableRoots: auxiliaryWritableRootsSchema,
  },
};
