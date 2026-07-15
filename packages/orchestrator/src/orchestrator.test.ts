import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { repoHash } from "@claudexor/config";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const shellGate = (command: string) => ({
  program: "sh",
  args: ["-c", command],
  envAllowlist: [] as string[],
});

const frozenShellGate = (id: string, command: string) => ({
  id,
  ...shellGate(command),
  required: true,
  trust_required: false,
  trust_grant: null,
});
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { runCapture, spawnProcess } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { ControlReviewerPanelEntry, ProviderFamily } from "@claudexor/schema";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { noProjectRepoRoot, projectRuntimeDir } from "@claudexor/util";
import { writeEvidencePacket } from "@claudexor/context";
import type { ReviewerSpec } from "@claudexor/review";
import { Orchestrator } from "./orchestrator.js";

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-orch-"));
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@t.dev",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "init",
  ]);
  return repo;
}

function cleanReviewer(id: string, family: ProviderFamily): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: { review: true },
      });
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

/** Run a block with CLAUDEXOR_CONFIG_DIR pointed at a fresh empty dir, so the
 * developer's real ~/.claudexor config can never leak into fixtures. */
async function withScopedConfigDir<T>(fn: () => Promise<T>): Promise<T> {
  const configDir = mkdtempSync(join(tmpdir(), "claudexor-test-config-"));
  const prev = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
  }
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
        capabilities: {
          implement: true,
          review: true,
          // Manifest truth source for strict model-truth tests: explicit "model-x"
          // requests validate; anything else gets a typed refusal. The
          // *-cheap-model / *-review ids serve the reviewer-override tests.
          known_models: [
            "model-x",
            "model-y",
            "o-cheap-model",
            "a-cheap-model",
            "o-review",
            "a-review",
          ],
        },
        access_profiles_supported: ["readonly", "workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["implement", "review"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      yield { type: "usage", session_id: spec.session_id, ts, usage: { cost_usd: 0.01 } };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

/** An implementer that writes a REAL file, so the candidate has a non-empty diff
 * and the reviewer panel actually runs (empty-diff candidates skip paid review). */
function diffImplementer(id: string, family: ProviderFamily = "local"): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        // Implement-only: it must NOT also qualify as a reviewer (else it would
        // review its own candidate and crowd out a real cross-family reviewer).
        capabilities: { implement: true },
        access_profiles_supported: ["workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["implement"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts, observed_model: `${id}-model` };
      writeFileSync(join(spec.cwd, "CHANGED.txt"), "real change\n");
      yield { type: "message", session_id: spec.session_id, ts, text: "Implemented." };
      yield {
        type: "usage",
        session_id: spec.session_id,
        ts,
        usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01 },
      };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

function transientThenDiffImplementer(id: string): {
  adapter: HarnessAdapter;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    adapter: {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        calls += 1;
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        if (calls === 1) {
          yield {
            type: "error",
            session_id: spec.session_id,
            ts,
            error: "network dropped",
            transient: { kind: "network", retry_delay_ms: 0 },
          };
          yield { type: "completed", session_id: spec.session_id, ts };
          return;
        }
        writeFileSync(join(spec.cwd, "RECOVERED.txt"), "ok\n");
        yield { type: "message", session_id: spec.session_id, ts, text: "Recovered." };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    },
  };
}

/** A reviewer/planner-only adapter (like raw-api): cannot implement/edit. */
function noImplementAdapter(id: string, family: ProviderFamily = "openai"): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "remote_api",
        provider_family: family,
        capabilities: { plan: true, review: true, implement: false, edit_files: false },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["review", "plan"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

function askAdapter(
  id: string,
  events: (sessionId: string) => AsyncIterable<unknown> | Iterable<unknown>,
  family: ProviderFamily = "openai",
  webPolicy: "native" | "tools" | "uncontrolled" | "none" = "tools",
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: {
          plan: true,
          review: true,
          read_files: true,
          web_policy: webPolicy,
        },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["explain", "audit", "plan", "review"],
      });
    },
    async *run(spec) {
      for await (const event of events(spec.session_id) as AsyncIterable<Record<string, unknown>>) {
        yield event as never;
      }
    },
  };
}

const reviewers = () => [
  cleanReviewer("rev-openai", "openai"),
  cleanReviewer("rev-anthropic", "anthropic"),
];

