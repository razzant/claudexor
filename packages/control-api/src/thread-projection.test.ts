import { describe, expect, it, vi } from "vitest";
import { ControlRunSummary, ControlTurnRunCard, makeOutcomeFacts } from "@claudexor/schema";
import {
  projectSession,
  projectThread,
  projectTurn,
  projectTurnRunCards,
  turnRunCard,
} from "./thread-projection.js";

describe("Delegate thread-card projection", () => {
  it("submits no turn summary for an already inactive request", async () => {
    const summarize = vi.fn(() => ControlRunSummary.parse({ jobId: "job", state: "running" }));
    const cards = await projectTurnRunCards(
      [{ run_id: "run" }],
      [{ id: "job", runId: "run", state: "running" }],
      summarize,
      () => false,
    );
    expect(cards.size).toBe(0);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("carries the durable outcome and bounded child identities", () => {
    const card = turnRunCard(
      ControlRunSummary.parse({
        jobId: "job-parent",
        runId: "run-parent",
        state: "succeeded",
        delegation: {
          requested: true,
          effective: true,
          used: true,
          reason: "used",
        },
      }),
      ["run-child-1", "run-child-2"],
    );
    expect(card.delegation).toMatchObject({ requested: true, effective: true, used: true });
    expect(card.delegatedChildRunIds).toEqual(["run-child-1", "run-child-2"]);
  });

  it("defaults legacy cards to no outcome and no children", () => {
    const card = ControlTurnRunCard.parse({ state: "succeeded" });
    expect(card.delegation).toBeNull();
    expect(card.delegatedChildRunIds).toEqual([]);
  });

  it.each(["wall_clock_exceeded", "user_cancelled"] as const)(
    "carries the canonical cancelled reason onto compact thread cards (%s)",
    (reason) => {
      const outcomeFacts = makeOutcomeFacts("cancelled", { reason });
      const card = turnRunCard(
        ControlRunSummary.parse({
          jobId: `job-${reason}`,
          runId: `run-${reason}`,
          state: "cancelled",
          outcomeFacts,
        }),
      );
      expect(card.outcomeFacts).toEqual(outcomeFacts);
    },
  );
});

// Release wave round-15 #3: clients can SET a thread-sticky credential
// profile and are SUBJECT to a session's profile binding (resume never
// crosses profiles), so both projections must report the durable fields —
// a settable-but-invisible binding is not auditable.
describe("thread/session projections expose the profile bindings (INV-135)", () => {
  const now = new Date().toISOString();
  const thread = {
    id: "th-1",
    title: "t",
    repo: { root: "/repo", base_ref: "HEAD" },
    mode: "agent",
    workspace: { mode: "in_place" },
    auth_preference: "auto",
    primary_harness: null,
    eligible_harnesses: [],
    run_ids: [],
    head_run_id: null,
    state: "active",
    created_at: now,
    updated_at: now,
  };

  it("projects the thread's sticky credential_profile_id (and null when unset)", () => {
    expect(
      projectThread({ ...thread, credential_profile_id: "work" }, false).credentialProfileId,
    ).toBe("work");
    expect(projectThread(thread, false).credentialProfileId).toBeNull();
  });

  it("projects the session's creation profile_id (and null for engine-default)", () => {
    const session = {
      id: "se-1",
      thread_id: "th-1",
      harness_id: "claude",
      native_session_id: "n-1",
      last_observed_model: null,
      state: "live",
    };
    expect(projectSession({ ...session, profile_id: "work" }).profileId).toBe("work");
    expect(projectSession(session).profileId).toBeNull();
  });
});

// QA-046: the durable Implement turn records the frozen plan's SHA-256 and the
// operator's "Implement anyway" override, but the projection historically
// dropped both — a reviewer could not prove which plan bytes ran or that the
// destructive override was used. The projection must carry them.
describe("projectTurn carries the frozen-plan audit fields (QA-046, INV-081)", () => {
  const now = new Date().toISOString();
  const cards = new Map<string, ReturnType<typeof ControlTurnRunCard.parse>>();

  it("projects plan_hash + plan_readiness_overridden from the durable turn", () => {
    const turn = projectTurn(
      {
        id: "tn-1",
        thread_id: "th-1",
        run_id: null,
        plan_run_id: "run-plan",
        plan_hash: "00a73aeac4e4a11b81cb2d82fb94ac7f7c1fe086ff516972ebfb28c02f358511",
        plan_readiness_overridden: true,
        kind: "decision",
        prompt: "Implement the approved plan",
        created_at: now,
      },
      cards,
    );
    expect(turn.planRunId).toBe("run-plan");
    expect(turn.planHash).toBe("00a73aeac4e4a11b81cb2d82fb94ac7f7c1fe086ff516972ebfb28c02f358511");
    expect(turn.planReadinessOverridden).toBe(true);
  });

  it("projects the durable plan-answer source", () => {
    const turn = projectTurn(
      {
        id: "tn-answer",
        thread_id: "th-1",
        run_id: "run-answer",
        answers_plan_run_id: "run-plan",
        kind: "followup",
        prompt: "answers",
        created_at: now,
      },
      cards,
    );
    expect(turn.answersPlanRunId).toBe("run-plan");
  });

  it("defaults a legacy turn (no freeze fields) to null hash + false override", () => {
    const turn = projectTurn(
      {
        id: "tn-2",
        thread_id: "th-1",
        run_id: null,
        kind: "followup",
        prompt: "hi",
        created_at: now,
      },
      cards,
    );
    expect(turn.planHash).toBeNull();
    expect(turn.planReadinessOverridden).toBe(false);
  });
});
