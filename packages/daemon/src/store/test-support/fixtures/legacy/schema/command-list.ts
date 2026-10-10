import { z } from "zod/v3";
import { Id } from "./primitives.js";
import { RunListQuery } from "./run-list-page.js";

/** Every retained-command read names its subject before public projection.
 * Single id/turn reads retain full params; collections contain summary facts.
 * No omitted, empty, mixed or unknown selector can request all history. */
export const CommandListQuery = z
  .union([
    z.object({ id: Id }).strict(),
    z.object({ delegatedFromRunId: Id }).strict(),
    z.object({ ids: z.array(Id).min(1).max(1000) }).strict(),
    z.object({ continuationChainOf: Id }).strict(),
    z.object({ delegatedDescendantsOf: Id }).strict(),
    z.object({ threadId: Id, activeOnly: z.boolean().optional() }).strict(),
    z.object({ threadIds: z.array(Id).min(1).max(1000) }).strict(),
    z.object({ turnId: Id }).strict(),
    z.object({ activeOnly: z.literal(true) }).strict(),
    z.object({ page: RunListQuery }).strict(),
  ])
  .describe("Required addressed selection for retained product commands; collections are compact.");
export type CommandListQuery = z.infer<typeof CommandListQuery>;
