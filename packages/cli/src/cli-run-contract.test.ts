import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  RunFailure,
  RunTelemetry,
  SCHEMA_VERSION,
  TaskContract,
  makeOutcomeFacts,
  requiredActionsFor,
  validateRunFactsInvariants,
} from "@claudexor/schema";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const cliSource = fileURLToPath(new URL("./cli.ts", import.meta.url));
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("run-command pre-daemon machine contract", () => {
  it("renders missing prompts for all five run verbs as exactly one NDJSON failure", () => {
    for (const verb of ["agent", "ask", "best-of", "plan", "create"]) {
      const result = spawnSync(process.execPath, [tsxCli, cliSource, verb, "--json-stream"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
      });
      expect(result.status, `${verb}: ${result.stderr}`).toBe(2);
      expect(result.stderr, verb).toBe("");
      expect(result.stdout.endsWith("\n"), verb).toBe(true);
      const lines = result.stdout.split("\n");
      expect(lines, verb).toHaveLength(2);
      expect(lines[1], verb).toBe("");
      expect(JSON.parse(lines[0] ?? "{}"), verb).toEqual({
        ok: false,
        exitCode: 2,
        code: "invalid_argument",
        message: "claudexor: missing prompt",
        error: "claudexor: missing prompt",
      });
    }
  });

  it("advertises only mode-applicable controls in dedicated Ask/Plan help", () => {
    const cases = [
      {
        verb: "ask",
        present: ["--deep-scan", "--n", "--output-schema", "--attach"],
        absent: [
          "--attempts",
          "--council",
          "--test",
          "--in-place",
          "--reviewer-panel",
          "--reviewer-panel-json",
        ],
      },
      {
        verb: "plan",
        present: ["--council", "--n", "--attach"],
        absent: [
          "--attempts",
          "--deep-scan",
          "--synthesis",
          "--test",
          "--allow-protected-path",
          "--deny-path",
          "--output-schema",
          "--reviewer-panel",
          "--reviewer-panel-json",
          "--reviewer-model",
          "--reviewer-effort",
          "--in-place",
        ],
      },
    ];
    for (const fixture of cases) {
      const result = spawnSync(process.execPath, [tsxCli, cliSource, fixture.verb, "--help"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
      });
      expect(result.status, `${fixture.verb}: ${result.stderr}`).toBe(0);
      expect(result.stderr, fixture.verb).toBe("");
      for (const flag of fixture.present) expect(result.stdout, fixture.verb).toContain(flag);
      for (const flag of fixture.absent) expect(result.stdout, fixture.verb).not.toContain(flag);
    }
  });

  it("rejects Agent controls before daemon startup on agent --mode plan", () => {
    const result = spawnSync(
      process.execPath,
      [
        tsxCli,
        cliSource,
        "agent",
        "plan it",
        "--mode",
        "plan",
        "--reviewer-model",
        "openai=gpt-test",
        "--json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
      },
    );
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "invalid_argument",
      message: expect.stringContaining("--reviewer-model"),
    });
  });

  it("inspect drains a large failed run projection before exiting", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-cli-inspect-terminal-"));
    tempRoots.push(root);
    const project = join(root, "project");
    const config = join(root, "config");
    mkdirSync(project, { recursive: true });
    const store = new ArtifactStore(project, { claudexorDir: config });
    const paths = store.createRun("run-failed-inspect");
    const outcome = makeOutcomeFacts("failed", { reason: "harness_failed" });
    store.writeYaml(
      join(paths.contextDir, "task.yaml"),
      TaskContract.parse({
        schema_version: SCHEMA_VERSION,
        task_id: "task-failed-inspect",
        created_at: "2026-07-29T00:00:00.000Z",
        repo: { root: project, base_ref: "HEAD" },
        mode: { kind: "ask" },
        user_intent: { raw: "inspect a failed run" },
        tests: { commands: [] },
      }),
    );
    const failure = RunFailure.parse({
      phase: "harness",
      category: "harness_unavailable",
      code: null,
      safeMessage: "Provider is unavailable.",
      runDir: paths.root,
      nextActions: ["Choose another harness and retry."],
    });
    store.writeYaml(join(paths.finalDir, "failure.yaml"), failure);
    // Larger than a pipe's 64 KiB high-water mark. The CLI used to call process.exit(0)
    // immediately after writing this projection, producing truncated but successful JSON.
    const diagnostic = `Provider is unavailable.\n${"diagnostic context\n".repeat(5_000)}`;
    store.writeText(join(paths.finalDir, "summary.md"), diagnostic);
    store.writeYaml(
      join(paths.finalDir, "run_facts.yaml"),
      validateRunFactsInvariants({
        schema_version: SCHEMA_VERSION,
        run_id: "run-failed-inspect",
        task_id: "task-failed-inspect",
        mode: "ask",
        outcome,
        deliverable: { present: false, kind: null, path: null, producer_attempt_id: null },
        presentation: {
          state: "diagnostic",
          primary: { kind: "diagnostic", path: "final/summary.md" },
        },
        participants: { planners: 0, attempts: [] },
        gates: {
          configured: false,
          required: 0,
          total: 0,
          executed: false,
          state: "not_configured",
          receipt_attempt_id: null,
        },
        review: { state: "not_run", blocker_ids: [], blockers: 0 },
        apply: { eligibility: null, operator_decision_present: false },
        required_actions: requiredActionsFor(outcome, false),
        generated_at: "2026-07-29T00:00:01.000Z",
      }),
    );

    const env = { ...process.env, CLAUDEXOR_CONFIG_DIR: config };
    const json = spawnSync(
      process.execPath,
      [tsxCli, cliSource, "inspect", "run-failed-inspect", "--json"],
      { cwd: project, encoding: "utf8", env },
    );
    expect(json.status, json.stderr).toBe(0);
    expect(json.stderr).toBe("");
    expect(Buffer.byteLength(json.stdout, "utf8")).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(json.stdout)).toMatchObject({
      lifecycle: "failed",
      outputReadyState: "diagnostic",
      failure: {
        category: "harness_unavailable",
        code: null,
        nextActions: ["Choose another harness and retry."],
      },
      primaryOutput: {
        kind: "diagnostic",
        path: "final/summary.md",
        text: diagnostic,
      },
      runFacts: { outcome: { lifecycle: "failed", reason: "harness_failed" } },
    });

    const human = spawnSync(
      process.execPath,
      [tsxCli, cliSource, "inspect", "run-failed-inspect"],
      { cwd: project, encoding: "utf8", env },
    );
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain("lifecycle: failed (harness_failed)");
    expect(human.stdout).toContain("failure: harness_unavailable phase=harness");
    expect(human.stdout).toContain("next action: Choose another harness and retry.");
    // No vendor-typed evidence on the record: the failure line says nothing extra.
    expect(human.stdout).not.toContain("vendor_code=");
    expect(JSON.parse(json.stdout).failure.vendorFailure).toBeNull();

    // The vendor's own typed failure is shown as a fact token beside the
    // engine's classification, labelled with the channel it was read from.
    const vendorFailure = {
      code: "server_overloaded",
      message: "Selected model is at capacity. Please try a different model.",
      source: "codex_rollout",
    };
    store.writeYaml(
      join(paths.finalDir, "failure.yaml"),
      RunFailure.parse({ ...failure, harnessId: "codex", vendorFailure }),
    );
    const humanVendor = spawnSync(
      process.execPath,
      [tsxCli, cliSource, "inspect", "run-failed-inspect"],
      { cwd: project, encoding: "utf8", env },
    );
    expect(humanVendor.status, humanVendor.stderr).toBe(0);
    expect(humanVendor.stdout).toContain(
      "failure: harness_unavailable phase=harness harness=codex vendor_code=server_overloaded (codex_rollout)",
    );
    const jsonVendor = spawnSync(
      process.execPath,
      [tsxCli, cliSource, "inspect", "run-failed-inspect", "--json"],
      { cwd: project, encoding: "utf8", env },
    );
    expect(jsonVendor.status, jsonVendor.stderr).toBe(0);
    expect(JSON.parse(jsonVendor.stdout).failure.vendorFailure).toEqual(vendorFailure);

    // A refused capture's bounded inventory is printed as such: not exact, not a patch.
    store.writeYaml(
      join(paths.finalDir, "failure.yaml"),
      RunFailure.parse({
        ...failure,
        captureFailure: {
          code: "capture_output_exceeded",
          message: "stdout exceeded the 268435456-byte combined capture buffer budget",
          bufferBudgetBytes: 268435456,
          stream: "stdout",
          inventory: {
            exact: false,
            changedFiles: 3,
            largest: [
              { path: "media/capture.mov", change: "added", sizeBytes: 283115520 },
              { path: "notes.md", change: "modified", sizeBytes: 812 },
            ],
          },
        },
      }),
    );
    const humanInventory = spawnSync(
      process.execPath,
      [tsxCli, cliSource, "inspect", "run-failed-inspect"],
      { cwd: project, encoding: "utf8", env },
    );
    expect(humanInventory.status, humanInventory.stderr).toBe(0);
    expect(humanInventory.stdout).toContain(
      [
        "Largest changed files (inventory, not exact, not a patch): 3 changed, 1 not listed",
        "- added media/capture.mov · 270.0 MiB (283115520 bytes)",
        "- modified notes.md · 812 bytes",
      ].join("\n"),
    );
  });

  it("inspect classifies unrecovered tools by attempt outcome instead of web kind", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-cli-inspect-tool-outcomes-"));
    tempRoots.push(root);
    const project = join(root, "project");
    const config = join(root, "config");
    mkdirSync(project, { recursive: true });
    const store = new ArtifactStore(project, { claudexorDir: config });
    const paths = store.createRun("run-tool-outcomes");
    store.writeYaml(
      join(paths.contextDir, "task.yaml"),
      TaskContract.parse({
        schema_version: SCHEMA_VERSION,
        task_id: "task-tool-outcomes",
        created_at: "2026-08-14T00:00:00.000Z",
        repo: { root: project, base_ref: "HEAD" },
        mode: { kind: "ask" },
        user_intent: { raw: "inspect tool outcomes" },
        tests: { commands: [] },
      }),
    );
    store.writeYaml(
      join(paths.finalDir, "telemetry.yaml"),
      RunTelemetry.parse({
        schema_version: SCHEMA_VERSION,
        run_id: "run-tool-outcomes",
        task_id: "task-tool-outcomes",
        mode: "ask",
        requested_access: "readonly",
        effective_access: "readonly",
        external_context_policy: "auto",
        effective_web_mode: "auto",
        final_attempt_id: "a-web",
        web: { attempted: true, status: "failed", error_summary: "web denied" },
        attempts: [
          {
            attempt_id: "a-web",
            harness_id: "cursor",
            web: { attempted: true, status: "failed", error_summary: "web denied" },
            tool_errors: [
              {
                tool: "WebFetch",
                kind: "web",
                target: "https://example.com",
                summary: "web denied",
              },
            ],
            outcome: {
              deliverable_present: true,
              tool_warnings_count: 1,
              status: "success_with_warnings",
            },
          },
          {
            attempt_id: "a-command",
            harness_id: "codex",
            web: {},
            tool_errors: [
              {
                tool: "command",
                kind: "command",
                target: "npm test",
                summary: "command failed",
              },
            ],
            outcome: {
              deliverable_present: false,
              harness_errored: true,
              tool_warnings_count: 1,
              status: "failed",
            },
          },
          {
            attempt_id: "a-required-web",
            harness_id: "claude",
            web: { required: true, attempted: true, status: "failed" },
            tool_errors: [
              {
                tool: "WebSearch",
                kind: "web",
                target: "required query",
                summary: "required web failed",
              },
            ],
            outcome: {
              deliverable_present: true,
              web_required_unsatisfied: true,
              tool_warnings_count: 1,
              status: "blocked",
            },
          },
          {
            attempt_id: "a-recovered",
            harness_id: "claude",
            web: {},
            tool_errors: [
              {
                tool: "Read",
                kind: "file",
                target: "README.md",
                summary: "temporary read failure",
                recovered: true,
              },
            ],
            outcome: { deliverable_present: true, status: "success" },
          },
        ],
        generated_at: "2026-08-14T00:00:01.000Z",
      }),
    );
    store.writeText(join(paths.finalDir, "summary.md"), "Tool outcome summary.\n");

    const result = spawnSync(
      process.execPath,
      [tsxCli, cliSource, "inspect", "run-tool-outcomes", "--json"],
      {
        cwd: project,
        encoding: "utf8",
        env: { ...process.env, CLAUDEXOR_CONFIG_DIR: config },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      toolWarnings: [{ attemptId: "a-web", tool: "WebFetch", summary: "web denied" }],
      toolErrors: [
        { attemptId: "a-command", tool: "command", summary: "command failed" },
        {
          attemptId: "a-required-web",
          tool: "WebSearch",
          summary: "required web failed",
        },
      ],
    });

    const human = spawnSync(process.execPath, [tsxCli, cliSource, "inspect", "run-tool-outcomes"], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, CLAUDEXOR_CONFIG_DIR: config },
    });
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain("tool warnings (non-blocking):");
    expect(human.stdout).toContain("a-web WebFetch: web denied");
    expect(human.stdout).toContain("tool errors (unrecovered):");
    expect(human.stdout).toContain("a-required-web WebSearch: required web failed");
    expect(human.stdout).not.toContain("a-recovered Read");
  });
});
