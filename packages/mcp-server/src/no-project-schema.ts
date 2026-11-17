/** The public Ask's explicit no-project scope; translated to the engine's `scope: {kind: "none"}`. */
export const noProjectSchema = {
  type: "boolean",
  description:
    "true answers a general question without a project: no project is registered, Claudexor adds no project context, and the run is kept in the user-level no-project store. Cannot be combined with repoPath. execution is admitted by the engine as for any run without a project, which refuses execution.workspaceRoot (execution_workspace_invalid). false or omission keeps the project scope.",
};
