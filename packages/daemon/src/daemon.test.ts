import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonClient } from "./client.js";
import { DaemonServer, type JobRecord } from "./server.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("daemon", () => {
  it("health, enqueue -> run via injected runner, status, auth, shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-daemon-"));
    const socketPath = join(dir, "s.sock");
    const token = "tkn-123";
    let ran = 0;
    const server = new DaemonServer({
      socketPath,
      token,
      runner: async (params) => {
        ran += 1;
        return { status: "success", echoed: (params as { x: number }).x * 2 };
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, token);
      const health = (await client.health()) as { ok: boolean };
      expect(health.ok).toBe(true);

      const job = await client.enqueue({ x: 21 });
      expect(job.state).toBe("queued");

      let st = await client.status(job.id);
      for (let i = 0; i < 100 && (st.state === "queued" || st.state === "running"); i++) {
        await sleep(10);
        st = await client.status(job.id);
      }
      expect(st.state).toBe("succeeded");
      expect((st.result as { echoed: number }).echoed).toBe(42);
      expect(ran).toBe(1);

      const bad = new DaemonClient(socketPath, "wrong-token");
      await expect(bad.health()).rejects.toThrow(/unauthorized/);
    } finally {
      await server.stop();
    }
  });

  it("runs jobs concurrently up to the limit, surfaces runId, and cancels a running job via signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-daemon-"));
    const socketPath = join(dir, "s.sock");
    const token = "tkn-abc";
    let active = 0;
    let maxActive = 0;
    const server = new DaemonServer({
      socketPath,
      token,
      maxConcurrent: 2,
      runner: async (params, ctx) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        ctx.onRunStart({ runId: `run-${(params as { x: number }).x}`, taskId: "t", runDir: "/tmp/x" });
        try {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            });
          });
          return { ok: true };
        } finally {
          active -= 1;
        }
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, token);
      const j1 = await client.enqueue({ x: 1 });
      const j2 = await client.enqueue({ x: 2 });
      for (let i = 0; i < 100 && maxActive < 2; i++) await sleep(10);
      expect(maxActive).toBe(2);

      const st1 = await client.status(j1.id);
      expect(st1.state).toBe("running");
      expect((st1 as { runId?: string }).runId).toBe("run-1");

      await client.cancel(j1.id);
      let s = await client.status(j1.id);
      for (let i = 0; i < 100 && s.state === "running"; i++) {
        await sleep(10);
        s = await client.status(j1.id);
      }
      expect(s.state).toBe("cancelled");

      await client.cancel(j2.id);

      // Honesty: cancelling an UNKNOWN id fails loudly (like status), never
      // returns `{cancelled:true}` for a job that does not exist.
      await expect(client.cancel("job-does-not-exist")).rejects.toThrow(/no such job/);
    } finally {
      await server.stop();
    }
  }, 20000);

  it("onTurnEnqueueFailed fires when a turn-carrying job dies BEFORE a run binds — and never when one did", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-daemon-"));
    const socketPath = join(dir, "s.sock");
    const token = "tkn-turnfail";
    const refusals: Array<{ turnId: string; error: string; code: string | null }> = [];
    const server = new DaemonServer({
      socketPath,
      token,
      persistPath: join(dir, "jobs.json"),
      onTurnEnqueueFailed: (turnId, error, code) => refusals.push({ turnId, error, code }),
      runner: async (params, ctx) => {
        const p = params as { boom?: string; turnId?: string };
        // Pre-run refusal (the trust gate shape): a TYPED throw whose machine
        // code must survive into the hook (remedies key on it).
        if (p.boom === "pre-run") {
          throw Object.assign(new Error("access profile 'full' requires allow_full_access: true"), {
            code: "trust_full_access_required",
          });
        }
        // Post-start failure: the run materialized, so the turn is bound and
        // failure honesty lives on the RUN, not the turn.
        ctx.onRunStart({ runId: "run-ok", taskId: "t", runDir: "/tmp/x" });
        if (p.boom === "post-start") throw new Error("late failure");
        return { status: "success" };
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, token);
      const settle = async (id: string) => {
        let st = await client.status(id);
        for (let i = 0; i < 200 && (st.state === "queued" || st.state === "running"); i++) {
          await sleep(10);
          st = await client.status(id);
        }
        return st;
      };
      // 1. Pre-run refusal WITH a turn: the hook records message AND code.
      const j1 = await client.enqueue({ boom: "pre-run", turnId: "tn-refused" });
      expect((await settle(j1.id)).state).toBe("failed");
      expect(refusals).toEqual([
        {
          turnId: "tn-refused",
          error: expect.stringContaining("allow_full_access"),
          code: "trust_full_access_required",
        },
      ]);
      // 2. Post-start failure: run bound -> no turn-level refusal.
      const j2 = await client.enqueue({ boom: "post-start", turnId: "tn-ran" });
      expect((await settle(j2.id)).state).toBe("failed");
      // 3. Pre-run refusal WITHOUT a turn: nothing to record.
      const j3 = await client.enqueue({ boom: "pre-run" });
      expect((await settle(j3.id)).state).toBe("failed");
      expect(refusals).toHaveLength(1);
      // The typed code SURVIVES the registry round-trip: persisted by the
      // serializer, salvaged on reload — a daemon restart must not strip the
      // machine-readable refusal from job history.
      const persisted = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8")) as Array<{ id: string; errorCode?: string }>;
      expect(persisted.find((r) => r.id === j1.id)?.errorCode).toBe("trust_full_access_required");
    } finally {
      await server.stop();
    }
  }, 20000);

  it("persists the job registry across restart (durable run list)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-daemon-"));
    const socketPath = join(dir, "s.sock");
    const persistPath = join(dir, "jobs.json");
    const token = "tkn-persist";
    const mk = () =>
      new DaemonServer({
        socketPath,
        token,
        persistPath,
        runner: async (params) => ({ status: "success", echoed: (params as { x: number }).x }),
      });

    const a = mk();
    await a.start();
    let jobId = "";
    try {
      const client = new DaemonClient(socketPath, token);
      const job = await client.enqueue({ x: 7 });
      jobId = job.id;
      let st = await client.status(job.id);
      for (let i = 0; i < 100 && st.state !== "succeeded"; i++) {
        await sleep(10);
        st = await client.status(job.id);
      }
      expect(st.state).toBe("succeeded");
    } finally {
      await a.stop();
    }

    const b = mk();
    await b.start();
    try {
      const client = new DaemonClient(socketPath, token);
      const list = (await client.list()) as JobRecord[];
      expect(list.some((r) => r.id === jobId && r.state === "succeeded")).toBe(true);
    } finally {
      await b.stop();
    }
  }, 20000);

  it("keeps terminal blocked state across restart (only in-flight states interrupt)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-daemon-"));
    const socketPath = join(dir, "s.sock");
    const persistPath = join(dir, "jobs.json");
    const token = "tkn-blocked";
    const mk = () =>
      new DaemonServer({
        socketPath,
        token,
        persistPath,
        runner: async () => ({ status: "blocked", summary: "NEEDS_HUMAN findings" }),
      });
    const a = mk();
    await a.start();
    let jobId = "";
    try {
      const client = new DaemonClient(socketPath, token);
      const job = await client.enqueue({ x: 1 });
      jobId = job.id;
      let st = await client.status(job.id);
      for (let i = 0; i < 100 && st.state !== "blocked"; i++) {
        await sleep(10);
        st = await client.status(job.id);
      }
      expect(st.state).toBe("blocked");
    } finally {
      await a.stop();
    }
    const b = mk();
    await b.start();
    try {
      const client = new DaemonClient(socketPath, token);
      const list = (await client.list()) as JobRecord[];
      // blocked is a TERMINAL review-queue state; a restart must not rewrite it.
      expect(list.some((r) => r.id === jobId && r.state === "blocked")).toBe(true);
    } finally {
      await b.stop();
    }
  }, 20000);

  it("re-enqueues persisted queued jobs on restart (pending work is not dropped to interrupted)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-daemon-"));
    const socketPath = join(dir, "s.sock");
    const persistPath = join(dir, "jobs.json");
    const token = "tkn-requeue";
    // Simulate a daemon that went down with a job still QUEUED (never started).
    writeFileSync(
      persistPath,
      JSON.stringify([{ id: "job-q1", state: "queued", params: { x: 5 }, createdAt: new Date().toISOString() }]),
    );
    let ran = 0;
    const server = new DaemonServer({
      socketPath,
      token,
      persistPath,
      runner: async (p) => {
        ran += 1;
        return { status: "success", echoed: (p as { x: number }).x };
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, token);
      let st = await client.status("job-q1");
      for (let i = 0; i < 100 && st.state !== "succeeded"; i++) {
        await sleep(10);
        st = await client.status("job-q1");
      }
      expect(st.state).toBe("succeeded");
      expect(ran).toBe(1);
    } finally {
      await server.stop();
    }
  }, 20000);

  it("persists runId at run start and never writes the raw result to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-daemon-"));
    const socketPath = join(dir, "s.sock");
    const persistPath = join(dir, "jobs.json");
    const token = "tkn-redact";
    const SECRET_SUMMARY = "RAW-MODEL-OUTPUT-do-not-persist";
    const server = new DaemonServer({
      socketPath,
      token,
      persistPath,
      runner: async (_params, ctx) => {
        ctx.onRunStart({ runId: "run-redact-1", taskId: "t", runDir: "/tmp/run-redact-1" });
        return { status: "success", summary: SECRET_SUMMARY };
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, token);
      const job = await client.enqueue({ x: 1, prompt: "tidy the README wording" });
      let st = await client.status(job.id);
      for (let i = 0; i < 100 && st.state !== "succeeded"; i++) {
        await sleep(10);
        st = await client.status(job.id);
      }
      expect(st.state).toBe("succeeded");
      // status (over the local token-gated socket) still returns the result in memory
      expect((st.result as { summary: string }).summary).toBe(SECRET_SUMMARY);
      // but the durable file must NOT contain the raw result, and must keep the runId pointer
      const onDisk = readFileSync(persistPath, "utf8");
      expect(onDisk).not.toContain(SECRET_SUMMARY);
      expect(onDisk).toContain("run-redact-1");
    } finally {
      await server.stop();
    }
  }, 20000);

  it("defense-in-depth: a secret-like prompt already ON DISK is redacted in public records and re-persistence", async () => {
    // The enqueue fence makes this state unreachable through the front door;
    // this pins the second layer for records that predate the fence (or are
    // hand-edited): redactParams covers status output AND the next persist.
    const dir = mkdtempSync(join(tmpdir(), "claudexor-daemon-"));
    const socketPath = join(dir, "s.sock");
    const persistPath = join(dir, "jobs.json");
    const token = "tkn-legacy";
    const secret = "sk-" + "e".repeat(24);
    writeFileSync(
      persistPath,
      JSON.stringify([{ id: "job-legacy", state: "failed", params: { prompt: `use ${secret}` }, createdAt: new Date().toISOString() }]),
    );
    const server = new DaemonServer({ socketPath, token, persistPath, runner: async () => ({ status: "success", summary: "x" }) });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, token);
      const st = await client.status("job-legacy");
      expect(JSON.stringify(st)).not.toContain(secret);
      expect(JSON.stringify((st as { params?: unknown }).params ?? {})).toContain("[redacted]");
    } finally {
      await server.stop();
    }
  }, 20000);

  it("REJECTS a secret-like prompt at enqueue (the prompt hard block; no bypass)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-daemon-"));
    const socketPath = join(dir, "s.sock");
    const persistPath = join(dir, "jobs.json");
    const token = "tkn-block";
    let ran = 0;
    const server = new DaemonServer({
      socketPath,
      token,
      persistPath,
      runner: async () => {
        ran += 1;
        return { status: "success", summary: "should never run" };
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, token);
      await expect(client.enqueue({ prompt: "please use sk-" + "a".repeat(24) })).rejects.toThrow(
        /durable run artifacts/,
      );
      expect(ran).toBe(0); // blocked BEFORE the runner, never queued
      // ...and BEFORE persistence: the block happens ahead of the registry
      // write, so no jobs.json record of the secret prompt ever exists.
      expect(existsSync(persistPath)).toBe(false);
      // The socket envelope carries the machine-readable class too.
      const raw = await new Promise<string>((resolvePromise, rejectPromise) => {
        const sock = createConnection(socketPath, () => {
          sock.write(
            JSON.stringify({ id: "e1", method: "claudexor.enqueue", token, params: { prompt: "k sk-" + "b".repeat(24) } }) + "\n",
          );
        });
        let buf = "";
        sock.on("data", (d) => {
          buf += String(d);
          if (buf.includes("\n")) {
            sock.end();
            resolvePromise(buf);
          }
        });
        sock.on("error", rejectPromise);
      });
      const parsed = JSON.parse(raw.split("\n")[0] as string) as { error?: { code?: string } };
      expect(parsed.error?.code).toBe("inline_secret_rejected");
    } finally {
      await server.stop();
    }
  }, 20000);

  it("maps non-success orchestrator results to honest terminal job states", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-daemon-"));
    const socketPath = join(dir, "s.sock");
    const token = "tkn-status";
    const server = new DaemonServer({
      socketPath,
      token,
      runner: async (_params, ctx) => {
        ctx.onRunStart({ runId: "run-not-converged", taskId: "t", runDir: "/tmp/run-not-converged" });
        return { status: "not_converged", summary: "best attempt still has blockers" };
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, token);
      const job = await client.enqueue({ prompt: "x" });
      let st = await client.status(job.id);
      for (let i = 0; i < 100 && (st.state === "queued" || st.state === "running"); i++) {
        await sleep(10);
        st = await client.status(job.id);
      }
      expect(st.state).toBe("not_converged");
      expect(st.error).toContain("best attempt");
    } finally {
      await server.stop();
    }
  }, 20000);
});

