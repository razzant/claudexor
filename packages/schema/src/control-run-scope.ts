import { z } from "zod";

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
