import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { ExecutionEngine, runDoctor } from "@claudexor/core";
import { ConformanceReport, HarnessManifest, type HarnessRunSpec } from "@claudexor/schema";
import { createFakeHarness, FAKE_KINDS } from "./index.js";

function registry() {
  const m = new Map();
  for (const k of FAKE_KINDS) m.set(k, createFakeHarness(k));
  return m;
}

describe("ExecutionEngine + fake harness", () => {
  it("runs fake-success end to end and writes artifacts", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-test-"));
    const engine = new ExecutionEngine(registry());
    const res = await engine.run({ repoRoot: repo, prompt: "do it", harnessId: "fake-success" });
    expect(res.status).toBe("success");
    expect(res.changedFiles).toContain("FAKE_CHANGE.txt");
    expect(existsSync(res.workProductPath)).toBe(true);
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("run.completed");
    expect(events).toContain("work_product.emitted");
    expect(res.costUsd).toBeCloseTo(0.01);
  });

  it("forwards access profile and model hint to the harness (agent)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-test-"));
    let seen: HarnessRunSpec | undefined;
    const capture: HarnessAdapter = {
      id: "capture",
      async discover() {
        return HarnessManifest.parse({ id: "capture", display_name: "capture", kind: "local_cli", capabilities: { implement: true } });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "capture", status: "ok" });
      },
      async *run(spec) {
        seen = spec;
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const engine = new ExecutionEngine(new Map([["capture", capture]]));
    await engine.run({ repoRoot: repo, prompt: "x", harnessId: "capture", access: "full", model: "some-model" });
    expect(seen?.access).toBe("full");
    expect(seen?.model_hint).toBe("some-model");
  });

  it("marks fake-fail-tests as failed", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-test-"));
    const engine = new ExecutionEngine(registry());
    const res = await engine.run({ repoRoot: repo, prompt: "x", harnessId: "fake-fail-tests" });
    expect(res.status).toBe("failed");
  });

  it("doctor reports fake-invalid-json as degraded with disabled review", async () => {
    const reports = await runDoctor(registry(), { cwd: "/tmp" });
    const degraded = reports.find((r) => r.harness_id === "fake-invalid-json");
    expect(degraded?.status).toBe("degraded");
    expect(degraded?.disabled_intents).toContain("review");
  });
});
