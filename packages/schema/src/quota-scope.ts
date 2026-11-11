import type { QuotaConstraint, QuotaFreshness, QuotaSnapshot } from "./quota.js";
import { quotaSourceTraits } from "./quota.js";

type ModelScope = Pick<QuotaConstraint, "applies_to_models" | "applies_to_model_prefixes">;

/** The one Claude quota-family scope: the vendor names the family (`Opus`,
 * `Fable`) and its full ids share the `claude-<family>-` prefix, so a newly
 * released id joins its family's limit without a frozen model list. `best` and
 * a bare default route are not assigned to any family before the vendor
 * resolves them. A name that is not one plain family word has no scope here:
 * producers keep it as diagnostic evidence, never an account-wide limit. */
export function claudeQuotaFamilyScope(displayName: string): ModelScope | null {
  const family = displayName.trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*$/.test(family)) return null;
  return { applies_to_models: [family], applies_to_model_prefixes: [`claude-${family}-`] };
}

/** Engines before the family-prefix scope wrote a family as its alias, the
 * enumerated known full ids and `best`. That list shape is the retired
 * producer's signature; nothing else adds `best` to a Claude scope. */
function retiredClaudeAliasFamily(constraint: QuotaConstraint): string | null {
  const models = constraint.applies_to_models;
  if (!models?.includes("best") || constraint.applies_to_model_prefixes?.length) return null;
  const named = models.filter((model) => model !== "best");
  const families = named.filter((model) => !model.startsWith("claude-"));
  const family = families.length === 1 ? families[0]! : null;
  return family && named.every((m) => m === family || m.startsWith(`claude-${family}-`))
    ? family
    : null;
}

const CLAUDE_FAMILY_SOURCES = new Set<QuotaSnapshot["source"]>([
  "claude_oauth_usage",
  "claude_rate_limit_event",
  "claude_api_retry",
]);

/** Current scope of one restored constraint; null retires an unknown scope. */
function currentConstraint(snapshot: QuotaSnapshot, constraint: QuotaConstraint) {
  const scoped =
    !!constraint.applies_to_models?.length || !!constraint.applies_to_model_prefixes?.length;
  // Only an unrecognized AGY group (or an unnamed OAuth weekly_scoped limit)
  // was ever written without model scope by these sources.
  if (snapshot.source === "agy_command_usage") return scoped ? constraint : null;
  if (snapshot.source === "claude_oauth_usage" && constraint.id === "weekly_scoped:scoped")
    return scoped ? constraint : null;
  const family = retiredClaudeAliasFamily(constraint);
  if (family === null) return constraint;
  const scope = claudeQuotaFamilyScope(family);
  return scope ? { ...constraint, ...scope } : null;
}

/**
 * Restore a journaled snapshot in the current scope representation. Only
 * source-proven retired shapes change: a Claude family alias list (measured,
 * OAuth or reactive cooldown) becomes the family prefix scope with its usage,
 * reset, cooldown and observation time intact, and an unknown AGY group or
 * unnamed OAuth weekly_scoped limit stops being account-wide. Every other
 * harness, source, window, route, subject and request kind is returned as is.
 * Null means a single-window record whose only window had an unknown scope; a
 * full reading left with no window keeps its identity with `freshness: unknown`.
 */
export function withCurrentQuotaScopes(snapshot: QuotaSnapshot): QuotaSnapshot | null {
  const relevant =
    (snapshot.subject.harness === "claude" && CLAUDE_FAMILY_SOURCES.has(snapshot.source)) ||
    (snapshot.subject.harness === "agy" && snapshot.source === "agy_command_usage");
  if (!relevant) return snapshot;
  const constraints = snapshot.constraints.flatMap((constraint) => {
    const current = currentConstraint(snapshot, constraint);
    return current ? [current] : [];
  });
  const unchanged =
    constraints.length === snapshot.constraints.length &&
    constraints.every((constraint, index) => constraint === snapshot.constraints[index]);
  if (unchanged) return snapshot;
  if (constraints.length > 0) return { ...snapshot, constraints };
  if (quotaSourceTraits(snapshot.source).snapshotMode === "window") return null;
  // A full reading whose every window had an unknown scope still supersedes
  // older readings of its source, but it is no fresh limit-free observation:
  // display, availability readers and refresh demand see it as unknown.
  return { ...snapshot, constraints, freshness: "unknown" };
}

export const QUOTA_FRESHNESS_TTL_MS = 5 * 60_000;

/** One window's freshness at `now`, from the snapshot's own label and
 * observation time and this window's own reset: fresh through exactly five
 * minutes, stale once its reset is reached. A sibling's reset never ages it and
 * nothing here makes stale evidence fresh. The registry ages a whole snapshot
 * by the same rule; admission readers apply it per window at their decision. */
export function quotaWindowFreshness(
  snapshot: Pick<QuotaSnapshot, "freshness" | "observed_at">,
  constraint: Pick<QuotaConstraint, "resets_at">,
  now: number,
): QuotaFreshness {
  if (snapshot.freshness !== "fresh") return snapshot.freshness;
  const observed = Date.parse(snapshot.observed_at);
  if (!Number.isFinite(observed) || now - observed > QUOTA_FRESHNESS_TTL_MS) return "stale";
  const reset = constraint.resets_at ? Date.parse(constraint.resets_at) : Number.NaN;
  return Number.isFinite(reset) && reset <= now ? "stale" : "fresh";
}