describe("Orchestrator", () => {
  it("keeps review evidence external even when a candidate path would block the old in-tree copy", () => {
    const source = mkdtempSync(join(tmpdir(), "claudexor-review-source-"));
    writeEvidencePacket(source, {
      userIntent: "review this candidate",
      diff: "diff --git a/a b/a\n",
      tests: "not run",
    });
    const candidateFile = join(
      mkdtempSync(join(tmpdir(), "claudexor-review-candidate-")),
      "not-a-dir",
    );
    writeFileSync(candidateFile, "file blocks candidate evidence dir");
    const orch = new Orchestrator({ registry: new Map() });

    const selected = (
      orch as unknown as {
        prepareReviewEvidenceDir(sourceDir: string, candidateCwd: string): string;
      }
    ).prepareReviewEvidenceDir(source, candidateFile);
    expect(selected).toBe(source);
    expect(readFileSync(candidateFile, "utf8")).toBe("file blocks candidate evidence dir");
  });

  it("terminates agent runs when review evidence setup fails", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["impl", diffImplementer("impl")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    (
      orch as unknown as {
        prepareReviewEvidenceDir(sourceDir: string, candidateCwd: string): string;
      }
    ).prepareReviewEvidenceDir = () => {
      throw new Error("forced review evidence failure");
    };

    const res = await orch.run({
      repoRoot: repo,
      prompt: "do it",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
    });

    expect(res.status).toBe("failed");
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("phase: review");
    expect(failure).toContain("forced review evidence failure");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"run.failed"');
    expect(events).not.toContain('"type":"arbitration.completed"');
    expect(events).not.toContain('"type":"run.completed"');
  });

  it("runs a best-of-n race end to end and emits a DecisionRecord", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do it",
      mode: "agent",
      harnesses: ["fake-success"],
      n: 2,
    });
    expect(res.mode).toBe("agent");
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
    expect(res.status).toBe("no_op");
    // the winner is always present in the returned candidates (incl. a synthesis candidate)
    expect(res.winner && res.candidates.some((c) => c.attemptId === res.winner)).toBeTruthy();
    expect(res.decisionPath && existsSync(res.decisionPath)).toBe(true);
    expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(true);
  });

  it("max-attempts converges and delivers to final/ (apply/inspect can use it)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      attempts: 3,
    });
    expect(res.status).toBe("no_op");
    expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(true);
    expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(true);
    expect(existsSync(join(res.runDir, "arbitration", "decision.yaml"))).toBe(true);
  });

  it("until-clean terminates on no-progress (bounded, not infinite)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-fail-tests", createFakeHarness("fake-fail-tests")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      untilClean: true,
      harnesses: ["fake-fail-tests"],
    });
    // The identical-repair-prompt loop detector stops the run as exhausted
    // (3rd identical prompt) before the slower stall detector can mark it failed.
    expect(res.status).toBe("exhausted");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("loop_detected");
  }, 20000);

  it("until-clean stops as stuck_no_progress on repeated identical diff plus failing gate", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-implement", createFakeHarness("fake-implement")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "write deterministic file",
      mode: "agent",
      untilClean: true,
      harnesses: ["fake-implement"],
      tests: [shellGate("false")],
    });
    expect(res.status).toBe("stuck_no_progress");
    const summary = readFileSync(join(res.runDir, "final", "summary.md"), "utf8");
    expect(summary).toContain("No-progress reason");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("stuck_no_progress");
  }, 20000);

  it("retries a typed transient candidate failure when no deliverable was produced", async () => {
    const repo = await initRepo();
    const transient = transientThenDiffImplementer("transient-impl");
    const registry = new Map<string, HarnessAdapter>([[transient.adapter.id, transient.adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "write file",
      mode: "agent",
      harnesses: [transient.adapter.id],
      n: 1,
    });
    expect(transient.calls()).toBe(2);
    expect(res.status).not.toBe("failed");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("route.transient.retry_scheduled");
    const attempt = readFileSync(join(res.runDir, "attempts", "a01", "attempt.yaml"), "utf8");
    expect(attempt).toContain("transient_failures");
    expect(attempt).toContain("network");
  });

  it("plan mode produces a SpecPack without mutating", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map the repo",
      mode: "plan",
      harnesses: ["fake-success"],
    });
    expect(res.status).toBe("success");
    expect(existsSync(join(res.runDir, "final", "plan.md"))).toBe(true);
  });

  it("enforces an explicit project mandatory_files contract UNIFORMLY across modes (P1)", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    writeFileSync(
      join(repo, ".claudexor", "config.yaml"),
      "version: 1\ncontext:\n  mandatory_files:\n    - MISSING.md\n",
    );
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    // ask (skips ContextPack), audit (builds it), and agent (never built it) must
    // now ALL fail the same way on a missing explicit mandatory file — the P1 bug
    // was that audit failed while run/ask silently passed the same repo state.
    for (const mode of ["ask", "audit", "agent"] as const) {
      await expect(
        orch.run({ repoRoot: repo, prompt: "x", mode, harnesses: ["fake-success"] }),
      ).rejects.toThrow(/mandatory context missing\/unreadable/);
    }
  });

  it("enforces the budget cap mid-flight: no candidate beyond the wave spawns and the cap abort is evidenced", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers(), maxUsd: 0.005 });
    // Each fake streams 0.01 usage (> 0.005 cap). With amount-bearing holds the
    // FIRST usage event already drives the tier hard: in-flight candidates abort
    // mid-stream (no silent overshoot), pre-start wave slots are skipped, and the
    // queued slots beyond the parallel wave (a05, a06) are never spawned.
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      n: 6,
    });
    const primary = res.candidates.filter((c) => /^a\d+$/.test(c.attemptId));
    expect(primary.length).toBeGreaterThanOrEqual(1);
    expect(primary.length).toBeLessThanOrEqual(4);
    expect(primary.some((c) => c.attemptId === "a05" || c.attemptId === "a06")).toBe(false);
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toMatch(/hard cap/);
  });

  it("wave-guard boundary: cap = 2×floor runs TWO candidates (never zero) and denies the rest as estimate_headroom", async () => {
    // GPT-critic live repro (Phase 2): with the default 0.05 floor, a race
    // whose cap is an exact multiple of the floor granted an estimate that
    // consumed headroom to the boundary, tripped the hard tier with $0 spent,
    // and cancelled EVERY candidate ("exhausted", zero candidates).
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers(), maxUsd: 0.1 });
    const res = await withScopedConfigDir(async () =>
      orch.run({ repoRoot: repo, prompt: "x", mode: "agent", harnesses: ["fake-success"], n: 4 }),
    );
    const primary = res.candidates.filter((c) => /^a\d+$/.test(c.attemptId));
    // Slot 1 holds nothing; slot 2 holds 0.05 (< 0.10 remaining); slot 3 would
    // need 0.05 with exactly 0.05 remaining -> typed estimate_headroom denial.
    expect(primary.length).toBe(2);
    expect(res.status).not.toBe("exhausted");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("insufficient headroom for estimated cost");
  });

  it("capability-gates candidates: a non-implementing harness is dropped from an implement race", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["raw-ish", noImplementAdapter("raw-ish")],
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["raw-ish", "fake-success"],
      n: 2,
    });
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
      ["version: 1", "budget:", "  portfolio: balanced", ""].join("\n"),
    );
    const seen: { id: string; model: string | null }[] = [];
    const adapterA: HarnessAdapter = {
      ...realLikeAdapter("codex", "openai"),
      async *run(spec) {
        seen.push({ id: "codex", model: spec.model_hint });
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const adapterB: HarnessAdapter = {
      ...realLikeAdapter("claude", "anthropic"),
      async *run(spec) {
        seen.push({ id: "claude", model: spec.model_hint });
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const registry = new Map<string, HarnessAdapter>([
      ["codex", adapterA],
      ["claude", adapterB],
    ]);
    // Scope the global config away from the developer's real ~/.claudexor:
    // strict model preflight now judges per-harness settings defaults, so an
    // operator's own `harnesses.codex.default_model` would leak into fixtures.
    const res = await withScopedConfigDir(async () => {
      const orch = new Orchestrator({ registry, reviewers: [] });
      return orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["codex", "claude"],
        primaryHarness: "claude",
        model: "model-x",
        n: 2,
      });
    });
    expect(res.status).not.toBe("failed");
    const taskYaml = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
    // INV-103: the scalar model expands to the RESOLVED PRIMARY only. The
    // other pool member must NOT be poisoned by the primary's model id (the
    // old crash class: one vendor's model forwarded to every harness).
    expect(seen.find((s) => s.id === "claude")?.model).toBe("model-x");
    expect(seen.find((s) => s.id === "codex")?.model).toBeNull();
    expect(taskYaml).toContain("portfolio: balanced");
    // The contract records the resolved harness-scoped map.
    expect(taskYaml).toContain("routing_models");
    expect(taskYaml).toContain("claude: model-x");
  });

  it("REFUSES a run whose resolved model fails the harness truth source (typed preflight, no CLI spawn)", async () => {
    const repo = await initRepo();
    let spawned = false;
    const adapter: HarnessAdapter = {
      ...realLikeAdapter("codex", "openai"),
      async *run(spec) {
        spawned = true;
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const registry = new Map<string, HarnessAdapter>([["codex", adapter]]);
    const res = await withScopedConfigDir(async () => {
      const orch = new Orchestrator({ registry, reviewers: [] });
      return orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["codex"],
        model: "gpt-nonexistent",
        n: 1,
      });
    });
    expect(res.status).toBe("failed");
    expect(spawned).toBe(false);
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("gpt-nonexistent");
    expect(failure).toContain("codex");
    expect(failure).toContain("truth source");
  });

  it("REJECTS a scalar model when no primary harness is resolvable (ambiguous pool)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["codex", realLikeAdapter("codex", "openai")],
      ["claude", realLikeAdapter("claude", "anthropic")],
    ]);
    await withScopedConfigDir(async () => {
      const orch = new Orchestrator({ registry, reviewers: [] });
      await expect(
        orch.run({
          repoRoot: repo,
          prompt: "x",
          mode: "agent",
          harnesses: ["codex", "claude"],
          model: "model-x",
          n: 2,
        }),
      ).rejects.toThrow(/scalar model .* ambiguous without a primary harness/);
    });
  });

  it("auto-protects test and package surfaces when deterministic gates are configured", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      tests: [shellGate("node --test test/*.test.js")],
    });
    const taskYaml = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
    expect(taskYaml).toContain("auto_protected_paths");
    expect(taskYaml).toContain("package.json");
    expect(taskYaml).toContain("test/**");
    expect(taskYaml).toContain("test/*.test.js");
  });

  it("emits a deterministic BLOCK when a candidate edits a protected gate path", async () => {
    const repo = await initRepo();
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }, null, 2),
    );
    await runCapture("git", ["-C", repo, "add", "package.json"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add package",
    ]);
    const adapter: HarnessAdapter = {
      ...diffImplementer("tamper-impl"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "tamper-model" };
        writeFileSync(
          join(spec.cwd, "package.json"),
          JSON.stringify({ scripts: { test: "true" } }, null, 2),
        );
        yield { type: "message", session_id: spec.session_id, ts, text: "changed package script" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "fix implementation only",
      mode: "agent",
      harnesses: [adapter.id],
      tests: [shellGate("true")],
      n: 1,
    });
    expect(res.status).toBe("blocked");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).toContain("level: critical");
    expect(review).toContain("candidate changed protected path");
    expect(review).toContain("severity: BLOCK");
  });

  it("allows explicitly approved existing protected gate path changes", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, "test"), { recursive: true });
    writeFileSync(
      join(repo, "test", "math.test.js"),
      "import test from 'node:test';\ntest('old', () => {});\n",
    );
    await runCapture("git", ["-C", repo, "add", "test/math.test.js"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add test",
    ]);
    const adapter: HarnessAdapter = {
      ...diffImplementer("approved-test-edit-impl"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "approved-test-edit-model",
        };
        writeFileSync(
          join(spec.cwd, "test", "math.test.js"),
          "import test from 'node:test';\ntest('updated', () => {});\n",
        );
        yield { type: "message", session_id: spec.session_id, ts, text: "updated test" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "update the tests",
      mode: "agent",
      harnesses: [adapter.id],
      tests: [shellGate("true")],
      protectedPathApprovals: [{ path: "test/**", reason: "test authoring requested" }],
      n: 1,
    });
    expect(res.status).not.toBe("blocked");
    const taskYaml = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
    expect(taskYaml).toContain("protected_path_approvals");
    expect(taskYaml).toContain("test/**");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).not.toContain("candidate changed protected gate/test path");
  });

  it("does not let protected path approval bypass built-in human paths", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: release\n");
    await runCapture("git", ["-C", repo, "add", ".github/workflows/release.yml"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add workflow",
    ]);
    const adapter: HarnessAdapter = {
      ...diffImplementer("approved-critical-edit-impl"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "approved-critical-edit-model",
        };
        writeFileSync(
          join(spec.cwd, ".github", "workflows", "release.yml"),
          "name: release\non: push\n",
        );
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: "updated release workflow",
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "update workflow",
      mode: "agent",
      harnesses: [adapter.id],
      tests: [shellGate("true")],
      protectedPathApprovals: [
        { path: ".github/workflows/**", reason: "operator approved test path changes" },
      ],
      n: 1,
    });
    expect(res.status).toBe("blocked");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).toContain("protected-path change requires human approval");
    expect(review).toContain(".github/workflows/release.yml");
  });

  it("uses frozen SpecPack protected paths when calculating critical review depth", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, "guarded"), { recursive: true });
    writeFileSync(join(repo, "guarded", "rules.txt"), "locked\n");
    await runCapture("git", ["-C", repo, "add", "guarded/rules.txt"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add guarded file",
    ]);
    const specPath = join(repo, "spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        schema_version: 2,
        id: "spec-protected-depth",
        version: 1,
        created_at: new Date().toISOString(),
        intent: { raw: "modify guarded file" },
        summary: "guarded path work",
        success_criteria: [],
        non_goals: [],
        forbidden_approaches: [],
        decided_tradeoffs: [],
        constraints: { protected_paths: ["guarded/**"] },
        tests: [],
        tasks: [],
        open_questions: [],
        frozen: true,
      }),
    );
    let seenPrompt = "";
    const adapter: HarnessAdapter = {
      ...diffImplementer("protected-depth-impl"),
      async *run(spec) {
        seenPrompt = spec.prompt;
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "protected-depth-model",
        };
        writeFileSync(join(spec.cwd, "guarded", "rules.txt"), "changed\n");
        yield { type: "message", session_id: spec.session_id, ts, text: "changed guarded file" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "modify guarded file",
      mode: "agent",
      harnesses: [adapter.id],
      specPath,
      protectedPathApprovals: [{ path: "guarded/**", reason: "must not suppress spec path" }],
      n: 1,
    });

    expect(res.status).toBe("blocked");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).toContain("level: critical");
    expect(review).toContain("critical-risk diff requires human approval: protected-path change");
    expect(review).toContain("guarded/rules.txt");
    expect(seenPrompt).toContain("spec/config protected paths");
    expect(seenPrompt).toContain("guarded/**");
    expect(seenPrompt).not.toContain("Approved protected gate/test path changes");
    expect(seenPrompt).not.toContain("Approved auto-protected gate/test path changes");
  });

  it("blocks renaming a built-in human path out of the protected glob", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: release\n");
    await runCapture("git", ["-C", repo, "add", ".github/workflows/release.yml"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add workflow",
    ]);
    const adapter: HarnessAdapter = {
      ...diffImplementer("rename-critical-edit-impl"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "rename-critical-edit-model",
        };
        mkdirSync(join(spec.cwd, "scripts"), { recursive: true });
        await runCapture("git", [
          "-C",
          spec.cwd,
          "mv",
          ".github/workflows/release.yml",
          "scripts/release.yml",
        ]);
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: "moved release workflow",
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "move workflow",
      mode: "agent",
      harnesses: [adapter.id],
      tests: [shellGate("true")],
      n: 1,
    });
    expect(res.status).toBe("blocked");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).toContain("protected-path change requires human approval");
    expect(review).toContain(".github/workflows/release.yml");
  });

  it("does not treat newly-created package/test files as protected-path tamper", async () => {
    const repo = await initRepo();
    const adapter: HarnessAdapter = {
      ...diffImplementer("create-test-impl"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "create-test-model",
        };
        mkdirSync(join(spec.cwd, "test"), { recursive: true });
        writeFileSync(
          join(spec.cwd, "package.json"),
          JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2),
        );
        writeFileSync(
          join(spec.cwd, "test", "hello.test.js"),
          "import test from 'node:test';\ntest('ok', () => {});\n",
        );
        yield { type: "message", session_id: spec.session_id, ts, text: "created test scaffold" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "create test scaffold",
      mode: "agent",
      harnesses: [adapter.id],
      tests: [shellGate("true")],
      n: 1,
    });
    expect(res.status).not.toBe("blocked");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).not.toContain("candidate changed protected gate/test path");
  });

  it("blocks renaming an existing protected gate path out of the protected glob", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, "test"), { recursive: true });
    writeFileSync(
      join(repo, "test", "math.test.js"),
      "import test from 'node:test';\ntest('ok', () => {});\n",
    );
    await runCapture("git", ["-C", repo, "add", "test/math.test.js"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add test",
    ]);
    const adapter: HarnessAdapter = {
      ...diffImplementer("rename-test-impl"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "rename-test-model",
        };
        mkdirSync(join(spec.cwd, "src"), { recursive: true });
        await runCapture("git", ["-C", spec.cwd, "mv", "test/math.test.js", "src/math-check.js"]);
        yield { type: "message", session_id: spec.session_id, ts, text: "renamed test" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do not edit tests",
      mode: "agent",
      harnesses: [adapter.id],
      tests: [shellGate("true")],
      n: 1,
    });
    expect(res.status).toBe("blocked");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).toContain("test/math.test.js");
    expect(review).toContain("severity: BLOCK");
  });

  it("resolves a frozen SpecPack: provenance AND content (criteria/non-goals/task graph) reach the contract", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    writeFileSync(
      join(repo, ".claudexor", "config.yaml"),
      'tests:\n  commands:\n    - program: node\n      args: ["-e", "console.log(\\"project gate\\")"]\n      envAllowlist: []\n',
    );
    const specPath = join(repo, "spec.json");
    const specGate = "node -e \"console.log('spec gate')\"";
    const explicitGate = "node -e \"console.log('explicit gate')\"";
    writeFileSync(
      specPath,
      JSON.stringify({
        schema_version: 2,
        id: "spec-123",
        version: 1,
        created_at: new Date().toISOString(),
        intent: { raw: "implement the widget" },
        summary: "widget work",
        success_criteria: [{ id: "AC-1", behavior: "widget renders", required: true }],
        non_goals: ["no redesign"],
        forbidden_approaches: ["no global state"],
        decided_tradeoffs: [],
        constraints: { protected_paths: [] },
        tests: [frozenShellGate("spec-gate", specGate)],
        tasks: [
          { id: "t1", title: "scaffold", depends_on: [] },
          { id: "t2", title: "wire", depends_on: ["t1"] },
        ],
        open_questions: [],
        frozen: true,
      }),
    );
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    // The tamper fence verifies the recorded hash — use the REAL one
    // (parse-normalized, matching both producers).
    const { hashJson } = await import("@claudexor/util");
    const { SpecPack } = await import("@claudexor/schema");
    const realHash = hashJson(SpecPack.parse(JSON.parse(readFileSync(specPath, "utf8"))));
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      specId: "spec-123",
      specHash: realHash,
      specPath,
      tests: [shellGate(specGate), shellGate(explicitGate)],
    });
    const taskYaml = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
    expect(taskYaml).toContain("id: spec-123");
    expect(taskYaml).toContain(`hash: ${realHash}`);
    // Spec CONTENT now reaches the contract (the previously-dead pipeline):
    expect(taskYaml).toContain("widget renders");
    expect(taskYaml).toContain("no redesign");
    expect(taskYaml).toContain("no global state");
    // ...including the topologically-ordered task graph.
    expect(taskYaml).toContain("task_graph");
    expect(taskYaml.indexOf("t1")).toBeGreaterThan(-1);
    expect(taskYaml).toContain(specGate);
    expect(taskYaml).toContain(explicitGate);
    expect(taskYaml).toContain("project gate");
    expect(taskYaml.match(/spec gate/g)?.length).toBe(1);
    expect(taskYaml.indexOf(specGate)).toBeLessThan(taskYaml.indexOf(explicitGate));
    expect(taskYaml.indexOf(explicitGate)).toBeLessThan(taskYaml.indexOf("project gate"));
  });

  it("does not let a frozen SpecPack self-authorize protected path edits", async () => {
    const repo = await initRepo();
    const specPath = join(repo, "spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        schema_version: 2,
        id: "spec-approval",
        version: 1,
        created_at: new Date().toISOString(),
        intent: { raw: "update tests" },
        constraints: {
          protected_paths: ["test/**"],
          protected_path_approvals: [{ path: "test/**", reason: "self-authorized by frozen spec" }],
        },
        open_questions: [],
        frozen: true,
      }),
    );
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });

    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-success"],
        specPath,
      }),
    ).rejects.toThrow(/failed to resolve frozen SpecPack/);
  });

  it("fails loudly when the spec path cannot be resolved (no silent unspecced contract)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-success"],
        specPath: join(repo, "missing-spec.json"),
      }),
    ).rejects.toThrow(/failed to resolve frozen SpecPack/);
  });

  it("rejects a primary harness outside the selected eligible pool", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["codex", realLikeAdapter("codex", "openai")],
      ["claude", realLikeAdapter("claude", "anthropic")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["codex"],
        primaryHarness: "claude",
      }),
    ).rejects.toThrow(/primary harness 'claude'/);
  });

  it("does not persist secret-like tokens from generated patch diffs", async () => {
    const repo = await initRepo();
    const secret = "sk-" + "a".repeat(24);
    const adapter: HarnessAdapter = {
      id: "leaky",
      async discover() {
        return HarnessManifest.parse({
          id: "leaky",
          display_name: "leaky",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "leaky",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        writeFileSync(join(spec.cwd, ".env"), `OPENAI_API_KEY=${secret}\n`);
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const orch = new Orchestrator({ registry: new Map([["leaky", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["leaky"],
      n: 1,
    });
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
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["raw-ish"],
      n: 1,
    });
    expect(res.status).toBe("failed");
    expect(res.summary).toMatch(/perform 'implement'/);
    expect(readFileSync(join(res.runDir, "context", "context_error.md"), "utf8")).toMatch(
      /perform 'implement'/,
    );
  });

  it("records an ask routing failure as inspectable artifacts instead of crashing the run", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["raw-ish", noImplementAdapter("raw-ish")]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "2+2?",
      mode: "ask",
      harnesses: ["raw-ish"],
    });
    expect(res.status).toBe("failed");
    expect(res.summary).toMatch(/perform 'explain'/);
    expect(existsSync(join(res.runDir, "context", "context_error.md"))).toBe(true);
    expect(readFileSync(join(res.runDir, "final", "summary.md"), "utf8")).toContain(
      "Status: failed",
    );
  });

  it("forwards attachments into read-only ask harness specs", async () => {
    const repo = await initRepo();
    const note = join(repo, "note.txt");
    writeFileSync(note, "hello\n");
    const attachment = {
      id: "att-1",
      kind: "file" as const,
      mime: "text/plain",
      name: "note.txt",
      path: note,
    };
    let observedAttachments: unknown;
    const adapter: HarnessAdapter = {
      id: "asker",
      async discover() {
        return HarnessManifest.parse({
          id: "asker",
          display_name: "asker",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { read_files: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "asker",
          status: "ok",
          enabled_intents: ["explain"],
        });
      },
      async *run(spec) {
        observedAttachments = spec.attachments;
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield { type: "message", session_id: spec.session_id, ts, text: "saw the note" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["asker", adapter]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "Read this attachment",
      mode: "ask",
      harnesses: ["asker"],
      attachments: [attachment],
    });
    expect(res.status).toBe("success");
    expect(observedAttachments).toEqual([attachment]);
  });

  it("vision gate (INV-065): a blind harness is refused for an image run when explicit, dropped from auto-pools", async () => {
    const repo = await initRepo();
    const image = join(repo, "shot.png");
    writeFileSync(image, "png-bytes\n");
    const attachment = {
      id: "att-img",
      kind: "image" as const,
      mime: "image/png",
      name: "shot.png",
      path: image,
    };
    const mk = (id: string, imageInput: "none" | "file_path"): HarnessAdapter => ({
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: id === "blind" ? "openai" : "anthropic",
          capabilities: { read_files: true },
          capability_profile: { image_input: imageInput },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["explain"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield { type: "message", session_id: spec.session_id, ts, text: `answered by ${id}` };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    });
    const registry = new Map<string, HarnessAdapter>([
      ["blind", mk("blind", "none")],
      ["sighted", mk("sighted", "file_path")],
    ]);
    // EXPLICIT pool naming a blind harness: loud typed refusal naming the gap.
    const explicit = await new Orchestrator({ registry, reviewers: [] }).run({
      repoRoot: repo,
      prompt: "what is in this image?",
      mode: "ask",
      harnesses: ["blind"],
      attachments: [attachment],
    });
    expect(explicit.status).toBe("failed");
    expect(explicit.summary).toMatch(/cannot accept image attachments|image_input=none/);
    // AUTO pool: the blind harness is silently-but-honestly DROPPED; the
    // sighted one carries the run.
    const auto = await new Orchestrator({ registry, reviewers: [] }).run({
      repoRoot: repo,
      prompt: "what is in this image?",
      mode: "ask",
      attachments: [attachment],
    });
    expect(auto.status).toBe("success");
    expect(auto.summary).toContain("answered by sighted");
  });

  it("blocks ask success when an attempted WebSearch tool_result errors without recovery", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("web-bad", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield {
        type: "tool_call",
        session_id: sessionId,
        ts,
        text: "WebSearch",
        tool: {
          name: "WebSearch",
          kind: "web",
          use_id: "toolu_web",
          target: "current Node.js LTS version",
        },
      };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        text: "tool_result: error: permission denied",
        tool: {
          name: "WebSearch",
          kind: "web",
          use_id: "toolu_web",
          status: "error",
          error_summary: "permission denied",
        },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Memory answer only." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["web-bad", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "google this",
      mode: "ask",
      harnesses: ["web-bad"],
      web: "auto",
      n: 1,
    });
    expect(res.status).toBe("blocked");
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "web evidence unsatisfied",
    );
    expect(readFileSync(join(res.runDir, "final", "answer.md"), "utf8")).toContain(
      "Unverified partial output",
    );
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
      yield {
        type: "message",
        session_id: sessionId,
        ts,
        text: "Answer from memory, no web call made.",
      };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["no-web", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "google this",
      mode: "ask",
      harnesses: ["no-web"],
      web: "live",
      n: 1,
    });
    expect(res.status).toBe("blocked");
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "never attempted",
    );
  });

  it("does not block on a tool error that was later recovered by the same tool", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("recovers", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield {
        type: "tool_call",
        session_id: sessionId,
        ts,
        text: "Bash",
        tool: { name: "Bash", kind: "command", use_id: "t1", target: "pnpm test" },
      };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        tool: {
          name: "Bash",
          kind: "command",
          use_id: "t1",
          status: "error",
          error_summary: "2 tests failed",
        },
      };
      yield {
        type: "tool_call",
        session_id: sessionId,
        ts,
        text: "Bash",
        tool: { name: "Bash", kind: "command", use_id: "t2", target: "pnpm test" },
      };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        tool: {
          name: "Bash",
          kind: "command",
          use_id: "t2",
          status: "ok",
          content_summary: "all green",
        },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Recovered and finished." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["recovers", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do it",
      mode: "ask",
      harnesses: ["recovers"],
      n: 1,
    });
    expect(res.status).toBe("success");
    expect(readFileSync(join(res.runDir, "final", "answer.md"), "utf8")).toContain(
      "Recovered and finished.",
    );
  });

  it("keeps a readonly answer with an unrecovered non-web tool warning usable", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("warns", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield {
        type: "tool_call",
        session_id: sessionId,
        ts,
        text: "Bash",
        tool: { name: "Bash", kind: "command", use_id: "t1", target: "make it" },
      };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        tool: {
          name: "Bash",
          kind: "command",
          use_id: "t1",
          status: "error",
          error_summary: "command not found",
        },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Claimed done anyway." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["warns", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do it",
      mode: "ask",
      harnesses: ["warns"],
      n: 1,
    });
    expect(res.status).toBe("success");
    expect(readFileSync(join(res.runDir, "final", "answer.md"), "utf8")).toContain(
      "Claimed done anyway.",
    );
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("tool_warnings_total: 1");
    expect(telemetry).toContain("status: success_with_warnings");
  });

  it("budget-degraded race keeps envelope isolation + adoption (requested semantics stick)", async () => {
    const repo = await initRepo();
    // Cap sized so the wave guard denies the SECOND slot: requested
    // n=2, granted 1. The surviving candidate must still run in an isolated
    // envelope (never silently in-place) and its work be ADOPTED after.
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-degraded-race-"));
    writeFileSync(join(configDir, "config.yaml"), "budget:\n  estimate_usd_floor: 5\n");
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const orch = new Orchestrator({
        registry: new Map([
          ["a", diffImplementer("a", "local")],
          ["b", diffImplementer("b", "openai")],
        ]),
        reviewers: reviewers(),
      });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["a", "b"],
        n: 2,
        inPlace: true,
        maxUsd: 5, // floor 5: slot 1 holds nothing, slot 2's estimate (5) >= headroom (5) -> denied
      });
      expect(res.candidates.length).toBe(1); // wave guard trimmed the wave
      const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
      // The surviving slot ran ISOLATED: its work reached the live tree via
      // ADOPTION (work_product.adopted event), not direct in-place mutation.
      expect(events).toContain("work_product.adopted");
      expect(existsSync(join(repo, "CHANGED.txt"))).toBe(true);
      const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
      expect(wp).toContain("adopted: true");
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    }
  });

  it("FinalVerifier: a winner whose gates fail on a FRESH verify tree is blocked, not shipped", async () => {
    const repo = await initRepo();
    // fake-implement writes IMPLEMENTED.md into its worktree -> real patch.
    // The gate greps the file CONTENT on the verify tree: it passes only if
    // the patch actually applied there (proves the fresh-tree mechanics),
    // and we then flip expectations with an impossible gate.
    const orchGreen = new Orchestrator({
      registry: new Map([
        ["a", diffImplementer("a", "local")],
        ["b", diffImplementer("b", "openai")],
      ]),
      reviewers: reviewers(),
    });
    const green = await orchGreen.run({
      repoRoot: repo,
      prompt: "implement",
      mode: "agent",
      harnesses: ["a", "b"],
      n: 2,
      tests: [shellGate("test -f CHANGED.txt")],
    });
    expect(["success", "ungated"]).toContain(green.status);
    const greenDecision = readFileSync(join(green.runDir, "arbitration", "decision.yaml"), "utf8");
    expect(greenDecision).toContain("final_verify");
    expect(greenDecision).toContain("applied_cleanly: true");
    expect(greenDecision).toContain("gates_passed: true");

    // Direct verdict coverage on the same repo (private method, cast):
    const { finalVerifyPatch } = await import("@claudexor/delivery");
    const noopVerifyLog = { emit: () => undefined };
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const goodPatch = [
      "diff --git a/v.txt b/v.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/v.txt",
      "@@ -0,0 +1 @@",
      "+verified",
      "",
    ].join("\n");
    const failingGates = [{ id: "g1", ...shellGate("exit 3"), required: true }];
    const gatesFail = await finalVerifyPatch(
      repo,
      { baseSha, diff: goodPatch },
      failingGates,
      noopVerifyLog,
    );
    expect(gatesFail).toMatchObject({
      attempted: true,
      applied_cleanly: true,
      gates_passed: false,
    });
    // A patch built against content the base never had -> apply refusal.
    const conflictPatch = [
      "diff --git a/math.js b/math.js",
      "index 000..111 100644",
      "--- a/math.js",
      "+++ b/math.js",
      "@@ -1 +1 @@",
      "-CONTENT THE BASE NEVER HAD",
      "+patched",
      "",
    ].join("\n");
    const conflict = await finalVerifyPatch(
      repo,
      { baseSha, diff: conflictPatch },
      failingGates,
      noopVerifyLog,
    );
    expect(conflict.attempted).toBe(true);
    expect(conflict.applied_cleanly).toBe(false);
    // No base sha at the HELPER level FAILS CLOSED (the in-place exemption
    // is a caller decision): an envelope patch without a recorded base
    // cannot be proven and must block, never silently bypass INV-115.
    const noBase = await finalVerifyPatch(repo, { diff: goodPatch }, failingGates, noopVerifyLog);
    expect(noBase.attempted).toBe(true);
    expect(noBase.applied_cleanly).toBeNull();
    const { finalVerifyBlocks } = await import("@claudexor/delivery");
    expect(finalVerifyBlocks(noBase)).toBe(true);
  });

  it("spec tamper fence: a frozen spec modified after freeze refuses the run loudly (INV-081)", async () => {
    const repo = await initRepo();
    const spec = {
      schema_version: 2,
      id: "spec-tamper",
      created_at: new Date().toISOString(),
      version: 1,
      frozen: true,
      intent: { raw: "do the thing" },
      summary: "frozen contract",
    };
    const { hashJson } = await import("@claudexor/util");
    const specPath = join(repo, "spec.json");
    writeFileSync(specPath, JSON.stringify(spec));
    // Parse-normalized hash (defaults applied) — matching both producers.
    const { SpecPack } = await import("@claudexor/schema");
    const goodHash = hashJson(SpecPack.parse(JSON.parse(readFileSync(specPath, "utf8"))));
    const orch = new Orchestrator({
      registry: new Map([["fake-impl", diffImplementer("fake-impl")]]),
      reviewers: [],
    });
    // Tamper AFTER freeze: success criteria silently rewritten.
    writeFileSync(specPath, JSON.stringify({ ...spec, summary: "TAMPERED contract" }));
    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "implement",
        mode: "agent",
        harnesses: ["fake-impl"],
        n: 1,
        specPath,
        specHash: goodHash,
        specId: "spec-tamper",
      }),
    ).rejects.toThrow(/SpecPack hash mismatch/);
    // The recorded hash still accepts the UNMODIFIED spec.
    writeFileSync(specPath, JSON.stringify(spec));
    const ok = await orch.run({
      repoRoot: repo,
      prompt: "implement",
      mode: "agent",
      harnesses: ["fake-impl"],
      n: 1,
      specPath,
      specHash: goodHash,
      specId: "spec-tamper",
    });
    expect(ok.status).not.toBe("failed");
  });

  it("inactivity watchdog: a wedged harness stream ends as a typed failure, never a forever-running run (INV-116)", async () => {
    const repo = await initRepo();
    // One event, then silence with no exit: only the abort the watchdog
    // fires can end this stream (mirrors a wedged vendor CLI).
    const hangingAdapter: HarnessAdapter = {
      ...askAdapter("wedged", function* () {
        /* unused */
      }),
      async *run(spec) {
        yield { type: "started", session_id: spec.session_id, ts: new Date().toISOString() };
        const abort = spec.extra?.["abortSignal"] as AbortSignal | undefined;
        await new Promise<void>((resolve) => {
          if (abort?.aborted) return resolve();
          abort?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const prev = process.env["CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS"];
    process.env["CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS"] = "400";
    try {
      const orch = new Orchestrator({
        registry: new Map([["wedged", hangingAdapter]]),
        reviewers: [],
      });
      const started = Date.now();
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "ask",
        harnesses: ["wedged"],
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(res.status).toBe("failed");
      expect(res.summary).toContain("inactivity watchdog");
      const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
      expect(events).toContain('"run.failed"');
    } finally {
      if (prev === undefined) delete process.env["CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS"];
      else process.env["CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS"] = prev;
    }
  });

  it("terminal net: a throw escaping an ANNOUNCED strategy still ends the run with failure.yaml + run.failed", async () => {
    const repo = await initRepo();
    const { guardAnnouncedRun } = await import("./runTerminals.js");
    const guard = guardAnnouncedRun as unknown as (
      signal: AbortSignal | undefined,
      body: (announce: (a: unknown) => void) => Promise<unknown>,
    ) => Promise<{ status: string; summary: string; runDir: string }>;
    const { ArtifactStore } = await import("@claudexor/artifact-store");
    const { EventLog } = await import("@claudexor/event-log");

    // Pre-announce throws keep the loud-request contract (no run dir → rethrow).
    await expect(
      guard(undefined, async () => {
        throw new Error("pre-announce boom");
      }),
    ).rejects.toThrow("pre-announce boom");

    // Post-announce throws stamp terminal artifacts instead of orphaning the run.
    const store = new ArtifactStore(repo);
    const runId = "run-netted";
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, "task-netted");
    const res = await guard(undefined, async (announce) => {
      log.emit("run.created", { mode: "agent", prompt: "x" });
      announce({ log, store, paths, runId, taskId: "task-netted", mode: "agent", phase: "race" });
      throw new Error("escaped mid-strategy");
    });
    expect(res.status).toBe("failed");
    expect(res.summary).toContain("escaped mid-strategy");
    const events = readFileSync(paths.eventsPath, "utf8");
    expect(events).toContain("run.failed");
    expect(readFileSync(join(paths.root, "final", "failure.yaml"), "utf8")).toContain(
      "escaped mid-strategy",
    );

    // An abort mid-strategy is a CANCELLED terminal, not an internal failure.
    const ctrl = new AbortController();
    ctrl.abort();
    const paths2 = store.createRun("run-net-cancel");
    const log2 = new EventLog(paths2.eventsPath, "run-net-cancel", "task-nc");
    const res2 = await guard(ctrl.signal, async (announce) => {
      log2.emit("run.created", { mode: "agent", prompt: "x" });
      announce({
        log: log2,
        store,
        paths: paths2,
        runId: "run-net-cancel",
        taskId: "task-nc",
        mode: "agent",
        phase: "race",
      });
      throw new Error("abort surfaced as throw");
    });
    expect(res2.status).toBe("cancelled");
    expect(readFileSync(paths2.eventsPath, "utf8")).toContain('"status":"cancelled"');
  });

  it("discloses a requested effort on a harness with no declared ladder via ignored_settings (INV-105)", async () => {
    const repo = await initRepo();
    // realLikeAdapter declares NO effort_levels — a configured per-harness
    // effort must be DISCLOSED as ignored on harness.started, never silently
    // dropped (and never forwarded to a CLI that has no such flag).
    const registry = new Map<string, HarnessAdapter>([
      ["codex", realLikeAdapter("codex", "openai")],
    ]);
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-effort-disclosure-"));
    writeFileSync(join(configDir, "config.yaml"), "harnesses:\n  codex:\n    effort: high\n");
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const orch = new Orchestrator({ registry, reviewers: [] });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["codex"],
        n: 1,
      });
      const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
      expect(events).toContain("ignored_settings");
      expect(events).toContain("effort=high");
      expect(events).toContain("effort_levels is empty");
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    }
  });

  it("lifts readiness-preferred auth route disclosures into typed run events", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("authy", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield {
        type: "message",
        session_id: sessionId,
        ts,
        text: "[auth] auto selected api_key route because doctor smoke-proved it",
        payload: {
          auth_switched: true,
          from_auth_mode: "local_session",
          to_auth_mode: "api_key",
          reason: "readiness_preferred",
        },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Answered." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["authy", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do it",
      mode: "ask",
      harnesses: ["authy"],
      n: 1,
    });
    expect(res.status).toBe("success");
    const eventLog = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(eventLog).toContain("route.fallback.auth_switched");
    expect(eventLog).toContain("readiness_preferred");
    expect(eventLog).toContain('"from_auth_mode":"local_session"');
    expect(eventLog).toContain('"to_auth_mode":"api_key"');
    const answer = readFileSync(join(res.runDir, "final", "answer.md"), "utf8");
    expect(answer).toContain("Answered.");
    expect(answer).not.toContain("[auth]");
  });

  it("falls back to another ask harness when web evidence is unsatisfied", async () => {
    const repo = await initRepo();
    const bad = askAdapter("web-bad", function* (sessionId) {
      const ts = new Date().toISOString();
      yield {
        type: "tool_call",
        session_id: sessionId,
        ts,
        text: "WebSearch",
        tool: {
          name: "WebSearch",
          kind: "web",
          use_id: "toolu_web",
          target: "current Node.js LTS version",
        },
      };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        tool: {
          name: "WebSearch",
          kind: "web",
          use_id: "toolu_web",
          status: "error",
          error_summary: "permission denied",
        },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Memory answer only." };
    });
    const good = askAdapter(
      "web-good",
      function* (sessionId) {
        const ts = new Date().toISOString();
        yield {
          type: "tool_call",
          session_id: sessionId,
          ts,
          text: "WebSearch",
          tool: {
            name: "WebSearch",
            kind: "web",
            use_id: "toolu_web2",
            target: "current Node.js LTS version",
          },
        };
        yield {
          type: "tool_result",
          session_id: sessionId,
          ts,
          tool: {
            name: "WebSearch",
            kind: "web",
            use_id: "toolu_web2",
            status: "ok",
            content_summary: "search result",
          },
        };
        yield { type: "message", session_id: sessionId, ts, text: "Web-backed answer." };
      },
      "anthropic",
    );
    const orch = new Orchestrator({
      registry: new Map([
        ["web-bad", bad],
        ["web-good", good],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "google this",
      mode: "ask",
      harnesses: ["web-bad", "web-good"],
      web: "auto",
    });
    expect(res.status).toBe("success");
    expect(readFileSync(join(res.runDir, "final", "answer.md"), "utf8")).toContain(
      "Web-backed answer.",
    );
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
      const registry = new Map<string, HarnessAdapter>([
        ["fake-success", createFakeHarness("fake-success")],
      ]);
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
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        contextMode: "off",
        harnesses: ["fake-success"],
      }),
    ).rejects.toThrow("contextMode 'off' is only supported for Ask without a repoRoot");
  });

  it("runs explore as a bounded read-only swarm with synthesis and per-explorer artifacts", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map auth and run storage",
      mode: "audit",
      swarm: true,
      harnesses: ["fake-success"],
      n: 2,
    });
    expect(res.status).toBe("success");
    expect(res.candidates).toHaveLength(2);
    expect(existsSync(join(res.runDir, "findings", "a01.md"))).toBe(true);
    expect(existsSync(join(res.runDir, "findings", "a02.md"))).toBe(true);
    expect(readFileSync(join(res.runDir, "final", "explore.md"), "utf8")).toContain(
      "Explorers succeeded: 2/2",
    );
    expect(existsSync(join(res.runDir, "final", "explore-findings.yaml"))).toBe(true);
    expect(existsSync(join(res.runDir, "final", "omissions.md"))).toBe(true);
  });

  it("keeps warning-bearing explorers in swarm synthesis when they produced a report", async () => {
    const repo = await initRepo();
    const warned = askAdapter("warned", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield {
        type: "tool_call",
        session_id: sessionId,
        ts,
        text: "Grep",
        tool: { name: "Grep", kind: "search", use_id: "g1", target: "packages/*/package.json" },
      };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        tool: {
          name: "Grep",
          kind: "search",
          use_id: "g1",
          status: "error",
          error_summary: "bad glob",
        },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Useful repository analysis." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const clean = askAdapter(
      "clean",
      function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "Second useful analysis." };
        yield { type: "completed", session_id: sessionId, ts };
      },
      "anthropic",
    );
    const orch = new Orchestrator({
      registry: new Map([
        ["warned", warned],
        ["clean", clean],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map auth and run storage",
      mode: "audit",
      swarm: true,
      harnesses: ["warned", "clean"],
      n: 2,
    });
    expect(res.status).toBe("success");
    const explore = readFileSync(join(res.runDir, "final", "explore.md"), "utf8");
    expect(explore).toContain("Explorers succeeded: 2/2");
    expect(explore).toContain("Useful repository analysis.");
    expect(explore).toContain("Tool warnings");
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("tool_warnings_total: 1");
  });

  it("runs deterministic gates from the tests input (test-driven, not vacuous)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });

    // A failing gate must make the candidate red (gates are no longer vacuous).
    const failed = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      n: 1,
      tests: [shellGate("exit 1")],
    });
    expect(failed.candidates[0]?.status).toBe("red");

    // A passing gate keeps the candidate green.
    const passed = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      n: 1,
      tests: [shellGate("true")],
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
      async *run() {
        throw new Error("boom");
      },
    };
    const registry = new Map<string, HarnessAdapter>([["throwing", throwing]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["throwing"],
      n: 1,
    });
    expect(res.status).toBe("failed");
    expect(existsSync(join(res.runDir, "final", "failure.yaml"))).toBe(true);
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "attempts/a01/attempt.yaml",
    );
    expect(existsSync(join(repo, ".claudexor", "workspaces", res.taskId, "a01"))).toBe(false);
  });

  it("applies a per-family reviewer model override (cheaper reviewer)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-impl", diffImplementer("fake-impl")],
      ["rev-openai", realLikeAdapter("rev-openai", "openai")],
      ["rev-anthropic", realLikeAdapter("rev-anthropic", "anthropic")],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewerModels: { openai: "o-cheap-model", anthropic: "a-cheap-model" },
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-impl"],
      n: 1,
    });
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
            capabilities: {
              review: true,
              effort_levels: family === "anthropic" ? ["max"] : [],
            },
            access_profiles_supported: ["readonly"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: id,
            status: "ok",
            enabled_intents: ["review"],
          });
        },
        async models() {
          const ids =
            family === "anthropic"
              ? ["claude-opus-4-8", "opus"]
              : ["gemini-3.1-pro", "gemini-3.5-flash", "gpt-5.5-xhigh-1M", "o-review"];
          return ids.map((modelId) => ({ id: modelId, label: null, context_window: null }));
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          seen.push({ id, model: spec.model_hint, effort: spec.effort_hint });
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            observed_model: `${id}-observed`,
          };
          yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        },
      };
    }
    const registry = new Map<string, HarnessAdapter>([
      ["fake-impl", diffImplementer("fake-impl")],
      ["rev-openai", reviewer("rev-openai", "openai")],
      ["rev-anthropic", reviewer("rev-anthropic", "anthropic")],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewerModels: { openai: "o-review", anthropic: "opus" },
      reviewerEfforts: { anthropic: "max" },
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-impl"],
      n: 1,
    });
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

  it("honors an explicit reviewer panel with repeated same-harness model entries", async () => {
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
            capabilities: {
              review: true,
              effort_levels: family === "anthropic" ? ["max"] : [],
            },
            access_profiles_supported: ["readonly"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: id,
            status: "ok",
            enabled_intents: ["review"],
          });
        },
        async models() {
          const ids =
            family === "anthropic"
              ? ["claude-opus-4-8"]
              : ["gemini-3.1-pro", "gemini-3.5-flash", "gpt-5.5-xhigh-1M"];
          return ids.map((modelId) => ({ id: modelId, label: null, context_window: null }));
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          seen.push({ id, model: spec.model_hint, effort: spec.effort_hint });
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            observed_model: spec.model_hint ?? `${id}-observed`,
          };
          yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
    }
    const registry = new Map<string, HarnessAdapter>([
      ["fake-impl", diffImplementer("fake-impl")],
      ["rev-claude", reviewer("rev-claude", "anthropic")],
      ["rev-cursor", reviewer("rev-cursor", "cursor")],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewerPanel: [
        { harness: "rev-claude", model: "claude-opus-4-8", effort: "max" },
        { harness: "rev-cursor", model: "gemini-3.1-pro" },
        { harness: "rev-cursor", model: "gemini-3.5-flash" },
        { harness: "rev-cursor", model: "gpt-5.5-xhigh-1M" },
      ],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-impl"],
      n: 1,
    });
    expect(res.status).toBe("success");
    expect(seen).toHaveLength(4);
    expect(seen).toEqual(
      expect.arrayContaining([
        { id: "rev-claude", model: "claude-opus-4-8", effort: "max" },
        { id: "rev-cursor", model: "gemini-3.1-pro", effort: null },
        { id: "rev-cursor", model: "gemini-3.5-flash", effort: null },
        { id: "rev-cursor", model: "gpt-5.5-xhigh-1M", effort: null },
      ]),
    );
    const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(reviewYaml).toContain("reviewer_requests:");
    expect(reviewYaml).toContain("claude-opus-4-8");
    expect(reviewYaml).toContain("gemini-3.1-pro");
    expect(reviewYaml).toContain("gemini-3.5-flash");
    expect(reviewYaml).toContain("gpt-5.5-xhigh-1M");
  });

  it("rejects explicit reviewer panel effort hints unsupported by the harness", async () => {
    const repo = await initRepo();
    const reviewer: HarnessAdapter = {
      id: "rev-cursor",
      async discover() {
        return HarnessManifest.parse({
          id: "rev-cursor",
          display_name: "rev cursor",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true, effort_levels: [] },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "rev-cursor",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async models() {
        return [{ id: "gemini-3.1-pro", label: null, context_window: null }];
      },
      async *run() {
        throw new Error("reviewer should not run when effort validation fails");
      },
    };
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev-cursor", reviewer],
      ]),
      reviewerPanel: [{ harness: "rev-cursor", model: "gemini-3.1-pro", effort: "max" }],
    });

    const effortRes = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-impl"],
      n: 1,
    });
    expect(effortRes.status).toBe("failed");
    expect(effortRes.summary).toContain(
      "reviewer harness 'rev-cursor' does not support requested effort 'max' (harness declares no effort controls)",
    );
  });

  it("uses configured default model for harness-only explicit reviewer panel entries", async () => {
    const repo = await initRepo();
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-reviewer-panel-default-config-"));
    writeFileSync(
      join(configDir, "config.yaml"),
      "harnesses:\n  rev:\n    default_model: configured-review-model\n",
    );
    const seen: { model: string | null; effort: string | null }[] = [];
    const reviewer: HarnessAdapter = {
      id: "rev",
      async discover() {
        return HarnessManifest.parse({
          id: "rev",
          display_name: "rev",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "rev",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async models() {
        return [{ id: "configured-review-model", label: null, context_window: null }];
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        seen.push({ model: spec.model_hint, effort: spec.effort_hint });
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: spec.model_hint ?? "rev-observed",
        };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const registry = new Map<string, HarnessAdapter>([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer],
      ]);
      const orch = new Orchestrator({ registry, reviewerPanel: [{ harness: "rev" }] });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-impl"],
        n: 1,
      });
      expect(res.status).toBe("ungated");
      expect(seen).toEqual([{ model: "configured-review-model", effort: null }]);
      const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
      expect(reviewYaml).toContain("requested_model: configured-review-model");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("validates explicit reviewer models against the scoped per-run auth route", async () => {
    const repo = await initRepo();
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-reviewer-panel-config-"));
    writeFileSync(
      join(configDir, "config.yaml"),
      "harnesses:\n  rev:\n    auth_preference: subscription\n",
    );
    const modelSpecs: DoctorSpec[] = [];
    const doctorSpecs: DoctorSpec[] = [];
    const runSpecs: Array<{ auth: string; home: string | undefined }> = [];
    const reviewer: HarnessAdapter = {
      id: "rev",
      async discover() {
        return HarnessManifest.parse({
          id: "rev",
          display_name: "rev",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor(spec) {
        doctorSpecs.push(spec);
        return ConformanceReport.parse({
          harness_id: "rev",
          status: spec.env?.["HOME"] && spec.authPreference === "api_key" ? "ok" : "unavailable",
          enabled_intents:
            spec.env?.["HOME"] && spec.authPreference === "api_key" ? ["review"] : [],
        });
      },
      async models(spec) {
        modelSpecs.push(spec ?? { cwd: "" });
        return spec?.env?.["HOME"] && spec.authPreference === "api_key"
          ? [{ id: "scoped-api-model", label: null, context_window: null }]
          : [{ id: "native-model", label: null, context_window: null }];
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        runSpecs.push({ auth: spec.auth_preference, home: spec.env?.["HOME"] });
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: spec.model_hint ?? "rev-observed",
        };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const registry = new Map<string, HarnessAdapter>([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer],
      ]);
      const orch = new Orchestrator({
        registry,
        reviewerPanel: [{ harness: "rev", model: "scoped-api-model" }],
      });
      await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-impl"],
        authPreference: "api_key",
        n: 1,
      });
      const scopedDoctorSpec = doctorSpecs.find(
        (spec) => spec.authPreference === "api_key" && Boolean(spec.env?.["HOME"]),
      );
      expect(scopedDoctorSpec).toBeTruthy();
      expect(modelSpecs).toHaveLength(1);
      expect(modelSpecs[0]?.authPreference).toBe("api_key");
      expect(modelSpecs[0]?.env?.["HOME"]).toBeTruthy();
      expect(runSpecs).toHaveLength(1);
      expect(runSpecs[0]?.auth).toBe("api_key");
      expect(runSpecs[0]?.home).toBeTruthy();
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("selects automatic reviewers using scoped per-run auth readiness", async () => {
    const repo = await initRepo();
    const doctorSpecs: DoctorSpec[] = [];
    const runSpecs: Array<{ auth: string; home: string | undefined }> = [];
    const reviewer: HarnessAdapter = {
      id: "rev",
      async discover() {
        return HarnessManifest.parse({
          id: "rev",
          display_name: "rev",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor(spec) {
        doctorSpecs.push(spec);
        const scopedSubscription = spec.env?.["HOME"] && spec.authPreference === "subscription";
        return ConformanceReport.parse({
          harness_id: "rev",
          status: scopedSubscription ? "ok" : "unavailable",
          enabled_intents: scopedSubscription ? ["review"] : [],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        runSpecs.push({ auth: spec.auth_preference, home: spec.env?.["HOME"] });
        yield { type: "started", session_id: spec.session_id, ts };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([
      ["fake-impl", diffImplementer("fake-impl")],
      ["rev", reviewer],
    ]);
    const orch = new Orchestrator({ registry });

    await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-impl"],
      authPreference: "subscription",
      n: 1,
    });

    expect(doctorSpecs).toContainEqual(
      expect.objectContaining({
        authPreference: "subscription",
        env: expect.objectContaining({ HOME: expect.any(String) }),
      }),
    );
    expect(runSpecs).toEqual([{ auth: "subscription", home: expect.any(String) }]);
  });

  it("skips disabled automatic reviewers before doctor probes", async () => {
    const repo = await initRepo();
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-disabled-reviewer-config-"));
    writeFileSync(join(configDir, "config.yaml"), "harnesses:\n  rev:\n    enabled: false\n");
    let doctorCalls = 0;
    const reviewer: HarnessAdapter = {
      id: "rev",
      async discover() {
        return HarnessManifest.parse({
          id: "rev",
          display_name: "rev",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        doctorCalls += 1;
        return ConformanceReport.parse({
          harness_id: "rev",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run() {
        throw new Error("disabled reviewer should not run");
      },
    };
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const orch = new Orchestrator({
        registry: new Map([
          ["fake-impl", diffImplementer("fake-impl")],
          ["rev", reviewer],
        ]),
      });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-impl"],
        n: 1,
      });
      expect(["success", "ungated", "review_not_run"]).toContain(res.status);
      expect(doctorCalls).toBe(0);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("retries transient explicit reviewer model inventory failures before failing the panel", async () => {
    const repo = await initRepo();
    let modelCalls = 0;
    const modelCallTimes: number[] = [];
    const seenModels: Array<string | null> = [];
    const reviewer: HarnessAdapter = {
      id: "rev",
      async discover() {
        return HarnessManifest.parse({
          id: "rev",
          display_name: "rev",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "rev",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async models() {
        modelCalls += 1;
        modelCallTimes.push(Date.now());
        if (modelCalls === 1) throw new Error("transient inventory crash");
        return [{ id: "retry-model", label: null, context_window: null }];
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        seenModels.push(spec.model_hint ?? null);
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: spec.model_hint ?? "rev-observed",
        };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([
      ["fake-impl", diffImplementer("fake-impl")],
      ["rev", reviewer],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewerPanel: [{ harness: "rev", model: "retry-model" }],
    });

    await orch.run({ repoRoot: repo, prompt: "x", mode: "agent", harnesses: ["fake-impl"], n: 1 });

    expect(modelCalls).toBe(2);
    expect((modelCallTimes[1] ?? 0) - (modelCallTimes[0] ?? 0)).toBeGreaterThanOrEqual(200);
    expect(seenModels).toEqual(["retry-model"]);
  });

  it("retries empty explicit reviewer model inventories before failing the panel", async () => {
    const repo = await initRepo();
    let modelCalls = 0;
    const modelCallTimes: number[] = [];
    const reviewer: HarnessAdapter = {
      id: "rev",
      async discover() {
        return HarnessManifest.parse({
          id: "rev",
          display_name: "rev",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "rev",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async models() {
        modelCalls += 1;
        modelCallTimes.push(Date.now());
        return [];
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: spec.model_hint ?? "rev-observed",
        };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([
      ["fake-impl", diffImplementer("fake-impl")],
      ["rev", reviewer],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewerPanel: [{ harness: "rev", model: "retry-model" }],
    });

    const emptyRes = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-impl"],
      n: 1,
    });
    expect(emptyRes.status).toBe("failed");
    expect(emptyRes.summary).toMatch(
      /model inventory call failed after retry: model inventory was empty/,
    );
    expect(modelCalls).toBe(2);
    expect((modelCallTimes[1] ?? 0) - (modelCallTimes[0] ?? 0)).toBeGreaterThanOrEqual(200);
  });

  it("validates explicit reviewer panel entries and model evidence loudly", async () => {
    function reviewer(
      id: string,
      opts: {
        kind?: "local_cli" | "fake";
        status?: "ok" | "degraded" | "unavailable";
        enabledIntents?: string[];
        reviewCapability?: boolean;
        accessProfiles?: string[];
        discoverThrows?: boolean;
        models?: string[];
        modelsThrow?: boolean;
        omitModels?: boolean;
        knownModels?: string[];
      } = {},
    ): HarnessAdapter {
      const adapter: HarnessAdapter = {
        id,
        async discover() {
          if (opts.discoverThrows) throw new Error("missing reviewer");
          return HarnessManifest.parse({
            id,
            display_name: id,
            kind: opts.kind ?? "local_cli",
            provider_family: "cursor",
            capabilities: {
              review: opts.reviewCapability ?? true,
              known_models: opts.knownModels ?? [],
            },
            access_profiles_supported: opts.accessProfiles ?? ["readonly"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: id,
            status: opts.status ?? "ok",
            enabled_intents: opts.enabledIntents ?? ["review"],
            reasons: opts.status && opts.status !== "ok" ? ["doctor said no"] : [],
          });
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            observed_model: spec.model_hint ?? "ok",
          };
          yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
      if (!opts.omitModels) {
        adapter.models = async () => {
          if (opts.modelsThrow) throw new Error("inventory crashed");
          return (opts.models ?? []).map((id) => ({ id, label: null, context_window: null }));
        };
      }
      return adapter;
    }

    async function expectRejected(
      registry: Map<string, HarnessAdapter>,
      message: RegExp,
      configYaml = "",
      reviewerPanel: ControlReviewerPanelEntry[] = [{ harness: "rev" }],
    ): Promise<void> {
      const repo = await initRepo();
      const configDir = mkdtempSync(join(tmpdir(), "claudexor-reviewer-panel-config-"));
      if (configYaml) writeFileSync(join(configDir, "config.yaml"), configYaml);
      const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
      process.env.CLAUDEXOR_CONFIG_DIR = configDir;
      try {
        const orch = new Orchestrator({ registry, reviewerPanel });
        // A doomed panel ends the run as a TYPED failure WITH artifacts
        // (failure.yaml naming the refusal) — after run-dir creation, before
        // any candidate spends money. Never a bare pre-announce throw.
        const res = await orch.run({
          repoRoot: repo,
          prompt: "x",
          mode: "agent",
          harnesses: ["fake-impl"],
          n: 1,
        });
        expect(res.status).toBe("failed");
        expect(res.summary).toMatch(message);
        const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
        expect(failure).toContain("review_preflight");
      } finally {
        if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
        else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
      }
    }

    await expectRejected(
      new Map([["fake-impl", diffImplementer("fake-impl")]]),
      /unknown reviewer harness 'rev'/,
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { discoverThrows: true })],
      ]),
      /reviewer harness 'rev' is unavailable/,
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { kind: "fake" })],
      ]),
      /fake harness/,
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { status: "degraded" })],
      ]),
      /not doctor-ok: doctor said no/,
    );
    let disabledDoctorCalls = 0;
    const disabledReviewer = reviewer("rev");
    disabledReviewer.doctor = async () => {
      disabledDoctorCalls += 1;
      return ConformanceReport.parse({
        harness_id: "rev",
        status: "ok",
        enabled_intents: ["review"],
      });
    };
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", disabledReviewer],
      ]),
      /disabled in settings/,
      "harnesses:\n  rev:\n    enabled: false\n",
    );
    expect(disabledDoctorCalls).toBe(0);
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { enabledIntents: ["plan"] })],
      ]),
      /cannot perform readonly review/,
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { reviewCapability: false })],
      ]),
      /cannot perform readonly review/,
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { accessProfiles: ["workspace_write"] })],
      ]),
      /cannot perform readonly review/,
    );
    {
      const repo = await initRepo();
      const registry = new Map<string, HarnessAdapter>([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { omitModels: true, knownModels: ["manifest-model"] })],
      ]);
      const orch = new Orchestrator({
        registry,
        reviewerPanel: [{ harness: "rev", model: "manifest-model" }],
      });
      await expect(
        orch.run({ repoRoot: repo, prompt: "x", mode: "agent", harnesses: ["fake-impl"], n: 1 }),
      ).resolves.toMatchObject({ status: "ungated" });
    }
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { models: ["gpt-5.5-extra-high"] })],
      ]),
      /does not support requested model 'gpt-5.5-xhigh-1M'.*claudexor models --harness rev/,
      "",
      [{ harness: "rev", model: "gpt-5.5-xhigh-1M" }],
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { models: [] })],
      ]),
      /could not verify requested model 'gpt-5.5-xhigh-1M'.*model inventory call failed after retry: model inventory was empty.*claudexor models --harness rev/,
      "",
      [{ harness: "rev", model: "gpt-5.5-xhigh-1M" }],
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { modelsThrow: true })],
      ]),
      /could not verify requested model 'gpt-5.5-xhigh-1M'.*model inventory call failed after retry: inventory crashed.*claudexor models --harness rev/,
      "",
      [{ harness: "rev", model: "gpt-5.5-xhigh-1M" }],
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { omitModels: true })],
      ]),
      /refused requested model 'gpt-5.5-xhigh-1M'.*cannot verify models.*claudexor models --harness rev/,
      "",
      [{ harness: "rev", model: "gpt-5.5-xhigh-1M" }],
    );
    // STRICT: a manifest MISS is a typed refusal naming the truth source
    // (previously a warn-through for non-authoritative manifests).
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { omitModels: true, knownModels: ["manifest-model"] })],
      ]),
      /refused requested model 'ghost-model'.*manifest known-model list.*claudexor models --harness rev/,
      "",
      [{ harness: "rev", model: "ghost-model" }],
    );
  });

  it("persists convergence review artifacts with reviewer effort metadata", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
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
      mode: "agent",
      harnesses: ["fake-success"],
      attempts: 1,
      tests: [shellGate("true")],
    });
    const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(reviewYaml).toContain("reviewer_requests:");
    expect(reviewYaml).toContain("requested_effort: max");
    expect(reviewYaml).toContain("findings:");
    expect(reviewYaml).toContain("route_proofs:");
    const testsEvidence = readFileSync(
      join(res.runDir, "reviews", "a01-reviewers", "evidence", "TESTS.txt"),
      "utf8",
    );
    expect(testsEvidence).toContain("Gate results:");
    expect(testsEvidence).toContain("- gate-1: passed");
    expect(testsEvidence).toContain('command: ["sh","-c","true"]');
  });

  it("in-place agent turn runs in the LIVE tree and resumes the native session (v0.10 chat)", async () => {
    const repo = await initRepo();
    let sawResume: string | null | undefined;
    const impl: HarnessAdapter = {
      id: "impl",
      async discover() {
        return HarnessManifest.parse({
          id: "impl",
          display_name: "impl",
          kind: "local_cli",
          provider_family: "local",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "impl",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        sawResume = spec.resume_session_id; // in-place turns pass the native resume id
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "impl-model",
          payload: { native_session_id: "vendor-sess-9" },
        };
        writeFileSync(join(spec.cwd, "LIVE.txt"), "in place\n");
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const observed: Record<string, string> = {};
    const orch = new Orchestrator({ registry: new Map([["impl", impl]]), reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "edit it",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
      inPlace: true,
      threadId: "th-1",
      resumeSessions: { impl: "vendor-sess-prev" },
      onSessionObserved: (h, nid) => {
        observed[h] = nid;
      },
    });
    // The file landed in the LIVE project tree (no isolated worktree), and the
    // candidate ran in-place (spec.cwd === repo).
    expect(existsSync(join(repo, "LIVE.txt"))).toBe(true);
    // In-place turns RESUME the native session and RECORD the new one.
    expect(sawResume).toBe("vendor-sess-prev");
    expect(observed["impl"]).toBe("vendor-sess-9");
    expect(res.mode).toBe("agent");
  });

  it("race leaves an ungated winner as an artifact without mutating the live tree", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([
        ["a", diffImplementer("a", "local")],
        ["b", diffImplementer("b", "openai")],
      ]),
      reviewers: [cleanReviewer("rev-openai", "openai")],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["a", "b"],
      n: 2,
      inPlace: true,
    });
    expect(res.status).toBe("ungated");
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(false);
    const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    expect(wp).toContain("adopted: null");
  });

  it("race auto-adopts a verified successful winner into the live in-place tree", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([
        ["a", diffImplementer("a", "local")],
        ["b", diffImplementer("b", "openai")],
      ]),
      reviewers: reviewers(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["a", "b"],
      n: 2,
      inPlace: true,
      tests: [shellGate("true")],
    });
    expect(res.status).toBe("success");
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(true);
    const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    expect(wp).toContain("adopted: true");
  });

  it("plan mode writes an honest plan (no SpecPack) that surfaces review findings", async () => {
    const repo = await initRepo();
    // A reviewer that BLOCKs: the plan must still surface it, not hide it.
    const blocker: ReviewerSpec = {
      providerFamily: "anthropic",
      adapter: {
        id: "rev-block",
        async discover() {
          return HarnessManifest.parse({
            id: "rev-block",
            display_name: "rev-block",
            kind: "local_cli",
            provider_family: "anthropic",
            capabilities: { review: true },
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "rev-block",
            status: "ok",
            enabled_intents: ["review"],
          });
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            observed_model: "rev-block-model",
          };
          yield {
            type: "message",
            session_id: spec.session_id,
            ts,
            text:
              "```json\n" +
              JSON.stringify([
                {
                  severity: "BLOCK",
                  category: "deploy",
                  claim: "the requested feature is not delivered",
                  evidence: { files: [{ path: "DIFF.patch", lines: "1" }] },
                },
              ]) +
              "\n```",
          };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      },
    };
    const orch = new Orchestrator({
      registry: new Map([["fake-success", createFakeHarness("fake-success")]]),
      reviewers: [blocker],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "make a racing game",
      mode: "plan",
      harnesses: ["fake-success"],
    });
    expect(res.status).toBe("success");
    const plan = readFileSync(join(res.runDir, "final", "plan.md"), "utf8");
    expect(plan).toContain("# Plan");
    expect(plan).not.toContain("SpecPack");
    expect(plan).toContain("## Review findings");
    expect(plan).toContain("the requested feature is not delivered"); // BLOCK is visible, not hidden
    // Plan is a work product (report) with result_kind=plan: NO files changed.
    const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    expect(wp).toContain("result_kind: plan");
    expect(wp).toContain("blockers: 1");
    const summary = readFileSync(join(res.runDir, "final", "summary.md"), "utf8");
    expect(summary).toContain("- Review blockers: 1");
    const reviewYaml = readFileSync(join(res.runDir, "reviews", "plan-review.yaml"), "utf8");
    expect(reviewYaml).toContain("status: accepted");
    const reviewPlanEvidence = readFileSync(
      join(res.runDir, "review-evidence", "PLAN_ACCEPTED.md"),
      "utf8",
    );
    expect(reviewPlanEvidence).toContain("## Plan from fake-success");
    expect(reviewPlanEvidence).toContain("Implemented by the fake harness.");
    const reviewDiffEvidence = readFileSync(
      join(res.runDir, "review-evidence", "DIFF.patch"),
      "utf8",
    );
    expect(reviewDiffEvidence).toBe("(plan review — no code diff)\n");
    expect(reviewDiffEvidence).not.toContain("Implemented by the fake harness.");
  });

  it("validates explicit reviewer panel before starting plan harness work", async () => {
    const repo = await initRepo();
    let plannerStarted = false;
    let runStarted = false;
    const planner: HarnessAdapter = {
      id: "planner",
      async discover() {
        return HarnessManifest.parse({
          id: "planner",
          display_name: "planner",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { plan: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "planner",
          status: "ok",
          enabled_intents: ["plan"],
        });
      },
      async *run(spec) {
        plannerStarted = true;
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const orch = new Orchestrator({
      registry: new Map([["planner", planner]]),
      reviewerPanel: [{ harness: "missing-reviewer" }],
    });

    const planRes = await orch.run({
      repoRoot: repo,
      prompt: "plan",
      mode: "plan",
      harnesses: ["planner"],
      runId: "invalid-panel-plan",
      onRunStart: () => {
        runStarted = true;
      },
    });
    // The doomed panel ends the run with typed failure ARTIFACTS after the
    // run dir exists — but still BEFORE any planner harness work spawns.
    expect(planRes.status).toBe("failed");
    expect(planRes.summary).toMatch(/unknown reviewer harness 'missing-reviewer'/);
    expect(plannerStarted).toBe(false);
    expect(runStarted).toBe(true);
    const failure = readFileSync(join(planRes.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("review_preflight");
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
          capabilities: {
            implement: true,
            edit_files: true,
            review: true,
          },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "writer",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        writeFileSync(join(spec.cwd, "README.md"), "OK\n");
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "writer-model" };
        yield {
          type: "completed",
          session_id: spec.session_id,
          ts,
          observed_model: "writer-model",
        };
      },
    };
    function cwdAwareReviewer(id: string, family: ProviderFamily): ReviewerSpec {
      const adapter: HarnessAdapter = {
        id,
        async discover() {
          return HarnessManifest.parse({
            id,
            display_name: id,
            kind: "local_cli",
            provider_family: family,
            capabilities: { review: true },
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: id,
            status: "ok",
            enabled_intents: ["review"],
          });
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
          yield {
            type: "completed",
            session_id: spec.session_id,
            ts,
            observed_model: `${id}-model`,
          };
        },
      };
      return { adapter, providerFamily: family };
    }

    const registry = new Map<string, HarnessAdapter>([["writer", writer]]);
    const orch = new Orchestrator({
      registry,
      reviewers: [
        cwdAwareReviewer("rev-openai", "openai"),
        cwdAwareReviewer("rev-anthropic", "anthropic"),
      ],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "change README.md to OK",
      mode: "agent",
      harnesses: ["writer"],
      n: 1,
      tests: [shellGate("grep -qx OK README.md")],
    });
    expect(res.status).toBe("success");
    const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(reviewYaml).not.toContain("Reviewer did not see");
  });

  it("auto-resolves available real harnesses when --harness is omitted", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["realish", realLikeAdapter("realish")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "agent", n: 2 });
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
    expect(res.candidates.every((c) => c.harnessId === "realish")).toBe(true);
  });

  it("surfaces runId early and streams events via in-proc hooks (agent)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
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
    expect(eventLog).toContain('"type":"harness.event"');
    expect(eventLog).toContain('"harness_id":"fake-success"');
    expect(eventLog).toContain('"attempt_id":"a01"');
  });

  it("honors a pre-aborted signal (agent -> cancelled, no harness work forwarded)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
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
        return ConformanceReport.parse({
          harness_id: "silent-process",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        const signal = spec.extra["abortSignal"] as AbortSignal | undefined;
        const script = [
          "console.log('ready')",
          "process.on('SIGINT', () => {})",
          `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500)`,
          "setTimeout(() => {}, 5000)",
        ].join(";");
        for await (const ev of spawnProcess(process.execPath, ["-e", script], {
          abortSignal: signal,
          cancelKillDelayMs: 100,
        })) {
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
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
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
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
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
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const ac = new AbortController();
    ac.abort();
    const plan = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "plan",
      harnesses: ["fake-success"],
      signal: ac.signal,
    });
    expect(plan.status).toBe("cancelled");
    const race = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      n: 2,
      signal: ac.signal,
    });
    expect(race.status).toBe("cancelled");
  });

  it("cancels plan mode after a plan-review abort instead of writing a success plan", async () => {
    const repo = await initRepo();
    let reviewerStarted = false;
    const reviewer: ReviewerSpec = {
      providerFamily: "anthropic",
      adapter: {
        id: "slow-plan-reviewer",
        async discover() {
          return HarnessManifest.parse({
            id: "slow-plan-reviewer",
            display_name: "slow plan reviewer",
            kind: "local_cli",
            provider_family: "anthropic",
            capabilities: { review: true },
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "slow-plan-reviewer",
            status: "ok",
            enabled_intents: ["review"],
          });
        },
        async *run(spec) {
          reviewerStarted = true;
          const ts = new Date().toISOString();
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            observed_model: "slow-plan-reviewer-model",
          };
          const signal = spec.extra["abortSignal"] as AbortSignal | undefined;
          await new Promise<void>((resolve) => {
            if (!signal || signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    };
    const controller = new AbortController();
    const eventTypes: string[] = [];
    const orch = new Orchestrator({
      registry: new Map([["fake-success", createFakeHarness("fake-success")]]),
      reviewers: [reviewer],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map cancellation",
      mode: "plan",
      harnesses: ["fake-success"],
      signal: controller.signal,
      onEvent: (event) => {
        eventTypes.push(event.type);
        if (event.type === "reviewer.first_event") controller.abort();
      },
    });
    expect(reviewerStarted).toBe(true);
    expect(eventTypes).toContain("reviewer.first_event");
    expect(res.status).toBe("cancelled");
    expect(res.candidates.some((candidate) => candidate.status === "success")).toBe(true);
    expect(existsSync(join(res.runDir, "final", "plan.md"))).toBe(false);
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"run.failed"');
    expect(events).toContain('"status":"cancelled"');
  });

  it("cancels agent mode after a reviewer-panel abort instead of continuing to arbitration", async () => {
    const repo = await initRepo();
    let reviewerStarted = false;
    const reviewer: ReviewerSpec = {
      providerFamily: "anthropic",
      adapter: {
        id: "slow-agent-reviewer",
        async discover() {
          return HarnessManifest.parse({
            id: "slow-agent-reviewer",
            display_name: "slow agent reviewer",
            kind: "local_cli",
            provider_family: "anthropic",
            capabilities: { review: true },
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "slow-agent-reviewer",
            status: "ok",
            enabled_intents: ["review"],
          });
        },
        async *run(spec) {
          reviewerStarted = true;
          const ts = new Date().toISOString();
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            observed_model: "slow-agent-reviewer-model",
          };
          const signal = spec.extra["abortSignal"] as AbortSignal | undefined;
          await new Promise<void>((resolve) => {
            if (!signal || signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    };
    const controller = new AbortController();
    const eventTypes: string[] = [];
    const orch = new Orchestrator({
      registry: new Map([["diff-impl", diffImplementer("diff-impl")]]),
      reviewers: [reviewer],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "change then cancel review",
      mode: "agent",
      harnesses: ["diff-impl"],
      signal: controller.signal,
      onEvent: (event) => {
        eventTypes.push(event.type);
        if (event.type === "reviewer.first_event") controller.abort();
      },
    });

    expect(reviewerStarted).toBe(true);
    expect(eventTypes).toContain("reviewer.first_event");
    expect(eventTypes).not.toContain("arbitration.completed");
    expect(res.status).toBe("cancelled");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"run.failed"');
    expect(events).toContain('"status":"cancelled"');
    expect(events).not.toContain('"type":"arbitration.completed"');
    expect(events).not.toContain('"type":"run.completed"');
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
      const registry = new Map<string, HarnessAdapter>([
        ["fake-success", createFakeHarness("fake-success")],
      ]);
      // Two clean cross-family reviewers -> review-only convergence succeeds on attempt 1.
      const orch = new Orchestrator({ registry, reviewers: reviewers() });
      const res = await orch.run({
        repoRoot: dir,
        prompt: "x",
        mode: "agent",
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

  it("in-place convergence records honest apply-state + revert fence in work_product", async () => {
    // An in-place convergence run mutates the LIVE tree directly across attempts,
    // so its work_product must carry adopted/apply_state/pre_turn_sha/post_turn_sha
    // (parity with runRace) — otherwise the control-api projects applyState
    // "not_applied"/revertable=false and the Revert affordance is lost.
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([["impl", diffImplementer("impl", "local")]]),
      reviewers: reviewers(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["impl"],
      attempts: 2,
      inPlace: true,
    });
    expect(["success", "ungated"]).toContain(res.status);
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(true);
    const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    expect(wp).toContain("adopted: true");
    expect(wp).toMatch(/apply_state: (applied|applied_review_blocked)/);
    // Both fences are real SHAs (not null) so the server-owned revert can run.
    expect(wp).toMatch(/pre_turn_sha: ['"]?[0-9a-f]{6,}/);
    expect(wp).toMatch(/post_turn_sha: ['"]?[0-9a-f]{6,}/);
  });

  it("refuses access=full without a user-level trust allow (loud, no silent downgrade)", async () => {
    const repo = await initRepo();
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-orch-notrust-"));
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const registry = new Map<string, HarnessAdapter>([
        ["fake-success", createFakeHarness("fake-success")],
      ]);
      const orch = new Orchestrator({ registry, reviewers: reviewers() });
      await expect(
        orch.run({
          repoRoot: repo,
          prompt: "x",
          mode: "agent",
          harnesses: ["fake-success"],
          n: 1,
          access: "full",
        }),
      ).rejects.toThrow(/allow_full_access/);
    } finally {
      delete process.env.CLAUDEXOR_CONFIG_DIR;
    }
  });

  it("web off routes a no-web harness but excludes an uncontrolled-web harness loudly", async () => {
    const repo = await initRepo();
    const answer = (sessionId: string) => [
      { type: "started", session_id: sessionId, ts: new Date().toISOString() },
      {
        type: "message",
        session_id: sessionId,
        ts: new Date().toISOString(),
        text: "local answer",
      },
      { type: "completed", session_id: sessionId, ts: new Date().toISOString() },
    ];
    // `none` (no web at ALL) trivially satisfies --web off.
    const noWeb = new Map<string, HarnessAdapter>([
      ["no-web", askAdapter("no-web", answer, "openai", "none")],
    ]);
    const ok = await new Orchestrator({ registry: noWeb, reviewers: [] }).run({
      repoRoot: repo,
      prompt: "q",
      mode: "ask",
      harnesses: ["no-web"],
      web: "off",
    });
    expect(ok.status).toBe("success");
    // `uncontrolled` (web exists, no switch) cannot enforce off: explicit selection fails loudly.
    const uncontrolled = new Map<string, HarnessAdapter>([
      ["wild-web", askAdapter("wild-web", answer, "openai", "uncontrolled")],
    ]);
    const blocked = await new Orchestrator({ registry: uncontrolled, reviewers: [] }).run({
      repoRoot: repo,
      prompt: "q",
      mode: "ask",
      harnesses: ["wild-web"],
      web: "off",
    });
    expect(blocked.status).toBe("failed");
    expect(blocked.summary).toContain("cannot enforce web policy 'off'");
    expect(blocked.summary).toContain("choose a web-capable/enforceable harness");
  });

  it("applies the configured global max_usd_per_run as the default run cap", async () => {
    const repo = await initRepo();
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-orch-budgetcfg-"));
    writeFileSync(join(configDir, "config.yaml"), "budget:\n  max_usd_per_run: 0.005\n");
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const registry = new Map<string, HarnessAdapter>([
        ["fake-success", createFakeHarness("fake-success")],
      ]);
      const orch = new Orchestrator({ registry, reviewers: reviewers() });
      // No explicit --max-usd: the configured default cap must bind (each fake
      // candidate costs 0.01 > 0.005, so the wave settles into the hard tier
      // and queued slots are denied — same shape as the explicit-cap test).
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-success"],
        n: 6,
      });
      const contract = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
      expect(contract).toContain("max_usd: 0.005");
      const primary = res.candidates.filter((c) => /^a\d+$/.test(c.attemptId));
      expect(primary.length).toBeLessThan(6);
    } finally {
      delete process.env.CLAUDEXOR_CONFIG_DIR;
    }
  });
});

/** A planner adapter that doctor-OKs the orchestrate intent and emits a fenced
 * JSON plan in its message (the typed plan the executor consumes). */
function plannerAdapter(
  id: string,
  plan: unknown,
  family: ProviderFamily = "anthropic",
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: {
          orchestrate: true,
          plan: true,
          review: true,
          read_files: true,
        },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["orchestrate", "plan", "review"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts, observed_model: `${id}-model` };
      yield {
        type: "message",
        session_id: spec.session_id,
        ts,
        text: "Plan:\n\n```json\n" + JSON.stringify(plan) + "\n```\n",
      };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

describe("Orchestrate executor (auto_safe / auto_full)", () => {
  it("FAIL-CLOSED risk: an apply step blocks an auto_safe run and is NOT executed", async () => {
    const repo = await initRepo();
    // Plan = a single risky apply step referencing some run. Under auto_safe the
    // executor must STOP at it (blocked terminal), never deliver it.
    const plan = { tool_calls: [{ tool: "apply", run_id: "run-nonexistent", why: "ship it" }] };
    const orch = new Orchestrator({
      registry: new Map([["planner", plannerAdapter("planner", plan)]]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do the thing",
      mode: "orchestrate",
      harnesses: ["planner"],
      autonomy: "auto_safe",
    });
    expect(res.status).toBe("blocked");
    // The plan was still produced (suggest artifact), and progress records the block.
    expect(existsSync(join(res.runDir, "final", "orchestration.yaml"))).toBe(true);
    const progress = readFileSync(join(res.runDir, "final", "orchestration_progress.yaml"), "utf8");
    expect(progress).toContain("autonomy: auto_safe");
    expect(progress).toContain("status: blocked");
    expect(progress).toContain("risk: risky");
    // Terminal: a NEEDS_HUMAN-style block awaiting an operator decision.
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain("risky step");
    const types = readRunEvents(res.runDir).map((e) => e.type);
    expect(types).toContain("orchestrate.step.blocked");
    expect(types).toContain("run.blocked");
    // The live tree was NEVER mutated (no apply happened): the only working-tree
    // change is the engine's own .claudexor/ artifacts, never user source.
    const status = await runCapture("git", [
      "-C",
      repo,
      "status",
      "--porcelain",
      "--",
      ".",
      ":(exclude).claudexor",
    ]);
    expect(status.stdout.trim()).toBe("");
  });

  it("SAFE step runs as an isolated ENVELOPE sub-run (inPlace=false), never the live tree", async () => {
    const repo = await initRepo();
    // The plan asks for one safe start_run. The sub-run's implementer writes a
    // file; because it runs in an isolated envelope, the LIVE repo tree is NOT
    // mutated by the sub-run (the envelope is disposed; nothing adopted).
    const plan = {
      tool_calls: [
        { tool: "start_run", prompt: "edit something", mode: "agent", why: "kick it off" },
      ],
    };
    const registry = new Map<string, HarnessAdapter>([
      ["planner", plannerAdapter("planner", plan)],
      ["impl", diffImplementer("impl", "local")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      // harnesses pins the planner; the sub-run auto-resolves the impl harness.
      repoRoot: repo,
      prompt: "go",
      mode: "orchestrate",
      harnesses: ["planner"],
      autonomy: "auto_safe",
    });
    // The executor ran the safe step and the orchestrate run succeeded.
    expect(res.status).toBe("success");
    const progress = readFileSync(join(res.runDir, "final", "orchestration_progress.yaml"), "utf8");
    expect(progress).toContain("tool: start_run");
    expect(progress).toContain("risk: safe");
    expect(progress).toContain("status: done");
    const types = readRunEvents(res.runDir).map((e) => e.type);
    expect(types).toContain("orchestrate.subrun.started");
    // SAFETY: the live repo tree was NOT mutated by the safe envelope sub-run.
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(false);
  });

  it("ENVELOPE ENFORCEMENT: a start_run sub-run executes in an isolated worktree, not the live repo root", async () => {
    const repo = await initRepo();
    // Capture the cwd the sub-run's implementer actually executes in. A safe
    // Envelope sub-run runs in an isolated worktree under the external project runtime,
    // NEVER the live repo root (inPlace=false enforced by assertEnvelopeSubRun).
    let subCwd: string | null = null;
    const recordingImpl: HarnessAdapter = {
      id: "rec",
      async discover() {
        return HarnessManifest.parse({
          id: "rec",
          display_name: "rec",
          kind: "local_cli",
          provider_family: "local",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "rec",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        subCwd = spec.cwd;
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "rec-model" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const plan = {
      tool_calls: [{ tool: "start_run", prompt: "do it", mode: "agent", why: "spawn" }],
    };
    const registry = new Map<string, HarnessAdapter>([
      ["planner", plannerAdapter("planner", plan)],
      ["rec", recordingImpl],
    ]);
    const res = await new Orchestrator({ registry, reviewers: reviewers() }).run({
      repoRoot: repo,
      prompt: "go",
      mode: "orchestrate",
      harnesses: ["planner"],
      autonomy: "auto_safe",
    });
    expect(res.status).toBe("success");
    expect(subCwd).not.toBeNull();
    // The sub-run executed in an ISOLATED envelope worktree, not the live tree.
    expect(subCwd).not.toBe(repo);
    expect((subCwd as unknown as string).startsWith(projectRuntimeDir(repo))).toBe(true);
  });

  it("auto_full applies a referenced run's clean patch through the single apply gate", async () => {
    const repo = await initRepo();
    // First, produce a real clean patch via a normal envelope race (n=1 -> single
    // candidate); the resulting run's final/patch.diff + work_product feed apply.
    const seed = await new Orchestrator({
      registry: new Map([["impl", diffImplementer("impl", "local")]]),
      reviewers: reviewers(),
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
      tests: [shellGate("true")],
    });
    expect(existsSync(join(seed.runDir, "final", "patch.diff"))).toBe(true);
    const seedRunId = seed.runId;

    // Now an orchestrate auto_full run whose plan applies that referenced run.
    const plan = {
      tool_calls: [{ tool: "apply", run_id: seedRunId, mode: "apply", why: "land it" }],
    };
    const orch = new Orchestrator({
      registry: new Map([["planner", plannerAdapter("planner", plan)]]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "land the work",
      mode: "orchestrate",
      harnesses: ["planner"],
      autonomy: "auto_full",
    });
    expect(res.status).toBe("success");
    const progress = readFileSync(join(res.runDir, "final", "orchestration_progress.yaml"), "utf8");
    expect(progress).toContain("tool: apply");
    expect(progress).toContain("status: done");
    // The referenced patch wrote CHANGED.txt into the LIVE tree (auto_full applied).
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(true);
  });

  it("suggest autonomy never executes: the plan is the work product (read-only)", async () => {
    const repo = await initRepo();
    const plan = { tool_calls: [{ tool: "apply", run_id: "run-x", why: "would mutate" }] };
    const orch = new Orchestrator({
      registry: new Map([["planner", plannerAdapter("planner", plan)]]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "plan only",
      mode: "orchestrate",
      harnesses: ["planner"],
    });
    expect(res.status).toBe("success");
    // No executor ran under suggest: no progress artifact, no apply.
    expect(existsSync(join(res.runDir, "final", "orchestration.yaml"))).toBe(true);
    expect(existsSync(join(res.runDir, "final", "orchestration_progress.yaml"))).toBe(false);
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(false);
  });

  it("emits a failure-shaped terminal (run.failed{not_converged} + failure.yaml) when the planner yields no typed plan", async () => {
    const repo = await initRepo();
    // A planner that talks prose without a fenced JSON plan: the typed-plan
    // contract fails, so the terminal must be failure-shaped, never
    // run.completed (command projection and events.jsonl must agree).
    const proseBrain: HarnessAdapter = {
      ...plannerAdapter("planner", {}),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: "I would suggest refactoring things.",
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const orch = new Orchestrator({ registry: new Map([["planner", proseBrain]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "goal",
      mode: "orchestrate",
      harnesses: ["planner"],
    });
    expect(res.status).toBe("not_converged");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"run.failed"');
    expect(events).not.toContain('"run.completed"');
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("no valid typed plan");
  });

  it("forbids orchestrate-within-orchestrate (recursion guard)", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([
        ["planner", plannerAdapter("planner", { tool_calls: [{ tool: "status", run_id: "r" }] })],
      ]),
      reviewers: [],
    });
    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "orchestrate",
        harnesses: ["planner"],
        orchestrateDepth: 1,
      }),
    ).rejects.toThrow(/orchestrate-within-orchestrate is forbidden/);
  });
});

function readRunEvents(
  runDir: string,
): { seq?: number; type: string; payload: Record<string, unknown> }[] {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { seq?: number; type: string; payload: Record<string, unknown> });
}

/** Lifecycle invariant: output.ready precedes the terminal event (non-cancelled). */
function expectOutputReadyBeforeTerminal(runDir: string): void {
  const events = readRunEvents(runDir);
  const terminalIdx = events.findIndex((e) =>
    ["run.completed", "run.failed", "run.blocked"].includes(e.type),
  );
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
    const res = await new Orchestrator({ registry, reviewers: reviewers() }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
    });
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

    const race = await new Orchestrator({ registry, reviewers: reviewers() }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
    });
    expectOutputReadyBeforeTerminal(race.runDir);

    const converge = await new Orchestrator({ registry, reviewers: reviewers() }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["impl"],
      attempts: 1,
    });
    expectOutputReadyBeforeTerminal(converge.runDir);

    const ask = await new Orchestrator({ registry: askRegistry, reviewers: [] }).run({
      repoRoot: repo,
      prompt: "q",
      mode: "ask",
      harnesses: ["asker"],
    });
    expectOutputReadyBeforeTerminal(ask.runDir);

    const plan = await new Orchestrator({ registry: askRegistry, reviewers: [] }).run({
      repoRoot: repo,
      prompt: "q",
      mode: "plan",
      harnesses: ["asker"],
    });
    expectOutputReadyBeforeTerminal(plan.runDir);
  });

  it("skips review/synthesis/arbitration entirely when no candidate produced work", async () => {
    const repo = await initRepo();
    const crashing: HarnessAdapter = {
      id: "crasher",
      async discover() {
        return HarnessManifest.parse({
          id: "crasher",
          display_name: "crasher",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "crasher",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(): AsyncIterable<never> {
        throw new Error("adapter exploded before any work");
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["crasher", crashing]]),
      reviewers: reviewers(),
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["crasher"],
      n: 2,
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
      repoRoot: dir,
      prompt: "x",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
    });
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    const events = readRunEvents(res.runDir);
    const initEvent = events.find((e) => e.type === "project.git.initialized");
    expect(initEvent).toBeDefined();
    expect(initEvent?.payload["baseline_committed"]).toBe(true);
    const log = await runCapture("git", ["-C", dir, "log", "--oneline"]);
    expect(log.stdout).toContain("claudexor: initialize repository baseline");
    // The baseline includes user files; runtime lives outside the repository.
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
          id: "asker",
          display_name: "asker",
          kind: "local_cli",
          provider_family: "anthropic",
          capabilities: { implement: true, interactive: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "asker",
          status: "ok",
          enabled_intents: ["implement"],
        });
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
            questions: [
              {
                id: "q1",
                question: "Which flavor?",
                header: null,
                options: [{ label: "vanilla", description: null }],
                multi_select: false,
              },
            ],
          });
          seen.push(answers);
        }
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["asker", interactive]]),
      reviewers: reviewers(),
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["asker"],
      n: 1,
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
          id: "asker",
          display_name: "asker",
          kind: "local_cli",
          provider_family: "anthropic",
          capabilities: { implement: true, interactive: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "asker",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        const channel = (spec.extra as Record<string, unknown>)["interactionChannel"] as
          | { request(req: unknown): Promise<unknown> }
          | undefined;
        if (channel) {
          seen.push(
            await channel.request({
              interaction_id: "int-t",
              source_tool: "AskUserQuestion",
              questions: [],
            }),
          );
        }
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["asker", interactive]]),
      reviewers: reviewers(),
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["asker"],
      n: 1,
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

  it("releases an interaction wait immediately when the run is cancelled (no timeout sit-out)", async () => {
    const repo = await initRepo();
    const interactive: HarnessAdapter = {
      id: "asker",
      async discover() {
        return HarnessManifest.parse({
          id: "asker",
          display_name: "asker",
          kind: "local_cli",
          provider_family: "anthropic",
          capabilities: { implement: true, interactive: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "asker",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        const channel = (spec.extra as Record<string, unknown>)["interactionChannel"] as
          | { request(req: unknown): Promise<unknown> }
          | undefined;
        if (channel) {
          await channel.request({
            interaction_id: "int-c",
            source_tool: "AskUserQuestion",
            questions: [],
          });
        }
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const controller = new AbortController();
    const startedAt = Date.now();
    const res = await new Orchestrator({
      registry: new Map([["asker", interactive]]),
      reviewers: reviewers(),
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["asker"],
      n: 1,
      interactionTimeoutMs: 60_000, // the wait must NOT sit this out
      signal: controller.signal,
      // Abort only once the question is actually parked (a wall-clock timer
      // can fire before the run even reaches the harness on a cold CI host,
      // cancelling everything before interaction.requested exists).
      onInteraction: () => {
        setTimeout(() => controller.abort(), 25);
        return new Promise(() => {}); // never answers
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    const events = readRunEvents(res.runDir);
    const timeoutEvent = events.find((e) => e.type === "interaction.timeout");
    expect(timeoutEvent).toBeTruthy();
    expect((timeoutEvent?.payload as Record<string, unknown>)["reason"]).toBe("cancelled");
  });
});

describe("interaction late-answer honesty", () => {
  it("emits interaction.answer_discarded when the answer arrives after the timeout", async () => {
    const { interactionChannelFor } = await import("./interaction.js");
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const log = {
      emit: (type: string, payload: Record<string, unknown>) => events.push({ type, payload }),
    };
    let releaseAnswer: (v: { answers: { question_id: string; answer: string }[] }) => void = () =>
      undefined;
    const channel = interactionChannelFor(
      {
        onInteraction: () =>
          new Promise((resolve) => {
            releaseAnswer = resolve;
          }),
        interactionTimeoutMs: 100,
      } as never,
      log as never,
      "run-late",
      "task-late",
      "a01",
      "harness-x",
      true,
      900_000,
    );
    expect(channel).toBeTruthy();
    const res = await channel!.request({
      interaction_id: "int-1",
      source_tool: "ask_user",
      questions: [{ id: "q1", question: "answer me?" }],
    } as never);
    expect(res).toBeNull(); // timed out
    expect(events.some((e) => e.type === "interaction.timeout")).toBe(true);
    // The user answers AFTER the decline.
    releaseAnswer({ answers: [{ question_id: "q1", answer: "too late" }] });
    await new Promise((r) => setTimeout(r, 20));
    const discarded = events.find((e) => e.type === "interaction.answer_discarded");
    expect(discarded).toBeTruthy();
    expect(discarded?.payload["reason"]).toBe("timed_out");
  });
});

describe("interaction channel registration order", () => {
  it("invokes the answer handler SYNCHRONOUSLY before emitting interaction.requested (registry-population contract)", async () => {
    const { interactionChannelFor } = await import("./interaction.js");
    const order: string[] = [];
    const log = {
      emit: (type: string) => {
        order.push(type);
      },
    } as never;
    const channel = interactionChannelFor(
      {
        onInteraction: () => {
          order.push("handler");
          return new Promise(() => undefined); // never answers
        },
        interactionTimeoutMs: 30,
      },
      log,
      "run-x",
      "task-x",
      "a01",
      "h1",
      true,
      30,
    );
    await channel!.request({
      interaction_id: "int-1",
      source_tool: "AskUserQuestion",
      questions: [{ id: "q1", prompt: "?", options: [], allow_text: true }],
    } as never);
    expect(order[0]).toBe("handler"); // BEFORE interaction.requested
    expect(order).toContain("interaction.requested");
  });

  it("releases the watchdog suspension even when the handler throws synchronously", async () => {
    const { interactionChannelFor } = await import("./interaction.js");
    const channel = interactionChannelFor(
      {
        onInteraction: () => {
          throw new Error("sync boom");
        },
        interactionTimeoutMs: 20,
      },
      { emit: () => undefined } as never,
      "run-x",
      "task-x",
      "a01",
      "h1",
      true,
      20,
    );
    const res = await channel!.request({
      interaction_id: "int-2",
      source_tool: "AskUserQuestion",
      questions: [{ id: "q1", prompt: "?", options: [], allow_text: true }],
    } as never);
    expect(res).toBeNull();
    expect(channel!.pendingCount!()).toBe(0); // suspension released
  });
});

describe("auth-route attempt telemetry (route evidence)", () => {
  it("captures the adapter's first-class credential route (first-wins) into the record", async () => {
    const { attemptTelemetryRecord, createAttemptTelemetry, observeAttemptTelemetry } =
      await import("./attemptTelemetry.js");
    const t = createAttemptTelemetry("auto", false);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(t, {
      type: "started",
      session_id: "s",
      ts,
      credential_route: "vendor_native",
    } as never);
    // A later conflicting value must not overwrite the decided route.
    observeAttemptTelemetry(t, {
      type: "message",
      session_id: "s",
      ts,
      text: "x",
      credential_route: "managed_api_key",
    } as never);
    expect(t.authMode).toBe("local_session");
    expect(attemptTelemetryRecord("a1", "codex", t).auth_mode).toBe("local_session");
  });

  it("an absent credential route stays undisclosed (never guessed from payload)", async () => {
    const { attemptTelemetryRecord, createAttemptTelemetry, observeAttemptTelemetry } =
      await import("./attemptTelemetry.js");
    const t = createAttemptTelemetry("auto", false);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(t, { type: "started", session_id: "s", ts } as never);
    observeAttemptTelemetry(t, {
      type: "started",
      session_id: "s",
      ts,
      payload: { auth_route: "local_session" },
    } as never);
    expect(t.authMode).toBeNull();
    expect(attemptTelemetryRecord("a1", "codex", t).auth_mode).toBeNull();
  });
});

describe("web evidence recovery keying (INV-043)", () => {
  it("keeps the failure DISCLOSED when an unrelated-target web success satisfies the evidence gate", async () => {
    const { createAttemptTelemetry, observeAttemptTelemetry, webUnsatisfied } =
      await import("./attemptTelemetry.js");
    const t = createAttemptTelemetry("auto", false);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: {
        name: "WebSearch",
        kind: "web",
        status: "error",
        target: "query-A",
        error_summary: "search A failed",
      },
    } as never);
    expect(t.web.failed).toBe(true);
    // Success on a DIFFERENT target: evidence obtained (satisfied — the gate
    // asks for evidence, and reformulated queries are legitimate recovery),
    // but the A-failure stays disclosed (failed remains true).
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: { name: "WebSearch", kind: "web", status: "ok", target: "query-B" },
    } as never);
    expect(t.web.satisfied).toBe(true);
    expect(t.web.failed).toBe(true); // disclosure survives
    expect(t.web.errorSummary).toContain("search A failed");
    expect(webUnsatisfied(t)).toBe(false); // evidence gate: satisfied
    // The unrecovered web failure counts as a WARNING on a satisfied route
    // (green becomes success_with_warnings, never a silent clean success).
    const { toolWarnings } = await import("./attemptTelemetry.js");
    expect(toolWarnings(t).some((e) => e.kind === "web" && e.target === "query-A")).toBe(true);
    // A second failure on another target: BOTH stay disclosed until each
    // recovers (the rollup derives from the tool+target-keyed store).
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: {
        name: "WebFetch",
        kind: "web",
        status: "error",
        target: "https://c",
        error_summary: "fetch C failed",
      },
    } as never);
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: { name: "WebFetch", kind: "web", status: "ok", target: "https://c" },
    } as never);
    expect(t.web.failed).toBe(true); // query-A is STILL unrecovered
    // Success on the SAME target is the attributable recovery that clears it.
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: { name: "WebSearch", kind: "web", status: "ok", target: "query-A" },
    } as never);
    expect(t.web.failed).toBe(false);
  });

  it("a same-name same-target success of a DIFFERENT kind does not recover a web error", async () => {
    const { createAttemptTelemetry, observeAttemptTelemetry } =
      await import("./attemptTelemetry.js");
    const t = createAttemptTelemetry("auto", false);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: {
        name: "fetch",
        kind: "web",
        status: "error",
        target: "https://a",
        error_summary: "net down",
      },
    } as never);
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: { name: "fetch", kind: "command", status: "ok", target: "https://a" },
    } as never);
    expect(t.toolErrors.filter((e) => !e.recovered).length).toBe(1); // web error NOT laundered
  });

  it("web_required with only failures stays blocking regardless", async () => {
    const { createAttemptTelemetry, observeAttemptTelemetry, webUnsatisfied } =
      await import("./attemptTelemetry.js");
    const t = createAttemptTelemetry("live", true);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: {
        name: "WebFetch",
        kind: "web",
        status: "error",
        target: "https://x",
        error_summary: "boom",
      },
    } as never);
    expect(webUnsatisfied(t)).toBe(true);
  });
});

