/**
 * #299: a native turn ended by the caller's max-turns cap is a typed
 * interruption, never a crash, a transport resume under the same cap, or a
 * complete answer.
 *
 * Each case runs the production chain a Claude or Grok turn takes after the
 * vendor process starts: the core run loop (`runCliHarness`) spawning a real
 * process, the adapter's own parser, and the real Orchestrator lane. The
 * stand-in process prints the frames Claude Code 2.1.316 builds for a capped
 * turn (`subtype: error_max_turns`, `is_error: true`, `errors[]`, no `result`)
 * and exits 1, as that binary does for an `is_error` result.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCapture, runCliHarness, type HarnessAdapter } from "@claudexor/core";
import { readRunEvents } from "@claudexor/event-log";
import { ConformanceReport, HarnessManifest, type HarnessRunSpec } from "@claudexor/schema";
import { createClaudeParser } from "../../harness-claude/src/parse.js";
import {
  withClaudeApiFailureParser,
  withClaudeVendorFailure,
} from "../../harness-claude/src/vendor-failure.js";
import { createGrokParser } from "../../harness-grok/src/parse.js";
import { summarizeThreadPrefix } from "./continuity-summary.js";
import { Orchestrator } from "./orchestrator.js";

const reapDirs: string[] = [];
function reapMk(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  reapDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function initRepo(): Promise<string> {
  const repo = reapMk("claudexor-turn-limit-");
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", [
    "-C",
    repo,
    ...["-c", "user.email=t@t.dev", "-c", "user.name=t"],
    ...["commit", "-m", "init"],
  ]);
  return repo;
}

const PARTIAL = "PARTIAL-FINDING: parse() never checks for a null header";
const CAP = 3;

/** Claude Code 2.1.316's capped result frame (static read of that binary). */
const claudeCapped = {
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  duration_ms: 1200,
  duration_api_ms: 900,
  num_turns: CAP,
  stop_reason: null,
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5 },
  errors: [`Reached maximum number of turns (${CAP})`],
  session_id: "native-capped",
};

function claudeFrames(result: Record<string, unknown>): Record<string, unknown>[] {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: "native-capped",
      claude_code_version: "2.1.316",
      model: "claude-fable-5-1",
    },
    {
      type: "assistant",
      session_id: "native-capped",
      message: {
        id: "msg_1",
        model: "claude-fable-5-1",
        content: [
          { type: "text", text: PARTIAL },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } },
        ],
      },
    },
    {
      type: "user",
      session_id: "native-capped",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "# repo" }] },
    },
    result,
  ];
}

function grokFrames(): Record<string, unknown>[] {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: "grok-capped",
      model: "grok-4.7",
      apiKeySource: "oauth",
      permissionMode: "dontAsk",
      tools: ["read_file", "list_dir", "grep"],
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: PARTIAL }] },
      session_id: "grok-capped",
    },
    {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: CAP,
      errors: ["Maximum turns reached"],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ];
}

/** A real process: optionally writes a partial file, prints the frames, exits. */
function standIn(frames: Record<string, unknown>[], exitCode: number, writes = false): string {
  const script = join(reapMk("claudexor-turn-limit-cli-"), "cli.mjs");
  writeFileSync(
    script,
    [
      'import { writeFileSync } from "node:fs";',
      writes ? 'writeFileSync("partial.txt", "half of the change\\n");' : "",
      `for (const frame of ${JSON.stringify(frames)}) process.stdout.write(JSON.stringify(frame) + "\\n");`,
      `process.exitCode = ${exitCode};`,
    ].join("\n"),
  );
  return script;
}

function cappedAdapter(
  vendor: "claude" | "grok",
  script: string,
  calls: HarnessRunSpec[],
): HarnessAdapter {
  return standInAdapter(`${vendor}-capped`, vendor, () => script, calls);
}

