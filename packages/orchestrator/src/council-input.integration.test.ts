import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import {
  ConformanceReport,
  CouncilProjection,
  HarnessManifest,
  RunFacts,
  RunFailure,
  RunTelemetry,
  type HarnessRunSpec,
  type HarnessRequestRefusal,
  type RunEvent,
  type WorkReport,
} from "@claudexor/schema";
import { Orchestrator, type RunInput } from "./orchestrator.js";
import { PLAN_WORK_REPORT_GUIDANCE } from "./plan-prompt.js";
import * as plannerAttempt from "./plannerAttempt.js";

const completed: WorkReport = { state: "completed", required_inputs: [] };
const contradiction: WorkReport = {
  state: "completed",
  required_inputs: [
    { kind: "file", locator: "design.md", description: "Need the compatibility decision" },
  ],
};
const originalError = "work_report contract: a completed work_report must not list required_inputs";
const draft =
  "  # Draft\n\nA useful idea with Cyrillic: решение.\n\n## Open Questions\n- [text] Future implementation choice?\n";
const merged = "# Unified plan\n\nUse the available evidence.\n\n## Open Questions\n- (none)";
type Channel = "constrained_json" | "side_tool" | "instructed_fence";
interface Reply {
  requestRefusal?: HarnessRequestRefusal;
  output?: unknown;
  report?: unknown;
  error?: string;
  contextExhausted?: boolean;
  cost?: number;
  beforeResult?: () => Promise<void>;
}
interface Member {
  channel?: Channel;
  draft?: Reply;
  merge?: Reply;
}
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function planner(id: string, member: Member, calls: HarnessRunSpec[]): HarnessAdapter {
  const channel = member.channel ?? "constrained_json";
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "openai",
        capabilities: {
          plan: true,
          work_report_transport: channel === "instructed_fence" ? "validated" : "constrained",
          json_schema_output: channel !== "instructed_fence",
          structured_output_channel: channel === "side_tool" ? "side_tool" : "final_message",
        },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["plan", "synthesize"],
      });
    },
    async *run(spec) {
      calls.push(spec);
      const reply = (spec.intent === "synthesize" ? member.merge : member.draft) ?? {};
      const report = reply.report ?? completed;
      const output = Object.hasOwn(reply, "output")
        ? reply.output
        : spec.intent === "synthesize"
          ? merged
          : draft;
      const base = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield {
        ...base,
        type: "started",
        credential_route: reply.cost === undefined ? "vendor_native" : "managed_api_key",
      };
      await reply.beforeResult?.();
      const text =
        channel === "constrained_json"
          ? JSON.stringify({ output, work_report: report })
          : channel === "instructed_fence"
            ? `${String(output)}\n\n\`\`\`json\n${JSON.stringify({ work_report: report })}\n\`\`\``
            : String(output);
      yield {
        ...base,
        type: "message",
        final: true,
        text,
        ...(channel === "side_tool" ? { payload: { work_report_side_tool: report } } : {}),
      };
      if (reply.error)
        yield {
          ...base,
          type: "error",
          error: reply.error,
          ...(reply.requestRefusal ? { request_refusal: reply.requestRefusal } : {}),
        };
      if (reply.contextExhausted)
        yield {
          ...base,
          type: "context",
          context: {
            kind: "capacity_exhausted",
            cause: "window_exceeded",
            native_code: null,
            trigger: "auto",
            pre_tokens: null,
          },
        };
      if (reply.cost !== undefined)
        yield { ...base, type: "usage", usage: { cost_usd: reply.cost, estimated: false } };
      yield { ...base, type: "completed" };
    },
  };
}

