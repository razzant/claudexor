/**
 * The Cursor catalog proof across native tries, through the REAL Orchestrator:
 * the Agent and Ask/report retry loops, in-run continuation on the pinned
 * account, the Cursor adapter and parser, the per-spawn gate, the CLI run loop
 * and final/telemetry.yaml. Only the run loop's process seam is scripted: each
 * spawn replays one cursor-agent process. Catalog rows and stream frames are
 * SYNTHETIC Cursor-style values: no recorded real catalog/init pair exists.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { runCapture, runCliHarness, type CliRunLoopOptions } from "@claudexor/core";
import { HarnessModel, RunTelemetry } from "@claudexor/schema";
import { createCursorAdapter } from "../../harness-cursor/src/index.js";
import { Orchestrator } from "./orchestrator.js";

const temporaryDirectories: string[] = [];
function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}
afterAll(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const row = (id: string, label: string) => HarnessModel.parse({ id, label });
const CATALOG = [
  row("gpt-5.5-high", "GPT-5.5 High"),
  row("gpt-5.5-high-fast", "GPT-5.5 High Fast"),
  row("gpt-5.5", "GPT-5.5"),
];
const PROOF = {
  label: "GPT-5.5 High",
  id: "gpt-5.5-high",
  source: "account_catalog",
  profile_id: "work",
} as const;
const ANSWER = [
  "Reviewed the fixture repository; no findings.",
  "",
  "```json",
  '{"work_report":{"state":"completed","required_inputs":[]}}',
  "```",
].join("\n");

type Frame = Record<string, unknown>;
interface CursorProcess {
  stdout: Frame[];
  stderr?: string[];
  exitCode: number;
}

const init = (model: string | undefined): Frame => ({
  type: "system",
  subtype: "init",
  chatId: "chat-1",
  ...(model === undefined ? {} : { model }),
});
const answered = (model: string | undefined): CursorProcess => ({
  stdout: [
    init(model),
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: ANSWER }] },
    },
    { type: "result", subtype: "success", is_error: false, result: ANSWER },
  ],
  exitCode: 0,
});
// The first try is proven and makes progress, then its process dies.
const DIED_AFTER_PROGRESS: CursorProcess = {
  stdout: [init("GPT-5.5 High"), { type: "thinking", text: "Reading the repository layout." }],
  stderr: ["connection reset by peer"],
  exitCode: 1,
};

/** The run loop's process seam: each spawn replays the next scripted process. */
function scriptedCursorAgent(
  processes: CursorProcess[],
  argv: string[][],
): NonNullable<CliRunLoopOptions["spawn"]> {
  return async function* (_bin, args) {
    argv.push(args);
    const next = processes[argv.length - 1];
    if (!next) throw new Error(`unscripted cursor-agent spawn #${argv.length}`);
    for (const frame of next.stdout) yield { type: "stdout", line: JSON.stringify(frame) };
    for (const line of next.stderr ?? []) yield { type: "stderr", line };
    yield { type: "exit", code: next.exitCode, signal: null };
  };
}

async function initializedRepository(): Promise<string> {
  const root = temporaryDirectory("claudexor-native-retry-");
  await runCapture("git", ["-C", root, "init", "-b", "main"]);
  writeFileSync(join(root, "README.md"), "# Native retry fixture\n");
  await runCapture("git", ["-C", root, "add", "-A"]);
  await runCapture("git", [
    "-C",
    root,
    ...["-c", "user.email=qa@example.invalid", "-c", "user.name=QA"],
    ...["commit", "-m", "fixture"],
  ]);
  return root;
}

