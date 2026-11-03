/** The controller lifecycle over the built MCP transport and a disposable daemon. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { RunWaitManyResult } from "@claudexor/schema";
import { CLI, cli, makeSandbox, type Sandbox } from "./support.js";
import { mcpStdioClient, type McpStdioClient } from "./mcp-stdio.js";
import { follow, ok, parked, until } from "./mcp-controller-support.js";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.dispose();
  sandbox = undefined;
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function controller(sb: Sandbox) {
  const child = spawn(process.execPath, [CLI, "mcp", "serve"], {
    cwd: sb.repo,
    env: sb.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nextId = 0;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  child.once("exit", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`MCP exited: ${stderr}`));
    }
    pending.clear();
  });
  function request(method: string, params?: unknown) {
    const id = ++nextId;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request ${method} timed out: ${stderr}`));
      }, 60_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  return {
    request,
    async initialize() {
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "supervision-canary", version: "1.0" },
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
      );
    },
    async call(name: string, args: Record<string, unknown>) {
      return request("tools/call", { name, arguments: args });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
        lines.close();
      }
    },
  };
}

it("[INV-002:mcp-supervision] replays one launch, observes, steers and continues without duplicating work", async () => {
  sandbox = makeSandbox();
  const mcp = controller(sandbox);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.call(name, args);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    return result.structuredContent as Record<string, any>;
  };
  const observeUntil = async (
    runId: string,
    predicate: (result: Record<string, any>) => boolean,
  ) => {
    let cursor = 0;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const result = await call("claudexor_run_wait", {
        runId,
        afterSeq: cursor,
        waitMs: 1000,
        maxEvents: 50,
      });
      if (predicate(result)) return result;
      cursor = result.nextSeq;
    }
    throw new Error(`run ${runId} did not reach the expected observation`);
  };
  const parked = (result: Record<string, any>) =>
    result.events?.some(
      ({ event }: any) =>
        event.type === "harness.event" &&
        event.payload?.text?.includes("waiting for a live message"),
    );
  const terminal = (result: Record<string, any>) =>
    ["succeeded", "failed", "cancelled", "interrupted"].includes(result.status);
  try {
    await mcp.initialize();
    const listed = await mcp.request("tools/list");
    expect(listed.tools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining([
        "claudexor_run_wait",
        "claudexor_run_message",
        "claudexor_run_continue",
      ]),
    );
    const launch = {
      prompt: "Wait for the controller message, then finish.",
      repoPath: sandbox.repo,
      harness: "fake-steerable",
      access: "readonly",
      idempotencyKey: "supervision-launch",
    };
    const first = await call("claudexor_ask", launch);
    const replay = await call("claudexor_ask", launch);
    expect(replay.runId).toBe(first.runId);
    const conflict = await mcp.call("claudexor_ask", { ...launch, prompt: "A different task" });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict)).toContain("idempotency_conflict");
    await observeUntil(first.runId, parked);
    const message = {
      runId: first.runId,
      text: "Use MANGO.",
      idempotencyKey: "supervision-message",
    };
    const receipt = await call("claudexor_run_message", message);
    expect(["accepted", "delivered"]).toContain(receipt.outcome);
    expect(receipt.messageId).toBe(message.idempotencyKey);
    expect(await call("claudexor_run_message", message)).toEqual(receipt);
    const finished = await observeUntil(first.runId, terminal);
    expect(finished.status).toBe("succeeded");
    const continuedRequest = {
      runId: first.runId,
      prompt: "",
      idempotencyKey: "supervision-continue",
    };
    const continued = await call("claudexor_run_continue", continuedRequest);
    const continuedReplay = await call("claudexor_run_continue", continuedRequest);
    expect(continuedReplay.jobId ?? continuedReplay.runId).toBe(continued.jobId ?? continued.runId);
    const successor = continued.runId ?? continued.jobId;
    expect(successor).toBeTruthy();
    expect(successor).not.toBe(first.runId);
    await observeUntil(successor, parked);
    await call("claudexor_run_message", {
      runId: successor,
      text: "Use MANGO again.",
      idempotencyKey: "supervision-successor-message",
    });
    expect((await observeUntil(successor, terminal)).status).toBe("succeeded");
    const superseded = await mcp.call("claudexor_run_continue", {
      runId: first.runId,
      idempotencyKey: "another-successor",
    });
    expect(superseded.isError).toBe(true);
    expect(JSON.stringify(superseded)).toContain("continuation_superseded");
  } finally {
    await mcp.close();
  }
}, 180_000);

it("[INV-002:mcp-wait-many] observes two durable jobs across controller cancellation and reconnect", async () => {
  sandbox = makeSandbox();
  const started = cli(sandbox, ["daemon", "start", "--json"], {
    env: { CLAUDEXOR_MAX_CONCURRENT: "2" },
  });
  expect(started.code, started.stdout + started.stderr).toBe(0);
  const first = mcpStdioClient(sandbox);
  const clients: McpStdioClient[] = [first];
  const wait = async (client: McpStdioClient, args: Record<string, unknown>) =>
    RunWaitManyResult.parse(await ok(client, "claudexor_runs_wait", args));
  try {
    await first.initialize();
    const questionLaunch = {
      prompt: "Supervise the interactive fixture without stopping it.",
      repoPath: sandbox.repo,
      harness: "fake-interactive",
      idempotencyKey: "many-question",
    };
    const otherLaunch = {
      prompt: "Park until the controller explicitly sends a message.",
      repoPath: sandbox.repo,
      harness: "fake-steerable",
      idempotencyKey: "many-other",
    };
    const question = await ok(first, "claudexor_ask", questionLaunch);
    const other = await ok(first, "claudexor_ask", otherLaunch);
    expect(question.jobId).toBeTruthy();
    expect(other.jobId).toBeTruthy();
    expect(question.jobId).not.toBe(other.jobId);
    const targets = [{ runId: question.jobId }, { runId: other.jobId }];
    await until(
      () => ok(first, "claudexor_run_status", { runId: question.jobId }),
      (status) => status.status === "running" && status.pendingInteractions === 1,
      "the first job's question",
    );
    await follow(first, other.jobId, 0, parked);

    const wire = await first.call("claudexor_runs_wait", { targets, waitMs: 0 });
    expect(wire.isError, JSON.stringify(wire)).not.toBe(true);
    const initial = RunWaitManyResult.parse(wire.structuredContent);
    expect(wire.content).toEqual([{ type: "text", text: JSON.stringify(initial) }]);
    expect(initial).toMatchObject({
      wakeReason: "attention",
      attention: [0],
      summaries: [
        { status: "running", pending: true, problem: null },
        { status: "running", pending: false, problem: null },
      ],
    });
    const acknowledged = targets.map((target, i) => ({
      ...target,
      seen: initial.summaries[i]!.token!,
    }));
    const timedOut = await wait(first, { targets: acknowledged, waitMs: 50 });
    expect(timedOut).toEqual({ ...initial, wakeReason: "timeout", attention: [] });

    // Exercise the built CLI against the same live daemon, with no launch flags.
    for (const format of ["--json", "--json-stream"]) {
      const snapshot = cli(sandbox, [
        "runs-wait",
        "--targets-json",
        JSON.stringify(acknowledged),
        "--wait-ms",
        "0",
        format,
      ]);
      expect(snapshot.code, snapshot.stdout + snapshot.stderr).toBe(0);
      expect(JSON.parse(snapshot.stdout)).toEqual(timedOut);
      if (format === "--json-stream") expect(snapshot.stdout).toBe(`${JSON.stringify(timedOut)}\n`);
    }

    const cancelled = first.start("tools/call", {
      name: "claudexor_runs_wait",
      arguments: { targets: acknowledged, waitMs: 50_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    first.notify("notifications/cancelled", {
      requestId: cancelled,
      reason: "stop observing only",
    });
    for (const target of targets)
      expect(await ok(first, "claudexor_run_status", target)).toMatchObject({ status: "running" });
    expect(await wait(first, { targets: acknowledged, waitMs: 0 })).toEqual(timedOut);

    // Lose an outstanding observation and the controlling process, then retain
    // the same job handles. No launch is authorized by loss of the observer.
    first.start("tools/call", {
      name: "claudexor_runs_wait",
      arguments: { targets: acknowledged, waitMs: 50_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await first.kill();
    const reconnected = mcpStdioClient(sandbox, { cwd: sandbox.home });
    clients.push(reconnected);
    await reconnected.initialize();
    for (const target of targets)
      expect(await ok(reconnected, "claudexor_run_status", target)).toMatchObject({
        status: "running",
      });
    expect(await wait(reconnected, { targets, waitMs: 0 })).toEqual(initial);
    expect(await wait(reconnected, { targets: acknowledged, waitMs: 0 })).toEqual(timedOut);
    expect(await ok(reconnected, "claudexor_ask", questionLaunch)).toMatchObject({
      jobId: question.jobId,
    });
    expect(await ok(reconnected, "claudexor_ask", otherLaunch)).toMatchObject({
      jobId: other.jobId,
    });
    expect((await ok(reconnected, "claudexor_runs", {})).total).toBe(2);

    // Acknowledging the first job's unchanged question must not hide the
    // second job's terminal attention, regardless of which arrives first.
    const [completed, receipt] = await Promise.all([
      wait(reconnected, { targets: acknowledged, waitMs: 20_000 }),
      ok(reconnected, "claudexor_run_message", {
        runId: other.jobId,
        text: "Finish now.",
        idempotencyKey: "many-other-finish",
      }),
    ]);
    expect(["accepted", "delivered"]).toContain(receipt.outcome);
    expect(completed).toMatchObject({
      wakeReason: "attention",
      attention: [1],
      summaries: [
        { status: "running", pending: true, token: initial.summaries[0]!.token },
        { status: "succeeded", pending: false, problem: null },
      ],
    });
    const output = await until(
      () => ok(reconnected, "claudexor_run_result", { runId: other.jobId }),
      (value) => String(value.summary).includes("Live message consumed by the fake harness."),
      "the second job's separately readable output",
    );
    expect(output.status).toBe("succeeded");

    // Question bodies are fetched and answered separately from compact waits.
    const pending = (await ok(reconnected, "claudexor_run_interactions", { runId: question.jobId }))
      .interactions[0];
    await ok(reconnected, "claudexor_answer_interaction", {
      runId: question.jobId,
      interactionId: pending.interactionId,
      answers: [{ questionId: "q1", selectedLabels: [pending.questions[0].options[0].label] }],
    });
    await follow(reconnected, question.jobId, 0, parked);
    await ok(reconnected, "claudexor_run_message", {
      runId: question.jobId,
      text: "Continue to the next question.",
      idempotencyKey: "many-question-steer",
    });
    const finalTargets = [
      acknowledged[0]!,
      { ...targets[1]!, seen: completed.summaries[1]!.token! },
    ];
    const replacement = await wait(reconnected, { targets: finalTargets, waitMs: 20_000 });
    expect(replacement).toMatchObject({ wakeReason: "attention", attention: [0] });
    expect(replacement.summaries[0]).toMatchObject({ status: "running", pending: true });
    expect(replacement.summaries[0]!.token).not.toBe(initial.summaries[0]!.token);
    const lastQuestion = (
      await ok(reconnected, "claudexor_run_interactions", { runId: question.jobId })
    ).interactions[0];
    await ok(reconnected, "claudexor_answer_interaction", {
      runId: question.jobId,
      interactionId: lastQuestion.interactionId,
      answers: [{ questionId: "q2", selectedLabels: ["Finish"] }],
    });
    const finished = await wait(reconnected, {
      targets: [{ ...targets[0]!, seen: replacement.summaries[0]!.token! }, finalTargets[1]!],
      waitMs: 20_000,
    });
    expect(finished.attention).toEqual([0]);
    expect(finished.summaries.map((summary) => summary.status)).toEqual(["succeeded", "succeeded"]);
    await until(
      () => ok(reconnected, "claudexor_run_result", { runId: question.jobId }),
      (value) => String(value.summary).includes("Interactive fixture finished."),
      "the first job's separately readable output",
    );
    expect((await ok(reconnected, "claudexor_runs", {})).total).toBe(2);
  } finally {
    for (const client of clients) await client.close();
  }
}, 300_000);