describe("final verify fail-closed + spend accounting (exit-gate criticals)", () => {
  it("verifier infra error yields applied_cleanly=null (attempted), never a silent pass", async () => {
    const repo = await initRepo();
    const { finalVerifyPatch } = await import("@claudexor/delivery");
    const rec = await finalVerifyPatch(
      repo,
      { baseSha: "0000000000000000000000000000000000000000", diff: "diff --git a/x b/x\n" },
      [],
      { emit: () => undefined },
    );
    // worktreeAdd cannot check out a nonexistent sha -> the verifier ERRORED.
    expect(rec).toMatchObject({ attempted: true, applied_cleanly: null });
    expect(rec.reason).toBeTruthy();
  });

  it("ask/plan/report results carry spendUsd so the orchestrate aggregate budget can charge them", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("spender", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield { type: "message", session_id: sessionId, ts, text: "the answer" };
      yield { type: "usage", session_id: sessionId, ts, usage: { cost_usd: 0.01 } };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const res = await new Orchestrator({
      registry: new Map([["spender", adapter]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "2+2?",
      mode: "ask",
      harnesses: ["spender"],
    });
    expect(res.status).toBe("success");
    expect(res.spendUsd).toBeCloseTo(0.01, 5);
  });

  it("orchestrate aggregate budget charges ask sub-runs and exhausts instead of overspending N times", async () => {
    const repo = await initRepo();
    const plan = {
      tool_calls: [
        { tool: "start_run", prompt: "q1", mode: "ask", harness: "spender", why: "" },
        { tool: "start_run", prompt: "q2", mode: "ask", harness: "spender", why: "" },
        { tool: "start_run", prompt: "q3", mode: "ask", harness: "spender", why: "" },
      ],
    };
    const spender = askAdapter("spender", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield { type: "message", session_id: sessionId, ts, text: "answered" };
      yield { type: "usage", session_id: sessionId, ts, usage: { cost_usd: 0.01 } };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const registry = new Map<string, HarnessAdapter>([
      ["planner", plannerAdapter("planner", plan)],
      ["spender", spender],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "answer three questions",
      mode: "orchestrate",
      harnesses: ["planner"],
      autonomy: "auto_safe",
      maxUsd: 0.015,
    });
    // Steps 1+2 spend 0.02 >= 0.015 -> step 3 must be SKIPPED and the run ends
    // `exhausted` (pre-fix: ask sub-runs returned no spendUsd, aggregate stayed
    // 0, and every step got the full cap again).
    expect(res.status).toBe("exhausted");
    const progress = readFileSync(join(res.runDir, "final", "orchestration_progress.yaml"), "utf8");
    expect(progress).toContain("aggregate budget exhausted");
    expect((progress.match(/status: skipped/g) ?? []).length).toBeGreaterThanOrEqual(1);
    // Failure-shaped terminal (a cut-short plan is NOT a clean success):
    // failure.yaml lands and the event log ends in run.failed, so `follow`
    // exits non-zero and the command projection agrees.
    expect(existsSync(join(res.runDir, "final", "failure.yaml"))).toBe(true);
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain("budget");
    const evTypes = readRunEvents(res.runDir).map((e) => e.type);
    expect(evTypes).toContain("run.failed");
    expect(evTypes).not.toContain("run.completed");
  });

  it("watchdog re-arms while a question is awaiting the user (isSuspended) instead of killing the run", async () => {
    const { withInactivityWatchdog, HarnessInactivityTimeoutError } =
      await import("@claudexor/core");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let suspended = true;
    async function* slowSource() {
      yield "first";
      await sleep(200); // 4x the 50ms window, but suspended -> must survive
      suspended = false;
      yield "second";
    }
    const seen: string[] = [];
    for await (const v of withInactivityWatchdog(slowSource(), {
      timeoutMs: 50,
      onTimeout: () => undefined,
      isSuspended: () => suspended,
    })) {
      seen.push(v);
    }
    expect(seen).toEqual(["first", "second"]);
    // Control: the same silence WITHOUT suspension times out.
    async function* wedged() {
      yield "only";
      await sleep(60_000);
    }
    await expect(async () => {
      for await (const v of withInactivityWatchdog(wedged(), {
        timeoutMs: 50,
        onTimeout: () => undefined,
      })) {
        void v;
      }
    }).rejects.toThrow(HarnessInactivityTimeoutError);
  });
});

describe("FinalVerifier scope (INV-115 completeness)", () => {
  it("in-place single-candidate turns are EXEMPT: no final_verify attempted (their diff is against the live tree)", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([["impl", diffImplementer("impl", "local")]]),
      reviewers: reviewers(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "edit the live tree",
      mode: "agent",
      harnesses: ["impl"],
      inPlace: true,
      tests: [shellGate('node -e "process.exit(0)"')],
    });
    // The turn mutated the live tree; a fresh snapshot worktree would lack
    // gitignored deps — verification must NOT have been attempted.
    const decision = readFileSync(join(res.runDir, "arbitration", "decision.yaml"), "utf8");
    expect(decision).not.toMatch(/final_verify:\s*\n\s*attempted: true/);
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(true);
  });

  it("an ENVELOPE convergence patch passes through the verifier (final_verify recorded on the decision)", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([["a", diffImplementer("a", "local")]]),
      reviewers: reviewers(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "converge",
      mode: "agent",
      harnesses: ["a"],
      attempts: 2,
      tests: [shellGate('node -e "process.exit(0)"')],
    });
    expect(res.status).toBe("success");
    const decision = readFileSync(join(res.runDir, "arbitration", "decision.yaml"), "utf8");
    expect(decision).toContain("final_verify:");
    expect(decision).toContain("attempted: true");
    expect(decision).toContain("applied_cleanly: true");
  });
});