/** The production chain over a stand-in process; `scriptFor` picks each spawn's script. */
function standInAdapter(
  id: string,
  vendor: "claude" | "grok",
  scriptFor: (spec: HarnessRunSpec) => string,
  calls: HarnessRunSpec[],
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capabilities: {
          plan: true,
          implement: true,
          review: true,
          read_files: true,
          max_turns: true,
          web_policy: "none",
        },
        access_profiles_supported: ["readonly", "workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["explain", "audit", "plan", "review", "implement"],
      });
    },
    run(spec) {
      calls.push(spec);
      const parseEvent =
        vendor === "claude"
          ? withClaudeApiFailureParser(createClaudeParser(), null)
          : createGrokParser().parseEvent;
      const stream = runCliHarness({
        bin: process.execPath,
        args: [scriptFor(spec)],
        spec,
        parseEvent,
        label: vendor,
      });
      return vendor === "claude" ? withClaudeVendorFailure(stream) : stream;
    },
  };
}

function terminal(runDir: string) {
  const { events } = readRunEvents(join(runDir, "events.jsonl"));
  const end = events.findLast((e) =>
    ["run.completed", "run.failed", "run.blocked"].includes(e.type),
  );
  return {
    type: end?.type,
    resumable: end?.payload["resumable"] as { cause?: string } | undefined,
    crashes: events.filter(
      (e) =>
        e.type === "harness.event" &&
        e.payload["type"] === "error" &&
        String(e.payload["error"] ?? "").includes("exited with code"),
    ).length,
    // The typed stop is durable run evidence, not only an in-memory flag.
    journaledTurnLimits: events.filter(
      (e) => e.type === "harness.event" && e.payload["turn_limit"] !== undefined,
    ).length,
  };
}

async function capped(
  vendor: "claude" | "grok",
  input: Record<string, unknown>,
  opts: { exitCode?: number; writes?: boolean; result?: Record<string, unknown> } = {},
) {
  const repo = await initRepo();
  const calls: HarnessRunSpec[] = [];
  const frames = vendor === "claude" ? claudeFrames(opts.result ?? claudeCapped) : grokFrames();
  const adapter = cappedAdapter(vendor, standIn(frames, opts.exitCode ?? 1, opts.writes), calls);
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
  }).run({
    repoRoot: repo,
    prompt: "Review parse() for null handling.",
    harnesses: [adapter.id],
    maxTurns: CAP,
    mode: "ask",
    ...input,
  } as Parameters<Orchestrator["run"]>[0]);
  return { result, calls, end: terminal(result.runDir) };
}

/** What the caller can observe of a capped run, as one comparable value. */
function observed(run: Awaited<ReturnType<typeof capped>>) {
  return {
    lifecycle: run.result.lifecycle,
    reason: run.result.facts?.reason ?? null,
    // [max_turns, resume_session_id] of every vendor process the run started.
    invocations: run.calls.map((c) => [c.max_turns, c.resume_session_id ?? null]),
    resumableCause: run.end.resumable?.cause ?? null,
    synthesizedCrashErrors: run.end.crashes,
    journaledTurnLimits: run.end.journaledTurnLimits,
  };
}

const INTERRUPTED = {
  lifecycle: "interrupted",
  reason: "turn_limit_reached",
  invocations: [[CAP, null]],
  resumableCause: "turn_limit",
  synthesizedCrashErrors: 0,
  journaledTurnLimits: 1,
};

