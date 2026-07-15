import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";
import { resolveDecisionBody } from "./decision.js";
import { exitCodeForState } from "./daemon-run.js";

const resolve = (argv: string[]) => resolveDecisionBody(parseArgs(argv));

describe("resolveDecisionBody", () => {
  it("maps each action flag to its typed RunDecisionAction", () => {
    expect(resolve(["run-1", "--accept-risk"])).toMatchObject({
      ok: true,
      action: "accept_risk",
      body: { action: "accept_risk" },
    });
    expect(resolve(["run-1", "--override"])).toMatchObject({
      ok: true,
      action: "override_needs_human",
    });
    expect(resolve(["run-1", "--revert"])).toMatchObject({ ok: true, action: "revert_run" });
    expect(resolve(["run-1", "--accept-clean-patch"])).toMatchObject({
      ok: true,
      action: "accept_clean_patch",
    });
    expect(resolve(["run-1", "--rerun", "--feedback", "fix it"])).toMatchObject({
      ok: true,
      action: "rerun_with_feedback",
      body: { action: "rerun_with_feedback", feedback: "fix it" },
    });
  });

  it("requires exactly one action flag", () => {
    expect(resolve(["run-1"])).toMatchObject({ ok: false });
    const two = resolve(["run-1", "--accept-risk", "--revert"]);
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.message).toContain("only one action");
  });

  it("rerun requires non-empty feedback", () => {
    const noFeedback = resolve(["run-1", "--rerun"]);
    expect(noFeedback.ok).toBe(false);
    if (!noFeedback.ok) expect(noFeedback.message).toContain("--feedback");
    const blank = resolve(["run-1", "--rerun", "--feedback", "   "]);
    expect(blank.ok).toBe(false);
  });

  it("accept-clean-patch validates --apply-mode and carries it when valid", () => {
    expect(resolve(["run-1", "--accept-clean-patch", "--apply-mode", "branch"])).toMatchObject({
      ok: true,
      body: { action: "accept_clean_patch", applyMode: "branch" },
    });
    const bad = resolve(["run-1", "--accept-clean-patch", "--apply-mode", "nope"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain("invalid --apply-mode");
    // No apply-mode is fine (server defaults to apply).
    expect(resolve(["run-1", "--accept-clean-patch"])).toMatchObject({
      ok: true,
      body: { action: "accept_clean_patch" },
    });
  });
});

describe("exitCodeForState", () => {
  it("treats success-shaped terminals as exit 0 and everything else as 1", () => {
    for (const ok of ["succeeded", "no_op"]) expect(exitCodeForState(ok)).toBe(0);
    for (const bad of [
      "ungated",
      "review_not_run",
      "blocked",
      "failed",
      "cancelled",
      "interrupted_unknown",
      "exhausted",
      "not_converged",
      "stuck_no_progress",
    ])
      expect(exitCodeForState(bad)).toBe(1);
  });
});
