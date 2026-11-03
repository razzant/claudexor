import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  ControlRunSummary,
  RawContextReceipt,
  RunTelemetry,
  SCHEMA_VERSION,
} from "@claudexor/schema";
import { summarizeRun } from "./run-projection.js";
import type { DaemonRunRecord } from "./run-record.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const receipt = (model: string, estimated: number) =>
  RawContextReceipt.parse({
    model,
    estimated_request_tokens: estimated,
    budget: {
      estimator: "chars_div_4",
      basis: "model_context_window",
      model,
      context_window: 200_000,
      output_allowance_tokens: 16_384,
      framing_tokens: 2_000,
      selection_limit_tokens: 181_616,
      estimated_packet_tokens: estimated - 2_000,
      omitted_for_budget: 3,
      mandatory_paths: ["AGENTS.md"],
    },
  });

/** A finished run whose telemetry names `finalAttempt` and carries `attempts`. */
function run(attempts: Array<{ id: string; rawContext?: unknown }>, finalAttempt: string | null) {
  const runDir = mkdtempSync(join(tmpdir(), "claudexor-raw-context-projection-"));
  roots.push(runDir);
  mkdirSync(join(runDir, "final"));
  const web = {
    required: false,
    policy: "auto",
    effective_mode: "auto",
    attempted: false,
    satisfied: false,
    status: "none",
    tool: null,
    target: null,
    error_summary: null,
  };
  const telemetry = RunTelemetry.parse({
    schema_version: SCHEMA_VERSION,
    run_id: "run-raw",
    task_id: "task-raw",
    mode: "agent",
    requested_access: "workspace_write",
    effective_access: "workspace_write",
    external_context_policy: "auto",
    effective_web_mode: "auto",
    web,
    final_attempt_id: finalAttempt,
    attempts: attempts.map((attempt) => ({
      attempt_id: attempt.id,
      harness_id: "openrouter",
      web,
      ...(attempt.rawContext ? { raw_context: attempt.rawContext } : {}),
    })),
    generated_at: "2026-10-29T00:00:00.000Z",
  });
  writeFileSync(join(runDir, "final", "telemetry.yaml"), stringifyYaml(telemetry));
  const record: DaemonRunRecord = {
    id: "job-raw",
    runId: "run-raw",
    taskId: "task-raw",
    state: "succeeded",
    runDir,
    params: { mode: "agent", prompt: "edit" },
  };
  return ControlRunSummary.parse(summarizeRun(record));
}

describe("the run summary projects the final attempt's raw request size (#147)", () => {
  it("projects the receipt of the attempt that produced the result, typed", () => {
    const winner = receipt("vendor/big", 182_000);
    const summary = run(
      [
        { id: "a01", rawContext: receipt("vendor/other", 90_000) },
        { id: "a02", rawContext: winner },
      ],
      "a02",
    );
    expect(summary.rawContext).toEqual(winner);
  });

  it("never borrows another attempt's receipt, and stays null without one", () => {
    expect(
      run([{ id: "a01", rawContext: receipt("vendor/big", 5_000) }, { id: "a02" }], "a02"),
    ).toMatchObject({ rawContext: null });
    expect(run([{ id: "a01", rawContext: receipt("vendor/big", 5_000) }], null)).toMatchObject({
      rawContext: null,
    });
    // Telemetry written before the field existed projects null as well.
    expect(run([{ id: "a01" }], "a01")).toMatchObject({ rawContext: null });
  });
});
