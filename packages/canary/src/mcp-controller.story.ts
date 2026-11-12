/**
 * An external MCP controller over the BUILT `claudexor mcp serve` and a real
 * disposable daemon with deterministic fake harnesses: lost launch replies,
 * queued handles, questions and live messages, oversized event parts, and
 * successor controls. Every behavior below is fixture-driven; no vendor runs.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";
import { ControlRunEventPart, RunEvent } from "@claudexor/schema";
import { cli, makeSandbox, type Sandbox } from "./support.js";
import { closeThenDispose, mcpStdioClient, type McpStdioClient } from "./mcp-stdio.js";
import {
  daemonApi,
  follow,
  ok,
  parked,
  refused,
  TERMINAL,
  until,
} from "./mcp-controller-support.js";

let sandbox: Sandbox | undefined;
const clients: McpStdioClient[] = [];
afterEachClosed((context) => {
  // This test's sandbox, taken here: a late close never reaches the next test's.
  const owned = sandbox;
  sandbox = undefined;
  return closeThenDispose(context, owned, clients.splice(0));
});

// Independent oracle of the fixture's first question (packages/harness-fake/src/interactive.ts).
const FIRST_QUESTION = "Проверка 🙂 确认 ✅ — ".repeat(1_100);

function connect(sb: Sandbox, opts: { cwd?: string } = {}): McpStdioClient {
  const client = mcpStdioClient(sb, opts);
  clients.push(client);
  return client;
}

it("[INV-002:mcp-launch-replay] recovers a lost keyed launch once, regardless of cwd, and refuses changed or rootless replays", async () => {
  sandbox = makeSandbox();
  const lost = connect(sandbox);
  await lost.initialize();
  const launch = {
    prompt: "Wait for one controller message.",
    repoPath: sandbox.repo,
    harness: "fake-steerable",
    idempotencyKey: "launch-lost-reply",
  };
  // The reply of this accepted launch is never read: its server dies with it.
  lost.start("tools/call", { name: "claudexor_ask", arguments: launch });
  const recovery = connect(sandbox, { cwd: sandbox.home });
  await recovery.initialize();
  // The lost call may still be starting the daemon: recovery_only refusals are retryable.
  await until(
    () => recovery.call("claudexor_runs", {}),
    (runs) => runs.isError !== true && runs.structuredContent?.total === 1,
    "the lost launch's acceptance",
  );
  await lost.kill();
  const replay = await ok(recovery, "claudexor_ask", launch);
  expect(replay.runId).toBeTruthy();
  expect(replay.jobId).toBeTruthy();
  expect(await ok(recovery, "claudexor_ask", launch)).toMatchObject({
    runId: replay.runId,
    jobId: replay.jobId,
  });
  expect((await ok(recovery, "claudexor_runs", {})).total).toBe(1);
  const conflict = await refused(recovery, "claudexor_ask", { ...launch, prompt: "Another task" });
  expect(conflict.text).toContain("idempotency_conflict");
  const rootless = await refused(recovery, "claudexor_ask", {
    prompt: "Keyed without a project.",
    harness: "fake-steerable",
    idempotencyKey: "launch-no-root",
  });
  expect(rootless.failure).toMatchObject({ code: "idempotency_repo_path_required" });
  expect((await ok(recovery, "claudexor_runs", {})).total).toBe(1);
  await follow(recovery, replay.runId, 0, parked);
  await ok(recovery, "claudexor_run_message", {
    runId: replay.runId,
    text: "Finish now.",
    idempotencyKey: "lost-reply-finish",
  });
  await follow(recovery, replay.runId, 0, (_events, page) => TERMINAL.includes(page.status));

  // A replay names its registered project: a moved root is refused, never restarted.
  const other = join(sandbox.home, "second-project");
  mkdirSync(other);
  writeFileSync(join(other, "README.md"), "# second\n");
  const moved = {
    prompt: "Answer from the second project.",
    repoPath: other,
    harness: "fake-success",
    idempotencyKey: "launch-moved-root",
  };
  const first = await ok(recovery, "claudexor_ask", moved);
  await follow(recovery, first.runId, 0, (_events, page) => TERMINAL.includes(page.status));
  expect(await ok(recovery, "claudexor_ask", moved)).toMatchObject({ runId: first.runId });
  renameSync(other, `${other}-moved`);
  const missing = await refused(recovery, "claudexor_ask", moved);
  expect(missing.failure).toMatchObject({ code: "project_root_missing", retryable: false });
  expect((await ok(recovery, "claudexor_runs", {})).total).toBe(2);
}, 240_000);

it("[INV-002:mcp-queued-handle] returns a durably queued launch as a job handle that converges on its run", async () => {
  sandbox = makeSandbox();
  const started = cli(sandbox, ["daemon", "start", "--json"], {
    env: { ...sandbox.env, CLAUDEXOR_MAX_CONCURRENT: "1" },
  });
  expect(started.code, started.stdout + started.stderr).toBe(0);
  const mcp = connect(sandbox);
  await mcp.initialize();
  const blocker = await ok(mcp, "claudexor_ask", {
    prompt: "Hold the only slot.",
    repoPath: sandbox.repo,
    harness: "fake-steerable",
  });
  await follow(mcp, blocker.runId, 0, parked);
  const queuedLaunch = {
    prompt: "Run after the slot frees.",
    repoPath: sandbox.repo,
    harness: "fake-steerable",
    idempotencyKey: "queued-launch",
  };
  const raw = await mcp.call("claudexor_ask", queuedLaunch, 120_000);
  expect(raw.isError, JSON.stringify(raw)).not.toBe(true);
  const queued = raw.structuredContent as Record<string, any>;
  expect(queued).toMatchObject({ runId: null, status: "queued" });
  expect(queued.jobId).toBeTruthy();
  // Text-only clients get the same recovery handle.
  expect(raw.content[0].text).toContain(`jobId: ${queued.jobId}`);
  expect(await ok(mcp, "claudexor_ask", queuedLaunch, 120_000)).toMatchObject({
    jobId: queued.jobId,
    status: "queued",
  });
  expect((await ok(mcp, "claudexor_runs", {})).total).toBe(2);
  // Still queued: a typed refusal, not a false "no such run".
  const early = { runId: queued.jobId, text: "Too early.", idempotencyKey: "queued-early" };
  const refusal = await ok(mcp, "claudexor_run_message", early);
  expect(refusal).toMatchObject({
    outcome: "not_active",
    reason: "no_live_session",
    runId: queued.jobId,
  });
  expect(await ok(mcp, "claudexor_run_wait", { runId: queued.jobId, waitMs: 0 })).toMatchObject({
    runId: queued.jobId,
    status: "queued",
  });
  await ok(mcp, "claudexor_run_message", {
    runId: blocker.runId,
    text: "Release the slot.",
    idempotencyKey: "blocker-release",
  });
  const bound = await until(
    () => ok(mcp, "claudexor_run_wait", { runId: queued.jobId, waitMs: 1000, wake: "event" }),
    (page) => page.runId !== queued.jobId,
    "the queued job's run binding",
  );
  expect(bound.runId).toMatch(/\S/);
  expect(await ok(mcp, "claudexor_run_status", { runId: queued.jobId })).toMatchObject({
    runId: bound.runId,
  });
  await follow(mcp, queued.jobId, 0, parked);
  // A lost reply to the early message replays its receipt by either id while the
  // run is live: the same key and body still send nothing.
  expect(await ok(mcp, "claudexor_run_message", early)).toEqual(refusal);
  expect(await ok(mcp, "claudexor_run_message", { ...early, runId: bound.runId })).toEqual(refusal);
  expect(
    await ok(mcp, "claudexor_run_message", {
      runId: queued.jobId,
      text: "Finish the queued run.",
      idempotencyKey: "queued-finish",
    }),
  ).toMatchObject({ outcome: "delivered", runId: bound.runId });
  const done = await follow(mcp, bound.runId, 0, (_events, page) => page.status === "succeeded");
  expect(done.events.filter(({ event }) => event.payload?.message_id === "queued-early")).toEqual(
    [],
  );
}, 300_000);

it("[INV-002:mcp-interactive-supervision] keeps backlog visible beside questions, answers them in both channels, and steers without cancelling", async () => {
  sandbox = makeSandbox();
  const mcp = connect(sandbox);
  await mcp.initialize();
  const run = await ok(mcp, "claudexor_ask", {
    prompt: "Supervise the interactive fixture.",
    repoPath: sandbox.repo,
    harness: "fake-interactive",
    idempotencyKey: "interactive-launch",
  });
  const runId = run.runId as string;
  // The first question exists before the controller's first wait.
  await until(
    () => ok(mcp, "claudexor_run_status", { runId }),
    (status) => status.pendingInteractions === 1,
    "the first question",
  );
  const asked = await follow(
    mcp,
    runId,
    0,
    (events) => events.some(({ event }) => event.type === "interaction.requested"),
    { waitMs: 20_000 },
  );
  expect(asked.events[0].event.type).toBe("run.created");
  expect(asked.page).toMatchObject({
    wakeReason: "interactions",
    pendingInteractionCount: 1,
    omittedInteractions: 1,
    pendingInteractions: [],
  });
  expect(
    await ok(mcp, "claudexor_run_message", {
      runId,
      text: "This is not an answer.",
      idempotencyKey: "message-while-asked",
    }),
  ).toMatchObject({ outcome: "not_active", reason: "interaction_pending" });
  const listed = await mcp.call("claudexor_run_interactions", { runId });
  expect(listed.isError).not.toBe(true);
  expect(JSON.parse(listed.content[0].text)).toEqual(listed.structuredContent);
  const question = listed.structuredContent.interactions[0];
  expect(question.questions[0].question).toBe(FIRST_QUESTION);
  expect(question.questions[0].options.map((o: any) => o.label)).toEqual(["Продолжить 🚀", "Stop"]);
  const answer = {
    runId,
    interactionId: question.interactionId,
    answers: [{ questionId: "q1", selectedLabels: ["Продолжить 🚀"] }],
  };
  const delivered = await mcp.call("claudexor_answer_interaction", answer);
  expect(delivered.structuredContent).toMatchObject({ accepted: true, status: "delivered" });
  expect(JSON.parse(delivered.content[0].text)).toMatchObject({ status: "delivered" });
  const again = await refused(mcp, "claudexor_answer_interaction", answer);
  expect(again.failure).toMatchObject({ code: "already_resolved", retryable: false });
  expect(again.text).toContain("already_resolved");

  const waiting = await follow(mcp, runId, asked.cursor, parked);
  const steer = { runId, text: "Prefer the smaller change.", idempotencyKey: "steer-1" };
  const receipt = await ok(mcp, "claudexor_run_message", steer);
  expect(receipt).toMatchObject({ outcome: "accepted", messageId: "steer-1" });
  expect(await ok(mcp, "claudexor_run_message", steer)).toEqual(receipt);
  // The second question arrives while a batch wait is already open.
  const fence = (
    await ok(mcp, "claudexor_run_wait", { runId, afterSeq: waiting.cursor, waitMs: 0 })
  ).snapshotSeq as number;
  const opened = Date.now();
  const second = await follow(
    mcp,
    runId,
    waiting.cursor,
    (events) => events.some(({ event }) => event.type === "interaction.requested"),
    { waitMs: 20_000 },
  );
  expect(Date.now() - opened).toBeLessThan(15_000);
  expect(second.page.wakeReason).toBe("interactions");
  // The harness status rides inside the harness event; correlate it by message id.
  const consumed = second.events.find(
    ({ event }) =>
      event.type === "harness.event" && event.payload?.payload?.code === "live_input_delivered",
  );
  expect(consumed?.event.payload.payload).toMatchObject({ message_id: "steer-1" });
  const request = second.events.find(({ event }) => event.type === "interaction.requested");
  expect(request.seq).toBeGreaterThan(fence);

  // Cancelling an observation never cancels the worker.
  const cancelled = mcp.start("tools/call", {
    name: "claudexor_run_wait",
    arguments: { runId, afterSeq: second.cursor, waitMs: 30_000 },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  mcp.notify("notifications/cancelled", { requestId: cancelled, reason: "controller stopped" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await ok(mcp, "claudexor_run_status", { runId })).toMatchObject({
    status: "running",
    pendingInteractions: 1,
  });
  const pending = (await ok(mcp, "claudexor_run_interactions", { runId })).interactions[0];
  await ok(mcp, "claudexor_answer_interaction", {
    runId,
    interactionId: pending.interactionId,
    answers: [{ questionId: "q2", selectedLabels: ["Finish"] }],
  });
  const done = await follow(mcp, runId, second.cursor, (_events, page) =>
    TERMINAL.includes(page.status),
  );
  expect(done.page.status).toBe("succeeded");

  // Terminal is not the end of events: bounded pages drain the backlog to its fence.
  let cursor = 0;
  let pages = 0;
  for (;;) {
    const page = await ok(mcp, "claudexor_run_wait", {
      runId,
      afterSeq: cursor,
      waitMs: 0,
      maxEvents: 5,
    });
    expect(page.wakeReason).toBe("terminal");
    for (const item of page.events) {
      expect(item.seq).toBe(cursor + 1);
      cursor = item.seq;
    }
    pages += 1;
    if (cursor === page.snapshotSeq) break;
    expect(page.eventOmission).not.toBeNull();
  }
  expect(pages).toBeGreaterThan(2);
  const result = await ok(mcp, "claudexor_run_result", { runId });
  expect(result).toMatchObject({ status: "succeeded" });
  expect(result.summary).toContain("Interactive fixture finished.");
}, 300_000);

it("[INV-002:mcp-event-parts] reconstructs an oversized prompt event in parts, then continues after it", async () => {
  sandbox = makeSandbox();
  const mcp = connect(sandbox);
  await mcp.initialize();
  const prompt = Array.from({ length: 4_000 }, (_, i) => `Unicode payload Ж🙂确 line ${i}`).join(
    "\n",
  );
  expect(Buffer.byteLength(prompt)).toBeGreaterThan(131_072);
  const run = await ok(mcp, "claudexor_ask", {
    prompt,
    repoPath: sandbox.repo,
    harness: "fake-success",
  });
  const runId = run.runId as string;
  await until(
    () => ok(mcp, "claudexor_run_status", { runId }),
    (status) => TERMINAL.includes(status.status),
    "the oversized run's terminal",
  );
  const blocked = await ok(mcp, "claudexor_run_wait", { runId, afterSeq: 0 });
  expect(blocked).toMatchObject({
    nextSeq: 0,
    events: [],
    eventOmission: "oversized_frame",
    oversizedEvent: { seq: 1, type: "run.created" },
  });
  // A partial read is not consumption: the cursor does not move past the event.
  const head = await mcp.call("claudexor_run_event_read", { runId, seq: 1, maxBytes: 32_768 });
  expect(head.isError).not.toBe(true);
  expect(await ok(mcp, "claudexor_run_wait", { runId, afterSeq: 0, waitMs: 0 })).toMatchObject({
    nextSeq: 0,
    oversizedEvent: { seq: 1 },
  });
  const parts = [ControlRunEventPart.parse(head.structuredContent)];
  const textParts = [String(head.content[0].text).split("\n").slice(1).join("\n")];
  while (parts.at(-1)!.nextOffset < parts.at(-1)!.totalBytes) {
    const next = await mcp.call("claudexor_run_event_read", {
      runId,
      seq: 1,
      offset: parts.at(-1)!.nextOffset,
    });
    expect(next.isError).not.toBe(true);
    parts.push(ControlRunEventPart.parse(next.structuredContent));
    textParts.push(String(next.content[0].text).split("\n").slice(1).join("\n"));
  }
  const whole = parts.map((part) => part.text).join("");
  // Structured and text-only channels reassemble the same exact bytes.
  expect(textParts.join("")).toBe(whole);
  expect(createHash("sha256").update(Buffer.from(whole, "utf8")).digest("hex")).toBe(
    parts[0]!.sha256,
  );
  const event = RunEvent.parse(JSON.parse(whole));
  expect(event).toMatchObject({ seq: 1, type: "run.created", payload: { prompt } });
  const rest = await follow(mcp, runId, 1, (_events, page) => page.nextSeq === page.snapshotSeq, {
    waitMs: 0,
  });
  expect(rest.events[0].seq).toBe(2);
  expect(rest.events.map(({ event }) => event.type)).toContain("run.completed");
  expect((await ok(mcp, "claudexor_run_result", { runId })).summary).toContain(
    "Implemented by the fake harness.",
  );
  // Part reads are addressed by run and seq only; malformed addresses are refused.
  const firstMultibyte = Buffer.byteLength(whole.slice(0, whole.indexOf("Ж")));
  for (const args of [
    { runId, seq: 1, offset: firstMultibyte + 1 },
    { runId, seq: 1, maxBytes: 3 },
    { runId, seq: 999_999 },
    { runId: "run-does-not-exist", seq: 1 },
    { runId, seq: 1, path: "events.jsonl" },
  ])
    await refused(mcp, "claudexor_run_event_read", args);
  // A crash that tears the last line leaves a fence no read reaches: the wait names
  // the end of what the stream serves instead of inviting a loop, and skips nothing.
  const torn = rest.cursor + 1;
  appendFileSync(join(run.runDir, "events.jsonl"), `{"seq":${torn},"type":"harness.ev`);
  expect(await ok(mcp, "claudexor_run_wait", { runId, afterSeq: rest.cursor })).toMatchObject({
    snapshotSeq: torn,
    nextSeq: rest.cursor,
    events: [],
    eventOmission: "stream_ended",
  });
  const unserved = await refused(mcp, "claudexor_run_event_read", { runId, seq: torn });
  expect(unserved.failure).toMatchObject({ code: "run_event_not_found" });
}, 240_000);

it("[INV-002:mcp-successor-controls] continues with explicit controls, documents omitted defaults, and names the chain head", async () => {
  sandbox = makeSandbox();
  const mcp = connect(sandbox);
  await mcp.initialize();
  const finishedPredecessor = async (key: string) => {
    const run = await ok(mcp, "claudexor_run", {
      prompt: "Readonly predecessor.",
      repoPath: sandbox!.repo,
      harness: "fake-steerable",
      access: "readonly",
      web: "off",
      maxSeconds: 900,
      timeLimitMode: "soft",
      idempotencyKey: key,
    });
    await follow(mcp, run.runId, 0, parked);
    await ok(mcp, "claudexor_run_message", {
      runId: run.runId,
      text: "Finish.",
      idempotencyKey: `${key}-finish`,
    });
    await follow(mcp, run.runId, 0, (_events, page) => page.status === "succeeded");
    return run.runId as string;
  };
  const api = (() => {
    let bound: ReturnType<typeof daemonApi> | undefined;
    return (path: string) => (bound ??= daemonApi(sandbox!))(path);
  })();
  const predecessor = await finishedPredecessor("predecessor-explicit");

  // An explicit unknown account is strict: the successor fails typed instead of falling back.
  const pinned = await ok(mcp, "claudexor_run_continue", {
    runId: predecessor,
    credentialProfileId: "no-such-profile",
    idempotencyKey: "successor-unknown-account",
  });
  const pinnedRun = (pinned.runId ?? pinned.jobId) as string;
  await follow(mcp, pinnedRun, 0, (_events, page) => TERMINAL.includes(page.status));
  const pinnedResult = await ok(mcp, "claudexor_run_result", { runId: pinnedRun });
  expect(pinnedResult.status).toBe("failed");
  expect(JSON.stringify(pinnedResult.failure)).toContain("no-such-profile");
  // That failed successor is now the chain head; the predecessor is superseded.
  const head = await refused(mcp, "claudexor_run_continue", {
    runId: predecessor,
    idempotencyKey: "successor-superseded",
  });
  expect(head.failure).toMatchObject({
    code: "continuation_superseded",
    context: { head: pinnedResult.runId },
  });

  // An explicit $0 cap reaches the engine budget gate too: the route is not proven free.
  const capped = await ok(mcp, "claudexor_run_continue", {
    runId: pinnedRun,
    paidBudget: { kind: "finite", maxUsd: 0 },
    idempotencyKey: "successor-zero-budget",
  });
  const cappedRun = (capped.runId ?? capped.jobId) as string;
  await follow(mcp, cappedRun, 0, (_events, page) => TERMINAL.includes(page.status));
  const cappedResult = await ok(mcp, "claudexor_run_result", { runId: cappedRun });
  expect(cappedResult.status).toBe("failed");
  expect(JSON.stringify(cappedResult)).toContain("maximum cash budget is $0");

  const explicit = await ok(mcp, "claudexor_run_continue", {
    runId: cappedResult.runId,
    prompt: "",
    access: "readonly",
    web: "off",
    paidBudget: { kind: "finite", maxUsd: 5 },
    maxSeconds: 600,
    timeLimitMode: "soft",
    review: false,
    continueCarrier: "packet",
    idempotencyKey: "successor-explicit",
  });
  const successor = (explicit.runId ?? explicit.jobId) as string;
  await follow(mcp, successor, 0, parked);
  const detail = await api(`/runs/${encodeURIComponent(successor)}`);
  // Earlier heads' account pin and $0 cap are not inherited; only stated controls apply.
  expect(detail.summary).toMatchObject({
    continueFrom: cappedResult.runId,
    requestedAccess: "readonly",
    effectiveAccess: "readonly",
    externalContextPolicy: "off",
    paidBudget: { kind: "finite", maxUsd: 5 },
    review: false,
  });
  expect(
    await ok(mcp, "claudexor_run_time_limit", { runId: successor, action: "read" }),
  ).toMatchObject({ mode: "soft", state: "armed" });
  expect(await ok(mcp, "claudexor_run_status", { runId: successor })).toMatchObject({
    continueFrom: cappedResult.runId,
    resumable: null,
  });
  await ok(mcp, "claudexor_run_message", {
    runId: successor,
    text: "Finish the successor.",
    idempotencyKey: "successor-finish",
  });
  await follow(mcp, successor, 0, (_events, page) => TERMINAL.includes(page.status));
  const finished = await ok(mcp, "claudexor_run_result", { runId: successor });
  // The successor's own finite cap governs it: fixture cash is unknown, so the
  // engine's budget policy ends it cost_unverifiable rather than inheriting anything.
  expect(finished, JSON.stringify(finished).slice(0, 3000)).toMatchObject({
    status: "failed",
    continueFrom: cappedResult.runId,
    outcomeFacts: { reason: "cost_unverifiable" },
    budget: { paidBudget: { kind: "finite", maxUsd: 5 } },
  });
  expect(finished.continuity?.[0]).toMatchObject({ carrier: "packet" });

  // Omitted controls take ordinary successor defaults, never the predecessor's.
  const plain = await finishedPredecessor("predecessor-defaults");
  const defaulted = await ok(mcp, "claudexor_run_continue", {
    runId: plain,
    idempotencyKey: "successor-defaults",
  });
  const defaultSuccessor = (defaulted.runId ?? defaulted.jobId) as string;
  await follow(mcp, defaultSuccessor, 0, parked);
  const defaults = (await api(`/runs/${encodeURIComponent(defaultSuccessor)}`)).summary;
  // The ordinary new-run defaults of this fresh, untrusted project: not readonly, not web-off.
  expect(defaults).toMatchObject({
    continueFrom: plain,
    requestedAccess: "workspace_write",
    effectiveAccess: "workspace_write",
    externalContextPolicy: "auto",
    review: false,
    paidBudget: { kind: "unlimited" },
  });
  expect(
    await ok(mcp, "claudexor_run_time_limit", { runId: defaultSuccessor, action: "read" }),
  ).toMatchObject({ state: "disabled" });
  // Disclose the observed defaults in the story log for the reviewer.
  console.info(
    "successor defaults:",
    JSON.stringify({
      requestedAccess: defaults.requestedAccess,
      effectiveAccess: defaults.effectiveAccess,
      externalContextPolicy: defaults.externalContextPolicy,
      review: defaults.review,
      paidBudget: defaults.paidBudget,
    }),
    "unknown account failure:",
    JSON.stringify(pinnedResult.failure).slice(0, 600),
  );
  await ok(mcp, "claudexor_run_message", {
    runId: defaultSuccessor,
    text: "Finish the default successor.",
    idempotencyKey: "defaults-finish",
  });
  await follow(mcp, defaultSuccessor, 0, (_events, page) => page.status === "succeeded");
}, 300_000);

it("[INV-002:mcp-wait-budgets] holds the default and a long wait to their bounds under a matching client timeout", async () => {
  sandbox = makeSandbox();
  const mcp = connect(sandbox);
  await mcp.initialize();
  const run = await ok(mcp, "claudexor_ask", {
    prompt: "Stay quiet until messaged.",
    repoPath: sandbox.repo,
    harness: "fake-steerable",
  });
  const { cursor } = await follow(mcp, run.runId, 0, parked);
  const timed = async (args: Record<string, unknown>, clientTimeoutMs: number) => {
    const started = Date.now();
    const page = await ok(
      mcp,
      "claudexor_run_wait",
      { runId: run.runId, afterSeq: cursor, ...args },
      clientTimeoutMs,
    );
    return { page, elapsed: Date.now() - started };
  };
  // Defaults (waitMs 25000, batch): a quiet run returns at its bound, not early.
  const quiet = await timed({}, 60_000);
  expect(quiet.page).toMatchObject({ wakeReason: "timeout", events: [], status: "running" });
  expect(quiet.elapsed).toBeGreaterThanOrEqual(24_000);
  expect(quiet.elapsed).toBeLessThan(40_000);
  // The maximum wait needs a client timeout above waitMs plus the stage budgets.
  const long = await timed({ waitMs: 50_000 }, 80_000);
  expect(long.page).toMatchObject({ wakeReason: "timeout", events: [] });
  expect(long.elapsed).toBeGreaterThanOrEqual(49_000);
  expect(long.elapsed).toBeLessThan(65_000);
  console.info("wait budgets:", JSON.stringify({ defaultMs: quiet.elapsed, longMs: long.elapsed }));
  await ok(mcp, "claudexor_run_message", {
    runId: run.runId,
    text: "Finish now.",
    idempotencyKey: "budgets-finish",
  });
  await follow(mcp, run.runId, cursor, (_events, page) => page.status === "succeeded");
}, 240_000);
