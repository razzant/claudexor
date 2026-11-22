import {
  ControlProblem,
  ComplexityRouteDecision,
  type AccountTier,
  type ComplexityAccountEvidence,
  type ComplexityCandidateEvidence,
  type ComplexityLevel,
  type ComplexityRoute,
  type ComplexityRouteBlock,
  type ComplexityRouteTable,
  type CredentialProfile,
  type EffortHint,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { rankAccountPool } from "./account-pool.js";
import { bySoonestReset, tierGroup, tierOf, type TierRouting } from "./account-tier-routing.js";

/**
 * Complexity routing (INV-140: routing picks WHO executes). A run may state
 * `easy | medium | hard`; the configured table turns that into ordered route
 * candidates, and the ordinary pool machinery then admits each candidate's
 * harness and resolves its account under the account tiers. This module owns
 * only what is specific to a complexity run: turning the table into the run's
 * pool, ordering the admitted lanes across harnesses, and stating the decision.
 * Everything here is arithmetic over config and quota evidence; no model is
 * asked and no branch names a vendor.
 */

export interface ComplexityPool {
  level: ComplexityLevel;
  routes: ComplexityRoute[];
  harnesses: string[];
  models: Record<string, string>;
  efforts: Record<string, EffortHint>;
}

/** Turn the table into the run's pool, or refuse a request that contradicts it. */
export function resolveComplexityPool(
  input: {
    complexity?: ComplexityLevel;
    harnesses?: string[];
    model?: string;
    models?: Record<string, string>;
    effort?: EffortHint;
    efforts?: Record<string, EffortHint>;
  },
  table: ComplexityRouteTable,
): ComplexityPool | null {
  const level = input.complexity;
  if (!level) return null;
  const configured = table[level] ?? [];
  if (configured.length === 0)
    throw new Error(
      `complexity '${level}' has no route candidates: add routing.complexity_routes.${level} to the global config`,
    );
  if (input.model !== undefined || input.effort !== undefined)
    throw new Error(
      `complexity '${level}' takes each candidate's model and effort from routing.complexity_routes; drop the scalar model/effort or the complexity`,
    );
  const requested = input.harnesses?.length ? new Set(input.harnesses) : null;
  const routes = configured.filter((route) => !requested || requested.has(route.harness));
  if (routes.length === 0)
    throw new Error(
      `complexity '${level}' lists no candidate among the requested harnesses [${[...(requested ?? [])].join(", ")}] (routing.complexity_routes.${level}: ${configured.map((route) => route.harness).join(", ")})`,
    );
  const models: Record<string, string> = {};
  const efforts: Record<string, EffortHint> = {};
  for (const route of routes) {
    const model = input.models?.[route.harness];
    const effort = input.efforts?.[route.harness];
    if ((model && model !== route.model) || (effort && route.effort && effort !== route.effort))
      throw new Error(
        `complexity '${level}' routes ${route.harness} to ${route.model}${route.effort ? ` (${route.effort})` : ""}, but the request names ${model ?? route.model}${effort ? ` (${effort})` : ""} for it; drop one of them`,
      );
    models[route.harness] = route.model;
    if (route.effort) efforts[route.harness] = route.effort;
  }
  return { level, routes, harnesses: routes.map((route) => route.harness), models, efforts };
}

interface LaneRefusal {
  blocked_by: ComplexityRouteBlock;
  detail: string;
  resets_at: string | null;
  accounts: ComplexityAccountEvidence[];
}

/** One admitted lane as the cross-harness order reads it. */
export interface ComplexityLane {
  harnessId: string;
  profile: CredentialProfile | null;
  model: string | null;
  headroomThreshold: number;
}

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The record of one complexity decision. The route resolver notes every lane
 * it drops; the trace orders the surviving lanes, states the decision for the
 * routing rationale, and turns "nothing qualifies" into the typed refusal.
 */
export class ComplexityTrace {
  private readonly refused = new Map<string, LaneRefusal>();

  constructor(
    private readonly level: ComplexityLevel,
    private readonly routes: readonly ComplexityRoute[],
    private readonly registry: readonly CredentialProfile[],
    private readonly tier: TierRouting,
    private readonly snapshots: () => readonly QuotaSnapshot[],
  ) {}

  /** A lane dropped before account resolution (discovery, doctor, capability...). */
  dropped(harnessId: string, stage: string, detail: string): void {
    this.refused.set(harnessId, {
      blocked_by: stage === "credential" ? "account_not_ready" : "lane_unavailable",
      detail,
      resets_at: null,
      accounts: [],
    });
  }

  /** A lane whose account resolution refused typed. */
  accountRefused(harnessId: string, error: unknown): void {
    const typed = (error ?? {}) as {
      code?: string;
      resetsAt?: string | null;
      quotaRefusal?: { basis?: string } | null;
      candidates?: readonly {
        profile_id: string;
        rejected: string;
        headroom: { resets_at: string | null; used_ratio?: number } | null;
        cooldown: { resets_at: string | null } | null;
      }[];
    };
    const accounts = (typed.candidates ?? [])
      .filter((row) => row.rejected !== "disabled")
      .map((row): ComplexityAccountEvidence => {
        const tier = tierOf(this.registry, harnessId, row.profile_id);
        const reserve = row.headroom !== null && (row.headroom.used_ratio ?? 1) < 1;
        return {
          profile_id: row.profile_id,
          tier,
          blocked_by: reserve
            ? "owner_reserve"
            : row.headroom || row.cooldown
              ? "account_exhausted"
              : row.rejected === "not_selected" && tier === "primary"
                ? "primary_quota_unknown"
                : row.rejected === "not_ready" || row.rejected === "credential_unusable"
                  ? "account_not_ready"
                  : "refused",
          resets_at: row.headroom?.resets_at ?? row.cooldown?.resets_at ?? null,
        };
      });
    const reasons = new Set(accounts.map((row) => row.blocked_by));
    const blocked_by: ComplexityRouteBlock =
      typed.code === "primary_quota_unknown"
        ? "primary_quota_unknown"
        : typed.quotaRefusal?.basis === "owner_reserve"
          ? "owner_reserve"
          : typed.quotaRefusal
            ? "account_exhausted"
            : reasons.size === 1
              ? [...reasons][0]!
              : reasons.has("account_exhausted")
                ? "account_exhausted"
                : reasons.has("owner_reserve")
                  ? "owner_reserve"
                  : typed.code === "credential_pool_exhausted" && accounts.length === 0
                    ? "account_not_ready"
                    : "refused";
    this.refused.set(harnessId, {
      blocked_by,
      detail: text(error),
      resets_at: typed.resetsAt ?? null,
      accounts,
    });
  }

  /** The budget router excluded these lanes (paid fallback or a ledger cooldown). */
  routerDropped(harnessIds: readonly string[]): void {
    for (const harnessId of harnessIds)
      if (!this.refused.has(harnessId))
        this.refused.set(harnessId, {
          blocked_by: "budget_or_cooldown",
          detail: `${harnessId} was excluded by the budget router (paid fallback or cooldown)`,
          resets_at: null,
          accounts: [],
        });
  }

  /**
   * Order the admitted lanes across harnesses: auxiliary accounts with known
   * room by soonest limiting reset, then untiered and primary accounts with
   * known room, then accounts whose quota is unknown; table order breaks ties.
   */
  order<T extends ComplexityLane>(lanes: readonly T[]): T[] {
    const snapshots = this.snapshots();
    const keyed = lanes.map((lane) => ({ lane, key: this.laneKey(lane, snapshots) }));
    keyed.sort(
      (a, b) =>
        a.key.group - b.key.group ||
        (a.key.group === 0 ? bySoonestReset(a.key.resetsAt, b.key.resetsAt) : 0) ||
        a.key.index - b.key.index,
    );
    return keyed.map(({ lane }) => lane);
  }

  private laneKey(lane: ComplexityLane, snapshots: readonly QuotaSnapshot[]) {
    const index = this.routes.findIndex((route) => route.harness === lane.harnessId);
    const tier: AccountTier | null = lane.profile?.tier ?? null;
    const verdict = lane.profile
      ? rankAccountPool({
          registry: [lane.profile],
          harnessId: lane.harnessId,
          snapshots,
          readyProfileIds: new Set([lane.profile.profile_id]),
          headroomThreshold: lane.headroomThreshold,
          model: lane.model,
          tier: this.tier,
        })[0]?.verdict
      : undefined;
    const known = verdict?.kind === "fresh_headroom";
    return {
      index: index < 0 ? Number.MAX_SAFE_INTEGER : index,
      tier,
      known,
      group: tierGroup(tier, known),
      resetsAt: verdict?.kind === "fresh_headroom" ? verdict.resets_at : null,
    };
  }

  /** The decision as evidence: every table candidate, chosen or blocked. */
  decision(ordered: readonly ComplexityLane[]): ComplexityRouteDecision {
    const snapshots = this.snapshots();
    const byHarness = new Map(ordered.map((lane) => [lane.harnessId, lane]));
    const candidates = this.routes.map((route): ComplexityCandidateEvidence => {
      const base = { harness_id: route.harness, model: route.model, effort: route.effort ?? null };
      const lane = byHarness.get(route.harness);
      if (lane) {
        const key = this.laneKey(lane, snapshots);
        return {
          ...base,
          profile_id: lane.profile?.profile_id ?? null,
          tier: key.tier,
          quota: key.known ? "known_room" : "unknown",
          resets_at: key.resetsAt,
          blocked_by: null,
          detail: null,
          accounts: [],
        };
      }
      const refusal = this.refused.get(route.harness);
      return {
        ...base,
        profile_id: null,
        tier: null,
        quota: null,
        resets_at: refusal?.resets_at ?? null,
        blocked_by: refusal?.blocked_by ?? "refused",
        detail: refusal?.detail ?? `${route.harness} was not admitted to the pool`,
        accounts: refusal?.accounts ?? [],
      };
    });
    return ComplexityRouteDecision.parse({
      level: this.level,
      selected: ordered[0]?.harnessId ?? null,
      candidates,
    });
  }

  /**
   * Nothing qualifies: the typed refusal naming what blocked each candidate.
   * `cause` is the error routing ended on; a lane it speaks for that no note
   * covered is attributed to it. A reserved or unknown-quota account is never
   * used to avoid this refusal.
   */
  refusal(
    cause: unknown,
    unattributed: readonly string[] = [],
  ): Error & { complexityDecision: ComplexityRouteDecision } {
    for (const harnessId of unattributed)
      if (!this.refused.has(harnessId)) this.accountRefused(harnessId, cause);
    const decision = this.decision([]);
    const resets = decision.candidates.map((candidate) => candidate.resets_at);
    // The earliest instant any candidate reopens; unknown when none names one.
    const known = resets.filter((at): at is string => at !== null);
    const resetsAt =
      known.length > 0
        ? known.reduce((earliest, at) => (Date.parse(at) < Date.parse(earliest) ? at : earliest))
        : null;
    const lines = decision.candidates.map(
      (candidate) =>
        `${candidate.harness_id}/${candidate.model}: ${candidate.blocked_by}` +
        (candidate.accounts.length
          ? ` [${candidate.accounts.map((row) => `${row.profile_id}: ${row.blocked_by}`).join(", ")}]`
          : "") +
        (candidate.resets_at ? ` (resets ${candidate.resets_at})` : ""),
    );
    const error = new Error(
      `no route candidate can serve complexity '${this.level}': ${lines.join("; ")}` +
        (resetsAt ? `; earliest reset ${resetsAt}` : ""),
    );
    return Object.assign(error, {
      code: COMPLEXITY_ROUTE_REFUSED,
      category: "harness_unavailable",
      resetsAt,
      complexityDecision: decision,
      problem: ControlProblem.parse({
        code: COMPLEXITY_ROUTE_REFUSED,
        message: error.message,
        retryable: false,
        context: { resetsAt, complexity: decision },
      }),
    });
  }
}

/** Not a RunFailureCode, like the other refusals a strict older reader must not
 * drop a record over: the run record keeps `code: null`, and the category, the
 * reset and the `route.complexity.decided` event state the facts. */
export const COMPLEXITY_ROUTE_REFUSED = "complexity_route_refused";
