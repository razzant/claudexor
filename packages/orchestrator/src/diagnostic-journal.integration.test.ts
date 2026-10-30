import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { runCapture } from "@claudexor/core";
import { ConformanceReport, HarnessManifest, type HarnessEvent } from "@claudexor/schema";
import { codexTerminalEvents } from "../../harness-codex/src/app-server-threads.js";
import { parseAgyEvent } from "../../harness-agy/src/parse.js";
import { createClaudeParser } from "../../harness-claude/src/parse.js";
import { codexAppServerEvents } from "../../harness-codex/src/app-server-protocol.js";
import { parseCodexEvent } from "../../harness-codex/src/parse.js";
import { createGrokParser } from "../../harness-grok/src/parse.js";
import { parseOpenCodeEvent } from "../../harness-opencode/src/parse.js";
import {
  withClaudeApiFailureParser,
  withClaudeVendorFailure,
} from "../../harness-claude/src/vendor-failure.js";
import { Orchestrator } from "./orchestrator.js";

// Every journal that persists harness events (the run's events.jsonl and the
// attempt journals of planner and read-only attempts) masks diagnostics — the
// adapter's native error object included — while the model's working text is
// kept byte-exact (INV-146). The vendor failure comes from the real Codex
// terminal-failure producer. Synthetic token-shaped values only, assembled at
// runtime.

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
  const repo = reapMk("claudexor-diagnostic-journal-");
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

const VENDOR_SECRET = ["sk-proj", "V3nd0rDiagnosticOnly", "q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Y"].join(
  "-",
);
const WORKING_SECRET = ["ghp", "W0rkingContent7Lm2Xv9Rk4Tz8Nw3Bp6Hs1J"].join("_");
const WORKING_TEXT = `Fixture for the auth test: const token = "${WORKING_SECRET}";`;

type Lane = "ask" | "agent" | "plan";

function stubAdapter(lane: Lane): HarnessAdapter {
  const id = "stub";
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capabilities:
          lane === "agent" ? { implement: true } : { plan: true, review: true, read_files: true },
        access_profiles_supported: [lane === "agent" ? "workspace_write" : "readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: lane === "agent" ? ["implement"] : ["explain", "audit", "plan", "review"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      yield { type: "message", session_id: spec.session_id, ts, text: WORKING_TEXT };
      // The real Codex app-server terminal producer for a failed turn: its
      // error event carries the native error object as `payload`.
      const failed = codexTerminalEvents({
        pendingTerminal: {
          status: "failed",
          error: { message: `upstream rejected the request authorized by ${VENDOR_SECRET}` },
        },
        systemError: false,
        sessionId: spec.session_id,
        parseState: {},
      });
      for (const event of failed.events) yield event;
      yield {
        type: "completed",
        session_id: spec.session_id,
        ts,
        payload: {
          vendor_failure: { code: "auth", message: `key ${VENDOR_SECRET}`, source: "fixture" },
        },
      };
    },
  };
}

function journals(runDir: string): string[] {
  const files = [join(runDir, "events.jsonl")];
  const attempts = join(runDir, "attempts");
  if (existsSync(attempts))
    for (const attempt of readdirSync(attempts)) {
      const path = join(attempts, attempt, "events.jsonl");
      if (existsSync(path)) files.push(path);
    }
  return files.filter((path) => existsSync(path));
}

