import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "@claudexor/journal";
import {
  RunEvent,
  SCHEMA_VERSION,
  makeOutcomeFacts,
  requiredActionsFor,
  validateRunFactsInvariants,
} from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { DaemonClient } from "./client.js";
import { CommandStore } from "./command-store.js";
import { InteractionRegistry, InteractionStore } from "./interactions.js";
import { DaemonServer, jobStateFromResult, type JobRecord } from "./server.js";
import { acquireDaemonWriterLease } from "./writer-lease.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

function tempDir(name = "daemon"): string {
  return realpathSync(reapMk(join(tmpdir(), `claudexor-${name}-`)));
}

function commandAuthority(
  dir: string,
  partition = "global",
): {
  journal: DurableJournal;
  store: CommandStore;
  slot: { current(): CommandStore };
} {
  const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition });
  const store = new CommandStore(journal);
  return { journal, store, slot: { current: () => store } };
}

function recoveredFailureFacts(runId: string, taskId: string) {
  const outcome = makeOutcomeFacts("failed", { reason: "harness_failed" });
  return validateRunFactsInvariants({
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    task_id: taskId,
    mode: "agent",
    outcome,
    deliverable: {
      present: false,
      kind: null,
      path: null,
      producer_attempt_id: null,
    },
    participants: { planners: 0, attempts: [] },
    gates: {
      configured: false,
      required: 0,
      total: 0,
      executed: false,
      state: "not_configured",
      receipt_attempt_id: null,
    },
    review: { state: "not_run", blocker_ids: [], blockers: 0 },
    apply: { eligibility: null, operator_decision_present: false },
    required_actions: requiredActionsFor(outcome, false),
    generated_at: "2026-07-26T12:00:00.000Z",
  });
}

function recoveredTerminalPayload(facts: ReturnType<typeof recoveredFailureFacts>) {
  return {
    lifecycle: facts.outcome.lifecycle,
    facts: facts.outcome,
    reason: facts.outcome.reason,
    run_facts: facts,
  };
}

function recoveryFixture(
  name: string,
  options: { seq?: number; type?: "run.completed" | "run.failed" | "run.blocked" } = {},
) {
  const dir = tempDir(name);
  const runId = `run-${name}`;
  const taskId = `task-${name}`;
  const runDir = join(dir, runId);
  mkdirSync(join(runDir, "final"), { recursive: true });
  const first = commandAuthority(dir);
  first.store.accept({
    id: `job-${name}`,
    params: { value: 1 },
    idempotencyKey: name,
    clientId: "test",
  });
  first.store.update(`job-${name}`, {
    state: "running",
    runId,
    taskId,
    runDir,
  });
  const facts = recoveredFailureFacts(runId, taskId);
  const terminalEvent = RunEvent.parse({
    seq: options.seq ?? 2,
    ts: "2026-07-26T12:00:01.000Z",
    run_id: runId,
    task_id: taskId,
    type: options.type ?? "run.failed",
    payload: recoveredTerminalPayload(facts),
  });
  first.journal.append("run.event", terminalEvent);
  return { dir, runDir, first, facts, terminalEvent };
}

