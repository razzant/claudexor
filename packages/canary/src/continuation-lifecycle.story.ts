/** Public continuation lifetime: cancel, one successor, project retirement,
 * and recovery after SIGKILL. Only offline fakes and our own temporary daemon. */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cli, makeSandbox, readEvents, type Sandbox } from "./support.js";

type Run = { jobId: string; runId: string; runDir: string; state: string };
type Problem = {
  code: string;
  retryable: boolean;
  context?: { head?: string };
  requiredActions: string[];
};
let sandbox: Sandbox | undefined;

afterEach(() => {
  if (!sandbox) return;
  try {
    const stopped = cli(sandbox, ["daemon", "stop", "--json"]);
    expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
  } finally {
    sandbox.dispose();
    sandbox = undefined;
  }
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function startDaemon(sb: Sandbox): number {
  const result = cli(sb, ["daemon", "start", "--json"], {
    env: { ...sb.env, CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS: "600000" },
  });
  expect(result.code, result.stdout + result.stderr).toBe(0);
  const ready = result.json() as {
    pid: number;
    ready: boolean;
    servingMode: string;
    alreadyRunning?: boolean;
  };
  expect(ready).toMatchObject({ ready: true, servingMode: "normal" });
  expect(ready.alreadyRunning).not.toBe(true);
  expect(ready.pid).toBeGreaterThan(0);
  return ready.pid;
}

function requestApi(sb: Sandbox) {
  return async <T>(method: string, path: string, body?: unknown) => {
    const address = JSON.parse(
      readFileSync(join(sb.configDir, "daemon", "control-api.json"), "utf8"),
    ) as { host: string; port: number; tokenPath: string };
    const token = readFileSync(address.tokenPath, "utf8").trim();
    const response = await fetch(`http://${address.host}:${address.port}/v2${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: ["Bearer", token].join(" "),
        "x-claudexor-protocol-major": "3",
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as T };
  };
}
type Api = ReturnType<typeof requestApi>;

async function waitForRun(api: Api, jobId: string, predicate: (run: Run) => boolean): Promise<Run> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const page = await api<{ runs: Run[] }>("GET", "/runs?limit=1000");
    expect(page.status).toBe(200);
    const run = page.body.runs.find((r) => r.jobId === jobId);
    if (run && predicate(run)) return run;
    if (Date.now() >= deadline)
      throw new Error(`run did not reach expected state: ${JSON.stringify(run)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function hang(api: Api, root: string): Promise<Run> {
  const accepted = await api<{ jobId: string }>("POST", "/runs", {
    prompt: "Continue the deterministic fixture work",
    mode: "agent",
    scope: { kind: "project", root },
    access: "workspace_write",
    harnesses: ["fake-hang"],
    primaryHarness: "fake-hang",
    model: "fake-model",
    tests: [],
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);
  return waitForRun(
    api,
    accepted.body.jobId,
    (r) =>
      r.state === "running" &&
      !!r.runDir &&
      existsSync(join(r.runDir, "events.jsonl")) &&
      readEvents(r.runDir).some(
        (e) => e.type === "harness.event" && JSON.stringify(e.payload).includes("silently wedged"),
      ),
  );
}

async function continueRun(api: Api, from: string) {
  return api<{ jobId: string }>("POST", "/runs", {
    prompt: "",
    continueFrom: from,
    harnesses: ["fake-implement"],
    primaryHarness: "fake-implement",
    model: "fake-model",
    tests: [],
  });
}
const terminal = (r: Run) => !["queued", "running"].includes(r.state);

it("[INV-142:continuation-lifecycle] continues cancelled and recovered work, and respects project retirement", async () => {
  sandbox = makeSandbox();
  const sb = sandbox;
  const pid = startDaemon(sb);
  const api = requestApi(sb);
  const memory = await api<{ memory: { atAdmission: unknown; heapLimitBytes: number } }>(
    "GET",
    "/daemon/status",
  );
  expect(memory.status).toBe(200);
  expect(memory.body.memory.atAdmission).not.toBeNull();
  expect(memory.body.memory.heapLimitBytes).toBeGreaterThan(0);
  const registered = await api<{ id: string }>("POST", "/projects", { root: sb.repo });
  expect(registered.status, JSON.stringify(registered.body)).toBeLessThan(300);
  const first = await hang(api, sb.repo);
  const cancel = await api("POST", `/runs/${first.runId}/control`, {
    control: { kind: "cancel", reason_code: "user_cancelled" },
  });
  expect(cancel.status).toBeLessThan(300);
  expect((await waitForRun(api, first.jobId, terminal)).state).toBe("cancelled");
  const continued = await continueRun(api, first.runId);
  expect(continued.status, JSON.stringify(continued.body)).toBeLessThan(300);
  const head = await waitForRun(api, continued.body.jobId, terminal);
  expect(head.state).toBe("succeeded");
  const superseded = await api<Problem>("POST", "/runs", { prompt: "", continueFrom: first.runId });
  expect(superseded.status).toBe(409);
  expect(superseded.body).toMatchObject({
    code: "continuation_superseded",
    retryable: false,
    context: { head: head.runId },
  });
  expect(superseded.body.requiredActions.length).toBeGreaterThan(0);
  const removed = await api("DELETE", `/projects/${registered.body.id}`);
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  const unknown = await api<Problem>("POST", "/runs", { prompt: "", continueFrom: first.runId });
  expect(unknown.status).toBe(404);
  expect(unknown.body).toMatchObject({ code: "predecessor_unknown", retryable: false });

  // Fresh active partition; the old one remains archived, never resurrected.
  expect((await api("POST", "/projects", { root: sb.repo })).status).toBeLessThan(300);
  const interrupted = await hang(api, sb.repo);
  // This pid came from the start receipt of this story's own temporary root.
  process.kill(pid, "SIGKILL");
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    if (Date.now() >= deadline) throw new Error("own killed daemon did not exit");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(startDaemon(sb)).not.toBe(pid);
  expect((await waitForRun(api, interrupted.jobId, terminal)).state).toBe("interrupted");
  const recovered = await continueRun(api, interrupted.runId);
  expect(recovered.status, JSON.stringify(recovered.body)).toBeLessThan(300);
  expect((await waitForRun(api, recovered.body.jobId, terminal)).state).toBe("succeeded");
});