describe("InteractionRegistry", () => {
  it("keys pending entries by (runId, interactionId): concurrent runs reusing a native id never collide", async () => {
    const { InteractionRegistry } = await import("./interactions.js");
    const registry = new InteractionRegistry();
    const ctx = (runId: string) => ({
      runId,
      taskId: `task-${runId}`,
      attemptId: "a01",
      harnessId: "claude",
      request: {
        interaction_id: "int-1", // same native id in BOTH runs
        source_tool: "AskUserQuestion",
        questions: [{ id: "q1", question: "Color?", header: null, options: [{ label: "Red", description: null }], multi_select: false }],
      },
      requestedAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const first = registry.register(ctx("run-a"));
    const second = registry.register(ctx("run-b"));
    expect(registry.pendingForRun("run-a")).toHaveLength(1);
    expect(registry.pendingForRun("run-b")).toHaveLength(1);

    const delivered = registry.answer("run-b", "int-1", {
      interaction_id: "int-1",
      answers: [{ question_id: "q1", selected_labels: ["Red"], free_text: null }],
    });
    expect(delivered.status).toBe("delivered");
    await expect(second).resolves.toMatchObject({ interaction_id: "int-1" });
    // run-a's identical native id is untouched and still answerable.
    expect(registry.pendingForRun("run-a")).toHaveLength(1);
    const other = registry.answer("run-a", "int-1", {
      interaction_id: "int-1",
      answers: [{ question_id: "q1", selected_labels: ["Red"], free_text: null }],
    });
    expect(other.status).toBe("delivered");
    await expect(first).resolves.toMatchObject({ interaction_id: "int-1" });
  });
});

describe("jobs.json robustness", () => {
  it("backs up a corrupt registry, starts empty, and does not crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-daemon-"));
    const socketPath = join(dir, "s.sock");
    const persistPath = join(dir, "jobs.json");
    writeFileSync(persistPath, "{ this is not json");
    const server = new DaemonServer({
      socketPath,
      token: "tkn-corrupt",
      persistPath,
      runner: async () => ({ status: "success" }),
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "tkn-corrupt");
      const list = (await client.list()) as JobRecord[];
      expect(list).toEqual([]);
      expect(existsSync(`${persistPath}.bak`)).toBe(true);
    } finally {
      await server.stop();
    }
  }, 20000);

  it("salvages good records around a bad one and rejects out-of-enum states", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-daemon-"));
    const socketPath = join(dir, "s.sock");
    const persistPath = join(dir, "jobs.json");
    const good = { id: "job-good", state: "succeeded", params: {}, createdAt: new Date().toISOString() };
    const badState = { id: "job-bad-state", state: "totally-new-state", params: {}, createdAt: new Date().toISOString() };
    const notObject = "garbage";
    writeFileSync(persistPath, JSON.stringify([good, badState, notObject]));
    const server = new DaemonServer({
      socketPath,
      token: "tkn-salvage",
      persistPath,
      runner: async () => ({ status: "success" }),
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "tkn-salvage");
      const list = (await client.list()) as JobRecord[];
      expect(list.map((r) => r.id)).toEqual(["job-good"]);
      expect(existsSync(`${persistPath}.bak`)).toBe(true);
    } finally {
      await server.stop();
    }
  }, 20000);
});

