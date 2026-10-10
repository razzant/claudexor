/**
 * Startup-shaped concurrency acceptance stories.
 *
 * These stories deliberately drive a BUILT claudexord through its public HTTP
 * control plane.  The fake-hang adapter is the only worker: it emits one
 * event and then waits for cancellation, so admission and queue state remain
 * observable without credentials, network access, or paid providers.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Sandbox, cli, makeSandbox, readEvents } from "./support.js";

type Address = { host: string; port: number };
type RunSummary = {
  jobId: string;
  runId: string;
  runDir?: string;
  state: string;
  prompt?: string;
};
type RunList = { runs: RunSummary[] };
type AcceptedRun = { jobId: string; runId?: string; runDir?: string };
type Probe = { promise: Promise<AcceptedRun>; failure?: Error };

const TEST_TIMEOUT_MS = 180_000;
const POLL_TIMEOUT_MS = 60_000;

function makeConcurrencySandbox(): Sandbox {
  const sb = makeSandbox();
  // The empty-root case must measure product defaults, and the YAML case must
  // measure the file. Neither may inherit the operator's concurrency overrides.
  for (const name of [
    "CLAUDEXOR_MAX_CONCURRENT",
    "CLAUDEXOR_MAX_PARALLEL_CANDIDATES",
    "CLAUDEXOR_MAX_DEEP_SCAN_WIDTH",
    "CLAUDEXOR_MAX_COUNCIL_MEMBERS",
  ]) {
    delete sb.env[name];
  }
  return sb;
}

function daemonAddress(sb: Sandbox): Address {
  return JSON.parse(
    readFileSync(join(sb.configDir, "daemon", "control-api.json"), "utf8"),
  ) as Address;
}

function daemonToken(sb: Sandbox): string {
  const pointer = JSON.parse(
    readFileSync(join(sb.configDir, "daemon", "control-api.json"), "utf8"),
  ) as { tokenPath?: string };
  return readFileSync(pointer.tokenPath ?? join(sb.configDir, "daemon", "token"), "utf8").trim();
}

function requestApi(sb: Sandbox) {
  const address = daemonAddress(sb);
  const token = daemonToken(sb);
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    // One key per logical request, retained for the entire HTTP attempt. A
    // sequence that restarts on daemon reconnect aliases earlier durable jobs.
    const idempotencyKey = randomUUID();
    const response = await fetch(`http://${address.host}:${address.port}/v2${path}`, {
      method,
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        "x-claudexor-protocol-major": "3",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "idempotency-key": idempotencyKey,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };
}

function startDaemon(sb: Sandbox): ReturnType<typeof requestApi> {
  // Keep the fake-hang barrier alive for the duration of this acceptance run.
  // The test cancels every job explicitly; no watchdog timeout is part of the
  // concurrency assertion.
  const started = cli(sb, ["daemon", "start", "--json"], {
    env: { ...sb.env, CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS: "600000" },
  });
  expect(started.code, started.stdout + started.stderr).toBe(0);
  return requestApi(sb);
}

async function waitForSnapshot(
  api: ReturnType<typeof requestApi>,
  prefix: string,
  expected: { running: number; queued: number },
  probes: Probe[],
): Promise<RunSummary[]> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const page = await api<RunList>("GET", "/runs?limit=1000");
    assertNoEnqueueFailures(probes);
    const ours = page.runs.filter((run) => run.prompt?.startsWith(prefix));
    const active = ours.filter((run) => run.state === "running");
    const running = active.length;
    const queued = ours.filter((run) => run.state === "queued").length;
    // Scheduler admission is not enough: every admitted job must reach the
    // deterministic adapter's waiting point and remain there simultaneously.
    if (
      running === expected.running &&
      queued === expected.queued &&
      active.every(reachedFakeBarrier)
    ) {
      return ours;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${prefix}: expected running=${expected.running} queued=${expected.queued}, got running=${running} queued=${queued}\n${JSON.stringify(ours)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function reachedFakeBarrier(run: RunSummary): boolean {
  if (!run.runDir || !existsSync(join(run.runDir, "events.jsonl"))) return false;
  return readEvents(run.runDir).some((event) => {
    const payload = event.payload as { harness_id?: string; type?: string } | undefined;
    return (
      event.type === "harness.event" &&
      payload?.harness_id === "fake-hang" &&
      payload.type === "thinking"
    );
  });
}

function assertNoEnqueueFailures(probes: Probe[]): void {
  const failures = probes.flatMap((probe) => (probe.failure ? [probe.failure.message] : []));
  if (failures.length) throw new Error(`enqueue failed:\n${failures.join("\n")}`);
}

function enqueueProbe(api: ReturnType<typeof requestApi>, prompt: string): Probe {
  const promise = api<AcceptedRun>("POST", "/runs", {
    prompt,
    mode: "ask",
    harnesses: ["fake-hang"],
    primaryHarness: "fake-hang",
    model: "fake-model",
  });
  const probe: Probe = { promise };
  // Attach immediately to avoid an unhandled rejection while observing the
  // queue; retain the original rejection and fail at the next observation.
  void promise.catch((error: unknown) => {
    probe.failure = error instanceof Error ? error : new Error(String(error));
  });
  return probe;
}

async function acceptedProbes(probes: Probe[]): Promise<AcceptedRun[]> {
  const receipts = await Promise.all(probes.map((probe) => probe.promise));
  assertNoEnqueueFailures(probes);
  expect(new Set(receipts.map((receipt) => receipt.jobId)).size).toBe(probes.length);
  return receipts;
}

async function cancelProbeFamily(
  api: ReturnType<typeof requestApi>,
  prefix: string,
  probes: Probe[],
  expectedQueued: number,
): Promise<void> {
  // Await the queued 202 receipt before cancelling: cancellation during the
  // start-observation window otherwise turns the original POST into a 500.
  // Every enqueue must have an inspected successful durable receipt.
  const receipts = await acceptedProbes(probes);
  const page = await api<RunList>("GET", "/runs?limit=1000");
  const ours = page.runs.filter((run) => run.prompt?.startsWith(prefix));
  expect(ours.map((run) => run.jobId).sort()).toEqual(
    receipts.map((receipt) => receipt.jobId).sort(),
  );
  const queuedIds = new Set(ours.filter((run) => run.state === "queued").map((run) => run.jobId));
  expect(queuedIds.size).toBe(expectedQueued);
  // Cancel queued work first so it cannot be promoted while active work drains.
  const cancelOrder = [...ours].sort(
    (a, b) => Number(b.state === "queued") - Number(a.state === "queued"),
  );
  for (const run of cancelOrder) {
    expect(["running", "queued"]).toContain(run.state);
    expect(
      await api("POST", `/runs/${encodeURIComponent(run.runId)}/control`, {
        control: { kind: "cancel", reason_code: "user_cancelled" },
      }),
    ).toMatchObject({ accepted: true, status: "applied" });
  }
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const page = await api<RunList>("GET", "/runs?limit=1000");
    const ours = page.runs.filter((run) => run.prompt?.startsWith(prefix));
    if (ours.length === probes.length && ours.every((run) => run.state === "cancelled")) {
      for (const run of ours.filter((run) => queuedIds.has(run.jobId))) {
        expect(run.runDir).toBeUndefined();
        expect(run.runId).toBe(run.jobId);
      }
      return;
    }
    if (Date.now() >= deadline) throw new Error(`timed out cancelling ${prefix}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function status(sb: Sandbox): Record<string, unknown> {
  const result = cli(sb, ["daemon", "status", "--json"]);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return result.json() as Record<string, unknown>;
}

describe("startup concurrency acceptance", () => {
  let sandbox: Sandbox | undefined;

  afterEach(() => {
    sandbox?.dispose();
    sandbox = undefined;
  });

  it(
    "default product admission has no hidden cap at the twenty-fifth fake worker",
    async () => {
      sandbox = makeConcurrencySandbox();
      const api = startDaemon(sandbox);
      const health = status(sandbox);
      expect(health.capacity).toMatchObject({
        maxConcurrent: "unlimited",
        maxConcurrentNonModelJobs: "unlimited",
        maxConcurrentModelOperations: "unlimited",
        maxParallelCandidates: 4,
        maxDeepScanWidth: 8,
        maxCouncilMembers: 4,
      });

      const prefix = `concurrency-default-${Date.now()}-`;
      const pending = Array.from({ length: 25 }, (_, index) =>
        enqueueProbe(api, `${prefix}${index}`),
      );
      const snapshot = await waitForSnapshot(api, prefix, { running: 25, queued: 0 }, pending);
      expect(snapshot.filter((run) => run.state === "running")).toHaveLength(25);
      expect(snapshot.filter((run) => run.state === "queued")).toHaveLength(0);
      await cancelProbeFamily(api, prefix, pending, 0);
      expect(status(sandbox)).toMatchObject({ active: 0, queue: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "uses YAML caps at startup, reports a mid-life change, and adopts it only after restart",
    async () => {
      sandbox = makeConcurrencySandbox();
      writeFileSync(
        join(sandbox.configDir, "config.yaml"),
        [
          "runtime:",
          "  max_concurrent: 24",
          "  max_parallel_candidates: 9",
          "  max_deep_scan_width: 13",
          "  max_council_members: 6",
          "",
        ].join("\n"),
      );
      let api = startDaemon(sandbox);
      expect(status(sandbox).capacity).toMatchObject({
        maxConcurrent: 24,
        maxParallelCandidates: 9,
        maxDeepScanWidth: 13,
        maxCouncilMembers: 6,
      });

      const prefix = `concurrency-restart-${Date.now()}-`;
      const pending = Array.from({ length: 25 }, (_, index) =>
        enqueueProbe(api, `${prefix}${index}`),
      );
      await waitForSnapshot(api, prefix, { running: 24, queued: 1 }, pending);

      // A file edit does not mutate a running daemon. The settings projection
      // must show both truths so operators can see why restart is required.
      writeFileSync(
        join(sandbox.configDir, "config.yaml"),
        [
          "runtime:",
          "  max_concurrent: 26",
          "  max_parallel_candidates: 11",
          "  max_deep_scan_width: 17",
          "  max_council_members: 8",
          "",
        ].join("\n"),
      );
      const beforeRestart = await api<Record<string, unknown>>("GET", "/settings");
      expect(beforeRestart.runtime).toMatchObject({
        concurrency: {
          configured: {
            maxConcurrent: 26,
            maxParallelCandidates: 11,
            maxDeepScanWidth: 17,
            maxCouncilMembers: 8,
          },
          effective: {
            maxConcurrent: 24,
            maxParallelCandidates: 9,
            maxDeepScanWidth: 13,
            maxCouncilMembers: 6,
          },
          restartRequired: true,
        },
      });
      expect(status(sandbox).capacity).toMatchObject({ maxConcurrent: 24 });
      // Newly submitted jobs still use the startup cap after the file edit.
      pending.push(enqueueProbe(api, `${prefix}after-config-edit`));
      await waitForSnapshot(api, prefix, { running: 24, queued: 2 }, pending);
      await cancelProbeFamily(api, prefix, pending, 2);
      expect(status(sandbox)).toMatchObject({ active: 0, queue: 0 });

      const stopped = cli(sandbox, ["daemon", "stop", "--json"]);
      expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
      api = startDaemon(sandbox);
      expect(status(sandbox).capacity).toMatchObject({
        maxConcurrent: 26,
        maxParallelCandidates: 11,
        maxDeepScanWidth: 17,
        maxCouncilMembers: 8,
      });
      const afterRestart = await api<Record<string, unknown>>("GET", "/settings");
      expect(afterRestart.runtime).toMatchObject({
        concurrency: {
          configured: {
            maxConcurrent: 26,
            maxParallelCandidates: 11,
            maxDeepScanWidth: 17,
            maxCouncilMembers: 8,
          },
          effective: {
            maxConcurrent: 26,
            maxParallelCandidates: 11,
            maxDeepScanWidth: 17,
            maxCouncilMembers: 8,
          },
          restartRequired: false,
        },
      });

      // Prove actual admission beyond 24, not just settings/health projection.
      const widePrefix = `concurrency-wide-${Date.now()}-`;
      const widePending = Array.from({ length: 27 }, (_, index) =>
        enqueueProbe(api, `${widePrefix}${index}`),
      );
      await waitForSnapshot(api, widePrefix, { running: 26, queued: 1 }, widePending);
      await cancelProbeFamily(api, widePrefix, widePending, 1);
      expect(status(sandbox)).toMatchObject({ active: 0, queue: 0 });
    },
    TEST_TIMEOUT_MS,
  );
});