describe("structured-first plan parsing", () => {
  it("accepts a BARE JSON final message (schema-constrained route) and falls back to fenced JSON", async () => {
    const { extractOrchestratePlan } = await import("./orchestratePlanner.js");
    const plan = { tool_calls: [{ tool: "status", run_id: "run-1", why: "check" }] };
    const bare = extractOrchestratePlan(JSON.stringify(plan));
    expect(bare.plan).not.toBeNull();
    expect(bare.plan!.tool_calls[0]!.tool).toBe("status");
    const fenced = extractOrchestratePlan(
      "Report:\n\n```json\n" + JSON.stringify(plan) + "\n```\n",
    );
    expect(fenced.plan).not.toBeNull();
    const neither = extractOrchestratePlan("no plan here");
    expect(neither.plan).toBeNull();
    expect(neither.error).toContain("no fenced json");
  });
});

describe("strict structured-output schema (critic findings)", () => {
  it("optional fields become NULLABLE (never force-required) and explicit nulls parse back", async () => {
    const { orchestratePlanJsonSchema } = await import("@claudexor/schema");
    const schema = orchestratePlanJsonSchema() as {
      properties?: {
        tool_calls?: {
          items?: {
            anyOf?: Array<{ properties?: Record<string, { type?: unknown }>; required?: string[] }>;
          };
        };
      };
    };
    const variants = schema.properties?.tool_calls?.items?.anyOf ?? [];
    const startRun = variants.find((v) => v.properties && "harness" in v.properties)!;
    expect(startRun.required).toContain("harness"); // strict mode: listed...
    const harnessType = startRun.properties!["harness"]!.type;
    expect(Array.isArray(harnessType) ? harnessType : [harnessType]).toContain("null"); // ...but nullable
    const { extractOrchestratePlan } = await import("./orchestratePlanner.js");
    const withNulls = extractOrchestratePlan(
      JSON.stringify({
        tool_calls: [{ tool: "start_run", prompt: "p", mode: "agent", harness: null, why: "w" }],
      }),
    );
    expect(withNulls.plan).not.toBeNull();
    expect(withNulls.plan!.tool_calls[0]).not.toHaveProperty("harness", null);
    // Null ARRAY ELEMENTS are NOT the nullable-optional recipe — a malformed
    // plan must fail the parse loudly, never be silently truncated.
    const nullElement = extractOrchestratePlan(JSON.stringify({ tool_calls: [null] }));
    expect(nullElement.plan).toBeNull();
    expect(nullElement.error).not.toBe("");
  });
});