describe("#299 a capped turn is a typed interruption with its partial output kept", () => {
  it("Ask: interrupted / turn_limit_reached, one invocation, partial kept only as retained output", async () => {
    const run = await capped("claude", { mode: "ask" });
    // The cap is the caller's decision: no resume or replay under the same cap.
    expect(observed(run)).toEqual(INTERRUPTED);
    // The partial is evidence, never an invented final answer.
    expect(existsSync(join(run.result.runDir, "final", "answer.md"))).toBe(false);
    expect(readFileSync(join(run.result.runDir, "final", "retained-output.md"), "utf8")).toContain(
      PARTIAL,
    );
  });

  it("Agent: the partial change is kept, not adopted, and the run is resumable by turn_limit", async () => {
    // Daemon-owned runs keep stopped work for an explicit continueFrom.
    const run = await capped(
      "claude",
      { mode: "agent", continuation: { retain: true } },
      { writes: true },
    );
    expect(observed(run)).toEqual(INTERRUPTED);
    const kept = run.end.resumable as { workspace?: { kind?: string; root?: string } };
    expect(kept.workspace?.kind).toBe("retained_envelope");
    expect(readFileSync(join(kept.workspace!.root!, "partial.txt"), "utf8")).toBe(
      "half of the change\n",
    );
  });

  it("Plan: interrupted / turn_limit_reached without changing the Plan continuation contract", async () => {
    const run = await capped("claude", { mode: "plan" });
    // The Plan pipeline emits no in-run resumable facts (INV-046 unchanged).
    expect(observed(run)).toEqual({ ...INTERRUPTED, resumableCause: null });
  });

  it("deep scan: every capped scout is an interrupted omission", async () => {
    const run = await capped("claude", { mode: "ask", deepScan: true, n: 1 });
    const { lifecycle, reason, invocations } = observed(run);
    expect({ lifecycle, reason, invocations }).toEqual({
      lifecycle: "interrupted",
      reason: "turn_limit_reached",
      invocations: [[CAP, null]],
    });
  });

  it("Grok's capped result takes the same typed path", async () => {
    expect(observed(await capped("grok", { mode: "ask" }))).toEqual(INTERRUPTED);
  });

  it("class sibling: a context exhaustion that exits non-zero also ends Ask interrupted, once", async () => {
    // Claude labels it `success` with is_error and terminal_reason, then exits 1.
    const exhausted = {
      ...claudeCapped,
      subtype: "success",
      terminal_reason: "prompt_too_long",
      result: "Prompt is too long",
      errors: undefined,
    };
    const { lifecycle, reason, invocations, resumableCause } = observed(
      await capped("claude", { mode: "ask" }, { result: exhausted }),
    );
    expect({ lifecycle, reason, invocations, resumableCause }).toEqual({
      lifecycle: "interrupted",
      reason: "context_capacity_exhausted",
      invocations: [[CAP, null]],
      resumableCause: "context_exhausted",
    });
  });

  it("negative control: another failed result stays an ordinary harness failure", async () => {
    const failed = { ...claudeCapped, subtype: "error_during_execution", errors: ["boom"] };
    const { lifecycle, reason } = observed(
      await capped("claude", { mode: "ask" }, { result: failed }),
    );
    expect({ lifecycle, reason }).toEqual({ lifecycle: "failed", reason: "harness_failed" });
  });

  it("negative control: a successful result under a cap is an ordinary answer", async () => {
    const ok = {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 2,
      result: "Done: parse() is fine.",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const run = await capped("claude", { mode: "ask" }, { result: ok, exitCode: 0 });
    expect(observed(run)).toMatchObject({
      lifecycle: "succeeded",
      invocations: [[CAP, null]],
      synthesizedCrashErrors: 0,
    });
    expect(readFileSync(join(run.result.runDir, "final", "answer.md"), "utf8")).toContain(
      "Done: parse() is fine.",
    );
  });

  it("a capped result whose CLI exits 0 is the same typed stop, never an answer", async () => {
    const run = await capped("claude", { mode: "ask" }, { exitCode: 0 });
    expect(observed(run)).toEqual(INTERRUPTED);
    expect(existsSync(join(run.result.runDir, "final", "answer.md"))).toBe(false);
  });
});

const OK_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: "NEXT-HARNESS-ANSWER",
  usage: { input_tokens: 10, output_tokens: 5 },
};

