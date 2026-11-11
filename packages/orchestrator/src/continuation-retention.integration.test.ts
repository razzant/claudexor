import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetLedger } from "@claudexor/budget";
import { ArtifactStore } from "@claudexor/artifact-store";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { retainedEnvelopeOfRun } from "@claudexor/workspace";
import { run } from "./inrun-continuity.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("retention follows the final run outcome", () => {
  it("keeps a context-exhausted candidate that is interrupted without a harness error", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a"],
      input: { inPlace: false, continuation: { retain: true } },
      script: function* ({ spec, emit }) {
        yield emit({ type: "started", payload: { native_session_id: "sid-context" } });
        writeFileSync(join(spec.cwd, "partial.txt"), "unfinished work\n");
        yield emit({ type: "file_change", payload: { path: "partial.txt" } });
        yield emit({
          type: "context",
          context: {
            kind: "capacity_exhausted",
            cause: "window_exceeded",
            native_code: null,
            trigger: "auto",
            pre_tokens: null,
          },
        });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle).toBe("interrupted");
    const kept = retainedEnvelopeOfRun(o.result.runDir, o.result.runId);
    expect(kept).not.toBeNull();
    expect(readFileSync(join(kept!.envelope.worktree_path, "partial.txt"), "utf8")).toBe(
      "unfinished work\n",
    );
    expect(o.resumable?.["workspace"]).toEqual({
      kind: "retained_envelope",
      root: kept!.envelope.worktree_path,
    });
  });

  it("keeps completed candidate work when the budget fails the run after review", async () => {
    let reviewed = false;
    const terminal = BudgetLedger.prototype.terminal;
    vi.spyOn(BudgetLedger.prototype, "terminal").mockImplementation(function (this: BudgetLedger) {
      return reviewed ? "budget_overshoot" : terminal.call(this);
    });
    const o = await run({
      mode: "agent",
      profiles: ["a"],
      input: { inPlace: false, review: true, continuation: { retain: true } },
      capabilities: { work_report_transport: "validated" },
      reviewers: [
        {
          providerFamily: "openai",
          adapter: {
            id: "retention-reviewer",
            async discover() {
              return HarnessManifest.parse({
                id: "retention-reviewer",
                display_name: "Reviewer",
                kind: "local_cli",
                provider_family: "openai",
                capabilities: { review: true, read_files: true },
              });
            },
            async doctor() {
              return ConformanceReport.parse({
                harness_id: "retention-reviewer",
                status: "ok",
                enabled_intents: ["review"],
              });
            },
            async *run(spec) {
              const base = { session_id: spec.session_id, ts: new Date().toISOString() };
              yield {
                ...base,
                type: "started",
                observed_model: "review-fixture",
                credential_route: "managed_api_key",
              };
              yield { ...base, type: "message", text: "[]" };
              yield {
                ...base,
                type: "usage",
                usage: { cost_usd: 0.001 },
                credential_route: "managed_api_key",
              };
              reviewed = true;
              yield { ...base, type: "completed" };
            },
          },
        },
      ],
      script: function* ({ spec, emit }) {
        yield emit({ type: "started", payload: { native_session_id: "sid-completed" } });
        writeFileSync(join(spec.cwd, "completed.txt"), "completed candidate\n");
        yield emit({ type: "file_change", payload: { path: "completed.txt" } });
        yield emit({
          type: "message",
          final: true,
          text:
            "Done.\n\n```json\n" +
            JSON.stringify({
              work_report: { state: "completed", required_inputs: [] },
            }) +
            "\n```",
        });
        yield emit({ type: "completed" });
      },
    });
    expect(reviewed).toBe(true);
    expect(o.result.facts).toMatchObject({ lifecycle: "failed", reason: "budget_overshoot" });
    const telemetry = new ArtifactStore(o.root).readYaml<{
      attempts: { outcome: { work_state: { state: string } } }[];
    }>(join(o.result.runDir, "final", "telemetry.yaml"));
    expect(telemetry?.attempts[0]?.outcome.work_state.state).toBe("completed");
    const kept = retainedEnvelopeOfRun(o.result.runDir, o.result.runId);
    expect(kept).not.toBeNull();
    expect(existsSync(join(kept!.envelope.worktree_path, "completed.txt"))).toBe(true);
    expect(o.resumable?.["workspace"]).toEqual({
      kind: "retained_envelope",
      root: kept!.envelope.worktree_path,
    });
  });
});
