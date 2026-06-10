import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { repoHash } from "@claudexor/config";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { runCapture, spawnProcess } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { ProviderFamily } from "@claudexor/schema";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { writeEvidencePacket } from "@claudexor/context";
import type { ReviewerSpec } from "@claudexor/review";
import { Orchestrator } from "./orchestrator.js";

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-orch-"));
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

function askAdapter(id: string, events: (sessionId: string) => AsyncIterable<unknown> | Iterable<unknown>, family: ProviderFamily = "openai", webPolicy: "native" | "tools" | "uncontrolled" | "none" = "tools"): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: { plan: true, review: true, read_files: true, structured_events: true, web_policy: webPolicy },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["explain", "audit", "plan", "review"] });
    },
    async *run(spec) {
      for await (const event of events(spec.session_id) as AsyncIterable<Record<string, unknown>>) {
        yield event as never;
      }
    },
  };
}

const reviewers = () => [cleanReviewer("rev-openai", "openai"), cleanReviewer("rev-anthropic", "anthropic")];

describe("Orchestrator", () => {
  it("fails closed when review evidence cannot be copied into the candidate tree", () => {
    const source = mkdtempSync(join(tmpdir(), "claudexor-review-source-"));
    writeEvidencePacket(source, {
      userIntent: "review this candidate",
      diff: "diff --git a/a b/a\n",
      tests: "not run",
    });
    const candidateFile = join(mkdtempSync(join(tmpdir(), "claudexor-review-candidate-")), "not-a-dir");
    writeFileSync(candidateFile, "file blocks candidate evidence dir");
    const orch = new Orchestrator({ registry: new Map() });

    expect(() =>
      (orch as unknown as { prepareReviewEvidenceDir(sourceDir: string, candidateCwd: string): string }).prepareReviewEvidenceDir(source, candidateFile),
    ).toThrow(/review evidence copy into candidate tree failed/);
  });

  it("runs a best-of-n race end to end and emits a DecisionRecord", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({ repoRoot: repo, prompt: "do it", mode: "best_of_n", harnesses: ["fake-success"], n: 2 });
    expect(res.mode).toBe("best_of_n");
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
    expect(res.status).toBe("no_op");
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
    expect(res.status).toBe("no_op");
    expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(true);
    expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(true);
    expect(existsSync(join(res.runDir, "arbitration", "decision.yaml"))).toBe(true);
  });

  it("until-clean terminates on no-progress (bounded, not infinite)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-fail-tests", createFakeHarness("fake-fail-tests")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "until_clean", harnesses: ["fake-fail-tests"] });
    // The identical-repair-prompt loop detector stops the run as exhausted
    // (3rd identical prompt) before the slower stall detector can mark it failed.
    expect(res.status).toBe("exhausted");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("loop_detected");
  }, 20000);

  it("plan mode produces a SpecPack without mutating", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({ repoRoot: repo, prompt: "map the repo", mode: "plan", harnesses: ["fake-success"] });
    expect(res.status).toBe("success");
    expect(existsSync(join(res.runDir, "final", "plan.md"))).toBe(true);
  });

  it("stops spawning queued candidates once the budget hard cap is hit (parallel wave finishes)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers(), maxUsd: 0.005 });
    // Candidates run in a bounded parallel wave (cap 4). Each fake spends 0.01
    // (> 0.005 cap), so the first wave settles into the hard tier and the
    // queued slots beyond the wave must be skipped, never spawned.
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["fake-success"], n: 6 });
    const primary = res.candidates.filter((c) => /^a\d+$/.test(c.attemptId));
    expect(primary.length).toBe(4);
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
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    writeFileSync(
      join(repo, ".claudexor", "config.yaml"),
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
    // The leaky candidate is refused before any artifact persists; with zero
    // working candidates the run fails with the ROOT CAUSE (no corpse review,
    // no empty final patch pretending to be a work product).
    expect(res.status).toBe("failed");
    expect(res.summary).toContain("secret-like token");
    expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(false);
    expect(existsSync(join(res.runDir, "attempts", "a01", "patch.diff"))).toBe(false);
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).not.toContain(secret);
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

  it("blocks ask success when an attempted WebSearch tool_result errors without recovery", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("web-bad", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield { type: "tool_call", session_id: sessionId, ts, text: "WebSearch", tool: { name: "WebSearch", kind: "web", use_id: "toolu_web", target: "Anton Razzhigaev" } };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        text: "tool_result: error: permission denied",
        tool: { name: "WebSearch", kind: "web", use_id: "toolu_web", status: "error", error_summary: "permission denied" },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Memory answer only." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["web-bad", adapter]]), reviewers: [] });
    const res = await orch.run({ repoRoot: repo, prompt: "google this", mode: "ask", harnesses: ["web-bad"], web: "auto", n: 1 });
    expect(res.status).toBe("blocked");
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain("web evidence unsatisfied");
    expect(readFileSync(join(res.runDir, "final", "answer.md"), "utf8")).toContain("Unverified partial output");
    const eventLog = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(eventLog).toContain("route.fallback.exhausted");
    expect(eventLog).toContain("run.blocked");
    // single-owner telemetry artifact records the web evidence
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("status: failed");
    expect(telemetry).toContain("permission denied");
  });

  it("blocks a web-required run that never attempted web (required && !satisfied)", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("no-web", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield { type: "message", session_id: sessionId, ts, text: "Answer from memory, no web call made." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["no-web", adapter]]), reviewers: [] });
    const res = await orch.run({ repoRoot: repo, prompt: "google this", mode: "ask", harnesses: ["no-web"], web: "live", n: 1 });
    expect(res.status).toBe("blocked");
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain("never attempted");
  });

  it("does not block on a tool error that was later recovered by the same tool", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("recovers", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield { type: "tool_call", session_id: sessionId, ts, text: "Bash", tool: { name: "Bash", kind: "command", use_id: "t1", target: "pnpm test" } };
      yield { type: "tool_result", session_id: sessionId, ts, tool: { name: "Bash", kind: "command", use_id: "t1", status: "error", error_summary: "2 tests failed" } };
      yield { type: "tool_call", session_id: sessionId, ts, text: "Bash", tool: { name: "Bash", kind: "command", use_id: "t2", target: "pnpm test" } };
      yield { type: "tool_result", session_id: sessionId, ts, tool: { name: "Bash", kind: "command", use_id: "t2", status: "ok", content_summary: "all green" } };
      yield { type: "message", session_id: sessionId, ts, text: "Recovered and finished." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["recovers", adapter]]), reviewers: [] });
    const res = await orch.run({ repoRoot: repo, prompt: "do it", mode: "ask", harnesses: ["recovers"], n: 1 });
    expect(res.status).toBe("success");
    expect(readFileSync(join(res.runDir, "final", "answer.md"), "utf8")).toContain("Recovered and finished.");
  });

  it("blocks on an unrecovered tool error in a readonly run", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("never-recovers", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield { type: "tool_call", session_id: sessionId, ts, text: "Bash", tool: { name: "Bash", kind: "command", use_id: "t1", target: "make it" } };
      yield { type: "tool_result", session_id: sessionId, ts, tool: { name: "Bash", kind: "command", use_id: "t1", status: "error", error_summary: "command not found" } };
      yield { type: "message", session_id: sessionId, ts, text: "Claimed done anyway." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["never-recovers", adapter]]), reviewers: [] });
    const res = await orch.run({ repoRoot: repo, prompt: "do it", mode: "ask", harnesses: ["never-recovers"], n: 1 });
    expect(res.status).toBe("failed");
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain("failed without recovery");
  });

  it("falls back to another ask harness when web evidence is unsatisfied", async () => {
    const repo = await initRepo();
    const bad = askAdapter("web-bad", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "tool_call", session_id: sessionId, ts, text: "WebSearch", tool: { name: "WebSearch", kind: "web", use_id: "toolu_web", target: "Anton Razzhigaev" } };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        tool: { name: "WebSearch", kind: "web", use_id: "toolu_web", status: "error", error_summary: "permission denied" },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Memory answer only." };
    });
    const good = askAdapter("web-good", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "tool_call", session_id: sessionId, ts, text: "WebSearch", tool: { name: "WebSearch", kind: "web", use_id: "toolu_web2", target: "Anton Razzhigaev" } };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        tool: { name: "WebSearch", kind: "web", use_id: "toolu_web2", status: "ok", content_summary: "search result" },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Web-backed answer." };
    }, "anthropic");
    const orch = new Orchestrator({ registry: new Map([["web-bad", bad], ["web-good", good]]), reviewers: [] });
    const res = await orch.run({ repoRoot: repo, prompt: "google this", mode: "ask", harnesses: ["web-bad", "web-good"], web: "auto" });
    expect(res.status).toBe("success");
    expect(readFileSync(join(res.runDir, "final", "answer.md"), "utf8")).toContain("Web-backed answer.");
    const eventLog = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(eventLog).toContain("route.fallback.started");
    expect(eventLog).toContain("route.fallback.completed");
  });

  it("stores no-project Ask artifacts in the user config store, not the synthetic repo root", async () => {
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-orch-config-"));
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
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
      expect(existsSync(join(noProjectRoot, ".claudexor"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
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
        return HarnessManifest.parse({
          id: "throwing",
          display_name: "throwing",
          kind: "local_cli",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
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
    expect(res.status).toBe("failed");
    expect(existsSync(join(res.runDir, "final", "failure.yaml"))).toBe(true);
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain("attempts/a01/attempt.yaml");
    expect(existsSync(join(repo, ".claudexor", "workspaces", res.taskId, "a01"))).toBe(false);
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

  it("reviews the candidate worktree rather than the unchanged base repo", async () => {
    const repo = await initRepo();
    const writer: HarnessAdapter = {
      id: "writer",
      async discover() {
        return HarnessManifest.parse({
          id: "writer",
          display_name: "writer",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { implement: true, edit_files: true, review: true, structured_events: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "writer", status: "ok", enabled_intents: ["implement"] });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        writeFileSync(join(spec.cwd, "README.md"), "OK\n");
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "writer-model" };
        yield { type: "completed", session_id: spec.session_id, ts, observed_model: "writer-model" };
      },
    };
    function cwdAwareReviewer(id: string, family: ProviderFamily): ReviewerSpec {
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
          const readme = readFileSync(join(spec.cwd, "README.md"), "utf8");
          const findings =
            readme === "OK\n"
              ? "[]"
              : JSON.stringify([
                  {
                    severity: "BLOCK",
                    category: "correctness",
                    claim: "Reviewer did not see the candidate README.md content.",
                    evidence: { files: [{ path: "README.md", lines: "1" }] },
                    proposed_fix: "Run reviewers against the candidate worktree.",
                  },
                ]);
          yield { type: "started", session_id: spec.session_id, ts, observed_model: `${id}-model` };
          yield { type: "message", session_id: spec.session_id, ts, text: findings };
          yield { type: "completed", session_id: spec.session_id, ts, observed_model: `${id}-model` };
        },
      };
      return { adapter, providerFamily: family };
    }

    const registry = new Map<string, HarnessAdapter>([["writer", writer]]);
    const orch = new Orchestrator({
      registry,
      reviewers: [cwdAwareReviewer("rev-openai", "openai"), cwdAwareReviewer("rev-anthropic", "anthropic")],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "change README.md to OK",
      mode: "best_of_n",
      harnesses: ["writer"],
      n: 1,
      tests: ["grep -qx OK README.md"],
    });
    expect(res.status).toBe("success");
    const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(reviewYaml).not.toContain("Reviewer did not see");
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
    const eventLog = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(eventLog).toContain("\"type\":\"harness.event\"");
    expect(eventLog).toContain("\"harness_id\":\"fake-success\"");
    expect(eventLog).toContain("\"attempt_id\":\"a01\"");
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

  it("forwards abort into the harness process for silent active runs", async () => {
    const repo = await initRepo();
    const marker = join(repo, "survived.txt");
    const adapter: HarnessAdapter = {
      id: "silent-process",
      async discover() {
        return HarnessManifest.parse({
          id: "silent-process",
          display_name: "silent-process",
          kind: "local_cli",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "silent-process", status: "ok", enabled_intents: ["implement"] });
      },
      async *run(spec) {
        const signal = spec.extra["abortSignal"] as AbortSignal | undefined;
        const script = [
          "console.log('ready')",
          "process.on('SIGINT', () => {})",
          `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500)`,
          "setTimeout(() => {}, 5000)",
        ].join(";");
        for await (const ev of spawnProcess(process.execPath, ["-e", script], { abortSignal: signal, cancelKillDelayMs: 100 })) {
          if (ev.type === "stdout" && ev.line === "ready") {
            yield { type: "started", session_id: spec.session_id, ts: new Date().toISOString() };
          }
        }
      },
    };
    const ac = new AbortController();
    const orch = new Orchestrator({ registry: new Map([["silent-process", adapter]]) });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["silent-process"],
      signal: ac.signal,
      onHarnessEvent: (e) => {
        if (e.type === "started") ac.abort();
      },
    });
    expect(res.status).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(existsSync(marker)).toBe(false);
  }, 10000);

  it("isolates a throwing onHarnessEvent observer (agent stays terminal no-op)", async () => {
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
    expect(res.status).toBe("no_op");
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
    expect(res.status).toBe("no_op");
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
    // A plain (non-git) directory standing in for a stateful external environment.
    const dir = mkdtempSync(join(tmpdir(), "claudexor-orch-inplace-"));
    writeFileSync(join(dir, "task.txt"), "do the thing\n");
    // access=full requires a USER-LEVEL trust allow (TrustConfig wire-in); the
    // test scopes the config dir so it never touches the developer's real home.
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-orch-trust-"));
    mkdirSync(join(configDir, "trust"), { recursive: true });
    writeFileSync(join(configDir, "trust", `${repoHash(dir)}.yaml`), "allow_full_access: true\n");
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
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
      expect(res.status).toBe("no_op");
      // The live dir and its file survive (dispose must not delete the tree in-place).
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "task.txt"))).toBe(true);
      // No scoped envelope leaks after dispose.
      expect(existsSync(join(dir, ".claudexor", "workspaces", res.taskId, "converge"))).toBe(false);
    } finally {
      delete process.env.CLAUDEXOR_CONFIG_DIR;
    }
  });

  it("refuses access=full without a user-level trust allow (loud, no silent downgrade)", async () => {
    const repo = await initRepo();
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-orch-notrust-"));
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
      const orch = new Orchestrator({ registry, reviewers: reviewers() });
      await expect(
        orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["fake-success"], n: 1, access: "full" }),
      ).rejects.toThrow(/allow_full_access/);
    } finally {
      delete process.env.CLAUDEXOR_CONFIG_DIR;
    }
  });

  it("web off routes a no-web harness but excludes an uncontrolled-web harness loudly", async () => {
    const repo = await initRepo();
    const answer = (sessionId: string) => [
      { type: "started", session_id: sessionId, ts: new Date().toISOString() },
      { type: "message", session_id: sessionId, ts: new Date().toISOString(), text: "local answer" },
      { type: "completed", session_id: sessionId, ts: new Date().toISOString() },
    ];
    // `none` (no web at ALL) trivially satisfies --web off.
    const noWeb = new Map<string, HarnessAdapter>([["no-web", askAdapter("no-web", answer, "openai", "none")]]);
    const ok = await new Orchestrator({ registry: noWeb, reviewers: [] }).run({
      repoRoot: repo, prompt: "q", mode: "ask", harnesses: ["no-web"], web: "off",
    });
    expect(ok.status).toBe("success");
    // `uncontrolled` (web exists, no switch) cannot enforce off: explicit selection fails loudly.
    const uncontrolled = new Map<string, HarnessAdapter>([["wild-web", askAdapter("wild-web", answer, "openai", "uncontrolled")]]);
    const blocked = await new Orchestrator({ registry: uncontrolled, reviewers: [] }).run({
      repoRoot: repo, prompt: "q", mode: "ask", harnesses: ["wild-web"], web: "off",
    });
    expect(blocked.status).toBe("failed");
    expect(blocked.summary).toContain("cannot enforce web policy 'off'");
  });

  it("applies the configured global max_usd_per_run as the default run cap", async () => {
    const repo = await initRepo();
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-orch-budgetcfg-"));
    writeFileSync(join(configDir, "config.yaml"), "budget:\n  max_usd_per_run: 0.005\n");
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const registry = new Map<string, HarnessAdapter>([["fake-success", createFakeHarness("fake-success")]]);
      const orch = new Orchestrator({ registry, reviewers: reviewers() });
      // No explicit --max-usd: the configured default cap must bind (each fake
      // candidate costs 0.01 > 0.005, so the wave settles into the hard tier
      // and queued slots are denied — same shape as the explicit-cap test).
      const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["fake-success"], n: 6 });
      const contract = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
      expect(contract).toContain("max_usd: 0.005");
      const primary = res.candidates.filter((c) => /^a\d+$/.test(c.attemptId));
      expect(primary.length).toBeLessThan(6);
    } finally {
      delete process.env.CLAUDEXOR_CONFIG_DIR;
    }
  });
});

