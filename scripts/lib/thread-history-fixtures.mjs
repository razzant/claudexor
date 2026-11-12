export function threadHistoryFixtures(schema) {
  const revision = { epoch: "11111111-1111-4111-8111-111111111111", sequence: 42 };
  const { runIds: _runIds, ...thread } = schema.ControlThread.parse({
    id: "th-history",
    createdAt: "2026-10-26T10:00:00Z",
    updatedAt: "2026-10-26T10:00:00Z",
  });
  const empty = schema.ThreadHistoryPage.parse({
    storeId: "22222222-2222-4222-8222-222222222222",
    threadId: thread.id,
    epoch: "partition-epoch",
    revision,
    header: {
      thread,
      latestTurnId: null,
      latestOrdinal: null,
      latestAdmission: null,
      headRun: null,
      headRunStatus: "unbound",
      sessions: [],
      sessionsComplete: true,
    },
    turns: [],
    hasOlder: false,
    hasNewer: false,
    olderCursor: null,
    newerCursor: null,
    replayCursor: null,
    replayNextCursor: null,
    limitedBy: null,
  });
  const refusal = schema.ThreadHistoryTurn.parse({
    id: "turn-refused",
    threadId: thread.id,
    createdAt: thread.createdAt,
    ordinal: 0,
    revision,
    prompt: "Question 😀",
    promptInfo: { textBytes: 13, totalTextBytes: 13, truncated: false },
    run: null,
    runStatus: "unbound",
    primaryOutput: null,
    primaryOutputStatus: "none",
    answeredByTurnId: null,
    answeredByPrompt: null,
    planAnswerComplete: true,
    enqueueError: {
      message: "Choose an available route",
      retryable: false,
      failedAt: thread.createdAt,
    },
  });
  const settled = schema.ThreadHistoryTurn.parse({
    ...refusal,
    id: "turn-settled",
    ordinal: 1,
    runId: "run-history",
    enqueueError: null,
    runStatus: "available",
    primaryOutputStatus: "available",
    run: schema.ThreadHistoryRun.parse({
      state: "succeeded",
      mode: "plan",
      harnesses: ["fake"],
      runDir: "/fixtures/runs/run-history",
      authRoute: {
        requested: "auto",
        effective: "local_session",
        source: "native_session",
        reason: "native_first",
        profileId: "profile-history",
      },
      startedAt: thread.createdAt,
      finishedAt: thread.updatedAt,
      spendUsd: null,
      spendEstimated: true,
      toolCount: { value: 2, coverage: "partial" },
      fileCount: { value: null, coverage: "unavailable" },
      applyEligibilityCoverage: "complete",
      operatorDecisionCoverage: "complete",
      unverifiedOperatorDecision: null,
      failureMessageInfo: null,
      outputReadyState: "ready",
      planReadiness: { state: "needs_answers", questionCount: 1 },
      planQuestions: [{ id: "q", kind: "text", prompt: "Which direction?" }],
      requiredActions: [{ id: "provide_required_input", detail: "Answer the plan question" }],
    }),
    answeredByTurnId: "off-page-answer",
    answeredByPrompt: {
      id: "off-page-answer",
      prompt: "Continue",
      promptInfo: { textBytes: 8, totalTextBytes: 8, truncated: false },
    },
    primaryOutput: {
      kind: "plan",
      path: "final/plan.md",
      text: "Plan 😀",
      bytes: 9,
      textBytes: 9,
      totalTextBytes: 9,
      truncated: false,
    },
  });
  const withRows = schema.ThreadHistoryPage.parse({
    ...empty,
    header: {
      ...empty.header,
      thread: { ...empty.header.thread, headRunId: settled.runId },
      latestTurnId: settled.id,
      latestOrdinal: settled.ordinal,
      latestAdmission: {
        id: settled.id,
        runId: settled.runId,
        enqueueError: null,
        jobId: "job-settled",
        state: "succeeded",
      },
      headRun: { runId: settled.runId, run: schema.ControlTurnRunCard.parse(settled.run) },
      headRunStatus: "available",
    },
    turns: [refusal, settled],
    replayCursor: "opaque-replay",
    hasOlder: true,
    olderCursor: "opaque-older",
    limitedBy: "turns",
  });
  const part = schema.ThreadPromptPart.parse({
    threadId: thread.id,
    turnId: refusal.id,
    totalBytes: 13,
    sha256: "a".repeat(64),
    offset: 0,
    nextOffset: 13,
    text: refusal.prompt,
  });
  const retained = schema.ThreadHistoryPage.parse({
    ...withRows,
    header: {
      ...withRows.header,
      thread: { ...withRows.header.thread, headRunId: settled.runId },
      headRun: null,
      headRunStatus: "not_retained",
    },
    turns: [
      refusal,
      {
        ...settled,
        run: null,
        runStatus: "not_retained",
        primaryOutput: null,
        primaryOutputStatus: "not_retained",
        planAnswerComplete: true,
        answeredByTurnId: null,
        answeredByPrompt: null,
      },
    ],
  });
  const unavailable = schema.ThreadHistoryPage.parse({
    ...withRows,
    turns: [
      refusal,
      {
        ...settled,
        run: {
          ...settled.run,
          applyEligibility: null,
          applyEligibilityCoverage: "unavailable",
          operatorDecisionCoverage: "unavailable",
          unverifiedOperatorDecision: { action: "accept_risk", decidedAt: thread.updatedAt },
          failure: schema.RunFailure.parse({
            safeMessage: "bounded",
            rawDetailRef: "final/failure.yaml",
          }),
          failureMessageInfo: { textBytes: 7, totalTextBytes: 900000, truncated: true },
        },
      },
    ],
  });
  // One receipt per consumer branch of the D-16 work_state veto, with its two
  // controls. Banner and required actions come from the engine's own projection
  // owners, so a consumer test reads what the server would send.
  const answer = "The change stops here for now.";
  const receipt = (id, ordinal, outcomeFacts) =>
    schema.ThreadHistoryTurn.parse({
      ...settled,
      id: `turn-${id}`,
      ordinal,
      runId: `run-${id}`,
      answeredByTurnId: null,
      answeredByPrompt: null,
      primaryOutput: {
        kind: "answer",
        path: "final/answer.md",
        text: answer,
        bytes: answer.length,
        textBytes: answer.length,
        totalTextBytes: answer.length,
        truncated: false,
      },
      run: {
        ...settled.run,
        state: outcomeFacts.lifecycle,
        mode: "agent",
        outcomeFacts,
        outcomeBanner: schema.outcomeBanner(outcomeFacts, {
          applyState: "not_applied",
          hasApplyableChange: false,
        }),
        requiredActions: schema.requiredActionsFor(outcomeFacts, false),
        planReadiness: null,
        planQuestions: [],
      },
    });
  const facts = (lifecycle, reason, axes = {}) => ({
    lifecycle,
    noChanges: false,
    checks: "not_configured",
    review: "not_run",
    reason,
    ...axes,
  });
  const needsInput = {
    state: "needs_input",
    source: "constrained",
    required_inputs: [
      { kind: "file", locator: "fixtures/input.json", description: "The fixture it needs." },
    ],
  };
  const incomplete = { state: "incomplete", source: "validated" };
  const vetoRows = [
    receipt("needs-input", 0, facts("succeeded", "input_required", { work_state: needsInput })),
    receipt(
      "incomplete-review-blocked",
      1,
      facts("succeeded", "review_blocked", { review: "blocked", work_state: incomplete }),
    ),
    receipt(
      "needs-input-checks-failed",
      2,
      facts("succeeded", "checks_failed", { checks: "failed", work_state: needsInput }),
    ),
    receipt("review-gate", 3, facts("succeeded", "review_blocked", { review: "blocked" })),
    receipt("host-stopped", 4, facts("cancelled", "host_cancelled")),
    receipt(
      "clean",
      5,
      facts("succeeded", null, {
        review_requested: false,
        work_state: { state: "completed", source: "constrained" },
      }),
    ),
  ];
  const vetoHead = vetoRows.at(-1);
  const workVeto = schema.ThreadHistoryPage.parse({
    ...empty,
    header: {
      ...empty.header,
      thread: { ...empty.header.thread, headRunId: vetoHead.runId },
      latestTurnId: vetoHead.id,
      latestOrdinal: vetoHead.ordinal,
      latestAdmission: {
        id: vetoHead.id,
        runId: vetoHead.runId,
        enqueueError: null,
        jobId: "job-work-veto",
        state: vetoHead.run.state,
      },
      headRun: { runId: vetoHead.runId, run: schema.ControlTurnRunCard.parse(vetoHead.run) },
      headRunStatus: "available",
    },
    turns: vetoRows,
    replayCursor: "opaque-replay",
  });
  return [
    { name: "thread-history-empty", schema: "ThreadHistoryPage", value: empty },
    { name: "thread-history-receipts", schema: "ThreadHistoryPage", value: withRows },
    { name: "thread-history-not-retained", schema: "ThreadHistoryPage", value: retained },
    {
      name: "thread-history-unavailable-evidence",
      schema: "ThreadHistoryPage",
      value: unavailable,
    },
    { name: "thread-history-work-veto", schema: "ThreadHistoryPage", value: workVeto },
    { name: "thread-prompt-part", schema: "ThreadPromptPart", value: part },
  ];
}
