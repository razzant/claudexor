import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudex/core";
import { runCapture } from "@claudex/core";
import { createFakeHarness } from "@claudex/harness-fake";
import type { ProviderFamily } from "@claudex/schema";
import { ConformanceReport, HarnessManifest } from "@claudex/schema";
import type { ReviewerSpec } from "@claudex/review";
import { Orchestrator } from "./orchestrator.js";

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudex-orch-"));
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", ["-C", repo, "-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-m", "init"]);
  return repo;
}

function cleanReviewer(id: string, family: ProviderFamily): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id,
    async discover() {
      return HarnessManifest.parse({ id, display_name: id, kind: "local_cli", provider_family: family, capabilities: { review: true } });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts, observed_model: `${id}-model` };
      yield { type: "message", session_id: spec.session_id, ts, text: "```json\n[]\n```" };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
  return { adapter, providerFamily: family };
}

/** A non-fake adapter that behaves like fake-success (for default-harness resolution). */
function realLikeAdapter(id: string, family: ProviderFamily = "openai"): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: { implement: true, review: true, structured_events: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["implement"] });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      yield { type: "usage", session_id: spec.session_id, ts, usage: { cost_usd: 0.01 } };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

const reviewers = () => [cleanReviewer("rev-openai", "openai"), cleanReviewer("rev-anthropic", "anthropic")];

describe("Orchestrator", () => {
  it("runs a best-of-n race end to end and emits a DecisionRecord", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({ repoRoot: repo, prompt: "do it", mode: "best_of_n", harnesses: ["fake-success"], n: 2 });
    expect(res.mode).toBe("best_of_n");
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
    expect(res.status).toBe("success");
    // the winner is always present in the returned candidates (incl. a synthesis candidate)
    expect(res.winner && res.candidates.some((c) => c.attemptId === res.winner)).toBeTruthy();
    expect(res.decisionPath && existsSync(res.decisionPath)).toBe(true);
    expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(true);
  });

  it("max-attempts converges and delivers to final/ (apply/inspect can use it)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "max_attempts", harnesses: ["fake-success"], attempts: 3 });
    expect(res.status).toBe("success");
    expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(true);
    expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(true);
  });

  it("until-convergence terminates on no-progress (bounded, not infinite)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-fail-tests", createFakeHarness("fake-fail-tests")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "until_convergence", harnesses: ["fake-fail-tests"] });
    expect(["not_converged", "exhausted"]).toContain(res.status);
  }, 20000);

  it("plan mode produces a SpecPack without mutating", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({ repoRoot: repo, prompt: "map the repo", mode: "plan", harnesses: ["fake-success"] });
    expect(res.status).toBe("success");
    expect(existsSync(join(res.runDir, "final", "plan.md"))).toBe(true);
  });

  it("stops spawning candidates once the budget hard cap is hit", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers(), maxUsd: 0.005 });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["fake-success"], n: 3 });
    // first candidate spends 0.01 (> 0.005 cap) -> hard tier -> remaining candidates denied
    expect(res.candidates.length).toBe(1);
  });

  it("runs deterministic gates from the tests input (test-driven, not vacuous)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });

    // A failing gate must make the candidate red (gates are no longer vacuous).
    const failed = await orch.run({
      repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["fake-success"], n: 1, tests: ["exit 1"],
    });
    expect(failed.candidates[0]?.status).toBe("red");

    // A passing gate keeps the candidate green.
    const passed = await orch.run({
      repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["fake-success"], n: 1, tests: ["true"],
    });
    expect(passed.candidates[0]?.status).toBe("green");
  });

  it("does not leak a worktree when a candidate errors", async () => {
    const repo = await initRepo();
    const throwing: HarnessAdapter = {
      id: "throwing",
      async discover() {
        return HarnessManifest.parse({ id: "throwing", display_name: "throwing", kind: "local_cli", capabilities: { implement: true } });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "throwing", status: "ok" });
      },
      // eslint-disable-next-line require-yield
      async *run() {
        throw new Error("boom");
      },
    };
    const registry = new Map<string, HarnessAdapter>([["throwing", throwing]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["throwing"], n: 1 });
    expect(res.status).not.toBe("success");
    expect(existsSync(join(repo, ".claudex", "workspaces", res.taskId, "a01"))).toBe(false);
  });

  it("applies a per-family reviewer model override (cheaper reviewer)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
      ["rev-openai", realLikeAdapter("rev-openai", "openai")],
      ["rev-anthropic", realLikeAdapter("rev-anthropic", "anthropic")],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewerModels: { openai: "o-cheap-model", anthropic: "a-cheap-model" },
    });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["fake-success"], n: 1 });
    const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(reviewYaml).toContain("o-cheap-model");
    expect(reviewYaml).toContain("a-cheap-model");
  });

  it("auto-resolves available real harnesses when --harness is omitted", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["realish", realLikeAdapter("realish")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", n: 2 });
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
    expect(res.candidates.every((c) => c.harnessId === "realish")).toBe(true);
  });
});
