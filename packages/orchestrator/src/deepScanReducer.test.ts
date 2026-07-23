import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import { BudgetLedger, routeCostEvidence } from "@claudexor/budget";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import type { HarnessAdapter } from "@claudexor/core";
import { runDeepScanReducer, type DeepScanReducerDeps } from "./deepScanReducer.js";
import type { WorkReportEnvelopeMode } from "./attemptFinalize.js";
import type { RoutedAdapter } from "./orchestrator.js";

/**
 * D-16 wave-1 parity: the deep-scan bounded reducer must unwrap + finalize its
 * output through the SAME WorkReport contract as every other attempt. A capable
 * reducer route that breaks the contract (malformed) or attests
 * needs_input/incomplete is a typed reducer FAILURE — never a laundered
 * synthesis — so the caller degrades to the honest raw scout bundle.
 */

const __dirs: string[] = [];
afterAll(() => {
  for (const d of __dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An adapter that emits a single final message (the reducer's raw output). */
function reducerAdapter(finalText: string): HarnessAdapter {
  async function* run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
    const s = spec.session_id;
    yield { type: "started", session_id: s, ts: nowIso() };
    yield {
      type: "message",
      session_id: s,
      ts: nowIso(),
      text: finalText,
      final: true,
      payload: { final_source: "test" },
    };
    yield {
      type: "usage",
      session_id: s,
      ts: nowIso(),
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001 },
    };
    yield { type: "completed", session_id: s, ts: nowIso() };
  }
  return {
    id: "fake-reducer",
    discover: () => Promise.reject(new Error("unused")),
    doctor: () => Promise.reject(new Error("unused")),
    run,
    review: run,
    cancel: () => Promise.resolve(),
  } as unknown as HarnessAdapter;
}

/** A CONSTRAINED WorkReport transport mode (the `{work_report, output}` envelope
 * a capable reducer route would ride). */
const constrainedMode: WorkReportEnvelopeMode = {
  active: true,
  source: "constrained",
  hasCallerSchema: false,
  channel: "constrained_json",
  instruction: null,
};

function makeDeps(mode: WorkReportEnvelopeMode): DeepScanReducerDeps {
  return {
    newReadOnlyHome: () => ({ env: {}, dispose: () => {} }),
    costEvidence: () =>
      routeCostEvidence({
        billing: "metered",
        knowledge: "estimated",
        source: "test-pricing",
        provenance: ["fixture:deepscan"],
        estimatedUsd: 0.01,
      }),
    buildSpec: (_routed, homeEnv, prompt) => ({
      spec: HarnessRunSpec.parse({
        session_id: "ses_reducer",
        intent: "synthesize",
        prompt,
        cwd: tmpdir(),
        access: "readonly",
        env: homeEnv,
      }),
      webPolicy: "off",
      effectiveWeb: "off",
      model: null,
      workReportMode: mode,
    }),
    hardTimeoutMs: 5_000,
    inactivityTimeoutMs: 5_000,
    webRequired: false,
  };
}

async function runWith(mode: WorkReportEnvelopeMode, finalText: string) {
  const root = mkdtempSync(join(tmpdir(), "claudexor-deepscan-"));
  __dirs.push(root);
  const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
  const paths = store.createRun("run-reducer");
  const log = new EventLog(paths.eventsPath, "run-reducer", "task-reducer");
  const ledger = new BudgetLedger({ kind: "unlimited" });
  const routed = { adapter: reducerAdapter(finalText) } as unknown as RoutedAdapter;
  try {
    return await runDeepScanReducer(makeDeps(mode), {
      taskId: "task-reducer",
      goal: "merge the scout reports",
      routed,
      scoutReports: [],
      ledger,
      log,
      paths,
      attemptTelemetries: [],
    });
  } finally {
    log.dispose();
  }
}

describe("runDeepScanReducer WorkReport contract parity (D-16)", () => {
  it("a completed envelope on a constrained route succeeds with the UNWRAPPED output (never the envelope)", async () => {
    const finalText = JSON.stringify({
      work_report: { state: "completed", required_inputs: [] },
      output: "Merged synthesis: deduplicated the scout findings.",
    });
    const result = await runWith(constrainedMode, finalText);
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.report).toContain("Merged synthesis");
      expect(result.report).not.toContain("work_report");
    }
  });

  it("a MALFORMED report on a constrained route is a typed reducer failure, never a prose success", async () => {
    const result = await runWith(constrainedMode, "just prose, no envelope");
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toMatch(/work_report contract/i);
    }
  });

  it("a needs_input report on a constrained route is a typed reducer failure (degrade to the raw bundle)", async () => {
    const finalText = JSON.stringify({
      work_report: {
        state: "needs_input",
        required_inputs: [{ kind: "decision", locator: null, description: "which merge order?" }],
      },
      output: "partial",
    });
    const result = await runWith(constrainedMode, finalText);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toMatch(/needs_input/);
    }
  });

  it("an INACTIVE transport passes the report through untouched (schema-free reducer route)", async () => {
    const inactive: WorkReportEnvelopeMode = {
      active: false,
      source: "absent",
      hasCallerSchema: false,
      channel: "constrained_json",
      instruction: null,
    };
    const result = await runWith(inactive, "Plain merged synthesis with no envelope.");
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.report).toContain("Plain merged synthesis");
    }
  });
});
