import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, cli, makeSandbox, readRunYaml } from "./support.js";

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = makeSandbox();
});

afterEach(() => {
  sandbox.dispose();
});

describe("RunFacts canary", () => {
  it("[INV-122:run-facts-surface-parity] terminal JSON, API, inspect, artifact, and telemetry expose one receipt", async () => {
    const run = cli(sandbox, [
      "plan",
      "Plan adding an uppercase option.",
      "--harness",
      "fake-success",
      "--json",
    ]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const terminal = run.json() as {
      runId: string;
      runDir: string;
      runFacts: unknown;
    };
    const stored = readRunYaml(terminal.runDir, "final/run_facts.yaml");
    const telemetry = readRunYaml<{ run_facts: unknown }>(terminal.runDir, "final/telemetry.yaml");
    const inspected = cli(sandbox, ["inspect", terminal.runId, "--json"]);
    expect(inspected.code, inspected.stdout + inspected.stderr).toBe(0);
    const inspectJson = inspected.json() as { runFacts: unknown };

    const controlInfo = JSON.parse(
      readFileSync(join(sandbox.configDir, "daemon", "control-api.json"), "utf8"),
    ) as { host: string; port: number };
    const token = readFileSync(join(sandbox.configDir, "daemon", "token"), "utf8").trim();
    const response = await fetch(
      `http://${controlInfo.host}:${controlInfo.port}/v2/runs/${encodeURIComponent(terminal.runId)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "x-claudexor-protocol-major": "3",
        },
      },
    );
    expect(response.status).toBe(200);
    const detail = (await response.json()) as { runFacts: unknown };

    const canonical = JSON.stringify(stored);
    expect(JSON.stringify(terminal.runFacts)).toBe(canonical);
    expect(JSON.stringify(telemetry.run_facts)).toBe(canonical);
    expect(JSON.stringify(detail.runFacts)).toBe(canonical);
    expect(JSON.stringify(inspectJson.runFacts)).toBe(canonical);
    expect(stored).toMatchObject({
      run_id: terminal.runId,
      mode: "plan",
      deliverable: {
        present: true,
        kind: "plan",
        path: "final/plan.md",
      },
    });

    const streamedRun = cli(sandbox, [
      "plan",
      "Plan adding a lowercase option.",
      "--harness",
      "fake-success",
      "--json-stream",
    ]);
    expect(streamedRun.code, streamedRun.stdout + streamedRun.stderr).toBe(0);
    const frames = streamedRun.stdout
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const streamedTerminal = frames.find((frame) => frame["frame"] === "run.terminal") as
      { runId: string; runFacts: unknown } | undefined;
    expect(streamedTerminal).toBeDefined();
    const streamedInspect = cli(sandbox, ["inspect", streamedTerminal!.runId, "--json"]);
    expect(streamedInspect.code, streamedInspect.stdout + streamedInspect.stderr).toBe(0);
    expect(JSON.stringify(streamedTerminal!.runFacts)).toBe(
      JSON.stringify((streamedInspect.json() as { runFacts: unknown }).runFacts),
    );
  }, 30_000);
});
