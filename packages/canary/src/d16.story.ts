/**
 * D-16 canary golden stories — the model-authored WorkReport contract and the
 * work_state veto axis, pinned to INV-116 (the run's terminal truth = the D8
 * axes, orthogonal to the process lifecycle).
 *
 * The fake-work-* / fake-context-exhausted harnesses emit a REAL structured
 * envelope (and a typed context signal), so the whole D-16 path is exercised
 * offline over the public CLI surface: compile → constrain → unwrap → finalize
 * → project. If a story fails, INV-116 regressed — fix the product, not the
 * story.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, cli, makeSandbox, readEvents, readRunFile } from "./support.js";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.dispose();
});

describe("D-16 WorkReport + work_state canaries", () => {
  it("[INV-116:work-complete] a completed WorkReport ⇒ succeeded, exit 0, answer.md holds the OUTPUT not the envelope", () => {
    const r = cli(sb, ["ask", "do the thing", "--harness", "fake-work-complete", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const out = r.json() as { runDir: string; status: string };
    expect(out.status).toBe("succeeded");
    // answer.md persists the unwrapped OUTPUT, never the {work_report,...} envelope.
    const answer = readRunFile(out.runDir, "final/answer.md");
    expect(answer).toContain("Implemented by the fake harness.");
    expect(answer).not.toContain("work_report");
    const telemetry = readRunFile(out.runDir, "final/telemetry.yaml");
    expect(telemetry).toMatch(/work_state/);
    expect(telemetry).toMatch(/completed/);
  });

  it("[INV-116:work-state-veto] a needs_input WorkReport with a REAL diff is a GREEN process that is NON-APPLYABLE end-to-end and exits non-zero", () => {
    // A patch-producing agent run (fake-needs-input writes a real worktree file
    // for the implement intent) so the whole apply boundary is exercised: the
    // model attests needs_input while a diff exists. INV-116 / B-1: the run is a
    // succeeded lifecycle but the work_state VETOES applyability — apply must
    // refuse, not just the exit code.
    const r = cli(sb, ["agent", "do the thing", "--harness", "fake-needs-input", "--json"]);
    // INV-116: lifecycle succeeded (the process ran clean) but the OUTCOME
    // vetoes — the outcome-aware exit projection returns non-zero.
    expect(r.code, r.stdout + r.stderr).not.toBe(0);
    const out = r.json() as {
      runId: string;
      runDir: string;
      status: string;
      outcomeBanner?: string;
      applyEligibility?: { eligible?: boolean; state?: string } | null;
    };
    expect(out.status).toBe("succeeded");
    // A real diff was produced, and the banner discloses the non-applied veto.
    expect(readRunFile(out.runDir, "final/patch.diff").length).toBeGreaterThan(0);
    expect(out.outcomeBanner ?? "").toMatch(/needs input/i);
    expect(out.outcomeBanner ?? "").toMatch(/NOT APPLIED/i);
    const telemetry = readRunFile(out.runDir, "final/telemetry.yaml");
    expect(telemetry).toMatch(/needs_input/);
    // B-1: the work_state veto makes the run non-applyable via the single gate —
    // the derived eligibility says needs_input, and `apply` itself refuses.
    expect(out.applyEligibility?.eligible).toBe(false);
    expect(out.applyEligibility?.state).toBe("needs_input");
    const check = cli(sb, ["apply", out.runId, "--dry-run"]);
    expect(check.code).toBe(1);
    expect(check.stdout + check.stderr).toMatch(/needs more input|can't be applied/i);
  });

  it("[INV-116:work-report-contract] a malformed WorkReport on a constrained route is a typed FAILURE, never a prose success", () => {
    const r = cli(sb, ["ask", "do the thing", "--harness", "fake-work-malformed", "--json"]);
    expect(r.code).not.toBe(0);
    const out = r.json() as { status: string };
    // The constrained route promised a WorkReport and broke the contract — the
    // attempt fails; it must never terminalize as a prose success.
    expect(out.status).not.toBe("succeeded");
  });

  it("[INV-116:context-interrupted] a terminal context exhaustion with no completed report ⇒ interrupted", () => {
    const r = cli(sb, ["ask", "do the thing", "--harness", "fake-context-exhausted", "--json"]);
    expect(r.code).not.toBe(0);
    const out = r.json() as { status: string };
    expect(out.status).toBe("interrupted");
  });

  it("[INV-116:continuation] an eligible context exhaustion triggers a one-shot continuation that completes ⇒ succeeded, exit 0", () => {
    const r = cli(sb, ["ask", "do the thing", "--harness", "fake-context-then-complete", "--json"]);
    // The first turn exhausts (repeated_refill); the engine launches ONE
    // fresh-session continuation which completes with a valid WorkReport.
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const out = r.json() as { runDir: string; status: string };
    expect(out.status).toBe("succeeded");
    // The continuation was DISCLOSED as a typed run.continuation event.
    const events = readEvents(out.runDir);
    const cont = events.find((e) => e["type"] === "run.continuation");
    expect(cont, "run.continuation event present").toBeTruthy();
    expect((cont?.["payload"] as Record<string, unknown>)?.["cause"]).toBe("repeated_refill");
    expect((cont?.["payload"] as Record<string, unknown>)?.["continuation_count"]).toBe(1);
    // answer.md holds the continuation's OUTPUT, not the envelope.
    const answer = readRunFile(out.runDir, "final/answer.md");
    expect(answer).toContain("Completed after a one-shot continuation.");
    expect(answer).not.toContain("work_report");
  });

  it("[INV-116:continuation-denied] an eligible exhaustion whose continuation lease is DENIED discloses run.continuation.denied, never a false run.continuation", () => {
    // An ENVELOPED candidate reserves its one-shot continuation WITH the estimate
    // floor (0.05). A finite cap below that floor admits the first candidate (no
    // floor) but refuses the continuation lease (estimate_headroom). The
    // reserve-before-disclose fix must emit run.continuation.denied and NEVER a
    // run.continuation claiming a launch that never happened.
    writeFileSync(
      join(sb.configDir, "config.yaml"),
      "budget:\n  paid_budget_per_run:\n    kind: finite\n    maxUsd: 0.03\n",
    );
    const r = cli(sb, [
      "agent",
      "do the thing",
      "--harness",
      "fake-context-then-complete",
      "--json",
    ]);
    const out = r.json() as { runDir: string };
    const events = readEvents(out.runDir);
    expect(
      events.find((e) => e["type"] === "run.continuation.denied"),
      "run.continuation.denied disclosed",
    ).toBeTruthy();
    // The false-launch disclosure must be absent — the continuation never ran.
    expect(events.some((e) => e["type"] === "run.continuation")).toBe(false);
  });

  it("[INV-116:plan-needs-input] a needs_input WorkReport on the winning PLANNER vetoes the plan terminal — succeeded lifecycle, exit non-zero", () => {
    // Wave-1 parity fix: the plan finalizer previously ALWAYS emitted a clean
    // succeeded and ignored the winner's work_state. A plan whose capable route
    // reports needs_input must exit non-zero and disclose the veto.
    const r = cli(sb, ["plan", "do the thing", "--harness", "fake-needs-input", "--json"]);
    expect(r.code, r.stdout + r.stderr).not.toBe(0);
    const out = r.json() as { runDir: string; status: string };
    expect(out.status).toBe("succeeded");
    const telemetry = readRunFile(out.runDir, "final/telemetry.yaml");
    expect(telemetry).toMatch(/needs_input/);
    const events = readEvents(out.runDir);
    expect(events.some((e) => e["type"] === "run.blocked")).toBe(true);
  });

  it("[INV-116:plan-incomplete] an incomplete WorkReport on the winning PLANNER vetoes the plan terminal — succeeded lifecycle, exit non-zero", () => {
    const r = cli(sb, ["plan", "do the thing", "--harness", "fake-work-incomplete", "--json"]);
    expect(r.code, r.stdout + r.stderr).not.toBe(0);
    const out = r.json() as { runDir: string; status: string };
    expect(out.status).toBe("succeeded");
    const telemetry = readRunFile(out.runDir, "final/telemetry.yaml");
    expect(telemetry).toMatch(/incomplete/);
  });

  it("[INV-116:plan-context] a terminal context exhaustion on the winning PLANNER ⇒ interrupted plan, exit non-zero", () => {
    const r = cli(sb, ["plan", "do the thing", "--harness", "fake-context-exhausted", "--json"]);
    expect(r.code, r.stdout + r.stderr).not.toBe(0);
    const out = r.json() as { status: string };
    expect(out.status).toBe("interrupted");
  });

  it("[INV-116:agent-continuation] an eligible context exhaustion on an ENVELOPED candidate triggers a one-shot continuation that completes ⇒ succeeded, exit 0", () => {
    // Wave-1 parity fix: the continuation controller was wired only into the
    // read-only loop. An enveloped candidate that exhausts context (repeated_refill)
    // must get the SAME one-shot fresh-session continuation and supersede the
    // exhausted attempt only after the continuation completes.
    const r = cli(sb, [
      "agent",
      "do the thing",
      "--harness",
      "fake-context-then-complete",
      "--json",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const out = r.json() as { runDir: string; status: string };
    expect(out.status).toBe("succeeded");
    const events = readEvents(out.runDir);
    const cont = events.find((e) => e["type"] === "run.continuation");
    expect(cont, "run.continuation event present").toBeTruthy();
    expect((cont?.["payload"] as Record<string, unknown>)?.["cause"]).toBe("repeated_refill");
    expect((cont?.["payload"] as Record<string, unknown>)?.["continuation_count"]).toBe(1);
  });
});
