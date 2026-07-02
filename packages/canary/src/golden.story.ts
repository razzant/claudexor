/**
 * Canary golden stories — user-level contracts over the public CLI surface.
 *
 * Each story name carries the Bible invariant it pins (CLAUDEXOR_BIBLE.md
 * INV-NNN). If a story fails, the named invariant regressed — fix the
 * product, never the story, unless the owner approved a CONCEPT-CHANGE for
 * that invariant.
 */
import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, cli, makeSandbox, readEvents, readRunFile, runFileExists } from "./support.js";

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

  // [INV-116:cancel-fast] cancel latency story is a Phase 3 deliverable (watchdog +
  // abort-before-gates); pinned here as an explicit todo so the gap stays loud.
  it.todo("[INV-116:cancel-fast] cancelling a run acknowledges within seconds even when gates are configured");

  // [INV-111:blocked-needs-decision] requires a deterministic NEEDS_HUMAN fake or a
  // protected-path fixture; lands with the Phase 1 canary expansion.
  it.todo("[INV-111:blocked-needs-decision] a blocked run refuses apply until a typed operator decision exists");
});
