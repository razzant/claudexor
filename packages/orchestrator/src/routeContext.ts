import type { AuthPreference } from "@claudexor/schema";
import type { DoctorSpec } from "@claudexor/core";
import type { HarnessStatus } from "@claudexor/gateway";
import { WorkspaceManager } from "@claudexor/workspace";

/**
 * The effective execution context a routed run will actually spawn in,
 * resolved ONCE per run and consumed by BOTH the routing readiness
 * point-probe and the spawned spec (W3.3 / ТЗ-1 §B). Readiness evidence
 * gathered in one env while the run executes in another is not evidence:
 * the route-admitting probe and the run must share this exact context.
 */
export interface ResolvedRouteContext {
  /** Execution root the run (and its readiness point-probe) use as cwd. */
  cwd: string;
  /** Scoped env the run will receive verbatim in `spec.env`. */
  env: Record<string, string>;
  /** Release the scoped state after the run (or a failed routing) ends. */
  dispose: () => void;
}

/**
 * Resolve the read-only route context: the scoped throwaway HOME every
 * read-only attempt of this run will spawn with (workspace §6/§7 containment).
 */
export function resolveReadOnlyRouteContext(execRoot: string): ResolvedRouteContext {
  const scoped = new WorkspaceManager(execRoot).readOnlyHomeEnv();
  return { cwd: execRoot, env: scoped.env, dispose: scoped.dispose };
}

/**
 * The readiness truth that ADMITS one candidate route. Without a route
 * context this is the host-level statusAll evidence unchanged. With one, the
 * env-sensitive evidence (auth truth, reasons, auth sources) is re-derived by
 * a source-targeted point-probe in the exact env/cwd the run will spawn with,
 * and the ordering map is updated so pool ordering consumes the same truth.
 * Discovery stays host-level: a candidate host discovery dropped is never
 * probed or resurrected here. `fresh` keeps the per-run scoped env (a unique
 * tmp path that would never be hit again) out of the shared doctor cache.
 */
export async function candidateStatusInRouteContext(
  gateway: { routeStatus(id: string, spec: DoctorSpec): Promise<HarnessStatus | null> },
  ctx: ResolvedRouteContext | undefined,
  harnessId: string,
  authPreference: AuthPreference,
  statusById: Map<string, HarnessStatus>,
): Promise<HarnessStatus | undefined> {
  const host = statusById.get(harnessId);
  if (!ctx || !host?.manifest) return host;
  const scoped = await gateway.routeStatus(harnessId, {
    cwd: ctx.cwd,
    env: ctx.env,
    authPreference,
    fresh: true,
  });
  // Fail CLOSED (release wave sol #1): a null scoped probe is ABSENT evidence
  // for the env this route would actually run in — host readiness must not
  // stand in for it (the W3.3 same-context guarantee).
  if (!scoped) return undefined;
  statusById.set(harnessId, scoped);
  return scoped;
}
