/** Retained task recovery over the BUILT CLI/MCP/HTTP and fresh SQLite stores.
 * Controller loss and daemon loss are separate faults, with offline fakes only. */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  CONTROL_PROTOCOL_MAJOR,
  ControlHandshakeResponse,
  RunWaitManyResult,
  TaskGroupRunsResult,
} from "@claudexor/schema";
import { afterEach, expect, it } from "vitest";
import { daemonApi, follow, ok, parked, refused, until } from "./mcp-controller-support.js";
import { mcpStdioClient, type McpStdioClient } from "./mcp-stdio.js";
import { cli, inspectSandboxLease, makeSandbox, readEvents, type Sandbox } from "./support.js";

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.dispose();
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function fixture() {
  const sb = makeSandbox();
  sandboxes.push(sb);
  return sb;
}

// Like store-durability.story.ts, rediscover this fixture's HTTP address after
// restart. This reads only the sandbox pointer and its sandbox-owned token.
async function http(sb: Sandbox, method: string, path: string, body?: unknown) {
  const address = JSON.parse(
    readFileSync(join(sb.configDir, "daemon", "control-api.json"), "utf8"),
  ) as { host: string; port: number; tokenPath: string };
  expect(address.host).toBe("127.0.0.1");
  expect(address.tokenPath.startsWith(join(sb.configDir, "daemon") + sep)).toBe(true);
  const token = readFileSync(address.tokenPath, "utf8").trim();
  const response = await fetch(`http://${address.host}:${address.port}/v2${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${token}`,
      "x-claudexor-protocol-major": String(CONTROL_PROTOCOL_MAJOR),
      "x-claudexor-store-identity": "1",
      "content-type": "application/json",
      ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function ownedLease(sb: Sandbox, pid: number) {
  const lease = inspectSandboxLease(sb.env, sb.repo);
  expect(lease.path.startsWith(join(sb.configDir, "daemon") + sep)).toBe(true);
  expect(lease).toMatchObject({
    status: "owned",
    pid,
    capability: "capable",
    reason: "identity_match",
  });
  return lease;
}

async function start(sb: Sandbox) {
  const result = cli(sb, ["daemon", "start", "--json"], {
    env: {
      CLAUDEXOR_MAX_CONCURRENT: "1",
      CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS: "600000",
    },
  });
  expect(result.code, result.stdout + result.stderr).toBe(0);
  const ready = result.json() as { pid: number; alreadyRunning?: boolean };
  expect(ready).toMatchObject({ ready: true, servingMode: "normal" });
  expect(ready.alreadyRunning).not.toBe(true);
  expect(ready.pid).toBeGreaterThan(0);
  const lease = ownedLease(sb, ready.pid);
  const response = await http(sb, "POST", "/handshake", {
    protocolMajor: CONTROL_PROTOCOL_MAJOR,
    client: "task-groups-canary",
  });
  expect(response.status).toBe(200);
  const hello = ControlHandshakeResponse.parse(response.body);
  expect(hello.servingMode).toBe("normal");
  expect(realpathSync(hello.engine.entry)).toBe(realpathSync(sb.env.CLAUDEXOR_DAEMON_ENTRY!));
  expect(hello.storeId).toBeTruthy();
  const receipt = {
    pid: ready.pid,
    configDir: sb.configDir,
    entry: hello.engine.entry,
    storeId: hello.storeId!,
    lease,
  };
  writeFileSync(join(sb.home, "task-group-daemon-receipt.json"), JSON.stringify(receipt, null, 2));
  return receipt;
}

function page(raw: unknown) {
  expect(Buffer.byteLength(JSON.stringify(raw), "utf8")).toBeLessThanOrEqual(131_072);
  const result = TaskGroupRunsResult.parse(raw);
  expect(result.visibility).toBe("current_served_generations");
  expect(result.retention).toBe("retained_only");
  return result;
}

async function group(mcp: McpStdioClient, taskGroupId: string, storeId: string, cursor?: string) {
  return page(
    await ok(mcp, "claudexor_task_group_runs", {
      taskGroupId,
      expectedStoreId: storeId,
      limit: 1,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
}

function cliPage(sb: Sandbox, taskGroupId: string, storeId: string, cursor?: string) {
  const result = cli(
    sb,
    [
      "task-group-runs",
      taskGroupId,
      "--expected-store-id",
      storeId,
      "--limit",
      "1",
      ...(cursor === undefined ? [] : ["--cursor", cursor]),
      "--json",
    ],
    { cwd: sb.home },
  );
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return page(result.json());
}

const starts = (runDir: string) =>
  readEvents(runDir).filter((e) => e.type === "harness.started").length;

it("[INV-002:mcp-task-groups] recovers queued and bound jobs after controller loss, without relaunching", async () => {
  const sb = fixture();
  const daemon = await start(sb);
  const registered = await http(sb, "POST", "/projects", { root: sb.repo });
  expect(registered.status).toBeLessThan(300);
  const G = randomUUID();
  const KA = randomUUID();
  const KB = randomUUID();
  const aBody = {
    prompt: "Supervise the deterministic question fixture.",
    repoPath: sb.repo,
    harness: "fake-interactive",
    taskGroupId: G,
    idempotencyKey: KA,
  };
  const bBody = {
    prompt: "Wait for an explicit fixture message.",
    repoPath: sb.repo,
    harness: "fake-steerable",
    taskGroupId: G,
    idempotencyKey: KB,
  };
  const receiptPath = join(sb.home, "task-group-controller-receipt.json");
  // Caller identity and exact requests exist outside the ephemeral MCP process
  // before either launch. Accepted receipts are saved before transport loss.
  writeFileSync(receiptPath, JSON.stringify({ G, KA, KB, storeId: daemon.storeId, aBody, bBody }));
  const first = mcpStdioClient(sb);
  const clients = [first];
  try {
    await first.initialize();
    const tools = await first.request("tools/list");
    expect(tools.tools.map((t: any) => t.name)).toContain("claudexor_task_group_runs");
    const a = await ok(first, "claudexor_ask", aBody);
    writeFileSync(
      receiptPath,
      JSON.stringify({ G, KA, KB, storeId: daemon.storeId, aBody, bBody, a }),
    );
    const active = await until(
      () => ok(first, "claudexor_run_status", { runId: a.jobId }),
      (value) => value.status === "running" && value.pendingInteractions === 1,
      "the first job's pending question",
    );
    const b = await ok(first, "claudexor_ask", bBody);
    expect(a).toMatchObject({ taskGroupId: G, storeId: daemon.storeId });
    expect(b).toMatchObject({
      taskGroupId: G,
      storeId: daemon.storeId,
      runId: null,
      status: "queued",
    });
    expect(a.jobId).not.toBe(b.jobId);
    expect(active.runId).toBeTruthy();
    expect(starts(active.runDir)).toBe(1);
    writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          G,
          KA,
          KB,
          storeId: daemon.storeId,
          aBody,
          bBody,
          a,
          b,
          actualRunId: active.runId,
        },
        null,
        2,
      ),
    );

    // Page one is deliberately incomplete: no adapter may auto-follow it.
    const initial = await group(first, G, daemon.storeId);
    expect(initial.members).toHaveLength(1);
    expect(initial.members[0]).toMatchObject({
      jobId: b.jobId,
      runId: null,
      observation: { status: "queued", pending: false, problem: null },
    });
    expect(initial.hasMore).toBe(true);
    expect(initial.nextCursor).toEqual(expect.any(String));
    await first.kill(); // Only this story's MCP transport; daemon/workers stay alive.
    ownedLease(sb, daemon.pid);

    const saved = JSON.parse(readFileSync(receiptPath, "utf8"));
    const reconnected = mcpStdioClient(sb, { cwd: sb.home });
    clients.push(reconnected);
    await reconnected.initialize();
    const recoveredB = await group(reconnected, saved.G, saved.storeId);
    expect(recoveredB).toEqual(initial);
    const recoveredA = await group(reconnected, saved.G, saved.storeId, recoveredB.nextCursor!);
    expect(recoveredA.members).toHaveLength(1);
    expect(recoveredA.members[0]).toMatchObject({
      jobId: saved.a.jobId,
      runId: saved.actualRunId,
      observation: { status: "running", pending: true, problem: null },
    });
    expect(recoveredA).toMatchObject({ hasMore: false, nextCursor: null });
    expect(cliPage(sb, saved.G, saved.storeId)).toEqual(recoveredB);
    expect(cliPage(sb, saved.G, saved.storeId, recoveredB.nextCursor!)).toEqual(recoveredA);
    const query = new URLSearchParams({ limit: "1", expectedStoreId: saved.storeId });
    const api = daemonApi(sb);
    expect(page(await api(`/task-groups/${saved.G}/runs?${query}`))).toEqual(recoveredB);
    query.set("cursor", recoveredB.nextCursor!);
    expect(page(await api(`/task-groups/${saved.G}/runs?${query}`))).toEqual(recoveredA);

    // Recovered job handles, not fabricated run IDs, drive multi-run attention.
    const members = [recoveredA.members[0]!, recoveredB.members[0]!];
    const targets = members.map(({ jobId }) => ({ runId: jobId }));
    const attention = RunWaitManyResult.parse(
      await ok(reconnected, "claudexor_runs_wait", {
        targets,
        waitMs: 0,
      }),
    );
    expect(attention).toMatchObject({ wakeReason: "attention", attention: [0] });
    expect(attention.summaries).toEqual(members.map(({ observation }) => observation));
    const seen = targets.map((target, i) => ({ ...target, seen: attention.summaries[i]!.token! }));
    expect(await ok(reconnected, "claudexor_runs_wait", { targets: seen, waitMs: 0 })).toEqual({
      ...attention,
      wakeReason: "timeout",
      attention: [],
    });

    // Exact key/body replay preserves acceptance while the second job is still
    // queued; changing or removing membership conflicts instead of starting work.
    for (const [body, accepted] of [
      [saved.aBody, saved.a],
      [saved.bBody, saved.b],
    ]) {
      expect(await ok(reconnected, "claudexor_ask", body)).toMatchObject({
        jobId: accepted.jobId,
        taskGroupId: saved.G,
        storeId: saved.storeId,
      });
      const { taskGroupId: _group, ...removed } = body;
      for (const changed of [{ ...body, taskGroupId: randomUUID() }, removed]) {
        const conflict = await refused(reconnected, "claudexor_ask", changed);
        expect(JSON.stringify(conflict)).toContain("idempotency_conflict");
      }
    }
    expect((await ok(reconnected, "claudexor_runs", {})).total).toBe(2);
    expect(await group(reconnected, saved.G, saved.storeId)).toEqual(initial);
    expect(starts(active.runDir)).toBe(1);

    // Explicitly answer the deterministic fake's questions via the existing
    // controls. Neither group reads nor seen tokens answer or advance events.
    const q1 = (await ok(reconnected, "claudexor_run_interactions", { runId: members[0]!.jobId }))
      .interactions[0];
    expect(q1.questions[0]).toMatchObject({
      id: "q1",
      options: [{ label: "Продолжить 🚀" }, { label: "Stop" }],
    });
    await ok(reconnected, "claudexor_answer_interaction", {
      runId: members[0]!.jobId,
      interactionId: q1.interactionId,
      answers: [{ questionId: "q1", selectedLabels: [q1.questions[0].options[0].label] }],
    });
    const parkedA = await follow(reconnected, members[0]!.jobId, 0, parked);
    await ok(reconnected, "claudexor_run_message", {
      runId: members[0]!.jobId,
      text: "Continue to the next fixture question.",
      idempotencyKey: "task-group-a-message",
    });
    const replacement = RunWaitManyResult.parse(
      await ok(reconnected, "claudexor_runs_wait", {
        targets: seen,
        waitMs: 20_000,
      }),
    );
    expect(replacement).toMatchObject({ wakeReason: "attention", attention: [0] });
    expect(replacement.summaries[0]).toMatchObject({ status: "running", pending: true });
    expect(replacement.summaries[0]!.token).not.toBe(attention.summaries[0]!.token);
    const q2 = (await ok(reconnected, "claudexor_run_interactions", { runId: members[0]!.jobId }))
      .interactions[0];
    expect(q2.questions[0]).toMatchObject({ id: "q2", options: [{ label: "Finish" }] });
    await ok(reconnected, "claudexor_answer_interaction", {
      runId: members[0]!.jobId,
      interactionId: q2.interactionId,
      answers: [{ questionId: "q2", selectedLabels: [q2.questions[0].options[0].label] }],
    });
    const finishedA = await follow(
      reconnected,
      members[0]!.jobId,
      parkedA.cursor,
      (_events, value) => value.status === "succeeded",
    );
    expect(finishedA.cursor).toBeGreaterThan(parkedA.cursor);
    const outputA = await until(
      () => ok(reconnected, "claudexor_run_result", { runId: members[0]!.jobId }),
      (value) => String(value.summary).includes("Interactive fixture finished."),
      "A's separate result",
    );
    expect(outputA.status).toBe("succeeded");
    await follow(reconnected, members[1]!.jobId, 0, parked);
    await ok(reconnected, "claudexor_run_message", {
      runId: members[1]!.jobId,
      text: "Finish the queued fixture job now.",
      idempotencyKey: "task-group-b-message",
    });
    const outputB = await until(
      () => ok(reconnected, "claudexor_run_result", { runId: members[1]!.jobId }),
      (value) =>
        value.status === "succeeded" &&
        String(value.summary).includes("Live message consumed by the fake harness."),
      "B's separate result",
    );
    expect(starts(active.runDir)).toBe(1);
    expect(starts(outputB.runDir)).toBe(1);
    expect((await ok(reconnected, "claudexor_runs", {})).total).toBe(2);

    // A new target store must refuse the saved identity even with no membership.
    const target = fixture();
    expect((await start(target)).storeId).not.toBe(saved.storeId);
    const mismatch = cli(target, [
      "task-group-runs",
      saved.G,
      "--expected-store-id",
      saved.storeId,
      "--json",
    ]);
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.json()).toMatchObject({ ok: false, code: "store_mismatch" });
    const wrongStore = await http(
      target,
      "GET",
      `/task-groups/${saved.G}/runs?expectedStoreId=${encodeURIComponent(saved.storeId)}`,
    );
    expect(wrongStore.status).toBe(409);
    expect(wrongStore.body).toMatchObject({ code: "store_mismatch" });

    // Public archive changes the served view. Retained history is not a roster.
    const beforeArchive = await group(reconnected, saved.G, saved.storeId);
    expect(beforeArchive.hasMore).toBe(true);
    expect(beforeArchive.members[0]).toMatchObject({
      jobId: saved.b.jobId,
      runId: outputB.runId,
      observation: { status: "succeeded" },
    });
    expect(outputB.runId).toBeTruthy();
    expect(
      (await group(reconnected, saved.G, saved.storeId, beforeArchive.nextCursor!)).members[0],
    ).toMatchObject({
      jobId: saved.a.jobId,
      runId: saved.actualRunId,
      observation: { status: "succeeded" },
    });
    expect((await http(sb, "DELETE", `/projects/${registered.body.id}`)).status).toBe(200);
    const stale = await refused(reconnected, "claudexor_task_group_runs", {
      taskGroupId: saved.G,
      expectedStoreId: saved.storeId,
      cursor: beforeArchive.nextCursor,
    });
    expect(JSON.stringify(stale)).toContain("stale_cursor");
    const empty = await group(reconnected, saved.G, saved.storeId);
    expect(empty).toMatchObject({ members: [], hasMore: false, nextCursor: null });
    expect(empty.viewToken).not.toBe(beforeArchive.viewToken);
    expect(cliPage(sb, saved.G, saved.storeId)).toEqual(empty);
  } finally {
    for (const client of clients) await client.close();
  }
}, 300_000);

it("[INV-143:task-group-daemon-restart] observes interrupted work without starting or resuming a run", async () => {
  const sb = fixture();
  const daemon = await start(sb);
  const G = randomUUID();
  const mcp = mcpStdioClient(sb);
  try {
    await mcp.initialize();
    const accepted = await ok(mcp, "claudexor_ask", {
      prompt: "Keep this deterministic fixture running until a daemon crash.",
      repoPath: sb.repo,
      harness: "fake-hang",
      taskGroupId: G,
      idempotencyKey: randomUUID(),
    });
    const running = await until(
      () => ok(mcp, "claudexor_run_status", { runId: accepted.jobId }),
      (value) =>
        value.status === "running" &&
        !!value.runDir &&
        existsSync(join(value.runDir, "events.jsonl")) &&
        readEvents(value.runDir).some(
          (e) =>
            e.type === "harness.event" && JSON.stringify(e.payload).includes("silently wedged"),
        ),
      "the single running fake job before the crash",
    );
    expect(starts(running.runDir)).toBe(1);
    expect((await group(mcp, G, daemon.storeId)).members[0]).toMatchObject({
      jobId: accepted.jobId,
      runId: running.runId,
      observation: { status: "running" },
    });
    writeFileSync(
      join(sb.home, "task-group-crash-receipt.json"),
      JSON.stringify(
        {
          ...daemon,
          G,
          accepted,
          runId: running.runId,
          runDir: running.runDir,
        },
        null,
        2,
      ),
    );
    await mcp.close();
    // Same provenance as store-durability: own start receipt, built entry,
    // sandbox config root, then a fresh birth-identity lease proof before kill.
    ownedLease(sb, daemon.pid);
    process.kill(daemon.pid, "SIGKILL");
    await until(
      async () => inspectSandboxLease(sb.env, sb.repo),
      (lease) =>
        lease.status === "owned" &&
        lease.pid === daemon.pid &&
        lease.capability === "proven_stale" &&
        ["process_missing", "linux_zombie"].includes(lease.reason!),
      "the fixture daemon's proven exit",
    );
    const restarted = await start(sb);
    expect(restarted.pid).not.toBe(daemon.pid);
    expect(restarted.storeId).toBe(daemon.storeId);
    const observer = mcpStdioClient(sb, { cwd: sb.home });
    try {
      await observer.initialize();
      const recovered = await group(observer, G, daemon.storeId);
      expect(recovered).toMatchObject({
        hasMore: false,
        nextCursor: null,
        members: [
          {
            jobId: accepted.jobId,
            runId: running.runId,
            observation: { status: "interrupted", pending: false, problem: null },
          },
        ],
      });
      expect(cliPage(sb, G, daemon.storeId)).toEqual(recovered);
      expect(
        page(
          await daemonApi(sb)(
            `/task-groups/${G}/runs?limit=1&expectedStoreId=${encodeURIComponent(daemon.storeId)}`,
          ),
        ),
      ).toEqual(recovered);
      const seen = [{ runId: accepted.jobId, seen: recovered.members[0]!.observation.token! }];
      expect(await ok(observer, "claudexor_runs_wait", { targets: seen, waitMs: 0 })).toMatchObject(
        { wakeReason: "timeout", attention: [], summaries: [{ status: "interrupted" }] },
      );
      expect(await group(observer, G, daemon.storeId)).toEqual(recovered);
      expect((await ok(observer, "claudexor_runs", {})).total).toBe(1);
      expect(starts(running.runDir)).toBe(1);
    } finally {
      await observer.close();
    }
  } finally {
    await mcp.close();
  }
}, 180_000);