describe("harness event journals mask diagnostics, never working content (INV-146)", () => {
  it.each(["agent", "ask", "plan"] as const)(
    "%s: no journal holds the vendor's credential-shaped error; the working text stays exact",
    async (lane) => {
      const repo = await initRepo();
      const res = await new Orchestrator({
        registry: new Map([["stub", stubAdapter(lane)]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: lane === "ask" ? "explain the fixture" : "do it",
        mode: lane,
        harnesses: ["stub"],
      });
      const files = journals(res.runDir);
      // The main journal always exists; ask and plan also keep attempt journals.
      expect(files.length).toBeGreaterThanOrEqual(lane === "agent" ? 1 : 2);
      const all = files.map((path) => readFileSync(path, "utf8")).join("\n");
      expect(all).toContain("upstream rejected the request authorized by");
      expect(all).not.toContain(VENDOR_SECRET);
      expect(all).toContain(JSON.stringify(WORKING_TEXT).slice(1, -1));
      for (const path of files)
        if (path !== join(res.runDir, "events.jsonl"))
          expect(readFileSync(path, "utf8")).toContain(JSON.stringify(WORKING_TEXT).slice(1, -1));
    },
    30_000,
  );
});

// The Claude adapter's own stream path: the real stream parser behind the
// API-failure wrapper, then the vendor-failure wrapper, as index.ts composes
// them. A native API failure arrives as a `result` frame whose `result` prose is
// the vendor's diagnostic; a successful result and a non-API-failure result
// (max turns: the prose is partial work) are working content.
const CLAUDE_VENDOR_SECRET = [
  "sk-ant-api03",
  "Cl4udeApiFailure7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc",
].join("-");
const CLAUDE_CONTEXT_SECRET = [
  "sk-ant-api03",
  "Cl4udeContextTerminal7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0",
].join("-");
const CLAUDE_ANSWER = `Fixture plan: set ANTHROPIC_API_KEY=${["sk-ant-api03", "Cl4udeWorkingAnswer7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0"].join("-")} in the test env.`;
const CLAUDE_PARTIAL = `Partial work so far: const key = "${["sk-ant-api03", "Cl4udePartialWork7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc"].join("-")}";`;

function claudeResult(frame: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "result",
    session_id: "native-claude",
    duration_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    ...frame,
  };
}

function claudeStreamAdapter(
  result: Record<string, unknown>,
  failedExit: boolean,
  before: Record<string, unknown>[] = [],
): HarnessAdapter {
  const id = "claude-stream";
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capabilities: { plan: true, review: true, read_files: true },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["explain", "audit", "plan", "review"],
      });
    },
    run(spec) {
      const parse = withClaudeApiFailureParser(createClaudeParser(), null);
      const frames = [
        {
          type: "system",
          subtype: "init",
          session_id: "native-claude",
          claude_code_version: "2.1.288",
          model: "claude-fable-5-1",
        },
        ...before,
        claudeResult(result),
      ];
      async function* stream() {
        const ts = new Date().toISOString();
        yield { type: "started" as const, session_id: spec.session_id, ts };
        for (const frame of frames)
          for (const event of parse(frame, spec.session_id) ?? []) yield event;
        // The CLI run loop's exit record: a failed exit with a harness-reported error.
        yield {
          type: "completed" as const,
          session_id: spec.session_id,
          ts,
          payload: failedExit ? { exit_code: 1, harness_reported_error: true } : { exit_code: 0 },
        };
      }
      return withClaudeVendorFailure(stream());
    },
  };
}

async function planJournals(adapter: HarnessAdapter) {
  const repo = await initRepo();
  const res = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
  }).run({ repoRoot: repo, prompt: "plan the fixture", mode: "plan", harnesses: [adapter.id] });
  const files = journals(res.runDir);
  const outcome = {
    lifecycle: res.lifecycle,
    reason: res.facts.reason,
    candidates: res.candidates,
  };
  return { files, all: files.map((path) => readFileSync(path, "utf8")).join("\n"), outcome };
}

const inJson = (text: string) => JSON.stringify(text).slice(1, -1);

