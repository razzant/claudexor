import { z } from "zod/v3";

/** Project context depth. The retired deep tier never had distinct behavior. */
export const RunScopeContext = z
  .enum(["auto"])
  .describe("Project context depth; auto is the only mode.");
export type RunScopeContext = z.infer<typeof RunScopeContext>;

export const RunScope = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("project"),
        root: z.string().describe("Absolute path of the project root."),
        context: RunScopeContext.default("auto"),
        /** ONE-SHOT root (INV-035). A caller that hands Claudexor a disposable
         * tree per run (a delegating host's per-subagent worktrees) would
         * otherwise fill the durable registry with entries that are dead on
         * arrival — and then have them quarantined as ghosts. Declaring the root
         * ephemeral keeps it out of the registry entirely, so "no-project state
         * remains global" applies: its commands and run events live in the
         * global partition, and nothing registered ever names it. */
        ephemeral: z
          .boolean()
          .default(false)
          .describe(
            "Declare the root one-shot: it anchors this run only, is never entered into the durable project registry, and its commands/run events live in the global no-project partition.",
          ),
      })
      .strict()
      .describe("Run anchored to a project."),
    z
      .object({ kind: z.literal("none") })
      .strict()
      .describe("Run with no project (pure ask)."),
  ])
  .describe("What the run operates on: a project (with root) or nothing.");
export type RunScope = z.infer<typeof RunScope>;

/**
 * Whether a run request declares a ONE-SHOT project root. Reads the raw request
 * shape (not a parsed RunScope) so the daemon's partition router — which routes
 * `unknown` params before any typed parse — and typed callers share ONE
 * definition of "ephemeral" instead of each re-deriving it.
 */
export function isEphemeralRunScope(scope: unknown): boolean {
  const value = scope && typeof scope === "object" ? (scope as Record<string, unknown>) : null;
  return value?.["kind"] === "project" && value["ephemeral"] === true;
}
