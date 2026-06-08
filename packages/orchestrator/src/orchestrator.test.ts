import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudex/core";
import { runCapture } from "@claudex/core";
import { createFakeHarness } from "@claudex/harness-fake";
import type { ProviderFamily } from "@claudex/schema";
import { ConformanceReport, HarnessManifest } from "@claudex/schema";
import { noProjectRepoRoot } from "@claudex/util";
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
        access_profiles_supported: ["readonly", "workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["implement", "review"] });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      yield { type: "usage", session_id: spec.session_id, ts, usage: { cost_usd: 0.01 } };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

/** A reviewer/planner-only adapter (like raw-api): cannot implement/edit. */
function noImplementAdapter(id: string, family: ProviderFamily = "openai"): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id, display_name: id, kind: "remote_api", provider_family: family,
        capabilities: { plan: true, review: true, implement: false, edit_files: false },
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review", "plan"] });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
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

  it("until-clean terminates on no-progress (bounded, not infinite)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-fail-tests", createFakeHarness("fake-fail-tests")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "until_clean", harnesses: ["fake-fail-tests"] });
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

  it("capability-gates candidates: a non-implementing harness is dropped from an implement race", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["raw-ish", noImplementAdapter("raw-ish")],
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["raw-ish", "fake-success"], n: 2 });
    // Primary candidates (a01..) must all be the implementing harness; raw-ish is excluded.
    const primary = res.candidates.filter((c) => /^a\d+$/.test(c.attemptId));
    expect(primary.length).toBe(2);
    expect(primary.every((c) => c.harnessId === "fake-success")).toBe(true);
    expect(res.candidates.every((c) => c.harnessId !== "raw-ish")).toBe(true);
  });

  it("applies configured eligible pool, primary harness, model, and portfolio defaults", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, ".claudex"), { recursive: true });
    writeFileSync(
      join(repo, ".claudex", "config.yaml"),
      [
        "version: 1",
        "budget:",
        "  portfolio: balanced",
        "",
      ].join("\n"),
    );
    const seen: { id: string; model: string | null }[] = [];
    const adapterA = realLikeAdapter("codex", "openai");
    const adapterB: HarnessAdapter = {
      ...realLikeAdapter("claude", "anthropic"),
      async *run(spec) {
        seen.push({ id: "claude", model: spec.model_hint });
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const registry = new Map<string, HarnessAdapter>([["codex", adapterA], ["claude", adapterB]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["codex", "claude"], primaryHarness: "claude", model: "model-x", n: 1 });
    const taskYaml = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
    expect(res.candidates[0]?.harnessId).toBe("claude");
    expect(seen[0]?.model).toBe("model-x");
    expect(taskYaml).toContain("portfolio: balanced");
  });

  it("persists frozen spec provenance in the task contract", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      specId: "spec-123",
      specHash: "sha256:abc",
      specPath: "/tmp/spec.json",
    });
    const taskYaml = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
    expect(taskYaml).toContain("id: spec-123");
    expect(taskYaml).toContain("hash: sha256:abc");
    expect(taskYaml).toContain("path: /tmp/spec.json");
  });

  it("rejects a primary harness outside the selected eligible pool", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["codex", realLikeAdapter("codex", "openai")],
      ["claude", realLikeAdapter("claude", "anthropic")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    await expect(orch.run({ repoRoot: repo, prompt: "x", mode: "agent", harnesses: ["codex"], primaryHarness: "claude" })).rejects.toThrow(
      /primary harness 'claude'/,
    );
  });

  it("does not persist secret-like tokens from generated patch diffs", async () => {
    const repo = await initRepo();
    const secret = "sk-" + "a".repeat(24);
    const adapter: HarnessAdapter = {
      id: "leaky",
      async discover() {
        return HarnessManifest.parse({ id: "leaky", display_name: "leaky", kind: "local_cli", provider_family: "openai", capabilities: { implement: true }, access_profiles_supported: ["workspace_write"] });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "leaky", status: "ok", enabled_intents: ["implement"] });
      },
      async *run(spec) {
        writeFileSync(join(spec.cwd, ".env"), `OPENAI_API_KEY=${secret}\n`);
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const orch = new Orchestrator({ registry: new Map([["leaky", adapter]]), reviewers: [] });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["leaky"], n: 1 });
    expect(readFileSync(join(res.runDir, "final", "patch.diff"), "utf8")).not.toContain(secret);
    expect(existsSync(join(res.runDir, "attempts", "a01", "patch.diff"))).toBe(false);
  });

  it("fails loudly when no available harness can perform the intent", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["raw-ish", noImplementAdapter("raw-ish")]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["raw-ish"], n: 1 });
    expect(res.status).toBe("failed");
    expect(res.summary).toMatch(/perform 'implement'/);
    expect(readFileSync(join(res.runDir, "context", "context_error.md"), "utf8")).toMatch(/perform 'implement'/);
  });

  it("records an ask routing failure as inspectable artifacts instead of crashing the run", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["raw-ish", noImplementAdapter("raw-ish")]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({ repoRoot: repo, prompt: "2+2?", mode: "ask", harnesses: ["raw-ish"] });
    expect(res.status).toBe("failed");
    expect(res.summary).toMatch(/perform 'explain'/);
    expect(existsSync(join(res.runDir, "context", "context_error.md"))).toBe(true);
    expect(readFileSync(join(res.runDir, "final", "summary.md"), "utf8")).toContain("Status: failed");
  });

  it("stores no-project Ask artifacts in the user config store, not the synthetic repo root", async () => {
    const prev = process.env.CLAUDEX_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), "claudex-orch-config-"));
    process.env.CLAUDEX_CONFIG_DIR = configDir;
    try {
      const noProjectRoot = noProjectRepoRoot();
      mkdirSync(noProjectRoot, { recursive: true });
      const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
      const orch = new Orchestrator({ registry, reviewers: [] });
      const res = await orch.run({
        repoRoot: noProjectRoot,
        prompt: "2+2?",
        mode: "ask",
        contextMode: "off",
        harnesses: ["fake-success"],
      });
      expect(res.status).toBe("success");
      expect(res.runDir.startsWith(join(configDir, "runs"))).toBe(true);
      expect(existsSync(join(res.runDir, "final", "answer.md"))).toBe(true);
      expect(existsSync(join(noProjectRoot, ".claudex"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEX_CONFIG_DIR;
      else process.env.CLAUDEX_CONFIG_DIR = prev;
    }
  });

  it("rejects contextMode off outside no-project Ask", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    await expect(orch.run({ repoRoot: repo, prompt: "2+2?", mode: "ask", contextMode: "off", harnesses: ["fake-success"] })).rejects.toThrow(
      "contextMode 'off' is only supported for Ask without a repoRoot",
    );
  });

  it("runs explore as a bounded read-only swarm with synthesis and per-explorer artifacts", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({ repoRoot: repo, prompt: "map auth and run storage", mode: "explore", harnesses: ["fake-success"], n: 2 });
    expect(res.status).toBe("success");
    expect(res.candidates).toHaveLength(2);
    expect(existsSync(join(res.runDir, "findings", "a01.md"))).toBe(true);
    expect(existsSync(join(res.runDir, "findings", "a02.md"))).toBe(true);
    expect(readFileSync(join(res.runDir, "final", "explore.md"), "utf8")).toContain("Explorers succeeded: 2/2");
    expect(existsSync(join(res.runDir, "final", "explore-findings.yaml"))).toBe(true);
    expect(existsSync(join(res.runDir, "final", "omissions.md"))).toBe(true);
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

  it("applies per-family reviewer effort overrides", async () => {
    const repo = await initRepo();
    const seen: { id: string; model: string | null; effort: string | null }[] = [];
    function reviewer(id: string, family: ProviderFamily): HarnessAdapter {
      return {
        id,
        async discover() {
          return HarnessManifest.parse({
            id,
            display_name: id,
            kind: "local_cli",
            provider_family: family,
            capabilities: { review: true, structured_events: true },
            access_profiles_supported: ["readonly"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          seen.push({ id, model: spec.model_hint, effort: spec.effort_hint });
          yield { type: "started", session_id: spec.session_id, ts, observed_model: `${id}-observed` };
          yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        },
      };
    }
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
      ["rev-openai", reviewer("rev-openai", "openai")],
      ["rev-anthropic", reviewer("rev-anthropic", "anthropic")],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewerModels: { openai: "o-review", anthropic: "opus" },
      reviewerEfforts: { anthropic: "max" },
    });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["fake-success"], n: 1 });
    expect(seen).toEqual(
      expect.arrayContaining([
        { id: "rev-openai", model: "o-review", effort: null },
        { id: "rev-anthropic", model: "opus", effort: "max" },
      ]),
    );
    const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(reviewYaml).toContain("reviewer_requests:");
    expect(reviewYaml).toContain("requested_effort: max");
  });

  it("persists convergence review artifacts with reviewer effort metadata", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const anthropic = cleanReviewer("rev-anthropic", "anthropic");
    const orch = new Orchestrator({
      registry,
      reviewers: [
        cleanReviewer("rev-openai", "openai"),
        { ...anthropic, requestedModel: "opus", requestedEffort: "max" },
      ],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "max_attempts",
      harnesses: ["fake-success"],
      attempts: 1,
      tests: ["true"],
    });
    const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(reviewYaml).toContain("reviewer_requests:");
    expect(reviewYaml).toContain("requested_effort: max");
    expect(reviewYaml).toContain("findings:");
    expect(reviewYaml).toContain("route_proofs:");
  });

  it("auto-resolves available real harnesses when --harness is omitted", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["realish", realLikeAdapter("realish")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", n: 2 });
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
    expect(res.candidates.every((c) => c.harnessId === "realish")).toBe(true);
  });

  it("surfaces runId early and streams events via in-proc hooks (agent)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry });
    const runEvents: string[] = [];
    const harnessEvents: string[] = [];
    let startedRunId: string | null = null;
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      onRunStart: (i) => {
        startedRunId = i.runId;
      },
      onEvent: (e) => runEvents.push(e.type),
      onHarnessEvent: (e) => harnessEvents.push(e.type),
    });
    expect(startedRunId).toBe(res.runId);
    expect(runEvents).toContain("run.created");
    expect(runEvents).toContain("run.completed");
    expect(harnessEvents).toContain("message");
  });

  it("honors a pre-aborted signal (agent -> cancelled, no harness work forwarded)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry });
    const ac = new AbortController();
    ac.abort();
    const harnessEvents: string[] = [];
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      signal: ac.signal,
      onHarnessEvent: (e) => harnessEvents.push(e.type),
    });
    expect(res.status).toBe("cancelled");
    expect(harnessEvents.length).toBe(0);
  });

  it("isolates a throwing onHarnessEvent observer (agent stays success)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      onHarnessEvent: () => {
        throw new Error("observer boom");
      },
    });
    expect(res.status).toBe("success");
  });

  it("isolates a throwing onHarnessEvent observer in best_of_n (candidate not failed by observer)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "best_of_n",
      harnesses: ["fake-success"],
      n: 1,
      onHarnessEvent: () => {
        throw new Error("observer boom");
      },
    });
    expect(res.status).toBe("success");
  });

  it("a pre-aborted signal yields a cancelled result (plan + best_of_n, no misleading errors)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const ac = new AbortController();
    ac.abort();
    const plan = await orch.run({ repoRoot: repo, prompt: "x", mode: "plan", harnesses: ["fake-success"], signal: ac.signal });
    expect(plan.status).toBe("cancelled");
    const race = await orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["fake-success"], n: 2, signal: ac.signal });
    expect(race.status).toBe("cancelled");
  });

  it("in-place convergence runs against a non-git live dir and never deletes it", async () => {
    // A plain (non-git) directory standing in for a stateful benchmark container's /app.
    const dir = mkdtempSync(join(tmpdir(), "claudex-orch-inplace-"));
    writeFileSync(join(dir, "task.txt"), "do the thing\n");
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    // Two clean cross-family reviewers -> review-only convergence succeeds on attempt 1.
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: dir,
      prompt: "x",
      mode: "max_attempts",
      harnesses: ["fake-success"],
      attempts: 2,
      inPlace: true,
      access: "full",
    });
    expect(res.status).toBe("success");
    // The live dir and its file survive (dispose must not delete the tree in-place).
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "task.txt"))).toBe(true);
    // No scoped envelope leaks after dispose.
    expect(existsSync(join(dir, ".claudex", "workspaces", res.taskId, "converge"))).toBe(false);
  });
});
