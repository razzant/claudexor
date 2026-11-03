/**
 * Canary story for live messages into a running run
 * (`POST /v2/runs/:id/messages`, CONTRACT v2 for the steer sprint).
 *
 * Drives the BUILT claudexord over its public HTTP control plane against the
 * deterministic `fake-steerable` harness kind (declares `live_input: mid_turn`,
 * answers `message()` with `delivered` while parked, never echoes the text). The story pins the user-visible contract: admission → typed receipt →
 * journal rows; not_active after terminal; rejected/multi_attempt on a race
 * without expectedAttemptId; rejected/admission_persist_failed when the event
 * log cannot be written; and a daemon restart replaying the stored receipt
 * under the same Idempotency-Key.
 *
 * The `fake-steerable` kind (packages/harness-fake) parks after started/thinking,
 * consumes exactly ONE message and answers `delivered` synchronously; the story
 * therefore accepts `accepted` or `delivered` as the first receipt.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Sandbox, cli, makeSandbox, readEvents } from "./support.js";

type Address = { host: string; port: number };
type AcceptedRun = { jobId: string; runId?: string; runDir?: string };
type RunSummary = { jobId: string; runId: string; runDir?: string; state: string };
type RunList = { runs: RunSummary[] };
type MessageReceipt = {
  accepted: boolean;
  outcome: string;
  reason?: string;
  runId: string;
  messageId: string;
  attemptId?: string;
  harnessId?: string;
  liveInput?: string;
};

const POLL_TIMEOUT_MS = 60_000;

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

/** Raw request: every status is returned (typed outcomes are HTTP 200 by contract). */
function requestApi(sb: Sandbox) {
  return async <T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey: string = randomUUID(),
  ): Promise<{ status: number; body: T }> => {
    const address = daemonAddress(sb);
    const response = await fetch(`http://${address.host}:${address.port}/v2${path}`, {
      method,
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${daemonToken(sb)}`,
        "x-claudexor-protocol-major": "3",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "idempotency-key": idempotencyKey,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
}

function startDaemon(sb: Sandbox): ReturnType<typeof requestApi> {
  const started = cli(sb, ["daemon", "start", "--json"], {
    env: { ...sb.env, CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS: "600000" },
  });
  expect(started.code, started.stdout + started.stderr).toBe(0);
  return requestApi(sb);
}

async function runRow(api: ReturnType<typeof requestApi>, jobId: string): Promise<RunSummary> {
  const page = await api<RunList>("GET", "/runs?limit=1000");
  const row = page.body.runs.find((run) => run.jobId === jobId);
  if (!row) throw new Error(`job ${jobId} is not in the run list`);
  return row;
}

/**
 * Attempt ids that have emitted the fake's parking row ("waiting for a live
 * message"): the fake registers its waiter before that row, so these attempts
 * are steerable the moment the row is visible.
 */
function parkedAttempts(runDir: string): string[] {
  const started = new Map<string, string>();
  const parked: string[] = [];
  for (const event of readEvents(runDir)) {
    const payload = event.payload as { attempt_id?: string; text?: string; type?: string };
    if (event.type === "harness.started" && payload.attempt_id) {
      started.set(payload.attempt_id, payload.attempt_id);
    }
    if (
      event.type === "harness.event" &&
      payload.attempt_id &&
      typeof payload.text === "string" &&
      payload.text.includes("waiting for a live message")
    ) {
      parked.push(payload.attempt_id);
    }
  }
  return parked.filter((id) => started.has(id));
}

/**
 * Enqueue a fake-steerable run and wait until `attempts` agent attempts have
 * parked (the fake registers its live-input waiter before its parking row). Every run is an agent run on the sandbox repo.
 */
async function startSteerableRun(
  api: ReturnType<typeof requestApi>,
  repo: string,
  prompt: string,
  attempts = 1,
  mode: "agent" | "ask" = "agent",
): Promise<{ jobId: string; runId: string; runDir: string; attemptIds: string[] }> {
  // Candidate (agent) and read-only (ask/plan) attempts both register as live
  // targets. An agent run needs a registered project root (idempotent per
  // root); a no-project ask run needs none.
  if (mode === "agent") {
    const registered = await api<{ id?: string }>("POST", "/projects", { root: repo });
    expect(registered.status, JSON.stringify(registered.body)).toBeLessThan(300);
  }
  const { status, body } = await api<AcceptedRun>("POST", "/runs", {
    prompt,
    mode,
    ...(mode === "agent" ? { scope: { kind: "project", root: repo } } : {}),
    harnesses: ["fake-steerable"],
    primaryHarness: "fake-steerable",
    model: "fake-model",
    ...(attempts > 1 ? { n: attempts } : {}),
  });
  expect(status, JSON.stringify(body)).toBeLessThan(300);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const row = await runRow(api, body.jobId);
    if (row.state === "running" && row.runDir && existsSync(join(row.runDir, "events.jsonl"))) {
      const attemptIds = parkedAttempts(row.runDir);
      if (attemptIds.length >= attempts) {
        return { jobId: body.jobId, runId: row.runId, runDir: row.runDir, attemptIds };
      }
    }
    if (Date.now() >= deadline) throw new Error(`run did not reach the steerable barrier`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function cancelRun(api: ReturnType<typeof requestApi>, runId: string): Promise<void> {
  await api("POST", `/runs/${encodeURIComponent(runId)}/control`, {
    control: { kind: "cancel", reason_code: "user_cancelled" },
  });
}

async function waitTerminal(api: ReturnType<typeof requestApi>, jobId: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const row = await runRow(api, jobId);
    if (row.state !== "running" && row.state !== "queued") return;
    if (Date.now() >= deadline) throw new Error(`job ${jobId} did not reach a terminal state`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let sb: Sandbox;
afterEach(() => {
  sb.dispose();
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("[LIVE-MESSAGE:contract] live messages into a running fake-steerable run", () => {
  it("admits, accepts and delivers one message and journals the three receipts in order", async () => {
    sb = makeSandbox();
    const api = startDaemon(sb);
    const run = await startSteerableRun(api, sb.repo, "canary live-message accepted/delivered");
    const key = `msg-${randomUUID()}`;
    const first = await api<MessageReceipt>(
      "POST",
      `/runs/${run.runId}/messages`,
      { text: "Use MANGO." },
      key,
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      accepted: true,
      runId: run.runId,
      messageId: key,
      harnessId: "fake-steerable",
      liveInput: "mid_turn",
    });
    expect(["accepted", "delivered"]).toContain(first.body.outcome);
    // A replay under the same key is the SAME receipt, never a second delivery.
    const replay = await api<MessageReceipt>(
      "POST",
      `/runs/${run.runId}/messages`,
      { text: "Use MANGO." },
      key,
    );
    expect(replay.body).toEqual(first.body);
    const types = readEvents(run.runDir).map((e) => e.type);
    expect(types.filter((t) => t === "message.accepted")).toHaveLength(1);
    if (first.body.outcome === "delivered") expect(types).toContain("message.delivered");
    // The fake never echoes the text into its own output; only the receipt rows carry it.
    expect(
      readEvents(run.runDir).some(
        (e) => e.type === "harness.event" && JSON.stringify(e.payload).includes("MANGO"),
      ),
    ).toBe(false);
    // The fake completes on its own once the message is consumed.
    await waitTerminal(api, run.jobId);
    // After the terminal: not_active/run_terminal, HTTP 200, no new admission row.
    const late = await api<MessageReceipt>("POST", `/runs/${run.runId}/messages`, {
      text: "too late",
    });
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ accepted: false, outcome: "not_active" });
    expect(late.body.reason).toBe("run_terminal");
    expect(readEvents(run.runDir).filter((e) => e.type === "message.accepted")).toHaveLength(1);
  });

  it("rejects a race message without expectedAttemptId (multi_attempt) and routes by attempt when given", async () => {
    sb = makeSandbox();
    // Two candidates must be live at once: drop any ambient concurrency cap.
    for (const name of [
      "CLAUDEXOR_MAX_PARALLEL_CANDIDATES",
      "CLAUDEXOR_MAX_DEEP_SCAN_WIDTH",
      "CLAUDEXOR_MAX_COUNCIL_MEMBERS",
    ]) {
      delete sb.env[name];
    }
    const api = startDaemon(sb);
    const run = await startSteerableRun(api, sb.repo, "canary live-message race", 2);
    const ambiguous = await api<MessageReceipt>("POST", `/runs/${run.runId}/messages`, {
      text: "which one?",
    });
    expect(ambiguous.status).toBe(200);
    expect(ambiguous.body).toMatchObject({
      accepted: false,
      outcome: "rejected",
      reason: "multi_attempt",
    });
    const [target] = run.attemptIds;
    const routed = await api<MessageReceipt>("POST", `/runs/${run.runId}/messages`, {
      text: "this one",
      expectedAttemptId: target,
    });
    expect(routed.status).toBe(200);
    expect(routed.body).toMatchObject({ accepted: true, attemptId: target });
    const mismatch = await api<MessageReceipt>("POST", `/runs/${run.runId}/messages`, {
      text: "nobody",
      expectedAttemptId: "a99",
    });
    expect(mismatch.body).toMatchObject({ outcome: "not_active", reason: "attempt_mismatch" });
    await cancelRun(api, run.runId);
    await waitTerminal(api, run.jobId);
  });

  it("dispatches nothing when admission cannot be journaled (rejected/admission_persist_failed)", async () => {
    sb = makeSandbox();
    const api = startDaemon(sb);
    const run = await startSteerableRun(api, sb.repo, "canary live-message admission failure");
    const eventsPath = join(run.runDir, "events.jsonl");
    expect(existsSync(eventsPath)).toBe(true);
    chmodSync(eventsPath, 0o444);
    try {
      const refused = await api<MessageReceipt>("POST", `/runs/${run.runId}/messages`, {
        text: "never sent",
      });
      expect(refused.status).toBe(200);
      expect(refused.body).toMatchObject({
        accepted: false,
        outcome: "rejected",
        reason: "admission_persist_failed",
      });
    } finally {
      chmodSync(eventsPath, 0o644);
    }
    // Nothing reached the fake: it is still parked, so the run is still running.
    expect((await runRow(api, run.jobId)).state).toBe("running");
    await cancelRun(api, run.runId);
    await waitTerminal(api, run.jobId);
  });

  it("steers a read-only ask run the same way (the dominant delegated-child shape)", async () => {
    sb = makeSandbox();
    const api = startDaemon(sb);
    const run = await startSteerableRun(api, sb.repo, "canary live-message ask mode", 1, "ask");
    const first = await api<MessageReceipt>("POST", `/runs/${run.runId}/messages`, {
      text: "Use MANGO.",
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      accepted: true,
      outcome: "delivered",
      harnessId: "fake-steerable",
      liveInput: "mid_turn",
    });
    await waitTerminal(api, run.jobId);
    const types = readEvents(run.runDir).map((e) => e.type);
    expect(types).toContain("message.accepted");
    expect(types).toContain("message.delivered");
  });

  it("replays the recorded receipt under the same key across a daemon restart", async () => {
    sb = makeSandbox();
    let api = startDaemon(sb);
    const run = await startSteerableRun(api, sb.repo, "canary live-message restart replay");
    const key = `msg-${randomUUID()}`;
    const first = await api<MessageReceipt>(
      "POST",
      `/runs/${run.runId}/messages`,
      { text: "before restart" },
      key,
    );
    expect(first.status).toBe(200);
    expect(first.body.accepted).toBe(true);
    const stopped = cli(sb, ["daemon", "stop", "--json"]);
    expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
    api = startDaemon(sb);
    const replay = await api<MessageReceipt>(
      "POST",
      `/runs/${run.runId}/messages`,
      { text: "before restart" },
      key,
    );
    // The ledger is durable: the same key answers the stored verdict, never a
    // fresh dispatch into the (now interrupted) run.
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
  });
});
