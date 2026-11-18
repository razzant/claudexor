import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { ContextPack, TaskContract } from "@claudexor/schema";
import { ContextPack as ContextPackSchema } from "@claudexor/schema";
import { MandatoryContextUnavailableError } from "@claudexor/core";
import { errorCode, hashJson } from "@claudexor/util";
import { loadAgentsInstructions } from "./agents.js";
import { type AtlasOptions, buildScopeAtlas, contextSymlinkDenyReason } from "./atlas.js";

export interface ContextPackOptions extends AtlasOptions {
  /** Fail closed if explicitly-requested mandatory files are missing/unreadable. Default true. */
  failOnMissingMandatory?: boolean;
}

export const DEFAULT_MANDATORY_CONTEXT = ["README.md", "docs/ARCHITECTURE.md"];

/**
 * Uniform fail-closed preflight for EXPLICITLY-configured mandatory context.
 * Called by every canonical run mode (ask/plan/agent) so a versioned
 * `mandatory_files` contract is honored identically — not just by the modes that
 * happen to build a ContextPack (the bug where one route failed but another
 * silently passed the same repo). A no-op when the list is empty (the default,
 * since `claudexor init` no longer seeds it), so fresh repos are never gated.
 * Read-only: only checks file readability, never mutates.
 */
export function assertMandatoryContext(repoRoot: string, mandatoryFiles: readonly string[]): void {
  if (mandatoryFiles.length === 0) return;
  const base = resolve(repoRoot);
  const unavailableFiles: { path: string; reason: string }[] = [];
  let canonicalBase = base;
  try {
    canonicalBase = realpathSync(base);
  } catch {
    // Missing roots are accounted below as missing mandatory paths.
  }
  for (const rel of mandatoryFiles) {
    // Versioned project config must not point mandatory context OUTSIDE the repo
    // (absolute paths or `..` traversal): fail closed rather than read host files
    // (versioned config never self-grants powers).
    const abs = resolve(base, rel);
    if (isAbsolute(rel)) {
      unavailableFiles.push({ path: rel, reason: "absolute paths are not allowed" });
      continue;
    }
    if (abs !== base && !abs.startsWith(base + sep)) {
      unavailableFiles.push({ path: rel, reason: "path escapes the repo" });
      continue;
    }
    const denied = contextSymlinkDenyReason(base, canonicalBase, rel);
    if (denied) {
      unavailableFiles.push({ path: rel, reason: denied });
      continue;
    }
    try {
      readFileSync(abs, "utf8");
    } catch (error) {
      unavailableFiles.push({ path: rel, reason: errorCode(error) ?? "read failed" });
    }
  }
  if (unavailableFiles.length > 0) {
    throw new MandatoryContextUnavailableError({ executionRoot: base, unavailableFiles });
  }
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
  const mandatory = opts.mandatory ?? DEFAULT_MANDATORY_CONTEXT;
  const atlas = await buildScopeAtlas(repoRoot, { ...opts, mandatory });

  if (
    usingExplicitMandatory &&
    (opts.failOnMissingMandatory ?? true) &&
    atlas.missingMandatory.length > 0
  ) {
    const reasons = new Map(atlas.atlas.map((entry) => [entry.path, entry.reason]));
    throw new MandatoryContextUnavailableError({
      executionRoot: resolve(repoRoot),
      unavailableFiles: atlas.missingMandatory.map((path) => ({
        path,
        reason: reasons.get(path) ?? "not present in the context inventory",
      })),
    });
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
