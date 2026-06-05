import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("Orchestrator", () => {
  it("runs a best-of-n race end to end and emits a DecisionRecord", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const reviewers = [cleanReviewer("rev-openai", "openai"), cleanReviewer("rev-anthropic", "anthropic")];
    const orch = new Orchestrator({ registry, reviewers });

    const res = await orch.run({ repoRoot: repo, prompt: "do it", mode: "best_of_n", harnesses: ["fake-success"], n: 2 });
    expect(res.mode).toBe("best_of_n");
    expect(res.candidates.length).toBe(2);
    expect(res.status).toBe("success");
    expect(res.decisionPath && existsSync(res.decisionPath)).toBe(true);
    expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(true);
    expect(existsSync(join(res.runDir, "events.jsonl"))).toBe(true);
  });

  it("max-attempts converges with a passing harness", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const reviewers = [cleanReviewer("rev-openai", "openai"), cleanReviewer("rev-anthropic", "anthropic")];
    const orch = new Orchestrator({ registry, reviewers });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "max_attempts", harnesses: ["fake-success"], attempts: 3 });
    expect(res.status).toBe("success");
  });

  it("readonly plan mode produces a report without mutating", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({ repoRoot: repo, prompt: "map the repo", mode: "plan", harnesses: ["fake-success"] });
    expect(res.status).toBe("success");
    expect(existsSync(join(res.runDir, "final", "plan.md"))).toBe(true);
  });
});
