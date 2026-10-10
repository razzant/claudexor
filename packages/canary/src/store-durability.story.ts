/** Public process-crash durability over the built SQL engine. SIGKILL does
 * not simulate power loss; the private store suite owns that barrier matrix. */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  CONTROL_PROTOCOL_MAJOR,
  ControlDaemonStatus,
  ControlHandshakeResponse,
  type ControlRunDetail,
  type ControlRunSummary,
  type ControlThread,
  type ControlThreadDetail,
} from "@claudexor/schema";
import { afterEach, expect, it, vi } from "vitest";
import { cli, inspectSandboxLease, makeSandbox, readEvents, type Sandbox } from "./support.js";

type TurnReceipt = {
  jobId: string;
  runId: string;
  runDir: string;
  threadId: string;
  turnId: string;
};
const version = (
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
let sandbox: Sandbox | undefined;

afterEach(() => {
  if (!sandbox) return;
  const home = sandbox.home;
  // The fixture stops its exact live lease owner, or accepts proven stale
  // ownership after a crash. Failed cleanup retains the root and its receipt.
  sandbox.dispose();
  sandbox = undefined;
  expect(existsSync(home)).toBe(false);
  process.stdout.write(`${JSON.stringify({ story: "store-durability", cleanedRoot: home })}\n`);
});

function requestApi(sb: Sandbox) {
  return async <T>(
    method: string,
    path: string,
    body?: unknown,
    key = randomUUID(),
  ): Promise<T> => {
    // Rediscover after restart; neither the port nor the connection is reused.
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
        "content-type": "application/json",
        "idempotency-key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    expect(response.ok, `${method} ${path}: ${response.status} ${text}`).toBe(true);
    return JSON.parse(text) as T;
  };
}
type Api = ReturnType<typeof requestApi>;

function ownedLease(sb: Sandbox, pid: number) {
  const lease = inspectSandboxLease(sb.env, sb.repo);
  expect(lease.path.startsWith(join(sb.configDir, "daemon") + sep)).toBe(true);
  expect(lease).toMatchObject({
    status: "owned",
    pid,
    capability: "capable",
    reason: "identity_match",
  });
}

async function start(sb: Sandbox, api: Api): Promise<number> {
  const result = cli(sb, ["daemon", "start", "--json"]);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  const ready = result.json() as { pid: number; alreadyRunning?: boolean };
  expect(ready).toMatchObject({ ready: true, servingMode: "normal" });
  expect(ready.alreadyRunning).not.toBe(true);
  expect(ready.pid).toBeGreaterThan(0);
  ownedLease(sb, ready.pid);
  const hello = ControlHandshakeResponse.parse(
    await api("POST", "/handshake", {
      protocolMajor: CONTROL_PROTOCOL_MAJOR,
      client: "store-durability-canary",
    }),
  );
  expect(hello.engine.version).toBe(version);
  expect(realpathSync(hello.engine.entry)).toBe(realpathSync(sb.env.CLAUDEXOR_DAEMON_ENTRY!));
  expect(hello.servingMode).toBe("normal");
  return ready.pid;
}

async function runInState(api: Api, runId: string, state: string): Promise<ControlRunDetail> {
  let detail: ControlRunDetail | undefined;
  await vi.waitFor(
    async () => {
      detail = await api<ControlRunDetail>("GET", `/runs/${runId}`);
      expect(detail.summary.state).toBe(state);
    },
    { timeout: 30_000, interval: 100 },
  );
  return detail!;
}

it("[INV-143:store-durability] keeps accepted conversation and crash custody without replaying work", async () => {
  sandbox = makeSandbox();
  const sb = sandbox;
  writeFileSync(
    join(sb.configDir, "config.yaml"),
    [
      "credential_profiles: []",
      "routing:",
      "  primary_harness: fake-session",
      "  eligible_harnesses: [fake-session, fake-hang]",
      "",
    ].join("\n"),
  );
  sb.env.CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS = "600000";
  // Discovery uses the fixture's existing version-only stubs, including Cursor.
  sb.env.CLAUDEXOR_CURSOR_BIN = sb.env.CLAUDEXOR_CODEX_BIN;
  expect(inspectSandboxLease(sb.env, sb.repo).status).toBe("absent");
  const api = requestApi(sb);
  const pid = await start(sb, api);
  const health = ControlDaemonStatus.parse(await api("GET", "/daemon/status"));
  expect(health.store?.flusher?.state).toBe("up");
  expect(health.store?.integrity).not.toBe("failed");

  const projectKey = randomUUID(),
    threadKey = randomUUID(),
    firstKey = randomUUID(),
    crashKey = randomUUID();
  const project = await api<{ id: string }>("POST", "/projects", { root: sb.repo }, projectKey);
  const threadBody = {
    scope: { kind: "project", root: sb.repo },
    mode: "ask",
    primaryHarness: "fake-session",
    eligibleHarnesses: ["fake-session"],
  };
  const thread = await api<ControlThread>("POST", "/threads", threadBody, threadKey);
  const turnPath = `/threads/${thread.id}/turns`;
  const firstBody = { prompt: "Keep this completed answer in the conversation." };
  const first = await api<TurnReceipt>("POST", turnPath, firstBody, firstKey);
  const completed = await runInState(api, first.runId, "succeeded");
  expect(completed.primaryOutput?.text).toContain("Answered by the fake session harness.");
  const saved = await api<ControlThreadDetail>("GET", `/threads/${thread.id}`);
  expect(saved.sessions).toEqual([
    expect.objectContaining({
      harnessId: "fake-session",
      nativeSessionId: expect.any(String),
    }),
  ]);
  expect(saved.turns).toEqual([
    expect.objectContaining({
      id: first.turnId,
      runId: first.runId,
      prompt: firstBody.prompt,
    }),
  ]);

  // fake-hang is an in-process async generator: killing the daemon cannot
  // leave a detached vendor process behind. Wait for its real adapter event.
  const crashBody = { prompt: "Keep this accepted but unfinished turn.", harnesses: ["fake-hang"] };
  const accepted = await api<TurnReceipt>("POST", turnPath, crashBody, crashKey);
  await runInState(api, accepted.runId, "running");
  await vi.waitFor(
    () => {
      expect(readEvents(accepted.runDir)).toContainEqual(
        expect.objectContaining({
          type: "harness.event",
          payload: expect.objectContaining({ harness_id: "fake-hang", type: "thinking" }),
        }),
      );
    },
    { timeout: 30_000, interval: 50 },
  );
  const before = await api<ControlThreadDetail>("GET", `/threads/${thread.id}`);
  expect(before.turns).toHaveLength(2);
  const attemptsBefore = [first, accepted].map(({ runDir }) =>
    readEvents(runDir).filter((event) => event.type === "harness.started"),
  );
  expect(attemptsBefore.map((attempts) => attempts.length)).toEqual([1, 1]);
  const eventsBefore = readFileSync(join(accepted.runDir, "events.jsonl"), "utf8");
  ownedLease(sb, pid); // Fresh birth-identity/root proof immediately before signalling.
  process.kill(pid, "SIGKILL");
  await vi.waitFor(
    () => {
      const lease = inspectSandboxLease(sb.env, sb.repo);
      expect(lease).toMatchObject({ status: "owned", pid, capability: "proven_stale" });
      expect(["process_missing", "linux_zombie"]).toContain(lease.reason);
    },
    { timeout: 10_000, interval: 50 },
  );

  const restartedPid = await start(sb, api);
  expect(restartedPid).not.toBe(pid);
  const interrupted = await runInState(api, accepted.runId, "interrupted");
  expect(interrupted.summary).toMatchObject({
    jobId: accepted.jobId,
    runId: accepted.runId,
    resumable: { cause: "host_restart" },
  });
  expect((await runInState(api, first.runId, "succeeded")).primaryOutput).toEqual(
    completed.primaryOutput,
  );
  const restored = await api<ControlThreadDetail>("GET", `/threads/${thread.id}`);
  expect(restored.thread).toEqual(before.thread);
  expect(restored.sessions).toEqual(before.sessions);
  expect(restored.turns.map(({ run: _run, ...turn }) => turn)).toEqual(
    before.turns.map(({ run: _run, ...turn }) => turn),
  );
  expect(restored.turns[1]?.run?.state).toBe("interrupted");

  // Both creation and accepted-turn keys still name their original records.
  expect(await api("POST", "/projects", { root: sb.repo }, projectKey)).toMatchObject({
    id: project.id,
  });
  expect(await api("POST", "/threads", threadBody, threadKey)).toMatchObject({ id: thread.id });
  expect(await api("POST", turnPath, firstBody, firstKey)).toMatchObject(first);
  expect(await api("POST", turnPath, crashBody, crashKey)).toMatchObject(accepted);
  expect(await api("GET", `/threads/${thread.id}`)).toEqual(restored);
  const runs = await api<{ runs: ControlRunSummary[] }>("GET", "/runs?limit=1000");
  expect(
    runs.runs
      .map(({ jobId, runId }) => ({ jobId, runId }))
      .sort((a, b) => a.jobId.localeCompare(b.jobId)),
  ).toEqual(
    [first, accepted]
      .map(({ jobId, runId }) => ({ jobId, runId }))
      .sort((a, b) => a.jobId.localeCompare(b.jobId)),
  );
  expect(readFileSync(join(accepted.runDir, "events.jsonl"), "utf8").startsWith(eventsBefore)).toBe(
    true,
  );
  expect(
    [first, accepted].map(({ runDir }) =>
      readEvents(runDir).filter((event) => event.type === "harness.started"),
    ),
  ).toEqual(attemptsBefore);

  // Observe real public barrier progress after recovery, without a private
  // flusher hook or treating the earlier ACK as a power-loss guarantee.
  await vi.waitFor(
    async () => {
      const status = ControlDaemonStatus.parse(await api("GET", "/daemon/status"));
      expect(status).toMatchObject({ servingMode: "normal", active: 0, queue: 0 });
      expect(status.store).toMatchObject({
        integrity: "ok",
        obligations_open: 0,
        flusher: { state: "up" },
        last_barrier_at: expect.any(String),
      });
      expect(status.store!.flusher!.acknowledged_generation).toBeGreaterThan(0);
      expect(status.store!.flusher!.counters.barriers).toBeGreaterThan(0);
    },
    { timeout: 30_000, interval: 100 },
  );
  process.stdout.write(
    `${JSON.stringify({
      story: "store-durability",
      configDir: sb.configDir,
      pid,
      restartedPid,
      threadId: thread.id,
      jobIds: [first.jobId, accepted.jobId],
      runIds: [first.runId, accepted.runId],
    })}\n`,
  );
});
