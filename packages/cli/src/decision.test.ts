import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";
import { decisionAnswerLines, resolveDecisionBody } from "./decision.js";
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
    expect(resolve(["run-1", "--discard"])).toMatchObject({
      ok: true,
      action: "discard",
      body: { action: "discard" },
    });
    expect(resolve(["run-1", "--taken"])).toMatchObject({
      ok: true,
      action: "taken",
      body: { action: "taken", reason: "captured_result" },
    });
    expect(resolve(["run-1", "--discard", "--revert"])).toMatchObject({ ok: false });
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

describe("decisionAnswerLines", () => {
  it("names the follow-up run, or its job while that run is still unbound", () => {
    expect(
      decisionAnswerLines("rerun_with_feedback", "old-run", {
        accepted: true,
        status: "requeued",
        newRunId: "run-next",
        newJobId: "job-next",
        message: "follow-up run enqueued with reviewer feedback",
      }),
    ).toEqual([
      "decision rerun_with_feedback on old-run: accepted [requeued]",
      "  new run: run-next",
      "  follow-up run enqueued with reviewer feedback",
    ]);
    expect(
      decisionAnswerLines("rerun_with_feedback", "old-run", {
        accepted: true,
        status: "requeued",
        newJobId: "job-next",
        message: "follow-up job enqueued; run start is still pending",
      }),
    ).toEqual([
      "decision rerun_with_feedback on old-run: accepted [requeued]",
      "  new job: job-next",
      "  follow-up job enqueued; run start is still pending",
    ]);
    expect(decisionAnswerLines("revert_run", "old-run", { accepted: false })).toEqual([
      "decision revert_run on old-run: rejected [?]",
    ]);
  });
});

describe("exitCodeForState (D8: the lifecycle IS the exit code)", () => {
  it("treats a succeeded lifecycle as exit 0 and every other lifecycle as 1", () => {
    expect(exitCodeForState("succeeded")).toBe(0);
    for (const bad of ["failed", "cancelled", "interrupted"]) expect(exitCodeForState(bad)).toBe(1);
  });
});
