/** Offline built stdio/HTTP/SQL qualification. AUTHORED ONLY in the source
 * implementation run; the controller runs this after building the candidate. */
import { expect, it } from "vitest";
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";
import { DeferredMessageReceipt, DeferredMessageReadResult } from "@claudexor/schema";
import { cli, makeSandbox, type Sandbox } from "./support.js";
import { closeThenDispose, mcpStdioClient, type McpStdioClient } from "./mcp-stdio.js";
import { TERMINAL, follow, ok, parked, refused, until } from "./mcp-controller-support.js";

let sandbox: Sandbox | undefined;
let mcp: McpStdioClient | undefined;
afterEachClosed((context) => {
  // This test's sandbox and client, taken here: a late close never reaches the next test's.
  const owned = { sandbox, clients: mcp ? [mcp] : [] };
  sandbox = undefined;
  mcp = undefined;
  return closeThenDispose(context, owned.sandbox, owned.clients);
});

it("[INV-142:deferred-next-message] edits one reserved draft, dispatches one settled successor and returns held output handles", async () => {
  sandbox = makeSandbox();
  const started = cli(sandbox, ["daemon", "start", "--json"], {
    env: { ...sandbox.env, CLAUDEXOR_MAX_CONCURRENT: "1" },
  });
  expect(started.code, started.stdout + started.stderr).toBe(0);
  mcp = mcpStdioClient(sandbox);
  await mcp.initialize();
  const parent = await ok(mcp, "claudexor_ask", {
    repoPath: sandbox.repo,
    prompt: "First controller-owned one-shot",
    harness: "fake-steerable",
    idempotencyKey: "parent",
  });
  await follow(mcp, parent.runId, 0, parked);
  const create = {
    request: {
      action: "create",
      predecessorId: parent.jobId,
      prompt: "First draft",
      attachments: [],
      controls: { continueCarrier: "packet", web: "off" },
    },
    idempotencyKey: "draft-create",
  };
  const receipt = DeferredMessageReceipt.parse(await ok(mcp, "claudexor_next_message", create));
  expect(receipt.draft.state).toBe("waiting");
  const draftId = receipt.draft.draftId;
  const edit = {
    request: {
      action: "replace",
      draftId,
      expectedRevision: 1,
      prompt: "Verify the previous answer",
      attachments: [],
    },
    idempotencyKey: "draft-edit",
  };
  const edited = DeferredMessageReceipt.parse(await ok(mcp, "claudexor_next_message", edit));
  expect(edited).toMatchObject({ appliedRevision: 2, draft: { revision: 2, state: "waiting" } });
  expect(await ok(mcp, "claudexor_next_message", create)).toMatchObject({
    appliedRevision: 1,
    draft: { revision: 2, draftId },
  });
  const reserved = await refused(mcp, "claudexor_run_continue", {
    runId: parent.jobId,
    prompt: "Overtake draft",
    idempotencyKey: "overtake",
  });
  expect(reserved.failure).toMatchObject({ code: "continuation_reserved" });
  expect((await ok(mcp, "claudexor_runs", {})).total).toBe(1);
  await ok(mcp, "claudexor_run_message", {
    runId: parent.runId,
    text: "Finish the predecessor",
    idempotencyKey: "release-parent",
  });
  // Terminal wake refers to the predecessor only. Addressed draft observation
  // separately confirms automatic promotion; observation has no send authority.
  await follow(mcp, parent.runId, 0, (_events, page) => page.status === "succeeded");
  const dispatched = DeferredMessageReadResult.parse(
    await until(
      () => ok(mcp!, "claudexor_next_message_read", { draftId }),
      (result) => result.draft.state === "dispatched",
      "deferred promotion",
    ),
  );
  expect(dispatched.draft).toMatchObject({ dispatchedRevision: 2, predecessorRunId: parent.runId });
  expect(dispatched.draft.successorJobId).toBeTruthy();
  expect(dispatched.draft.predecessorResult).toBe(`/v2/runs/${parent.runId}`);
  expect(dispatched.promptPreview).toBe("Verify the previous answer");
  expect(dispatched.omittedPromptBytes).toBe(0);
  const successor = dispatched.draft.successorJobId!;
  await follow(mcp, successor, 0, parked);
  expect((await ok(mcp, "claudexor_runs", {})).total).toBe(2);
  expect(await ok(mcp, "claudexor_next_message", edit)).toMatchObject({
    appliedRevision: 2,
    draft: { successorJobId: successor, state: "dispatched" },
  });
  expect(await ok(mcp, "claudexor_run_result", { runId: parent.runId })).toMatchObject({
    deferredMessage: { successorJobId: successor, state: "dispatched" },
  });
  await ok(mcp, "claudexor_run_message", {
    runId: successor,
    text: "Finish successor",
    idempotencyKey: "release-successor",
  });
  await follow(mcp, successor, 0, (_events, page) => page.status === "succeeded");

  const blocked = await ok(mcp, "claudexor_ask", {
    repoPath: sandbox.repo,
    prompt: "Needs a controller decision",
    harness: "fake-needs-input",
    idempotencyKey: "blocked",
  });
  await follow(mcp, blocked.jobId, 0, (_events, page) => page.status === "succeeded");
  const held = DeferredMessageReceipt.parse(
    await ok(mcp, "claudexor_next_message", {
      request: {
        action: "create",
        predecessorId: blocked.jobId,
        prompt: "Do not auto-send",
        attachments: [],
      },
      idempotencyKey: "held",
    }),
  );
  expect(held.draft).toMatchObject({ state: "held", hold: { code: "predecessor_needs_input" } });
  expect(held.draft.predecessorResult).toMatch(/^\/v2\/runs\//);
  const cleared = {
    request: { action: "clear", draftId: held.draft.draftId, expectedRevision: 1 },
    idempotencyKey: "clear-held",
  };
  expect(await ok(mcp, "claudexor_next_message", cleared)).toMatchObject({
    draft: { state: "cleared" },
  });
  expect(await ok(mcp, "claudexor_next_message", cleared)).toMatchObject({
    appliedRevision: 2,
    draft: { state: "cleared" },
  });
  expect((await ok(mcp, "claudexor_runs", {})).total).toBe(3);
}, 300_000);

it("[INV-142:deferred-next-message] public Stop holds a pending next message and names an accepted successor", async () => {
  sandbox = makeSandbox();
  const started = cli(sandbox, ["daemon", "start", "--json"], {
    env: { ...sandbox.env, CLAUDEXOR_MAX_CONCURRENT: "1" },
  });
  expect(started.code, started.stdout + started.stderr).toBe(0);
  mcp = mcpStdioClient(sandbox);
  await mcp.initialize();
  const ask = async (prompt: string, idempotencyKey: string) => {
    const run = await ok(mcp!, "claudexor_ask", {
      repoPath: sandbox!.repo,
      prompt,
      harness: "fake-steerable",
      idempotencyKey,
    });
    await follow(mcp!, run.runId, 0, parked);
    return run;
  };
  const draft = async (predecessorId: string, idempotencyKey: string) =>
    DeferredMessageReceipt.parse(
      await ok(mcp!, "claudexor_next_message", {
        request: { action: "create", predecessorId, prompt: "Verify", attachments: [] },
        idempotencyKey,
      }),
    ).draft;

  // Before any dispatch validation: Stop of the live predecessor holds its draft.
  const live = await ask("Stopped predecessor", "live");
  const pending = await draft(live.jobId, "pending");
  expect(pending.state).toBe("waiting");
  expect(await ok(mcp, "claudexor_run_cancel", { runId: live.runId })).toMatchObject({
    acknowledged: true,
    deferredMessage: { draftId: pending.draftId, state: "held", hold: { code: "stop_requested" } },
  });
  await follow(mcp, live.runId, 0, (_events, page) => TERMINAL.includes(page.status));
  expect(await ok(mcp, "claudexor_next_message_read", { draftId: pending.draftId })).toMatchObject({
    draft: { state: "held", successorJobId: null },
  });

  // After acceptance: Stop of the predecessor names the successor and leaves it running.
  const parent = await ask("Finished predecessor", "parent");
  const next = await draft(parent.jobId, "next");
  await ok(mcp, "claudexor_run_message", {
    runId: parent.runId,
    text: "Finish the predecessor",
    idempotencyKey: "finish-parent",
  });
  await follow(mcp, parent.runId, 0, (_events, page) => page.status === "succeeded");
  const dispatched = await until(
    () => ok(mcp!, "claudexor_next_message_read", { draftId: next.draftId }),
    (result) => result.draft.state === "dispatched",
    "deferred promotion",
  );
  const successor = dispatched.draft.successorJobId as string;
  await follow(mcp, successor, 0, parked);
  const refusal = await refused(mcp, "claudexor_run_cancel", { runId: parent.runId });
  expect(refusal.text).toContain(successor);
  expect(refusal.failure).toMatchObject({
    code: "next_message_dispatched",
    context: { deferredMessage: { state: "dispatched", successorJobId: successor } },
  });
  expect(await ok(mcp, "claudexor_run_status", { runId: successor })).toMatchObject({
    status: "running",
  });
  // The predecessor's held draft is terminal history: Stop reports it, nothing new.
  const again = await refused(mcp, "claudexor_run_cancel", { runId: live.runId });
  expect(again.failure).toMatchObject({
    code: "http_409",
    context: { deferredMessage: { draftId: pending.draftId, state: "held" } },
  });
  await ok(mcp, "claudexor_run_message", {
    runId: successor,
    text: "Finish successor",
    idempotencyKey: "finish-successor",
  });
  await follow(mcp, successor, 0, (_events, page) => page.status === "succeeded");
  expect((await ok(mcp, "claudexor_runs", {})).total).toBe(3);
}, 300_000);
