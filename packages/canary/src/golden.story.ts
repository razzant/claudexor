/**
 * Canary golden stories — user-level contracts over the public CLI surface.
 *
 * Each story name carries the Bible invariant it pins (CLAUDEXOR_BIBLE.md
 * INV-NNN). If a story fails, the named invariant regressed — fix the
 * product, never the story, unless the owner approved a CONCEPT-CHANGE for
 * that invariant.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLI,
  type Sandbox,
  cli,
  makeSandbox,
  readEvents,
  readRunFile,
  runFileExists,
} from "./support.js";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.dispose();
});

describe("canary golden stories", () => {
  it("[INV-032:modes-canonical] an unknown mode id hard-errors and never silently runs another mode", () => {
    const r = cli(sb, [
      "agent",
      "do things",
      "--mode",
      "daily",
      "--harness",
      "fake-success",
      "--json",
    ]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/mode/i);
  });

  it("[INV-021:fail-loud-flags] an unknown flag fails loudly with exit 2, never runs with defaults", () => {
    const r = cli(sb, ["ask", "2+2?", "--frobnicate", "--harness", "fake-success", "--json"]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/unknown flag|frobnicate/i);
  });

  it("[INV-021:spec-grounding-flags] spec --answers refuses grounding-only flags instead of silently ignoring them", () => {
    const r = cli(sb, [
      "spec",
      "add a multiply feature",
      "--answers",
      "does-not-matter.json",
      "--effort",
      "low",
      "--json",
    ]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/grounding plan run/);
    const withHarness = cli(sb, [
      "spec",
      "add a multiply feature",
      "--answers",
      "does-not-matter.json",
      "--harness",
      "fake-success",
      "--json",
    ]);
    expect(withHarness.code).toBe(2);
    const withReviewer = cli(sb, [
      "spec",
      "add a multiply feature",
      "--answers",
      "does-not-matter.json",
      "--reviewer-effort",
      "openai=low",
      "--json",
    ]);
    expect(withReviewer.code).toBe(2);
    expect(withReviewer.stdout + withReviewer.stderr).toMatch(
      /reviewer-effort.*grounding plan run/,
    );
    // And malformed values fail loudly on the grounding path too.
    const bad = cli(sb, ["spec", "add a multiply feature", "--max-usd", "not-a-number", "--json"]);
    expect(bad.code).toBe(2);
  });

  it("[INV-033:verbs-renamed] the retired verbs run/race hard-error with the new spelling, never silently alias", () => {
    const oldRun = cli(sb, ["run", "do things", "--harness", "fake-success", "--json"]);
    expect(oldRun.code).toBe(2);
    expect(oldRun.stdout + oldRun.stderr).toContain("claudexor agent");
    const oldRace = cli(sb, [
      "race",
      "do things",
      "--n",
      "2",
      "--harness",
      "fake-success",
      "--json",
    ]);
    expect(oldRace.code).toBe(2);
    expect(oldRace.stdout + oldRace.stderr).toContain("claudexor best-of");
  });

  it("[INV-035:cli-all-modes-daemon-owned] every product mode returns a durable daemon handle", () => {
    const commands: Array<{ args: string[]; mode: string; harness?: string }> = [
      { args: ["ask", "answer"], mode: "ask" },
      { args: ["plan", "plan"], mode: "plan" },
      { args: ["agent", "inspect", "--mode", "audit"], mode: "audit" },
      { args: ["agent", "change"], mode: "agent" },
      {
        args: ["agent", "coordinate", "--mode", "orchestrate"],
        mode: "orchestrate",
        harness: "fake-implement",
      },
    ];
    for (const command of commands) {
      const result = cli(sb, [
        ...command.args,
        "--harness",
        command.harness ?? "fake-success",
        "--json",
      ]);
      expect(result.code, `${command.mode}: ${result.stdout}${result.stderr}`).toBe(0);
      const output = result.json() as { jobId?: string; mode?: string };
      expect(output.jobId).toMatch(/^job-/);
      expect(output.mode).toBe(command.mode);
    }
  });

  it("[INV-062:prompt-secret-block] a secret-like value in the prompt is hard-blocked before any run starts (no bypass)", () => {
    const secret = "sk-" + "z".repeat(24);
    const r = cli(sb, [
      "agent",
      `deploy the service using ${secret}`,
      "--harness",
      "fake-success",
      "--json",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/durable run artifacts/);
    expect(r.stdout + r.stderr).toContain("claudexor secrets set");
    // Nothing ran: no run directory was created for the blocked prompt.
    const runsRoot = join(sb.repo, ".claudexor", "runs");
    const runDirs = existsSync(runsRoot) ? readdirSync(runsRoot) : [];
    expect(runDirs.length).toBe(0);
  });

  it("[INV-093:plan-honest-no-op] a plan run says 'plan, no files changed' and never claims a green patch", () => {
    const r = cli(sb, [
      "plan",
      "make add() add instead of subtract",
      "--harness",
      "fake-success",
      "--json",
    ]);
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
    const terminal = types.findIndex(
      (t) => t === "run.completed" || t === "run.failed" || t === "run.blocked",
    );
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
    const r = cli(sb, ["ask", "what is 2+2?", "--harness", "fake-success", "--json"], {
      cwd: sb.home,
    });
    expect(r.code).toBe(0);
    const out = r.json() as { runDir: string; status: string };
    expect(out.status).toBe("success");
    expect(realpathSync(out.runDir).startsWith(realpathSync(sb.home))).toBe(true);
    expect(readRunFile(out.runDir, "final/answer.md").length).toBeGreaterThan(0);
  });

  it("[INV-112:apply-needs-verified-review] a race with no available reviewers is honest (review_not_run) and apply refuses, naming the remedy", () => {
    const r = cli(sb, [
      "best-of",
      "fix add() so it adds",
      "--harness",
      "fake-implement",
      "--n",
      "2",
      "--test",
      'node -e "process.exit(0)"',
      "--json",
    ]);
    expect(r.code).toBe(1);
    const out = r.json() as { runId: string; runDir: string; status: string };
    // Offline fakes cannot produce a cross-family verified review; the honest
    // terminal and process status are review_not_run/nonzero — never a green
    // "succeeded" or exit 0 over an
    // unreviewed patch (Bible: verification basis is disclosed, gates alone
    // do not make a patch applyable).
    expect(out.status).toBe("review_not_run");
    expect(readRunFile(out.runDir, "final/patch.diff").length).toBeGreaterThan(0);
    const check = cli(sb, ["apply", out.runId, "--dry-run"]);
    expect(check.code).toBe(1);
    expect(check.stdout + check.stderr).toMatch(/refusing apply|not applyable/);
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

  it("[INV-116:stream-watchdog] a wedged harness stream is killed by the inactivity watchdog with a typed failure", () => {
    // fake-hang emits one event then goes silent forever; with a 1.5s window
    // the run must end as a typed failure instead of parking in `running`.
    const r = cli(sb, ["ask", "please wedge", "--harness", "fake-hang", "--json"], {
      env: { CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS: "1500" },
    });
    const out = r.json() as { runDir: string; status: string; summary?: string };
    expect(out.status).toBe("failed");
    expect(out.summary ?? "").toContain("inactivity watchdog");
    const events = readEvents(out.runDir);
    expect(events.some((e) => e["type"] === "run.failed")).toBe(true);
  });

  it("[INV-116:cancel-fast] cancelling a run acknowledges within seconds even when gates are configured", async () => {
    // A run with a 60s deterministic gate: Ctrl-C during the GATE phase must
    // end the run within seconds (SIGINT -> typed daemon cancel -> abort
    // kills the in-flight gate and skips the rest), not wait out the suite.
    // The terminal is a typed cancelled run.failed and telemetry still lands.
    const child = spawn(
      process.execPath,
      [CLI, "agent", "cancel me", "--harness", "fake-success", "--test", "sleep 60", "--json"],
      {
        cwd: sb.repo,
        env: sb.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += String(c);
    });
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    // Wait until the 60s gate is RUNNING (gate.started in events), then interrupt.
    const runtimeRoot = join(sb.configDir, "projects");
    const deadline = Date.now() + 60_000;
    let runDir: string | null = null;
    let gateRunning = false;
    while (Date.now() < deadline && !gateRunning) {
      if (!runDir && existsSync(runtimeRoot)) {
        const found = readdirSync(runtimeRoot, { recursive: true, encoding: "utf8" }).find(
          (entry) => entry.endsWith("events.jsonl"),
        );
        if (found) runDir = dirname(join(runtimeRoot, found));
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

  it("[INV-111:blocked-needs-decision] a NEEDS_HUMAN-blocked run refuses apply until a typed operator decision exists, then applies", async () => {
    // Protected-path tamper is the deterministic NEEDS_HUMAN trigger: the spec
    // freezes FAKE_CHANGE.txt as protected, the file EXISTS in the repo, and
    // fake-implement overwrites it -> reviewer escalates -> blocked terminal.
    execFileSync("git", ["-C", sb.repo, "config", "user.email", "c@c"]);
    execFileSync("git", ["-C", sb.repo, "config", "user.name", "c"]);
    writeFileSync(join(sb.repo, "FAKE_CHANGE.txt"), "protected original\n");
    execFileSync("git", ["-C", sb.repo, "add", "-A"]);
    execFileSync("git", ["-C", sb.repo, "commit", "-qm", "protect fixture"]);
    const spec = {
      schema_version: 2,
      id: "spec-canary-protected",
      created_at: new Date().toISOString(),
      version: 1,
      frozen: true,
      intent: { raw: "change the protected file" },
      constraints: { protected_paths: ["FAKE_CHANGE.txt"] },
      tests: [{ id: "t1", command: 'node -e "process.exit(0)"' }],
    };
    const specPath = join(sb.repo, "spec.json");
    writeFileSync(specPath, JSON.stringify(spec));
    const r = cli(sb, [
      "best-of",
      "tamper the protected file",
      "--spec",
      specPath,
      "--harness",
      "fake-implement",
      "--n",
      "2",
      "--json",
    ]);
    const out = r.json() as { runId: string; runDir: string; status: string };
    expect(out.status).toBe("blocked");
    expect(readRunFile(out.runDir, "final/failure.yaml")).toMatch(/NEEDS_HUMAN|human/i);
    // Apply REFUSES while no typed operator decision exists, naming the remedy.
    const refused = cli(sb, ["apply", out.runId, "--dry-run"]);
    expect(refused.code).toBe(1);
    expect(refused.stdout + refused.stderr).toMatch(/refusing apply|not applyable/);
    expect(refused.stdout + refused.stderr).toMatch(/decision/i);
    // The typed operator decision (public surface: claudexor decision --override)
    // unblocks apply for THIS patch.
    const decided = cli(sb, ["decision", out.runId, "--override", "--json"]);
    expect(decided.code).toBe(0);
    const applied = cli(sb, ["apply", out.runId, "--dry-run"]);
    expect(applied.code).toBe(0);
  }, 120_000);

  it("[INV-041:crlf-diff-fidelity] a candidate patch over CRLF content survives byte-faithfully and applies onto the live tree", () => {
    // The repo holds a COMMITTED CRLF file; fake-implement overwrites it with
    // LF content. The captured patch must carry the original CR bytes (raw
    // capture, no readline mangling) and must APPLY cleanly back onto the
    // live tree — the round-trip the phase's diff-fidelity work guarantees.
    execFileSync("git", ["-C", sb.repo, "config", "user.email", "c@c"]);
    execFileSync("git", ["-C", sb.repo, "config", "user.name", "c"]);
    writeFileSync(join(sb.repo, "FAKE_CHANGE.txt"), "line one\r\nline two\r\n");
    execFileSync("git", ["-C", sb.repo, "add", "-A"]);
    execFileSync("git", ["-C", sb.repo, "commit", "-qm", "crlf fixture"]);
    const r = cli(sb, [
      "agent",
      "rewrite the file",
      "--harness",
      "fake-implement",
      "--test",
      'node -e "process.exit(0)"',
      "--json",
    ]);
    const out = r.json() as { runId: string; runDir: string; status: string };
    const patch = readRunFile(out.runDir, "final/patch.diff");
    // The removed CRLF lines keep their CR bytes inside the patch artifact.
    expect(patch).toMatch(/-line one\r\n/);
    // The artifact byte-fidelity contract: git itself confirms the patch
    // applies onto the live tree. (`claudexor apply` additionally demands a
    // verified review — INV-112, pinned by its own story above — so the
    // fidelity check goes straight to git.)
    const patchPath = join(sb.repo, ".crlf-canary.patch");
    writeFileSync(patchPath, patch);
    execFileSync("git", ["-C", sb.repo, "apply", "--check", patchPath]);
  });

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
      "best-of",
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
      harnesses: Array<{
        harnessId: string;
        source: string;
        models: Array<{ id: string }>;
        verifiedAgainst: string | null;
      }>;
    };
    const fake = out.harnesses.find((h) => h.harnessId === "fake-success");
    expect(fake?.source).toBe("manifest");
    expect(fake?.models.map((m) => m.id)).toContain("fake-model");

    const doctor = cli(sb, ["doctor", "--harness", "fake-success", "--all", "--json"]);
    expect(doctor.code).toBe(0);
    expect(
      (doctor.json() as { harnesses: Array<{ id: string }> }).harnesses.map((h) => h.id),
    ).toEqual(["fake-success"]);
  });

  it("[INV-122:trust-daemon-owned] trust reads and writes the disposable user-level store through the daemon", () => {
    const initial = cli(sb, ["trust", "--json"]);
    expect(initial.code).toBe(0);
    expect(initial.json()).toMatchObject({ allowFullAccess: false });

    const changed = cli(sb, ["trust", "--access-default", "readonly", "--json"]);
    expect(changed.code).toBe(0);
    expect(changed.json()).toMatchObject({ accessDefault: "readonly" });

    const shown = cli(sb, ["trust", "--json"]);
    expect(shown.json()).toMatchObject({ accessDefault: "readonly" });

    const stored = cli(sb, ["secrets", "set", "openai", "--from-env", "CX_TEST_SECRET", "--json"], {
      env: { CX_TEST_SECRET: "disposable-test-value" },
    });
    expect(stored.code).toBe(0);
    expect(stored.json()).toMatchObject({ name: "openai", backend: "file", stored: true });
    expect(cli(sb, ["secrets", "list", "--json"]).json()).toMatchObject({
      backend: "file",
      secrets: [{ name: "openai", present: true }],
    });
    expect(cli(sb, ["secrets", "delete", "openai", "--json"]).json()).toMatchObject({
      name: "openai",
      deleted: true,
    });
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
    // Fakes are test fixtures, never persistable routing targets.
    const fake = cli(sb, ["settings", "set", "harness.fake-success.default_model", "fake-model"]);
    expect(fake.code).toBe(1);
    expect(fake.stdout + fake.stderr).toMatch(/fake-success.*(?:not persistable|not a real)/i);
  });

  it("[INV-103:no-global-model] the retired global default_model setting hard-errors with the harness-scoped remedy", () => {
    const r = cli(sb, ["settings", "set", "default_model", "gpt-5.5"]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/harness-scoped|harness\.<id>\.default_model/);
  });
});