describe("browser gate (INV-066): every unmet condition disarms; fully-armed injects", () => {
  it("browserSpecFor is null for opt-out/incapable/web-off/non-full-access; a spec appears only fully armed", async () => {
    const { Orchestrator: Orch } = await import("./orchestrator.js");
    const orch = new Orch({ registry: new Map(), reviewers: [] }) as any;
    const paths = { root: "/tmp/run-root" };
    const routedWith = (supportsBrowser: boolean) => ({ supportsBrowser });
    const base = { browser: true };
    // 1) run did not opt in
    expect(
      orch.browserSpecFor({ browser: false }, routedWith(true), "auto", "full", paths),
    ).toBeNull();
    // 2) harness lacks browser_tool
    expect(orch.browserSpecFor(base, routedWith(false), "auto", "full", paths)).toBeNull();
    // 3) web policy off (the browser is live egress riding external context policy)
    expect(orch.browserSpecFor(base, routedWith(true), "off", "full", paths)).toBeNull();
    // 4) access below full (workspace-write sandboxes cancel navigation — live-verified)
    expect(
      orch.browserSpecFor(base, routedWith(true), "auto", "workspace_write", paths),
    ).toBeNull();
    expect(orch.browserSpecFor(base, routedWith(true), "auto", "readonly", paths)).toBeNull();
    // FULLY ARMED: opt-in + capability + web + full access -> headed spec into the run tree.
    const armed = orch.browserSpecFor(base, routedWith(true), "auto", "full", paths);
    expect(armed).toEqual({ output_dir: "/tmp/run-root/browser", headless: false });
    const sandboxFull = orch.browserSpecFor(
      base,
      routedWith(true),
      "live",
      "external_sandbox_full",
      paths,
    );
    expect(sandboxFull).not.toBeNull();
  });
});

