import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BudgetLedger } from "./ledger.js";
import { loadHarnessMetrics, metricsPath, recordHarnessMetric } from "./metrics.js";
import { explainRanking, type RouterCandidate } from "./router.js";

const roots: string[] = [];
function temporaryConfig(): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-metric-cost-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("routing cost evidence", () => {
  it("drops incompatible legacy cost before API ranking while retaining other telemetry", () => {
    const root = temporaryConfig();
    const path = metricsPath(root);
    const legacy = {
      avg_cost_usd: 0.02,
      avg_duration_ms: 30_000,
      samples: 4,
      last_auth_mode: "local_session",
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ codex: legacy }));
    expect(loadHarnessMetrics(root).codex).toEqual({ ...legacy, avg_cost_usd: null });

    // A clean unpriced attempt sends null; a resolved API route may follow a
    // previously used subscription route on an ordinary upgraded installation.
    recordHarnessMetric(root, "codex", {
      costUsd: null,
      durationMs: 50_000,
      authMode: "api_key",
    });
    recordHarnessMetric(root, "claude", { costUsd: 0.4, authMode: "api_key" });
    const metrics = loadHarnessMetrics(root);
    expect(metrics.codex).toEqual({
      avg_cost_usd: null,
      avg_duration_ms: 36_000,
      samples: 5,
      last_auth_mode: "api_key",
    });
    const candidates: RouterCandidate[] = ["codex", "claude"].map((harnessId) => ({
      harnessId,
      available: true,
      authRoute: { route: "managed_api_key", verification: "passed" },
      incrementalCostUsd: metrics[harnessId]?.avg_cost_usd ?? null,
    }));
    const context = {
      paidFallback: "when_unavailable" as const,
      intent: "implement" as const,
      qualityTiers: {},
      ledger: new BudgetLedger(),
    };
    const economy = explainRanking(candidates, { ...context, goal: "economy" });
    expect(economy.order).toEqual(["claude", "codex"]);
    expect(economy.entries.find((entry) => entry.harness_id === "codex")).toMatchObject({
      incremental_cost_usd: null,
      eligible: true,
    });
    const auto = explainRanking(candidates, { ...context, goal: "auto" });
    expect(auto.entries.find((entry) => entry.harness_id === "codex")).toMatchObject({
      incremental_cost_usd: null,
      eligible: true,
    });
  });

  it("preserves compatible observed history on auth-only records and clears it on unpriced work", () => {
    const root = temporaryConfig();
    recordHarnessMetric(root, "adapter", { costUsd: 0.2, durationMs: 1_000 });
    recordHarnessMetric(root, "adapter", { costUsd: 0.4, durationMs: 2_000 });
    recordHarnessMetric(root, "adapter", { authMode: "api_key" });
    expect(loadHarnessMetrics(root).adapter).toEqual({
      avg_cost_usd: 0.26,
      avg_duration_ms: 1_300,
      samples: 2,
      last_auth_mode: "api_key",
    });

    recordHarnessMetric(root, "adapter", { costUsd: null, durationMs: 3_000 });
    expect(loadHarnessMetrics(root).adapter?.avg_cost_usd).toBeNull();
    recordHarnessMetric(root, "adapter", { costUsd: 0.8 });
    expect(loadHarnessMetrics(root).adapter?.avg_cost_usd).toBe(0.8);
  });

  it("does not revalidate a legacy cost when an unrelated harness writes new metrics", () => {
    const root = temporaryConfig();
    const path = metricsPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ old: { avg_cost_usd: 0.01, avg_duration_ms: 9_000, samples: 2 } }),
    );
    recordHarnessMetric(root, "new", { costUsd: 0.3 });
    expect(loadHarnessMetrics(root).old).toEqual({
      avg_cost_usd: null,
      avg_duration_ms: 9_000,
      samples: 2,
      last_auth_mode: null,
    });
    expect(loadHarnessMetrics(root).new?.avg_cost_usd).toBe(0.3);
  });
});
