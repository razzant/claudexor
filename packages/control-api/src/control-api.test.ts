import { describe, expect, it } from "vitest";
import {
  DaemonControlApiServer,
  normalizeRunStartRequest,
  producedRepoRoot,
  type DaemonControlApiOptions,
  type DaemonFacadeClient,
  type DaemonRunRecord,
} from "./daemon-server.js";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@claudexor/util";

describe("normalizeRunStart prompt validation", () => {
  const projectScope = () => ({ scope: { kind: "project" as const, root: tmpdir() } });
  it("rejects an empty prompt (no silent no-op)", () => {
    expect(() =>
      normalizeRunStartRequest({ ...projectScope(), prompt: "", mode: "agent" }),
    ).toThrowError(/prompt must not be empty/);
  });
  it("rejects a whitespace-only prompt", () => {
    expect(() =>
      normalizeRunStartRequest({ ...projectScope(), prompt: "   \n\t ", mode: "agent" }),
    ).toThrowError(/prompt must not be empty/);
  });
  it("allows an empty prompt only when a frozen specPath supplies the intent", () => {
    const req = normalizeRunStartRequest({
      ...projectScope(),
      prompt: "",
      mode: "agent",
      specPath: " /tmp/spec.yaml ",
    });
    expect(req.specPath).toBe("/tmp/spec.yaml");
  });
  it("rejects a whitespace-only specPath as an empty-prompt substitute", () => {
    expect(() =>
      normalizeRunStartRequest({
        ...projectScope(),
        prompt: "",
        mode: "agent",
        specPath: "   ",
      }),
    ).toThrow();
  });
  it("rejects an empty prompt with only a specId (no spec content loaded at enqueue)", () => {
    expect(() =>
      normalizeRunStartRequest({ ...projectScope(), prompt: "", mode: "agent", specId: "spec-1" }),
    ).toThrowError(/prompt must not be empty/);
  });
  it("accepts a real prompt", () => {
    expect(() =>
      normalizeRunStartRequest({ ...projectScope(), prompt: "do the thing", mode: "agent" }),
    ).not.toThrow();
  });
  it("preserves typed protected path approvals", () => {
    const req = normalizeRunStartRequest({
      ...projectScope(),
      prompt: "update tests",
      mode: "agent",
      protectedPathApprovals: [
        { path: "packages/**/*.test.ts", reason: "test authoring requested" },
      ],
    });
    expect(req.protectedPathApprovals?.[0]?.path).toBe("packages/**/*.test.ts");
    expect(req.protectedPathApprovals?.[0]?.reason).toBe("test authoring requested");
  });
});

