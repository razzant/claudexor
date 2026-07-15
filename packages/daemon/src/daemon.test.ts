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
      runner: async () => ({ status: "success" }),
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
        return { status: "success", echoed: (params as { value: number }).value * 2 };
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
        return { status: "success" };
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

  it("retains recent idempotency handles beyond the history cap and restores terminal results", async () => {
    const dir = tempDir("retention");
    const authority = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      maxHistory: 1,
      runner: async (params) => ({ status: "success", echoed: params }),
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
      result: { status: "success", echoed: { value: 1 } },
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

  it("recovers queued and running commands as interrupted_unknown without replay", async () => {
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
        expect.objectContaining({ id: "job-queued", state: "interrupted_unknown" }),
        expect.objectContaining({ id: "job-running", state: "interrupted_unknown" }),
      ]),
    );
    let calls = 0;
    const server = new DaemonServer({
      socketPath: join(dir, "daemon.sock"),
      token: "token",
      commands: recovered.slot,
      runner: async () => {
        calls += 1;
        return { status: "success" };
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
        return { status: "success" };
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
        return { status: "cancelled" };
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
        return { status: "success" };
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
      expect(failures).toEqual([["turn-1", "preflight refused", "trust_required"]]);
      await expect(client.enqueue({ prompt: `use sk-${"a".repeat(32)}` })).rejects.toThrow(
        /secret-like/i,
      );
      expect(authority.store.records()).toHaveLength(1);
    } finally {
      await server.stop();
      authority.journal.close();
    }
  });

  it("maps every non-success result to its honest terminal state", async () => {
    const statuses = [
      "no_op",
      "ungated",
      "review_not_run",
      "blocked",
      "cost_unverifiable",
      "exhausted_overshoot",
      "exhausted",
      "not_converged",
      "stuck_no_progress",
      "failed",
    ];
    const dir = tempDir("outcomes");
    const authority = commandAuthority(dir);
    const socketPath = join(dir, "daemon.sock");
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: authority.slot,
      runner: async (params) => ({ status: (params as { status: string }).status }),
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "token");
      for (const status of statuses) {
        const job = await client.enqueue({ status });
        expect((await terminal(client, job.id)).state).toBe(status);
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
      runner: async () => ({ status: "success" }),
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
