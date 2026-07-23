import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "@claudexor/journal";
import { describe, expect, it } from "vitest";
import { DaemonClient } from "./client.js";
import { CommandStore } from "./command-store.js";
import { InteractionRegistry, InteractionStore } from "./interactions.js";
import { DaemonServer, type JobRecord } from "./server.js";
import { acquireDaemonWriterLease } from "./writer-lease.js";

function tempDir(name = "daemon"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `claudexor-${name}-`)));
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
      await expect(new DaemonClient(socketPath, "wrong").health()).rejects.toMatchObject({
        status: 401,
        code: "unauthorized",
        message: "unauthorized",
        retryable: false,
        fieldErrors: {},
        requiredActions: [],
        evidenceRefs: [],
        context: {},
      });
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
      ).rejects.toMatchObject({
        code: "idempotency_conflict",
        status: 409,
        retryable: false,
        fieldErrors: {},
        requiredActions: [],
        evidenceRefs: [],
        context: {},
      });
      await terminal(client, first.id);
      expect(calls).toBe(1);
    } finally {
      await server.stop();
      authority.journal.close();
    }
  });

  it("round-trips complete RPC problems and clamps invalid error statuses to 500", async () => {
    const dir = tempDir("rpc-problem");
    const authority = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    const originalAccept = authority.store.accept.bind(authority.store);
    authority.store.accept = (input) => {
      const variant = (input.params as { variant?: unknown } | null)?.variant;
      if (variant === "complete") {
        throw Object.assign(new Error("output schema is unsupported"), {
          code: "unsupported_schema_dialect",
          status: 422,
          retryable: true,
          fieldErrors: { outputSchema: ["unsupported dialect"] },
          requiredActions: ["choose_supported_dialect"],
          evidenceRefs: ["request.outputSchema.$schema"],
          context: { supportedDialects: ["draft-07", "draft-2020-12"] },
        });
      }
      if (variant === "invalid-status") {
        throw Object.assign(new Error("defective writer supplied a success status"), {
          code: "invalid_writer_status",
          status: 200,
          retryable: true,
          fieldErrors: { status: ["must be an error status"] },
          requiredActions: ["retry_after_upgrade"],
          evidenceRefs: ["daemon.error.status"],
          context: { receivedStatus: 200 },
        });
      }
      return originalAccept(input);
    };
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      runner: async () => ({ lifecycle: "succeeded" }),
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "token");
      await expect(client.enqueue({ variant: "complete" })).rejects.toMatchObject({
        status: 422,
        code: "unsupported_schema_dialect",
        message: "output schema is unsupported",
        retryable: true,
        fieldErrors: { outputSchema: ["unsupported dialect"] },
        requiredActions: ["choose_supported_dialect"],
        evidenceRefs: ["request.outputSchema.$schema"],
        context: { supportedDialects: ["draft-07", "draft-2020-12"] },
      });
      await expect(client.enqueue({ variant: "invalid-status" })).rejects.toMatchObject({
        status: 500,
        code: "invalid_writer_status",
        message: "defective writer supplied a success status",
        retryable: true,
        fieldErrors: { status: ["must be an error status"] },
        requiredActions: ["retry_after_upgrade"],
        evidenceRefs: ["daemon.error.status"],
        context: { receivedStatus: 200 },
      });
      expect(authority.store.records()).toHaveLength(0);
    } finally {
      await server.stop();
      authority.journal.close();
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
        return { lifecycle: "succeeded" };
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
          throw Object.assign(new Error("preflight refused"), {
            code: "trust_required",
            status: 403,
            retryable: false,
            fieldErrors: { access: ["full access is required"] },
            requiredActions: ["approve_access"],
            evidenceRefs: ["request.access"],
            context: { requestedAccess: "workspace_write" },
          });
        }
        return { lifecycle: "succeeded" };
      },
    });
    await server.start();
    let failedId = "";
    try {
      const client = new DaemonClient(socketPath, "token");
      const failed = await client.enqueue({ fail: true, turnId: "turn-1" });
      failedId = failed.id;
      expect(await terminal(client, failed.id)).toMatchObject({
        state: "failed",
        errorCode: "trust_required",
        errorStatus: 403,
        problem: {
          code: "trust_required",
          message: "preflight refused",
          retryable: false,
          fieldErrors: { access: ["full access is required"] },
          requiredActions: ["approve_access"],
          evidenceRefs: ["request.access"],
          context: { requestedAccess: "workspace_write" },
        },
      });
      expect(failures).toEqual([["turn-1", "preflight refused", "trust_required"]]);
      await expect(client.enqueue({ prompt: `use sk-${"a".repeat(32)}` })).rejects.toThrow(
        /secret-like/i,
      );
      expect(authority.store.records()).toHaveLength(1);
    } finally {
      await server.stop();
      authority.journal.close();
    }
    const reopened = commandAuthority(dir);
    try {
      expect(reopened.store.get(failedId)).toMatchObject({
        state: "failed",
        errorCode: "trust_required",
        errorStatus: 403,
        problem: {
          code: "trust_required",
          message: "preflight refused",
          retryable: false,
          fieldErrors: { access: ["full access is required"] },
          requiredActions: ["approve_access"],
          evidenceRefs: ["request.access"],
          context: { requestedAccess: "workspace_write" },
        },
      });
    } finally {
      reopened.journal.close();
    }
  });

  it("keeps fallback problem codes out of legacy typed-code fields", async () => {
    const dir = tempDir("untyped-refusal");
    const authority = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    const failures: unknown[] = [];
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      onTurnEnqueueFailed: (...args) => failures.push(args),
      runner: async () => {
        throw new Error("disk failed before run start");
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "token");
      const failed = await client.enqueue({ turnId: "turn-untyped" });
      expect(await terminal(client, failed.id)).toMatchObject({
        state: "failed",
        error: "disk failed before run start",
        problem: {
          code: "daemon_job_failed",
          message: "disk failed before run start",
        },
      });
      expect(await client.status(failed.id)).not.toHaveProperty("errorCode");
      expect(failures).toEqual([["turn-untyped", "disk failed before run start", null]]);
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