/** The cap ends the run: no other harness, model or session re-runs the work. */
describe("#299 nothing re-runs a capped attempt implicitly; an explicit continueFrom can", () => {
  async function twoHarnesses(mode: "ask" | "plan") {
    const repo = await initRepo();
    const capCalls: HarnessRunSpec[] = [];
    const nextCalls: HarnessRunSpec[] = [];
    const first = cappedAdapter("claude", standIn(claudeFrames(claudeCapped), 1), capCalls);
    const okScript = standIn(claudeFrames(OK_RESULT), 0);
    const second = standInAdapter("claude-next", "claude", () => okScript, nextCalls);
    const result = await new Orchestrator({
      registry: new Map([
        [first.id, first],
        [second.id, second],
      ]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "Review parse() for null handling.",
      harnesses: [first.id, second.id],
      maxTurns: CAP,
      mode,
    });
    return {
      lifecycle: result.lifecycle,
      reason: result.facts?.reason ?? null,
      capped: capCalls.length,
      next: nextCalls.length,
    };
  }

  it.each(["ask", "plan"] as const)(
    "%s never falls through to the next harness after the cap",
    async (mode) => {
      expect(await twoHarnesses(mode)).toEqual({
        lifecycle: "interrupted",
        reason: "turn_limit_reached",
        capped: 1,
        next: 0,
      });
    },
  );

  it("an explicit continueFrom resumes the capped session, naming the cap as the cause", async () => {
    const repo = await initRepo();
    const calls: HarnessRunSpec[] = [];
    const phase = { current: "predecessor" as "predecessor" | "successor" };
    const scripts = {
      predecessor: standIn(claudeFrames(claudeCapped), 1),
      successor: standIn(claudeFrames(OK_RESULT), 0),
    };
    const adapter = standInAdapter("claude-capped", "claude", () => scripts[phase.current], calls);
    const orchestrator = () =>
      new Orchestrator({ registry: new Map([[adapter.id, adapter]]), reviewers: [] });
    const workOrder = "Review parse() for null handling.";
    const base = { repoRoot: repo, harnesses: [adapter.id], maxTurns: CAP, mode: "ask" as const };
    const pred = await orchestrator().run({
      ...base,
      prompt: workOrder,
      continuation: { retain: true },
    });
    phase.current = "successor";
    const before = calls.length;
    const succ = await orchestrator().run({
      ...base,
      prompt: "Continue the review.",
      continuation: {
        retain: true,
        from: {
          runId: pred.runId,
          runDir: pred.runDir,
          state: pred.lifecycle,
          workOrder,
          preference: "auto",
        },
      },
    });
    const next = calls.slice(before);
    expect({
      predecessor: [pred.lifecycle, pred.facts?.reason],
      successorSpawns: next.map((spec) => spec.resume_session_id ?? null),
      successor: succ.lifecycle,
    }).toEqual({
      predecessor: ["interrupted", "turn_limit_reached"],
      successorSpawns: ["native-capped"],
      successor: "succeeded",
    });
    expect(next[0]!.prompt).toContain("the max-turns limit set for it was reached");
  });
});

/** The thread summary pass reads only errors: a capped pass is no summary. */
describe("#299 the one-turn summary pass never keeps a capped turn's narration", () => {
  const turns = [{ id: "t1", prompt: "earlier question", outputText: "earlier answer" }];
  async function summary(result: Record<string, unknown>, exitCode: number) {
    const calls: HarnessRunSpec[] = [];
    const adapter = cappedAdapter("claude", standIn(claudeFrames(result), exitCode), calls);
    const text = await summarizeThreadPrefix({
      adapter,
      turns,
      cwd: reapMk("claudexor-turn-limit-summary-"),
      env: {},
      credentialProfile: null,
      authPreference: "auto",
      envInheritance: "clean",
    });
    return { text, maxTurns: calls.map((c) => c.max_turns) };
  }

  it.each([1, 0])("capped, exit %i: no summary", async (exitCode) => {
    expect(await summary(claudeCapped, exitCode)).toEqual({ text: null, maxTurns: [1] });
  });

  it("control: a completed pass is the summary", async () => {
    expect(await summary(OK_RESULT, 0)).toEqual({ text: "NEXT-HARNESS-ANSWER", maxTurns: [1] });
  });
});
