/**
 * Canary golden stories — user-level contracts over the public CLI surface.
 *
 * Each story name carries the Bible invariant it pins (CLAUDEXOR_BIBLE.md
 * INV-NNN). If a story fails, the named invariant regressed — fix the
 * product, never the story, unless the owner approved a CONCEPT-CHANGE for
 * that invariant.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI, type Sandbox, cli, makeSandbox, readEvents, readRunFile, runFileExists } from "./support.js";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.dispose();
});

describe("canary golden stories", () => {
  it("[INV-032:modes-canonical] an unknown mode id hard-errors and never silently runs another mode", () => {
    const r = cli(sb, ["run", "do things", "--mode", "daily", "--harness", "fake-success", "--json"]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/mode/i);
  });

  it("[INV-021:fail-loud-flags] an unknown flag fails loudly with exit 2, never runs with defaults", () => {
    const r = cli(sb, ["ask", "2+2?", "--frobnicate", "--harness", "fake-success", "--json"]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/unknown flag|frobnicate/i);
  });

  it("[INV-093:plan-honest-no-op] a plan run says 'plan, no files changed' and never claims a green patch", () => {
    const r = cli(sb, ["plan", "make add() add instead of subtract", "--harness", "fake-success", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json() as { runDir: string; status: string };
    expect(runFileExists(out.runDir, "final/plan.md")).toBe(true);
    const wp = readRunFile(out.runDir, "final/work_product.yaml");
    expect(wp).toMatch(/result_kind: plan/);
    expect(runFileExists(out.runDir, "final/patch.diff")).toBe(false);
  });

  it("[INV-116:output-ready-before-terminal] output.ready precedes the terminal run event in the canonical event log", () => {
    const r = cli(sb, ["ask", "what is 2+2?", "--harness", "fake-success", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json() as { runDir: string };
    const events = readEvents(out.runDir);
    const types = events.map((e) => e["type"]);
    const firstReady = types.indexOf("output.ready");
    const terminal = types.findIndex((t) => t === "run.completed" || t === "run.failed" || t === "run.blocked");
    expect(firstReady).toBeGreaterThanOrEqual(0);
    expect(terminal).toBeGreaterThan(firstReady);
    // seq is monotonic per run — the SSE snapshot-then-subscribe contract.
    const seqs = events.map((e) => e["seq"] as number);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  it("[INV-071:project-context-explicit] CLI Ask anchors artifacts to the invoking directory — never some other repo's store", () => {
    // The CLI contract: the process cwd IS the project scope, even for a plain
    // non-git folder on a read-only ask. (The app's no-project Ask with the
    // user-level store is a control-api thread story — Phase 1 expansion.)
    const r = cli(sb, ["ask", "what is 2+2?", "--harness", "fake-success", "--json"], { cwd: sb.home });
    expect(r.code).toBe(0);
    const out = r.json() as { runDir: string; status: string };
    expect(out.status).toBe("success");
    expect(realpathSync(out.runDir).startsWith(realpathSync(sb.home))).toBe(true);
    expect(readRunFile(out.runDir, "final/answer.md").length).toBeGreaterThan(0);
  });

  it("[INV-112:apply-needs-verified-review] a race with no available reviewers is honest (review_not_run) and apply refuses, naming the remedy", () => {
    const r = cli(sb, [
      "race",
      "fix add() so it adds",
      "--harness",
      "fake-implement",
      "--n",
      "2",
      "--test",
      'node -e "process.exit(0)"',
      "--json",
    ]);
    expect(r.code).toBe(0);
    const out = r.json() as { runId: string; runDir: string; status: string };
    // Offline fakes cannot produce a cross-family verified review; the honest
    // terminal is review_not_run — never a green "succeeded" over an
    // unreviewed patch (Bible: verification basis is disclosed, gates alone
    // do not make a patch applyable).
    expect(out.status).toBe("review_not_run");
    expect(readRunFile(out.runDir, "final/patch.diff").length).toBeGreaterThan(0);
    const check = cli(sb, ["apply", out.runId, "--dry-run"]);
    expect(check.code).toBe(1);
    expect(check.stdout + check.stderr).toMatch(/refusing apply/);
    expect(check.stdout + check.stderr).toMatch(/cross-family review/);
  });

  it("[INV-040:evidence-beats-summaries] a failed harness run writes inspectable failure artifacts, never a silent green", () => {
    const r = cli(sb, ["ask", "please explode", "--harness", "fake-invalid-json", "--json"]);
    const out = r.json() as { runDir: string; status: string };
    expect(out.status).not.toBe("succeeded");
    expect(runFileExists(out.runDir, "final/failure.yaml")).toBe(true);
    expect(runFileExists(out.runDir, "final/summary.md")).toBe(true);
    const events = readEvents(out.runDir);
    expect(events.some((e) => e["type"] === "run.failed")).toBe(true);
  });

  it("[INV-116:cancel-fast] cancelling a run acknowledges within seconds even when gates are configured", async () => {
    // A run with a 60s deterministic gate: Ctrl-C during the GATE phase must
    // end the run within seconds (SIGINT -> typed daemon cancel -> abort
    // kills the in-flight gate and skips the rest), not wait out the suite.
    // The terminal is a typed cancelled run.failed and telemetry still lands.
    const child = spawn(process.execPath, [CLI, "run", "cancel me", "--harness", "fake-success", "--test", "sleep 60", "--json"], {
      cwd: sb.repo,
      env: sb.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += String(c);
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    // Wait until the 60s gate is RUNNING (gate.started in events), then interrupt.
    const runsDir = join(sb.repo, ".claudexor", "runs");
    const deadline = Date.now() + 60_000;
    let runDir: string | null = null;
    let gateRunning = false;
    while (Date.now() < deadline && !gateRunning) {
      if (!runDir && existsSync(runsDir)) {
        const found = readdirSync(runsDir).find((e) => existsSync(join(runsDir, e, "events.jsonl")));
        if (found) runDir = join(runsDir, found);
      }
      if (runDir) {
        gateRunning = readEvents(runDir).some((e) => e["type"] === "gate.started");
      }
      if (!gateRunning) await new Promise((r) => setTimeout(r, 100));
    }
    expect(gateRunning).toBe(true);
    const cancelledAt = Date.now();
    child.kill("SIGINT");
    const code = await exited;
    const ackMs = Date.now() - cancelledAt;
    expect(ackMs).toBeLessThan(15_000); // far under the 60s gate
    expect(code).not.toBe(0);
    const events = readEvents(runDir as string);
    expect(events.some((e) => e["type"] === "run.failed")).toBe(true);
    const out = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { status: string };
    expect(out.status).toBe("cancelled");
    expect(runFileExists(runDir as string, "final/telemetry.yaml")).toBe(true);
  }, 90_000);

  // [INV-111:blocked-needs-decision] requires a deterministic NEEDS_HUMAN fake or a
  // protected-path fixture; lands with the Phase 1 canary expansion.
  it.todo("[INV-111:blocked-needs-decision] a blocked run refuses apply until a typed operator decision exists");

  it("[INV-104:model-truth-refusal] a model outside the harness truth source is a typed preflight refusal with artifacts — no CLI spawn, no opaque native error", () => {
    const r = cli(sb, [
      "ask",
      "what is 2+2?",
      "--harness",
      "fake-success",
      "--model",
      "gpt-nonexistent-model",
      "--json",
    ]);
    const out = r.json() as { runDir: string; status: string };
    expect(out.status).toBe("failed");
    const failure = readRunFile(out.runDir, "final/failure.yaml");
    expect(failure).toContain("gpt-nonexistent-model");
    expect(failure).toContain("fake-success");
    expect(failure).toContain("truth source");
  });

  it("[INV-103:scalar-model-primary-only] a scalar model with a multi-harness pool and no primary is rejected, never poisons the pool", () => {
    const r = cli(sb, [
      "race",
      "fix add()",
      "--harness",
      "fake-success,fake-implement",
      "--n",
      "2",
      "--model",
      "fake-model",
      "--json",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/ambiguous without a primary harness/);
  });

  it("[INV-104:models-manifest-fallback] `claudexor models` reports manifest-sourced hints with the verification note, never a fake 'api' claim", () => {
    const r = cli(sb, ["models", "--harness", "fake-success", "--all", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json() as {
      harnesses: Array<{ harnessId: string; source: string; models: Array<{ id: string }>; verifiedAgainst: string | null }>;
    };
    const fake = out.harnesses.find((h) => h.harnessId === "fake-success");
    expect(fake?.source).toBe("manifest");
    expect(fake?.models.map((m) => m.id)).toContain("fake-model");
  });

  it("[INV-104:settings-write-strict] `settings set harness.<id>.default_model` refuses a model outside the truth source and persists nothing", () => {
    // codex's manifest known_models is the offline truth source here.
    const bad = cli(sb, ["settings", "set", "harness.codex.default_model", "ghost-model-9000"]);
    expect(bad.code).toBe(1);
    expect(bad.stdout + bad.stderr).toMatch(/refused|not in the harness/i);
    const show = cli(sb, ["settings", "show", "--json"]);
    expect(show.stdout).not.toContain("ghost-model-9000");
    const good = cli(sb, ["settings", "set", "harness.codex.default_model", "gpt-5.5"]);
    expect(good.code).toBe(0);
    const show2 = cli(sb, ["settings", "show", "--json"]);
    expect(show2.stdout).toContain("gpt-5.5");
    // Fakes are test fixtures, never persistable routing targets (T1#26).
    const fake = cli(sb, ["settings", "set", "harness.fake-success.default_model", "fake-model"]);
    expect(fake.code).toBe(1);
    expect(fake.stdout + fake.stderr).toMatch(/unknown harness 'fake-success'/);
  });

  it("[INV-103:no-global-model] the retired global default_model setting hard-errors with the harness-scoped remedy", () => {
    const r = cli(sb, ["settings", "set", "default_model", "gpt-5.5"]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/harness-scoped|harness\.<id>\.default_model/);
  });
});