async function runCouncil(members: Member[], extra: Partial<RunInput> = {}) {
  const root = mkdtempSync(join(tmpdir(), "claudexor-council-input-"));
  roots.push(root);
  writeFileSync(join(root, "README.md"), "# Isolated test repository\n");
  const calls: HarnessRunSpec[] = [];
  const events: RunEvent[] = [];
  const registry = new Map(
    members.map((member, index) => {
      const id = `planner-${index + 1}`;
      return [id, planner(id, member, calls)] as const;
    }),
  );
  const result = await new Orchestrator({ registry, reviewers: [] }).run({
    repoRoot: root,
    prompt: "Prepare the current plan",
    mode: "plan",
    council: true,
    harnesses: [...registry.keys()],
    primaryHarness: "planner-1",
    paidBudget: { kind: "unlimited" },
    ...extra,
    onEvent(event) {
      events.push(event);
      extra.onEvent?.(event);
    },
  });
  const store = new ArtifactStore(root);
  const read = (path: string) => store.readYaml(join(result.runDir, path));
  return {
    result,
    calls,
    events,
    read,
    text: (path: string) => readFileSync(join(result.runDir, path), "utf8"),
    exists: (path: string) => existsSync(join(result.runDir, path)),
    facts: RunFacts.parse(read("final/run_facts.yaml")),
    get telemetry() {
      return RunTelemetry.parse(read("final/telemetry.yaml"));
    },
  };
}

