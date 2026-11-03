/** Actual AGY parser -> CLI run loop -> adapter -> Orchestrator, on SYNTHETIC
 * vendor frames: neutral fixture text, not a recording of any CLI version. Only
 * the vendor executable and admission probes are replaced; no normalized event
 * is injected. Each spawn replays its own frame file (the last one repeats). */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliRunLoopOptions, HarnessAdapter } from "@claudexor/core";
import {
  ConformanceReport,
  CredentialProfile,
  HarnessManifest,
  RunFailure,
  type HarnessEvent,
  type RunEvent,
} from "@claudexor/schema";
import { ArtifactStore } from "@claudexor/artifact-store";
import { createAgyAdapter } from "../../harness-agy/src/index.js";
import { Orchestrator, type RunInput } from "./orchestrator.js";

const fixture = vi.hoisted(() => ({ files: [] as string[], spawns: [] as CliRunLoopOptions[] }));
vi.mock("@claudexor/core", async (original) => {
  const actual = await original<typeof import("@claudexor/core")>();
  return {
    ...actual,
    runCliHarness: (options: CliRunLoopOptions) => {
      const file = fixture.files[Math.min(fixture.spawns.length, fixture.files.length - 1)]!;
      fixture.spawns.push(options);
      return actual.runCliHarness({
        ...options,
        bin: process.execPath,
        // A frame `{__stderr}` is a vendor stderr line and `{__exit}` the exit code.
        args: [
          "-e",
          `const fs = require('node:fs'); fs.readFileSync(0);
           for (const frame of JSON.parse(fs.readFileSync(process.argv[1], 'utf8')))
             if (typeof frame.__stderr === 'string') process.stderr.write(frame.__stderr + '\\n');
             else if (typeof frame.__exit === 'number') process.exitCode = frame.__exit;
             else process.stdout.write(JSON.stringify(frame) + '\\n');`,
          file,
        ],
      });
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  fixture.spawns.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const init = (conversation?: string) => ({
  event: "init",
  ...(conversation ? { conversation_id: conversation } : {}),
  init: { model: "gemini-fixture", tools: [] },
});
const viewTool = (index: number) =>
  (["ACTIVE", "DONE"] as const).map((state) => ({
    event: "step_update",
    step_update: {
      step_index: index,
      step_type: "tool",
      state,
      tool_info: {
        name: "view_file",
        parameters: { AbsolutePath: "/fixture/notes.md" },
        ...(state === "DONE" ? { output: "3 lines" } : {}),
      },
    },
  }));
const fragments = (chunks: readonly string[], index = 5) =>
  chunks.map((text_delta) => ({
    event: "step_update",
    step_update: { step_index: index, step_type: "agent_response", state: "ACTIVE", text_delta },
  }));
const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0 };
const failedResult = (status: string, error: unknown, response = "") => ({
  event: "result",
  result: { status, error, response, usage },
});
const succeededResult = (response: string) => ({
  event: "result",
  result: { status: "SUCCESS", response, usage },
});

// Complete-looking text, footer included: it is still not a typed final.
const FIRST = [
  "Findings",
  ":",
  " ",
  "\n",
  "ha",
  "ha",
  " ",
  "fragments are joined verbatim",
  "\n",
  "```json\n",
  '{"work_report":{"state":"completed","required_inputs":[]}}',
  "\n```\n",
] as const;
const THIRD = ["A different ", "third", " answer", "\n", "\n", "end"] as const;
const text = (chunks: readonly string[]) => chunks.join("");

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-agy-continuity-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"],
    { cwd: root, stdio: "pipe" },
  );
  return root;
}

/** One run; a `continueFrom` successor reuses its predecessor's repository. */
async function run(
  mode: "agent" | "ask" | "plan",
  tries: unknown[][],
  successor?: { root: string; continuation: RunInput["continuation"] },
) {
  const root = successor?.root ?? repository();
  fixture.files = tries.map((frames, index) => {
    const file = join(root, `vendor-frames-${successor ? "successor-" : ""}${index}.json`);
    writeFileSync(file, JSON.stringify(frames));
    return file;
  });
  const configDir = process.env.CLAUDEXOR_CONFIG_DIR!;
  const home = join(configDir, "profiles", "agy-a");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(configDir, "config.yaml"),
    JSON.stringify({
      runtime: { transient_retry: { max_retries: 2, initial_delay_ms: 1, max_delay_ms: 2 } },
      credential_profiles: [
        CredentialProfile.parse({
          profile_id: "a",
          display_name: "a",
          harness_id: "agy",
          credential_kind: "config_dir_login",
          isolation_locator: home,
        }),
      ],
      harnesses: { agy: { profile_policy: { limit_action: "rotate" } } },
    }),
  );
  const native = createAgyAdapter({ prepareProfileKeychain: () => undefined });
  const adapter: HarnessAdapter = {
    ...native,
    async discover() {
      return HarnessManifest.parse({
        id: "agy",
        display_name: "AGY fixture",
        kind: "local_cli",
        provider_family: "google",
        capabilities: {
          plan: true,
          implement: true,
          explain: true,
          read_files: true,
          work_report_transport: "validated",
          web_policy: "uncontrolled",
        },
        capability_profile: native.capabilityProfile,
        auth_modes: ["local_session"],
        access_profiles_supported: ["readonly", "workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "agy",
        status: "ok",
        enabled_intents: ["implement", "explain", "plan"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: "agy",
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        last_verified_at: new Date().toISOString(),
      };
    },
    async models() {
      return [];
    },
  };
  const events: RunEvent[] = [];
  const live: HarnessEvent[] = [];
  const result = await new Orchestrator({
    registry: new Map([["agy", adapter]]),
    reviewers: [],
    quotaSnapshots: () => [],
  }).run({
    repoRoot: root,
    mode,
    ...(mode === "agent" ? { inPlace: true } : {}),
    prompt: "Review the fixture notes and report.",
    harnesses: ["agy"],
    review: false,
    web: "auto",
    ...(successor ? { continuation: successor.continuation } : {}),
    onEvent: (event) => events.push(event),
    onHarnessEvent: (event) => live.push(event),
  });
  const final = (rel: string) => join(result.runDir, "final", rel);
  const terminal = events.find((e) =>
    ["run.failed", "run.completed", "run.blocked"].includes(e.type),
  );
  return {
    root,
    result,
    events,
    live,
    terminal,
    receipts: events
      .filter((e) => e.type === "run.continuity")
      .map((e) => e.payload["receipt"] as Record<string, unknown>),
    exists: (rel: string) => existsSync(final(rel)),
    read: (rel: string) => readFileSync(final(rel), "utf8"),
    failure: () =>
      RunFailure.parse(new ArtifactStore(result.runDir).readYaml(final("failure.yaml"))),
    completed: events.filter((e) => e.type === "harness.completed"),
    prompts: fixture.spawns.map((spawn) => spawn.spec.prompt),
    conversations: fixture.spawns.map((spawn) => {
      const at = spawn.args.indexOf("--conversation");
      return at < 0 ? null : spawn.args[at + 1];
    }),
  };
}

// SYNTHETIC vendor words at the sizes recorded failure records carry (three
// failed tries; cause lines of 69-260 and messages of 590-1,354 characters).
const AUTH =
  "UNAUTHENTICATED (code 401): Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://identity.example.test/sign-in/web/devconsole-project.";
const DROPPED =
  "The connection to the model service was interrupted before the turn completed; please try again.";
const PIPE =
  'agent executor error: generating and executing: request failed: Post "https://model.example.test/v1internal:streamGenerateContent?alt=sse": write tcp 192.0.2.10:64004->198.51.100.4:443: write: broken pipe';
const NOTICE =
  "The assistant text this run retained (not an accepted final answer) is in final/retained-output.md.";

const incidentShaped = (third: unknown = failedResult("ERROR", PIPE)) => [
  [init("conv-1"), ...viewTool(1), ...fragments(FIRST), failedResult("ERROR", AUTH)],
  // A resumed try that repeats the same text without new tools (text is not progress).
  [init("conv-1"), ...fragments(FIRST), failedResult("ERROR", DROPPED)],
  [init("conv-1"), ...fragments(THIRD), third],
];

describe("AGY failed terminal after streamed text (actual consumer boundary)", () => {
  it.each(["agent", "ask"] as const)(
    "%s: native continuations keep each try's exact text as evidence, never as a final",
    async (mode) => {
      const out = await run(mode, incidentShaped());
      // Progress in try 0 → bounded same-session continuation, never a fresh replay.
      expect(out.conversations).toEqual([null, "conv-1", "conv-1"]);
      for (const prompt of out.prompts.slice(1)) {
        expect(prompt).toContain("The previous process stopped (an error without a typed cause)");
        expect(prompt).not.toContain("died");
        // The native lane relies on vendor history: no file is injected there.
        expect(prompt).not.toContain("retained-output");
      }
      expect(out.result.lifecycle).toBe("failed");
      expect(out.exists("answer.md")).toBe(false);
      // Exact bytes per physical session: whitespace-only and repeated frames kept.
      const retained = out.read("retained-output.md");
      expect(retained.split("Session: `").length - 1).toBe(3);
      expect(retained).toContain(`\n\n${text(FIRST)}`);
      expect(retained).toContain(`\n\n${text(THIRD)}`);
      expect(retained.split(text(FIRST)).length - 1).toBe(2);
      // The engine's own projection consumed by CLI/API/MCP stays failed + diagnostic.
      const runFacts = out.terminal?.payload["run_facts"] as Record<string, any>;
      expect(runFacts["outcome"]).toMatchObject({ lifecycle: "failed", reason: "harness_failed" });
      expect(runFacts["presentation"]).toEqual({
        state: "diagnostic",
        primary: { kind: "report", path: "final/retained-output.md" },
      });
      // The footer-looking text is not an accepted final: no footer verdict either.
      const workState = (out.completed.at(-1)?.payload["outcome"] as Record<string, any>)[
        "workState"
      ];
      expect(workState).toEqual({ state: "unverified", source: "validated" });
      expect(out.terminal?.payload["resumable"]).toMatchObject({ cause: "transport" });
      const failure = out.failure();
      // `logRefs` addresses the file. The record is the terminal's own message
      // (the `run.failed` error, unchanged) with the notice inserted right after
      // its first line, the native cause route health groups by, and before
      // the account attempts: within the first 512 characters of this
      // real-sized record, where an appended notice would start past them.
      expect(failure.logRefs).toContain("final/retained-output.md");
      const original = String(out.terminal?.payload["error"]);
      const lineEnd = original.indexOf("\n");
      expect(original.slice(0, lineEnd)).toContain(PIPE);
      expect(original.slice(lineEnd)).toMatch(/^\n\nAccount attempts:\n/);
      expect(original.length).toBeGreaterThanOrEqual(590);
      expect(failure.safeMessage).toBe(
        `${original.slice(0, lineEnd)}\n\n${NOTICE}${original.slice(lineEnd)}`,
      );
      expect(failure.safeMessage.indexOf(NOTICE) + NOTICE.length).toBeLessThanOrEqual(512);
      // Each try's own vendor words; the record speaks with the last try's.
      expect(failure.poolAttempts.map((row) => [row.phase, row.vendorFailure])).toEqual([
        ["after_progress", { code: "ERROR", message: AUTH, source: "agy_result" }],
        ["pre_progress", { code: "ERROR", message: DROPPED, source: "agy_result" }],
        ["pre_progress", { code: "ERROR", message: PIPE, source: "agy_result" }],
      ]);
      expect(failure.vendorFailure).toEqual({ code: "ERROR", message: PIPE, source: "agy_result" });
    },
  );

  it.each(["agent", "ask"] as const)(
    "%s: opaque vendor codes and words change evidence only, never a decision",
    async (mode) => {
      const decisions = async (third: unknown) => {
        const out = await run(mode, incidentShaped(third));
        const failure = out.failure();
        const decided = {
          conversations: out.conversations,
          lifecycle: out.result.lifecycle,
          facts: out.result.facts,
          resumable: (({ cause, carriers, session }) => ({ cause, carriers, session }))(
            out.terminal?.payload["resumable"] as Record<string, unknown>,
          ),
          receipts: out.events
            .filter((e) => e.type === "run.continuity")
            .map((e) => {
              const receipt = e.payload["receipt"] as Record<string, unknown>;
              return [receipt["carrier"], receipt["cause"], receipt["tryIndex"]];
            }),
          rows: failure.poolAttempts.map((row) => [row.phase, row.category, row.tryIndex]),
        };
        fixture.spawns.length = 0;
        return { decided, vendor: failure.vendorFailure };
      };
      const a = await decisions(failedResult("ERROR", "opaque words alpha"));
      const b = await decisions(failedResult("UNAVAILABLE", { code: 14, detail: "beta" }));
      expect(b.decided).toEqual(a.decided);
      expect(a.vendor).toMatchObject({ code: "ERROR", message: "opaque words alpha" });
      expect(b.vendor).toMatchObject({ code: "UNAVAILABLE" });
      expect(b.vendor?.message).toContain("beta");
    },
  );

  it.each(["agent", "ask"] as const)(
    "%s: text then an error with no progress opens no replay (sawRetryable stays false)",
    async (mode) => {
      const out = await run(mode, [
        [init("conv-1"), ...fragments(FIRST), failedResult("ERROR", "text-only failure")],
        [init("conv-2"), succeededResult("must never run")],
      ]);
      expect(fixture.spawns).toHaveLength(1);
      expect(out.events.some((e) => e.type === "route.transient.retry_scheduled")).toBe(false);
      expect(out.result.lifecycle).toBe("failed");
      expect(out.failure().poolAttempts.map((row) => row.phase)).toEqual(["pre_progress"]);
      expect(out.read("retained-output.md")).toContain(`\n\n${text(FIRST)}`);
    },
  );

  it("a terminal-only error response stays exact retained evidence, not an answer", async () => {
    const response = "Partial answer:\n\n  indented line\n";
    const out = await run("ask", [
      [init("conv-1"), failedResult("ERROR", "late failure", response)],
    ]);
    expect(out.result.lifecycle).toBe("failed");
    expect(out.exists("answer.md")).toBe(false);
    expect(out.read("retained-output.md")).toContain(`\n\n${response}`);
    // Retained evidence is never live display.
    expect(out.live.some((e) => e.type === "message" && e.text === response)).toBe(false);
  });

  it("a successful fragment stream keeps its typed final verbatim and adds no retained copy", async () => {
    const answer =
      'The answer.\n\n```json\n{"work_report":{"state":"completed","required_inputs":[]}}\n```';
    const chunks = ["The ", "answer", ".", "\n", "\n", answer.slice("The answer.\n\n".length)];
    expect(text(chunks)).toBe(answer);
    const out = await run("ask", [[init("conv-1"), ...fragments(chunks), succeededResult(answer)]]);
    expect(out.result.lifecycle).toBe("succeeded");
    expect(out.read("answer.md")).toContain("The answer.");
    expect(out.exists("retained-output.md")).toBe(false);
    expect(out.exists("failure.yaml")).toBe(false);
  });

  it("plan: an errored plan without a typed final is no plan and invents no footer verdict", async () => {
    const out = await run("plan", [
      [init("conv-1"), ...fragments(FIRST), failedResult("ERROR", "plan failure")],
    ]);
    expect(out.result.lifecycle).toBe("failed");
    expect(out.exists("plan.md")).toBe(false);
    const workState = (out.completed.at(-1)?.payload["outcome"] as Record<string, any>)[
      "workState"
    ];
    expect(workState).toEqual({ state: "unverified", source: "validated" });
  });
});

describe("AGY packet continuation (no native session reported)", () => {
  it("keeps the complete projection beside the index; >4000 fragments stay complete in evidence while live display is capped", async () => {
    const many = Array.from({ length: 4100 }, (_, index) => `w${index} `);
    const out = await run("agent", [
      [init(), ...viewTool(1), ...fragments(many), failedResult("ERROR", "flood failure")],
      [init(), succeededResult("Done after the packet.")],
    ]);
    expect(out.result.lifecycle).toBe("succeeded");
    expect(out.conversations).toEqual([null, null]);
    const receipts = out.events.filter((e) => e.type === "run.continuity");
    expect((receipts[0]?.payload["receipt"] as Record<string, unknown>)["carrier"]).toBe("packet");
    const attemptDir = join(out.result.runDir, "attempts", "a01", "continuation");
    const complete = join(attemptDir, "retained-output-try1.md");
    const whole = readFileSync(complete, "utf8");
    // Boolean checks: a failure must not print the 25 KB text.
    expect(whole.includes(`\n\n${text(many)}\n`)).toBe(true);
    const index = readFileSync(join(attemptDir, "evidence-index-try1.md"), "utf8");
    expect(index).toContain(`it is complete in the file ${complete}.`);
    expect(index).toContain(`- Complete retained assistant output: ${complete}`);
    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(24 * 1024);
    expect(out.prompts[1]).toContain(`- Complete retained assistant output: ${complete}`);
    // Live display is bounded and says so; the journal keeps every fragment.
    const liveDeltas = out.live.filter(
      (e) => e.type === "message" && e.payload?.["delta"] === true,
    );
    expect(liveDeltas).toHaveLength(4000);
    const journal = readFileSync(join(out.result.runDir, "events.jsonl"), "utf8");
    expect(journal).toContain("direct observer delta preview capped at 4000 chunks");
    expect(journal).toContain('"text":"w4099 "');
  });
});

describe("AGY non-SUCCESS response repeating its fragments across a tool", () => {
  it("the retained output and the packet's complete file keep each streamed run once", async () => {
    // SYNTHETIC fixtures/fragment-error-run.jsonl, read as recorded; its vendor
    // conversation id is left out in memory so the continuation is a packet.
    const fixture = fileURLToPath(
      new URL("../../harness-agy/fixtures/fragment-error-run.jsonl", import.meta.url),
    );
    const frames = readFileSync(fixture, "utf8")
      .trim()
      .split("\n")
      .map((line) =>
        JSON.parse(line, (key, value: unknown) => (key === "conversation_id" ? undefined : value)),
      );
    const out = await run("agent", [frames, [init(), succeededResult("Done after the packet.")]]);
    expect(out.result.lifecycle).toBe("succeeded");
    expect(out.conversations).toEqual([null, null]);
    const complete = readFileSync(
      join(out.result.runDir, "attempts", "a01", "continuation", "retained-output-try1.md"),
      "utf8",
    );
    for (const retained of [complete, out.read("retained-output.md")]) {
      // Each run exact (whitespace-only and repeated frames kept), the
      // buffered response that repeats them both is not a third copy.
      expect(retained).toMatch(
        /### Streamed text · events \d+–\d+\n\nChecking the file\.\n\n\n### Streamed text · events \d+–\d+\n\nhaha done\n/,
      );
      expect(retained.split("Checking the file.").length - 1).toBe(1);
      expect(retained.split("haha done").length - 1).toBe(1);
      expect(retained).not.toContain("### Assistant message");
    }
  });
});

describe("AGY's explicit not-retryable record (stderr `AGY_ERROR`, exit 3)", () => {
  // Neutral synthetic vendor words and ids in the vendor's documented line shape.
  const agyError = (fields: Record<string, unknown>) => ({
    __stderr: `AGY_ERROR: ${JSON.stringify(fields)}`,
  });
  const acted = (tail: unknown[]) => [
    init("conv-1"),
    ...viewTool(1),
    ...fragments(FIRST),
    failedResult("ERROR", "fixture vendor refusal words"),
    ...tail,
  ];
  const next = [init("conv-1"), succeededResult("must never run")];
  const resumed = [init("conv-1"), succeededResult("Done after the continuation.")];

  it.each([
    ["agent", "", []],
    ["ask", "", []],
    // Lines without the marker after the record do not clear it.
    [
      "agent",
      " (then a line without the marker)",
      [{ __stderr: "warning: unrelated vendor line" }],
    ],
  ] as const)(
    "%s: retryable:false after progress stops%s: no continuation, retry or rotation",
    async (mode, _label, after) => {
      const out = await run(mode, [
        acted([
          agyError({ short_error: "fixture refusal", retryable: false, error_id: "fx-1" }),
          ...after,
          { __exit: 3 },
        ]),
        next,
      ]);
      expect(fixture.spawns).toHaveLength(1);
      expect(out.conversations).toEqual([null]);
      expect(out.result.lifecycle).toBe("failed");
      const failure = out.failure();
      expect(failure).toMatchObject({
        category: "harness_error",
        code: "vendor_not_retryable",
        requestRefusal: { kind: "vendor_not_retryable", source: "agy_stderr", error_id: "fx-1" },
      });
      expect(failure.nextActions[0]).toContain("not retryable (error id fx-1)");
      // The streamed text stays retained evidence, never an answer.
      expect(out.exists("answer.md")).toBe(false);
      expect(out.read("retained-output.md")).toContain(`\n\n${text(FIRST)}`);
      expect(failure.logRefs).toContain("final/retained-output.md");
      // The refused try settled its progress and cause like every other try.
      expect(out.terminal?.payload["resumable"]).toMatchObject({
        cause: "other",
        carriers: ["native", "packet"],
      });
    },
  );

  it.each(["agent", "ask"] as const)(
    "%s: a first try that acted and was refused keeps its packet for an explicit continueFrom",
    async (mode) => {
      const pred = await run(mode, [
        [
          init(),
          ...viewTool(1),
          ...fragments(FIRST),
          failedResult("ERROR", "fixture vendor refusal words"),
          agyError({ short_error: "fixture refusal", retryable: false, error_id: "fx-2" }),
          { __exit: 3 },
        ],
        next,
      ]);
      expect(fixture.spawns).toHaveLength(1);
      expect(pred.failure().code).toBe("vendor_not_retryable");
      expect(pred.terminal?.payload["resumable"]).toMatchObject({
        cause: "other",
        carriers: ["packet"],
      });
      fixture.spawns.length = 0;
      // The successor the daemon would start: the actual continueFrom reader and carrier ladder.
      const succ = await run(mode, [[init(), succeededResult("Done after the packet.")]], {
        root: pred.root,
        continuation: {
          retain: true,
          from: {
            runId: pred.result.runId,
            runDir: pred.result.runDir,
            state: pred.result.lifecycle,
            workOrder: "Review the fixture notes and report.",
            preference: "auto",
          },
        },
      });
      expect(succ.result.lifecycle).toBe("succeeded");
      expect(fixture.spawns).toHaveLength(1);
      expect(succ.receipts[0]).toMatchObject({
        carrier: "packet",
        cause: "other",
        from: { runId: pred.result.runId },
      });
      expect(succ.prompts[0]).toContain("# Evidence index of the interrupted work");
      expect(succ.prompts[0]).toContain(text(FIRST));
    },
  );

  it.each(["agent", "ask"] as const)(
    "%s: a refused continued try ends with its own cause, not the earlier untyped one",
    async (mode) => {
      const out = await run(mode, [
        [init("conv-1"), ...viewTool(1), ...fragments(FIRST), failedResult("ERROR", "untyped")],
        [
          init("conv-1"),
          ...viewTool(2),
          failedResult("ERROR", "fixture vendor refusal words"),
          agyError({ short_error: "fixture refusal", retryable: false, error_id: "fx-3" }),
          { __exit: 3 },
        ],
        next,
      ]);
      expect(out.conversations).toEqual([null, "conv-1"]);
      expect(out.failure().code).toBe("vendor_not_retryable");
      expect(out.receipts.map((r) => [r["carrier"], r["cause"], r["tryIndex"]])).toEqual([
        ["native", "transport", 1],
      ]);
      expect(out.terminal?.payload["resumable"]).toMatchObject({
        cause: "other",
        carriers: ["native", "packet"],
      });
    },
  );

  it.each([
    ["retryable:true", [agyError({ short_error: "x", retryable: true }), { __exit: 3 }]],
    ["no retryable field", [agyError({ short_error: "x" }), { __exit: 3 }]],
    ["malformed record", [{ __stderr: 'AGY_ERROR: {"retryable":false' }, { __exit: 3 }]],
    ["no record", [{ __exit: 3 }]],
    [
      "a false record followed by an unreadable one",
      [
        agyError({ short_error: "x", retryable: false }),
        { __stderr: 'AGY_ERROR: {"retryable":false' },
        { __exit: 3 },
      ],
    ],
  ] as const)("%s keeps today's native continuation", async (_label, tail) => {
    const out = await run("agent", [acted([...tail]), resumed]);
    expect(out.conversations).toEqual([null, "conv-1"]);
    expect(out.result.lifecycle).toBe("succeeded");
  });

  it("the same line in model text is not a vendor record", async () => {
    const line = `AGY_ERROR: ${JSON.stringify({ short_error: "x", retryable: false })}`;
    const out = await run("agent", [
      [init("conv-1"), ...viewTool(1), ...fragments([line]), failedResult("ERROR", "words")],
      resumed,
    ]);
    expect(out.conversations).toEqual([null, "conv-1"]);
    expect(out.result.lifecycle).toBe("succeeded");
  });
});
