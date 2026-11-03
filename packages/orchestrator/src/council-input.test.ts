import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { createAttemptTelemetry, setAttemptOutcome } from "./attemptTelemetry.js";
import type { PlannerAttemptOutcome } from "./plannerAttempt.js";
import { stageCouncilDraft } from "./council-input.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "claudexor-council-stage-"));
  roots.push(root);
  const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
  const paths = store.createRun("run-input");
  const telemetry = createAttemptTelemetry("off", false, "off", [], null);
  setAttemptOutcome(telemetry, {
    deliverablePresent: false,
    gatesPassed: null,
    harnessErrored: true,
    webRequiredUnsatisfied: false,
    workState: { state: "unverified", source: "constrained" },
  });
  const outcome: PlannerAttemptOutcome = {
    attemptId: "p01",
    harnessId: "planner",
    status: "failed",
    outcomeClass: "contract_failure",
    error: "original contradiction",
    text: "useful extracted plan",
    harnessFailedBeforeReport: false,
    telemetry,
    budgetDenied: false,
    reportProblem: {
      kind: "completed_with_required_inputs",
      reported: {
        state: "completed",
        required_inputs: [{ kind: "file", locator: "design.md", description: "Missing input" }],
      },
    },
  };
  return { store, paths, telemetry, outcome };
}

describe("Council unverified eligibility is positive typed evidence", () => {
  it("does not authorize historical outcomes missing the original harness-failure fact or marker", () => {
    const { store, paths, outcome } = fixture();
    const { harnessFailedBeforeReport: _harnessFailure, ...withoutFailureFact } = outcome;
    expect(
      stageCouncilDraft(withoutFailureFact as PlannerAttemptOutcome, store, paths, false).input,
    ).toBeNull();
    const { reportProblem: _problem, ...withoutProblem } = outcome;
    expect(stageCouncilDraft(withoutProblem, store, paths, false).input).toBeNull();
  });

  it("refuses required-web failure, terminal context exhaustion, and abort independently", () => {
    const { store, paths, telemetry, outcome } = fixture();
    expect(stageCouncilDraft(outcome, store, paths, true).input).toBeNull();
    telemetry.contextExhausted = true;
    expect(stageCouncilDraft(outcome, store, paths, false).input).toBeNull();
    telemetry.contextExhausted = false;
    telemetry.outcome!.webRequiredUnsatisfied = true;
    expect(stageCouncilDraft(outcome, store, paths, false).input).toBeNull();
  });
});