describe("Council retains contradictory input through real planner attempts (#214)", () => {
  it("keeps successful drafts while projecting the merge attempt's typed input refusal", async () => {
    const refusal: HarnessRequestRefusal = {
      kind: "input_too_large",
      scope: "turn_text",
      unit: "unicode_scalars",
      limit: 10,
      actual: 11,
      source: "fixture.turn/start",
      native_code: "input_too_large",
    };
    const run = await runCouncil([
      { merge: { output: "", error: "input refused", requestRefusal: refusal } },
      {},
    ]);
    expect(run.calls.map((call) => call.intent)).toEqual(["plan", "plan", "synthesize"]);
    expect(run.result.lifecycle).toBe("failed");
    expect(RunFailure.parse(run.read("final/failure.yaml"))).toMatchObject({
      category: "validation",
      code: "input_too_large",
      requestRefusal: refusal,
      resetsAt: null,
    });
    expect(run.text("council/draft-planner-1.md")).toBe(draft);
    expect(run.text("council/draft-planner-2.md")).toBe(draft);
    expect(run.text("final/failure.yaml")).not.toContain("Retry the run");
  });

  it.each<Channel>(["constrained_json", "side_tool"])(
    "%s preserves the extracted draft and original claim without accepting the attempt",
    async (channel) => {
      const run = await runCouncil([{ channel, draft: { report: contradiction } }, {}]);
      expect(run.result.lifecycle).toBe("succeeded");
      expect(run.text("council/draft-planner-1.md")).toBe(draft);
      expect(run.read("attempts/p01/council-input.yaml")).toMatchObject({
        attempt_id: "p01",
        harness_id: "planner-1",
        status: "failed",
        outcome_class: "contract_failure",
        error: originalError,
        harness_failed_before_report: false,
        work_state: { state: "unverified" },
        report_problem: { kind: "completed_with_required_inputs", reported: contradiction },
        draft_path: "council/draft-planner-1.md",
      });
      const council = CouncilProjection.parse(run.read("council/membership.yaml"));
      expect(council).toMatchObject({
        drafted: 1,
        requested: 2,
        degraded: true,
        mergedBy: "planner-2",
      });
      expect(council.members[0]).toMatchObject({
        status: "failed",
        error: `${originalError}\nUnverified draft retained for the merge: council/draft-planner-1.md`,
      });
      expect(
        run.events.filter((e) => e.type === "council.draft").map((e) => e.payload["harness_id"]),
      ).toEqual(["planner-2"]);
      expect(run.events.find((e) => e.type === "council.member.failed")?.payload).toMatchObject({
        error: originalError,
        unverified_draft_path: "council/draft-planner-1.md",
      });
      expect(run.telemetry.attempts[0]?.outcome).toMatchObject({
        status: "failed",
        deliverable_present: false,
        work_state: { state: "unverified" },
      });
      expect(run.facts.participants).toMatchObject({
        planners: 2,
        attempts: [
          { attempt_id: "p01", role: "planner", status: "failed", deliverable_present: false },
          { attempt_id: "p02", role: "planner", status: "success", deliverable_present: true },
          { attempt_id: "p03", role: "merge", status: "success", deliverable_present: true },
        ],
      });
      expect(run.telemetry.final_attempt_id).toBe("p03");
      expect(run.read("final/work_product.yaml")).toMatchObject({
        producer_attempt_id: "p03",
        meta: { planners: 2 },
      });
      expect(run.calls).toHaveLength(3);
      expect(run.calls.every((call) => call.prompt.includes(PLAN_WORK_REPORT_GUIDANCE))).toBe(true);
      const mergeCall = run.calls.find((call) => call.intent === "synthesize");
      expect(mergeCall?.prompt).toContain("planner-1 (UNVERIFIED)");
      expect(mergeCall?.prompt).toContain("attempts/p01/council-input.yaml");
      expect(mergeCall?.prompt).not.toContain(draft);
      expect(run.text("final/summary.md")).toContain(
        "1 contract-accepted draft(s), 1 unverified draft(s)",
      );
      expect(run.text("final/plan.md")).toBe(`${merged}\n`);
    },
  );

  it("instructed_fence: a contradictory footer is an accepted draft with an unverified work_state (owner decision 2026-10-05)", async () => {
    // The instructed fence is a request, not a native constraint: a broken
    // footer never fails the planner attempt. The draft is accepted whole, the
    // work_state discloses the cause, and the contradiction claim stays evidence.
    const run = await runCouncil([
      { channel: "instructed_fence", draft: { report: contradiction } },
      {},
    ]);
    expect(run.result.lifecycle).toBe("succeeded");
    // Nothing is cut on a footer problem: the merger reads the model's reply
    // byte for byte, the contradictory footer included.
    expect(run.text("council/draft-planner-1.md")).toBe(
      `${draft}\n\n\`\`\`json\n${JSON.stringify({ work_report: contradiction })}\n\`\`\``,
    );
    expect(run.read("attempts/p01/council-input.yaml")).toMatchObject({
      attempt_id: "p01",
      harness_id: "planner-1",
      status: "success",
      outcome_class: "clean",
      error: null,
      harness_failed_before_report: false,
      work_state: {
        state: "unverified",
        source: "validated",
        unverified_reason: "report_contradictory",
      },
      report_problem: { kind: "completed_with_required_inputs", reported: contradiction },
      draft_path: "council/draft-planner-1.md",
    });
    const council = CouncilProjection.parse(run.read("council/membership.yaml"));
    expect(council).toMatchObject({
      drafted: 2,
      requested: 2,
      degraded: false,
      mergedBy: "planner-1",
    });
    // planner-1 (the first accepted draft in primary order) is also the merger.
    expect(council.members.map((member) => member.status)).toEqual(["merged", "drafted"]);
    expect(
      run.events.filter((e) => e.type === "council.draft").map((e) => e.payload["harness_id"]),
    ).toEqual(["planner-1", "planner-2"]);
    expect(run.events.some((e) => e.type === "council.member.failed")).toBe(false);
    expect(run.telemetry.attempts[0]?.outcome).toMatchObject({
      status: "success",
      deliverable_present: true,
      work_state: {
        state: "unverified",
        source: "validated",
        unverified_reason: "report_contradictory",
      },
    });
    expect(run.facts.participants.attempts.map((a) => a.status)).toEqual([
      "success",
      "success",
      "success",
    ]);
    const mergeCall = run.calls.find((call) => call.intent === "synthesize");
    expect(mergeCall?.prompt).toContain("planner-1 (ordinary)");
    expect(mergeCall?.prompt).not.toContain("planner-1 (UNVERIFIED)");
    expect(run.text("final/summary.md")).toContain(
      "2 contract-accepted draft(s), 0 unverified draft(s)",
    );
    expect(run.text("final/plan.md")).toBe(`${merged}\n`);
  });

  it("merges all contradictory drafts once without turning the merger's failed draft into merged", async () => {
    const run = await runCouncil([
      { draft: { report: contradiction } },
      { draft: { report: contradiction } },
    ]);
    expect(run.result.lifecycle).toBe("succeeded");
    expect(CouncilProjection.parse(run.read("council/membership.yaml"))).toMatchObject({
      drafted: 0,
      degraded: true,
      mergedBy: "planner-1",
      members: [{ status: "failed" }, { status: "failed" }],
    });
    expect(run.calls.filter((c) => c.intent === "synthesize")).toHaveLength(1);
    expect(run.events.some((e) => e.type === "council.draft")).toBe(false);
    expect(run.facts.participants.planners).toBe(2);
    expect(run.facts.participants.attempts.map((a) => a.status)).toEqual([
      "failed",
      "failed",
      "success",
    ]);
    expect(run.result.summary).toContain("0 contract-accepted draft(s), 2 unverified draft(s)");
  });

  it("retains every byte of a long extracted draft without embedding it in the merge prompt", async () => {
    const output = `${draft}\n${"Detailed repository analysis stays available.\n".repeat(12_000)}FINAL SOURCE LINE\n`;
    const run = await runCouncil([{ draft: { report: contradiction, output } }]);
    expect(run.text("council/draft-planner-1.md")).toBe(output);
    expect(run.calls.find((call) => call.intent === "synthesize")?.prompt).not.toContain(
      "FINAL SOURCE LINE",
    );
    expect(run.read("attempts/p01/council-input.yaml")).not.toHaveProperty("text");
  });

  it.each([
    { name: "empty contradiction", reply: { report: contradiction, output: " \n " } },
    {
      name: "non-string output",
      reply: { report: contradiction, output: { idea: "cannot coerce this" } },
    },
    { name: "missing output", reply: { report: contradiction, output: undefined } },
    { name: "unknown work state", reply: { report: { state: "bogus", required_inputs: [] } } },
    {
      name: "needs_input without inputs",
      reply: { report: { state: "needs_input", required_inputs: [] } },
    },
    {
      name: "real transport failure with text",
      reply: { report: contradiction, error: "transport disconnected" },
    },
    { name: "empty ordinary draft", reply: { output: "" } },
    { name: "context exhaustion", reply: { report: contradiction, contextExhausted: true } },
  ])("$name cannot create a usable unverified input", async ({ reply }) => {
    const run = await runCouncil([{ draft: reply }, { draft: reply }]);
    expect(run.result.lifecycle).toBe(reply.contextExhausted ? "interrupted" : "failed");
    expect(run.calls).toHaveLength(2);
    expect(run.exists("council/draft-planner-1.md")).toBe(false);
    expect(run.exists("council/membership.yaml")).toBe(false);
    expect(run.exists("final/plan.md")).toBe(false);
    expect(run.facts.participants.planners).toBe(2);
    expect(run.facts.participants.attempts).toHaveLength(2);
    expect(
      run.facts.participants.attempts.every((a) => a.role === "planner" && a.status === "failed"),
    ).toBe(true);
    if (reply.error) expect(run.text("final/failure.yaml")).toContain(reply.error);
  });

  it.each(["needs_input", "incomplete"] as const)(
    "preserves genuine %s inputs and the final merger veto",
    async (state) => {
      const report = { ...contradiction, state };
      const run = await runCouncil([{ draft: { report }, merge: { report } }]);
      expect(run.result.lifecycle).toBe("succeeded");
      expect(run.result.facts.work_state).toMatchObject(report);
      expect(run.read("attempts/p01/council-input.yaml")).toMatchObject({
        status: "success",
        work_state: report,
      });
      expect(run.facts.outcome.work_state).toMatchObject(report);
      expect(run.events.some((e) => e.type === "run.blocked")).toBe(true);
      expect(run.calls).toHaveLength(2);
    },
  );

  it.each([
    { name: "contradictory report", reply: { report: contradiction } },
    { name: "malformed report", reply: { report: { state: "invalid" } } },
    { name: "empty output", reply: { output: "" } },
    { name: "transport error", reply: { error: "merge failed on transport" } },
    { name: "context exhaustion", reply: { report: contradiction, contextExhausted: true } },
  ])(
    "failed merger ($name) never substitutes a retained draft for final/plan.md",
    async ({ reply }) => {
      const run = await runCouncil([{ draft: { report: contradiction }, merge: reply }]);
      expect(run.result.lifecycle).toBe(reply.contextExhausted ? "interrupted" : "failed");
      expect(run.exists("final/plan.md")).toBe(false);
      expect(run.text("council/draft-planner-1.md")).toBe(draft);
      expect(run.result.summary).toContain("p01/planner-1");
      expect(run.result.summary).toContain("p02/planner-1");
      expect(run.result.summary).toContain("council/draft-planner-1.md (UNVERIFIED)");
      expect(run.calls).toHaveLength(2);
    },
  );

  it("cancellation before merge preserves staged inputs and starts no synthesis", async () => {
    const abort = new AbortController();
    const run = await runCouncil([{ draft: { report: contradiction } }, {}], {
      signal: abort.signal,
      onEvent(event) {
        if (event.type === "council.member.failed") abort.abort();
      },
    });
    expect(run.result.lifecycle).toBe("cancelled");
    expect(run.calls).toHaveLength(2);
    expect(run.exists("council/draft-planner-1.md")).toBe(true);
    expect(run.exists("attempts/p01/council-input.yaml")).toBe(true);
    expect(run.exists("final/plan.md")).toBe(false);
  });

  it("budget refusal before merge retains inputs without another physical call", async () => {
    const run = await runCouncil([{ draft: { report: contradiction, cost: 1 } }], {
      paidBudget: { kind: "finite", maxUsd: 0.5 },
    });
    expect(run.result.lifecycle).toBe("failed");
    expect(run.result.facts.reason).toBe("budget_exhausted");
    expect(run.calls).toHaveLength(1);
    expect(run.exists("council/draft-planner-1.md")).toBe(true);
    expect(run.exists("final/plan.md")).toBe(false);
    expect(run.text("final/failure.yaml")).toContain("budget");
    expect(run.read("final/failure.yaml")).toMatchObject({ code: "hard_cap", attemptId: "p02" });
    expect(run.result.summary).toContain("council/draft-planner-1.md (UNVERIFIED)");
  });

  it("a failed nominal primary uses the first remaining admitted lane", async () => {
    const run = await runCouncil([
      { draft: { error: "primary process crashed" } },
      { draft: { report: contradiction } },
    ]);
    expect(run.result.lifecycle).toBe("succeeded");
    expect(CouncilProjection.parse(run.read("council/membership.yaml"))).toMatchObject({
      drafted: 0,
      mergedBy: "planner-2",
    });
    expect(run.calls).toHaveLength(3);
  });

  it("a metadata write failure excludes only that input after every sibling has finished", async () => {
    const writeYaml = ArtifactStore.prototype.writeYaml;
    let siblingDone = false;
    vi.spyOn(ArtifactStore.prototype, "writeYaml").mockImplementation(function (
      this: ArtifactStore,
      path,
      value,
    ) {
      if (path.endsWith(join("p01", "council-input.yaml"))) {
        expect(siblingDone).toBe(true);
        throw new Error("fixture metadata write refused");
      }
      return writeYaml.call(this, path, value);
    });
    const run = await runCouncil([
      { draft: { report: contradiction } },
      {
        draft: {
          beforeResult: async () => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            siblingDone = true;
          },
        },
      },
    ]);
    expect(run.result.lifecycle).toBe("succeeded");
    const prompt = run.calls.find((c) => c.intent === "synthesize")?.prompt ?? "";
    expect(prompt).not.toContain("draft-planner-1.md");
    expect(prompt).toContain("draft-planner-2.md");
    expect(
      CouncilProjection.parse(run.read("council/membership.yaml")).members[0]?.error,
    ).toContain("fixture metadata write refused");
    expect(run.events.find((e) => e.type === "council.member.failed")?.payload).not.toHaveProperty(
      "unverified_draft_path",
    );
  });

  it("unexpected planner rejection drains siblings and preserves their draft before failing the run", async () => {
    const original = plannerAttempt.runPlannerAttempt;
    let siblingFinished = false;
    vi.spyOn(plannerAttempt, "runPlannerAttempt").mockImplementation((deps, args) =>
      args.attemptId === "p01"
        ? Promise.reject(new Error("unexpected event persistence failure"))
        : original(deps, args),
    );
    const run = await runCouncil([
      {},
      {
        draft: {
          beforeResult: async () => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            siblingFinished = true;
          },
        },
      },
    ]);
    expect(siblingFinished).toBe(true);
    expect(run.result.lifecycle).toBe("failed");
    expect(run.exists("council/draft-planner-2.md")).toBe(true);
    expect(run.calls.some((call) => call.intent === "synthesize")).toBe(false);
    expect(run.text("final/failure.yaml")).toContain("unexpected event persistence failure");
  });

  it("solo planning receives the same completion guidance and still fails a contradictory report", async () => {
    const run = await runCouncil([{ draft: { report: contradiction } }], { council: false });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.prompt).toContain(PLAN_WORK_REPORT_GUIDANCE);
    expect(run.result.lifecycle).toBe("failed");
    expect(run.exists("final/plan.md")).toBe(false);
  });
});
