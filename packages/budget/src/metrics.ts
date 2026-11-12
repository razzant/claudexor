/**
 * Harness routing metrics: per-harness rolling averages of OBSERVED
 * attempt cost and duration, persisted under the Claudexor config dir. ONE
 * producer (the orchestrator records after each settled attempt) and ONE
 * consumer (pool ordering fills RouterCandidate.costPerCall/latencyMs).
 * Evidence-based inputs only — never pricing guesses; an explicitly unknown
 * attempt cost clears the cost average while still recording duration.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { measureSync } from "@claudexor/util";

export interface HarnessMetric {
  avg_cost_usd: number | null;
  avg_duration_ms: number | null;
  samples: number;
  /**
   * Auth route the harness's LAST settled attempt actually ran under
   * (adapter-disclosed route evidence, not a manifest capability guess).
   * Economy routing may consume settled cost as evidence; no quality prior is
   * inferred. Null until any attempt disclosed a route.
   */
  last_auth_mode: "local_session" | "api_key" | null;
}

export type HarnessMetrics = Record<string, HarnessMetric>;

/** Exponential moving average weight for new samples (recent runs dominate). */
const EMA_ALPHA = 0.3;
const MAX_SAMPLES_COUNTED = 1_000_000;
// Older rows mixed observed usage with removed adapter fallback tariffs. They
// cannot prove cost provenance; keep their latency, sample count, and auth route.
const COST_EVIDENCE_VERSION = 1;

export function metricsPath(configDir: string): string {
  return join(configDir, "telemetry", "harness-metrics.json");
}

export function loadHarnessMetrics(configDir: string): HarnessMetrics {
  try {
    const raw = JSON.parse(readFileSync(metricsPath(configDir), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: HarnessMetrics = {};
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      const m = v as {
        cost_evidence_version?: unknown;
        avg_cost_usd?: unknown;
        avg_duration_ms?: unknown;
        samples?: unknown;
        last_auth_mode?: unknown;
      };
      out[id] = {
        avg_cost_usd:
          m.cost_evidence_version === COST_EVIDENCE_VERSION &&
          typeof m.avg_cost_usd === "number" &&
          m.avg_cost_usd >= 0
            ? m.avg_cost_usd
            : null,
        avg_duration_ms:
          typeof m.avg_duration_ms === "number" && m.avg_duration_ms >= 0
            ? m.avg_duration_ms
            : null,
        samples:
          typeof m.samples === "number" && m.samples > 0
            ? Math.min(m.samples, MAX_SAMPLES_COUNTED)
            : 0,
        last_auth_mode:
          m.last_auth_mode === "local_session" || m.last_auth_mode === "api_key"
            ? m.last_auth_mode
            : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Record one settled attempt (EMA update; atomic tmp+rename write).
 * `authMode` is route evidence and updates independently of the performance
 * sample: an auth-only record (no cost/duration) refreshes `last_auth_mode`
 * WITHOUT counting a sample, so errored attempts can still disclose the route
 * they burned without earning a flattering latency average.
 * An explicit null cost means the settled attempt was unpriced and invalidates
 * the prior cost average; an omitted cost leaves compatible history unchanged.
 * The read-modify-write of this one shared file stays synchronous, so two
 * attempts settling at once never interleave it; it is labeled in `worstSync`.
 */
export function recordHarnessMetric(
  configDir: string,
  harnessId: string,
  sample: {
    costUsd?: number | null;
    durationMs?: number | null;
    authMode?: "local_session" | "api_key" | null;
  },
): void {
  measureSync("metrics.harness_write", () => recordHarnessSample(configDir, harnessId, sample));
}

function recordHarnessSample(
  configDir: string,
  harnessId: string,
  sample: Parameters<typeof recordHarnessMetric>[2],
): void {
  const all = loadHarnessMetrics(configDir);
  const prev = all[harnessId] ?? {
    avg_cost_usd: null,
    avg_duration_ms: null,
    samples: 0,
    last_auth_mode: null,
  };
  const ema = (old: number | null, next: number | null | undefined): number | null => {
    if (typeof next !== "number" || !Number.isFinite(next) || next < 0) return old;
    if (old === null) return next;
    return old * (1 - EMA_ALPHA) + next * EMA_ALPHA;
  };
  const isPerfSample = typeof sample.costUsd === "number" || typeof sample.durationMs === "number";
  all[harnessId] = {
    avg_cost_usd: sample.costUsd === null ? null : ema(prev.avg_cost_usd, sample.costUsd),
    avg_duration_ms: ema(prev.avg_duration_ms, sample.durationMs),
    samples: isPerfSample ? Math.min(prev.samples + 1, MAX_SAMPLES_COUNTED) : prev.samples,
    last_auth_mode:
      sample.authMode === "local_session" || sample.authMode === "api_key"
        ? sample.authMode
        : prev.last_auth_mode,
  };
  const path = metricsPath(configDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Unique per WRITE, not per process: two attempts settling concurrently in
    // one daemon collide on a pid-only name (the second rename ENOENTs and
    // silently drops the sample).
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const persisted = Object.fromEntries(
      Object.entries(all).map(([id, metric]) => [
        id,
        { ...metric, cost_evidence_version: COST_EVIDENCE_VERSION },
      ]),
    );
    writeFileSync(tmp, JSON.stringify(persisted, null, 2) + "\n");
    renameSync(tmp, path);
  } catch {
    /* metrics are advisory routing inputs — never fail a run over them */
  }
}