describe("stall rotation (headroom + coverage)", () => {
  it("prefers UNTRIED candidates even when a tried one has more headroom", async () => {
    const { pickStallRotationIdx } = await import("./runSupport.js");
    const ledger = {
      headroom: (id: string) => (id === "strong" ? 1 : 0.2),
      cooldownActive: () => false,
    };
    const pool = ["strong", "current", "fresh"];
    // "strong" was already tried since progress; "fresh" was not.
    expect(pickStallRotationIdx(pool, 1, ledger, new Set(["strong", "current"]))).toBe(2);
    // all tried -> falls back to best headroom among eligible.
    expect(pickStallRotationIdx(pool, 1, ledger, new Set(pool))).toBe(0);
    // total on degenerate pools: empty pool never NaN/undefined.
    expect(pickStallRotationIdx([], 0, ledger)).toBe(0);
    // every ALTERNATIVE cooling -> STAY on current (never hop onto a
    // known rate-limited harness just to rotate).
    const allCooling = { headroom: () => 1, cooldownActive: () => true };
    expect(pickStallRotationIdx(pool, 1, allCooling)).toBe(1);
    // equal headroom -> round-robin tiebreak: nearest clockwise neighbor.
    const flat = { headroom: () => 1, cooldownActive: () => false };
    expect(pickStallRotationIdx(pool, 1, flat)).toBe(2);
    expect(pickStallRotationIdx(pool, 2, flat)).toBe(0);
  });
});