async function terminal(client: DaemonClient, id: string): Promise<JobRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = (await client.status(id)) as JobRecord;
    if (record.state !== "queued" && record.state !== "running") return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${id} did not reach a terminal state`);
}

describe("DaemonServer", () => {
  it("never replaces a regular file at the configured socket path", async () => {
    const dir = tempDir("unsafe-socket");
    const socketPath = join(dir, "keep.txt");
    writeFileSync(socketPath, "user bytes\n");
    const authority = commandAuthority(dir);
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      runner: async () => ({ lifecycle: "succeeded" }),
    });
    try {
      await expect(server.start()).rejects.toThrow(/refusing to replace/);
      expect(readFileSync(socketPath, "utf8")).toBe("user bytes\n");
    } finally {
      await server.stop();
      authority.journal.close();
    }
  });

  it("claims one writer lease before journal startup", () => {
    const socketPath = join(tempDir("writer-lease"), "daemon.sock");
    const lease = acquireDaemonWriterLease(socketPath);
    expect(() => acquireDaemonWriterLease(socketPath)).toThrow(/another claudexor daemon owns/);
    lease.release();
    const successor = acquireDaemonWriterLease(socketPath);
    successor.release();
  });

  it("scopes identical command idempotency keys to their journal partition", () => {
    const dir = tempDir("partition-idempotency");
    const global = commandAuthority(dir);
    const project = commandAuthority(dir, "project:alpha");
    try {
      global.store.accept({
        id: "job-global",
        params: { value: 1 },
        idempotencyKey: "same",
        clientId: "ui",
      });
      project.store.accept({
        id: "job-project",
        params: { value: 2 },
        idempotencyKey: "same",
        clientId: "ui",
      });
      const globalKey = (global.journal.records()[0]!.payload as { keyDigest: string }).keyDigest;
      const projectKey = (project.journal.records()[0]!.payload as { keyDigest: string }).keyDigest;
      expect(globalKey).not.toBe(projectKey);
    } finally {
      global.journal.close();
      project.journal.close();
    }
  });

  it("serves health, durably accepts a command, runs it, and shuts down", async () => {
    const dir = tempDir();
    const authority = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    let ran = 0;
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      runner: async (params) => {
        ran += 1;
        return { lifecycle: "succeeded", echoed: (params as { value: number }).value * 2 };
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "token");
      await expect(client.health()).resolves.toMatchObject({ ok: true });
      const accepted = await client.enqueue(
        { value: 21 },
        { idempotencyKey: "create-1", clientId: "test" },
      );
      const record = await terminal(client, accepted.id);
      expect(record).toMatchObject({ state: "succeeded", result: { echoed: 42 } });
      expect(ran).toBe(1);
      await expect(new DaemonClient(socketPath, "wrong").health()).rejects.toThrow(/unauthorized/);
    } finally {
      await server.stop();
      authority.journal.close();
    }
  });

  it("deduplicates the same create request and rejects key reuse with different bytes", async () => {
    const dir = tempDir("idempotency");
    const authority = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    let calls = 0;
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      runner: async () => {
        calls += 1;
        return { lifecycle: "succeeded" };
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "token");
      const first = await client.enqueue({ value: 1 }, { idempotencyKey: "same", clientId: "ui" });
      const again = await client.enqueue({ value: 1 }, { idempotencyKey: "same", clientId: "ui" });
      expect(again.id).toBe(first.id);
      await expect(
        client.enqueue({ value: 2 }, { idempotencyKey: "same", clientId: "ui" }),
      ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
      await terminal(client, first.id);
      expect(calls).toBe(1);
    } finally {
      await server.stop();
      authority.journal.close();
    }
  });

  it.each([
    ["cap", "delegation_subrun_cap"],
    ["fence", "delegation_budget_parent_unavailable"],
  ] as const)(
    "replays an accepted delegated command after the parent %s without admitting a new child",
    async (_condition, refusalCode) => {
      const dir = tempDir(_condition === "cap" ? "dr-cap" : "dr-fence");
      const commands = commandAuthority(dir);
      const socketPath = join(dir, "daemon.sock");
      commands.store.accept({
        id: "job-parent",
        params: { delegate: true },
        idempotencyKey: "parent",
        clientId: "test",
      });
      commands.store.update("job-parent", {
        state: "running",
        runId: "run-parent",
        startedAt: new Date().toISOString(),
      });
      let refuseNew = false;
      let accepted = 0;
      const server = new DaemonServer({
        socketPath,
        token: "token",
        commands: commands.slot,
        delegationAuthority: {
          assertCanAdmitChild: () => {
            if (!refuseNew) return;
            throw Object.assign(new Error(refusalCode), { code: refusalCode, status: 409 });
          },
          noteChildAccepted: () => {
            accepted += 1;
          },
          cancelAcceptedChild: () => {},
          beginParentClose: () => {},
        },
        runner: async () => ({ lifecycle: "succeeded" }),
      });
      await server.start();
      try {
        const client = new DaemonClient(socketPath, "token");
        const child = {
          prompt: "child",
          parentRunId: "run-parent",
          delegatedFromRunId: "run-parent",
        };
        const options = {
          idempotencyKey: "child-one",
          clientId: "belt",
          operation: "delegated-run",
        };
        const first = await client.enqueue(child, options);
        refuseNew = true;
        const replay = await client.enqueue(child, options);
        expect(replay.id).toBe(first.id);
        expect(accepted).toBe(1);
        await expect(
          client.enqueue(child, { ...options, idempotencyKey: "child-two" }),
        ).rejects.toMatchObject({ code: refusalCode, status: 409 });
      } finally {
        await server.stop();
        commands.journal.close();
      }
    },
  );

  it("releases a delegated pending admission when the runner fails before binding a run", async () => {
    const dir = tempDir("d-pre");
    const commands = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    commands.store.accept({
      id: "job-parent",
      params: { delegate: true },
      idempotencyKey: "parent",
      clientId: "test",
    });
    commands.store.update("job-parent", {
      state: "running",
      runId: "run-parent",
      startedAt: new Date().toISOString(),
    });
    const pending = new Set<string>();
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: commands.slot,
      delegationAuthority: {
        assertCanAdmitChild: () => {},
        noteChildAccepted: (_parentRunId, admissionId) => pending.add(admissionId),
        cancelAcceptedChild: (_parentRunId, admissionId) => {
          pending.delete(admissionId);
        },
        beginParentClose: () => {},
      },
      runner: async () => {
        throw new Error("pre-announce contract failure");
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "token");
      const child = await client.enqueue(
        {
          prompt: "child",
          parentRunId: "run-parent",
          delegatedFromRunId: "run-parent",
        },
        { idempotencyKey: "child", clientId: "belt", operation: "delegated-run" },
      );
      await expect(terminal(client, child.id)).resolves.toMatchObject({ state: "failed" });
      expect(pending).toEqual(new Set());
    } finally {
      await server.stop();
      commands.journal.close();
    }
  });

  it("retains recent idempotency handles beyond the history cap and restores terminal results", async () => {
    const dir = tempDir("retention");
    const authority = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      maxHistory: 1,
      runner: async (params) => ({ lifecycle: "succeeded", echoed: params }),
    });
    await server.start();
    const client = new DaemonClient(socketPath, "token");
    const first = await client.enqueue({ value: 1 }, { idempotencyKey: "first" });
    const second = await client.enqueue({ value: 2 }, { idempotencyKey: "second" });
    await terminal(client, first.id);
    await terminal(client, second.id);
    expect(authority.store.records()).toHaveLength(2);
    await server.stop();
    authority.journal.close();

    const reopened = commandAuthority(dir);
    expect(reopened.store.get(first.id)).toMatchObject({
      state: "succeeded",
      result: { lifecycle: "succeeded", echoed: { value: 1 } },
    });
    expect(
      reopened.store.find({
        params: { value: 1 },
        idempotencyKey: "first",
        clientId: "daemon-client",
      })?.id,
    ).toBe(first.id);
    reopened.journal.close();
  });

  it("recovers queued and running commands as interrupted without replay", async () => {
    const dir = tempDir("restart");
    const first = commandAuthority(dir);
    first.store.accept({
      id: "job-queued",
      params: { value: 1 },
      idempotencyKey: "queued",
      clientId: "test",
    });
    first.store.accept({
      id: "job-running",
      params: { value: 2 },
      idempotencyKey: "running",
      clientId: "test",
    });
    first.store.update("job-running", { state: "running", startedAt: new Date().toISOString() });
    first.journal.close();

    const recovered = commandAuthority(dir);
    expect(recovered.store.records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "job-queued", state: "interrupted" }),
        expect.objectContaining({ id: "job-running", state: "interrupted" }),
      ]),
    );
    let calls = 0;
    const server = new DaemonServer({
      socketPath: join(dir, "daemon.sock"),
      token: "token",
      commands: recovered.slot,
      runner: async () => {
        calls += 1;
        return { lifecycle: "succeeded" };
      },
    });
    await server.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(calls).toBe(0);
    } finally {
      await server.stop();
      recovered.journal.close();
    }
  });

  it("recovers a running command from its durable terminal event and restores artifacts", () => {
    const dir = tempDir("terminal-recovery");
    const runDir = join(dir, "run-durable");
    mkdirSync(join(runDir, "final"), { recursive: true });
    const first = commandAuthority(dir);
    first.store.accept({
      id: "job-durable",
      params: { value: 1 },
      idempotencyKey: "durable",
      clientId: "test",
    });
    first.store.update("job-durable", {
      state: "running",
      runId: "run-durable",
      taskId: "task-durable",
      runDir,
      startedAt: "2026-07-26T11:59:00.000Z",
    });
    const facts = recoveredFailureFacts("run-durable", "task-durable");
    const terminalEvent = RunEvent.parse({
      seq: 2,
      ts: "2026-07-26T12:00:01.000Z",
      run_id: "run-durable",
      task_id: "task-durable",
      type: "run.failed",
      payload: {
        lifecycle: "failed",
        facts: facts.outcome,
        reason: "harness_failed",
        run_facts: facts,
      },
    });
    first.journal.append("run.event", terminalEvent);
    writeFileSync(join(runDir, "final", "run_facts.yaml"), "run_id: [");
    writeFileSync(join(runDir, "events.jsonl"), JSON.stringify(terminalEvent).slice(0, -24));
    first.journal.close();

    const recovered = commandAuthority(dir);
    try {
      expect(recovered.store.get("job-durable")).toMatchObject({
        state: "failed",
        result: { lifecycle: "failed", facts: facts.outcome },
      });
      expect(
        validateRunFactsInvariants(
          JSON.parse(readFileSync(join(runDir, "final", "run_facts.yaml"), "utf8")),
        ),
      ).toEqual(facts);
      expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toBe(
        `${JSON.stringify(terminalEvent)}\n`,
      );
    } finally {
      recovered.journal.close();
    }
  });

  it("repairs a terminal tail torn inside a multi-byte UTF-8 code point", () => {
    const dir = tempDir("terminal-utf8-recovery");
    const runDir = join(dir, "run-utf8");
    mkdirSync(join(runDir, "final"), { recursive: true });
    const first = commandAuthority(dir);
    first.store.accept({
      id: "job-utf8",
      params: { value: 1 },
      idempotencyKey: "utf8",
      clientId: "test",
    });
    first.store.update("job-utf8", {
      state: "running",
      runId: "run-utf8",
      taskId: "task-utf8",
      runDir,
    });
    const baseFacts = recoveredFailureFacts("run-utf8", "task-utf8");
    const facts = validateRunFactsInvariants({
      ...baseFacts,
      participants: {
        planners: 0,
        attempts: [
          {
            attempt_id: "a01",
            harness_id: "модель",
            role: "candidate",
            deliverable_present: false,
            status: "failed",
          },
        ],
      },
    });
    const terminalEvent = RunEvent.parse({
      seq: 1,
      ts: "2026-07-26T12:00:01.000Z",
      run_id: facts.run_id,
      task_id: facts.task_id,
      type: "run.failed",
      payload: recoveredTerminalPayload(facts),
    });
    first.journal.append("run.event", terminalEvent);
    const terminalBytes = Buffer.from(JSON.stringify(terminalEvent), "utf8");
    const multiByteOffset = terminalBytes.indexOf(Buffer.from("модель", "utf8"));
    expect(multiByteOffset).toBeGreaterThan(0);
    writeFileSync(join(runDir, "events.jsonl"), terminalBytes.subarray(0, multiByteOffset + 1));
    first.journal.close();

    const recovered = commandAuthority(dir);
    try {
      expect(recovered.store.get("job-utf8")).toMatchObject({ state: "failed" });
      expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toBe(
        `${JSON.stringify(terminalEvent)}\n`,
      );
    } finally {
      recovered.journal.close();
    }
  });

  it("rejects a durable terminal whose RunFacts identity mismatches the command", () => {
    const dir = tempDir("terminal-mismatch");
    const runDir = join(dir, "run-expected");
    mkdirSync(join(runDir, "final"), { recursive: true });
    const first = commandAuthority(dir);
    first.store.accept({
      id: "job-mismatch",
      params: { value: 1 },
      idempotencyKey: "mismatch",
      clientId: "test",
    });
    first.store.update("job-mismatch", {
      state: "running",
      runId: "run-expected",
      taskId: "task-expected",
      runDir,
    });
    const facts = recoveredFailureFacts("run-other", "task-expected");
    first.journal.append(
      "run.event",
      RunEvent.parse({
        seq: 1,
        ts: "2026-07-26T12:00:01.000Z",
        run_id: "run-expected",
        task_id: "task-expected",
        type: "run.failed",
        payload: recoveredTerminalPayload(facts),
      }),
    );
    first.journal.close();

    expect(() => commandAuthority(dir)).toThrow(/identity, envelope, or outcome mismatch/);
  });

  it("rejects a durable terminal envelope whose type contradicts canonical RunFacts", () => {
    const { dir, first } = recoveryFixture("terminal-envelope", {
      seq: 1,
      type: "run.completed",
    });
    first.journal.close();

    expect(() => commandAuthority(dir)).toThrow(/identity, envelope, or outcome mismatch/);
  });

  it("rejects an already-terminal command result that disagrees with journal RunFacts", () => {
    const dir = tempDir("terminal-result-mismatch");
    const runDir = join(dir, "run-result-mismatch");
    mkdirSync(join(runDir, "final"), { recursive: true });
    const first = commandAuthority(dir);
    first.store.accept({
      id: "job-result-mismatch",
      params: { value: 1 },
      idempotencyKey: "result-mismatch",
      clientId: "test",
    });
    first.store.update("job-result-mismatch", {
      state: "running",
      runId: "run-result-mismatch",
      taskId: "task-result-mismatch",
      runDir,
    });
    const facts = recoveredFailureFacts("run-result-mismatch", "task-result-mismatch");
    first.journal.append(
      "run.event",
      RunEvent.parse({
        seq: 1,
        ts: "2026-07-26T12:00:01.000Z",
        run_id: facts.run_id,
        task_id: facts.task_id,
        type: "run.failed",
        payload: recoveredTerminalPayload(facts),
      }),
    );
    first.store.update("job-result-mismatch", {
      state: "failed",
      result: {
        lifecycle: "failed",
        facts: facts.outcome,
        runId: facts.run_id,
        taskId: "task-stale",
        runDir,
      },
    });
    first.journal.close();

    expect(() => commandAuthority(dir)).toThrow(/command result conflicts/);
  });

  it("retries a provisional recovery state from durable journal authority on startup", () => {
    const dir = tempDir("terminal-provisional-recovery");
    const runDir = join(dir, "run-provisional");
    mkdirSync(join(runDir, "final"), { recursive: true });
    const first = commandAuthority(dir);
    first.store.accept({
      id: "job-provisional",
      params: { value: 1 },
      idempotencyKey: "provisional",
      clientId: "test",
    });
    first.store.update("job-provisional", {
      state: "running",
      runId: "run-provisional",
      taskId: "task-provisional",
      runDir,
    });
    const facts = recoveredFailureFacts("run-provisional", "task-provisional");
    first.journal.append(
      "run.event",
      RunEvent.parse({
        seq: 1,
        ts: "2026-07-26T12:00:01.000Z",
        run_id: facts.run_id,
        task_id: facts.task_id,
        type: "run.failed",
        payload: recoveredTerminalPayload(facts),
      }),
    );
    first.store.update("job-provisional", {
      state: "interrupted",
      error: "local finalization failed",
      errorCode: "terminal_recovery_required",
      errorStatus: 503,
      errorRetryable: false,
    });
    first.journal.close();

    const recovered = commandAuthority(dir);
    try {
      const record = recovered.store.get("job-provisional");
      expect(record).toMatchObject({
        state: "failed",
        result: {
          lifecycle: "failed",
          runId: facts.run_id,
          taskId: facts.task_id,
        },
      });
      expect(record?.errorCode).toBeUndefined();
    } finally {
      recovered.journal.close();
    }
  });

  it("immediately reconciles terminal_recovery_required instead of leaving a live job", async () => {
    const dir = tempDir("terminal-immediate-recovery");
    const runDir = join(dir, "run-immediate");
    mkdirSync(join(runDir, "final"), { recursive: true });
    const authority = commandAuthority(dir);
    const facts = recoveredFailureFacts("run-immediate", "task-immediate");
    const server = new DaemonServer({
      socketPath: join(dir, "daemon.sock"),
      token: "token",
      commands: authority.slot,
      runner: async (_params, ctx) => {
        ctx.onRunStart({
          runId: facts.run_id,
          taskId: facts.task_id,
          runDir,
        });
        authority.journal.append(
          "run.event",
          RunEvent.parse({
            seq: 1,
            ts: "2026-07-26T12:00:01.000Z",
            run_id: facts.run_id,
            task_id: facts.task_id,
            type: "run.failed",
            payload: recoveredTerminalPayload(facts),
          }),
        );
        throw Object.assign(new Error("local terminal append failed"), {
          code: "terminal_recovery_required",
          status: 503,
          retryable: false,
        });
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(join(dir, "daemon.sock"), "token");
      const accepted = await client.enqueue(
        { value: 1 },
        { idempotencyKey: "immediate", clientId: "test" },
      );
      const record = await terminal(client, accepted.id);
      expect(record).toMatchObject({
        state: "failed",
        result: { lifecycle: "failed", runId: facts.run_id, taskId: facts.task_id },
      });
      expect(record.errorCode).toBeUndefined();
      expect(existsSync(join(runDir, "final", "run_facts.yaml"))).toBe(true);
      expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain('"run.failed"');
    } finally {
      await server.stop();
      authority.journal.close();
    }
  });

  it("keeps historical terminal commands readable and interrupts active legacy recovery", () => {
    const dir = tempDir("legacy-terminal-upgrade");
    const first = commandAuthority(dir);
    for (const [id, runId] of [
      ["job-terminal", "run-terminal"],
      ["job-active", "run-active"],
    ] as const) {
      first.store.accept({
        id,
        params: { value: id },
        idempotencyKey: id,
        clientId: "test",
      });
      first.store.update(id, {
        state: "running",
        runId,
        taskId: "task-legacy",
        runDir: join(dir, runId),
      });
      const outcome = makeOutcomeFacts("failed", { reason: "harness_failed" });
      first.journal.append(
        "run.event",
        RunEvent.parse({
          seq: 1,
          ts: "2026-07-26T12:00:01.000Z",
          run_id: runId,
          task_id: "task-legacy",
          type: "run.failed",
          payload: { facts: outcome, reason: "harness_failed" },
        }),
      );
    }
    first.store.update("job-terminal", {
      state: "failed",
      result: { lifecycle: "failed" },
      finishedAt: "2026-07-26T12:00:02.000Z",
    });
    first.journal.close();

    const recovered = commandAuthority(dir);
    try {
      expect(recovered.store.get("job-terminal")).toMatchObject({
        state: "failed",
        result: { lifecycle: "failed" },
      });
      expect(recovered.store.get("job-active")).toMatchObject({
        state: "interrupted",
        errorCode: "legacy_terminal_recovery_unavailable",
        errorStatus: 503,
        errorRetryable: false,
      });
    } finally {
      recovered.journal.close();
    }
  });

  it("rejects new durable RunFacts recovery without complete command identity", () => {
    const dir = tempDir("terminal-missing-command-identity");
    const first = commandAuthority(dir);
    first.store.accept({
      id: "job-incomplete",
      params: { value: 1 },
      idempotencyKey: "incomplete",
      clientId: "test",
    });
    first.store.update("job-incomplete", {
      state: "running",
      runId: "run-incomplete",
    });
    const facts = recoveredFailureFacts("run-incomplete", "task-incomplete");
    first.journal.append(
      "run.event",
      RunEvent.parse({
        seq: 1,
        ts: "2026-07-26T12:00:01.000Z",
        run_id: "run-incomplete",
        task_id: "task-incomplete",
        type: "run.failed",
        payload: recoveredTerminalPayload(facts),
      }),
    );
    first.journal.close();

    expect(() => commandAuthority(dir)).toThrow(/missing the command run identity or directory/);
  });

  it("rejects arbitrary malformed EOF instead of truncating committed evidence", () => {
    const dir = tempDir("terminal-garbage-eof");
    const runDir = join(dir, "run-garbage");
    mkdirSync(join(runDir, "final"), { recursive: true });
    const first = commandAuthority(dir);
    first.store.accept({
      id: "job-garbage",
      params: { value: 1 },
      idempotencyKey: "garbage",
      clientId: "test",
    });
    first.store.update("job-garbage", {
      state: "running",
      runId: "run-garbage",
      taskId: "task-garbage",
      runDir,
    });
    const facts = recoveredFailureFacts("run-garbage", "task-garbage");
    first.journal.append(
      "run.event",
      RunEvent.parse({
        seq: 2,
        ts: "2026-07-26T12:00:01.000Z",
        run_id: "run-garbage",
        task_id: "task-garbage",
        type: "run.failed",
        payload: recoveredTerminalPayload(facts),
      }),
    );
    writeFileSync(join(runDir, "events.jsonl"), '{"unrelated":"garbage"');
    first.journal.close();

    expect(() => commandAuthority(dir)).toThrow(/malformed committed evidence/);
  });

  it("rejects full per-run evidence from another run", () => {
    const { dir, runDir, first, terminalEvent } = recoveryFixture("terminal-local-identity");
    writeFileSync(
      join(runDir, "events.jsonl"),
      `${JSON.stringify(
        RunEvent.parse({
          seq: 1,
          ts: terminalEvent.ts,
          run_id: "run-other",
          task_id: terminalEvent.task_id,
          type: "run.created",
          payload: {},
        }),
      )}\n`,
    );
    first.journal.close();

    expect(() => commandAuthority(dir)).toThrow(/event identity conflicts/);
  });

  it("rejects duplicate or out-of-bounds per-run event sequences", () => {
    const duplicate = recoveryFixture("terminal-local-duplicate-seq", { seq: 3 });
    const firstEvent = RunEvent.parse({
      seq: 1,
      ts: duplicate.terminalEvent.ts,
      run_id: duplicate.terminalEvent.run_id,
      task_id: duplicate.terminalEvent.task_id,
      type: "run.created",
      payload: {},
    });
    const secondEvent = RunEvent.parse({
      ...firstEvent,
      type: "task.contract.created",
    });
    writeFileSync(
      join(duplicate.runDir, "events.jsonl"),
      `${JSON.stringify(firstEvent)}\n${JSON.stringify(secondEvent)}\n`,
    );
    duplicate.first.journal.close();
    expect(() => commandAuthority(duplicate.dir)).toThrow(/duplicate or non-monotonic/);

    const outOfBounds = recoveryFixture("terminal-local-out-of-bounds", { seq: 2 });
    writeFileSync(
      join(outOfBounds.runDir, "events.jsonl"),
      `${JSON.stringify(
        RunEvent.parse({
          seq: 3,
          ts: outOfBounds.terminalEvent.ts,
          run_id: outOfBounds.terminalEvent.run_id,
          task_id: outOfBounds.terminalEvent.task_id,
          type: "run.created",
          payload: {},
        }),
      )}\n`,
    );
    outOfBounds.first.journal.close();
    expect(() => commandAuthority(outOfBounds.dir)).toThrow(/sequence conflicts/);
  });

  it("rejects invalid UTF-8 in a committed full event line", () => {
    const { dir, runDir, first, terminalEvent } = recoveryFixture("terminal-local-invalid-utf8");
    const localEvent = RunEvent.parse({
      seq: 1,
      ts: terminalEvent.ts,
      run_id: terminalEvent.run_id,
      task_id: terminalEvent.task_id,
      type: "run.created",
      payload: { prompt: "é" },
    });
    const bytes = Buffer.from(`${JSON.stringify(localEvent)}\n`, "utf8");
    const accentOffset = bytes.indexOf(Buffer.from("é", "utf8"));
    expect(accentOffset).toBeGreaterThan(0);
    bytes[accentOffset + 1] = 0x28;
    writeFileSync(join(runDir, "events.jsonl"), bytes);
    first.journal.close();

    expect(() => commandAuthority(dir)).toThrow(/malformed committed evidence/);
  });

  it("accepts a strictly increasing control audit after the canonical terminal", () => {
    const { dir, runDir, first, terminalEvent } = recoveryFixture("terminal-post-control");
    const controlEvent = RunEvent.parse({
      seq: 3,
      ts: "2026-07-26T12:00:02.000Z",
      run_id: terminalEvent.run_id,
      task_id: terminalEvent.task_id,
      type: "control.rejected",
      payload: { reason: "run is terminal" },
    });
    writeFileSync(
      join(runDir, "events.jsonl"),
      `${JSON.stringify(terminalEvent)}\n${JSON.stringify(controlEvent)}\n`,
    );
    first.journal.close();

    const recovered = commandAuthority(dir);
    try {
      expect(recovered.store.get("job-terminal-post-control")).toMatchObject({
        state: "failed",
      });
      expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toBe(
        `${JSON.stringify(terminalEvent)}\n${JSON.stringify(controlEvent)}\n`,
      );
    } finally {
      recovered.journal.close();
    }
  });

  it("rejects duplicate identical terminal events in the per-run log", () => {
    const dir = tempDir("terminal-local-duplicate");
    const runDir = join(dir, "run-duplicate");
    mkdirSync(join(runDir, "final"), { recursive: true });
    const first = commandAuthority(dir);
    first.store.accept({
      id: "job-duplicate",
      params: { value: 1 },
      idempotencyKey: "duplicate",
      clientId: "test",
    });
    first.store.update("job-duplicate", {
      state: "running",
      runId: "run-duplicate",
      taskId: "task-duplicate",
      runDir,
    });
    const facts = recoveredFailureFacts("run-duplicate", "task-duplicate");
    const terminalEvent = RunEvent.parse({
      seq: 2,
      ts: "2026-07-26T12:00:01.000Z",
      run_id: "run-duplicate",
      task_id: "task-duplicate",
      type: "run.failed",
      payload: recoveredTerminalPayload(facts),
    });
    first.journal.append("run.event", terminalEvent);
    writeFileSync(
      join(runDir, "events.jsonl"),
      `${JSON.stringify(terminalEvent)}\n${JSON.stringify(terminalEvent)}\n`,
    );
    first.journal.close();

    expect(() => commandAuthority(dir)).toThrow(/duplicate|multiple terminal events/);
  });

  it("bounds concurrency and cancellation while exposing run identity", async () => {
    const dir = tempDir("concurrency");
    const authority = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    let active = 0;
    let maxActive = 0;
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      maxConcurrent: 2,
      runner: async (params, ctx) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        ctx.onRunStart({
          runId: `run-${(params as { id: number }).id}`,
          taskId: "task",
          runDir: dir,
        });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        active -= 1;
        // The runner owns terminal commit truth: an abort observed before it
        // returns must already be folded into the result lifecycle.
        return { lifecycle: ctx.signal.aborted ? "cancelled" : "succeeded" };
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "token");
      const jobs = await Promise.all([1, 2, 3].map((id) => client.enqueue({ id })));
      await client.cancel(jobs[0]!.id);
      const records = await Promise.all(jobs.map((job) => terminal(client, job.id)));
      expect(maxActive).toBe(2);
      expect(records[0]).toMatchObject({ state: "cancelled", runId: "run-1" });
      expect(records.slice(1).map((record) => record.state)).toEqual(["succeeded", "succeeded"]);
    } finally {
      await server.stop();
      authority.journal.close();
    }
  });

  it("reserves one overflow lane for children when a Delegate parent occupies the only slot", async () => {
    const dir = tempDir("dov");
    const authority = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    let client!: DaemonClient;
    let active = 0;
    let maxActive = 0;
    let firstChildReleased = false;
    let secondStartedBeforeRelease = false;
    let releaseFirstChild!: () => void;
    const firstChildBarrier = new Promise<void>((resolve) => {
      releaseFirstChild = resolve;
    });
    const childJobIds: string[] = [];
    const acceptedChildren = new Set<string>();
    let delegationAccepting = true;
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      delegationAuthority: {
        assertCanAdmitChild: () => {
          if (!delegationAccepting) throw new Error("parent closing");
          if (acceptedChildren.size >= 8) throw new Error("cap reached");
        },
        noteChildAccepted: (_parentRunId, admissionId) => {
          acceptedChildren.add(admissionId);
        },
        cancelAcceptedChild: (_parentRunId, admissionId) => {
          acceptedChildren.delete(admissionId);
        },
        beginParentClose: () => {
          delegationAccepting = false;
        },
      },
      maxConcurrent: 1,
      runner: async (params, ctx) => {
        const input = params as { kind: "parent" | "child"; child?: number };
        active += 1;
        maxActive = Math.max(maxActive, active);
        ctx.onRunStart({
          runId: input.kind === "parent" ? "run-parent" : `run-child-${input.child}`,
          taskId: "task",
          runDir: dir,
        });
        try {
          if (input.kind === "parent") {
            for (const child of [1, 2]) {
              const accepted = await client.enqueue(
                {
                  kind: "child",
                  child,
                  parentRunId: "run-parent",
                  delegatedFromRunId: "run-parent",
                },
                { clientId: "delegation-belt", operation: "delegated-run" },
              );
              childJobIds.push(accepted.id);
            }
            // The first child is running in the sole overflow lane; releasing
            // it lets the second reuse that lane while this parent waits.
            firstChildReleased = true;
            releaseFirstChild();
            for (const id of childJobIds) {
              const childRecord = await terminal(client, id);
              if (childRecord.state !== "succeeded") {
                throw new Error(`child ${id} ended ${childRecord.state}`);
              }
            }
          } else if (input.child === 1) {
            await firstChildBarrier;
          } else if (!firstChildReleased) {
            secondStartedBeforeRelease = true;
          }
          return { lifecycle: "succeeded" };
        } finally {
          active -= 1;
        }
      },
    });
    await server.start();
    try {
      client = new DaemonClient(socketPath, "token");
      const parentJob = await client.enqueue({ kind: "parent", delegate: true });
      await expect(terminal(client, parentJob.id)).resolves.toMatchObject({ state: "succeeded" });
      expect(childJobIds).toHaveLength(2);
      expect(secondStartedBeforeRelease).toBe(false);
      expect(maxActive).toBe(2);
    } finally {
      releaseFirstChild();
      await server.stop();
      authority.journal.close();
    }
  });

  it("fences admission during shutdown and never starts queued work afterward", async () => {
    const dir = tempDir("shutdown");
    const authority = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    let starts = 0;
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      maxConcurrent: 1,
      runner: async (_params, ctx) => {
        starts += 1;
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
        return { lifecycle: "cancelled" };
      },
    });
    await server.start();
    const client = new DaemonClient(socketPath, "token");
    await client.enqueue({ id: 1 });
    await client.enqueue({ id: 2 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stopping = server.stop();
    await expect(client.enqueue({ id: 3 })).rejects.toThrow();
    await stopping;
    expect(starts).toBe(1);
    authority.journal.close();
  });

  it("records pre-run turn failures, preserves typed codes, and rejects inline secrets", async () => {
    const dir = tempDir("refusal");
    const authority = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    const failures: unknown[] = [];
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      onTurnEnqueueFailed: (...args) => failures.push(args),
      runner: async (params) => {
        if ((params as { fail?: boolean }).fail) {
          throw Object.assign(new Error("preflight refused"), { code: "trust_required" });
        }
        return { lifecycle: "succeeded" };
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "token");
      const failed = await client.enqueue({ fail: true, turnId: "turn-1" });
      expect(await terminal(client, failed.id)).toMatchObject({
        state: "failed",
        errorCode: "trust_required",
      });
      // The 4th arg is the throw's explicit retryability claim; an untyped
      // refusal (no `retryable` on the throw) passes `undefined`, so the
      // refused-turn recorder keeps its retryable=true default (round-2 #4).
      expect(failures).toEqual([["turn-1", "preflight refused", "trust_required", undefined]]);
      await expect(client.enqueue({ prompt: `use sk-${"a".repeat(32)}` })).rejects.toThrow(
        /secret-like/i,
      );
      expect(authority.store.records()).toHaveLength(1);
    } finally {
      await server.stop();
      authority.journal.close();
    }
  });

  it("maps every result lifecycle to its job state 1:1 (D8)", async () => {
    // The daemon job state IS the run lifecycle; jobStateFromResult reads
    // result.facts.lifecycle. Outcome quality (checks/review/reason) lives on
    // the facts and is projected by the control plane, never re-encoded here.
    const lifecycles = ["succeeded", "failed", "cancelled", "interrupted"];
    const dir = tempDir("outcomes");
    const authority = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      runner: async (params) => ({ lifecycle: (params as { lifecycle: string }).lifecycle }),
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "token");
      for (const lifecycle of lifecycles) {
        const job = await client.enqueue({ lifecycle });
        expect((await terminal(client, job.id)).state).toBe(lifecycle);
      }
    } finally {
      await server.stop();
      authority.journal.close();
    }
  });

  it("does not leave a listener when shutdown races startup", async () => {
    const dir = tempDir("start-stop");
    const authority = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      runner: async () => ({ lifecycle: "succeeded" }),
    });
    const starting = server.start();
    await server.stop();
    await expect(starting).rejects.toMatchObject({ code: "daemon_stopping" });
    expect(existsSync(socketPath)).toBe(false);
    authority.journal.close();
  });
});

describe("InteractionRegistry", () => {
  it("isolates identical native interaction ids by run", async () => {
    const journal = new DurableJournal({
      rootDir: join(tempDir("interactions"), "journal"),
      partition: "global",
    });
    const store = new InteractionStore(journal);
    const registry = new InteractionRegistry({ forRequest: () => store, all: () => [store] });
    const context = (runId: string) => ({
      runId,
      taskId: `task-${runId}`,
      attemptId: "a01",
      harnessId: "test",
      request: {
        interaction_id: "same",
        source_tool: "AskUserQuestion",
        questions: [],
      },
      requestedAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const first = registry.register(context("run-a"), {});
    const second = registry.register(context("run-b"), {});
    expect(registry.pendingForRun("run-a")).toHaveLength(1);
    expect(registry.pendingForRun("run-b")).toHaveLength(1);
    const answer = { interaction_id: "same", answers: [] };
    registry.answer("run-a", "same", answer);
    registry.answer("run-b", "same", answer);
    await expect(first).resolves.toEqual(answer);
    await expect(second).resolves.toEqual(answer);
    journal.close();
  });

  it("drops pending questions when a run terminates", async () => {
    const journal = new DurableJournal({
      rootDir: join(tempDir("interactions"), "journal"),
      partition: "global",
    });
    const store = new InteractionStore(journal);
    const registry = new InteractionRegistry({ forRequest: () => store, all: () => [store] });
    const pending = registry.register(
      {
        runId: "run",
        taskId: "task",
        attemptId: "a01",
        harnessId: "test",
        request: { interaction_id: "question", source_tool: "AskUserQuestion", questions: [] },
        requestedAt: new Date().toISOString(),
        timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {},
    );
    registry.dropForRun("run");
    await expect(pending).resolves.toBeNull();
    expect(registry.pendingForRun("run")).toEqual([]);
    journal.close();
  });

  it("interrupts pending interactions on journal restart", () => {
    const rootDir = join(tempDir("interaction-restart"), "journal");
    const firstJournal = new DurableJournal({ rootDir, partition: "global" });
    const first = new InteractionStore(firstJournal);
    first.request({
      runId: "run-restart",
      taskId: "task",
      attemptId: "a01",
      harnessId: "test",
      request: { interaction_id: "question", source_tool: "AskUserQuestion", questions: [] },
      requestedAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    });
    firstJournal.close();

    const secondJournal = new DurableJournal({ rootDir, partition: "global" });
    const second = new InteractionStore(secondJournal);
    expect(second.pendingForRun("run-restart")).toEqual([]);
    expect(second.status("run-restart", "question")).toBe("resolved");
    secondJournal.close();
  });
});

describe("jobStateFromResult (terminal commit truth, QA-027)", () => {
  it("preserves a recognized committed lifecycle across a later abort", () => {
    expect(jobStateFromResult({ lifecycle: "succeeded" }, true)).toBe("succeeded");
    expect(jobStateFromResult({ lifecycle: "cancelled" }, true)).toBe("cancelled");
  });

  it("uses abort as the fail-closed fallback for a malformed result", () => {
    expect(jobStateFromResult({}, true)).toBe("cancelled");
  });

  it("preserves the honest lifecycle when not aborted", () => {
    expect(jobStateFromResult({ lifecycle: "succeeded" }, false)).toBe("succeeded");
    expect(jobStateFromResult({ lifecycle: "cancelled" }, false)).toBe("cancelled");
    // Unrecognized lifecycle is never success-by-default.
    expect(jobStateFromResult({ lifecycle: "weird" }, false)).toBe("failed");
    expect(jobStateFromResult({}, false)).toBe("failed");
  });
});
