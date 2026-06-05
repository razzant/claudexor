import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionEngine, runDoctor } from "@claudex/core";
import { createFakeHarness, FAKE_KINDS } from "./index.js";

function registry() {
  const m = new Map();
  for (const k of FAKE_KINDS) m.set(k, createFakeHarness(k));
  return m;
}

describe("ExecutionEngine + fake harness", () => {
  it("runs fake-success end to end and writes artifacts", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudex-test-"));
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

  it("marks fake-fail-tests as failed", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudex-test-"));
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