describe("Claude API-failure prose is a diagnostic in every journal (INV-146)", () => {
  it("masks the API-failure prose in the CLI's synthetic turn and the result's status copy", async () => {
    const prose = `API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key ${CLAUDE_VENDOR_SECRET}"}}`;
    const { files, all } = await planJournals(
      claudeStreamAdapter(
        { subtype: "success", is_error: true, api_error_status: 401, result: prose },
        true,
        [
          // The CLI's own API-error turn, as recorded in fixtures/signals.
          {
            type: "assistant",
            session_id: "native-claude",
            error: "authentication_failed",
            is_api_error_message: true,
            message: {
              id: "synthetic-1",
              type: "message",
              role: "assistant",
              model: "<synthetic>",
              content: [{ type: "text", text: prose }],
            },
          },
        ],
      ),
    );
    // The run's events.jsonl and the planner attempt's journal.
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(all).toContain("API Error: 401");
    expect(all).toContain("non_success_result");
    expect(all).not.toContain(CLAUDE_VENDOR_SECRET);
  }, 30_000);

  it("masks a context-terminal API failure's prose and keeps its context outcome", async () => {
    // The recorded prompt_too_long shape (fixtures/signals/terminal-prompt-too-long.jsonl).
    const contextTerminal = (prose: string) =>
      claudeStreamAdapter(
        {
          subtype: "success",
          is_error: true,
          api_error_status: 400,
          terminal_reason: "prompt_too_long",
          result: prose,
        },
        true,
        [
          {
            type: "assistant",
            session_id: "native-claude",
            error: "invalid_request",
            is_api_error_message: true,
            message: {
              id: "synthetic-2",
              type: "message",
              role: "assistant",
              model: "<synthetic>",
              content: [{ type: "text", text: prose }],
            },
          },
        ],
      );
    const leaked = await planJournals(
      contextTerminal(`Prompt is too long; request authorized by ${CLAUDE_CONTEXT_SECRET}`),
    );
    const plain = await planJournals(contextTerminal("Prompt is too long; plain fixture prose"));
    expect(leaked.files.length).toBeGreaterThanOrEqual(2);
    expect(leaked.all).toContain("Prompt is too long; request authorized by");
    expect(leaked.all).not.toContain(CLAUDE_CONTEXT_SECRET);
    // The context owner is unchanged: its signal is journaled, no API error is added.
    expect(leaked.all).toContain('"cause":"prompt_too_long"');
    expect(leaked.all).not.toContain("api_error_status");
    expect(leaked.outcome).toEqual(plain.outcome);
    expect(leaked.outcome).toMatchObject({
      lifecycle: "interrupted",
      reason: "context_capacity_exhausted",
    });
  }, 60_000);

  it("keeps a successful Claude answer exact", async () => {
    const { files, all } = await planJournals(
      claudeStreamAdapter({ subtype: "success", is_error: false, result: CLAUDE_ANSWER }, false),
    );
    expect(all).toContain(inJson(CLAUDE_ANSWER));
    for (const path of files) expect(readFileSync(path, "utf8")).toContain(inJson(CLAUDE_ANSWER));
  }, 30_000);

  it("keeps the partial output of a non-API-failure result exact", async () => {
    const { files, all } = await planJournals(
      claudeStreamAdapter(
        { subtype: "error_max_turns", is_error: true, result: CLAUDE_PARTIAL },
        false,
      ),
    );
    expect(all).toContain("non_success_result");
    for (const path of files) expect(readFileSync(path, "utf8")).toContain(inJson(CLAUDE_PARTIAL));
  }, 30_000);
});