describe("interrupt terminal stamping", () => {
  it("appends run.failed{interrupted} to the orphaned events.jsonl when a running job is flipped on restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-daemon-"));
    const socketPath = join(dir, "s.sock");
    const persistPath = join(dir, "jobs.json");
    const runDir = join(dir, "run-orphan");
    const eventsPath = join(runDir, "events.jsonl");
    // A previous daemon life: run announced, one event, NO terminal.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ seq: 1, ts: new Date().toISOString(), run_id: "run-orphan", task_id: "t1", type: "run.created", payload: {} })}\n`,
    );
    writeFileSync(
      persistPath,
      JSON.stringify([
        {
          id: "job-orphan",
          state: "running",
          params: {},
          createdAt: new Date().toISOString(),
          runId: "run-orphan",
          taskId: "t1",
          runDir,
        },
      ]),
    );
    const server = new DaemonServer({
      socketPath,
      token: "tkn-interrupt",
      persistPath,
      runner: async () => ({ status: "success" }),
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "tkn-interrupt");
      const list = (await client.list()) as JobRecord[];
      expect(list.find((r) => r.id === "job-orphan")?.state).toBe("interrupted");
      const lines = readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; seq: number; payload: { status?: string } });
      const terminal = lines.at(-1);
      expect(terminal?.type).toBe("run.failed");
      expect(terminal?.payload.status).toBe("interrupted");
      expect(terminal?.seq).toBe(2); // seq continues the tail
    } finally {
      await server.stop();
    }
  }, 20000);
});

describe("InteractionRegistry terminal hygiene", () => {
  it("dropForRun resolves and removes a run's pending questions (no stale waiting_on_user)", async () => {
    const { InteractionRegistry } = await import("./interactions.js");
    const registry = new InteractionRegistry();
    const ctx = {
      runId: "run-t",
      taskId: "task-t",
      attemptId: "a01",
      harnessId: "h",
      request: { interaction_id: "int-1", source_tool: "AskUserQuestion", questions: [] },
      requestedAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 900_000).toISOString(),
    };
    const parked = registry.register(ctx as never);
    expect(registry.pendingForRun("run-t").length).toBe(1);
    registry.dropForRun("run-t");
    expect(registry.pendingForRun("run-t").length).toBe(0);
    await expect(parked).resolves.toBeNull();
  });
});
