import type { ContextPack, TaskContract } from "@claudex/schema";
import { ContextPack as ContextPackSchema } from "@claudex/schema";
import { ContextOverflowError } from "@claudex/core";
import { hashJson } from "@claudex/util";
import { loadAgentsInstructions } from "./agents.js";
import { type AtlasOptions, buildScopeAtlas } from "./atlas.js";

export interface ContextPackOptions extends AtlasOptions {
  /** Fail closed if explicitly-requested mandatory files are missing/unreadable. Default true. */
  failOnMissingMandatory?: boolean;
}

/**
 * Build a deterministic, hashable ContextPack. Every tracked path is accounted
 * for via the Scope Atlas; omissions are explicit. Fails closed when caller-
 * specified mandatory files cannot be read (BIBLE P6: no silent truncation).
 */
export async function buildContextPack(
  repoRoot: string,
  contract: TaskContract,
  opts: ContextPackOptions = {},
): Promise<ContextPack> {
  const usingExplicitMandatory = opts.mandatory !== undefined;
  const mandatory = opts.mandatory ?? ["AGENTS.md", "README.md"];
  const atlas = await buildScopeAtlas(repoRoot, { ...opts, mandatory });

  if (usingExplicitMandatory && (opts.failOnMissingMandatory ?? true) && atlas.missingMandatory.length > 0) {
    throw new ContextOverflowError(
      `mandatory context missing/unreadable: ${atlas.missingMandatory.join(", ")}`,
    );
  }

  const agents = loadAgentsInstructions(repoRoot);
  const taskHash = hashJson(contract);
  const partial = {
    task_contract_hash: taskHash,
    files: { mandatory: atlas.mandatory, included: atlas.included, omitted: atlas.omitted },
    atlas: atlas.atlas,
    instructions: [...agents.sources, "TASK.md", "ACCEPTANCE.md"],
    token_budget: { limit: atlas.tokenLimit, estimated_used: atlas.estimatedTokens },
  };
  return ContextPackSchema.parse({ ...partial, hash: hashJson(partial) });
}
