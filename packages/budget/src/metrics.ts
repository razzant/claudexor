/**
 * Harness routing metrics (D7): per-harness rolling averages of OBSERVED
 * attempt cost and duration, persisted under the Claudexor config dir. ONE
 * producer (the orchestrator records after each settled attempt) and ONE
 * consumer (pool ordering fills RouterCandidate.costPerCall/latencyMs).
 * Evidence-based inputs only — never pricing guesses; an attempt with no
 * observed cost records duration alone.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface HarnessMetric {
  avg_cost_usd: number | null;
  avg_duration_ms: number | null;
  samples: number;
}

export type HarnessMetrics = Record<string, HarnessMetric>;

/** Exponential moving average weight for new samples (recent runs dominate). */
const EMA_ALPHA = 0.3;
const MAX_SAMPLES_COUNTED = 1_000_000;

export function metricsPath(configDir: string): string {
  return join(configDir, "telemetry", "harness-metrics.json");
}

export function loadHarnessMetrics(configDir: string): HarnessMetrics {
  try {
    const raw = JSON.parse(readFileSync(metricsPath(configDir), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: HarnessMetrics = {};
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      const m = v as { avg_cost_usd?: unknown; avg_duration_ms?: unknown; samples?: unknown };
      out[id] = {
        avg_cost_usd: typeof m.avg_cost_usd === "number" && m.avg_cost_usd >= 0 ? m.avg_cost_usd : null,
        avg_duration_ms: typeof m.avg_duration_ms === "number" && m.avg_duration_ms >= 0 ? m.avg_duration_ms : null,
        samples: typeof m.samples === "number" && m.samples > 0 ? Math.min(m.samples, MAX_SAMPLES_COUNTED) : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Record one settled attempt (EMA update; atomic tmp+rename write). */
export function recordHarnessMetric(
  configDir: string,
  harnessId: string,
  sample: { costUsd?: number | null; durationMs?: number | null },
): void {
  const all = loadHarnessMetrics(configDir);
  const prev = all[harnessId] ?? { avg_cost_usd: null, avg_duration_ms: null, samples: 0 };
  const ema = (old: number | null, next: number | null | undefined): number | null => {
    if (typeof next !== "number" || !Number.isFinite(next) || next < 0) return old;
    if (old === null) return next;
    return old * (1 - EMA_ALPHA) + next * EMA_ALPHA;
  };
  all[harnessId] = {
    avg_cost_usd: ema(prev.avg_cost_usd, sample.costUsd),
    avg_duration_ms: ema(prev.avg_duration_ms, sample.durationMs),
    samples: Math.min(prev.samples + 1, MAX_SAMPLES_COUNTED),
  };
  const path = metricsPath(configDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
    renameSync(tmp, path);
  } catch {
    /* metrics are advisory routing inputs — never fail a run over them */
  }
}