/** One run on the pinned Cursor account `work`, requesting the explicit id gpt-5.5-high. */
async function pinnedCursorRun(lane: "ask" | "agent", processes: CursorProcess[]) {
  const repo = await initializedRepository();
  const configDir = temporaryDirectory("claudexor-native-retry-config-");
  const home = join(configDir, "profiles", "cursor-work");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(configDir, "config.yaml"),
    [
      "credential_profiles:",
      "  - profile_id: work",
      "    harness_id: cursor",
      "    display_name: Work",
      "    credential_kind: config_dir_login",
      `    isolation_locator: ${JSON.stringify(home)}`,
      "runtime:",
      "  transient_retry:",
      "    initial_delay_ms: 0",
      "",
    ].join("\n"),
  );
  const argv: string[][] = [];
  const adapter = createCursorAdapter({
    detectVersion: async () => "cursor-fixture",
    nativeAuthOk: async () => ({ kind: "authenticated" }),
    cursorApiKey: () => null,
    smokeIsolatedApiKey: async () => ({ ok: false, detail: "not needed" }),
    listCursorModels: async () => CATALOG,
    runCliHarness: (opts) =>
      runCliHarness({ ...opts, spawn: scriptedCursorAgent(processes, argv) }),
  });
  const continuity: Array<Record<string, unknown>> = [];
  const previousConfig = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  try {
    const result = await new Orchestrator({
      registry: new Map([["cursor", adapter]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "Review the fixture repository and report findings.",
      mode: lane,
      harnesses: ["cursor"],
      models: { cursor: "gpt-5.5-high" },
      credentialProfileId: "work",
      ...(lane === "agent" ? { n: 1 } : {}),
      onEvent: (event) => {
        if (event.type === "run.continuity")
          continuity.push((event.payload as { receipt: Record<string, unknown> }).receipt);
      },
    });
    const telemetry = RunTelemetry.parse(
      new ArtifactStore(repo).readYaml(join(result.runDir, "final", "telemetry.yaml")),
    );
    const finals = telemetry.attempts.filter((a) => a.attempt_id === telemetry.final_attempt_id);
    expect(finals).toHaveLength(1);
    return { lifecycle: result.lifecycle, attempt: finals[0]!, argv, continuity };
  } finally {
    if (previousConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previousConfig;
  }
}

const modelArg = (args: string[]) => args[args.indexOf("--model") + 1];

for (const lane of ["ask", "agent"] as const) {
  describe(`the first native try's catalog proof (${lane} loop)`, { timeout: 30_000 }, () => {
    it("is kept when the attempt ran a single try (control)", async () => {
      const run = await pinnedCursorRun(lane, [answered("GPT-5.5 High")]);
      expect(run.lifecycle).toBe("succeeded");
      expect(run.argv).toHaveLength(1);
      expect(run.attempt.observed_model).toBe("GPT-5.5 High");
      expect(run.attempt.observed_model_catalog_match).toEqual(PROOF);
    });

    it.each([
      { resumed: "another catalogued model", retryModel: "GPT-5.5" },
      { resumed: "no model", retryModel: undefined },
      // Conservative: no proof spans tries, even an identical one.
      { resumed: "the same model", retryModel: "GPT-5.5 High" },
    ])(
      "ends when the same account resumes after progress and reports $resumed",
      async ({ retryModel }) => {
        const run = await pinnedCursorRun(lane, [DIED_AFTER_PROGRESS, answered(retryModel)]);
        expect(run.lifecycle).toBe("succeeded");
        // In-run continuation: the pinned account resumes its own native session.
        expect(run.argv).toHaveLength(2);
        expect(run.argv.map(modelArg)).toEqual(["gpt-5.5-high", "gpt-5.5-high"]);
        expect(run.argv[0]).not.toContain("--resume");
        expect(run.argv[1]?.[run.argv[1].indexOf("--resume") + 1]).toBe("chat-1");
        expect(run.continuity).toMatchObject([
          {
            carrier: "native",
            cause: "transport",
            from: { profileId: "work" },
            to: { profileId: "work" },
            observedModel: retryModel ?? null,
          },
        ]);
        // The raw string stays first-wins; the proof never certifies the later try.
        expect(run.attempt.observed_model).toBe("GPT-5.5 High");
        expect(run.attempt.profile_id).toBe("work");
        expect(run.attempt.observed_model_catalog_match).toBeNull();
      },
    );
  });
}
