import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { runCapture, type HarnessAdapter } from "@claudexor/core";
import {
  ConformanceReport,
  HarnessManifest,
  RunTelemetry,
  outcomeExitCode,
  type HarnessRunSpec,
} from "@claudexor/schema";
import { Orchestrator, type OrchestratorResult, type RunInput } from "./orchestrator.js";

/**
 * Owner decision 2026-10-05 («1. A») through the real orchestrator lanes: on a
 * route where the WorkReport footer is only REQUESTED (`validated` transport —
 * cursor, agy, acp) a missing or broken footer never fails the run. The
 * lifecycle succeeds, the work_state is disclosed as unverified with a typed
 * reason, and the answer is kept whole. A valid needs_input footer still vetoes.
 */
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

async function repository(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "claudexor-instructed-footer-"));
  roots.push(root);
  await runCapture("git", ["-C", root, "init", "-b", "main"]);
  writeFileSync(join(root, "README.md"), "# Instructed footer fixture\n");
  await runCapture("git", ["-C", root, "add", "-A"]);
  await runCapture("git", [
    "-C",
    root,
    "-c",
    "user.email=qa@example.invalid",
    "-c",
    "user.name=QA",
    "commit",
    "-m",
    "fixture",
  ]);
  return root;
}

/** A harness whose manifest declares the instructed (`validated`) transport and
 * which replies with exactly `reply`, optionally after writing a file. */
function instructedHarness(reply: string, writes?: string): HarnessAdapter {
  const id = "instructed";
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "cursor",
        capabilities: {
          implement: true,
          plan: true,
          review: true,
          read_files: true,
          work_report_transport: "validated",
          json_schema_output: false,
        },
        access_profiles_supported: ["readonly", "workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["explain", "audit", "plan", "implement", "review"],
      });
    },
    async *run(spec: HarnessRunSpec) {
      const base = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...base, type: "started", credential_route: "vendor_native" };
      if (writes) writeFileSync(join(spec.cwd, writes), "real change\n");
      yield { ...base, type: "message", final: true, text: reply };
      yield { ...base, type: "completed" };
    },
  };
}

async function run(
  adapter: HarnessAdapter,
  input: Pick<RunInput, "mode"> & Partial<RunInput>,
): Promise<{
  result: OrchestratorResult;
  text: (path: string) => string;
  telemetry: RunTelemetry;
}> {
  const repo = await repository();
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
  }).run({ repoRoot: repo, prompt: "Answer the question.", harnesses: [adapter.id], ...input });
  const text = (path: string) => readFileSync(join(result.runDir, path), "utf8");
  return {
    result,
    text,
    telemetry: RunTelemetry.parse(
      new ArtifactStore(repo).readYaml(join(result.runDir, "final", "telemetry.yaml")),
    ),
  };
}

const fence = (value: unknown): string => ["```json", JSON.stringify(value), "```"].join("\n");

describe("instructed WorkReport footer through the orchestrator (owner decision 2026-10-05)", () => {
  it("ask: an answer without a footer succeeds, unverified, with its trailing JSON block intact", async () => {
    const verdict = fence({ verdict: "PASS", findings: [] });
    const reply = ["# Review", "", "The change is sound.", "", verdict].join("\n");
    const { result, text, telemetry } = await run(instructedHarness(reply), { mode: "ask" });

    expect(result.lifecycle).toBe("succeeded");
    expect(result.facts.reason ?? null).toBeNull();
    expect(result.facts.work_state).toEqual({
      state: "unverified",
      source: "validated",
      unverified_reason: "report_missing",
    });
    expect(outcomeExitCode(result.facts)).toBe(0);
    const answer = text("final/answer.md");
    expect(answer).toContain("The change is sound.");
    expect(answer).toContain(verdict);
    expect(telemetry.attempts[0]?.outcome).toMatchObject({
      status: "success",
      deliverable_present: true,
      work_state: {
        state: "unverified",
        source: "validated",
        unverified_reason: "report_missing",
      },
    });
    expect(text("events.jsonl")).not.toContain("work_report contract");
  });

  it("ask: a malformed footer is disclosed and stays readable; it neither fails nor vetoes", async () => {
    const footer = fence({
      work_report: {
        state: "needs_input",
        required_inputs: [{ kind: "api_key", locator: null, description: "Need the staging key" }],
      },
    });
    const { result, text } = await run(instructedHarness(["Partial answer.", footer].join("\n")), {
      mode: "ask",
    });

    expect(result.lifecycle).toBe("succeeded");
    expect(result.facts.work_state).toEqual({
      state: "unverified",
      source: "validated",
      unverified_reason: "report_malformed",
    });
    expect(outcomeExitCode(result.facts)).toBe(0);
    const answer = text("final/answer.md");
    expect(answer).toContain("Partial answer.");
    expect(answer).toContain("Need the staging key");
  });

  it("ask: a VALID needs_input footer still vetoes and leaves the answer without the footer", async () => {
    const report = {
      state: "needs_input",
      required_inputs: [
        { kind: "decision", locator: "db-backend", description: "Which database?" },
      ],
    };
    const { result, text } = await run(
      instructedHarness(["I need a decision first.", fence({ work_report: report })].join("\n")),
      { mode: "ask" },
    );

    expect(result.lifecycle).toBe("succeeded");
    expect(result.facts.work_state).toEqual({ ...report, source: "validated" });
    expect(result.facts.reason).toBe("input_required");
    expect(outcomeExitCode(result.facts)).toBe(1);
    const answer = text("final/answer.md");
    expect(answer).toContain("I need a decision first.");
    expect(answer).not.toContain("work_report");
  });

  it("plan: prose with no fence at all is an accepted plan with a footer_missing work_state", async () => {
    const plan = [
      "# Plan",
      "",
      "1. Inspect the owner.",
      "",
      "## Open Questions",
      "- [text] Should the file be committed?",
    ].join("\n");
    const { result, text } = await run(instructedHarness(plan), { mode: "plan" });

    expect(result.lifecycle).toBe("succeeded");
    expect(result.facts.work_state).toEqual({
      state: "unverified",
      source: "validated",
      unverified_reason: "footer_missing",
    });
    expect(text("final/plan.md").trim()).toBe(plan);
    expect(JSON.parse(text("final/questions.json"))).toMatchObject({ parse: "found" });
  });

  it("agent: a real change with no footer is a clean candidate, not a contract failure", async () => {
    const { result, text, telemetry } = await run(
      instructedHarness("Implemented the change.", "CHANGED.txt"),
      { mode: "agent", n: 1 },
    );

    expect(result.lifecycle).toBe("succeeded");
    expect(telemetry.attempts[0]?.outcome).toMatchObject({
      status: "success",
      deliverable_present: true,
      work_state: {
        state: "unverified",
        source: "validated",
        unverified_reason: "footer_missing",
      },
    });
    expect(text("final/patch.diff")).toContain("CHANGED.txt");
    expect(text("final/answer.md")).toContain("Implemented the change.");
    expect(text("events.jsonl")).not.toContain("work_report contract");
  });
});
