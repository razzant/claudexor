import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, makeSandbox, type CliResult, type Sandbox } from "./support.js";

const FCHMOD_EPERM_PRELOAD = join(
  dirname(fileURLToPath(import.meta.url)),
  "fchmod-eperm.preload.cjs",
);

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.dispose());

function expectTypedFailure(
  result: CliResult,
  expected: { exitCode: 1 | 2; code: string; context?: Record<string, unknown> },
): void {
  expect(result.code).toBe(expected.exitCode);
  expect(result.stderr).toBe("");
  expect(result.strictJson()).toMatchObject({
    ok: false,
    exitCode: expected.exitCode,
    code: expected.code,
    message: expect.any(String),
    error: expect.any(String),
    retryable: expect.any(Boolean),
    fieldErrors: expect.any(Object),
    requiredActions: expect.any(Array),
    evidenceRefs: expect.any(Array),
    context: expected.context ?? expect.any(Object),
  });
}

describe("CLI typed failure contract", () => {
  it("apply rejects an invalid mode as one complete usage envelope", () => {
    const r = cli(sb, ["apply", "run-123", "--mode", "explode", "--json"]);
    expectTypedFailure(r, {
      exitCode: 2,
      code: "invalid_apply_mode",
      context: { runId: "run-123", mode: "explode" },
    });
  });

  it("daemon status without a token is one complete operational envelope", () => {
    const r = cli(sb, ["daemon", "status", "--json"]);
    expectTypedFailure(r, {
      exitCode: 1,
      code: "daemon_not_initialized",
    });
  });

  it("command-local validation fails before daemon bootstrap with complete envelopes", () => {
    const settings = cli(sb, ["settings", "set", "paid_budget_per_run", "not-a-budget", "--json"]);
    expectTypedFailure(settings, { exitCode: 2, code: "invalid_argument" });

    const zodSettings = cli(sb, ["settings", "set", "routing_goal", "bogus", "--json"]);
    expectTypedFailure(zodSettings, { exitCode: 2, code: "invalid_argument" });
    expect(zodSettings.strictJson()).toMatchObject({
      fieldErrors: { routingGoal: expect.any(Array) },
    });

    const trust = cli(sb, ["trust", "--allow-full-access", "--revoke-full-access", "--json"]);
    expectTypedFailure(trust, { exitCode: 2, code: "invalid_argument" });

    const quotaIngest = cli(sb, ["quota", "ingest-claude-statusline", "wrong-version", "--json"]);
    expectTypedFailure(quotaIngest, { exitCode: 2, code: "invalid_argument" });

    const models = cli(sb, ["models", "--route", "bogus", "--json"]);
    expectTypedFailure(models, { exitCode: 2, code: "invalid_argument" });

    const recoveryAction = cli(sb, ["recovery", "explode", "global", "--json"]);
    expectTypedFailure(recoveryAction, { exitCode: 2, code: "invalid_argument" });

    const quarantine = cli(sb, [
      "recovery",
      "quarantine",
      "global",
      "not-a-fingerprint",
      "yes",
      "--json",
    ]);
    expectTypedFailure(quarantine, {
      exitCode: 2,
      code: "invalid_quarantine_request",
    });

    const diffPath = join(sb.repo, "review.diff");
    writeFileSync(diffPath, "diff --git a/a b/a\n");
    const reviewerPanel = cli(sb, [
      "review",
      "--diff",
      diffPath,
      "--reviewer-panel",
      "codex=",
      "--json",
    ]);
    expectTypedFailure(reviewerPanel, {
      exitCode: 2,
      code: "invalid_reviewer_panel",
    });
  });

  it("plugin validation uses the shared typed envelope", () => {
    const r = cli(sb, ["plugin", "install", "bogus", "--json"]);
    expectTypedFailure(r, {
      exitCode: 2,
      code: "invalid_plugin_target",
      context: { verb: "install", target: "bogus", dryRun: false },
    });
  });

  it("interactive profile login refuses --json before daemon bootstrap", () => {
    const r = cli(sb, ["profiles", "login", "claude", "work", "--json"]);
    expectTypedFailure(r, {
      exitCode: 2,
      code: "interactive_json_unsupported",
      context: { harness: "claude", profileId: "work" },
    });
  });

  it("best-of --n 0 is one field-level JSON refusal and starts no run", () => {
    const r = cli(sb, [
      "best-of",
      "compare candidates",
      "--harness",
      "fake-success",
      "--n",
      "0",
      "--json",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("");
    expect(r.strictJson()).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "invalid_request",
      retryable: false,
      fieldErrors: { n: expect.any(Array) },
    });
    const runsRoot = join(sb.repo, ".claudexor", "runs");
    expect(existsSync(runsRoot) ? readdirSync(runsRoot) : []).toHaveLength(0);
  });

  it("doctor fchmod EPERM is one typed daemon bootstrap failure", () => {
    const nodeOptions = [sb.env.NODE_OPTIONS, `--require=${FCHMOD_EPERM_PRELOAD}`]
      .filter(Boolean)
      .join(" ");
    const r = cli(sb, ["doctor", "--all", "--json"], {
      env: { NODE_OPTIONS: nodeOptions },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("");
    expect(r.strictJson()).toMatchObject({
      ok: false,
      exitCode: 1,
      code: "daemon_bootstrap_failed",
      retryable: false,
      context: {
        systemCode: "EPERM",
        syscall: "fchmod",
      },
    });
  });

  it("an unknown output-schema dialect is a typed validation refusal", () => {
    const schemaPath = join(sb.repo, "unknown-dialect.schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        $schema: "https://example.test/custom-json-schema",
        type: "object",
        properties: { ok: { type: "boolean" } },
      }),
    );
    const r = cli(sb, [
      "ask",
      "return ok=true",
      "--harness",
      "fake-success",
      "--output-schema",
      schemaPath,
      "--json",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("");
    expect(r.strictJson()).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "unsupported_schema_dialect",
      status: 400,
      retryable: false,
      context: {
        supportedDialects: [
          { dialect: "draft-07", uri: "http://json-schema.org/draft-07/schema#" },
          {
            dialect: "draft-2020-12",
            uri: "https://json-schema.org/draft/2020-12/schema",
          },
        ],
      },
    });
  });

  it("an unsupported output-schema shape is a typed validation refusal", () => {
    const schemaPath = join(sb.repo, "cyclic-ref.schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        type: "object",
        properties: { x: { $ref: "#/$defs/x" } },
        $defs: { x: { $ref: "#/$defs/x" } },
      }),
    );
    const r = cli(sb, [
      "ask",
      "return ok=true",
      "--harness",
      "fake-success",
      "--output-schema",
      schemaPath,
      "--json",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("");
    expect(r.strictJson()).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "invalid_output_schema",
      status: 400,
      retryable: false,
    });
  });
});
