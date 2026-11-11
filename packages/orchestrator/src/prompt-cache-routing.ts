import type { HarnessAdapter } from "@claudexor/core";
import type { PromptCacheTtl } from "@claudexor/schema";

/**
 * The run's captured prompt-cache lifetime for one route. It is forwarded only
 * where the adapter's capability profile declares that exact value; elsewhere
 * it is disclosed as an ignored setting (INV-105), never silently dropped.
 */
export function routePromptCacheTtl(
  adapter: Pick<HarnessAdapter, "id" | "capabilityProfile">,
  requested: PromptCacheTtl | undefined,
): { ttl?: PromptCacheTtl; ignored?: string } {
  if (requested === undefined) return {};
  if (adapter.capabilityProfile?.prompt_cache_ttls?.includes(requested)) return { ttl: requested };
  return {
    ignored: `prompt_cache_ttl=${requested} (capability_profile.prompt_cache_ttls does not declare it for ${adapter.id})`,
  };
}

/** Reviewers receive the run's lifetime on the same terms as task lanes; an
 * undeclared reviewer harness is disclosed once through `review.preflight`. */
export function withReviewerPromptCacheTtl<
  R extends { adapter: Pick<HarnessAdapter, "id" | "capabilityProfile"> },
>(
  reviewers: R[],
  requested: PromptCacheTtl | undefined,
  warn: (detail: string) => void,
): Array<R & { promptCacheTtl?: PromptCacheTtl }> {
  const disclosed = new Set<string>();
  return reviewers.map((reviewer) => {
    const route = routePromptCacheTtl(reviewer.adapter, requested);
    if (route.ignored && !disclosed.has(route.ignored)) {
      disclosed.add(route.ignored);
      warn(`reviewer ${route.ignored}`);
    }
    return route.ttl === undefined ? reviewer : { ...reviewer, promptCacheTtl: route.ttl };
  });
}