// Tool output is what the model saw, and for a completed tool its bounded
// summary is the only copy Claudexor keeps: it stays exact in the run's
// journal (INV-146). Each producer is the adapter's real parser over native
// frames; the value is a short synthetic credential-shaped fixture.
const TOOL_SECRET = ["ghp", "T00lOutput7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Y"].join("_");
const TOOL_OUTPUT = `token=${TOOL_SECRET}\n`;
const mcpResult = { content: [{ type: "text", text: TOOL_OUTPUT }] };
const toolProducers: Record<string, (sid: string) => HarnessEvent[]> = {
  "claude tool_result": (sid) => {
    const parse = createClaudeParser();
    const use = { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat fixture" } };
    const result = {
      type: "tool_result",
      tool_use_id: "t1",
      content: [{ type: "text", text: TOOL_OUTPUT }],
    };
    return [
      ...(parse({ type: "assistant", message: { content: [use] } }, sid) ?? []),
      ...(parse({ type: "user", message: { content: [result] } }, sid) ?? []),
    ];
  },
  "codex exec command": (sid) =>
    parseCodexEvent(
      {
        type: "item.completed",
        item: {
          id: "c1",
          type: "command_execution",
          command: "cat fixture",
          aggregated_output: TOOL_OUTPUT,
          exit_code: 0,
          status: "completed",
        },
      },
      sid,
      {},
    ) ?? [],
  "codex exec mcp": (sid) =>
    parseCodexEvent(
      {
        type: "item.completed",
        item: {
          id: "m1",
          type: "mcp_tool_call",
          server: "fixture",
          tool: "read",
          status: "completed",
          result: mcpResult,
        },
      },
      sid,
      {},
    ) ?? [],
  "codex app-server command": (sid) =>
    codexAppServerEvents(
      {
        method: "item/completed",
        params: {
          item: {
            id: "a1",
            type: "commandExecution",
            command: "cat fixture",
            aggregatedOutput: TOOL_OUTPUT,
            exitCode: 0,
            status: "completed",
          },
        },
      },
      sid,
      {},
    ) ?? [],
  "codex app-server mcp": (sid) =>
    codexAppServerEvents(
      {
        method: "item/completed",
        params: {
          item: {
            id: "a2",
            type: "mcpToolCall",
            server: "fixture",
            tool: "read",
            status: "completed",
            result: mcpResult,
          },
        },
      },
      sid,
      {},
    ) ?? [],
  "grok tool_result": (sid) => {
    const { parseEvent } = createGrokParser();
    const use = { type: "tool_use", id: "g1", name: "bash", input: { command: "cat fixture" } };
    const result = {
      type: "tool_result",
      tool_use_id: "g1",
      content: TOOL_OUTPUT,
      is_error: false,
    };
    return [
      ...(parseEvent({ type: "assistant", message: { content: [use] } }, sid) ?? []),
      ...(parseEvent({ type: "user", message: { content: [result] } }, sid) ?? []),
    ];
  },
  "agy tool DONE": (sid) =>
    parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "DONE",
          step_index: 1,
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "cat fixture" },
            output: TOOL_OUTPUT,
          },
        },
      },
      sid,
    ) ?? [],
  "codex exec mcp failure (the tool's own error output)": (sid) =>
    parseCodexEvent(
      {
        type: "item.completed",
        item: {
          id: "m2",
          type: "mcp_tool_call",
          server: "fixture",
          tool: "read",
          status: "failed",
          error: { message: TOOL_OUTPUT },
        },
      },
      sid,
      {},
    ) ?? [],
  "opencode tool failure (the tool's own error output)": (sid) =>
    parseOpenCodeEvent(
      {
        type: "tool",
        tool: "bash",
        status: "error",
        args: { command: "cat fixture" },
        error: TOOL_OUTPUT,
      },
      sid,
    ) ?? [],
  "opencode tool completed": (sid) =>
    parseOpenCodeEvent(
      {
        type: "tool",
        tool: "bash",
        status: "completed",
        args: { command: "cat fixture" },
        output: TOOL_OUTPUT,
      },
      sid,
    ) ?? [],
};

function toolOutputAdapter(produce: (sid: string) => HarnessEvent[]): HarnessAdapter {
  const id = "tool-output";
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capabilities: { implement: true },
        access_profiles_supported: ["workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["implement"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      for (const event of produce(spec.session_id)) yield event;
      yield {
        type: "message",
        session_id: spec.session_id,
        ts,
        text: "Checked the fixture.",
        final: true,
      };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

describe("a tool's output stays exact in the run's journal (INV-146)", () => {
  it.each(Object.keys(toolProducers))(
    "%s: the short credential-shaped output survives in events.jsonl",
    async (name) => {
      const repo = await initRepo();
      const res = await new Orchestrator({
        registry: new Map([["tool-output", toolOutputAdapter(toolProducers[name]!)]]),
        reviewers: [],
      }).run({ repoRoot: repo, prompt: "do it", mode: "agent", harnesses: ["tool-output"] });
      const rows = readFileSync(join(res.runDir, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload?: Record<string, any> });
      const summaries = rows
        .filter((row) => row.type === "harness.event" && row.payload?.["type"] === "tool_result")
        .map((row) =>
          [
            row.payload?.["tool"]?.["content_summary"],
            row.payload?.["tool"]?.["error_summary"],
          ].join(" "),
        );
      expect(
        summaries.some((summary) => summary.includes(`token=${TOOL_SECRET}`)),
        name,
      ).toBe(true);
    },
    30_000,
  );
});