describe("DaemonControlApiServer", () => {
  const token = "daemon-token-123";
  const startAgentBody = () =>
    JSON.stringify({ prompt: "hello", mode: "agent", scope: { kind: "project", root: tmpdir() } });

  function fakeDaemon(): {
    daemon: DaemonFacadeClient;
    record: DaemonRunRecord;
    cancelled: string[];
  } {
    const runDir = mkdtempSync(join(tmpdir(), "claudexor-control-run-"));
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(runDir, "final"), { recursive: true });
    mkdirSync(join(runDir, "arbitration"), { recursive: true });
    mkdirSync(join(runDir, "context"), { recursive: true });
    mkdirSync(join(runDir, "reviews"), { recursive: true });
    writeFileSync(join(runDir, "final", "summary.md"), "# Summary\n\nDone.\n");
    const patch = "diff --git a/x b/x\n";
    writeFileSync(join(runDir, "final", "patch.diff"), patch);
    writeFileSync(
      join(runDir, "final", "work_product.yaml"),
      `id: wp-test\nkind: patch\nsource_task_id: task-d1\nmeta:\n  patch_sha256: ${sha256(patch)}\n`,
    );
    writeFileSync(
      join(runDir, "context", "task.yaml"),
      `task_id: task-d1\nrepo:\n  root: ${JSON.stringify(runDir)}\n  base_ref: HEAD\n`,
    );
    writeFileSync(
      join(runDir, "arbitration", "decision.yaml"),
      "winner: a01\nstatus: success\noutcome: ready\n",
    );
    writeFileSync(
      join(runDir, "reviews", "a01.yaml"),
      [
        "findings:",
        "  - id: f-test",
        "    severity: WARN",
        "    category: correctness",
        "    claim: persisted finding",
        "    evidence:",
        "      files:",
        "        - path: src/app.ts",
        "          lines: '12'",
        "    reviewer:",
        "      harness_id: claude",
        "      requested_effort: max",
        "      route_proof_status: verified",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(runDir, "events.jsonl"),
      [
        JSON.stringify({
          ts: new Date().toISOString(),
          run_id: "run-d1",
          task_id: "task-d1",
          type: "run.created",
          payload: {},
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          run_id: "run-d1",
          task_id: "task-d1",
          type: "harness.event",
          payload: {
            harness_id: "codex",
            attempt_id: "a01",
            type: "usage",
            title: "usage: 100 in / 20 out",
            usage: { input_tokens: 100, output_tokens: 20, cost_usd: 0.1234, estimated: true },
          },
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          run_id: "run-d1",
          task_id: "task-d1",
          type: "reviewer.started",
          payload: {
            harness_id: "codex",
            provider_family: "openai",
            requested_model: "gpt-5.5",
            requested_effort: "xhigh",
            artifact_dir: "reviews/a01-reviewers/01-codex",
          },
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          run_id: "run-d1",
          task_id: "task-d1",
          type: "reviewer.completed",
          payload: {
            harness_id: "codex",
            provider_family: "openai",
            requested_model: "gpt-5.5",
            requested_effort: "xhigh",
            route_proof_status: "verified",
            duration_ms: 1200,
            artifact_dir: "reviews/a01-reviewers/01-codex",
          },
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          run_id: "run-d1",
          task_id: "task-d1",
          type: "reviewer.failed",
          payload: {
            harness_id: "claude",
            provider_family: "anthropic",
            requested_model: "opus",
            requested_effort: "high",
            message: "reviewer failed",
            artifact_dir: "reviews/a01-reviewers/02-claude",
          },
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          run_id: "run-d1",
          task_id: "task-d1",
          type: "finding.revalidated",
          payload: { attempt_id: "a01", severity: "WARN", status: "accepted" },
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          run_id: "run-d1",
          task_id: "task-d1",
          type: "run.completed",
          payload: { status: "success" },
        }),
        "",
      ].join("\n"),
    );
    const record: DaemonRunRecord = {
      id: "job-d1",
      state: "succeeded",
      runId: "run-d1",
      taskId: "task-d1",
      runDir,
      params: {
        prompt: "hello",
        mode: "agent",
        scope: { kind: "project", root: runDir, context: "auto" },
        harnesses: ["codex"],
        portfolio: "subscription-first",
      },
    };
    const cancelled: string[] = [];
    const daemon: DaemonFacadeClient = {
      async enqueue() {
        return { id: record.id, state: "queued" };
      },
      async status(id: string) {
        if (id !== record.id) throw new Error("missing");
        return record;
      },
      async list() {
        return [record];
      },
      async cancel(id: string) {
        cancelled.push(id);
        return { ok: true };
      },
    };
    return { daemon, record, cancelled };
  }

  async function withDaemonServer(
    daemon: DaemonFacadeClient,
    fn: (base: string) => Promise<void>,
    runStartTimeoutMs?: number,
    services?: DaemonControlApiOptions["services"],
    bus?: DaemonControlApiOptions["bus"],
  ): Promise<void> {
    const server = new DaemonControlApiServer({
      token,
      daemon,
      pollMs: 5,
      runStartTimeoutMs,
      services,
      bus,
    });
    const { host, port } = await server.start();
    try {
      await fn(`http://${host}:${port}`);
    } finally {
      await server.stop();
    }
  }

  it("producedRepoRoot uses the typed scope and NEVER resolves a no-project run to the home dir", () => {
    expect(
      producedRepoRoot({
        id: "j",
        state: "succeeded",
        params: { scope: { kind: "project", root: "/Users/x/proj" } },
      }),
    ).toBe("/Users/x/proj");
    // The CRITICAL fix: a no-project run's runDir is ~/.claudexor/runs/<id>; path-
    // slicing would yield the HOME and let /produced serve ~/artifacts. scope
    // `none` must resolve to null => no produced outputs, never the home dir.
    expect(
      producedRepoRoot({
        id: "j",
        state: "succeeded",
        runDir: "/Users/x/.claudexor/runs/run-1",
        params: { scope: { kind: "none" } },
      }),
    ).toBeNull();
    expect(producedRepoRoot({ id: "j", state: "succeeded" })).toBeNull();
  });

  it("GET /runs/:id/produced lists the project's artifacts/ dir, serves files, and blocks traversal", async () => {
    const { daemon, record } = fakeDaemon();
    // record.params.scope.root === runDir; create the project's produced outputs.
    mkdirSync(join(record.runDir as string, "artifacts"), { recursive: true });
    writeFileSync(
      join(record.runDir as string, "artifacts", "preview.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    await withDaemonServer(daemon, async (base) => {
      const list = (await (
        await fetch(`${base}/runs/run-d1/produced`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as {
        artifacts: { path: string; mime?: string }[];
      };
      expect(list.artifacts.some((a) => a.path === "preview.png" && a.mime === "image/png")).toBe(
        true,
      );
      // The run-internal orchestration tree (decision.yaml etc.) must NOT leak in.
      expect(list.artifacts.some((a) => a.path.includes("decision.yaml"))).toBe(false);
      const png = await fetch(`${base}/runs/run-d1/produced/preview.png`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(png.status).toBe(200);
      expect(png.headers.get("content-type")).toBe("image/png");
      // Traversal out of <repoRoot>/artifacts is rejected by safeArtifactPath.
      const esc = await fetch(`${base}/runs/run-d1/produced/..%2f..%2fcontext%2ftask.yaml`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(esc.status).toBe(404);
    });
  });

  it("threads: create -> list -> turn (enqueued with threadId + native resume anchors) -> detail", async () => {
    const { daemon, record } = fakeDaemon();
    const repo = mkdtempSync(join(tmpdir(), "claudexor-thread-"));
    let enqueued: Record<string, unknown> | undefined;
    // Minimal in-memory thread service double (the daemon's ThreadStore contract).
    const now = new Date().toISOString();
    const threadObj: Record<string, unknown> = {
      schema_version: 2,
      id: "th-1",
      created_at: now,
      updated_at: now,
      repo: { root: repo, base_ref: "HEAD" },
      title: "test thread",
      mode: "agent",
      workspace: { mode: "in_place", worktree_path: null, base_sha: null },
      auth_preference: "auto",
      primary_harness: null,
      portfolio: "subscription-first",
      run_ids: [],
      head_run_id: null,
      state: "active",
    };
    const turns: Record<string, unknown>[] = [];
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown) {
        enqueued = params as Record<string, unknown>;
        const job = await daemon.enqueue(params);
        // Simulate the daemon runner binding the started run to its pre-created
        // turn (single-writer: control-api creates the turn, runner binds it).
        const turnId = (params as { turnId?: string }).turnId;
        if (turnId && record.runId) {
          const turn = turns.find((t) => t["id"] === turnId);
          if (turn) turn["run_id"] = record.runId;
          (threadObj["run_ids"] as string[]).push(record.runId);
          threadObj["head_run_id"] = record.runId;
        }
        return job;
      },
    };
    const services: DaemonControlApiOptions["services"] = {
      createThread: async () => threadObj,
      listThreads: async () => ({ threads: [threadObj] }),
      threadDetail: async (id) => {
        expect(id).toBe("th-1");
        return { thread: threadObj, sessions: [], turns };
      },
      createThreadTurn: async (id, prompt, opts) => {
        const turn = {
          id: "tn-1",
          thread_id: id,
          run_id: null,
          parent_run_id: opts.parentRunId ?? null,
          plan_run_id: opts.planRunId ?? null,
          kind: opts.kind ?? "followup",
          prompt,
          created_at: now,
        };
        turns.push(turn);
        return turn;
      },
    };
    await withDaemonServer(
      wrapped,
      async (base) => {
        const created = await fetch(`${base}/threads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ title: "test thread", scope: { kind: "project", root: repo } }),
        });
        expect(created.status).toBe(200);
        expect(((await created.json()) as { id: string }).id).toBe("th-1");

        const list = (await (
          await fetch(`${base}/threads`, { headers: { authorization: `Bearer ${token}` } })
        ).json()) as { threads: { id: string; needsHuman: boolean }[] };
        expect(list.threads[0]?.id).toBe("th-1");

        const turn = await fetch(`${base}/threads/th-1/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: "continue the plan" }),
        });
        expect(turn.status).toBe(200);
        const turnBody = (await turn.json()) as { runId: string; turnId: string; threadId: string };
        expect(turnBody.runId).toBe(record.runId);
        expect(turnBody.threadId).toBe("th-1");
        // The enqueued run carries the thread anchors (the engine resolves native resume from them).
        expect(enqueued).toMatchObject({
          threadId: "th-1",
          mode: "agent",
          scope: { kind: "project", root: repo },
        });

        const detail = (await (
          await fetch(`${base}/threads/th-1`, { headers: { authorization: `Bearer ${token}` } })
        ).json()) as {
          thread: { id: string; headRunId: string | null };
          turns: { prompt: string; state?: string }[];
        };
        expect(detail.thread.headRunId).toBe(record.runId);
        expect(detail.turns[0]?.prompt).toBe("continue the plan");
      },
      undefined,
      services,
    );
  });

  it("threads: a turn inherits the thread's sticky primary + eligible pool; the body overrides them; PATCH switches them", async () => {
    const { daemon, record } = fakeDaemon();
    const repo = mkdtempSync(join(tmpdir(), "claudexor-thread-pool-"));
    const now = new Date().toISOString();
    let enqueued: Record<string, unknown> | undefined;
    let patched: { primaryHarness?: string | null; eligibleHarnesses?: string[] } | undefined;
    const threadObj: Record<string, unknown> = {
      schema_version: 2,
      id: "th-9",
      created_at: now,
      updated_at: now,
      repo: { root: repo, base_ref: "HEAD" },
      title: "pool thread",
      mode: "agent",
      workspace: { mode: "in_place", worktree_path: null, base_sha: null },
      auth_preference: "auto",
      primary_harness: "codex", // sticky primary
      eligible_harnesses: ["codex", "claude"], // sticky pool
      portfolio: "subscription-first",
      run_ids: [],
      head_run_id: null,
      state: "active",
    };
    const turns: Record<string, unknown>[] = [];
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown) {
        enqueued = params as Record<string, unknown>;
        const job = await daemon.enqueue(params);
        const turnId = (params as { turnId?: string }).turnId;
        if (turnId) {
          const t = turns.find((x) => x["id"] === turnId);
          if (t) t["run_id"] = record.runId;
        }
        return job;
      },
    };
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async () => ({ thread: threadObj, sessions: [], turns }),
      createThreadTurn: async (id, prompt, opts) => {
        const turn = {
          id: `tn-${turns.length}`,
          thread_id: id,
          run_id: null,
          parent_run_id: opts.parentRunId ?? null,
          plan_run_id: opts.planRunId ?? null,
          kind: opts.kind ?? "followup",
          prompt,
          created_at: now,
        };
        turns.push(turn);
        return turn;
      },
      updateThread: async (_id, patch) => {
        patched = {
          primaryHarness: patch.primaryHarness,
          eligibleHarnesses: patch.eligibleHarnesses,
        };
        if (patch.primaryHarness !== undefined) threadObj["primary_harness"] = patch.primaryHarness;
        if (patch.eligibleHarnesses !== undefined)
          threadObj["eligible_harnesses"] = patch.eligibleHarnesses;
        return threadObj;
      },
    };
    await withDaemonServer(
      wrapped,
      async (base) => {
        // 1) No routing in the body -> inherit thread sticky primary + pool.
        await fetch(`${base}/threads/th-9/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: "go" }),
        });
        expect(enqueued).toMatchObject({ primaryHarness: "codex", harnesses: ["codex", "claude"] });

        // 2) Body override wins over the thread sticky values (+ per-turn strategy flags pass through).
        enqueued = undefined;
        await fetch(`${base}/threads/th-9/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "go",
            primaryHarness: "claude",
            harnesses: ["cursor"],
            untilClean: true,
            n: 3,
          }),
        });
        expect(enqueued).toMatchObject({
          primaryHarness: "claude",
          harnesses: ["cursor"],
          untilClean: true,
          n: 3,
        });

        // 2b) A turn that explicitly narrows the pool (Race over the available subset)
        // must NOT drag the sticky primary along when it is outside that pool — else
        // the engine would fail "primary not in eligible pool". Drop the bias instead.
        enqueued = undefined;
        await fetch(`${base}/threads/th-9/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: "race available", harnesses: ["claude"], n: 2 }), // codex (sticky primary) unavailable -> excluded
        });
        expect(enqueued).toMatchObject({ harnesses: ["claude"], n: 2 });
        expect(enqueued && "primaryHarness" in enqueued).toBe(false); // sticky codex NOT inherited (not in the pool)

        // 2c) An ORDINARY turn (no body routing) must ALSO drop the sticky primary when
        // the THREAD's own sticky pool no longer contains it — e.g. the user removed the
        // primary harness from the pool via the "⋯" chips. Otherwise EVERY following turn
        // inherits both and the engine rejects routing with "primary not in pool".
        await fetch(`${base}/threads/th-9`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ eligibleHarnesses: ["claude"] }), // drop codex (the sticky primary) from the pool
        });
        enqueued = undefined;
        await fetch(`${base}/threads/th-9/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: "ordinary turn" }), // no body routing -> inherit thread sticky
        });
        expect(enqueued).toMatchObject({ harnesses: ["claude"] });
        expect(enqueued && "primaryHarness" in enqueued).toBe(false); // sticky codex NOT inherited (outside the narrowed pool)

        // 3) PATCH switches the sticky primary + pool (the thin-gateway persist path).
        const patch = await fetch(`${base}/threads/th-9`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            primaryHarness: "claude",
            eligibleHarnesses: ["claude", "cursor"],
          }),
        });
        expect(patch.status).toBe(200);
        expect(patched).toEqual({
          primaryHarness: "claude",
          eligibleHarnesses: ["claude", "cursor"],
        });
        const patchedThread = (await patch.json()) as {
          primaryHarness: string | null;
          eligibleHarnesses: string[];
        };
        expect(patchedThread.primaryHarness).toBe("claude");
        expect(patchedThread.eligibleHarnesses).toEqual(["claude", "cursor"]);
      },
      undefined,
      services,
    );
  });

  it("threads: an empty sticky pool is NOT forwarded (engine auto-pools), but the body pool still is", async () => {
    const { daemon, record } = fakeDaemon();
    const repo = mkdtempSync(join(tmpdir(), "claudexor-thread-autopool-"));
    const now = new Date().toISOString();
    let enqueued: Record<string, unknown> | undefined;
    const threadObj: Record<string, unknown> = {
      schema_version: 2,
      id: "th-10",
      created_at: now,
      updated_at: now,
      repo: { root: repo, base_ref: "HEAD" },
      title: "auto pool",
      mode: "agent",
      workspace: { mode: "in_place", worktree_path: null, base_sha: null },
      auth_preference: "auto",
      primary_harness: null,
      eligible_harnesses: [],
      portfolio: "subscription-first",
      run_ids: [],
      head_run_id: null,
      state: "active",
    };
    const turns: Record<string, unknown>[] = [];
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown) {
        enqueued = params as Record<string, unknown>;
        const job = await daemon.enqueue(params);
        const turnId = (params as { turnId?: string }).turnId;
        if (turnId) {
          const t = turns.find((x) => x["id"] === turnId);
          if (t) t["run_id"] = record.runId;
        }
        return job;
      },
    };
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async () => ({ thread: threadObj, sessions: [], turns }),
      createThreadTurn: async (id, prompt, opts) => {
        const turn = {
          id: `tn-${turns.length}`,
          thread_id: id,
          run_id: null,
          parent_run_id: opts.parentRunId ?? null,
          plan_run_id: opts.planRunId ?? null,
          kind: opts.kind ?? "followup",
          prompt,
          created_at: now,
        };
        turns.push(turn);
        return turn;
      },
    };
    await withDaemonServer(
      wrapped,
      async (base) => {
        await fetch(`${base}/threads/th-10/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: "go" }),
        });
        expect(enqueued && "harnesses" in enqueued).toBe(false); // omitted -> engine auto-pools
        expect(enqueued && "primaryHarness" in enqueued).toBe(false);
      },
      undefined,
      services,
    );
  });

  it("threads: a turn forwards per-turn model/spec/review controls to daemon enqueue", async () => {
    // HTTP-boundary proof for the macOS per-turn model picker, spec Implement,
    // explicit reviewer panel, test gates, and protected-path approvals: the
    // thin gateway must accept and forward them to enqueue, not silently drop
    // them. (Kit tests cover Swift encoding; this locks the wire.)
    const { daemon, record } = fakeDaemon();
    const repo = mkdtempSync(join(tmpdir(), "claudexor-thread-modelspec-"));
    const now = new Date().toISOString();
    let enqueued: Record<string, unknown> | undefined;
    const threadObj: Record<string, unknown> = {
      schema_version: 2,
      id: "th-11",
      created_at: now,
      updated_at: now,
      repo: { root: repo, base_ref: "HEAD" },
      title: "model+spec",
      mode: "agent",
      workspace: { mode: "in_place", worktree_path: null, base_sha: null },
      auth_preference: "auto",
      primary_harness: null,
      eligible_harnesses: [],
      portfolio: "subscription-first",
      run_ids: [],
      head_run_id: null,
      state: "active",
    };
    const turns: Record<string, unknown>[] = [];
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown) {
        enqueued = params as Record<string, unknown>;
        const job = await daemon.enqueue(params);
        const turnId = (params as { turnId?: string }).turnId;
        if (turnId) {
          const t = turns.find((x) => x["id"] === turnId);
          if (t) t["run_id"] = record.runId;
        }
        return job;
      },
    };
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async () => ({ thread: threadObj, sessions: [], turns }),
      createThreadTurn: async (id, prompt, opts) => {
        const turn = {
          id: `tn-${turns.length}`,
          thread_id: id,
          run_id: null,
          parent_run_id: opts.parentRunId ?? null,
          plan_run_id: opts.planRunId ?? null,
          kind: opts.kind ?? "followup",
          prompt,
          created_at: now,
        };
        turns.push(turn);
        return turn;
      },
    };
    await withDaemonServer(
      wrapped,
      async (base) => {
        // A spec Implement turn: empty prompt is allowed because a frozen specPath
        // supplies the intent (mirrors normalizeRunStart's prompt-or-specPath rule).
        const r = await fetch(`${base}/threads/th-11/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "",
            model: "gpt-5-codex",
            specPath: "/repo/.claudexor/specs/s1/spec.json",
            authPreference: "subscription",
            reviewerPanel: [{ harness: "claude", model: "claude-opus-4.8", effort: "max" }],
            reviewerModels: { openai: "gpt-5.5" },
            reviewerEfforts: { openai: "xhigh" },
            tests: ["pnpm test"],
            protectedPathApprovals: [{ path: "packages/**/*.test.ts", reason: "requested" }],
          }),
        });
        expect(r.status).toBe(200);
        expect(enqueued).toMatchObject({
          model: "gpt-5-codex",
          specPath: "/repo/.claudexor/specs/s1/spec.json",
          authPreference: "subscription",
          reviewerPanel: [{ harness: "claude", model: "claude-opus-4.8", effort: "max" }],
          reviewerModels: { openai: "gpt-5.5" },
          reviewerEfforts: { openai: "xhigh" },
          tests: ["pnpm test"],
          protectedPathApprovals: [{ path: "packages/**/*.test.ts", reason: "requested" }],
          threadId: "th-11",
        });
      },
      undefined,
      services,
    );
  });

  it("allows Ask without a project by normalizing it to user-level context-off storage", async () => {
    const { daemon } = fakeDaemon();
    let enqueued: unknown;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown) {
        enqueued = params;
        return daemon.enqueue(params);
      },
    };
    await withDaemonServer(wrapped, async (base) => {
      const start = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: "2+2?", mode: "ask", harnesses: ["codex"] }),
      });
      expect(start.status).toBe(200);
      expect(enqueued).toMatchObject({
        mode: "ask",
        scope: { kind: "none" },
        execution: { isolation: "envelope" },
      });
    });
  });

  it("rejects direct inline attachment bytes before daemon enqueue", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-inline-attachment-"));
    let enqueued = 0;
    const daemon: DaemonFacadeClient = {
      async enqueue() {
        enqueued += 1;
        return { id: "job-inline", state: "queued" };
      },
      async status() {
        return { id: "job-inline", state: "queued" };
      },
      async list() {
        return [];
      },
      async cancel() {
        return { ok: true };
      },
    };
    await withDaemonServer(daemon, async (base) => {
      const start = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "use attached note",
          mode: "agent",
          scope: { kind: "project", root: repo },
          attachments: [
            {
              kind: "file",
              mime: "text/plain",
              name: "note.txt",
              data: Buffer.from("hello").toString("base64"),
            },
          ],
        }),
      });
      const body = (await start.json()) as { error?: string };
      expect(start.status).toBe(400);
      expect(body.error).toMatch(/inline attachment data/);
      expect(enqueued).toBe(0);
    });
  });

  it("allows direct path-only attachments through daemon enqueue", async () => {
    const { daemon } = fakeDaemon();
    const repo = mkdtempSync(join(tmpdir(), "claudexor-path-attachment-"));
    const file = join(repo, "note.txt");
    writeFileSync(file, "hello\n");
    let enqueued: Record<string, unknown> | undefined;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown) {
        enqueued = params as Record<string, unknown>;
        return daemon.enqueue(params);
      },
    };
    await withDaemonServer(wrapped, async (base) => {
      const start = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "use attached note",
          mode: "agent",
          scope: { kind: "project", root: repo },
          attachments: [
            {
              kind: "file",
              mime: "text/plain",
              name: "note.txt",
              path: file,
            },
          ],
        }),
      });
      expect(start.status).toBe(200);
      expect(enqueued?.["attachments"]).toEqual([
        expect.objectContaining({ kind: "file", mime: "text/plain", name: "note.txt", path: file }),
      ]);
      expect((enqueued?.["attachments"] as Array<Record<string, unknown>> | undefined)?.[0]?.["data"]).toBeUndefined();
    });
  });

  it("rejects malformed direct path-only attachments before daemon enqueue", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-bad-attachment-"));
    const nestedDir = join(repo, "dir");
    mkdirSync(nestedDir);
    let enqueued = 0;
    const daemon: DaemonFacadeClient = {
      async enqueue() {
        enqueued += 1;
        return { id: "job-bad-attachment", state: "queued" };
      },
      async status() {
        return { id: "job-bad-attachment", state: "queued" };
      },
      async list() {
        return [];
      },
      async cancel() {
        return { ok: true };
      },
    };
    await withDaemonServer(daemon, async (base) => {
      for (const attachment of [
        { kind: "file", mime: "text/plain", name: "none.txt" },
        { kind: "file", mime: "text/plain", name: "blank.txt", path: "   " },
        { kind: "file", mime: "text/plain", name: "relative.txt", path: "relative.txt" },
        { kind: "file", mime: "text/plain", name: "missing.txt", path: join(repo, "missing.txt") },
        { kind: "file", mime: "text/plain", name: "dir", path: nestedDir },
      ]) {
        const start = await fetch(`${base}/runs`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "use attached note",
            mode: "agent",
            scope: { kind: "project", root: repo },
            attachments: [attachment],
          }),
        });
        const body = (await start.json()) as { error?: string };
        expect(start.status).toBe(400);
        expect(body.error).toMatch(/attachment/);
      }
      expect(enqueued).toBe(0);
    });
  });

  it("summarizes no-project Ask runs without exposing the synthetic repo root as a project", async () => {
    const { daemon, record } = fakeDaemon();
    record.params = { prompt: "2+2?", mode: "ask", scope: { kind: "none" } };
    await withDaemonServer(daemon, async (base) => {
      const list = (await (
        await fetch(`${base}/runs`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as {
        runs: {
          project: {
            kind: string;
            root: string | null;
            projectName: string | null;
            context: string;
          };
        }[];
      };
      expect(list.runs[0]?.project).toEqual({
        kind: "none",
        root: null,
        projectName: null,
        context: "off",
      });
      const detail = (await (
        await fetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as {
        summary: {
          project: {
            kind: string;
            root: string | null;
            projectName: string | null;
            context: string;
          };
        };
      };
      expect(detail.summary.project).toEqual({
        kind: "none",
        root: null,
        projectName: null,
        context: "off",
      });
    });
  });

  it("echoes reviewer panel and protected path approvals in run summaries for honest retry", async () => {
    const { daemon, record } = fakeDaemon();
    record.params = {
      prompt: "review it",
      mode: "agent",
      scope: { kind: "project", root: record.runDir, context: "auto" },
      reviewerPanel: [
        { harness: "claude", model: "claude-opus-4.8", effort: "max" },
        { harness: "cursor", model: "gemini-3.5-flash" },
      ],
      protectedPathApprovals: [
        { path: "packages/**/*.test.ts", reason: "test authoring requested" },
      ],
    };
    await withDaemonServer(daemon, async (base) => {
      const detail = (await (
        await fetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as {
        summary: {
          reviewerPanel?: { harness: string; model?: string; effort?: string }[];
          protectedPathApprovals?: { path: string; reason?: string }[];
        };
      };
      expect(detail.summary.reviewerPanel).toEqual([
        { harness: "claude", model: "claude-opus-4.8", effort: "max" },
        { harness: "cursor", model: "gemini-3.5-flash" },
      ]);
      expect(detail.summary.protectedPathApprovals).toEqual([
        { path: "packages/**/*.test.ts", reason: "test authoring requested" },
      ]);
    });
  });

  it("falls back to TaskContract tests in run summaries for honest retry", async () => {
    const { daemon, record } = fakeDaemon();
    record.params = {
      prompt: "review it",
      mode: "agent",
      scope: { kind: "project", root: record.runDir, context: "auto" },
    };
    writeFileSync(
      join(record.runDir ?? "", "context", "task.yaml"),
      [
        "schema_version: 2",
        "task_id: task-d1",
        "created_at: 2026-07-01T00:00:00.000Z",
        "repo:",
        `  root: ${JSON.stringify(record.runDir)}`,
        "  base_ref: HEAD",
        "mode:",
        "  kind: agent",
        "user_intent:",
        "  raw: review it",
        "tests:",
        "  commands:",
        "    - id: gate-1",
        "      command: pnpm test",
        "      required: true",
        "    - id: gate-2",
        "      command: pnpm build",
        "      required: true",
        "",
      ].join("\n"),
    );
    await withDaemonServer(daemon, async (base) => {
      const detail = (await (
        await fetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as { summary: { tests?: string[] } };
      expect(detail.summary.tests).toEqual(["pnpm test", "pnpm build"]);
    });
  });

  it("rejects legacy repoRoot/contextMode fields instead of accepting the old run DTO", async () => {
    const { daemon } = fakeDaemon();
    const repo = mkdtempSync(join(tmpdir(), "claudexor-proj-"));
    await withDaemonServer(daemon, async (base) => {
      const start = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "2+2?",
          mode: "ask",
          repoRoot: repo,
          contextMode: "off",
          harnesses: ["codex"],
        }),
      });
      expect(start.status).toBe(400);
      const text = await start.text();
      expect(text).toContain("repoRoot");
      expect(text).toContain("contextMode");
    });
    rmSync(repo, { recursive: true, force: true });
  });

  it("rejects project-aware modes without a project scope instead of falling back to cwd", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      const start = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: "edit this", mode: "agent", harnesses: ["codex"] }),
      });
      expect(start.status).toBe(400);
      expect(await start.text()).toContain("project scope is required for mode 'agent'");
    });
  });

  it("rejects relative project roots at run-start and apply boundaries", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      const start = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "edit this",
          mode: "agent",
          scope: { kind: "project", root: "." },
          harnesses: ["codex"],
        }),
      });
      expect(start.status).toBe(400);
      expect(await start.text()).toContain("project root must be an absolute path");

      const check = await fetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ target: { kind: "project", root: "." } }),
      });
      expect(check.status).toBe(400);
      expect(await check.text()).toContain("project root must be an absolute path");
    });
  });

  it("rejects blank top-level scalar run controls at the HTTP boundary", async () => {
    const { daemon } = fakeDaemon();
    let enqueued = false;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown) {
        enqueued = true;
        return daemon.enqueue(params);
      },
    };
    await withDaemonServer(wrapped, async (base) => {
      const start = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "2+2?",
          mode: "ask",
          harnesses: ["codex"],
          model: "",
        }),
      });
      expect(start.status).toBe(400);
      expect(enqueued).toBe(false);

      const blankPrimary = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "2+2?",
          mode: "ask",
          harnesses: ["codex"],
          primaryHarness: "   ",
        }),
      });
      expect(blankPrimary.status).toBe(400);
      expect(enqueued).toBe(false);
    });
  });

  it("validates reviewer effort overrides at the HTTP boundary", async () => {
    const { daemon } = fakeDaemon();
    let enqueued: unknown;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown) {
        enqueued = params;
        return daemon.enqueue(params);
      },
    };
    await withDaemonServer(wrapped, async (base) => {
      const valid = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "2+2?",
          mode: "ask",
          harnesses: ["codex"],
          reviewerEfforts: { anthropic: "max", openai: "xhigh" },
        }),
      });
      expect(valid.status).toBe(200);
      expect(enqueued).toMatchObject({ reviewerEfforts: { anthropic: "max", openai: "xhigh" } });

      enqueued = undefined;
      const openaiFamily = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "2+2?",
          mode: "ask",
          harnesses: ["codex"],
          reviewerEfforts: { openai: "high" },
        }),
      });
      expect(openaiFamily.status).toBe(200);
      expect(enqueued).toMatchObject({ reviewerEfforts: { openai: "high" } });

      enqueued = undefined;
      const validModel = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "2+2?",
          mode: "ask",
          harnesses: ["codex"],
          reviewerModels: { openai: "gpt-4o" },
        }),
      });
      expect(validModel.status).toBe(200);
      expect(enqueued).toMatchObject({ reviewerModels: { openai: "gpt-4o" } });

      enqueued = undefined;
      const invalidValue = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "2+2?",
          mode: "ask",
          harnesses: ["codex"],
          reviewerEfforts: { anthropic: "banana" },
        }),
      });
      expect(invalidValue.status).toBe(400);
      expect(enqueued).toBeUndefined();

      const invalidProvider = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "2+2?",
          mode: "ask",
          harnesses: ["codex"],
          reviewerEfforts: { banana: "max" },
        }),
      });
      expect(invalidProvider.status).toBe(400);
      expect(enqueued).toBeUndefined();

      const invalidModelProvider = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "2+2?",
          mode: "ask",
          harnesses: ["codex"],
          reviewerModels: { opneai: "gpt-4o" },
        }),
      });
      expect(invalidModelProvider.status).toBe(400);
      expect(enqueued).toBeUndefined();
    });
  });

  it("rejects whitespace-only nested run controls at the HTTP boundary", async () => {
    const { daemon } = fakeDaemon();
    let enqueued = 0;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown) {
        enqueued += 1;
        return daemon.enqueue(params);
      },
    };
    await withDaemonServer(wrapped, async (base) => {
      const bodies = [
        { reviewerPanel: [{ harness: " " }] },
        { reviewerPanel: [{ harness: "claude", model: " " }] },
        { reviewerModels: { openai: " " } },
        { harnesses: ["codex", " "] },
        { tests: [" "] },
        { protectedPathApprovals: [{ path: " " }] },
        { protectedPathApprovals: [{ path: "packages/**/*.test.ts", reason: " " }] },
      ];
      for (const body of bodies) {
        const res = await fetch(`${base}/runs`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: "2+2?", mode: "ask", ...body }),
        });
        expect(res.status).toBe(400);
      }
      expect(enqueued).toBe(0);
    });
  });

  it("accepts an explicit ordered reviewer panel at the HTTP boundary", async () => {
    const { daemon } = fakeDaemon();
    let enqueued: unknown;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown) {
        enqueued = params;
        return daemon.enqueue(params);
      },
    };
    await withDaemonServer(wrapped, async (base) => {
      const valid = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "review it",
          mode: "ask",
          reviewerPanel: [
            { harness: "claude", model: "claude-opus-4-8", effort: "max" },
            { harness: "cursor", model: "gemini-3.1-pro" },
            { harness: "cursor", model: "gemini-3.5-flash" },
            { harness: "cursor", model: "gpt-5.5-xhigh-1M" },
          ],
        }),
      });
      expect(valid.status).toBe(200);
      expect(enqueued).toMatchObject({
        reviewerPanel: [
          { harness: "claude", model: "claude-opus-4-8", effort: "max" },
          { harness: "cursor", model: "gemini-3.1-pro" },
          { harness: "cursor", model: "gemini-3.5-flash" },
          { harness: "cursor", model: "gpt-5.5-xhigh-1M" },
        ],
      });

      enqueued = undefined;
      const invalid = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "review it",
          mode: "ask",
          reviewerPanel: [{ harness: "cursor", effort: "turbo" }],
        }),
      });
      expect(invalid.status).toBe(400);
      expect(enqueued).toBeUndefined();
    });
  });

  it("serves harness readiness checks and intent gating through the typed control-api service", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(
      daemon,
      async (base) => {
        const res = await fetch(`${base}/harnesses`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          harnesses: {
            id: string;
            status: string;
            enabledIntents: string[];
            disabledIntents: string[];
            checks: { id: string; status: string; detail?: string }[];
            reasons: string[];
          }[];
        };
        expect(body.harnesses[0]).toMatchObject({
          id: "codex",
          status: "degraded",
          enabledIntents: [],
          disabledIntents: ["review"],
          reasons: ["isolated smoke failed"],
        });
        expect(body.harnesses[0]?.checks).toContainEqual({
          id: "isolated_api_smoke",
          status: "fail",
          detail: "401",
        });
      },
      undefined,
      {
        harnesses: async () => ({
          harnesses: [
            {
              id: "codex",
              status: "degraded",
              manifest: null,
              enabledIntents: [],
              disabledIntents: ["review"],
              checks: [{ id: "isolated_api_smoke", status: "fail", detail: "401" }],
              reasons: ["isolated smoke failed"],
            },
          ],
        }),
      },
    );
  });

  it("serves a harness's enumerable models through the typed harnessModels service (ADP4)", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(
      daemon,
      async (base) => {
        const ok = await fetch(`${base}/harnesses/raw-api/models`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as {
          harnessId: string;
          source: string;
          models: { id: string; label: string | null; context_window: number | null }[];
        };
        expect(body).toMatchObject({ harnessId: "raw-api", source: "api" });
        expect(body.models).toEqual([{ id: "gpt-4o-mini", label: null, context_window: null }]);

        // A harness that cannot enumerate -> honest source "none" with [].
        const none = await fetch(`${base}/harnesses/codex/models`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(none.status).toBe(200);
        expect(await none.json()).toMatchObject({ harnessId: "codex", source: "none", models: [] });
      },
      undefined,
      {
        harnessModels: async ({ harnessId }) =>
          harnessId === "raw-api"
            ? {
                harnessId,
                source: "api",
                models: [{ id: "gpt-4o-mini", label: null, context_window: null }],
              }
            : { harnessId, source: "none", models: [] },
      },
    );
  });

  it("validates and forwards setup job lifecycle through typed control-api services", async () => {
    const { daemon } = fakeDaemon();
    const job = {
      jobId: "setup-1",
      harness: "cursor",
      action: "install",
      state: "waiting_for_input",
      command: "curl https://cursor.com/install -fsS | bash",
      guideUrl: "https://docs.cursor.com/cli",
      logPath: "/tmp/claudexor-setup-1.log",
      message: "confirm installer",
      riskFlags: ["network_download", "shell_pipe"],
      requiresConfirmation: true,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    const seen: unknown[] = [];
    await withDaemonServer(
      daemon,
      async (base) => {
        const created = await fetch(`${base}/setup/jobs`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ harness: "cursor", action: "install" }),
        });
        expect(created.status).toBe(200);
        expect(await created.json()).toMatchObject({
          jobId: "setup-1",
          requiresConfirmation: true,
        });
        expect(seen).toEqual([{ harness: "cursor", action: "install" }]);

        const listed = await fetch(`${base}/setup/jobs`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(listed.status).toBe(200);
        expect((await listed.json()) as unknown).toMatchObject({ jobs: [{ jobId: "setup-1" }] });

        const status = await fetch(`${base}/setup/jobs/setup-1`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(status.status).toBe(200);
        expect(await status.json()).toMatchObject({ jobId: "setup-1", state: "waiting_for_input" });

        // The lifecycle stream STAYS OPEN for a non-terminal job (it is a real
        // stream now, not a one-shot snapshot): read the first frame and abort.
        const sseAbort = new AbortController();
        const events = await fetch(`${base}/setup/jobs/setup-1/events`, {
          headers: { authorization: `Bearer ${token}` },
          signal: sseAbort.signal,
        });
        expect(events.status).toBe(200);
        const reader = (events.body as ReadableStream<Uint8Array>).getReader();
        let sseText = "";
        while (!sseText.includes("event: setup")) {
          const { value, done } = await reader.read();
          if (done) break;
          sseText += new TextDecoder().decode(value);
        }
        expect(sseText).toContain("event: setup");
        expect(sseText).toContain("waiting_for_input");
        expect(sseText).not.toContain("event: end");
        sseAbort.abort();

        const confirmed = await fetch(`${base}/setup/jobs/setup-1/confirm`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: "{}",
        });
        expect(confirmed.status).toBe(200);
        expect(await confirmed.json()).toMatchObject({ jobId: "setup-1", state: "running" });

        const cancelled = await fetch(`${base}/setup/jobs/setup-1/cancel`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(cancelled.status).toBe(200);
        expect(await cancelled.json()).toMatchObject({ jobId: "setup-1", state: "cancelled" });

        // After cancel the job is terminal: the lifecycle stream must emit the
        // terminal status and CLOSE with an end frame.
        job.state = "cancelled";
        job.finishedAt = new Date().toISOString() as never;
        const ended = await fetch(`${base}/setup/jobs/setup-1/events`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(ended.status).toBe(200);
        const endedText = await ended.text();
        expect(endedText).toContain("event: setup");
        expect(endedText).toContain("cancelled");
        expect(endedText).toContain("event: end");
      },
      undefined,
      {
        createSetupJob: async (input) => {
          seen.push(input);
          return job;
        },
        listSetupJobs: async () => ({ jobs: [job] }),
        setupJobStatus: async () => job,
        confirmSetupJob: async () => ({
          ...job,
          state: "running",
          requiresConfirmation: false,
          startedAt: new Date().toISOString(),
          message: "running",
        }),
        cancelSetupJob: async () => ({
          ...job,
          state: "cancelled",
          finishedAt: new Date().toISOString(),
          message: "cancelled",
        }),
      },
    );
  });

  it("validates spec question/freeze requests with strict scope DTOs", async () => {
    const { daemon } = fakeDaemon();
    const seen: unknown[] = [];
    await withDaemonServer(
      daemon,
      async (base) => {
        const validQuestions = await fetch(`${base}/spec/questions`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "Plan this",
            scope: { kind: "project", root: "/tmp/project" },
            harnesses: ["codex"],
          }),
        });
        expect(validQuestions.status).toBe(200);
        expect(await validQuestions.json()).toMatchObject({ questions: [] });

        for (const body of [
          { prompt: "legacy", repoRoot: "/tmp/project" },
          {
            prompt: "legacy",
            scope: { kind: "project", root: "/tmp/project" },
            contextMode: "off",
          },
          { prompt: "legacy", scope: { kind: "project", root: "/tmp/project" }, inPlace: true },
        ]) {
          const bad = await fetch(`${base}/spec/questions`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          });
          expect(bad.status).toBe(400);
        }

        const validFreeze = await fetch(`${base}/spec/freeze`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "Freeze this",
            scope: { kind: "project", root: "/tmp/project" },
            plan: "accepted plan",
          }),
        });
        expect(validFreeze.status).toBe(200);
        // specPath (the frozen SpecPack file an Implement run reads) must pass through.
        expect(await validFreeze.json()).toMatchObject({
          specId: "spec-1",
          specPath: "/tmp/spec-1/spec.json",
        });

        const badFreeze = await fetch(`${base}/spec/freeze`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "legacy",
            scope: { kind: "project", root: "/tmp/project" },
            plan: "x",
            inPlace: true,
          }),
        });
        expect(badFreeze.status).toBe(400);
        expect(seen).toHaveLength(2);
      },
      undefined,
      {
        specQuestions: async (input) => {
          seen.push(input);
          return { planRunId: "run-plan", planDir: "/tmp/run-plan", questions: [] };
        },
        specFreeze: async (input) => {
          seen.push(input);
          return {
            specId: "spec-1",
            specDir: "/tmp/spec-1",
            specPath: "/tmp/spec-1/spec.json",
            specHash: "sha256:" + "a".repeat(64),
            changes: [],
          };
        },
      },
    );
  });

  it("redacts secret-like strings from JSON artifacts before serving them", async () => {
    const { daemon, record } = fakeDaemon();
    writeFileSync(
      join(record.runDir as string, "final", "metadata.json"),
      JSON.stringify({ token: "sk-" + "a".repeat(24) }),
    );
    await withDaemonServer(daemon, async (base) => {
      const res = await fetch(`${base}/runs/run-d1/artifacts/final/metadata.json`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const text = await res.text();
      expect(text).toContain("[redacted]");
      expect(text).not.toContain("sk-" + "a".repeat(24));
    });
  });

  it("rejects secret-like string values in run params before enqueue", async () => {
    const { daemon } = fakeDaemon();
    const secret = "sk-" + "c".repeat(24);
    await withDaemonServer(daemon, async (base) => {
      const start = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: "safe", mode: "ask", tests: [`echo ${secret}`] }),
      });
      expect(start.status).toBe(400);
      expect(await start.text()).toContain("secret-like value is not accepted");
    });
  });

  it("fronts the durable daemon registry for start/list/cancel and tails events.jsonl", async () => {
    const { daemon, cancelled, record } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      const start = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: startAgentBody(),
      });
      expect(start.status).toBe(200);
      const started = (await start.json()) as {
        jobId: string;
        runId: string;
        taskId: string;
        runDir: string;
      };
      expect(started.jobId).toBe("job-d1");
      expect(started.runId).toBe("run-d1");
      expect(started.taskId).toBe("task-d1");

      const list = (await (
        await fetch(`${base}/runs`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as {
        runs: {
          jobId: string;
          runId: string;
          state: string;
          spendUsd?: number;
          spendEstimated?: boolean;
        }[];
      };
      expect(list.runs[0]?.runId).toBe("run-d1");
      expect(list.runs[0]?.state).toBe("succeeded");
      expect(list.runs[0]?.spendUsd).toBeCloseTo(0.1234);
      expect(list.runs[0]?.spendEstimated).toBe(true);

      const sse = await fetch(`${base}/runs/run-d1/events`, {
        headers: { authorization: `Bearer ${token}`, "Last-Event-ID": "1" },
      });
      expect(sse.status).toBe(200);
      const text = await sse.text();
      expect(text).not.toContain("run.created");
      expect(text).toContain("reviewer.completed");
      expect(text).toContain("reviewer.failed");
      expect(text).toContain("finding.revalidated");
      expect(text).toContain("run.completed");
      expect(text).toContain("event: end");

      // Control on a TERMINAL run is rejected honestly (nothing to stop)…
      const cancelTerminal = await fetch(`${base}/runs/run-d1/control`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ control: { kind: "cancel" } }),
      });
      expect(cancelTerminal.status).toBe(409);
      expect(cancelled).toEqual([]);
      // …and applied only while the job is actually active.
      record.state = "running";
      const cancel = await fetch(`${base}/runs/run-d1/control`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ control: { kind: "cancel" } }),
      });
      expect(cancel.status).toBe(200);
      expect(cancelled).toEqual(["job-d1"]);
    });
  });

  it("returns queued job metadata when a daemon job has not produced run artifacts yet", async () => {
    const { daemon, record } = fakeDaemon();
    record.state = "queued";
    delete record.runId;
    delete record.runDir;
    await withDaemonServer(
      daemon,
      async (base) => {
        const start = await fetch(`${base}/runs`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: startAgentBody(),
        });
        expect(start.status).toBe(202);
        expect(await start.text()).toContain("job-d1");
      },
      20,
    );
  });

  it("returns 202 for a queued job that has not surfaced runId yet", async () => {
    const daemon: DaemonFacadeClient = {
      async enqueue() {
        return { id: "job-queued", state: "queued" };
      },
      async status() {
        return { id: "job-queued", state: "queued" };
      },
      async list() {
        return [{ id: "job-queued", state: "queued" }];
      },
      async cancel() {
        return { ok: true };
      },
    };
    const server = new DaemonControlApiServer({ token, daemon, pollMs: 1, runStartTimeoutMs: 5 });
    const { host, port } = await server.start();
    try {
      const res = await fetch(`http://${host}:${port}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: startAgentBody(),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { jobId: string; state: string };
      expect(body).toEqual({ jobId: "job-queued", state: "queued" });
    } finally {
      await server.stop();
    }
  });

  it("direct POST /runs with a bare threadId pre-creates the turn BEFORE enqueue (202-queued lineage race)", async () => {
    const { record } = fakeDaemon();
    const repo = mkdtempSync(join(tmpdir(), "claudexor-race-"));
    const now = new Date().toISOString();
    const threadObj: Record<string, unknown> = {
      schema_version: 2,
      id: "th-race",
      created_at: now,
      updated_at: now,
      repo: { root: repo, base_ref: "HEAD" },
      title: "race thread",
      mode: "agent",
      workspace: { mode: "in_place", worktree_path: null, base_sha: null },
      auth_preference: "auto",
      primary_harness: null,
      eligible_harnesses: [],
      portfolio: "subscription-first",
      run_ids: [],
      head_run_id: null,
      state: "active",
    };
    const turns: Record<string, unknown>[] = [];
    // The job sits QUEUED (never surfaces runId/runDir) — exactly the window where
    // an unbound turn would be observable headless.
    let enqueuedParams: Record<string, unknown> | undefined;
    let createTurnCalled = false;
    let enqueueOrder: "turn-first" | "enqueue-first" | undefined;
    const daemon: DaemonFacadeClient = {
      async enqueue(params: unknown) {
        enqueuedParams = params as Record<string, unknown>;
        enqueueOrder = createTurnCalled ? "turn-first" : "enqueue-first";
        return { id: "job-race", state: "queued" };
      },
      async status() {
        return { id: "job-race", state: "queued" };
      },
      async list() {
        return [{ id: "job-race", state: "queued" }];
      },
      async cancel() {
        return { ok: true };
      },
    };
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async (id) => {
        expect(id).toBe("th-race");
        return { thread: threadObj, sessions: [], turns };
      },
      createThreadTurn: async (id, prompt, opts) => {
        createTurnCalled = true;
        const turn = {
          id: "tn-race",
          thread_id: id,
          run_id: null,
          parent_run_id: opts.parentRunId ?? null,
          plan_run_id: opts.planRunId ?? null,
          kind: opts.kind ?? "followup",
          prompt,
          created_at: now,
        };
        turns.push(turn);
        return turn;
      },
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        const res = await fetch(`${base}/runs`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "hi",
            mode: "agent",
            scope: { kind: "project", root: repo },
            threadId: "th-race",
          }),
        });
        expect(res.status).toBe(202);
        // The turn was created (single-writer) BEFORE the run was enqueued, and the
        // pre-created turnId rides the enqueue so the daemon runner binds it.
        expect(createTurnCalled).toBe(true);
        expect(enqueueOrder).toBe("turn-first");
        expect(enqueuedParams?.["turnId"]).toBe("tn-race");
        expect(turns).toHaveLength(1);
      },
      5,
      services,
    );
    void record;
  });

  it("direct POST /runs with a bare threadId for a MISSING thread fails loudly (no orphan enqueue)", async () => {
    let enqueued = 0;
    const daemon: DaemonFacadeClient = {
      async enqueue() {
        enqueued += 1;
        return { id: "job", state: "queued" };
      },
      async status() {
        return { id: "job", state: "queued" };
      },
      async list() {
        return [{ id: "job", state: "queued" }];
      },
      async cancel() {
        return { ok: true };
      },
    };
    const repo = mkdtempSync(join(tmpdir(), "claudexor-race-missing-"));
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async () => {
        throw Object.assign(new Error("no such thread: th-missing"), { status: 404 });
      },
      createThreadTurn: async () => {
        throw new Error("should not be called when the thread is missing");
      },
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        const res = await fetch(`${base}/runs`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "hi",
            mode: "agent",
            scope: { kind: "project", root: repo },
            threadId: "th-missing",
          }),
        });
        expect(res.status).toBe(404);
        expect(enqueued).toBe(0);
      },
      5,
      services,
    );
  });

  it("direct POST /runs with a bare threadId returns attachment precreate errors as 400", async () => {
    let enqueued = 0;
    const daemon: DaemonFacadeClient = {
      async enqueue() {
        enqueued += 1;
        return { id: "job", state: "queued" };
      },
      async status() {
        return { id: "job", state: "queued" };
      },
      async list() {
        return [];
      },
      async cancel() {
        return { ok: true };
      },
    };
    const repo = mkdtempSync(join(tmpdir(), "claudexor-race-attachment-"));
    const now = new Date().toISOString();
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async () => ({
        thread: {
          schema_version: 2,
          id: "th-attachment",
          created_at: now,
          updated_at: now,
          repo: { root: repo, base_ref: "HEAD" },
          title: "attachment thread",
          mode: "agent",
          workspace: { mode: "in_place", worktree_path: null, base_sha: null },
          auth_preference: "auto",
          primary_harness: null,
          eligible_harnesses: [],
          portfolio: "subscription-first",
          run_ids: [],
          head_run_id: null,
          state: "active",
        },
        sessions: [],
        turns: [],
      }),
      createThreadTurn: async () => {
        throw Object.assign(new Error("attachment 0 path must be absolute: relative.txt"), { status: 400 });
      },
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        const res = await fetch(`${base}/runs`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "hi",
            mode: "agent",
            scope: { kind: "project", root: repo },
            threadId: "th-attachment",
            attachments: [{ kind: "file", mime: "text/plain", name: "relative.txt", path: "relative.txt" }],
          }),
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("attachment 0 path must be absolute");
        expect(enqueued).toBe(0);
      },
      5,
      services,
    );
  });

  it("rejects old mode ids and inline env/secrets before daemon enqueue", async () => {
    let enqueued = 0;
    const daemon: DaemonFacadeClient = {
      async enqueue() {
        enqueued += 1;
        return { id: "job", state: "queued" };
      },
      async status() {
        return { id: "job", state: "queued" };
      },
      async list() {
        return [];
      },
      async cancel() {
        return { ok: true };
      },
    };
    await withDaemonServer(daemon, async (base) => {
      const oldMode = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: "x", mode: "daily" }),
      });
      expect(oldMode.status).toBe(400);

      const inlineEnv = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: "x", mode: "agent", env: { OPENAI_API_KEY: "sk-nope" } }),
      });
      expect(inlineEnv.status).toBe(400);
      expect(enqueued).toBe(0);
    });
  });

  it("serves run detail and artifact index from the run directory", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      const detail = await fetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as {
        summary: { mode?: string; prompt?: string };
        primaryOutput?: { kind: string; path: string; text: string };
        timeline: { type: string; harnessId?: string | null; title: string }[];
        budget: { spendUsd?: number; source: string; estimated: boolean };
        finalSummary?: string;
        decision?: { winner?: string };
        workProduct?: { id?: string };
        reviewFindings: { id: string; claim: string; reviewer: { requested_effort?: string } }[];
        artifacts: { path: string }[];
      };
      expect(body.summary.mode).toBe("agent");
      expect(body.summary.prompt).toBe("hello");
      expect(body.primaryOutput?.kind).toBe("summary");
      expect(body.primaryOutput?.text).toContain("Done");
      expect(body.timeline.some((e) => e.type === "harness.event" && e.harnessId === "codex")).toBe(
        true,
      );
      expect(body.timeline.some((e) => e.type === "reviewer.started")).toBe(true);
      expect(body.timeline.some((e) => e.type === "reviewer.completed")).toBe(true);
      expect(body.timeline.some((e) => e.type === "reviewer.failed")).toBe(true);
      expect(body.timeline.some((e) => e.type === "finding.revalidated")).toBe(true);
      expect(body.budget.spendUsd).toBeCloseTo(0.1234);
      expect(body.budget.source).toBe("events");
      expect(body.budget.estimated).toBe(true);
      expect(body.finalSummary).toContain("Done");
      expect(body.decision?.winner).toBe("a01");
      expect(body.workProduct?.id).toBe("wp-test");
      expect(body.reviewFindings[0]?.claim).toBe("persisted finding");
      expect(body.reviewFindings[0]?.reviewer.requested_effort).toBe("max");
      expect(body.artifacts.some((a) => a.path === "final/summary.md")).toBe(true);

      const artifacts = await fetch(`${base}/runs/run-d1/artifacts`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(artifacts.status).toBe(200);
      expect(await artifacts.text()).toContain("final/patch.diff");

      const summary = await fetch(`${base}/runs/run-d1/artifacts/final/summary.md`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(summary.status).toBe(200);
      expect(await summary.text()).toContain("Summary");
    });
  });

  it("keeps readiness-preferred auth disclosures informational in the timeline", async () => {
    const { daemon, record } = fakeDaemon();
    appendFileSync(
      join(record.runDir as string, "events.jsonl"),
      [
        JSON.stringify({
          ts: new Date().toISOString(),
          run_id: "run-d1",
          task_id: "task-d1",
          type: "route.fallback.auth_switched",
          payload: {
            reason: "readiness_preferred",
            text: "readiness-preferred Cursor api_key route",
          },
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          run_id: "run-d1",
          task_id: "task-d1",
          type: "route.fallback.auth_switched",
          payload: { reason: "auth_unavailable", text: "auth fallback" },
        }),
        "",
      ].join("\n"),
    );

    await withDaemonServer(daemon, async (base) => {
      const detail = await fetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as {
        timeline: { type: string; title: string; severity: string }[];
      };
      expect(
        body.timeline.find((e) => e.title === "readiness-preferred Cursor api_key route")?.severity,
      ).toBe("info");
      expect(body.timeline.find((e) => e.title === "auth fallback")?.severity).toBe("warning");
    });
  });

  it("selects primary output by run mode and falls back to diagnostics", async () => {
    const cases: { mode: string; path: string; kind: string; text: string }[] = [
      { mode: "ask", path: "final/answer.md", kind: "answer", text: "Answer: 4" },
      { mode: "plan", path: "final/plan.md", kind: "plan", text: "# Plan" },
      { mode: "audit", path: "final/explore.md", kind: "report", text: "# Explore" },
      { mode: "audit", path: "final/report.md", kind: "report", text: "# Audit" },
    ];
    for (const c of cases) {
      const { daemon, record } = fakeDaemon();
      record.params = { ...(record.params as Record<string, unknown>), mode: c.mode };
      writeFileSync(join(record.runDir as string, c.path), `${c.text}\n`);
      await withDaemonServer(daemon, async (base) => {
        const detail = await fetch(`${base}/runs/run-d1`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(detail.status).toBe(200);
        const body = (await detail.json()) as {
          primaryOutput?: { kind: string; path: string; text: string };
        };
        expect(body.primaryOutput?.kind).toBe(c.kind);
        expect(body.primaryOutput?.path).toBe(c.path);
        expect(body.primaryOutput?.text).toContain(c.text);
      });
    }

    const { daemon, record } = fakeDaemon();
    record.params = { ...(record.params as Record<string, unknown>), mode: "agent" };
    record.state = "failed";
    rmSync(join(record.runDir as string, "final", "summary.md"), { force: true });
    rmSync(join(record.runDir as string, "final", "patch.diff"), { force: true });
    writeFileSync(
      join(record.runDir as string, "final", "failure.yaml"),
      "safeMessage: Auth failed\ncategory: auth\n",
    );
    await withDaemonServer(daemon, async (base) => {
      const detail = await fetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await detail.json()) as { primaryOutput?: { kind: string; text: string } };
      expect(body.primaryOutput?.kind).toBe("diagnostic");
      expect(body.primaryOutput?.text).toContain("Auth failed");
    });
  });

  it("refuses symlink artifact escapes", async () => {
    const { daemon, record } = fakeDaemon();
    const outside = join(tmpdir(), `claudexor-outside-${Date.now()}.txt`);
    writeFileSync(outside, "outside secret\n");
    symlinkSync(outside, join(record.runDir as string, "final", "escape.txt"));
    await withDaemonServer(daemon, async (base) => {
      const listed = await fetch(`${base}/runs/run-d1/artifacts`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await listed.text()).not.toContain("escape.txt");

      const fetched = await fetch(`${base}/runs/run-d1/artifacts/final/escape.txt`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(fetched.status).toBe(404);
    });
  });

  it("refuses fixed apply artifacts through intermediate symlink directories", async () => {
    const { daemon, record } = fakeDaemon();
    const outside = mkdtempSync(join(tmpdir(), "claudexor-outside-final-"));
    writeFileSync(join(outside, "patch.diff"), "diff --git a/evil b/evil\n");
    rmSync(join(record.runDir as string, "final"), { recursive: true, force: true });
    symlinkSync(outside, join(record.runDir as string, "final"), "dir");
    await withDaemonServer(daemon, async (base) => {
      const apply = await fetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(apply.status).toBe(404);
      expect(await apply.text()).toContain("no patch artifact");
    });
  });

  it("refuses apply when patch hash differs from work product metadata", async () => {
    const { daemon, record } = fakeDaemon();
    writeFileSync(
      join(record.runDir as string, "final", "patch.diff"),
      "diff --git a/x b/x\n+changed\n",
    );
    await withDaemonServer(daemon, async (base) => {
      const apply = await fetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(apply.status).toBe(409);
      expect(await apply.text()).toContain("hash does not match");
    });
  });

  it("refuses apply for non-successful runs even when a patch exists", async () => {
    const { daemon, record } = fakeDaemon();
    record.state = "not_converged";
    await withDaemonServer(daemon, async (base) => {
      const apply = await fetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(apply.status).toBe(409);
      expect(await apply.text()).toContain("not_converged");
    });
  });

  it("operator decision unblocks a blocked run for apply (accept_risk), scoped to the exact patch", async () => {
    const { daemon, record } = fakeDaemon();
    record.state = "blocked";
    await withDaemonServer(daemon, async (base) => {
      // Blocked: apply/check refuses before any operator decision.
      const before = await fetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(before.status).toBe(409);

      // Operator accepts the risk (typed, audited, hash-bound).
      const decide = await fetch(`${base}/runs/run-d1/decision`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: "accept_risk",
          findingIds: ["f-1"],
          acceptedRisks: ["protected path change reviewed by hand"],
        }),
      });
      expect(decide.status).toBe(200);
      expect(((await decide.json()) as { accepted: boolean }).accepted).toBe(true);
      // The decision is a durable, auditable artifact.
      const persisted = readFileSync(
        join(record.runDir as string, "arbitration", "operator_decision.yaml"),
        "utf8",
      );
      expect(persisted).toContain("accept_risk");
      expect(persisted).toContain("patch_sha256");

      // The gate now passes for THIS patch...
      const after = await fetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(after.status).toBe(200);

      // ...but a mutated patch invalidates the override (hash-bound).
      writeFileSync(
        join(record.runDir as string, "final", "patch.diff"),
        "diff --git a/x b/x\n+tampered\n",
      );
      const tampered = await fetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(tampered.status).toBe(409);
    });
  });

  it("post-terminal audit appends keep the seq cursor strictly monotonic (SSE resume safety)", async () => {
    const { daemon, record } = fakeDaemon();
    record.state = "blocked";
    await withDaemonServer(daemon, async (base) => {
      const before = (await (
        await fetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as { lastSeq: number };
      const decide = await fetch(`${base}/runs/run-d1/decision`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "accept_risk", acceptedRisks: ["r"] }),
      });
      expect(decide.status).toBe(200);
      const after = (await (
        await fetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as { lastSeq: number; operatorDecision?: { action: string } | null };
      // The control.applied audit event appended to the terminal run must advance
      // the durable cursor (a collision would break Last-Event-ID resume).
      expect(after.lastSeq).toBeGreaterThan(before.lastSeq);
      // ...and the persisted operator decision is server-projected for UIs.
      expect(after.operatorDecision?.action).toBe("accept_risk");
    });
  });

  it("rerun_with_feedback enqueues a follow-up run carrying the operator feedback", async () => {
    const { daemon, record } = fakeDaemon();
    record.state = "blocked";
    let enqueued: Record<string, unknown> | undefined;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown) {
        enqueued = params as Record<string, unknown>;
        return daemon.enqueue(params);
      },
    };
    await withDaemonServer(wrapped, async (base) => {
      const res = await fetch(`${base}/runs/run-d1/decision`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: "rerun_with_feedback",
          feedback: "Narrow the diff to src/auth only.",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; newRunId?: string };
      expect(body.status).toBe("requeued");
      expect(body.newRunId).toBeTruthy();
      expect(String(enqueued?.["prompt"])).toContain("Narrow the diff to src/auth only.");
      expect(enqueued?.["parentRunId"]).toBe("run-d1");
    });
  });

  it("degrades an invalid persisted mode to an unknown field instead of poisoning the run list", async () => {
    // One malformed job record (e.g. a legacy "daily" mode) must never 500 the
    // whole run list/detail surface forever; the engine still rejects unknown
    // modes loudly at RUN time — this is only the read-side projection.
    const { daemon, record } = fakeDaemon();
    record.params = { prompt: "legacy", mode: "daily" };
    await withDaemonServer(daemon, async (base) => {
      const detail = await fetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as { summary: { mode?: string; runId: string } };
      expect(body.summary.mode).toBeUndefined();
      expect(body.summary.runId).toBe("run-d1");
      const list = await fetch(`${base}/runs`, { headers: { authorization: `Bearer ${token}` } });
      expect(list.status).toBe(200);
    });
  });

  it("redacts prompts in summaries and refuses secret-like patch artifacts", async () => {
    const { daemon, record } = fakeDaemon();
    const secret = "sk-" + "a".repeat(24);
    record.params = { prompt: `use ${secret}`, mode: "agent", portfolio: "subscription-first" };
    writeFileSync(
      join(record.runDir as string, "final", "patch.diff"),
      `diff --git a/.env b/.env\n+OPENAI_API_KEY=${secret}\n`,
    );
    await withDaemonServer(daemon, async (base) => {
      const list = (await (
        await fetch(`${base}/runs`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as {
        runs: { prompt?: string }[];
      };
      expect(list.runs[0]?.prompt).toContain("[redacted]");
      expect(list.runs[0]?.prompt).not.toContain(secret);

      const patch = await fetch(`${base}/runs/run-d1/artifacts/final/patch.diff`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(patch.status).toBe(409);

      const apply = await fetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(apply.status).toBe(409);
    });
  });

  it("redacts secret-like text artifacts before serving them", async () => {
    const { daemon, record } = fakeDaemon();
    const secret = "sk-" + "b".repeat(24);
    writeFileSync(
      join(record.runDir as string, "final", "summary.md"),
      `# Summary\n\nToken ${secret}\n`,
    );
    await withDaemonServer(daemon, async (base) => {
      const summary = await fetch(`${base}/runs/run-d1/artifacts/final/summary.md`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(summary.status).toBe(200);
      const text = await summary.text();
      expect(text).toContain("[redacted]");
      expect(text).not.toContain(secret);
    });
  });

  it("redacts secret-like jsonl artifacts before serving them", async () => {
    const { daemon, record } = fakeDaemon();
    const secret = "sk-" + "d".repeat(24);
    writeFileSync(
      join(record.runDir as string, "events.jsonl"),
      JSON.stringify({ type: "message", text: secret }) + "\n",
    );
    await withDaemonServer(daemon, async (base) => {
      const events = await fetch(`${base}/runs/run-d1/artifacts/events.jsonl`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(events.status).toBe(200);
      const text = await events.text();
      expect(text).toContain("[redacted]");
      expect(text).not.toContain(secret);
    });
  });

  it("redacts secret-like run events before daemon SSE replay", async () => {
    const { daemon, record } = fakeDaemon();
    const secret = "sk-" + "e".repeat(24);
    writeFileSync(
      join(record.runDir as string, "events.jsonl"),
      [
        JSON.stringify({ type: "harness.event", payload: { text: secret } }),
        JSON.stringify({ type: "run.completed", payload: { status: "success" } }),
        "",
      ].join("\n"),
    );
    await withDaemonServer(daemon, async (base) => {
      const events = await fetch(`${base}/runs/run-d1/events`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(events.status).toBe(200);
      const text = await events.text();
      expect(text).toContain("[redacted]");
      expect(text).not.toContain(secret);
      expect(text).toContain("event: run.completed");
    });
  });

  it("refuses apply with malformed decision artifacts instead of throwing a 500", async () => {
    const { daemon, record } = fakeDaemon();
    writeFileSync(join(record.runDir as string, "arbitration", "decision.yaml"), "winner: [\n");
    await withDaemonServer(daemon, async (base) => {
      const apply = await fetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(apply.status).toBe(409);
      expect(await apply.text()).toContain("decision record is required");
    });
  });

  it("redacts service errors before returning control-api JSON", async () => {
    const { daemon } = fakeDaemon();
    const secret = "sk-" + "f".repeat(24);
    await withDaemonServer(
      daemon,
      async (base) => {
        const res = await fetch(`${base}/settings`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(text).toContain("[redacted]");
        expect(text).not.toContain(secret);
      },
      undefined,
      {
        settings: async () => {
          throw new Error(`settings failed with ${secret}`);
        },
      },
    );
  });

  it("validates settings patches and managed secret names", async () => {
    const { daemon } = fakeDaemon();
    const server = new DaemonControlApiServer({
      token,
      daemon,
      services: {
        settings: async () => ({
          sources: [],
          defaultPortfolio: "subscription-first",
          routing: {
            defaultPolicy: "auto",
            primaryHarness: null,
            eligibleHarnesses: [],
            envInheritance: "mirror_native",
          },
          budget: { maxUsdPerRun: null },
          runtime: {
            reviewerTimeoutMs: 2_400_000,
            transientRetry: { maxRetries: 3, initialDelayMs: 2_000, maxDelayMs: 20_000 },
          },
        }),
        updateSettings: async (patch) => ({ patch }),
        listSecrets: async () => ({ backend: "file", secrets: [] }),
        setSecret: async () => ({ ok: true }),
        deleteSecret: async () => ({ ok: true }),
      },
    });
    const { host, port } = await server.start();
    const base = `http://${host}:${port}`;
    try {
      const badSettings = await fetch(`${base}/settings`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ routingPolicy: "surprise" }),
      });
      expect(badSettings.status).toBe(400);

      const okSettings = await fetch(`${base}/settings`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ clearMaxUsdPerRun: true }),
      });
      expect(okSettings.status).toBe(200);
      const shownSettings = await fetch(`${base}/settings`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(shownSettings.status).toBe(200);
      const shownJson = (await shownSettings.json()) as Record<string, any>;
      expect(shownJson["runtime"]?.["reviewerTimeoutMs"]).toBe(2_400_000);
      expect(shownJson["runtime"]?.["transientRetry"]?.["maxRetries"]).toBe(3);

      const badSecret = await fetch(`${base}/secrets`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "github", value: "x" }),
      });
      expect(badSecret.status).toBe(400);

      const okSecretList = await fetch(`${base}/secrets`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(okSecretList.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it("uses the PERSISTED event seq as the SSE cursor (sparse-safe replay from Last-Event-ID)", async () => {
    const { daemon, record } = fakeDaemon();
    writeFileSync(
      join(record.runDir as string, "events.jsonl"),
      [
        JSON.stringify({
          seq: 10,
          ts: "t",
          run_id: "run-d1",
          task_id: "task-d1",
          type: "run.created",
          payload: {},
        }),
        JSON.stringify({
          seq: 20,
          ts: "t",
          run_id: "run-d1",
          task_id: "task-d1",
          type: "output.ready",
          payload: { path: "final/summary.md" },
        }),
        JSON.stringify({
          seq: 30,
          ts: "t",
          run_id: "run-d1",
          task_id: "task-d1",
          type: "run.completed",
          payload: { status: "success" },
        }),
        "",
      ].join("\n"),
    );
    await withDaemonServer(daemon, async (base) => {
      const sse = await fetch(`${base}/runs/run-d1/events`, {
        headers: { authorization: `Bearer ${token}`, "Last-Event-ID": "10" },
      });
      const text = await sse.text();
      expect(text).not.toContain("run.created");
      expect(text).toContain("id: 20");
      expect(text).toContain("id: 30");
      expect(text).toContain("event: end");
    });
  });

  it("returns lastSeq + pending interactions in detail, overlays waitingOnUser, and delivers answers", async () => {
    const { daemon, record } = fakeDaemon();
    writeFileSync(
      join(record.runDir as string, "events.jsonl"),
      [
        JSON.stringify({
          seq: 1,
          ts: "t",
          run_id: "run-d1",
          task_id: "task-d1",
          type: "run.created",
          payload: {},
        }),
        JSON.stringify({
          seq: 2,
          ts: "t",
          run_id: "run-d1",
          task_id: "task-d1",
          type: "interaction.requested",
          payload: { interaction_id: "int-1" },
        }),
        "",
      ].join("\n"),
    );
    const delivered: unknown[] = [];
    const services: DaemonControlApiOptions["services"] = {
      pendingInteractions: (runId: string) =>
        runId === "run-d1"
          ? [
              {
                interactionId: "int-1",
                runId: "run-d1",
                attemptId: "a01",
                harnessId: "claude",
                sourceTool: "AskUserQuestion",
                questions: [
                  {
                    id: "q1",
                    question: "Which?",
                    header: null,
                    options: [{ label: "A", description: null }],
                    multi_select: false,
                  },
                ],
                requestedAt: "t",
                timeoutAt: null,
              },
            ]
          : [],
      answerInteraction: (runId: string, interactionId: string, answers: unknown) => {
        delivered.push({ runId, interactionId, answers });
        return interactionId === "int-1"
          ? { status: "delivered" }
          : { status: "not_found", message: "missing" };
      },
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        const detail = (await (
          await fetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
        ).json()) as {
          lastSeq: number;
          pendingInteractions: { interactionId: string }[];
          summary: { waitingOnUser: boolean };
        };
        expect(detail.lastSeq).toBe(2);
        expect(detail.pendingInteractions).toHaveLength(1);
        expect(detail.pendingInteractions[0]?.interactionId).toBe("int-1");
        expect(detail.summary.waitingOnUser).toBe(true);

        const list = (await (
          await fetch(`${base}/runs`, { headers: { authorization: `Bearer ${token}` } })
        ).json()) as {
          runs: { waitingOnUser: boolean }[];
        };
        expect(list.runs[0]?.waitingOnUser).toBe(true);

        const answer = await fetch(`${base}/runs/run-d1/interactions/int-1/answer`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            answers: [{ questionId: "q1", selectedLabels: ["A"], freeText: null }],
          }),
        });
        expect(answer.status).toBe(200);
        expect(await answer.json()).toMatchObject({ accepted: true, status: "delivered" });
        expect(delivered[0]).toMatchObject({
          runId: "run-d1",
          interactionId: "int-1",
          answers: {
            interaction_id: "int-1",
            answers: [{ question_id: "q1", selected_labels: ["A"], free_text: null }],
          },
        });

        const missing = await fetch(`${base}/runs/run-d1/interactions/int-404/answer`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ answers: [] }),
        });
        expect(missing.status).toBe(404);
      },
      undefined,
      services,
    );
  });

  it("streams the global live-only multiplex from the bus and 501s without one", async () => {
    const { daemon } = fakeDaemon();
    const listeners = new Set<(event: { run_id: string }) => void>();
    const bus = {
      subscribe(listener: (event: { run_id: string }) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      publish(event: { run_id: string }) {
        for (const l of listeners) l(event);
      },
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        const res = await fetch(`${base}/events`, {
          headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        });
        expect(res.status).toBe(200);
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        // Wait until the subscription is registered, then push one event.
        const deadline = Date.now() + 2_000;
        while (listeners.size === 0 && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 5));
        bus.publish({
          run_id: "run-d1",
          seq: 7,
          type: "harness.event",
          payload: { type: "message", title: "hi" },
        } as never);
        let buffer = "";
        const decoder = new TextDecoder();
        while (!buffer.includes("\n\n") || !buffer.includes("data:")) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (Date.now() > deadline) break;
        }
        await reader.cancel();
        expect(buffer).toContain("id: 7");
        expect(buffer).toContain("event: harness.event");
        expect(buffer).toContain("run-d1");
      },
      undefined,
      undefined,
      bus,
    );

    await withDaemonServer(daemon, async (base) => {
      const res = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(501);
    });
  });

  it("accepts a non-git existing project root (the engine initializes git itself) but 400s a missing one", async () => {
    const { daemon } = fakeDaemon();
    const nonGit = mkdtempSync(join(tmpdir(), "claudexor-nongit-api-"));
    await withDaemonServer(daemon, async (base) => {
      const ok = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "build",
          mode: "agent",
          scope: { kind: "project", root: nonGit },
        }),
      });
      expect(ok.status).toBe(200);

      const missing = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "build",
          mode: "agent",
          scope: { kind: "project", root: join(tmpdir(), "claudexor-definitely-missing-xyz") },
        }),
      });
      expect(missing.status).toBe(400);
      expect(await missing.text()).toContain("does not exist");
    });
    rmSync(nonGit, { recursive: true, force: true });
  });
});
