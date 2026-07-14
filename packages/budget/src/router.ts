import type { Portfolio, ProviderFamily } from "@claudexor/schema";
import type { BudgetLedger } from "./ledger.js";

export interface RouterCandidate {
  harnessId: string;
  providerFamily: ProviderFamily;
  available: boolean;
  authMode?: "local_session" | "api_key" | "unknown";
  /** 0..1 expected quality for the target intent. */
  qualityForIntent?: number;
  costPerCall?: number;
  latencyMs?: number;
}

export interface RouteContext {
  portfolio: Portfolio;
  ledger: BudgetLedger;
  /** Provider families already used (penalized, to encourage cross-family diversity). */
  diversityAgainst?: ProviderFamily[];
}

interface PortfolioWeights {
  quality: number;
  cost: number;
  latency: number;
  preferSubscription: number;
  preferApi: number;
}

function weights(p: Portfolio): PortfolioWeights {
  switch (p) {
    case "cheapest":
      return { quality: 0.5, cost: 2.0, latency: 1.0, preferSubscription: 1, preferApi: 1 };
    case "strongest":
      return { quality: 2.0, cost: 0.2, latency: 0.5, preferSubscription: 1, preferApi: 1 };
    case "burn":
      return { quality: 2.0, cost: 0.0, latency: 0.2, preferSubscription: 1, preferApi: 1 };
    case "subscription-first":
      return { quality: 1.0, cost: 0.5, latency: 0.5, preferSubscription: 1.6, preferApi: 0.6 };
    case "api-overflow":
      return { quality: 1.0, cost: 0.8, latency: 0.5, preferSubscription: 0.6, preferApi: 1.6 };
    default:
      return { quality: 1.0, cost: 0.7, latency: 0.5, preferSubscription: 1.1, preferApi: 1.0 };
  }
}

export function routeUtility(c: RouterCandidate, ctx: RouteContext): number {
  if (!c.available || ctx.ledger.cooldownActive(c.harnessId)) return 0;
  const w = weights(ctx.portfolio);
  const quality = (c.qualityForIntent ?? 0.5) ** w.quality;
  const headroom = ctx.ledger.headroom(c.harnessId);
  const diversity = ctx.diversityAgainst?.includes(c.providerFamily) ? 0.5 : 1;
  const authPref =
    c.authMode === "local_session"
      ? w.preferSubscription
      : c.authMode === "api_key"
        ? w.preferApi
        : 1;
  const conserve =
    (ctx.portfolio === "conserve-claude" && c.providerFamily === "anthropic") ||
    (ctx.portfolio === "conserve-codex" && c.providerFamily === "openai")
      ? 0.4
      : 1;
  const cost = Math.max(0.0001, c.costPerCall ?? 0.01);
  const latency = Math.max(0.1, (c.latencyMs ?? 1000) / 1000);
  const costFactor = cost ** w.cost;
  const latencyFactor = latency ** w.latency;
  return (quality * headroom * diversity * authPref * conserve) / (costFactor * latencyFactor);
}

/** Choose the highest-utility available harness, or null if none are usable. */
export function selectHarness(
  candidates: RouterCandidate[],
  ctx: RouteContext,
): RouterCandidate | null {
  let best: RouterCandidate | null = null;
  let bestU = 0;
  for (const c of candidates) {
    const u = routeUtility(c, ctx);
    if (u > bestU) {
      bestU = u;
      best = c;
    }
  }
  return best;
}
