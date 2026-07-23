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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, cli, makeSandbox, readRunFile } from "./support.js";

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

  it("[INV-116:work-state-veto] a needs_input WorkReport is a GREEN process that is non-applyable and exits non-zero", () => {
    const r = cli(sb, ["ask", "do the thing", "--harness", "fake-needs-input", "--json"]);
    // INV-116: lifecycle succeeded (the process ran clean) but the OUTCOME
    // vetoes — the outcome-aware exit projection returns non-zero.
    expect(r.code, r.stdout + r.stderr).not.toBe(0);
    const out = r.json() as { runDir: string; status: string; outcomeBanner?: string };
    expect(out.status).toBe("succeeded");
    expect(out.outcomeBanner ?? "").toMatch(/needs input/i);
    const telemetry = readRunFile(out.runDir, "final/telemetry.yaml");
    expect(telemetry).toMatch(/needs_input/);
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
});