function readRunEvents(runDir: string): { seq?: number; type: string; payload: Record<string, unknown> }[] {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { seq?: number; type: string; payload: Record<string, unknown> });
}

/** Lifecycle invariant: output.ready precedes the terminal event (non-cancelled). */
function expectOutputReadyBeforeTerminal(runDir: string): void {
  const events = readRunEvents(runDir);
  const terminalIdx = events.findIndex((e) => ["run.completed", "run.failed", "run.blocked"].includes(e.type));
  expect(terminalIdx).toBeGreaterThan(-1);
  const terminal = events[terminalIdx]!;
  if (terminal.type === "run.failed" && terminal.payload["status"] === "cancelled") return; // cancelled runs promise no output
  const readyIdx = events.findIndex((e) => e.type === "output.ready");
  expect(readyIdx).toBeGreaterThan(-1);
  expect(readyIdx).toBeLessThan(terminalIdx);
}

describe("Orchestrator v0.8 honesty & streaming", () => {
  it("stamps a strictly monotonic seq on every run event", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["impl", realLikeAdapter("impl")]]);
    const res = await new Orchestrator({ registry, reviewers: reviewers() }).run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["impl"], n: 1 });
    const events = readRunEvents(res.runDir);
    expect(events.length).toBeGreaterThan(3);
    for (const [idx, ev] of events.entries()) {
      expect(ev.seq).toBe(idx + 1);
    }
  });

  it("emits output.ready before the terminal event in every mode", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["impl", realLikeAdapter("impl")]]);
    const answer = (sessionId: string) => [
      { type: "started", session_id: sessionId, ts: new Date().toISOString() },
      { type: "message", session_id: sessionId, ts: new Date().toISOString(), text: "An answer." },
      { type: "completed", session_id: sessionId, ts: new Date().toISOString() },
    ];
    const askRegistry = new Map<string, HarnessAdapter>([["asker", askAdapter("asker", answer)]]);

    const race = await new Orchestrator({ registry, reviewers: reviewers() }).run({ repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["impl"], n: 1 });
    expectOutputReadyBeforeTerminal(race.runDir);

    const converge = await new Orchestrator({ registry, reviewers: reviewers() }).run({ repoRoot: repo, prompt: "x", mode: "max_attempts", harnesses: ["impl"], attempts: 1 });
    expectOutputReadyBeforeTerminal(converge.runDir);

    const ask = await new Orchestrator({ registry: askRegistry, reviewers: [] }).run({ repoRoot: repo, prompt: "q", mode: "ask", harnesses: ["asker"] });
    expectOutputReadyBeforeTerminal(ask.runDir);

    const plan = await new Orchestrator({ registry: askRegistry, reviewers: [] }).run({ repoRoot: repo, prompt: "q", mode: "plan", harnesses: ["asker"] });
    expectOutputReadyBeforeTerminal(plan.runDir);
  });

  it("skips review/synthesis/arbitration entirely when no candidate produced work", async () => {
    const repo = await initRepo();
    const crashing: HarnessAdapter = {
      id: "crasher",
      async discover() {
        return HarnessManifest.parse({ id: "crasher", display_name: "crasher", kind: "local_cli", provider_family: "openai", capabilities: { implement: true }, access_profiles_supported: ["workspace_write"] });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "crasher", status: "ok", enabled_intents: ["implement"] });
      },
      // eslint-disable-next-line require-yield
      async *run(): AsyncIterable<never> {
        throw new Error("adapter exploded before any work");
      },
    };
    const res = await new Orchestrator({ registry: new Map([["crasher", crashing]]), reviewers: reviewers() }).run({
      repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["crasher"], n: 2,
    });
    expect(res.status).toBe("failed");
    expect(res.summary).toContain("adapter exploded");
    const events = readRunEvents(res.runDir);
    const types = events.map((e) => e.type);
    // No reviewer money, no synthesis, no arbitration over corpses.
    expect(types).not.toContain("review.started");
    expect(types).not.toContain("reviewer.started");
    expect(types).not.toContain("synthesis.started");
    expect(types).not.toContain("arbitration.completed");
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("adapter exploded");
    expect(failure).not.toContain("attempts/a02/attempt.yaml\n"); // rawDetailRef must reference an EXISTING file
    expect(existsSync(join(res.runDir, "attempts", "a01", "attempt.yaml"))).toBe(true);
    expectOutputReadyBeforeTerminal(res.runDir);
  });

  it("initializes a git boundary automatically for write modes on a non-git folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-nongit-"));
    writeFileSync(join(dir, "notes.txt"), "pre-existing file\n");
    const registry = new Map<string, HarnessAdapter>([["impl", realLikeAdapter("impl")]]);
    const res = await new Orchestrator({ registry, reviewers: reviewers() }).run({
      repoRoot: dir, prompt: "x", mode: "best_of_n", harnesses: ["impl"], n: 1,
    });
    expect(existsSync(join(dir, ".git"))).toBe(true);
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".claudexor/");
    const events = readRunEvents(res.runDir);
    const initEvent = events.find((e) => e.type === "project.git.initialized");
    expect(initEvent).toBeDefined();
    expect(initEvent?.payload["baseline_committed"]).toBe(true);
    const log = await runCapture("git", ["-C", dir, "log", "--oneline"]);
    expect(log.stdout).toContain("claudexor: initialize repository baseline");
    // The baseline must include the user's pre-existing file but never .claudexor/.
    const tracked = await runCapture("git", ["-C", dir, "ls-files"]);
    expect(tracked.stdout).toContain("notes.txt");
    expect(tracked.stdout).not.toContain(".claudexor/runs");
  });

  it("delivers interactive answers into the harness and logs the lifecycle", async () => {
    const repo = await initRepo();
    const seen: unknown[] = [];
    const interactive: HarnessAdapter = {
      id: "asker",
      async discover() {
        return HarnessManifest.parse({
          id: "asker", display_name: "asker", kind: "local_cli", provider_family: "anthropic",
          capabilities: { implement: true, interactive: true }, access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "asker", status: "ok", enabled_intents: ["implement"] });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        const channel = (spec.extra as Record<string, unknown>)["interactionChannel"] as
          | { request(req: unknown): Promise<unknown> }
          | undefined;
        if (channel) {
          const answers = await channel.request({
            interaction_id: "int-1",
            source_tool: "AskUserQuestion",
            questions: [{ id: "q1", question: "Which flavor?", header: null, options: [{ label: "vanilla", description: null }], multi_select: false }],
          });
          seen.push(answers);
        }
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const res = await new Orchestrator({ registry: new Map([["asker", interactive]]), reviewers: reviewers() }).run({
      repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["asker"], n: 1,
      onInteraction: async (ctx) => ({
        interaction_id: ctx.request.interaction_id,
        answers: [{ question_id: "q1", selected_labels: ["vanilla"], free_text: null }],
      }),
    });
    expect(res.status).not.toBe("failed");
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).toContain("vanilla");
    const types = readRunEvents(res.runDir).map((e) => e.type);
    expect(types).toContain("interaction.requested");
    expect(types).toContain("interaction.answered");
  });

  it("declines benignly when the interactive answer times out", async () => {
    const repo = await initRepo();
    const seen: unknown[] = [];
    const interactive: HarnessAdapter = {
      id: "asker",
      async discover() {
        return HarnessManifest.parse({
          id: "asker", display_name: "asker", kind: "local_cli", provider_family: "anthropic",
          capabilities: { implement: true, interactive: true }, access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "asker", status: "ok", enabled_intents: ["implement"] });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        const channel = (spec.extra as Record<string, unknown>)["interactionChannel"] as
          | { request(req: unknown): Promise<unknown> }
          | undefined;
        if (channel) {
          seen.push(await channel.request({ interaction_id: "int-t", source_tool: "AskUserQuestion", questions: [] }));
        }
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const res = await new Orchestrator({ registry: new Map([["asker", interactive]]), reviewers: reviewers() }).run({
      repoRoot: repo, prompt: "x", mode: "best_of_n", harnesses: ["asker"], n: 1,
      interactionTimeoutMs: 50,
      onInteraction: () => new Promise(() => {}), // never answers
    });
    expect(res.status).not.toBe("failed");
    expect(seen).toEqual([null]);
    const types = readRunEvents(res.runDir).map((e) => e.type);
    expect(types).toContain("interaction.requested");
    expect(types).toContain("interaction.timeout");
    expect(types).not.toContain("interaction.answered");
  });
});
