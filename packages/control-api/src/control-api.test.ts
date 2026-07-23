import { describe, expect, it } from "vitest";
import {
  DaemonControlApiServer,
  normalizeRunStartRequest,
  type DaemonControlApiOptions,
  type DaemonFacadeClient,
  type DaemonRunRecord,
  type ControlOperatorDecisionRecord,
} from "./daemon-server.js";
import { producedRepoRoot, resolveProducedRoot } from "./artifact-serve-routes.js";
import { unboundRunStartResponse } from "./run-start.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";
import { eventsParseCountForTests, resetEventsParseCountForTests } from "./run-timeline.js";
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
import { connect } from "node:net";
import { execFileSync } from "node:child_process";
import { sha256 } from "@claudexor/util";
import type { ControlSetupJob } from "@claudexor/schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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

function apiFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  if (input instanceof Request) return globalThis.fetch(input, init);
  const url = new URL(String(input));
  if (url.pathname !== "/healthz" && !url.pathname.startsWith("/v2/")) {
    url.pathname = `/v2${url.pathname}`;
  }
  const headers = new Headers(init.headers);
  if (url.pathname !== "/healthz" && url.pathname !== "/v2/handshake") {
    headers.set("X-Claudexor-Protocol-Major", "3");
  }
  if (
    (init.method ?? "GET").toUpperCase() === "POST" &&
    (url.pathname === "/v2/runs" ||
      url.pathname === "/v2/projects" ||
      url.pathname === "/v2/threads" ||
      /^\/v2\/runs\/[^/]+\/apply$/.test(url.pathname) ||
      /^\/v2\/threads\/[^/]+\/apply$/.test(url.pathname) ||
      /^\/v2\/threads\/[^/]+\/turns(?:\/[^/]+\/retry)?$/.test(url.pathname)) &&
    !headers.has("Idempotency-Key")
  ) {
    headers.set("Idempotency-Key", `test-${crypto.randomUUID()}`);
  }
  return globalThis.fetch(url, { ...init, headers });
}

function inMemoryDeliveryServices() {
  const byKey = new Map<
    string,
    { id: string; state: string; result?: unknown; error?: string; errorCode?: string }
  >();
  return {
    beginDelivery: async (
      _params: unknown,
      input: { key: string; operation: string; request: unknown },
    ) => {
      const key = `${input.operation}:${input.key}`;
      const prior = byKey.get(key);
      if (prior) return { ...prior, reused: true };
      const record = { id: `delivery-${byKey.size + 1}`, state: "running" };
      byKey.set(key, record);
      return { ...record, reused: false };
    },
    completeDelivery: async (id: string, result: unknown) => {
      const record = [...byKey.values()].find((candidate) => candidate.id === id);
      if (record) Object.assign(record, { state: "succeeded", result });
    },
    failDelivery: async (id: string, error: unknown) => {
      const record = [...byKey.values()].find((candidate) => candidate.id === id);
      if (record)
        Object.assign(record, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
    },
  };
}

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
  // Council (INV-031) is a PLAN strategy; `--n` on a plan is legal ONLY with it.
  it("accepts council on a plan run", () => {
    expect(() =>
      normalizeRunStartRequest({
        ...projectScope(),
        prompt: "plan it",
        mode: "plan",
        council: true,
      }),
    ).not.toThrow();
  });
  it("accepts --n with council on a plan run", () => {
    expect(() =>
      normalizeRunStartRequest({
        ...projectScope(),
        prompt: "plan it",
        mode: "plan",
        council: true,
        n: 3,
      }),
    ).not.toThrow();
  });
  it("rejects council on a non-plan mode", () => {
    expect(() =>
      normalizeRunStartRequest({
        ...projectScope(),
        prompt: "do it",
        mode: "agent",
        council: true,
      }),
    ).toThrowError(/council is a plan strategy/);
  });
  it("rejects --n on a plan run WITHOUT council", () => {
    expect(() =>
      normalizeRunStartRequest({ ...projectScope(), prompt: "plan it", mode: "plan", n: 3 }),
    ).toThrowError(/council membership width|pass --council/);
  });
  it("rejects an out-of-range council membership n", () => {
    expect(() =>
      normalizeRunStartRequest({
        ...projectScope(),
        prompt: "plan it",
        mode: "plan",
        council: true,
        n: 9,
      }),
    ).toThrowError(/between 2 and 4/);
  });
});

describe("DaemonControlApiServer", () => {
  const token = "daemon-token-123";
  const readyIdentity = {};
  const startAgentBody = () =>
    JSON.stringify({ prompt: "hello", mode: "agent", scope: { kind: "project", root: tmpdir() } });

  const setupJobFixture = (overrides: Partial<ControlSetupJob> = {}): ControlSetupJob => {
    const state = overrides.state ?? "running";
    const harness = overrides.harness ?? "codex";
    const binding = {
      attemptId: "attempt-setup-stream",
      challengeDigest: "a".repeat(64),
      requestDigest: "b".repeat(64),
      disclosure: {
        schemaVersion: 1 as const,
        protocolVersion: 1 as const,
        harness,
        requested: "subscription" as const,
        requiredRoute: "vendor_native" as const,
        requiredSource: "native_session" as const,
        networkScope: "selected_harness_only" as const,
        billingKnowledge: "unknown" as const,
        incrementalCostKnowledge: "unknown" as const,
        mayConsumeQuota: true,
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    return {
      jobId: "setup-stream",
      harness,
      action: "login",
      state,
      phase: "verifying",
      command: `${harness} login`,
      guideUrl: null,
      message: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      finishedAt: null,
      profileId: null,
      authCapability:
        state === "interrupted_unknown"
          ? {
              ...binding,
              state: "interrupted_unknown",
              startedAt: "2026-01-01T00:00:01.000Z",
              interruptedAt: "2026-01-01T00:00:02.000Z",
            }
          : { ...binding, state: "running", startedAt: "2026-01-01T00:00:01.000Z" },
      ...overrides,
    };
  };

  const setupEventFixture = (
    job: ControlSetupJob,
    cursor: string,
    previousCursor: string | null,
    sequence: number,
  ) => ({
    jobId: job.jobId,
    cursor,
    previousCursor,
    sequence,
    time: "2026-01-01T00:00:02.000Z",
    kind: "status" as const,
    state: job.state,
    message: job.message,
    job,
  });

  function fakeDaemon(): {
    daemon: DaemonFacadeClient;
    record: DaemonRunRecord;
    cancelled: string[];
  } {
    const runDir = reapMk(join(tmpdir(), "claudexor-control-run-"));
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
      [
        "schema_version: 2",
        "task_id: task-d1",
        "created_at: 2026-07-15T00:00:00.000Z",
        "repo:",
        `  root: ${JSON.stringify(runDir)}`,
        "  base_ref: HEAD",
        "mode:",
        "  kind: agent",
        "user_intent:",
        "  raw: test run",
        "tests:",
        "  commands: []",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(runDir, "arbitration", "decision.yaml"),
      "winner: a01\nfacts:\n  lifecycle: succeeded\n  review: approved\n  checks: passed\n  noChanges: false\n  reason: null\nverification_basis: both\nfinal_verify:\n  attempted: true\n  applied_cleanly: true\n  gates_passed: true\n",
    );
    writeFileSync(
      join(runDir, "final", "telemetry.yaml"),
      [
        "schema_version: 2",
        "run_id: run-d1",
        "task_id: task-d1",
        "mode: agent",
        "requested_access: external_sandbox_full",
        "effective_access: external_sandbox_full",
        "external_context_policy: auto",
        "effective_web_mode: auto",
        "web_required: false",
        "web:",
        "  required: false",
        "  policy: auto",
        "  effective_mode: auto",
        "  attempted: false",
        "  satisfied: false",
        "  status: none",
        "  tool: null",
        "  target: null",
        "  error_summary: null",
        "attempts: []",
        "request_requirements:",
        "  - capability: browser",
        "    harness_id: codex",
        "    eligible: true",
        "    requested: true",
        "    effective: true",
        "    reason: effective",
        "    evidence_refs:",
        "      - manifest:codex:browser_tool",
        "tool_warnings_total: 0",
        "generated_at: 2026-07-15T00:00:00.000Z",
        "",
      ].join("\n"),
    );
    mkdirSync(join(runDir, "attempts", "a01"), { recursive: true });
    mkdirSync(join(runDir, "attempts", "a02"), { recursive: true });
    writeFileSync(
      join(runDir, "attempts", "a01", "attempt.yaml"),
      [
        "attempt_id: a01",
        "harness_id: claude",
        "label: A",
        "cost_usd: 0.42",
        "cost_estimated: false",
        "errored: false",
        "gates:",
        "  - id: g1",
        "    status: passed",
        "  - id: g2",
        "    status: passed",
        "diffstat:",
        "  files: 3",
        "  additions: 25",
        "  deletions: 4",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(runDir, "reviews", "a02.yaml"),
      [
        "review_verified: false",
        "final_review_clean: false",
        "findings:",
        "  - id: f-block",
        "    severity: BLOCK",
        "    status: accepted",
        "    category: correctness",
        "    claim: broken thing",
        "    evidence:",
        "      files:",
        "        - path: src/app.ts",
        "          lines: '1'",
        "    reviewer:",
        "      harness_id: codex",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(runDir, "attempts", "a02", "attempt.yaml"),
      [
        "attempt_id: a02",
        "harness_id: codex",
        "label: B",
        "cost_usd: 0.1",
        "cost_estimated: true",
        "errored: true",
        "errors:",
        "  - spawn E2BIG",
        "gates:",
        "  - id: g1",
        "    status: failed",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(runDir, "reviews", "a01.yaml"),
      [
        "review_verified: true",
        "final_review_clean: true",
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
        routingGoal: "auto",
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

  it("does not leave an HTTP listener when shutdown races startup", async () => {
    const { daemon } = fakeDaemon();
    const server = new DaemonControlApiServer({ ...readyIdentity, token, daemon });
    const starting = server.start();
    const stopping = server.stop();
    await stopping;
    await expect(starting).rejects.toMatchObject({ code: "daemon_stopping" });
    await expect(server.start()).rejects.toMatchObject({ code: "daemon_stopping" });
  });

  it("serves a simple loopback health probe", async () => {
    const { daemon } = fakeDaemon();
    const server = new DaemonControlApiServer({ token, daemon });
    const { host, port } = await server.start();
    const base = `http://${host}:${port}`;
    try {
      const healthy = await apiFetch(`${base}/healthz`);
      expect(healthy.status).toBe(200);
      expect(await healthy.json()).toEqual({ ok: true });
    } finally {
      await server.stop();
    }
  });

  it("requires v2 negotiation and serves the truthful operation catalog", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      const legacy = await globalThis.fetch(`${base}/runs`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(legacy.status).toBe(404);

      const incompatible = await globalThis.fetch(`${base}/v2/handshake`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ protocolMajor: 1, client: "test" }),
      });
      expect(incompatible.status).toBe(426);
      expect(await incompatible.json()).toMatchObject({ code: "incompatible_protocol_major" });

      const handshake = await apiFetch(`${base}/v2/handshake`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ protocolMajor: 3, client: "test" }),
      });
      expect(handshake.status).toBe(200);
      expect(await handshake.json()).toMatchObject({
        protocolMajor: 3,
        compatible: true,
        operationsPath: "/v2/operations",
        engine: { version: expect.any(String), sha: expect.any(String), entry: expect.any(String) },
      });

      const missingMajor = await globalThis.fetch(`${base}/v2/operations`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(missingMajor.status).toBe(426);
      expect(await missingMajor.json()).toMatchObject({ code: "handshake_required" });

      const catalog = await apiFetch(`${base}/v2/operations`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(catalog.status).toBe(200);
      const body = (await catalog.json()) as {
        protocolMajor: number;
        operations: {
          id: string;
          path: string;
          responseKind: string;
          responseSchema: string | null;
          errorSchema: string;
        }[];
      };
      expect(body.protocolMajor).toBe(3);
      expect(body.operations.every((operation) => operation.path.startsWith("/v2/"))).toBe(true);
      expect(new Set(body.operations.map((operation) => operation.id)).size).toBe(
        body.operations.length,
      );
      expect(
        body.operations.filter(
          (operation) => operation.responseKind === "json" && operation.responseSchema === null,
        ),
      ).toEqual([]);
      expect(body.operations.every((operation) => operation.errorSchema === "ControlProblem")).toBe(
        true,
      );
      expect(body.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/v2/runs" }),
          expect.objectContaining({ path: "/v2/setup/jobs" }),
        ]),
      );

      // QA-054: the catalog emits `project` applicability for project-family
      // routes (previously every project route falsely reported `global`).
      const ops = body.operations as unknown as {
        method: string;
        path: string;
        applicability: string;
        idempotency: string;
        parameters: { name: string; location: string; required: boolean; enum: string[] | null }[];
      }[];
      const projectApplicable = ops.filter((o) => o.applicability === "project");
      expect(projectApplicable.length).toBeGreaterThanOrEqual(6);
      expect(
        ops.find((o) => o.method === "POST" && o.path === "/v2/projects/:id/relink")?.applicability,
      ).toBe("project");
      expect(ops.find((o) => o.method === "GET" && o.path === "/v2/projects")?.applicability).toBe(
        "project",
      );
      // Run/thread families keep their planes.
      expect(ops.find((o) => o.path === "/v2/runs/:id/events")?.applicability).toBe("run");

      // QA-055: located query/header parameter metadata on the descriptors.
      const harnesses = ops.find((o) => o.method === "GET" && o.path === "/v2/harnesses");
      expect(harnesses?.parameters.map((p) => p.name)).toEqual(["fresh", "all", "harness"]);
      expect(harnesses?.parameters.every((p) => p.location === "query")).toBe(true);
      const models = ops.find((o) => o.path === "/v2/harnesses/:id/models");
      expect(models?.parameters[0]).toMatchObject({
        name: "route",
        location: "query",
        enum: ["local_session", "api_key"],
      });
      const runEvents = ops.find((o) => o.path === "/v2/runs/:id/events");
      expect(runEvents?.parameters.map((p) => `${p.name}:${p.location}`)).toEqual([
        "Last-Event-ID:header",
        "lastEventId:query",
      ]);
      // QA-075: extend is honestly key_required, not natural.
      expect(ops.find((o) => o.path === "/v2/setup/jobs/:id/extend")?.idempotency).toBe(
        "key_required",
      );

      const missingIdempotencyKey = await globalThis.fetch(`${base}/v2/runs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "X-Claudexor-Protocol-Major": "3",
        },
        body: startAgentBody(),
      });
      expect(missingIdempotencyKey.status).toBe(400);
      expect(await missingIdempotencyKey.json()).toMatchObject({
        code: "idempotency_key_required",
        fieldErrors: { "Idempotency-Key": ["required for create operations"] },
      });
    });
  });

  it("projects request-validation errors as typed fieldErrors, not a Zod dump (QA-053)", async () => {
    const { daemon } = fakeDaemon();
    let createCalls = 0;
    await withDaemonServer(
      daemon,
      async (base) => {
        const res = await apiFetch(`${base}/threads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ workspace: { mode: "in_place" } }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/problem+json");
        const body = (await res.json()) as {
          code: string;
          message: string;
          fieldErrors: Record<string, string[]>;
          context: { issueCount: number; omittedIssueCount: number };
        };
        expect(body.code).toBe("invalid_request");
        // Single-line human summary, NOT the multiline Zod issue array.
        expect(body.message).toBe("Request validation failed for 1 field.");
        expect(body.message).not.toContain("\n");
        expect(body.message).not.toContain("invalid_type");
        expect(Object.keys(body.fieldErrors)).toContain("/workspace");
        expect(body.context).toMatchObject({ issueCount: 1, omittedIssueCount: 0 });
        // Validation precedes the mutation: the service is never called.
        expect(createCalls).toBe(0);
      },
      undefined,
      {
        createThread: async () => {
          createCalls += 1;
          return {};
        },
      },
    );
  });

  it("rejects invalid UTF-8 request bytes with a typed 400 before parsing (QA-056)", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      const prefix = Buffer.from('{"protocolMajor":3,"client":"', "utf8");
      const bad = Buffer.from([0xff]);
      const suffix = Buffer.from('"}', "utf8");
      const res = await globalThis.fetch(`${base}/v2/handshake`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: new Uint8Array(Buffer.concat([prefix, bad, suffix])),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; compatible?: boolean };
      expect(body.code).toBe("invalid_encoding");
      expect(body.compatible).toBeUndefined();
    });
  });

  it("classifies malformed percent-encoded paths as 400, not 500 (QA-066)", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      for (const p of [
        "/v2/runs/%ZZ/artifacts",
        "/v2/projects/%C0%AF/outputs",
        "/v2/setup/jobs/%ZZ",
        "/v2/threads/%ZZ",
      ]) {
        const res = await globalThis.fetch(`${base}${p}`, {
          headers: { authorization: `Bearer ${token}`, "X-Claudexor-Protocol-Major": "3" },
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe("malformed_request_path");
      }
      // A validly-encoded literal percent still routes (then 404s as unknown id).
      const ok = await globalThis.fetch(`${base}/v2/runs/%2542/artifacts`, {
        headers: { authorization: `Bearer ${token}`, "X-Claudexor-Protocol-Major": "3" },
      });
      expect(ok.status).not.toBe(500);
      expect(ok.status).not.toBe(400);
    });
  });

  it("rejects malformed run SSE cursors before opening the stream (QA-061)", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      for (const cursor of ["abc", "-1", "1.5", "0x1f", "3.1e1"]) {
        const res = await globalThis.fetch(`${base}/v2/runs/run-any/events`, {
          headers: {
            authorization: `Bearer ${token}`,
            "X-Claudexor-Protocol-Major": "3",
            "Last-Event-ID": cursor,
          },
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/problem+json");
        expect(((await res.json()) as { code: string }).code).toBe("invalid_run_event_cursor");
      }
      // A malformed query alias is an error too (no silent fallback to replay).
      const aliasBad = await globalThis.fetch(`${base}/v2/runs/run-any/events?lastEventId=abc`, {
        headers: { authorization: `Bearer ${token}`, "X-Claudexor-Protocol-Major": "3" },
      });
      expect(aliasBad.status).toBe(400);
      // An unknown query parameter is rejected.
      const unknownQuery = await globalThis.fetch(`${base}/v2/runs/run-any/events?bogus=1`, {
        headers: { authorization: `Bearer ${token}`, "X-Claudexor-Protocol-Major": "3" },
      });
      expect(unknownQuery.status).toBe(400);
    });
  });

  it("refuses a mutation delivered on a preconnected socket after stop is marked", async () => {
    const { daemon } = fakeDaemon();
    let enqueueCalls = 0;
    const server = new DaemonControlApiServer({
      ...readyIdentity,
      token,
      daemon: {
        ...daemon,
        enqueue: async (params) => {
          enqueueCalls += 1;
          return daemon.enqueue(params);
        },
      },
    });
    const { host, port } = await server.start();
    const socket = connect({ host, port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    let responseText = "";
    const response = new Promise<string>((resolve, reject) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        responseText += chunk;
      });
      socket.once("end", () => resolve(responseText));
      socket.once("error", reject);
      socket.setTimeout(5_000, () => socket.destroy(new Error("raw HTTP response timed out")));
    });
    const body = startAgentBody();
    await new Promise<void>((resolve, reject) => {
      socket.write(`POST /runs HTTP/1.1\r\nHost: ${host}:${port}\r\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    // Let the server observe an incomplete request on this connection. No
    // request handler exists yet because the terminating header line is absent.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stopping = server.stop();
    expect(server.stop()).toBe(stopping);
    try {
      socket.write(
        `Authorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      const raw = await response;
      expect(raw).toMatch(/^HTTP\/1\.1 503 /);
      expect(raw.toLowerCase()).toContain("content-type: application/problem+json");
      const separator = raw.indexOf("\r\n\r\n");
      expect(separator).toBeGreaterThan(0);
      expect(JSON.parse(raw.slice(separator + 4))).toMatchObject({
        code: "daemon_stopping",
        retryable: true,
      });
      expect(enqueueCalls).toBe(0);
    } finally {
      socket.destroy();
      await stopping;
    }
  });

  it("waits for a disconnected client's pending handler before stop resolves", async () => {
    const { daemon } = fakeDaemon();
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let releaseService!: () => void;
    const serviceResult = new Promise<unknown>((resolve) => {
      releaseService = () => resolve({ ok: true });
    });
    const server = new DaemonControlApiServer({
      ...readyIdentity,
      token,
      daemon,
      services: {
        updateSettings: async () => {
          markEntered();
          return serviceResult;
        },
      },
    });
    const { host, port } = await server.start();
    const controller = new AbortController();
    const request = apiFetch(`http://${host}:${port}/settings`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ paidBudgetPerRun: { kind: "unlimited" } }),
      signal: controller.signal,
    }).then(
      () => "responded",
      () => "disconnected",
    );
    await entered;
    controller.abort();
    expect(await request).toBe("disconnected");

    const stopping = server.stop();
    try {
      const early = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      expect(early).toBe("pending");
    } finally {
      releaseService();
      await stopping;
    }
  });

  async function withDaemonServer(
    daemon: DaemonFacadeClient,
    fn: (base: string) => Promise<void>,
    runStartTimeoutMs?: number,
    services?: DaemonControlApiOptions["services"],
    bus?: DaemonControlApiOptions["bus"],
  ): Promise<void> {
    const operatorDecisions = new Map<string, ControlOperatorDecisionRecord>();
    const server = new DaemonControlApiServer({
      ...readyIdentity,
      token,
      daemon,
      pollMs: 5,
      runStartTimeoutMs,
      services: {
        operatorDecision: (runId) => operatorDecisions.get(runId) ?? null,
        recordOperatorDecision: (runId, _params, decision) => {
          operatorDecisions.set(runId, decision);
          return decision;
        },
        ...services,
      },
      bus,
    });
    const { host, port } = await server.start();
    try {
      await fn(`http://${host}:${port}`);
    } finally {
      await server.stop();
    }
  }

  it("runs: preserves a typed pre-start refusal's code and status", async () => {
    const typedFail: DaemonFacadeClient = {
      async enqueue() {
        return { id: "job-schema", state: "queued" };
      },
      async status() {
        return {
          id: "job-schema",
          state: "failed",
          error: "unsupported outputSchema dialect",
          errorCode: "unsupported_schema_dialect",
          errorStatus: 400,
        };
      },
      async list() {
        return [];
      },
      async cancel() {
        return { ok: true };
      },
    };

    await withDaemonServer(typedFail, async (base) => {
      const response = await apiFetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: startAgentBody(),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "unsupported_schema_dialect",
        message: "unsupported outputSchema dialect",
        retryable: false,
        context: { jobId: "job-schema", state: "failed" },
      });
    });
  });

  it("runs: a terminal refusal with an out-of-range errorStatus still fails as 500", async () => {
    const defectiveWriter: DaemonFacadeClient = {
      async enqueue() {
        return { id: "job-bad-status", state: "queued" };
      },
      async status() {
        return {
          id: "job-bad-status",
          state: "failed",
          error: "refused before start",
          errorCode: "unsupported_schema_dialect",
          errorStatus: 200,
        };
      },
      async list() {
        return [];
      },
      async cancel() {
        return { ok: true };
      },
    };

    await withDaemonServer(defectiveWriter, async (base) => {
      const response = await apiFetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: startAgentBody(),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        code: "unsupported_schema_dialect",
        retryable: false,
      });
    });
  });

  it("unboundRunStartResponse: an untyped terminal makes no retryability claim of its own", () => {
    // The wire-level retryable default belongs to the ControlProblem
    // projection (#28 owns that contract); the run-start body itself must
    // only assert non-retryability for TYPED refusals it can prove.
    const untyped = unboundRunStartResponse({ id: "job-cancelled", state: "cancelled" }, true);
    expect(untyped.status).toBe(500);
    expect(untyped.body).not.toHaveProperty("retryable");
    expect(untyped.body).not.toHaveProperty("code");

    const typed = unboundRunStartResponse(
      {
        id: "job-schema",
        state: "failed",
        error: "refused",
        errorCode: "invalid_output_schema",
        errorStatus: 400,
      },
      true,
    );
    expect(typed.status).toBe(400);
    expect(typed.body).toMatchObject({ code: "invalid_output_schema", retryable: false });
  });

  it("producedRepoRoot uses the typed scope and NEVER resolves a no-project run to the home dir", () => {
    expect(
      producedRepoRoot({
        id: "j",
        state: "succeeded",
        params: { scope: { kind: "project", root: "/Users/x/proj" } },
      }),
    ).toBe("/Users/x/proj");
    // The CRITICAL fix: a no-project run's runDir is ~/.claudexor/v2/runs/<id>; path-
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
        await apiFetch(`${base}/runs/run-d1/produced`, {
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
      const png = await apiFetch(`${base}/runs/run-d1/produced/preview.png`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(png.status).toBe(200);
      expect(png.headers.get("content-type")).toBe("image/png");
      // Traversal out of <repoRoot>/artifacts is rejected by safeArtifactPath.
      const esc = await apiFetch(`${base}/runs/run-d1/produced/..%2f..%2fcontext%2ftask.yaml`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(esc.status).toBe(404);
    });
  });

  // QA-038: an isolated-thread run's produced outputs live in its persistent
  // per-thread worktree (the tree it actually mutated), NOT the mutable live
  // project. The live project stays untouched until an explicit thread apply, so
  // reading it attributes pre-existing/future project files to the run and 404s
  // the file the run created.
  it("resolveProducedRoot redirects an isolated run to its worktree, never the live project", async () => {
    const liveRoot = "/Users/x/proj";
    const worktree = "/tmp/does-not-exist-worktree-marker";
    const rec = {
      id: "j",
      state: "succeeded",
      params: { scope: { kind: "project", root: liveRoot }, threadId: "th-iso" },
    };
    // in_place thread OR non-thread run stays on the live project root.
    expect(
      await resolveProducedRoot(rec, async () => ({ mode: "in_place", worktreePath: null })),
    ).toEqual({ kind: "root", root: liveRoot });
    expect(await resolveProducedRoot(rec)).toEqual({ kind: "root", root: liveRoot });
    // Isolated with a live worktree dir → that worktree, not the project.
    expect(
      await resolveProducedRoot(rec, async () => ({ mode: "isolated", worktreePath: tmpdir() })),
    ).toEqual({ kind: "root", root: tmpdir() });
    // Isolated but the worktree was purged (worktree_path nulled) → typed answer.
    expect(
      await resolveProducedRoot(rec, async () => ({ mode: "isolated", worktreePath: null })),
    ).toEqual({
      kind: "worktree_unavailable",
      threadId: "th-iso",
      reason: "worktree_not_retained",
    });
    // Isolated but the worktree directory is gone from disk → typed answer.
    expect(
      await resolveProducedRoot(rec, async () => ({ mode: "isolated", worktreePath: worktree })),
    ).toEqual({ kind: "worktree_unavailable", threadId: "th-iso", reason: "worktree_missing" });
    // No-project fence still holds even when a thread resolver is present.
    expect(
      await resolveProducedRoot(
        { id: "j", state: "succeeded", params: { scope: { kind: "none" }, threadId: "th-iso" } },
        async () => ({ mode: "isolated", worktreePath: tmpdir() }),
      ),
    ).toEqual({ kind: "no_project" });
  });

  // QA-038 store-error edge: a run bound to a thread whose workspace lookup
  // FAILS must NOT fail open back to the live project — that re-attributes the
  // live project's files to an isolated run. It answers typed authority-
  // unavailable (503) instead.
  it("resolveProducedRoot fails CLOSED when the thread workspace lookup throws", async () => {
    const liveRoot = "/Users/x/proj";
    const rec = {
      id: "j",
      state: "succeeded",
      params: { scope: { kind: "project", root: liveRoot }, threadId: "th-iso" },
    };
    expect(
      await resolveProducedRoot(rec, async () => {
        throw new Error("thread store unavailable");
      }),
    ).toEqual({
      kind: "worktree_unavailable",
      threadId: "th-iso",
      reason: "authority_unavailable",
    });
    // A non-thread run with a throwing resolver is unaffected (no threadId ⇒ the
    // resolver is never consulted): the live root is still correct.
    const oneShot = {
      id: "j2",
      state: "succeeded",
      params: { scope: { kind: "project", root: liveRoot } },
    };
    expect(
      await resolveProducedRoot(oneShot, async () => {
        throw new Error("should not be called");
      }),
    ).toEqual({ kind: "root", root: liveRoot });
  });

  it("GET /runs/:id/produced for an isolated run serves the worktree and hides live-project files", async () => {
    const { daemon, record } = fakeDaemon();
    const liveRoot = reapMk(join(tmpdir(), "claudexor-iso-live-"));
    const worktree = reapMk(join(tmpdir(), "claudexor-iso-tree-"));
    // The live project holds an UNRELATED older artifact; the run must not claim it.
    mkdirSync(join(liveRoot, "artifacts"), { recursive: true });
    writeFileSync(join(liveRoot, "artifacts", "live-old.md"), "# live project, another run\n");
    // The isolated worktree holds the file THIS run actually created.
    mkdirSync(join(worktree, "artifacts"), { recursive: true });
    writeFileSync(join(worktree, "artifacts", "thread-isolated-note.md"), "ISOLATED_THREAD_OK\n");
    record.params = {
      mode: "agent",
      scope: { kind: "project", root: liveRoot },
      threadId: "th-iso",
    };
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async (id: string) => ({
        thread: { id, workspace: { mode: "isolated", worktree_path: worktree } },
        sessions: [],
        turns: [],
      }),
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        const list = (await (
          await apiFetch(`${base}/runs/run-d1/produced`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).json()) as { artifacts: { path: string }[] };
        expect(list.artifacts.some((a) => a.path === "thread-isolated-note.md")).toBe(true);
        expect(list.artifacts.some((a) => a.path === "live-old.md")).toBe(false);
        // The created file is fetchable through the run id.
        const created = await apiFetch(`${base}/runs/run-d1/produced/thread-isolated-note.md`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(created.status).toBe(200);
        expect(await created.text()).toContain("ISOLATED_THREAD_OK");
        // A live-project file this run never produced is 404, not silently served.
        const live = await apiFetch(`${base}/runs/run-d1/produced/live-old.md`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(live.status).toBe(404);
      },
      undefined,
      services,
    );
  });

  it("GET /runs/:id/produced for an isolated run whose worktree was purged answers a typed 410", async () => {
    const { daemon, record } = fakeDaemon();
    const liveRoot = reapMk(join(tmpdir(), "claudexor-iso-purged-"));
    mkdirSync(join(liveRoot, "artifacts"), { recursive: true });
    writeFileSync(join(liveRoot, "artifacts", "live-old.md"), "# unrelated live file\n");
    record.params = {
      mode: "agent",
      scope: { kind: "project", root: liveRoot },
      threadId: "th-gone",
    };
    // Purge nulls the thread's worktree_path (the record survives for diagnosis).
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async (id: string) => ({
        thread: { id, workspace: { mode: "isolated", worktree_path: null } },
        sessions: [],
        turns: [],
      }),
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        const list = await apiFetch(`${base}/runs/run-d1/produced`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(list.status).toBe(410);
        // The typed answer flows through the standard ControlProblem envelope:
        // code + human message, with the machine reason/thread in context.
        expect(await list.json()).toMatchObject({
          code: "isolated_worktree_unavailable",
          context: { reason: "worktree_not_retained", thread_id: "th-gone" },
        });
        // Fetch must ALSO refuse — never fall back to the live project directory.
        const fetch = await apiFetch(`${base}/runs/run-d1/produced/live-old.md`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(fetch.status).toBe(410);
      },
      undefined,
      services,
    );
  });

  it("GET /runs/:id/produced for an IN-PLACE thread run keeps the live project root", async () => {
    const { daemon, record } = fakeDaemon();
    const liveRoot = reapMk(join(tmpdir(), "claudexor-inplace-live-"));
    mkdirSync(join(liveRoot, "artifacts"), { recursive: true });
    writeFileSync(join(liveRoot, "artifacts", "in-place.md"), "# in-place output\n");
    record.params = {
      mode: "agent",
      scope: { kind: "project", root: liveRoot },
      threadId: "th-live",
    };
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async (id: string) => ({
        thread: { id, workspace: { mode: "in_place", worktree_path: null } },
        sessions: [],
        turns: [],
      }),
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        const list = (await (
          await apiFetch(`${base}/runs/run-d1/produced`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).json()) as { artifacts: { path: string }[] };
        expect(list.artifacts.some((a) => a.path === "in-place.md")).toBe(true);
      },
      undefined,
      services,
    );
  });

  it("GET /projects/:id/outputs lists the project's durable outputs, serves files, and blocks traversal", async () => {
    const { daemon } = fakeDaemon();
    const projectRoot = reapMk(join(tmpdir(), "claudexor-project-outputs-"));
    mkdirSync(join(projectRoot, "artifacts", "reports"), { recursive: true });
    writeFileSync(join(projectRoot, "artifacts", "reports", "summary.md"), "# durable output\n");
    writeFileSync(
      join(projectRoot, "artifacts", "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    // A secret the project root holds OUTSIDE artifacts/ — traversal must never reach it.
    writeFileSync(join(projectRoot, "secret.txt"), "TOP SECRET\n");
    const now = new Date().toISOString();
    const services: DaemonControlApiOptions["services"] = {
      listProjects: async () => ({
        projects: [
          { schema_version: 2, id: "prj-out", root: projectRoot, created_at: now, updated_at: now },
        ],
      }),
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        const list = (await (
          await apiFetch(`${base}/projects/prj-out/outputs`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).json()) as { projectId: string; artifacts: { path: string; mime?: string }[] };
        expect(list.projectId).toBe("prj-out");
        expect(list.artifacts.some((a) => a.path === "logo.png" && a.mime === "image/png")).toBe(
          true,
        );
        expect(list.artifacts.some((a) => a.path === "reports/summary.md")).toBe(true);
        // The secret above the artifacts/ dir must NOT be listed.
        expect(list.artifacts.some((a) => a.path.includes("secret.txt"))).toBe(false);

        const png = await apiFetch(`${base}/projects/prj-out/outputs/logo.png`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(png.status).toBe(200);
        expect(png.headers.get("content-type")).toBe("image/png");

        // Nested path fetch resolves inside artifacts/.
        const md = await apiFetch(`${base}/projects/prj-out/outputs/reports/summary.md`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(md.status).toBe(200);
        expect(await md.text()).toContain("durable output");

        // Traversal out of <projectRoot>/artifacts is refused by safeArtifactPath.
        for (const escape of [
          "..%2f..%2fsecret.txt",
          "..%2fsecret.txt",
          "%2fetc%2fpasswd", // absolute
        ]) {
          const esc = await apiFetch(`${base}/projects/prj-out/outputs/${escape}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(esc.status).toBe(404);
        }

        // An unknown project id is a clean 404, never a 500 or a home-dir leak.
        const unknown = await apiFetch(`${base}/projects/nope/outputs`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(unknown.status).toBe(404);
      },
      undefined,
      services,
    );
  });

  it("GET /projects/:id/outputs blocks a symlink that escapes the artifacts dir", async () => {
    const { daemon } = fakeDaemon();
    const projectRoot = reapMk(join(tmpdir(), "claudexor-project-symlink-"));
    mkdirSync(join(projectRoot, "artifacts"), { recursive: true });
    const secretDir = reapMk(join(tmpdir(), "claudexor-project-secret-"));
    writeFileSync(join(secretDir, "creds"), "SECRET\n");
    // A symlink inside artifacts/ pointing OUT of the project must not be served.
    symlinkSync(secretDir, join(projectRoot, "artifacts", "escape"));
    const now = new Date().toISOString();
    const services: DaemonControlApiOptions["services"] = {
      listProjects: async () => ({
        projects: [
          { schema_version: 2, id: "prj-sym", root: projectRoot, created_at: now, updated_at: now },
        ],
      }),
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        // The symlink is skipped in the listing (listArtifacts drops symlinks).
        const list = (await (
          await apiFetch(`${base}/projects/prj-sym/outputs`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).json()) as { artifacts: { path: string }[] };
        expect(list.artifacts.some((a) => a.path.startsWith("escape"))).toBe(false);
        // Fetching through the symlink is refused.
        const esc = await apiFetch(`${base}/projects/prj-sym/outputs/escape/creds`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(esc.status).toBe(404);
      },
      undefined,
      services,
    );
  });

  it("projects: registration requires idempotency, lists the durable handle, and relinks it", async () => {
    const { daemon } = fakeDaemon();
    const firstRoot = reapMk(join(tmpdir(), "claudexor-project-first-"));
    const secondRoot = reapMk(join(tmpdir(), "claudexor-project-second-"));
    const now = new Date().toISOString();
    const project = {
      schema_version: 2,
      id: "prj-1",
      root: firstRoot,
      created_at: now,
      updated_at: now,
    };
    let registration: unknown;
    const services: DaemonControlApiOptions["services"] = {
      listProjects: async () => ({ projects: [project] }),
      registerProject: async (input) => {
        registration = input;
        return project;
      },
      relinkProject: async (id, root) => ({ ...project, id, root, updated_at: now }),
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        const missingKey = await globalThis.fetch(`${base}/v2/projects`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "X-Claudexor-Protocol-Major": "3",
          },
          body: JSON.stringify({ root: firstRoot }),
        });
        expect(missingKey.status).toBe(400);
        expect(await missingKey.json()).toMatchObject({ code: "idempotency_key_required" });

        const registered = await apiFetch(`${base}/projects`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ root: firstRoot }),
        });
        expect(registered.status).toBe(200);
        expect(await registered.json()).toMatchObject({ id: "prj-1", root: firstRoot });
        expect(registration).toMatchObject({ root: firstRoot, clientId: "control-api" });

        const listed = await apiFetch(`${base}/projects`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(await listed.json()).toMatchObject({ projects: [{ id: "prj-1" }] });

        const relinked = await apiFetch(`${base}/projects/prj-1/relink`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ root: secondRoot }),
        });
        expect(relinked.status).toBe(200);
        expect(await relinked.json()).toMatchObject({ id: "prj-1", root: secondRoot });
      },
      undefined,
      services,
    );
  });

  it("threads: create -> list -> turn (enqueued with threadId + native resume anchors) -> detail", async () => {
    const { daemon, record } = fakeDaemon();
    const repo = reapMk(join(tmpdir(), "claudexor-thread-"));
    let enqueued: Record<string, unknown> | undefined;
    let enqueueOptions: Parameters<DaemonFacadeClient["enqueue"]>[1];
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
      routingGoal: "auto",
      run_ids: [],
      head_run_id: null,
      state: "active",
    };
    const turns: Record<string, unknown>[] = [];
    let turnIdempotency: unknown;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown, options) {
        enqueued = params as Record<string, unknown>;
        enqueueOptions = options;
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
      createThread: async (input) => {
        expect(input).toMatchObject({
          idempotency: { client: "control-api", request: { title: "test thread" } },
        });
        return threadObj;
      },
      listThreads: async () => ({ threads: [threadObj] }),
      threadDetail: async (id) => {
        expect(id).toBe("th-1");
        return { thread: threadObj, sessions: [], turns };
      },
      createThreadTurn: async (id, prompt, opts) => {
        turnIdempotency = opts.idempotency;
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
        const missingThreadKey = await globalThis.fetch(`${base}/v2/threads`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "X-Claudexor-Protocol-Major": "3",
          },
          body: JSON.stringify({ title: "test thread", scope: { kind: "project", root: repo } }),
        });
        expect(missingThreadKey.status).toBe(400);
        expect(await missingThreadKey.json()).toMatchObject({ code: "idempotency_key_required" });

        const missingKey = await globalThis.fetch(`${base}/v2/threads/th-1/turns`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "X-Claudexor-Protocol-Major": "3",
          },
          body: JSON.stringify({ prompt: "continue the plan" }),
        });
        expect(missingKey.status).toBe(400);
        expect(await missingKey.json()).toMatchObject({ code: "idempotency_key_required" });
        expect(turns).toHaveLength(0);

        const created = await apiFetch(`${base}/threads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ title: "test thread", scope: { kind: "project", root: repo } }),
        });
        expect(created.status).toBe(200);
        expect(((await created.json()) as { id: string }).id).toBe("th-1");

        const list = (await (
          await apiFetch(`${base}/threads`, { headers: { authorization: `Bearer ${token}` } })
        ).json()) as { threads: { id: string; needsHuman: boolean }[] };
        expect(list.threads[0]?.id).toBe("th-1");

        const turn = await apiFetch(`${base}/threads/th-1/turns`, {
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
        expect(turnIdempotency).toMatchObject({
          client: "control-api",
          request: { threadId: "th-1" },
        });
        expect(enqueueOptions).toMatchObject({
          operation: "thread.turn.create",
          clientId: "control-api",
          idempotencyRequest: { threadId: "th-1" },
        });

        const detail = (await (
          await apiFetch(`${base}/threads/th-1`, { headers: { authorization: `Bearer ${token}` } })
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

  it("POST /runs REFUSES a threadId (D10): a thread turn goes through /threads/:id/turns", async () => {
    const { daemon } = fakeDaemon();
    let enqueued = 0;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown, options) {
        enqueued += 1;
        return daemon.enqueue(params, options);
      },
    };
    // The turn pipeline (scope resolution + lineage + continuation packet) is
    // owned by POST /threads/:id/turns; a threadId smuggled onto POST /runs
    // would skip continuity entirely, so it is refused BEFORE any enqueue.
    await withDaemonServer(wrapped, async (base) => {
      const res = await apiFetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": "idem-d10" },
        body: JSON.stringify({
          prompt: "continue",
          mode: "ask",
          threadId: "th-x",
          scope: { kind: "none" },
        }),
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("/threads/:id/turns");
      expect(enqueued).toBe(0);
    });
  });

  it("threads: a refused enqueue persists the error on the turn; the detail projection renders enqueueError", async () => {
    const { daemon } = fakeDaemon();
    const repo = reapMk(join(tmpdir(), "claudexor-thread-refuse-"));
    const now = new Date().toISOString();
    const threadObj: Record<string, unknown> = {
      schema_version: 2,
      id: "th-r",
      created_at: now,
      updated_at: now,
      repo: { root: repo, base_ref: "HEAD" },
      title: "refusal thread",
      mode: "agent",
      workspace: { mode: "in_place", worktree_path: null, base_sha: null },
      auth_preference: "auto",
      primary_harness: null,
      routingGoal: "auto",
      run_ids: [],
      head_run_id: null,
      state: "active",
    };
    const turns: Record<string, unknown>[] = [];
    const refusing: DaemonFacadeClient = {
      ...daemon,
      async enqueue() {
        throw new Error("daemon socket is gone");
      },
    };
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async () => ({ thread: threadObj, sessions: [], turns }),
      createThreadTurn: async (id, prompt, opts) => {
        const turn = {
          id: "tn-refused",
          thread_id: id,
          run_id: null,
          parent_run_id: opts.parentRunId ?? null,
          plan_run_id: opts.planRunId ?? null,
          kind: "initial",
          prompt,
          created_at: now,
        };
        turns.push(turn);
        return turn;
      },
      // The daemon ThreadStore contract: persist the refusal on the turn.
      setTurnEnqueueError: (turnId, message, code, retryable) => {
        const turn = turns.find((t) => t["id"] === turnId);
        if (turn && !turn["run_id"])
          turn["enqueue_error"] = { message, code, retryable: retryable ?? true, failed_at: now };
      },
    };
    await withDaemonServer(
      refusing,
      async (base) => {
        const res = await apiFetch(`${base}/threads/th-r/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: "do work" }),
        });
        // Untyped enqueue throws are INFRA failures — 500 (matching POST /runs).
        expect(res.status).toBe(500);
        const body = (await res.json()) as {
          message: string;
          context: { turnId?: string };
          retryable?: boolean;
        };
        // The error response names the recorded turn (no silent orphan) and
        // discloses that retry has nothing to replay (no job was recorded).
        expect(body.context.turnId).toBe("tn-refused");
        expect(body.retryable).toBe(false);
        expect(body.message).toContain("daemon socket is gone");
        // The projection renders the refusal so a reloading client sees it.
        const detail = (await (
          await apiFetch(`${base}/threads/th-r`, { headers: { authorization: `Bearer ${token}` } })
        ).json()) as {
          turns: {
            id: string;
            enqueueError: {
              message: string;
              code: string | null;
              retryable: boolean;
              failedAt: string;
            } | null;
          }[];
        };
        expect(detail.turns[0]?.enqueueError?.message).toContain("daemon socket is gone");
        expect(detail.turns[0]?.enqueueError?.code).toBeNull(); // untyped throw
        expect(detail.turns[0]?.enqueueError?.retryable).toBe(false); // nothing to replay
        expect(detail.turns[0]?.enqueueError?.failedAt).toBeTruthy();
      },
      undefined,
      services,
    );
  });

  it("threads: a turn whose job goes TERMINAL before a run binds is a 500 pre-start failure, never an accepted queued turn", async () => {
    const repo = reapMk(join(tmpdir(), "claudexor-thread-terminal-"));
    const now = new Date().toISOString();
    const threadObj: Record<string, unknown> = {
      schema_version: 2,
      id: "th-t",
      created_at: now,
      updated_at: now,
      repo: { root: repo, base_ref: "HEAD" },
      title: "terminal thread",
      mode: "agent",
      workspace: { mode: "in_place", worktree_path: null, base_sha: null },
      auth_preference: "auto",
      primary_harness: null,
      routingGoal: "auto",
      run_ids: [],
      head_run_id: null,
      state: "active",
    };
    const turns: Record<string, unknown>[] = [];
    // The daemon accepts the job, then the runner refuses PRE-run (trust
    // gate): the job settles `failed` with an error and NO runId/runDir.
    const failFast: DaemonFacadeClient = {
      async enqueue(params: unknown) {
        void params;
        return { id: "job-t", state: "queued" };
      },
      async status() {
        return {
          id: "job-t",
          state: "failed",
          error: "access profile 'full' requires allow_full_access: true",
        };
      },
      async list() {
        return [
          {
            id: "job-t",
            state: "failed",
            error: "access profile 'full' requires allow_full_access: true",
          },
        ];
      },
      async cancel() {
        return { ok: true };
      },
    };
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async () => ({ thread: threadObj, sessions: [], turns }),
      createThreadTurn: async (id, prompt) => {
        const turn = { id: "tn-t", thread_id: id, run_id: null, prompt, created_at: now };
        turns.push(turn);
        return turn;
      },
    };
    await withDaemonServer(
      failFast,
      async (base) => {
        const res = await apiFetch(`${base}/threads/th-t/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: "risky work" }),
        });
        // Mirrors POST /runs' terminal handling: a pre-start failure is 500
        // (the daemon hook persists the refusal on the turn), NOT a 202 that
        // the client would render as an accepted queued turn.
        expect(res.status).toBe(500);
        const body = (await res.json()) as {
          message: string;
          context: { turnId: string; state: string };
        };
        expect(body.context.turnId).toBe("tn-t");
        expect(body.context.state).toBe("failed");
        expect(body.message).toContain("allow_full_access");
      },
      undefined,
      services,
    );
  });

  it("threads: a typed pre-start refusal (trust) is a 4xx with the code, not a retryable 500 (W24)", async () => {
    const repo = reapMk(join(tmpdir(), "claudexor-thread-typed-"));
    const now = new Date().toISOString();
    const threadObj: Record<string, unknown> = {
      schema_version: 2,
      id: "th-typed",
      created_at: now,
      updated_at: now,
      repo: { root: repo, base_ref: "HEAD" },
      title: "typed refusal thread",
      mode: "agent",
      workspace: { mode: "in_place", worktree_path: null, base_sha: null },
      auth_preference: "auto",
      primary_harness: null,
      routingGoal: "auto",
      run_ids: [],
      head_run_id: null,
      state: "active",
    };
    const turns: Record<string, unknown>[] = [];
    // The run fails PRE-start with a TYPED code (the daemon captures the trust
    // gate's throw into JobRecord.errorCode).
    const typedFail: DaemonFacadeClient = {
      async enqueue() {
        return { id: "job-typed", state: "queued" };
      },
      async status() {
        return {
          id: "job-typed",
          state: "failed",
          error: "access profile 'full' requires allow_full_access: true",
          errorCode: "trust_full_access_required",
        };
      },
      async list() {
        return [{ id: "job-typed", state: "failed", errorCode: "trust_full_access_required" }];
      },
      async cancel() {
        return { ok: true };
      },
    };
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async () => ({ thread: threadObj, sessions: [], turns }),
      createThreadTurn: async (id, prompt) => {
        const turn = { id: "tn-typed", thread_id: id, run_id: null, prompt, created_at: now };
        turns.push(turn);
        return turn;
      },
    };
    await withDaemonServer(
      typedFail,
      async (base) => {
        const res = await apiFetch(`${base}/threads/th-typed/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: "risky work" }),
        });
        // trust_full_access_required needs a one-time grant → 403, NOT 500.
        expect(res.status).toBe(403);
        const raw = await res.text();
        // The typed code rides the response so the inline card keys its remedy
        // on the CODE (never substring-matching the human message).
        expect(raw).toContain("trust_full_access_required");
        expect(raw).toContain("tn-typed");
      },
      undefined,
      services,
    );
  });

  it("threads: refusal status is born at the throw — persisted errorStatus wins, a bare errno code stays 500 (W24)", async () => {
    const repo = reapMk(join(tmpdir(), "claudexor-thread-status-"));
    const now = new Date().toISOString();
    const threadObj: Record<string, unknown> = {
      schema_version: 2,
      id: "th-st",
      created_at: now,
      updated_at: now,
      repo: { root: repo, base_ref: "HEAD" },
      title: "status thread",
      mode: "agent",
      workspace: { mode: "in_place", worktree_path: null, base_sha: null },
      auth_preference: "auto",
      primary_harness: null,
      routingGoal: "auto",
      run_ids: [],
      head_run_id: null,
      state: "active",
    };
    const cases = [
      // A typed 503 (journal recovery) persisted from the throw is served
      // verbatim — retryable infra, never a client-actionable 400.
      { errorCode: "journal_recovery_required", errorStatus: 503, expected: 503 },
      // A bare errno-style code without a typed status proves nothing: infra 500.
      { errorCode: "ENOENT", errorStatus: undefined, expected: 500 },
    ];
    for (const { errorCode, errorStatus, expected } of cases) {
      const turns: Record<string, unknown>[] = [];
      const daemon: DaemonFacadeClient = {
        async enqueue() {
          return { id: "job-st", state: "queued" };
        },
        async status() {
          return {
            id: "job-st",
            state: "failed",
            error: "pre-start failure",
            errorCode,
            ...(errorStatus !== undefined ? { errorStatus } : {}),
          };
        },
        async list() {
          return [];
        },
        async cancel() {
          return { ok: true };
        },
      };
      const services: DaemonControlApiOptions["services"] = {
        threadDetail: async () => ({ thread: threadObj, sessions: [], turns }),
        createThreadTurn: async (id, prompt) => {
          const turn = { id: "tn-st", thread_id: id, run_id: null, prompt, created_at: now };
          turns.push(turn);
          return turn;
        },
      };
      await withDaemonServer(
        daemon,
        async (base) => {
          const res = await apiFetch(`${base}/threads/th-st/turns`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ prompt: "any work" }),
          });
          expect(res.status).toBe(expected);
        },
        undefined,
        services,
      );
    }
  });

  it("threads: a preflight refusal lands on the created turn, not raw JSON with no turn (W19)", async () => {
    const repo = reapMk(join(tmpdir(), "claudexor-thread-preflight-"));
    const now = new Date().toISOString();
    const threadObj: Record<string, unknown> = {
      schema_version: 2,
      id: "th-pf",
      created_at: now,
      updated_at: now,
      repo: { root: repo, base_ref: "HEAD" },
      title: "preflight thread",
      mode: "agent",
      workspace: { mode: "in_place", worktree_path: null, base_sha: null },
      auth_preference: "auto",
      primary_harness: null,
      routingGoal: "auto",
      run_ids: [],
      head_run_id: null,
      state: "active",
    };
    const turns: Record<string, unknown>[] = [];
    let enqueueCalled = false;
    const noEnqueue: DaemonFacadeClient = {
      async enqueue() {
        enqueueCalled = true;
        return { id: "job-x", state: "queued" };
      },
      // A preflight-refused turn never reaches the daemon: any lookup is a bug.
      async status() {
        throw new Error("status must not be called for a preflight-refused turn");
      },
      async list() {
        throw new Error("list must not be called for a preflight-refused turn");
      },
      async cancel() {
        throw new Error("cancel must not be called for a preflight-refused turn");
      },
    };
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async () => ({ thread: threadObj, sessions: [], turns }),
      createThreadTurn: async (id, prompt) => {
        const turn: Record<string, unknown> = {
          id: "tn-pf",
          thread_id: id,
          run_id: null,
          prompt,
          created_at: now,
        };
        turns.push(turn);
        return turn;
      },
      setTurnEnqueueError: (turnId, message, code) => {
        const turn = turns.find((t) => t["id"] === turnId);
        if (turn) turn["enqueue_error"] = { message, code, failed_at: now };
      },
      // Preflight refuses (e.g. a browser lane requirement) AFTER the turn exists.
      preflightRunRequirements: async () => {
        throw Object.assign(new Error("browser was requested but no lane can receive it"), {
          code: "browser_unavailable",
        });
      },
    };
    await withDaemonServer(
      noEnqueue,
      async (base) => {
        const res = await apiFetch(`${base}/threads/th-pf/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: "use the browser", browser: true }),
        });
        // A client-actionable refusal (4xx), the turn already exists, enqueue
        // never happened, and the refusal is persisted ON the turn (inline card).
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        const raw = await res.text();
        expect(raw).toContain("tn-pf");
        expect(enqueueCalled).toBe(false);
        expect(turns[0]?.["enqueue_error"]).toMatchObject({ code: "browser_unavailable" });
      },
      undefined,
      services,
    );
  });

  it("threads: retry 409s IMMEDIATELY for a retryable:false refusal (no registry lookup for params that were never recorded)", async () => {
    const repo = reapMk(join(tmpdir(), "claudexor-thread-norep-"));
    const now = new Date().toISOString();
    const threadObj: Record<string, unknown> = {
      schema_version: 2,
      id: "th-n",
      created_at: now,
      updated_at: now,
      repo: { root: repo, base_ref: "HEAD" },
      title: "non-replayable thread",
      mode: "agent",
      workspace: { mode: "in_place", worktree_path: null, base_sha: null },
      auth_preference: "auto",
      primary_harness: null,
      routingGoal: "auto",
      run_ids: [],
      head_run_id: null,
      state: "active",
    };
    const turns: Record<string, unknown>[] = [
      {
        id: "tn-norep",
        thread_id: "th-n",
        run_id: null,
        prompt: "never enqueued",
        enqueue_error: {
          message: "daemon socket is gone",
          code: null,
          retryable: false,
          failed_at: now,
        },
        created_at: now,
      },
    ];
    let listCalls = 0;
    const daemon: DaemonFacadeClient = {
      async enqueue() {
        throw new Error("must not be called");
      },
      async status() {
        throw new Error("missing");
      },
      async list() {
        listCalls += 1;
        return [];
      },
      async cancel() {
        return { ok: true };
      },
    };
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async () => ({ thread: threadObj, sessions: [], turns }),
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        const res = await apiFetch(`${base}/threads/th-n/turns/tn-norep/retry`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { message: string }).message).toContain("send a new message");
        expect(listCalls).toBe(0); // short-circuited before the registry lookup
      },
      undefined,
      services,
    );
  });

  it("threads: POST /threads/:id/turns/:turnId/retry replays the recorded job params; guards refuse bound/active/unknown turns", async () => {
    const repo = reapMk(join(tmpdir(), "claudexor-thread-retry-"));
    const now = new Date().toISOString();
    const threadObj: Record<string, unknown> = {
      schema_version: 2,
      id: "th-x",
      created_at: now,
      updated_at: now,
      repo: { root: repo, base_ref: "HEAD" },
      title: "retry thread",
      mode: "agent",
      workspace: { mode: "in_place", worktree_path: null, base_sha: null },
      auth_preference: "auto",
      primary_harness: null,
      routingGoal: "auto",
      run_ids: [],
      head_run_id: null,
      state: "active",
    };
    const refusedParams = {
      prompt: "risky work",
      mode: "agent",
      scope: { kind: "project", root: repo, context: "auto" },
      access: "full",
      turnId: "tn-1",
    };
    const turns: Record<string, unknown>[] = [
      {
        id: "tn-old-refused",
        thread_id: "th-x",
        run_id: null,
        parent_run_id: null,
        plan_run_id: null,
        kind: "initial",
        prompt: "old refused work",
        enqueue_error: { message: "old refusal", code: null, failed_at: now },
        created_at: now,
      },
      {
        id: "tn-bound",
        thread_id: "th-x",
        run_id: "run-old",
        parent_run_id: null,
        plan_run_id: null,
        kind: "followup",
        prompt: "done work",
        created_at: now,
      },
      {
        id: "tn-1",
        thread_id: "th-x",
        run_id: null,
        parent_run_id: null,
        plan_run_id: null,
        kind: "followup",
        prompt: "risky work",
        enqueue_error: {
          message: "access profile 'full' requires allow_full_access: true",
          code: "trust_full_access_required",
          failed_at: now,
        },
        created_at: now,
      },
    ];
    // Job registry double: the failed original + a retry that starts a run.
    const jobs = new Map<string, DaemonRunRecord>([
      [
        "job-fail",
        {
          id: "job-fail",
          state: "failed",
          error: "access profile 'full' requires allow_full_access: true",
          params: refusedParams,
          createdAt: now,
        },
      ],
    ]);
    const enqueued: unknown[] = [];
    // The FIRST replay is refused again (trust still missing — a typed
    // throw); the second succeeds. This is the exact "second refusal must be
    // persisted" scenario.
    let refuseNextEnqueue = true;
    const retryDaemon: DaemonFacadeClient = {
      async enqueue(params: unknown) {
        if (refuseNextEnqueue) {
          refuseNextEnqueue = false;
          throw Object.assign(
            new Error("access profile 'full' requires allow_full_access: true (still)"),
            {
              code: "trust_full_access_required",
            },
          );
        }
        enqueued.push(params);
        const rec: DaemonRunRecord = {
          id: `job-retry-${enqueued.length}`,
          state: "running",
          runId: "run-retried",
          taskId: "task-retried",
          runDir: repo,
          params,
          createdAt: new Date().toISOString(),
        };
        jobs.set(rec.id, rec);
        // Simulate the runner binding the run to the SAME turn.
        const turnId = (params as { turnId?: string }).turnId;
        const turn = turns.find((t) => t["id"] === turnId);
        if (turn) {
          turn["run_id"] = "run-retried";
          turn["enqueue_error"] = null;
        }
        return { id: rec.id, state: "queued" };
      },
      async status(id: string) {
        const rec = jobs.get(id);
        if (!rec) throw new Error("missing");
        return rec;
      },
      async list() {
        return [...jobs.values()];
      },
      async cancel() {
        return { ok: true };
      },
    };
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async () => ({ thread: threadObj, sessions: [], turns }),
      setTurnEnqueueError: (turnId, message, code) => {
        const turn = turns.find((t) => t["id"] === turnId);
        if (turn && !turn["run_id"]) turn["enqueue_error"] = { message, code, failed_at: now };
      },
    };
    await withDaemonServer(
      retryDaemon,
      async (base) => {
        const retry = (turnId: string) =>
          apiFetch(`${base}/threads/th-x/turns/${turnId}/retry`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          });
        // Guards first: unknown turn, already-bound turn, and an OLDER refused
        // turn (retry repairs the conversation TAIL only — re-running an old
        // turn would silently reorder lineage the thread already moved past).
        expect((await retry("tn-nope")).status).toBe(404);
        expect((await retry("tn-bound")).status).toBe(409);
        const older = await retry("tn-old-refused");
        expect(older.status).toBe(409);
        expect(((await older.json()) as { message: string }).message).toContain("not the latest");
        // First replay: refused AGAIN — the fresh refusal (message + typed
        // code) must be PERSISTED on the turn, not just returned once. The
        // typed trust throw carries no HTTP status -> infra default 500.
        const refused = await retry("tn-1");
        expect(refused.status).toBe(500);
        const turn1 = turns.find((t) => t["id"] === "tn-1");
        const freshError = turn1?.["enqueue_error"] as { message: string; code: string | null };
        expect(freshError.message).toContain("(still)");
        expect(freshError.code).toBe("trust_full_access_required");
        // Second replay succeeds: replays the recorded params verbatim onto
        // the SAME turn (no duplicate bubble).
        const ok = await retry("tn-1");
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as { runId: string; turnId: string; threadId: string };
        expect(body.runId).toBe("run-retried");
        expect(body.turnId).toBe("tn-1");
        expect(body.threadId).toBe("th-x");
        expect(enqueued).toEqual([refusedParams]);
        // After the run bound, a third retry is refused (turn has a run now).
        expect((await retry("tn-1")).status).toBe(409);
        // A LATEST runless turn with NO recorded refusal (the queued-bind
        // window) is not retryable either — its job may still be starting.
        turns.push({
          id: "tn-queued",
          thread_id: "th-x",
          run_id: null,
          parent_run_id: null,
          plan_run_id: null,
          kind: "followup",
          prompt: "queued work",
          created_at: now,
        });
        const pending = await retry("tn-queued");
        expect(pending.status).toBe(409);
        expect(((await pending.json()) as { message: string }).message).toContain(
          "no recorded refusal",
        );
      },
      undefined,
      services,
    );
  });

  // QA-045: Implementing a plan with unresolved owner questions must produce a
  // DURABLE, idempotent, replayable refused turn — the readiness gate rides the
  // SAME pre-start mechanism as the trust gate, never a bespoke early return
  // that leaves no turn and ignores the idempotency key.
  describe("threads: plan_not_ready implement is a durable refused turn (QA-045)", () => {
    function makePlanRunDir(): string {
      const runDir = reapMk(join(tmpdir(), "claudexor-plan-run-"));
      mkdirSync(join(runDir, "final"), { recursive: true });
      writeFileSync(join(runDir, "final", "plan.md"), "# Plan\n\nDo the thing.\n");
      // One open single-choice question -> readiness needs_answers. (Only the
      // OLD pre-create gate read this; the fixed route delegates readiness to
      // the run-start runner, so this drives the RED assertion pre-fix.)
      writeFileSync(
        join(runDir, "final", "questions.json"),
        JSON.stringify({
          parse: "found",
          questions: [
            {
              id: "q1",
              kind: "single",
              prompt: "How to store it?",
              options: [],
              allow_text: false,
            },
          ],
        }),
      );
      return runDir;
    }

    function planThread(repo: string, planRunId: string): Record<string, unknown> {
      const now = new Date().toISOString();
      return {
        schema_version: 2,
        id: "th-plan",
        created_at: now,
        updated_at: now,
        repo: { root: repo, base_ref: "HEAD" },
        title: "plan thread",
        mode: "agent",
        workspace: { mode: "in_place", worktree_path: null, base_sha: null },
        auth_preference: "auto",
        primary_harness: null,
        routingGoal: "auto",
        run_ids: [planRunId],
        head_run_id: planRunId,
        state: "active",
      };
    }

    it("a not-ready implement creates a durable, idempotent turn carrying the typed refusal", async () => {
      const repo = reapMk(join(tmpdir(), "claudexor-plan-thread-"));
      const planRunDir = makePlanRunDir();
      const now = new Date().toISOString();
      const threadObj = planThread(repo, "run-plan");
      const turns: Record<string, unknown>[] = [];
      const refusalMsg =
        "plan run-plan is not ready: 1 open question(s) — answer them and create a NEW Implement turn against the latest plan, or pass overridePlanReadiness:true";
      // Job registry: the completed PLAN run (so readRunArtifactText/resolve can
      // find final/plan.md) plus the implement job the runner refuses pre-start.
      const jobs = new Map<string, DaemonRunRecord>([
        ["job-plan", { id: "job-plan", state: "succeeded", runId: "run-plan", runDir: planRunDir }],
      ]);
      // createThreadTurn is idempotent by key (the daemon ThreadStore contract).
      const turnByKey = new Map<string, Record<string, unknown>>();
      let createTurnCalls = 0;
      // enqueue is idempotent by key: a repeat returns the same recorded job.
      const jobByKey = new Map<string, { id: string; state: string }>();
      const planDaemon: DaemonFacadeClient = {
        async enqueue(params: unknown, options) {
          const key = options?.idempotencyKey ?? "";
          const existing = jobByKey.get(key);
          if (existing) return existing;
          const turnId = (params as { turnId?: string }).turnId;
          // The runner refuses pre-start (open questions, no override): the job
          // settles terminal with a TYPED code and NO run bound.
          jobs.set("job-impl", {
            id: "job-impl",
            state: "failed",
            error: refusalMsg,
            errorCode: "plan_not_ready",
            errorStatus: 409,
            // Round-2 #4: the runner's typed throw declares retryable=false; the
            // daemon carries it onto the record and into the refused-turn record.
            errorRetryable: false,
            params,
            createdAt: now,
          });
          void turnId;
          const job = { id: "job-impl", state: "queued" };
          jobByKey.set(key, job);
          return job;
        },
        async status(id: string) {
          const rec = jobs.get(id);
          if (!rec) throw new Error(`missing job ${id}`);
          // The daemon's own finally-hook persists the pre-start refusal on the
          // turn (onTurnEnqueueFailed -> setTurnEnqueueError). plan_not_ready is
          // retryable=false (round-2 #4): the frozen planRef would replay the
          // same open questions, so retry can never repair it — the remediation
          // is a NEW Implement turn against the latest plan.
          if (id === "job-impl" && rec.state === "failed" && rec.errorCode === "plan_not_ready") {
            const turnId = (rec.params as { turnId?: string }).turnId;
            const turn = turns.find((t) => t["id"] === turnId);
            if (turn && !turn["run_id"] && !turn["enqueue_error"]) {
              turn["enqueue_error"] = {
                message: rec.error,
                code: "plan_not_ready",
                retryable: rec.errorRetryable ?? true,
                failed_at: now,
              };
            }
          }
          return rec;
        },
        async list() {
          return [...jobs.values()];
        },
        async cancel() {
          return { ok: true };
        },
      };
      const services: DaemonControlApiOptions["services"] = {
        threadDetail: async () => ({ thread: threadObj, sessions: [], turns }),
        createThreadTurn: async (id, prompt, opts) => {
          const key = opts.idempotency?.key ?? "";
          const prior = turnByKey.get(key);
          if (prior) return prior;
          createTurnCalls += 1;
          const turn: Record<string, unknown> = {
            id: "tn-impl",
            thread_id: id,
            run_id: null,
            parent_run_id: opts.parentRunId ?? null,
            plan_run_id: opts.planRunId ?? null,
            plan_hash: opts.planHash ?? null,
            plan_readiness_overridden: opts.planOverridden === true,
            kind: "followup",
            prompt,
            created_at: now,
          };
          turns.push(turn);
          turnByKey.set(key, turn);
          return turn;
        },
      };
      await withDaemonServer(
        planDaemon,
        async (base) => {
          const idem = `plan-impl-${crypto.randomUUID()}`;
          const post = () =>
            apiFetch(`${base}/threads/th-plan/turns`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "Idempotency-Key": idem },
              body: JSON.stringify({ prompt: "Implement this plan.", planRunId: "run-plan" }),
            });
          const res = await post();
          // The refusal is honest: 409 with the TYPED code AND durable handles
          // (turnId + threadId), so a reloading/other client can recover it.
          expect(res.status).toBe(409);
          const body = (await res.json()) as {
            code?: string;
            context?: { turnId?: string; threadId?: string };
          };
          expect(body.code).toBe("plan_not_ready");
          expect(body.context?.turnId).toBe("tn-impl");
          expect(body.context?.threadId).toBe("th-plan");
          // The turn is DURABLE: a thread reload projects it with the typed
          // enqueueError (never an eternally-empty bubble). head/run_ids are
          // unchanged — no run started.
          const detail = (await (
            await apiFetch(`${base}/threads/th-plan`, {
              headers: { authorization: `Bearer ${token}` },
            })
          ).json()) as {
            thread: { headRunId: string | null; runIds?: string[] };
            turns: {
              id: string;
              runId: string | null;
              planRunId: string | null;
              enqueueError: { code: string | null; retryable: boolean } | null;
            }[];
          };
          const durable = detail.turns.find((t) => t.id === "tn-impl");
          expect(durable?.runId).toBeNull();
          expect(durable?.planRunId).toBe("run-plan");
          expect(durable?.enqueueError?.code).toBe("plan_not_ready");
          // Round-2 #4: the refusal is NOT retryable — the frozen plan keeps its
          // open questions, so Exact Retry could never make it ready.
          expect(durable?.enqueueError?.retryable).toBe(false);
          expect(detail.thread.headRunId).toBe("run-plan"); // unchanged (plan run)

          // Idempotent: the SAME key returns the SAME durable turn and creates
          // no second turn.
          const again = await post();
          expect(again.status).toBe(409);
          expect(((await again.json()) as { context?: { turnId?: string } }).context?.turnId).toBe(
            "tn-impl",
          );
          expect(createTurnCalls).toBe(1);
        },
        undefined,
        services,
      );
    });

    it("retry of a plan_not_ready refusal is REFUSED as non-retryable (round-2 #4): answer + new turn, never a verbatim replay", async () => {
      const repo = reapMk(join(tmpdir(), "claudexor-plan-retry-"));
      const planRunDir = makePlanRunDir();
      const now = new Date().toISOString();
      const threadObj = planThread(repo, "run-plan");
      const implParams = {
        prompt: "Implement the approved plan of this thread",
        mode: "agent",
        scope: { kind: "project", root: repo, context: "auto" },
        planRunId: "run-plan",
        turnId: "tn-impl",
      };
      // Pre-seed the durable refused turn (as the not-ready implement left it):
      // enqueue_error.retryable is FALSE. Exact Retry replays the recorded
      // params VERBATIM with the planRef frozen to the ORIGINAL plan (INV-081),
      // whose questions.json still has the open question — so a retry could
      // never become ready. The remediation is a NEW Implement turn against the
      // latest plan, so the retry endpoint must refuse immediately.
      const turns: Record<string, unknown>[] = [
        {
          id: "tn-impl",
          thread_id: "th-plan",
          run_id: null,
          parent_run_id: "run-plan",
          plan_run_id: "run-plan",
          plan_readiness_overridden: false,
          kind: "followup",
          prompt: "Implement the approved plan of this thread",
          enqueue_error: {
            message: "plan run-plan is not ready: 1 open question(s)",
            code: "plan_not_ready",
            retryable: false,
            failed_at: now,
          },
          created_at: now,
        },
      ];
      const jobs = new Map<string, DaemonRunRecord>([
        ["job-plan", { id: "job-plan", state: "succeeded", runId: "run-plan", runDir: planRunDir }],
        [
          "job-impl",
          {
            id: "job-impl",
            state: "failed",
            error: "plan run-plan is not ready: 1 open question(s)",
            errorCode: "plan_not_ready",
            errorStatus: 409,
            errorRetryable: false,
            params: implParams,
            createdAt: now,
          },
        ],
      ]);
      const enqueued: unknown[] = [];
      const retryDaemon: DaemonFacadeClient = {
        // A non-retryable refusal must be rejected BEFORE any enqueue/registry
        // replay — nothing may be re-run.
        async enqueue(params: unknown) {
          enqueued.push(params);
          throw new Error("enqueue must not be called for a non-retryable refusal");
        },
        async status(id: string) {
          const rec = jobs.get(id);
          if (!rec) throw new Error(`missing job ${id}`);
          return rec;
        },
        async list() {
          return [...jobs.values()];
        },
        async cancel() {
          return { ok: true };
        },
      };
      const services: DaemonControlApiOptions["services"] = {
        threadDetail: async () => ({ thread: threadObj, sessions: [], turns }),
        setTurnEnqueueError: (turnId, message, code, retryable) => {
          const turn = turns.find((t) => t["id"] === turnId);
          if (turn && !turn["run_id"])
            turn["enqueue_error"] = { message, code, retryable: retryable ?? true, failed_at: now };
        },
      };
      await withDaemonServer(
        retryDaemon,
        async (base) => {
          const res = await apiFetch(`${base}/threads/th-plan/turns/tn-impl/retry`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          });
          expect(res.status).toBe(409);
          const body = (await res.json()) as {
            code?: string;
            message?: string;
            retryable?: boolean;
          };
          expect(body.message).toMatch(/no recorded enqueue attempt to replay|send a new message/i);
          expect(body.retryable).toBe(false);
          // Nothing was replayed and the refused turn is untouched.
          expect(enqueued).toEqual([]);
          const turn = turns.find((t) => t["id"] === "tn-impl");
          expect(turn?.["run_id"]).toBeNull();
          expect((turn?.["enqueue_error"] as { retryable?: boolean } | null)?.retryable).toBe(
            false,
          );
        },
        undefined,
        services,
      );
    });

    it("the explicit plan_readiness_overridden implement path is unchanged (creates a normal run, no refusal)", async () => {
      const repo = reapMk(join(tmpdir(), "claudexor-plan-override-"));
      const planRunDir = makePlanRunDir();
      const now = new Date().toISOString();
      const threadObj = planThread(repo, "run-plan");
      const turns: Record<string, unknown>[] = [];
      let overriddenRecorded: boolean | undefined;
      const jobs = new Map<string, DaemonRunRecord>([
        ["job-plan", { id: "job-plan", state: "succeeded", runId: "run-plan", runDir: planRunDir }],
      ]);
      const overrideDaemon: DaemonFacadeClient = {
        // Override recorded on the turn -> the runner SKIPS the readiness gate
        // and the run binds normally.
        async enqueue(params: unknown) {
          const rec: DaemonRunRecord = {
            id: "job-override",
            state: "running",
            runId: "run-impl",
            taskId: "task-impl",
            runDir: planRunDir,
            params,
            createdAt: now,
          };
          jobs.set(rec.id, rec);
          const turnId = (params as { turnId?: string }).turnId;
          const turn = turns.find((t) => t["id"] === turnId);
          if (turn) turn["run_id"] = "run-impl";
          return { id: rec.id, state: "queued" };
        },
        async status(id: string) {
          const rec = jobs.get(id);
          if (!rec) throw new Error(`missing job ${id}`);
          return rec;
        },
        async list() {
          return [...jobs.values()];
        },
        async cancel() {
          return { ok: true };
        },
      };
      const services: DaemonControlApiOptions["services"] = {
        threadDetail: async () => ({ thread: threadObj, sessions: [], turns }),
        createThreadTurn: async (id, prompt, opts) => {
          overriddenRecorded = opts.planOverridden;
          const turn: Record<string, unknown> = {
            id: "tn-impl",
            thread_id: id,
            run_id: null,
            parent_run_id: opts.parentRunId ?? null,
            plan_run_id: opts.planRunId ?? null,
            plan_readiness_overridden: opts.planOverridden === true,
            kind: "followup",
            prompt,
            created_at: now,
          };
          turns.push(turn);
          return turn;
        },
      };
      await withDaemonServer(
        overrideDaemon,
        async (base) => {
          const res = await apiFetch(`${base}/threads/th-plan/turns`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({
              prompt: "Implement this plan.",
              planRunId: "run-plan",
              overridePlanReadiness: true,
            }),
          });
          expect(res.status).toBe(200);
          const body = (await res.json()) as { runId: string; turnId: string };
          expect(body.runId).toBe("run-impl");
          expect(body.turnId).toBe("tn-impl");
          // The override provenance is recorded on the turn (D17), not silently
          // dropped.
          expect(overriddenRecorded).toBe(true);
        },
        undefined,
        services,
      );
    });
  });

  it("trust: GET resolves one repo and POST updates only typed user-level trust fields", async () => {
    const { daemon } = fakeDaemon();
    const calls: Array<{
      repoRoot: string;
      allowFullAccess?: boolean;
      accessDefault?: "readonly" | "workspace_write";
    }> = [];
    const listInputs: unknown[] = [];
    let allow = false;
    let accessDefault: "readonly" | "workspace_write" = "workspace_write";
    const services: DaemonControlApiOptions["services"] = {
      listTrust: async (input) => {
        listInputs.push(input);
        const entries = [
          {
            repoRoot: "/Users/x/proj",
            path: "/Users/x/.claudexor/trust/abc.yaml",
            allowFullAccess: allow,
            accessDefault,
          },
          // Legacy pre-provenance file: enumerable with a null root.
          {
            repoRoot: null,
            path: "/Users/x/.claudexor/trust/old.yaml",
            allowFullAccess: true,
            accessDefault: "workspace_write",
          },
        ];
        return { entries: input?.repoRoot ? entries.slice(0, 1) : entries };
      },
      updateTrust: async (input) => {
        calls.push(input);
        allow = input.allowFullAccess ?? allow;
        accessDefault = input.accessDefault ?? accessDefault;
        return {
          repoRoot: input.repoRoot,
          path: "/Users/x/.claudexor/trust/abc.yaml",
          allowFullAccess: allow,
          accessDefault,
        };
      },
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        const list = await apiFetch(`${base}/trust`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(list.status).toBe(200);
        const listBody = (await list.json()) as {
          entries: { repoRoot: string | null; allowFullAccess: boolean }[];
        };
        expect(listBody.entries).toHaveLength(2);
        expect(listBody.entries[1]?.repoRoot).toBeNull();

        const scoped = await apiFetch(`${base}/trust?repoRoot=%2FUsers%2Fx%2Fproj`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(scoped.status).toBe(200);
        expect(listInputs).toEqual([undefined, { repoRoot: "/Users/x/proj" }]);

        const unknown = await apiFetch(`${base}/trust`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            repoRoot: "/Users/x/proj",
            allowFullAccess: true,
            shell: true,
          }),
        });
        expect(unknown.status).toBe(400);
        expect(calls).toHaveLength(0);

        const missing = await apiFetch(`${base}/trust`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ repoRoot: "/Users/x/proj" }),
        });
        expect(missing.status).toBe(400);

        const ok = await apiFetch(`${base}/trust`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            repoRoot: "/Users/x/proj",
            allowFullAccess: true,
            accessDefault: "readonly",
          }),
        });
        expect(ok.status).toBe(200);
        const okBody = (await ok.json()) as { repoRoot: string; allowFullAccess: boolean };
        expect(okBody.allowFullAccess).toBe(true);
        expect(calls).toEqual([
          { repoRoot: "/Users/x/proj", allowFullAccess: true, accessDefault: "readonly" },
        ]);
      },
      undefined,
      services,
    );
  });

  it("threads: a turn inherits the thread's sticky primary + eligible pool; the body overrides them; PATCH switches them", async () => {
    const { daemon, record } = fakeDaemon();
    const repo = reapMk(join(tmpdir(), "claudexor-thread-pool-"));
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
      access: "full", // sticky write scope (D26)
      routingGoal: "auto",
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
        await apiFetch(`${base}/threads/th-9/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: "go" }),
        });
        expect(enqueued).toMatchObject({
          primaryHarness: "codex",
          harnesses: ["codex", "claude"],
          access: "full", // sticky write scope inherited (D26)
        });

        // 2) Body override wins over the thread sticky values (+ per-turn strategy flags pass through).
        enqueued = undefined;
        await apiFetch(`${base}/threads/th-9/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "go",
            primaryHarness: "claude",
            harnesses: ["cursor"],
            untilClean: true,
            n: 3,
            access: "workspace_write",
          }),
        });
        expect(enqueued).toMatchObject({
          primaryHarness: "claude",
          harnesses: ["cursor"],
          untilClean: true,
          n: 3,
        });

        // 2b) A turn that explicitly narrows the pool (Best-of over the available subset)
        // must NOT drag the sticky primary along when it is outside that pool — else
        // the engine would fail "primary not in eligible pool". Drop the bias instead.
        enqueued = undefined;
        await apiFetch(`${base}/threads/th-9/turns`, {
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
        await apiFetch(`${base}/threads/th-9`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ eligibleHarnesses: ["claude"] }), // drop codex (the sticky primary) from the pool
        });
        enqueued = undefined;
        await apiFetch(`${base}/threads/th-9/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: "ordinary turn" }), // no body routing -> inherit thread sticky
        });
        expect(enqueued).toMatchObject({ harnesses: ["claude"] });
        expect(enqueued && "primaryHarness" in enqueued).toBe(false); // sticky codex NOT inherited (outside the narrowed pool)

        // 3) PATCH switches the sticky primary + pool (the thin-gateway persist path).
        const patch = await apiFetch(`${base}/threads/th-9`, {
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
    const repo = reapMk(join(tmpdir(), "claudexor-thread-autopool-"));
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
      routingGoal: "auto",
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
        await apiFetch(`${base}/threads/th-10/turns`, {
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

  it("threads: a turn forwards per-turn model/review controls to daemon enqueue", async () => {
    // HTTP-boundary proof for the macOS per-turn model picker, spec Implement,
    // explicit reviewer panel, test gates, and protected-path approvals: the
    // thin gateway must accept and forward them to enqueue, not silently drop
    // them. (Kit tests cover Swift encoding; this locks the wire.)
    const { daemon, record } = fakeDaemon();
    const repo = reapMk(join(tmpdir(), "claudexor-thread-modelspec-"));
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
      routingGoal: "auto",
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
        const r = await apiFetch(`${base}/threads/th-11/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "implement it",
            model: "gpt-5-codex",
            authPreference: "subscription",
            reviewerPanel: [{ harness: "claude", model: "claude-opus-4.8", effort: "max" }],
            reviewerModels: { openai: "gpt-5.5" },
            reviewerEfforts: { openai: "xhigh" },
            tests: [{ program: "pnpm", args: ["test"], envAllowlist: [] }],
            protectedPathApprovals: [{ path: "packages/**/*.test.ts", reason: "requested" }],
          }),
        });
        expect(r.status).toBe(200);
        expect(enqueued).toMatchObject({
          model: "gpt-5-codex",
          authPreference: "subscription",
          reviewerPanel: [{ harness: "claude", model: "claude-opus-4.8", effort: "max" }],
          reviewerModels: { openai: "gpt-5.5" },
          reviewerEfforts: { openai: "xhigh" },
          tests: [{ program: "pnpm", args: ["test"], envAllowlist: [] }],
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
      const start = await apiFetch(`${base}/runs`, {
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

  it("rejects legacy inline/path attachment authority before daemon enqueue", async () => {
    const repo = reapMk(join(tmpdir(), "claudexor-inline-attachment-"));
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
      for (const attachment of [
        { kind: "file", mime: "text/plain", name: "note.txt", data: "aGVsbG8=" },
        { kind: "file", mime: "text/plain", name: "note.txt", path: join(repo, "note.txt") },
      ]) {
        const start = await apiFetch(`${base}/runs`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "use attached note",
            mode: "agent",
            scope: { kind: "project", root: repo },
            attachments: [attachment],
          }),
        });
        expect(start.status).toBe(400);
      }
      expect(enqueued).toBe(0);
    });
  });

  it("allows only finalized daemon resource ids through daemon enqueue", async () => {
    const { daemon } = fakeDaemon();
    const repo = reapMk(join(tmpdir(), "claudexor-resource-attachment-"));
    let enqueued: Record<string, unknown> | undefined;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown) {
        enqueued = params as Record<string, unknown>;
        return daemon.enqueue(params);
      },
    };
    await withDaemonServer(wrapped, async (base) => {
      const start = await apiFetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "use attached note",
          mode: "agent",
          scope: { kind: "project", root: repo },
          attachments: [{ resourceId: "res-note" }],
        }),
      });
      expect(start.status).toBe(200);
      expect(enqueued?.["attachments"]).toEqual([{ resourceId: "res-note" }]);
    });
  });

  it("refuses unsatisfied lane requirements before creating a daemon run", async () => {
    const { daemon } = fakeDaemon();
    const repo = reapMk(join(tmpdir(), "claudexor-pre-enqueue-requirements-"));
    let enqueued = 0;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown) {
        enqueued += 1;
        return daemon.enqueue(params);
      },
    };
    await withDaemonServer(
      wrapped,
      async (base) => {
        const response = await apiFetch(`${base}/runs`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "use attachment",
            mode: "agent",
            scope: { kind: "project", root: repo },
            harnesses: ["cursor"],
            attachments: [{ resourceId: "res-note" }],
          }),
        });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("mandatory attachment");
        expect(enqueued).toBe(0);
      },
      undefined,
      {
        preflightRunRequirements: async () => {
          throw Object.assign(new Error("cursor cannot receive every mandatory attachment"), {
            status: 400,
            code: "attachment_pool_unsupported",
          });
        },
      },
    );
  });

  it("streams upload bytes, exposes progress, supports finalize and cancel", async () => {
    const { daemon } = fakeDaemon();
    let bytes = Buffer.alloc(0);
    let cancelled = false;
    let createKey: string | undefined;
    let finalizeKey: string | undefined;
    const services: DaemonControlApiOptions["services"] = {
      createUpload: async (_input, key) => {
        createKey = key;
        return {
          uploadId: "upl-1",
          state: "open",
          receivedBytes: 0,
          expectedBytes: 5,
        };
      },
      writeUpload: async (_id, chunks) => {
        for await (const chunk of chunks) bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
        return { uploadId: "upl-1", state: "uploaded", receivedBytes: 5, expectedBytes: 5 };
      },
      uploadStatus: async () => ({
        uploadId: "upl-1",
        state: "uploaded",
        receivedBytes: bytes.length,
        expectedBytes: 5,
      }),
      finalizeUpload: async (_id, _digest, key) => {
        finalizeKey = key;
        return {
          resourceId: "res-1",
          kind: "file",
          mime: "text/plain",
          name: "note.txt",
          sha256: `sha256:${"1".repeat(64)}`,
          sizeBytes: 5,
          createdAt: new Date().toISOString(),
          deduplicated: false,
        };
      },
      cancelUpload: async () => {
        cancelled = true;
        return { uploadId: "upl-1", state: "cancelled", receivedBytes: 5, expectedBytes: 5 };
      },
    };
    await withDaemonServer(
      daemon,
      async (base) => {
        expect(
          (
            await apiFetch(`${base}/uploads`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "idempotency-key": "create-upload" },
              body: JSON.stringify({
                kind: "file",
                mime: "text/plain",
                name: "note.txt",
                sizeBytes: 5,
              }),
            })
          ).status,
        ).toBe(201);
        expect(createKey).toBe("create-upload");
        expect(
          (
            await apiFetch(`${base}/uploads/upl-1/bytes`, {
              method: "PUT",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/octet-stream",
              },
              body: "hello",
            })
          ).status,
        ).toBe(200);
        expect(bytes.toString()).toBe("hello");
        expect(
          (
            await apiFetch(`${base}/uploads/upl-1`, {
              headers: { authorization: `Bearer ${token}` },
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await apiFetch(`${base}/uploads/upl-1/finalize`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "idempotency-key": "finalize-upload",
              },
              body: "{}",
            })
          ).status,
        ).toBe(201);
        expect(finalizeKey).toBe("finalize-upload");
        expect(
          (
            await apiFetch(`${base}/uploads/upl-1`, {
              method: "DELETE",
              headers: { authorization: `Bearer ${token}` },
            })
          ).status,
        ).toBe(200);
        expect(cancelled).toBe(true);
      },
      undefined,
      services,
    );
  });

  it("summarizes no-project Ask runs without exposing the synthetic repo root as a project", async () => {
    const { daemon, record } = fakeDaemon();
    record.params = { prompt: "2+2?", mode: "ask", scope: { kind: "none" } };
    await withDaemonServer(daemon, async (base) => {
      const list = (await (
        await apiFetch(`${base}/runs`, { headers: { authorization: `Bearer ${token}` } })
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
        await apiFetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
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
        await apiFetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
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
        "      program: pnpm",
        "      args: [test]",
        "      envAllowlist: []",
        "      required: true",
        "    - id: gate-2",
        "      program: pnpm",
        "      args: [build]",
        "      envAllowlist: []",
        "      required: true",
        "",
      ].join("\n"),
    );
    await withDaemonServer(daemon, async (base) => {
      const detail = (await (
        await apiFetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as {
        summary: { tests?: Array<{ program: string; args: string[]; envAllowlist: string[] }> };
      };
      expect(detail.summary.tests).toEqual([
        { program: "pnpm", args: ["test"], envAllowlist: [] },
        { program: "pnpm", args: ["build"], envAllowlist: [] },
      ]);
    });
  });

  it("rejects legacy repoRoot/contextMode fields instead of accepting the old run DTO", async () => {
    const { daemon } = fakeDaemon();
    const repo = reapMk(join(tmpdir(), "claudexor-proj-"));
    await withDaemonServer(daemon, async (base) => {
      const start = await apiFetch(`${base}/runs`, {
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
      const start = await apiFetch(`${base}/runs`, {
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
      const start = await apiFetch(`${base}/runs`, {
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

      const check = await apiFetch(`${base}/runs/run-d1/apply/check`, {
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
      const start = await apiFetch(`${base}/runs`, {
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

      const blankPrimary = await apiFetch(`${base}/runs`, {
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
      const valid = await apiFetch(`${base}/runs`, {
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
      const openaiFamily = await apiFetch(`${base}/runs`, {
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
      const validModel = await apiFetch(`${base}/runs`, {
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
      const invalidValue = await apiFetch(`${base}/runs`, {
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

      const invalidProvider = await apiFetch(`${base}/runs`, {
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

      const invalidModelProvider = await apiFetch(`${base}/runs`, {
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
        { tests: [{ program: " ", args: [] }] },
        { protectedPathApprovals: [{ path: " " }] },
        { protectedPathApprovals: [{ path: "packages/**/*.test.ts", reason: " " }] },
      ];
      for (const body of bodies) {
        const res = await apiFetch(`${base}/runs`, {
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
    const panelRoot = reapMk(join(tmpdir(), "claudexor-panel-"));
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
      const valid = await apiFetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "review it",
          mode: "agent",
          scope: { kind: "project", root: panelRoot },
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
      const invalid = await apiFetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "review it",
          mode: "agent",
          scope: { kind: "project", root: panelRoot },
          reviewerPanel: [{ harness: "cursor", effort: "turbo" }],
        }),
      });
      expect(invalid.status).toBe(400);
      expect(enqueued).toBeUndefined();
    });
  });

  it("serves harness readiness checks and intent gating through the typed control-api service", async () => {
    const { daemon } = fakeDaemon();
    const harnessInputs: unknown[] = [];
    await withDaemonServer(
      daemon,
      async (base) => {
        const res = await apiFetch(`${base}/harnesses`, {
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
        const fresh = await apiFetch(`${base}/harnesses?fresh=true`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(fresh.status).toBe(200);
        const scoped = await apiFetch(
          `${base}/harnesses?fresh=true&all=true&harness=codex&harness=fake-success`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        expect(scoped.status).toBe(200);
        const invalid = await apiFetch(`${base}/harnesses?fresh=1`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(invalid.status).toBe(400);
        expect(harnessInputs).toEqual([
          {},
          { fresh: true },
          { fresh: true, includeFakes: true, harnessIds: ["codex", "fake-success"] },
        ]);
      },
      undefined,
      {
        harnesses: async (input) => {
          harnessInputs.push(input);
          return {
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
          };
        },
      },
    );
  });

  it("serves a harness's enumerable models through the typed harnessModels service (ADP4)", async () => {
    const { daemon } = fakeDaemon();
    const modelInputs: unknown[] = [];
    await withDaemonServer(
      daemon,
      async (base) => {
        const ok = await apiFetch(`${base}/harnesses/raw-api/models`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as {
          harnessId: string;
          source: string;
          models: { id: string; label: string | null; context_window: number | null }[];
        };
        expect(body).toMatchObject({ harnessId: "raw-api", source: "api" });
        // routes: null = unannotated (available on every credential route, W11).
        expect(body.models).toEqual([
          { id: "gpt-4o-mini", label: null, context_window: null, routes: null },
        ]);

        // A harness that cannot enumerate -> honest source "none" with [].
        const none = await apiFetch(`${base}/harnesses/codex/models`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(none.status).toBe(200);
        expect(await none.json()).toMatchObject({ harnessId: "codex", source: "none", models: [] });

        const fake = await apiFetch(`${base}/harnesses/fake-success/models`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(fake.status).toBe(200);
        expect(modelInputs.at(-1)).toEqual({ harnessId: "fake-success" });
      },
      undefined,
      {
        harnessModels: async (input) => {
          modelInputs.push(input);
          return input.harnessId === "raw-api"
            ? {
                harnessId: input.harnessId,
                source: "api",
                models: [{ id: "gpt-4o-mini", label: null, context_window: null, routes: null }],
              }
            : { harnessId: input.harnessId, source: "none", models: [] };
        },
      },
    );
  });

  it("validates and forwards setup job lifecycle through typed control-api services", async () => {
    const { daemon } = fakeDaemon();
    let job = setupJobFixture({
      jobId: "setup-1",
      harness: "cursor",
      state: "waiting_for_input",
      phase: "awaiting_user",
      message: "complete native login",
    });
    const seen: unknown[] = [];
    const listFilters: unknown[] = [];
    const reconciledJob = setupJobFixture({
      jobId: "setup-1",
      harness: "cursor",
      state: "failed",
      phase: "completed",
      outcome: { reason: "termination_unconfirmed" },
      finishedAt: "2026-01-01T00:10:00.000Z",
      execution: {
        executionId: "execution-1",
        commandDigest: "c".repeat(64),
        manifestDigest: "d".repeat(64),
        processGroup: {
          schemaVersion: 1,
          pgid: 42,
          leader: {
            status: "known",
            pid: 42,
            platform: "darwin",
            source: "proc_pidinfo",
            startToken: "start-42",
            processGroupId: 42,
          },
        },
        observedAt: "2026-01-01T00:00:01.000Z",
      },
      terminationReconciliation: {
        status: "empty",
        observedAt: "2026-01-01T00:10:00.000Z",
      },
    });
    await withDaemonServer(
      daemon,
      async (base) => {
        const missingKey = await apiFetch(`${base}/v2/setup/jobs`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            harness: "cursor",
            action: "login",
            authRequest: "subscription",
          }),
        });
        expect(missingKey.status).toBe(400);
        const created = await apiFetch(`${base}/v2/setup/jobs`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "Idempotency-Key": "setup-create-1" },
          body: JSON.stringify({
            harness: "cursor",
            action: "login",
            authRequest: "subscription",
          }),
        });
        expect(created.status).toBe(200);
        expect(await created.json()).toMatchObject({ jobId: "setup-1", action: "login" });
        expect(seen).toEqual([
          {
            request: { harness: "cursor", action: "login", authRequest: "subscription" },
            idempotencyKey: "setup-create-1",
            clientId: "control-api",
          },
        ]);
        const retired = await globalThis.fetch(`${base}/setup/jobs`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(retired.status).toBe(404);

        const listed = await apiFetch(
          `${base}/v2/setup/jobs?harness=cursor&action=login&active=true&limit=1`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        expect(listed.status).toBe(200);
        expect((await listed.json()) as unknown).toMatchObject({ jobs: [{ jobId: "setup-1" }] });
        expect(listFilters).toEqual([
          { harness: "cursor", action: "login", active: true, limit: 1 },
        ]);
        const invalidList = await apiFetch(`${base}/v2/setup/jobs?state=running`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(invalidList.status).toBe(400);
        const invalidHarness = await apiFetch(`${base}/v2/setup/jobs?harness=unknown`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(invalidHarness.status).toBe(400);

        const status = await apiFetch(`${base}/v2/setup/jobs/setup-1`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(status.status).toBe(200);
        expect(await status.json()).toMatchObject({ jobId: "setup-1", state: "waiting_for_input" });
        const snapshot = await apiFetch(`${base}/v2/setup/jobs/setup-1/snapshot`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(snapshot.status).toBe(200);
        expect(await snapshot.json()).toMatchObject({
          job: { jobId: "setup-1" },
          cursor: "cursor-41",
          sequence: 41,
        });

        // The lifecycle stream STAYS OPEN for a non-terminal job (it is a real
        // stream now, not a one-shot snapshot): read the first frame and abort.
        const sseAbort = new AbortController();
        const events = await apiFetch(`${base}/v2/setup/jobs/setup-1/events`, {
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
        expect(sseText).toContain("id: cursor-41");
        expect(sseText).toContain("waiting_for_input");
        expect(sseText).toContain('"job":{"jobId":"setup-1"');
        expect(sseText).not.toContain("event: end");
        sseAbort.abort();

        // QA-075: extend is key_required; a missing key is a typed 400.
        const extendNoKey = await apiFetch(`${base}/v2/setup/jobs/setup-1/extend`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(extendNoKey.status).toBe(400);
        expect(((await extendNoKey.json()) as { code: string }).code).toBe(
          "idempotency_key_required",
        );

        const extended = await apiFetch(`${base}/v2/setup/jobs/setup-1/extend`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "idempotency-key": "extend-once" },
        });
        expect(extended.status).toBe(200);
        expect(await extended.json()).toMatchObject({
          jobId: "setup-1",
          deadlineAt: "2026-01-01T00:15:00.000Z",
        });

        const reconciled = await apiFetch(`${base}/v2/setup/jobs/setup-1/reconcile`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(reconciled.status).toBe(200);
        expect(await reconciled.json()).toMatchObject({
          jobId: "setup-1",
          terminationReconciliation: { status: "empty" },
        });

        const cancelled = await apiFetch(`${base}/v2/setup/jobs/setup-1/cancel`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(cancelled.status).toBe(200);
        expect(await cancelled.json()).toMatchObject({ jobId: "setup-1", state: "cancelled" });

        // After cancel the job is terminal: the lifecycle stream must emit the
        // terminal status and CLOSE with an end frame.
        job = {
          ...job,
          state: "timed_out",
          phase: "completed",
          message: "timed out",
          outcome: { reason: "timed_out" },
          finishedAt: new Date().toISOString(),
        };
        const ended = await apiFetch(`${base}/v2/setup/jobs/setup-1/events`, {
          headers: { authorization: `Bearer ${token}`, "Last-Event-ID": "cursor-41" },
        });
        expect(ended.status).toBe(200);
        const endedText = await ended.text();
        expect(endedText).toContain("event: setup");
        expect(endedText).toContain("timed_out");
        expect(endedText).toContain("event: end");
      },
      undefined,
      {
        createSetupJob: async (input) => {
          seen.push(input);
          return job;
        },
        listSetupJobs: async (filter) => {
          listFilters.push(filter);
          return { jobs: [job] };
        },
        setupJobStatus: async () => job,
        setupJobSnapshot: async () => ({
          job,
          cursor: job.state === "timed_out" ? "cursor-42" : "cursor-41",
          sequence: job.state === "timed_out" ? 42 : 41,
        }),
        setupJobEvents: async (input) => {
          const afterCursor = (input as { afterCursor?: unknown }).afterCursor;
          const cursor = job.state === "timed_out" ? "cursor-42" : "cursor-41";
          return cursor === afterCursor
            ? []
            : [
                {
                  jobId: job.jobId,
                  cursor,
                  previousCursor: typeof afterCursor === "string" ? afterCursor : null,
                  sequence: job.state === "timed_out" ? 42 : 41,
                  time: new Date().toISOString(),
                  kind: "status",
                  state: job.state,
                  message: job.message,
                  job,
                },
              ];
        },
        cancelSetupJob: async () => ({
          ...job,
          state: "cancelled",
          phase: "completed",
          finishedAt: new Date().toISOString(),
          message: "cancelled",
          outcome: { reason: "cancelled_by_user" },
        }),
        reconcileSetupJob: async () => reconciledJob,
        extendSetupJob: async () => ({ ...job, deadlineAt: "2026-01-01T00:15:00.000Z" }),
      },
    );
  });

  it("reuses the validated resume batch and streams sparse sequences through an exact cursor chain", async () => {
    const { daemon } = fakeDaemon();
    const running = setupJobFixture({ phase: "verifying", message: "verifying" });
    const terminal = setupJobFixture({
      state: "timed_out",
      phase: "completed",
      message: "timed out",
      outcome: { reason: "timed_out" },
      finishedAt: "2026-01-01T00:00:03.000Z",
    });
    let eventReads = 0;
    await withDaemonServer(
      daemon,
      async (base) => {
        const response = await apiFetch(`${base}/v2/setup/jobs/${terminal.jobId}/events`, {
          headers: { authorization: `Bearer ${token}`, "Last-Event-ID": "cursor-base" },
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain(": connected");
        expect(text).toContain("id: cursor-41");
        expect(text).toContain("id: cursor-97");
        expect(text).toContain('"previousCursor":"cursor-base"');
        expect(text).toContain('"previousCursor":"cursor-41"');
        expect(text).toContain("event: end");
        expect(eventReads).toBe(1);
      },
      undefined,
      {
        setupJobStatus: async () => terminal,
        setupJobEvents: async (input) => {
          eventReads += 1;
          expect(input).toEqual({ jobId: terminal.jobId, afterCursor: "cursor-base" });
          return [
            setupEventFixture(running, "cursor-41", "cursor-base", 41),
            setupEventFixture(terminal, "cursor-97", "cursor-41", 97),
          ];
        },
      },
    );
  });

  it("treats interrupted_unknown as a terminal setup state", async () => {
    const { daemon } = fakeDaemon();
    const terminal = setupJobFixture({
      state: "interrupted_unknown",
      phase: "completed",
      message: "outcome unknown after restart",
      outcome: { reason: "interrupted_unknown" },
      finishedAt: "2026-01-01T00:00:03.000Z",
    });
    await withDaemonServer(
      daemon,
      async (base) => {
        const response = await apiFetch(`${base}/v2/setup/jobs/${terminal.jobId}/events`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("interrupted_unknown");
        expect(text).toContain("event: end");
      },
      undefined,
      {
        setupJobStatus: async () => terminal,
        setupJobEvents: async () => [setupEventFixture(terminal, "cursor-terminal", null, 3)],
      },
    );
  });

  it("returns a typed HTTP 409 for a stale setup journal cursor before SSE headers", async () => {
    const { daemon } = fakeDaemon();
    const current = setupJobFixture();
    await withDaemonServer(
      daemon,
      async (base) => {
        const response = await apiFetch(`${base}/v2/setup/jobs/${current.jobId}/events`, {
          headers: { authorization: `Bearer ${token}`, "Last-Event-ID": "stale-cursor" },
        });
        expect(response.status).toBe(409);
        expect(response.headers.get("content-type")).toBe("application/problem+json");
        expect(await response.json()).toEqual({
          code: "journal_cursor_invalid",
          message: "stale epoch",
          retryable: false,
          fieldErrors: {},
          requiredActions: ["resnapshot"],
          evidenceRefs: [],
          context: {},
        });
      },
      undefined,
      {
        setupJobStatus: async () => current,
        setupJobEvents: async () => {
          throw Object.assign(new Error("stale epoch"), {
            status: 409,
            code: "journal_cursor_invalid",
            requiredActions: ["resnapshot"],
          });
        },
      },
    );
  });

  it("exposes recovery inspection, validation, export, and idempotent quarantine through v2-only routes", async () => {
    const { daemon } = fakeDaemon();
    const fingerprint = "a".repeat(64);
    const inspection = {
      schemaVersion: 1 as const,
      partition: "global" as const,
      generation: 1,
      status: "recovery_required" as const,
      recovery: {
        status: "recovery_required" as const,
        location: { kind: "byte" as const, byteOffset: 42 },
        reason: "checksum mismatch",
        discardedTailBytes: 0,
      },
      fingerprint,
      observedAt: "2026-01-01T00:00:00.000Z",
      evidenceRefs: [`recovery:global:${fingerprint}`],
    };
    const quarantineInputs: unknown[] = [];
    const inspectedPartitions: string[] = [];
    await withDaemonServer(
      daemon,
      async (base) => {
        const headers = { authorization: `Bearer ${token}` };
        const inspect = await apiFetch(`${base}/v2/recovery/partitions/global`, { headers });
        expect(inspect.status).toBe(200);
        expect(await inspect.json()).toEqual(inspection);

        const projectInspect = await apiFetch(`${base}/v2/recovery/partitions/project%3Aprj-1`, {
          headers,
        });
        expect(projectInspect.status).toBe(200);
        expect(await projectInspect.json()).toMatchObject({ partition: "project:prj-1" });

        const validate = await apiFetch(`${base}/v2/recovery/partitions/global/validate`, {
          method: "POST",
          headers,
        });
        expect(validate.status).toBe(200);
        expect(await validate.json()).toMatchObject({
          projectionStatus: [{ name: "setup", status: "invalid" }],
        });

        const exported = await apiFetch(`${base}/v2/recovery/partitions/global/export`, {
          method: "POST",
          headers,
        });
        expect(exported.status).toBe(200);
        expect(await exported.json()).toMatchObject({ exportId: "export-1", fingerprint });

        const missingKey = await apiFetch(`${base}/v2/recovery/partitions/global/quarantine`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            expectedFingerprint: fingerprint,
            confirmation: "quarantine_and_start_fresh",
          }),
        });
        expect(missingKey.status).toBe(400);
        expect(missingKey.headers.get("content-type")).toBe("application/problem+json");
        expect(await missingKey.json()).toMatchObject({
          code: "idempotency_key_required",
          fieldErrors: { "Idempotency-Key": ["required for create operations"] },
        });

        const quarantine = await apiFetch(`${base}/v2/recovery/partitions/global/quarantine`, {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": "quarantine-1" },
          body: JSON.stringify({
            expectedFingerprint: fingerprint,
            confirmation: "quarantine_and_start_fresh",
          }),
        });
        expect(quarantine.status).toBe(200);
        expect(await quarantine.json()).toMatchObject({
          operationId: "00000000-0000-4000-8000-000000000001",
          newEpoch: "epoch-2",
        });
        expect(quarantineInputs).toEqual([
          {
            expectedFingerprint: fingerprint,
            confirmation: "quarantine_and_start_fresh",
            idempotencyKey: "quarantine-1",
          },
        ]);
      },
      undefined,
      {
        recoveryInspectPartition: async (partition) => {
          inspectedPartitions.push(partition);
          return {
            ...inspection,
            partition,
            evidenceRefs: [`recovery:${partition}:${fingerprint}`],
          };
        },
        recoveryValidatePartition: async (partition) => ({
          ...inspection,
          partition,
          evidenceRefs: [`recovery:${partition}:${fingerprint}`],
          projectionStatus: [
            { name: "setup", status: "invalid", detail: "semantic replay failed" },
          ],
        }),
        recoveryExportPartition: async (partition) => ({
          schemaVersion: 1,
          exportId: "export-1",
          partition,
          fingerprint,
          bundlePath: "/daemon-owned/recovery/export-1",
          manifestSha256: "b".repeat(64),
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
        recoveryQuarantinePartition: async (partition, input) => {
          quarantineInputs.push(input);
          return {
            schemaVersion: 1,
            operationId: "00000000-0000-4000-8000-000000000001",
            partition,
            previousFingerprint: fingerprint,
            quarantineArtifactId: "quarantine-1",
            quarantinePath: "/daemon-owned/quarantine/quarantine-1",
            newEpoch: "epoch-2",
            completedAt: "2026-01-01T00:00:02.000Z",
          };
        },
      },
    );
    expect(inspectedPartitions).toEqual(["global", "project:prj-1"]);
  });

  it("preserves typed service problems and treats invalid service output as an internal fault", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(
      daemon,
      async (base) => {
        const headers = { authorization: `Bearer ${token}` };
        const typed = await apiFetch(`${base}/v2/setup/jobs/job-corrupt`, { headers });
        expect(typed.status).toBe(503);
        expect(typed.headers.get("content-type")).toBe("application/problem+json");
        expect(await typed.json()).toEqual({
          code: "journal_recovery_required",
          message: "global journal requires recovery",
          retryable: false,
          fieldErrors: {},
          requiredActions: ["inspect_recovery", "export_recovery", "quarantine_partition"],
          evidenceRefs: ["recovery:global:abc"],
          context: {},
        });

        const invalidOutput = await apiFetch(`${base}/harnesses`, { headers });
        expect(invalidOutput.status).toBe(500);
        expect(invalidOutput.headers.get("content-type")).toBe("application/problem+json");
        expect(await invalidOutput.json()).toEqual({
          code: "invalid_service_response",
          message: "harnesses returned a response that violates its schema",
          retryable: false,
          fieldErrors: {},
          requiredActions: [],
          evidenceRefs: [],
          context: {},
        });
      },
      undefined,
      {
        setupJobStatus: async () => {
          throw Object.assign(new Error("global journal requires recovery"), {
            status: 503,
            code: "journal_recovery_required",
            retryable: false,
            requiredActions: ["inspect_recovery", "export_recovery", "quarantine_partition"],
            evidenceRefs: ["recovery:global:abc"],
          });
        },
        harnesses: async () => ({ harnesses: "wrong" }),
      },
    );
  });

  it("projects a ConfigParseError as a typed 422 config_invalid problem, not a generic 500 (v3.0.3 S1)", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(
      daemon,
      async (base) => {
        const response = await apiFetch(`${base}/harnesses`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(422);
        expect(response.headers.get("content-type")).toBe("application/problem+json");
        const body = (await response.json()) as {
          code: string;
          retryable: boolean;
          message: string;
          requiredActions: string[];
        };
        expect(body.code).toBe("config_invalid");
        expect(body.retryable).toBe(false);
        expect(body.message).toContain("invalid Claudexor YAML config");
        expect(body.requiredActions.some((a) => a.includes("config.yaml"))).toBe(true);
      },
      undefined,
      {
        harnesses: async () => {
          // The exact duck-typed shape ConfigParseError carries (config pkg).
          throw Object.assign(
            new Error("invalid Claudexor YAML config at /tmp/x/config.yaml: unknown key(s): z"),
            {
              status: 422,
              code: "config_invalid",
              retryable: false,
              requiredActions: [
                "inspect and fix /tmp/x/config.yaml against the current schema",
                "or restore it from the newest sibling backup (/tmp/x/config.yaml.bak-*)",
              ],
            },
          );
        },
      },
    );
  });

  it("forwards an exact auth-readiness request without invoking the aggregate harness service", async () => {
    const { daemon } = fakeDaemon();
    const seen: unknown[] = [];
    let aggregateCalls = 0;
    await withDaemonServer(
      daemon,
      async (base) => {
        const response = await apiFetch(`${base}/v2/harnesses/claude/auth-readiness`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ authRequest: "subscription", source: "native_session" }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          harnessId: "claude",
          authRequest: "subscription",
          requestedSource: "native_session",
          observedAt: "2026-01-01T00:00:00.000Z",
          readiness: {
            source: "native_session",
            availability: "available",
            verification: "passed",
          },
        });
        expect(seen).toEqual([
          {
            harnessId: "claude",
            request: { authRequest: "subscription", source: "native_session" },
          },
        ]);
        expect(aggregateCalls).toBe(0);
      },
      undefined,
      {
        harnesses: async () => {
          aggregateCalls += 1;
          return { harnesses: [] };
        },
        authReadiness: async (input) => {
          seen.push(input);
          return {
            harnessId: "claude",
            authRequest: "subscription",
            requestedSource: "native_session",
            observedAt: "2026-01-01T00:00:00.000Z",
            readiness: {
              source: "native_session",
              availability: "available",
              verification: "passed",
            },
          };
        },
      },
    );
  });

  it("rejects auth-readiness query knobs, extra body fields, and the unversioned alias", async () => {
    const { daemon } = fakeDaemon();
    let serviceCalls = 0;
    await withDaemonServer(
      daemon,
      async (base) => {
        const headers = {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        };
        const validBody = JSON.stringify({ authRequest: "subscription", source: "native_session" });

        const query = await apiFetch(`${base}/v2/harnesses/claude/auth-readiness?fresh=true`, {
          method: "POST",
          headers,
          body: validBody,
        });
        expect(query.status).toBe(400);
        expect(query.headers.get("content-type")).toBe("application/problem+json");
        expect(await query.json()).toMatchObject({ code: "invalid_request" });

        const extraBody = await apiFetch(`${base}/v2/harnesses/claude/auth-readiness`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            authRequest: "subscription",
            source: "native_session",
            fresh: true,
          }),
        });
        expect(extraBody.status).toBe(400);
        expect(extraBody.headers.get("content-type")).toBe("application/problem+json");
        expect(await extraBody.json()).toMatchObject({ code: "invalid_request" });

        const alias = await globalThis.fetch(`${base}/harnesses/claude/auth-readiness`, {
          method: "POST",
          headers,
          body: validBody,
        });
        expect(alias.status).toBe(404);
        expect(await alias.json()).toMatchObject({ code: "route_not_found" });
        expect(serviceCalls).toBe(0);
      },
      undefined,
      {
        authReadiness: async () => {
          serviceCalls += 1;
          throw new Error("boundary validation did not run");
        },
      },
    );
  });

  it("preserves typed auth-readiness service problems", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(
      daemon,
      async (base) => {
        const response = await apiFetch(`${base}/v2/harnesses/claude/auth-readiness`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ authRequest: "subscription", source: "native_session" }),
        });
        expect(response.status).toBe(503);
        expect(response.headers.get("content-type")).toBe("application/problem+json");
        expect(await response.json()).toEqual({
          code: "auth_readiness_probe_failed",
          message: "native status transport unavailable",
          retryable: true,
          fieldErrors: {},
          requiredActions: ["retry_auth_readiness_refresh"],
          evidenceRefs: ["doctor:claude:native_session"],
          context: {},
        });
      },
      undefined,
      {
        authReadiness: async () => {
          throw Object.assign(new Error("native status transport unavailable"), {
            status: 503,
            code: "auth_readiness_probe_failed",
            retryable: true,
            requiredActions: ["retry_auth_readiness_refresh"],
            evidenceRefs: ["doctor:claude:native_session"],
          });
        },
      },
    );
  });

  it("fails closed when auth-readiness service output violates the response schema", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(
      daemon,
      async (base) => {
        const response = await apiFetch(`${base}/v2/harnesses/claude/auth-readiness`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ authRequest: "subscription", source: "native_session" }),
        });
        expect(response.status).toBe(500);
        expect(response.headers.get("content-type")).toBe("application/problem+json");
        expect(await response.json()).toEqual({
          code: "invalid_service_response",
          message: "authReadiness returned a response that violates its schema",
          retryable: false,
          fieldErrors: {},
          requiredActions: [],
          evidenceRefs: [],
          context: {},
        });
      },
      undefined,
      {
        authReadiness: async () => ({
          harnessId: "claude",
          authRequest: "subscription",
          requestedSource: "native_session",
          observedAt: "2026-01-01T00:00:00.000Z",
          readiness: {
            source: "api_key_env",
            availability: "available",
            verification: "passed",
          },
        }),
      },
    );
  });

  it("flushes an immediate connected frame while an active setup stream is quiet", async () => {
    const { daemon } = fakeDaemon();
    const current = setupJobFixture();
    await withDaemonServer(
      daemon,
      async (base) => {
        const abort = new AbortController();
        const response = await apiFetch(`${base}/v2/setup/jobs/${current.jobId}/events`, {
          headers: { authorization: `Bearer ${token}` },
          signal: abort.signal,
        });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toContain(": connected");
        abort.abort();
      },
      undefined,
      {
        setupJobStatus: async () => current,
        setupJobEvents: async () => [],
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
      const res = await apiFetch(`${base}/runs/run-d1/artifacts/final/metadata.json`, {
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
      const start = await apiFetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: "safe", mode: "ask", tests: [`echo ${secret}`] }),
      });
      expect(start.status).toBe(400);
      expect(await start.text()).toContain("secret-like value is not accepted");
    });
  });

  it("rejects a secret-like value inside the PROMPT itself on POST /runs and POST /threads/:id/turns (hard block, 400)", async () => {
    const { daemon } = fakeDaemon();
    const secret = "sk-" + "d".repeat(24);
    await withDaemonServer(daemon, async (base) => {
      const start = await apiFetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: `use ${secret} to auth`, mode: "agent" }),
      });
      expect(start.status).toBe(400);
      const body = (await start.json()) as { message: string; code?: string };
      expect(body.message).toContain("durable run artifacts");
      // The machine-readable class rides the envelope, not just prose.
      expect(body.code).toBe("inline_secret_rejected");
    });

    // The thread-turn ingress (REPL/app path): the fence runs BEFORE thread
    // resolution, so a minimal threads-capable server proves the block
    // without a real thread. createThreadTurn must never be reached.
    let turnCreated = 0;
    await withDaemonServer(
      daemon,
      async (base) => {
        const turn = await apiFetch(`${base}/threads/th-any/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: `retry with ${secret}` }),
        });
        expect(turn.status).toBe(400);
        const turnBody = (await turn.json()) as { message: string; code?: string };
        expect(turnBody.message).toContain("durable run artifacts");
        expect(turnBody.code).toBe("inline_secret_rejected");
        expect(turnCreated).toBe(0);
      },
      undefined,
      {
        threadDetail: async () => ({ thread: {}, sessions: [], turns: [] }),
        createThreadTurn: async () => {
          turnCreated += 1;
          return {};
        },
      },
    );
  });

  it("fronts the durable daemon registry for start/list/cancel and tails events.jsonl", async () => {
    const { daemon, cancelled, record } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      const start = await apiFetch(`${base}/runs`, {
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
        await apiFetch(`${base}/runs`, { headers: { authorization: `Bearer ${token}` } })
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

      const sse = await apiFetch(`${base}/runs/run-d1/events`, {
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
      const cancelTerminal = await apiFetch(`${base}/runs/run-d1/control`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ control: { kind: "cancel" } }),
      });
      expect(cancelTerminal.status).toBe(409);
      expect(cancelled).toEqual([]);
      // …and applied only while the job is actually active.
      record.state = "running";
      const cancel = await apiFetch(`${base}/runs/run-d1/control`, {
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
        const start = await apiFetch(`${base}/runs`, {
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
    const server = new DaemonControlApiServer({
      ...readyIdentity,
      token,
      daemon,
      pollMs: 1,
      runStartTimeoutMs: 5,
    });
    const { host, port } = await server.start();
    try {
      const res = await apiFetch(`http://${host}:${port}/runs`, {
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

  it("thread apply gates every undelivered contribution, so a later success cannot launder a blocked run (INV-113)", async () => {
    const dir = reapMk(join(tmpdir(), "claudexor-thread-gate-"));
    const blockedRunDir = join(dir, "run-blocked");
    const headRunDir = join(dir, "run-head");
    const { mkdirSync: mkd } = await import("node:fs");
    const patchText = "diff --git a/x b/x\n";
    const seedRun = (runDir: string, status: "blocked" | "success") => {
      mkd(join(runDir, "arbitration"), { recursive: true });
      mkd(join(runDir, "context"), { recursive: true });
      mkd(join(runDir, "final"), { recursive: true });
      writeFileSync(join(runDir, "final", "patch.diff"), patchText);
      writeFileSync(
        join(runDir, "final", "work_product.yaml"),
        `id: wp-${status}\nkind: patch\nsource_task_id: task-${status}\nmeta:\n  patch_sha256: ${sha256(patchText)}\n`,
      );
      writeFileSync(
        join(runDir, "context", "task.yaml"),
        [
          "schema_version: 2",
          `task_id: task-${status}`,
          "created_at: 2026-07-15T00:00:00.000Z",
          "repo:",
          `  root: ${JSON.stringify(dir)}`,
          "  base_ref: HEAD",
          "mode:",
          "  kind: agent",
          "user_intent:",
          "  raw: thread gate test",
          "tests:",
          "  commands: []",
          "",
        ].join("\n"),
      );
      // D8: a "blocked" seed is a succeeded lifecycle with review=blocked (a
      // needs-decision terminal); a "success" seed is succeeded + review approved.
      const factsYaml =
        status === "success"
          ? "  lifecycle: succeeded\n  review: approved\n  checks: passed\n  noChanges: false\n  reason: null\n"
          : "  lifecycle: succeeded\n  review: blocked\n  checks: not_configured\n  noChanges: false\n  reason: review_blocked\n";
      writeFileSync(
        join(runDir, "arbitration", "decision.yaml"),
        `winner: a01\nfacts:\n${factsYaml}final_verify:\n  attempted: true\n  applied_cleanly: true\n  gates_passed: true\n`,
      );
    };
    seedRun(blockedRunDir, "blocked");
    seedRun(headRunDir, "success");
    const now = new Date().toISOString();
    const threadDelivery = {
      mode: "apply" as const,
      applied: true,
      finalVerify: {
        attempted: true,
        base_sha: "target-preimage-1",
        applied_cleanly: true,
        gates_passed: true,
        gates: [{ id: "thread-gate", status: "pass" }],
        duration_ms: 7,
        reason: null,
      },
      targetPreimageSha: "target-preimage-1",
    };
    const threadObj: Record<string, unknown> = {
      schema_version: 2,
      id: "th-gate",
      created_at: now,
      updated_at: now,
      repo: { root: dir, base_ref: "HEAD" },
      title: "gated thread",
      mode: "agent",
      workspace: { mode: "isolated", worktree_path: join(dir, "tree"), base_sha: "abc" },
      auth_preference: "auto",
      primary_harness: null,
      eligible_harnesses: [],
      routingGoal: "auto",
      run_ids: ["run-blocked", "run-head"],
      head_run_id: "run-head",
      state: "active",
    };
    let applied = 0;
    const operatorDecisions = new Map<string, ControlOperatorDecisionRecord>();
    const daemon: DaemonFacadeClient = {
      async enqueue() {
        return { id: "j", state: "queued" };
      },
      async status() {
        return { id: "job-head", state: "succeeded", runId: "run-head", runDir: headRunDir };
      },
      async list() {
        return [
          {
            id: "job-blocked",
            state: "blocked",
            runId: "run-blocked",
            runDir: blockedRunDir,
          },
          { id: "job-head", state: "succeeded", runId: "run-head", runDir: headRunDir },
        ];
      },
      async cancel() {
        return { ok: true };
      },
    };
    const server = new DaemonControlApiServer({
      ...readyIdentity,
      token,
      daemon,
      services: {
        ...inMemoryDeliveryServices(),
        operatorDecision: (runId) => operatorDecisions.get(runId) ?? null,
        recordOperatorDecision: (runId, _params, decision) => {
          operatorDecisions.set(runId, decision);
          return decision;
        },
        threadDetail: async () => ({ thread: threadObj, sessions: [], turns: [] }),
        applyThread: async () => {
          applied += 1;
          return {
            applied: true,
            status: "applied",
            headMoved: false,
            detail: null,
            delivery: threadDelivery,
          };
        },
      },
    });
    const { host, port } = await server.start();
    const base = `http://${host}:${port}`;
    try {
      const blockedRes = await apiFetch(`${base}/threads/th-gate/apply`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: "apply" }),
      });
      expect(blockedRes.status).toBe(409);
      expect(((await blockedRes.json()) as { code: string }).code).toBe("thread_run_unverified");
      expect(applied).toBe(0);

      // A typed decision for the earlier blocked contribution unblocks the
      // accumulated delivery; deciding only the successful HEAD would not.
      operatorDecisions.set("run-blocked", {
        action: "accept_risk",
        findingIds: [],
        acceptedRisks: ["test owner accepted"],
        patchSha256: sha256(patchText),
        decidedAt: now,
      });
      const okRes = await apiFetch(`${base}/threads/th-gate/apply`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Idempotency-Key": "thread-apply-1" },
        body: JSON.stringify({ mode: "apply" }),
      });
      expect(okRes.status).toBe(200);
      const okBody = (await okRes.json()) as {
        delivery: {
          finalVerify: unknown;
          targetPreimageSha: string;
        };
      };
      expect(okBody.delivery.finalVerify).toEqual(threadDelivery.finalVerify);
      expect(okBody.delivery.targetPreimageSha).toBe(threadDelivery.targetPreimageSha);
      expect(applied).toBe(1);

      const replay = await apiFetch(`${base}/threads/th-gate/apply`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Idempotency-Key": "thread-apply-1" },
        body: JSON.stringify({ mode: "apply" }),
      });
      expect(replay.status).toBe(200);
      const replayBody = (await replay.json()) as typeof okBody;
      expect(replayBody.delivery.finalVerify).toEqual(okBody.delivery.finalVerify);
      expect(replayBody.delivery.targetPreimageSha).toBe(okBody.delivery.targetPreimageSha);
      expect(applied).toBe(1);

      // Once the prefix is durably delivered, it is not re-gated on a later
      // apply. Only the suffix after this watermark remains eligible work.
      (threadObj.workspace as Record<string, unknown>).delivered_through_run_id = "run-blocked";
      operatorDecisions.clear();
      const watermarkRes = await apiFetch(`${base}/threads/th-gate/apply`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: "apply" }),
      });
      expect(watermarkRes.status).toBe(200);
      expect(applied).toBe(2);
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const activeState of ["queued", "running"] as const) {
    it(`refuses thread apply with thread_busy while a mutating turn is ${activeState}`, async () => {
      const now = new Date().toISOString();
      const threadObj = {
        schema_version: 2,
        id: "th-busy",
        created_at: now,
        updated_at: now,
        repo: { root: tmpdir(), base_ref: "HEAD" },
        title: "busy thread",
        mode: "agent",
        workspace: { mode: "isolated", worktree_path: "/tmp/tree", base_sha: "abc" },
        auth_preference: "auto",
        primary_harness: null,
        eligible_harnesses: [],
        routingGoal: "auto",
        run_ids: [],
        head_run_id: null,
        state: "active",
      };
      let applied = 0;
      const daemon: DaemonFacadeClient = {
        async enqueue() {
          return { id: "job-active", state: activeState };
        },
        async status() {
          return { id: "job-active", state: activeState };
        },
        async list() {
          return [
            {
              id: "job-active",
              state: activeState,
              params: { threadId: "th-busy", mode: "agent" },
            },
          ];
        },
        async cancel() {
          return { ok: true };
        },
      };
      const server = new DaemonControlApiServer({
        ...readyIdentity,
        token,
        daemon,
        services: {
          threadDetail: async () => ({ thread: threadObj, sessions: [], turns: [] }),
          applyThread: async () => {
            applied += 1;
            return { applied: true, status: "applied" };
          },
        },
      });
      const { host, port } = await server.start();
      try {
        const response = await apiFetch(`http://${host}:${port}/threads/th-busy/apply`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ mode: "apply" }),
        });
        expect(response.status).toBe(409);
        expect(((await response.json()) as { code: string }).code).toBe("thread_busy");
        expect(applied).toBe(0);
      } finally {
        await server.stop();
      }
    });
  }

  for (const activeState of ["queued", "running"] as const) {
    it(`refuses manual run apply with thread_busy while a mutating turn is ${activeState}`, async () => {
      const { daemon, record } = fakeDaemon();
      record.params = {
        ...(record.params as Record<string, unknown>),
        threadId: "th-run-apply-busy",
      };
      const sentinel = join(record.runDir as string, "x");
      writeFileSync(sentinel, "user state\n");
      const before = readFileSync(sentinel, "utf8");
      let deliveryBegun = 0;
      const busyDaemon: DaemonFacadeClient = {
        ...daemon,
        async list() {
          return [
            record,
            {
              id: `job-active-${activeState}`,
              state: activeState,
              params: { threadId: "th-run-apply-busy", mode: "agent" },
            },
          ];
        },
      };
      try {
        await withDaemonServer(
          busyDaemon,
          async (base) => {
            const response = await apiFetch(`${base}/runs/run-d1/apply`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}` },
              body: JSON.stringify({ mode: "apply" }),
            });
            expect(response.status).toBe(409);
            expect(((await response.json()) as { code: string }).code).toBe("thread_busy");
            expect(deliveryBegun).toBe(0);
            expect(readFileSync(sentinel, "utf8")).toBe(before);
          },
          undefined,
          {
            beginDelivery: async () => {
              deliveryBegun += 1;
              return { id: "unexpected-delivery", state: "running", reused: false };
            },
            completeDelivery: async () => undefined,
            failDelivery: async () => undefined,
          },
        );
      } finally {
        rmSync(record.runDir as string, { recursive: true, force: true });
      }
    });
  }

  for (const activeState of ["queued", "running"] as const) {
    for (const action of ["accept_clean_patch", "revert_run"] as const) {
      it(`refuses ${action} with thread_busy while a mutating turn is ${activeState}`, async () => {
        const { daemon, record } = fakeDaemon();
        record.params = {
          ...(record.params as Record<string, unknown>),
          threadId: "th-decision-busy",
        };
        let deliveryBegun = 0;
        const busyDaemon: DaemonFacadeClient = {
          ...daemon,
          async list() {
            return [
              record,
              {
                id: `job-active-${activeState}`,
                state: activeState,
                params: { threadId: "th-decision-busy", mode: "agent" },
              },
            ];
          },
        };
        await withDaemonServer(
          busyDaemon,
          async (base) => {
            const response = await apiFetch(`${base}/runs/run-d1/decision`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "Idempotency-Key": `decision-${action}-${activeState}`,
              },
              body: JSON.stringify({ action }),
            });
            expect(response.status).toBe(409);
            expect(((await response.json()) as { code: string }).code).toBe("thread_busy");
            expect(deliveryBegun).toBe(0);
          },
          undefined,
          {
            beginDelivery: async () => {
              deliveryBegun += 1;
              return { id: "unexpected-delivery", state: "running", reused: false };
            },
            completeDelivery: async () => undefined,
            failDelivery: async () => undefined,
          },
        );
      });
    }
  }

  for (const taskContractState of [
    "missing",
    "malformed",
    "omitted_tests",
    "omitted_commands",
  ] as const) {
    it(`refuses manual apply when the task contract is ${taskContractState}`, async () => {
      const { daemon, record } = fakeDaemon();
      const taskPath = join(record.runDir as string, "context", "task.yaml");
      if (taskContractState === "missing") rmSync(taskPath, { force: true });
      else if (taskContractState === "malformed") writeFileSync(taskPath, "schema_version: [\n");
      else {
        const task = parseYaml(readFileSync(taskPath, "utf8")) as Record<string, unknown>;
        if (taskContractState === "omitted_tests") delete task["tests"];
        else delete (task["tests"] as Record<string, unknown>)["commands"];
        writeFileSync(taskPath, stringifyYaml(task));
      }
      await withDaemonServer(
        daemon,
        async (base) => {
          const response = await apiFetch(`${base}/runs/run-d1/apply`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ mode: "apply" }),
          });
          expect(response.status).toBe(409);
          expect(((await response.json()) as { code: string }).code).toBe(
            "task_contract_unverifiable",
          );
        },
        undefined,
        inMemoryDeliveryServices(),
      );
    });
  }

  it("allows manual apply when a valid task contract explicitly has no test commands", async () => {
    const { daemon, record } = fakeDaemon();
    const project = reapMk(join(tmpdir(), "claudexor-empty-gates-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: project });
      execFileSync("git", ["config", "user.name", "Claudexor Test"], { cwd: project });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
      writeFileSync(join(project, "x"), "old\n");
      execFileSync("git", ["add", "x"], { cwd: project });
      execFileSync("git", ["commit", "-qm", "base"], { cwd: project });

      record.params = {
        ...(record.params as Record<string, unknown>),
        scope: { kind: "project", root: project, context: "auto" },
      };
      const taskPath = join(record.runDir as string, "context", "task.yaml");
      writeFileSync(
        taskPath,
        readFileSync(taskPath, "utf8").replace(
          JSON.stringify(record.runDir),
          JSON.stringify(project),
        ),
      );
      const patch = [
        "diff --git a/x b/x",
        "--- a/x",
        "+++ b/x",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n");
      writeFileSync(join(record.runDir as string, "final", "patch.diff"), patch);
      writeFileSync(
        join(record.runDir as string, "final", "work_product.yaml"),
        `id: wp-test\nkind: patch\nsource_task_id: task-d1\nmeta:\n  patch_sha256: ${sha256(patch)}\n`,
      );

      await withDaemonServer(
        daemon,
        async (base) => {
          const response = await apiFetch(`${base}/runs/run-d1/apply`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ mode: "apply" }),
          });
          expect(response.status).toBe(200);
          expect(readFileSync(join(project, "x"), "utf8")).toBe("new\n");
          // Round-15 #2 pin (D8/V8): a successful apply durably flips the
          // MUTABLE delivery state (final/delivery_state.yaml), so retention
          // stops classifying the delivered patch as actionable (and Revert
          // becomes offerable). work_product.yaml stays immutable.
          const ds = parseYaml(
            readFileSync(join(record.runDir as string, "final", "delivery_state.yaml"), "utf8"),
          ) as { applyState?: string };
          expect(ds.applyState).toBe("applied");
        },
        undefined,
        inMemoryDeliveryServices(),
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("reflects a successful apply in the GET /runs summary IMMEDIATELY (delivery_state is in the cache fingerprint) [B7]", async () => {
    const { daemon, record } = fakeDaemon();
    const project = reapMk(join(tmpdir(), "claudexor-b7-apply-cache-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: project });
      execFileSync("git", ["config", "user.name", "Claudexor Test"], { cwd: project });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
      writeFileSync(join(project, "x"), "old\n");
      execFileSync("git", ["add", "x"], { cwd: project });
      execFileSync("git", ["commit", "-qm", "base"], { cwd: project });

      record.params = {
        ...(record.params as Record<string, unknown>),
        scope: { kind: "project", root: project, context: "auto" },
      };
      const taskPath = join(record.runDir as string, "context", "task.yaml");
      writeFileSync(
        taskPath,
        readFileSync(taskPath, "utf8").replace(
          JSON.stringify(record.runDir),
          JSON.stringify(project),
        ),
      );
      const patch = [
        "diff --git a/x b/x",
        "--- a/x",
        "+++ b/x",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n");
      writeFileSync(join(record.runDir as string, "final", "patch.diff"), patch);
      writeFileSync(
        join(record.runDir as string, "final", "work_product.yaml"),
        `id: wp-test\nkind: patch\nsource_task_id: task-d1\nmeta:\n  patch_sha256: ${sha256(patch)}\n`,
      );

      await withDaemonServer(
        daemon,
        async (base) => {
          const listApplyState = async (): Promise<string | undefined> => {
            const body = (await (
              await apiFetch(`${base}/runs`, { headers: { authorization: `Bearer ${token}` } })
            ).json()) as { runs: { runId: string; result?: { applyState?: string } }[] };
            return body.runs.find((r) => r.runId === "run-d1")?.result?.applyState;
          };
          // First GET populates the summary-list cache with not_applied.
          expect(await listApplyState()).toBe("not_applied");
          const response = await apiFetch(`${base}/runs/run-d1/apply`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ mode: "apply" }),
          });
          expect(response.status).toBe(200);
          // The apply route writes ONLY delivery_state.yaml; the summary list must
          // still reflect it immediately (regression: it was cached stale because
          // delivery_state.yaml was absent from summaryFingerprint).
          expect(await listApplyState()).toBe("applied");
        },
        undefined,
        inMemoryDeliveryServices(),
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  // Shared git-project fixture for the delivery-truth apply tests (QA-021 / #26).
  async function withAppliableProject(
    fn: (base: string, project: string, record: DaemonRunRecord) => Promise<void>,
  ): Promise<void> {
    const { daemon, record } = fakeDaemon();
    const project = reapMk(join(tmpdir(), "claudexor-delivery-truth-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: project });
      execFileSync("git", ["config", "user.name", "Claudexor Test"], { cwd: project });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
      writeFileSync(join(project, "x"), "old\n");
      execFileSync("git", ["add", "x"], { cwd: project });
      execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
      record.params = {
        ...(record.params as Record<string, unknown>),
        scope: { kind: "project", root: project, context: "auto" },
      };
      const taskPath = join(record.runDir as string, "context", "task.yaml");
      writeFileSync(
        taskPath,
        readFileSync(taskPath, "utf8").replace(
          JSON.stringify(record.runDir),
          JSON.stringify(project),
        ),
      );
      const patch = [
        "diff --git a/x b/x",
        "--- a/x",
        "+++ b/x",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n");
      writeFileSync(join(record.runDir as string, "final", "patch.diff"), patch);
      writeFileSync(
        join(record.runDir as string, "final", "work_product.yaml"),
        `id: wp-test\nkind: patch\nsource_task_id: task-d1\nmeta:\n  patch_sha256: ${sha256(patch)}\n`,
      );
      await withDaemonServer(
        daemon,
        async (base) => fn(base, project, record),
        undefined,
        inMemoryDeliveryServices(),
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }

  it("replaying apply on an already-delivered run is a typed idempotent no-op, not a 409 conflict (#26)", async () => {
    await withAppliableProject(async (base, project) => {
      const apply = () =>
        apiFetch(`${base}/runs/run-d1/apply`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ mode: "apply" }),
        });
      // apiFetch injects a UNIQUE Idempotency-Key per call, so the second apply
      // is a fresh command (the exact #26 repro: separate CLI invocations).
      const first = await apply();
      expect(first.status).toBe(200);
      expect(((await first.json()) as { applied?: boolean }).applied).toBe(true);
      expect(readFileSync(join(project, "x"), "utf8")).toBe("new\n");

      const second = await apply();
      expect(second.status).toBe(200); // was 409 "patch does not apply"
      const receipt = (await second.json()) as {
        applied: boolean;
        treeMutated?: boolean;
        detail?: string;
      };
      expect(receipt.applied).toBe(true);
      expect(receipt.treeMutated).toBe(false);
      expect(receipt.detail).toMatch(/already applied/i);
      // No second physical delivery: the file is unchanged.
      expect(readFileSync(join(project, "x"), "utf8")).toBe("new\n");
    });
  });

  it("apply --dry-run after delivery reports the already-applied no-op instead of 'patch does not apply' (#26)", async () => {
    await withAppliableProject(async (base) => {
      await apiFetch(`${base}/runs/run-d1/apply`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: "apply" }),
      });
      const check = await apiFetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      expect(check.status).toBe(200); // was 409 fresh-final-check / patch-does-not-apply
      const body = (await check.json()) as { ok: boolean; stderr: string };
      expect(body.ok).toBe(true);
      expect(body.stderr).toMatch(/already applied/i);
    });
  });

  it("GET /runs/:id applyEligibility is already_applied after a manual apply, never 'rerun a fresh check' (QA-021)", async () => {
    await withAppliableProject(async (base) => {
      await apiFetch(`${base}/runs/run-d1/apply`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: "apply" }),
      });
      const detail = (await (
        await apiFetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as {
        applyEligibility: {
          eligible: boolean;
          state: string;
          reason: string;
          requiredAction: string | null;
        };
        summary: { result: { applyState: string } };
      };
      expect(detail.summary.result.applyState).toBe("applied");
      expect(detail.applyEligibility.eligible).toBe(false);
      expect(detail.applyEligibility.state).toBe("already_applied");
      expect(detail.applyEligibility.requiredAction).toBeNull();
      expect(detail.applyEligibility.reason).not.toMatch(/fresh final check|re-?run/i);
    });
  });

  it("an authorized accept_risk on a blocked run makes GET applyEligibility eligible (JIT verify at apply), not a dead end (QA-032)", async () => {
    const { daemon, record } = fakeDaemon();
    // A review-blocked run skips FinalVerifier by construction: final_verify is null.
    writeFileSync(
      join(record.runDir as string, "arbitration", "decision.yaml"),
      [
        "winner: a01",
        "facts:",
        "  lifecycle: succeeded",
        "  review: blocked",
        "  checks: passed",
        "  noChanges: false",
        "  reason: review_blocked",
        "verification_basis: none",
        "final_verify: null",
        "",
      ].join("\n"),
    );
    await withDaemonServer(daemon, async (base) => {
      // Before the decision: dead-ended (needs review / fresh check).
      const before = (await (
        await apiFetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as {
        applyEligibility: { eligible: boolean; state: string; requiredAction: string | null };
      };
      expect(before.applyEligibility.eligible).toBe(false);
      // Remediation no longer loops back to running a review that already ran.
      expect(before.applyEligibility.requiredAction).not.toMatch(/run a review/i);

      const decision = await apiFetch(`${base}/runs/run-d1/decision`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Idempotency-Key": "qa032-accept-risk" },
        body: JSON.stringify({ action: "accept_risk" }),
      });
      expect(decision.status).toBe(200);
      const ack = (await decision.json()) as { message: string };
      expect(ack.message).toMatch(/fresh final check/i);
      expect(ack.message).not.toMatch(/review queue/i);

      const after = (await (
        await apiFetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as {
        applyEligibility: { eligible: boolean; state: string; requiredAction: string | null };
      };
      expect(after.applyEligibility.eligible).toBe(true); // was false: fresh-check dead end
      expect(after.applyEligibility.state).toBe("verify_pending");
      expect(after.applyEligibility.requiredAction).toBeNull();
    });
  });

  it("a needs_input work_state on the decision facts lands in the apply gate via applyGateInputFor: NOT applyable (INV-116, B-1)", async () => {
    const { daemon, record } = fakeDaemon();
    // A CLEAN review + passing final verify — the ONLY blocker is the D-16
    // work_state the model attested. If the gate ignored facts.work_state this
    // run would read as fully applyable (the pre-B-1 defect).
    writeFileSync(
      join(record.runDir as string, "arbitration", "decision.yaml"),
      [
        "winner: a01",
        "facts:",
        "  lifecycle: succeeded",
        "  review: approved",
        "  checks: passed",
        "  noChanges: false",
        "  reason: input_required",
        "  work_state:",
        "    state: needs_input",
        "    source: constrained",
        "    required_inputs:",
        "      - kind: decision",
        "        locator: null",
        "        description: which database backend?",
        "verification_basis: none",
        "final_verify:",
        "  attempted: true",
        "  applied_cleanly: true",
        "  gates_passed: true",
        "",
      ].join("\n"),
    );
    await withDaemonServer(daemon, async (base) => {
      // GET /runs/:id projects the same gate — a typed needs_input disposition.
      const detail = (await (
        await apiFetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as {
        applyEligibility: { eligible: boolean; state: string; reason: string } | null;
      };
      expect(detail.applyEligibility?.eligible).toBe(false);
      expect(detail.applyEligibility?.state).toBe("needs_input");
      expect(detail.applyEligibility?.reason ?? "").toMatch(/needs more input/i);

      // The pre-apply gate boundary (POST /apply/check → applyGateError →
      // applyGateInputFor) refuses the same run with the typed veto (409).
      const check = await apiFetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ target: { kind: "project", root: record.runDir } }),
      });
      expect(check.status).toBe(409);
      expect(await check.text()).toMatch(/needs more input/i);
    });
  });

  it("POST /runs/:id/decision REJECTS accept_risk on a work_state-only needs_input veto with a typed problem (no false ACK)", async () => {
    // D-16 wave-1 fix: a work_state veto is non-overridable. The decision endpoint
    // previously ACKed accept_risk ("Apply is now available") because needsDecision
    // folded work_state in — then the gate refused. Now the endpoint rejects the
    // override up front with a typed problem, so there is no false ACK to hide the
    // required input.
    const { daemon, record } = fakeDaemon();
    writeFileSync(
      join(record.runDir as string, "arbitration", "decision.yaml"),
      [
        "winner: a01",
        "facts:",
        "  lifecycle: succeeded",
        "  review: approved",
        "  checks: passed",
        "  noChanges: false",
        "  reason: input_required",
        "  work_state:",
        "    state: needs_input",
        "    source: constrained",
        "    required_inputs:",
        "      - kind: decision",
        "        locator: null",
        "        description: which database backend?",
        "verification_basis: none",
        "final_verify:",
        "  attempted: true",
        "  applied_cleanly: true",
        "  gates_passed: true",
        "",
      ].join("\n"),
    );
    await withDaemonServer(daemon, async (base) => {
      const decision = await apiFetch(`${base}/runs/run-d1/decision`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Idempotency-Key": "workstate-refuse-1" },
        body: JSON.stringify({ action: "accept_risk" }),
      });
      expect(decision.status).toBe(409);
      // 4xx bodies are ControlProblem: the typed `code` + the human `message`.
      const body = (await decision.json()) as { message: string; code?: string };
      expect(body.code).toBe("work_state_needs_input");
      expect(body.message).toMatch(/needs more input|cannot supply the missing input/i);
      // The false ACK phrasing is NOT present.
      expect(body.message).not.toMatch(/Apply is now available/i);
    });
  });

  it("409s thread apply when the recorded head run was PRUNED from daemon history (state unknowable)", async () => {
    const dir = reapMk(join(tmpdir(), "claudexor-capi-prune-"));
    const token = "tok";
    const now = new Date().toISOString();
    const threadObj = {
      id: "th-pruned",
      created_at: now,
      updated_at: now,
      repo: { root: dir, base_ref: "HEAD" },
      title: "pruned head",
      mode: "agent",
      workspace: { mode: "isolated", worktree_path: join(dir, "tree"), base_sha: "abc" },
      auth_preference: "auto",
      primary_harness: null,
      eligible_harnesses: [],
      routingGoal: "auto",
      run_ids: ["run-gone"],
      head_run_id: "run-gone",
      state: "active",
    };
    let applied = 0;
    const daemon: DaemonFacadeClient = {
      async enqueue() {
        return { id: "j", state: "queued" };
      },
      async status() {
        return { id: "x", state: "succeeded" };
      },
      async list() {
        return []; // the head run's command record aged out (maxHistory)
      },
      async cancel() {
        return { ok: true };
      },
    };
    const server = new DaemonControlApiServer({
      ...readyIdentity,
      token,
      daemon,
      services: {
        threadDetail: async () => ({ thread: threadObj, sessions: [], turns: [] }),
        applyThread: async () => {
          applied += 1;
          return { applied: true, status: "applied" };
        },
      },
    });
    const { host, port } = await server.start();
    const base = `http://${host}:${port}`;
    try {
      const res = await apiFetch(`${base}/threads/th-pruned/apply`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: "apply" }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { message: string }).message).toContain(
        "no longer in the daemon history",
      );
      expect(applied).toBe(0);
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a successful thread run whose required patch artifact is missing", async () => {
    const dir = reapMk(join(tmpdir(), "claudexor-thread-missing-patch-"));
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    const now = new Date().toISOString();
    const daemon: DaemonFacadeClient = {
      async enqueue() {
        return { id: "job", state: "queued" };
      },
      async status() {
        return { id: "job", state: "succeeded", runId: "run-missing", runDir };
      },
      async list() {
        return [{ id: "job", state: "succeeded", runId: "run-missing", runDir }];
      },
      async cancel() {
        return { ok: true };
      },
    };
    let applied = 0;
    const server = new DaemonControlApiServer({
      ...readyIdentity,
      token,
      daemon,
      services: {
        threadDetail: async () => ({
          thread: {
            id: "th-missing",
            created_at: now,
            updated_at: now,
            repo: { root: dir, base_ref: "HEAD" },
            workspace: { mode: "in_place", base_sha: "abc" },
            run_ids: ["run-missing"],
            head_run_id: "run-missing",
            state: "active",
          },
          sessions: [],
          turns: [],
        }),
        applyThread: async () => {
          applied += 1;
          return { applied: true, status: "applied" };
        },
      },
    });
    const { host, port } = await server.start();
    try {
      const response = await apiFetch(`http://${host}:${port}/threads/th-missing/apply`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: "apply" }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("thread_run_unverifiable");
      expect(applied).toBe(0);
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("streams events for a QUEUED job (SSE waits with heartbeats, binds the run dir when it appears)", async () => {
    // GET /runs/:id/events on a queued job must open the stream and
    // wait, not 404 — `follow <jobId>` works from enqueue time.
    const dir = reapMk(join(tmpdir(), "claudexor-queued-sse-"));
    const runDir = join(dir, "run-q1");
    const { mkdirSync: mkd } = await import("node:fs");
    mkd(runDir, { recursive: true });
    let phase: "queued" | "running" = "queued";
    const daemon: DaemonFacadeClient = {
      async enqueue() {
        return { id: "job-q1", state: "queued" };
      },
      async status() {
        return phase === "queued"
          ? { id: "job-q1", state: "queued" }
          : { id: "job-q1", state: "running", runId: "run-q1", runDir };
      },
      async list() {
        return [await this.status("job-q1")];
      },
      async cancel() {
        return { ok: true };
      },
    };
    const server = new DaemonControlApiServer({ ...readyIdentity, token, daemon, pollMs: 5 });
    const { host, port } = await server.start();
    try {
      const res = await apiFetch(`http://${host}:${port}/runs/job-q1/events`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200); // stream OPEN while queued (was a 404)
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      // Flip to running with a terminal event already in the log.
      writeFileSync(
        join(runDir, "events.jsonl"),
        `${JSON.stringify({ seq: 1, ts: new Date().toISOString(), run_id: "run-q1", task_id: "t", type: "run.created", payload: {} })}\n` +
          `${JSON.stringify({ seq: 2, ts: new Date().toISOString(), run_id: "run-q1", task_id: "t", type: "run.completed", payload: { status: "success" } })}\n`,
      );
      phase = "running";
      let text = "";
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !text.includes("event: end")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      expect(text).toContain("run.created");
      expect(text).toContain("run.completed");
      expect(text).toContain("event: end");
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

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
      const oldMode = await apiFetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: "x", mode: "daily" }),
      });
      expect(oldMode.status).toBe(400);

      const inlineEnv = await apiFetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: "x", mode: "agent", env: { OPENAI_API_KEY: "sk-nope" } }),
      });
      expect(inlineEnv.status).toBe(400);
      expect(enqueued).toBe(0);
    });
  });

  it("projects the LAST plan.progress event as planProgress", async () => {
    const { daemon, record } = fakeDaemon();
    // Two plan.progress events: the projection must be LAST-WINS.
    const evPath = join(record.runDir!, "events.jsonl");
    const mk = (items: unknown, seq: number) =>
      JSON.stringify({
        ts: new Date().toISOString(),
        run_id: "run-d1",
        task_id: "task-d1",
        seq,
        type: "plan.progress",
        payload: { items },
      });
    appendFileSync(
      evPath,
      "\n" +
        mk([{ id: "claude-0", title: "old", status: "pending" }], 90) +
        "\n" +
        mk(
          [
            { id: "claude-0", title: "write tests", status: "completed" },
            { id: "claude-1", title: "ship", status: "in_progress" },
          ],
          91,
        ) +
        "\n",
    );
    await withDaemonServer(daemon, async (base) => {
      const detail = await apiFetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await detail.json()) as {
        planProgress: { items: Array<{ id: string; title: string; status: string }> } | null;
      };
      expect(body.planProgress).not.toBeNull();
      expect(body.planProgress!.items).toEqual([
        { id: "claude-0", title: "write tests", status: "completed" },
        { id: "claude-1", title: "ship", status: "in_progress" },
      ]);
    });
  });

  it("QA-074: malformed/non-object event lines surface a typed incompleteness marker, never silent partial", async () => {
    const { daemon, record } = fakeDaemon();
    const evPath = join(record.runDir!, "events.jsonl");
    const ev = (o: Record<string, unknown>) =>
      JSON.stringify({ ts: new Date().toISOString(), run_id: "run-d1", task_id: "task-d1", ...o });
    // One valid header, one unparseable line, one non-object (array) line, a
    // valid plan.progress, and a valid harness.event. The two bad lines must be
    // COUNTED and disclosed, not silently dropped, while the valid ones project.
    writeFileSync(
      evPath,
      [
        ev({ seq: 1, type: "run.created", payload: {} }),
        "{ this is not valid json",
        "[1, 2, 3]",
        ev({
          seq: 2,
          type: "plan.progress",
          payload: { items: [{ id: "p0", title: "do the thing", status: "pending" }] },
        }),
        ev({ seq: 3, type: "harness.event", payload: { harness_id: "codex", type: "tool" } }),
        "",
      ].join("\n"),
    );
    await withDaemonServer(daemon, async (base) => {
      const detail = await apiFetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await detail.json()) as {
        timeline: { type: string; title: string; severity: string }[];
        budget: { evidence: string };
        planProgress: { items: { id: string }[]; evidence: string } | null;
      };
      const marker = body.timeline.find((e) => e.type === "timeline.evidence_incomplete");
      expect(marker).toBeDefined();
      // The two skipped lines (1 unparseable + 1 non-object) are counted exactly.
      expect(marker!.title).toContain("2 malformed");
      expect(marker!.severity).toBe("warning");
      // The marker is the most prominent row (top of the timeline).
      expect(body.timeline[0]!.type).toBe("timeline.evidence_incomplete");
      // Valid lines still project alongside the disclosure.
      expect(body.timeline.some((e) => e.type === "harness.event")).toBe(true);
      // Budget and plan folds disclose partial evidence, never a clean shape.
      expect(body.budget.evidence).toBe("incomplete");
      expect(body.planProgress).not.toBeNull();
      expect(body.planProgress!.items.map((i) => i.id)).toEqual(["p0"]);
      expect(body.planProgress!.evidence).toBe("incomplete");
    });
  });

  it("QA-074: an unreadable events file discloses evidence_unavailable, not empty-success", async () => {
    const { daemon, record } = fakeDaemon();
    const evPath = join(record.runDir!, "events.jsonl");
    // A directory in place of the file is unreadable-as-events; the projection
    // must announce the whole run history is unavailable, not present as clean.
    rmSync(evPath, { force: true });
    mkdirSync(evPath, { recursive: true });
    await withDaemonServer(daemon, async (base) => {
      const detail = await apiFetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await detail.json()) as {
        timeline: { type: string; severity: string }[];
        budget: { evidence: string };
        planProgress: { items: unknown[]; evidence: string } | null;
      };
      const marker = body.timeline.find((e) => e.type === "timeline.evidence_unavailable");
      expect(marker).toBeDefined();
      expect(marker!.severity).toBe("error");
      expect(body.budget.evidence).toBe("unavailable");
      expect(body.planProgress).not.toBeNull();
      expect(body.planProgress!.items).toEqual([]);
      expect(body.planProgress!.evidence).toBe("unavailable");
    });
  });

  it("QA-074: an ABSENT events file (queued run) is complete/empty, not evidence_unavailable", async () => {
    const { daemon, record } = fakeDaemon();
    // ENOENT is the legitimate never-written case — no marker, evidence complete.
    rmSync(join(record.runDir!, "events.jsonl"), { force: true });
    await withDaemonServer(daemon, async (base) => {
      const detail = await apiFetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await detail.json()) as {
        timeline: { type: string }[];
        budget: { evidence: string };
        planProgress: unknown | null;
      };
      expect(body.timeline.some((e) => e.type.startsWith("timeline.evidence_"))).toBe(false);
      expect(body.budget.evidence).toBe("complete");
      expect(body.planProgress).toBeNull();
    });
  });

  it("QA-074: a fully-readable events file keeps a clean, unmarked projection", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      const detail = await apiFetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await detail.json()) as {
        timeline: { type: string }[];
        budget: { evidence: string };
        planProgress: { evidence: string } | null;
      };
      expect(body.timeline.some((e) => e.type.startsWith("timeline.evidence_"))).toBe(false);
      expect(body.budget.evidence).toBe("complete");
      if (body.planProgress) expect(body.planProgress.evidence).toBe("complete");
    });
  });

  it("projects candidate evidence cards from attempts/reviews/decision artifacts", async () => {
    const { daemon } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      const detail = await apiFetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as {
        candidates: Array<{
          attemptId: string;
          harnessId: string;
          label: string | null;
          costUsd: number;
          costEstimated: boolean;
          errored: boolean;
          errorReason: string | null;
          gatesPassed: number;
          gatesTotal: number;
          blockers: number;
          winner: boolean;
          finalReviewClean: boolean | null;
          diffstat: { files: number; additions: number; deletions: number } | null;
        }>;
      };
      expect(body.candidates.length).toBe(2);
      const a = body.candidates.find((c) => c.attemptId === "a01")!;
      expect(a).toMatchObject({
        harnessId: "claude",
        label: "A",
        costUsd: 0.42,
        gatesPassed: 2,
        gatesTotal: 2,
        winner: true,
        blockers: 0, // the WARN finding in reviews/a01.yaml is not blocking
        finalReviewClean: true,
      });
      expect(a.diffstat).toEqual({ files: 3, additions: 25, deletions: 4 });
      const b = body.candidates.find((c) => c.attemptId === "a02")!;
      expect(b).toMatchObject({
        harnessId: "codex",
        errored: true,
        errorReason: "spawn E2BIG",
        costEstimated: true,
        gatesPassed: 0,
        gatesTotal: 1,
        winner: false,
        blockers: 1, // the accepted BLOCK finding counts via the schema's isBlocking
        finalReviewClean: false,
      });
    });
  });

  it("bounds primary output inline text while preserving full artifact bytes", async () => {
    const { daemon, record } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      for (const [size, truncated] of [
        [256 * 1024, false],
        [256 * 1024 + 1, true],
        [257 * 1024, true],
      ] as const) {
        const full = "x".repeat(size);
        writeFileSync(join(record.runDir!, "final", "answer.md"), full);
        const response = await apiFetch(`${base}/runs/run-d1`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          primaryOutput: { text: string; bytes: number; truncated: boolean };
        };
        expect(body.primaryOutput.truncated).toBe(truncated);
        expect(body.primaryOutput.bytes).toBe(size);
        expect(Buffer.byteLength(body.primaryOutput.text)).toBeLessThanOrEqual(256 * 1024);
      }
      const utf = "x".repeat(256 * 1024 - 1) + "é";
      writeFileSync(join(record.runDir!, "final", "answer.md"), utf);
      const utfResponse = await apiFetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const utfBody = (await utfResponse.json()) as {
        primaryOutput: { text: string; truncated: boolean };
      };
      expect(utfBody.primaryOutput.truncated).toBe(true);
      expect(utfBody.primaryOutput.text).not.toContain("\uFFFD");
    });
  });

  it("serves run detail and artifact index from the run directory", async () => {
    const { daemon, record } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      const detail = await apiFetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as {
        summary: {
          mode?: string;
          prompt?: string;
          requestRequirements?: Array<{
            harness_id: string;
            effective: boolean;
            reason: string;
          }>;
        };
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
      expect(body.summary.requestRequirements).toEqual([
        expect.objectContaining({ harness_id: "codex", effective: true, reason: "effective" }),
      ]);
      // summary.md lost its primary-output authority (V8/PLAN addendum 2); the
      // patch is now the primary output for this write run.
      expect(body.primaryOutput?.kind).toBe("patch");
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
      // Derived apply-gate verdict rides the detail (single producer): this
      // fixture run has a patch, so the verdict is non-null and typed.
      const eligibility = (
        body as unknown as {
          applyEligibility: {
            eligible: boolean;
            reason: string | null;
            requiredAction: string | null;
          } | null;
        }
      ).applyEligibility;
      expect(eligibility).not.toBeNull();
      expect(typeof eligibility?.eligible).toBe("boolean");
      if (eligibility && !eligibility.eligible) {
        expect(eligibility.reason).toBeTruthy();
        expect(eligibility.requiredAction).toBeTruthy();
      } else if (eligibility) {
        // Eligible verdicts carry explicit nulls, never empty-string debris.
        expect(eligibility.reason).toBeNull();
        expect(eligibility.requiredAction).toBeNull();
      }

      const artifacts = await apiFetch(`${base}/runs/run-d1/artifacts`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(artifacts.status).toBe(200);
      expect(await artifacts.text()).toContain("final/patch.diff");

      const summary = await apiFetch(`${base}/runs/run-d1/artifacts/final/summary.md`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(summary.status).toBe(200);
      expect(await summary.text()).toContain("Summary");

      // A run with NO patch artifact serves detail fine with a NULL verdict —
      // the no-patch path is a null projection, never a crash (missing
      // artifacts resolve to null in safeArtifactPath before any lstat).
      rmSync(join(record.runDir as string, "final", "patch.diff"), { force: true });
      const noPatchDetail = await apiFetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(noPatchDetail.status).toBe(200);
      const noPatchBody = (await noPatchDetail.json()) as { applyEligibility: unknown };
      expect(noPatchBody.applyEligibility).toBeNull();
    });
  });

  it("budget snapshot prefers the ledger's CASH disclosure over valuation observations (W4.3)", async () => {
    // A decision-less subscription run (plan/ask): valuation ticks are
    // NON-ZERO while the cash truth is $0. Summing them as spend showed
    // valuation under a "real money" label (F4 review); budget.cash — the
    // ledger's cumulative disclosure — wins, last-write.
    const { daemon, record } = fakeDaemon();
    rmSync(join(record.runDir as string, "arbitration", "decision.yaml"), { force: true });
    appendFileSync(
      join(record.runDir as string, "events.jsonl"),
      [
        JSON.stringify({
          ts: new Date().toISOString(),
          run_id: "run-d1",
          task_id: "task-d1",
          type: "budget.observation",
          payload: { kind: "spend", usd: 2.5, estimated: true },
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          run_id: "run-d1",
          task_id: "task-d1",
          type: "budget.cash",
          payload: { cash_spend_usd: 0, valuation_usd: 2.5 },
        }),
        "",
      ].join("\n"),
    );
    await withDaemonServer(daemon, async (base) => {
      const detail = await apiFetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as {
        budget: { spendUsd?: number | null; source: string; estimated: boolean };
      };
      expect(body.budget.spendUsd).toBe(0); // the cash truth, not the $2.50 valuation
      expect(body.budget.source).toBe("events");
      expect(body.budget.estimated).toBe(false); // settled ledger cash is exact
    });
  });

  it("carries the server-owned outcome banner on the run detail (D18)", async () => {
    // fakeDaemon builds a succeeded run with a clean decision (review approved,
    // checks passed) + a patch work product that has NOT been applied.
    const { daemon } = fakeDaemon();
    await withDaemonServer(daemon, async (base) => {
      const detail = await apiFetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as { outcomeBanner: string | null };
      // Server-owned headline, derived by status-projection.outcomeBanner — the
      // client renders THIS verbatim above any model prose, never re-derives it.
      expect(body.outcomeBanner).toBe("Candidate ready — NOT APPLIED");
    });
  });

  it("parses a large events.jsonl EXACTLY ONCE per detail request (D15 perf)", async () => {
    const { daemon, record } = fakeDaemon();
    // 10k synthetic events: before the single-snapshot fix, timeline + the
    // budget fallback + plan progress each re-read and re-parsed the whole log.
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(
        JSON.stringify({
          ts: new Date().toISOString(),
          run_id: "run-d1",
          task_id: "task-d1",
          type: "harness.event",
          payload: { harness_id: "codex", text: `event ${i}` },
        }),
      );
    }
    lines.push("");
    appendFileSync(join(record.runDir as string, "events.jsonl"), lines.join("\n"));
    await withDaemonServer(daemon, async (base) => {
      resetEventsParseCountForTests();
      const detail = await apiFetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.status).toBe(200);
      // One detail GET, one full parse of events.jsonl — no matter how many
      // fields consume events. lastSeqInFile does a cheap byte-tail read, not a
      // full parse, so it never counts.
      expect(eventsParseCountForTests()).toBe(1);
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
      const detail = await apiFetch(`${base}/runs/run-d1`, {
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
      { mode: "ask", path: "final/report.md", kind: "report", text: "# Deep scan" },
    ];
    for (const c of cases) {
      const { daemon, record } = fakeDaemon();
      record.params = { ...(record.params as Record<string, unknown>), mode: c.mode };
      writeFileSync(join(record.runDir as string, c.path), `${c.text}\n`);
      await withDaemonServer(daemon, async (base) => {
        const detail = await apiFetch(`${base}/runs/run-d1`, {
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
      const detail = await apiFetch(`${base}/runs/run-d1`, {
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
    __reapDirs.push(outside);
    writeFileSync(outside, "outside secret\n");
    symlinkSync(outside, join(record.runDir as string, "final", "escape.txt"));
    await withDaemonServer(daemon, async (base) => {
      const listed = await apiFetch(`${base}/runs/run-d1/artifacts`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await listed.text()).not.toContain("escape.txt");

      const fetched = await apiFetch(`${base}/runs/run-d1/artifacts/final/escape.txt`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(fetched.status).toBe(404);
    });
  });

  it("refuses fixed apply artifacts through intermediate symlink directories", async () => {
    const { daemon, record } = fakeDaemon();
    const outside = reapMk(join(tmpdir(), "claudexor-outside-final-"));
    writeFileSync(join(outside, "patch.diff"), "diff --git a/evil b/evil\n");
    rmSync(join(record.runDir as string, "final"), { recursive: true, force: true });
    symlinkSync(outside, join(record.runDir as string, "final"), "dir");
    await withDaemonServer(daemon, async (base) => {
      const apply = await apiFetch(`${base}/runs/run-d1/apply/check`, {
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
      const apply = await apiFetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(apply.status).toBe(409);
      expect(await apply.text()).toContain("hash does not match");
    });
  });

  it("refuses apply for a non-succeeded lifecycle even when a patch exists", async () => {
    const { daemon, record } = fakeDaemon();
    record.state = "failed";
    await withDaemonServer(daemon, async (base) => {
      const apply = await apiFetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(apply.status).toBe(409);
      expect(await apply.text()).toContain("failed");
    });
  });

  it("operator decision unblocks a blocked run for apply (accept_risk), scoped to the exact patch", async () => {
    const { daemon, record } = fakeDaemon();
    record.state = "succeeded";
    writeFileSync(
      join(record.runDir as string, "arbitration", "decision.yaml"),
      "winner: a01\nfacts:\n  lifecycle: succeeded\n  review: blocked\n  checks: not_configured\n  noChanges: false\n  reason: review_blocked\nfinal_verify:\n  attempted: true\n  applied_cleanly: true\n  gates_passed: true\n",
    );
    await withDaemonServer(daemon, async (base) => {
      // Blocked: apply/check refuses before any operator decision.
      const before = await apiFetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(before.status).toBe(409);

      // Operator accepts the risk (typed, audited, hash-bound).
      const decide = await apiFetch(`${base}/runs/run-d1/decision`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Idempotency-Key": "decision-risk-1" },
        body: JSON.stringify({
          action: "accept_risk",
          findingIds: ["f-1"],
          acceptedRisks: ["protected path change reviewed by hand"],
        }),
      });
      expect(decide.status).toBe(200);
      expect(((await decide.json()) as { accepted: boolean }).accepted).toBe(true);
      // The journal-backed authority also emits the artifact-only compatibility projection.
      const persisted = readFileSync(
        join(record.runDir as string, "arbitration", "operator_decision.yaml"),
        "utf8",
      );
      expect(persisted).toContain("accept_risk");
      expect(persisted).toContain("patch_sha256");

      // The gate now passes for THIS patch...
      const after = await apiFetch(`${base}/runs/run-d1/apply/check`, {
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
      const tampered = await apiFetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(tampered.status).toBe(409);
    });
  });

  it("post-terminal audit appends keep the seq cursor strictly monotonic (SSE resume safety)", async () => {
    const { daemon, record } = fakeDaemon();
    record.state = "succeeded";
    writeFileSync(
      join(record.runDir as string, "arbitration", "decision.yaml"),
      "winner: a01\nfacts:\n  lifecycle: succeeded\n  review: blocked\n  checks: not_configured\n  noChanges: false\n  reason: review_blocked\nfinal_verify:\n  attempted: true\n  applied_cleanly: true\n  gates_passed: true\n",
    );
    await withDaemonServer(daemon, async (base) => {
      const before = (await (
        await apiFetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as { lastSeq: number };
      const decide = await apiFetch(`${base}/runs/run-d1/decision`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Idempotency-Key": "decision-risk-2" },
        body: JSON.stringify({ action: "accept_risk", acceptedRisks: ["r"] }),
      });
      expect(decide.status).toBe(200);
      const after = (await (
        await apiFetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
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
    record.state = "succeeded";
    writeFileSync(
      join(record.runDir as string, "arbitration", "decision.yaml"),
      "winner: a01\nfacts:\n  lifecycle: succeeded\n  review: blocked\n  checks: not_configured\n  noChanges: false\n  reason: review_blocked\nfinal_verify:\n  attempted: true\n  applied_cleanly: true\n  gates_passed: true\n",
    );
    let enqueued: Record<string, unknown> | undefined;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params: unknown, options) {
        enqueued = params as Record<string, unknown>;
        expect(options).toMatchObject({
          idempotencyKey: "decision-rerun-1",
          operation: "run.decision.rerun",
        });
        return daemon.enqueue(params, options);
      },
    };
    await withDaemonServer(wrapped, async (base) => {
      const res = await apiFetch(`${base}/runs/run-d1/decision`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Idempotency-Key": "decision-rerun-1" },
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

  it("Exact Retry creates a fresh idempotent command linked to the immutable source request", async () => {
    const { daemon, record } = fakeDaemon();
    let enqueued: Record<string, unknown> | undefined;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params, options) {
        enqueued = params as Record<string, unknown>;
        expect(options).toMatchObject({
          idempotencyKey: "exact-retry-1",
          operation: "run.retry",
          idempotencyRequest: { retryOf: "run-d1" },
        });
        return daemon.enqueue(params, options);
      },
    };
    await withDaemonServer(wrapped, async (base) => {
      const response = await apiFetch(`${base}/runs/run-d1/retry`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Idempotency-Key": "exact-retry-1" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ retryOf: "run-d1", jobId: "job-d1" });
      expect(enqueued).toMatchObject({
        prompt: "hello",
        parentRunId: "run-d1",
        retryOf: "run-d1",
      });
      expect(record.params).not.toHaveProperty("retryOf");
    });
  });

  it("QA-035: Exact Retry replays the model+effort frozen in the source contract despite a settings change", async () => {
    const { daemon, record } = fakeDaemon();
    // The source run FROZE its config-derived route into the immutable contract.
    writeFileSync(
      join(record.runDir as string, "context", "task.yaml"),
      [
        "schema_version: 2",
        "task_id: task-d1",
        "created_at: 2026-07-15T00:00:00.000Z",
        "repo:",
        `  root: ${JSON.stringify(record.runDir)}`,
        "  base_ref: HEAD",
        "mode:",
        "  kind: agent",
        "user_intent:",
        "  raw: test run",
        "routing_models:",
        "  codex: gpt-5.3-codex-spark",
        "routing_efforts:",
        "  codex: low",
        "tests:",
        "  commands: []",
        "",
      ].join("\n"),
    );
    // The ORIGINAL request carried no scalar model/effort — it relied on
    // settings that may since have changed. Exact Retry must NOT re-resolve
    // them from current settings.
    record.params = {
      prompt: "hello",
      mode: "agent",
      scope: { kind: "project", root: record.runDir, context: "auto" },
      harnesses: ["codex"],
      routingGoal: "auto",
    };
    let enqueued: Record<string, unknown> | undefined;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params, options) {
        enqueued = params as Record<string, unknown>;
        return daemon.enqueue(params, options);
      },
    };
    await withDaemonServer(wrapped, async (base) => {
      const response = await apiFetch(`${base}/runs/run-d1/retry`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Idempotency-Key": "qa035-retry" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      // The retry replays the FROZEN route, not whatever settings say now. Effort
      // is replayed as the per-lane MAP (not a collapsed scalar) so a non-primary
      // lane keeps its own effort (QA-035 completeness).
      expect(enqueued?.["models"]).toMatchObject({ codex: "gpt-5.3-codex-spark" });
      expect(enqueued?.["efforts"]).toMatchObject({ codex: "low" });
    });
  });

  it("QA-035 completeness: Exact Retry replays per-lane frozen efforts for a two-harness pool (non-primary lane keeps its own effort)", async () => {
    const { daemon, record } = fakeDaemon();
    // Two lanes with DIFFERENT frozen efforts; codex is primary. The old scalar
    // collapse replayed only codex's effort and dropped claude's.
    writeFileSync(
      join(record.runDir as string, "context", "task.yaml"),
      [
        "schema_version: 2",
        "task_id: task-d1",
        "created_at: 2026-07-15T00:00:00.000Z",
        "repo:",
        `  root: ${JSON.stringify(record.runDir)}`,
        "  base_ref: HEAD",
        "mode:",
        "  kind: agent",
        "user_intent:",
        "  raw: test run",
        "routing_models: {}",
        "routing_efforts:",
        "  codex: low",
        "  claude: max",
        "tests:",
        "  commands: []",
        "",
      ].join("\n"),
    );
    // Original request relied on (now potentially changed) settings; primary=codex.
    record.params = {
      prompt: "hello",
      mode: "agent",
      scope: { kind: "project", root: record.runDir, context: "auto" },
      harnesses: ["codex", "claude"],
      primaryHarness: "codex",
      routingGoal: "auto",
    };
    let enqueued: Record<string, unknown> | undefined;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params, options) {
        enqueued = params as Record<string, unknown>;
        return daemon.enqueue(params, options);
      },
    };
    await withDaemonServer(wrapped, async (base) => {
      const response = await apiFetch(`${base}/runs/run-d1/retry`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Idempotency-Key": "qa035-2lane-retry" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      // BOTH lanes' frozen efforts survive — not just the primary's.
      expect(enqueued?.["efforts"]).toMatchObject({ codex: "low", claude: "max" });
    });
  });

  it("Exact Retry and Run Again restore threaded attachment references from the durable turn", async () => {
    const { daemon, record } = fakeDaemon();
    const attachmentPath = join(record.runDir as string, "context", "attached.txt");
    writeFileSync(attachmentPath, "attached sentinel");
    record.params = {
      ...(record.params as Record<string, unknown>),
      threadId: "th-source",
      turnId: "tn-source",
    };
    let copiedAttachments: unknown;
    let enqueued: Record<string, unknown> | undefined;
    const wrapped: DaemonFacadeClient = {
      ...daemon,
      async enqueue(params, options) {
        enqueued = params as Record<string, unknown>;
        return daemon.enqueue(params, options);
      },
    };
    const services: DaemonControlApiOptions["services"] = {
      threadDetail: async () => ({
        thread: { id: "th-source" },
        sessions: [],
        turns: [
          {
            id: "tn-source",
            attachments: [
              {
                resource_id: "res-source",
                kind: "file",
                mime: "text/plain",
                name: "attached.txt",
                sha256: "sha256:fixture",
                size_bytes: 17,
                path: attachmentPath,
              },
            ],
          },
        ],
      }),
      createThreadTurn: async (_id, _prompt, options) => {
        copiedAttachments = options.attachments;
        return { id: "tn-retry" };
      },
    };
    await withDaemonServer(
      wrapped,
      async (base) => {
        const retry = await apiFetch(`${base}/runs/run-d1/retry`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "Idempotency-Key": "attachment-retry" },
          body: "{}",
        });
        expect(retry.status).toBe(200);
        expect(copiedAttachments).toEqual([{ resourceId: "res-source" }]);
        expect(enqueued?.["attachments"]).toEqual([{ resourceId: "res-source" }]);

        const draft = await apiFetch(`${base}/runs/run-d1/run-again`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(draft.status).toBe(200);
        expect(
          ((await draft.json()) as { request: { attachments?: unknown[] } }).request.attachments,
        ).toEqual([{ resourceId: "res-source" }]);
      },
      undefined,
      services,
    );
  });

  it("Run Again returns an editable request and discloses omitted server-owned bindings", async () => {
    const { daemon, record } = fakeDaemon();
    record.params = {
      ...(record.params as Record<string, unknown>),
      turnId: "tn-old",
      planRunId: "run-plan",
    };
    await withDaemonServer(daemon, async (base) => {
      const response = await apiFetch(`${base}/runs/run-d1/run-again`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        request: Record<string, unknown>;
        differences: Array<{ field: string }>;
      };
      expect(body.request).toMatchObject({ prompt: "hello", mode: "agent" });
      expect(body.request).not.toHaveProperty("turnId");
      expect(body.request).not.toHaveProperty("planRunId");
      expect(body.differences.map((entry) => entry.field)).toEqual(["turnId", "planRunId"]);
    });
  });

  it("degrades an invalid persisted mode to an unknown field instead of poisoning the run list", async () => {
    // One malformed job record (e.g. a legacy "daily" mode) must never 500 the
    // whole run list/detail surface forever; the engine still rejects unknown
    // modes loudly at RUN time — this is only the read-side projection.
    const { daemon, record } = fakeDaemon();
    record.params = { prompt: "legacy", mode: "daily" };
    await withDaemonServer(daemon, async (base) => {
      const detail = await apiFetch(`${base}/runs/run-d1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as { summary: { mode?: string; runId: string } };
      expect(body.summary.mode).toBeUndefined();
      expect(body.summary.runId).toBe("run-d1");
      const list = await apiFetch(`${base}/runs`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.status).toBe(200);
    });
  });

  it("redacts prompts in summaries and refuses secret-like patch artifacts", async () => {
    const { daemon, record } = fakeDaemon();
    const secret = "sk-" + "a".repeat(24);
    record.params = { prompt: `use ${secret}`, mode: "agent", routingGoal: "auto" };
    writeFileSync(
      join(record.runDir as string, "final", "patch.diff"),
      `diff --git a/.env b/.env\n+OPENAI_API_KEY=${secret}\n`,
    );
    await withDaemonServer(daemon, async (base) => {
      const list = (await (
        await apiFetch(`${base}/runs`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as {
        runs: { prompt?: string }[];
      };
      expect(list.runs[0]?.prompt).toContain("[redacted]");
      expect(list.runs[0]?.prompt).not.toContain(secret);

      const patch = await apiFetch(`${base}/runs/run-d1/artifacts/final/patch.diff`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(patch.status).toBe(409);

      const apply = await apiFetch(`${base}/runs/run-d1/apply/check`, {
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
      const summary = await apiFetch(`${base}/runs/run-d1/artifacts/final/summary.md`, {
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
      const events = await apiFetch(`${base}/runs/run-d1/artifacts/events.jsonl`, {
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
      const events = await apiFetch(`${base}/runs/run-d1/events`, {
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
      const apply = await apiFetch(`${base}/runs/run-d1/apply/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(apply.status).toBe(409);
      expect(await apply.text()).toContain("A completed run is required before this change");
    });
  });

  it("redacts service errors before returning control-api JSON", async () => {
    const { daemon } = fakeDaemon();
    const secret = "sk-" + "f".repeat(24);
    await withDaemonServer(
      daemon,
      async (base) => {
        const res = await apiFetch(`${base}/settings`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(500);
        expect(res.headers.get("content-type")).toBe("application/problem+json");
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
    const snapshot = {
      sources: [],
      routing: {
        primaryHarness: null,
        eligibleHarnesses: [],
        envInheritance: "mirror_native" as const,
        goal: "auto" as const,
        paidFallback: "when_unavailable" as const,
        qualityTiers: {},
      },
      budget: { paidBudgetPerRun: { kind: "unlimited" as const } },
      runtime: {
        reviewerTimeoutMs: 2_400_000,
        transientRetry: { maxRetries: 3, initialDelayMs: 2_000, maxDelayMs: 20_000 },
      },
    };
    const server = new DaemonControlApiServer({
      ...readyIdentity,
      token,
      daemon,
      services: {
        settings: async () => snapshot,
        updateSettings: async () => snapshot,
        listSecrets: async () => ({ backend: "file", secrets: [] }),
        setSecret: async (input) => ({
          name: (input as { name: string }).name,
          backend: "file",
          stored: true,
        }),
        deleteSecret: async (name) => ({ name, deleted: true }),
      },
    });
    const { host, port } = await server.start();
    const base = `http://${host}:${port}`;
    try {
      const badSettings = await apiFetch(`${base}/settings`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ envInheritance: "surprise" }),
      });
      expect(badSettings.status).toBe(400);

      const okSettings = await apiFetch(`${base}/settings`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ paidBudgetPerRun: { kind: "unlimited" } }),
      });
      expect(okSettings.status).toBe(200);
      expect(await okSettings.json()).toMatchObject(snapshot);
      const shownSettings = await apiFetch(`${base}/settings`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(shownSettings.status).toBe(200);
      const shownJson = (await shownSettings.json()) as Record<string, any>;
      expect(shownJson["runtime"]?.["reviewerTimeoutMs"]).toBe(2_400_000);
      expect(shownJson["runtime"]?.["transientRetry"]?.["maxRetries"]).toBe(3);

      const badSecret = await apiFetch(`${base}/secrets`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "github", value: "x" }),
      });
      expect(badSecret.status).toBe(400);

      const goodSecret = await apiFetch(`${base}/secrets`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "openai", value: "test-only" }),
      });
      expect(goodSecret.status).toBe(200);
      expect(await goodSecret.json()).toEqual({ name: "openai", backend: "file", stored: true });

      const deleted = await apiFetch(`${base}/secrets/openai`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ name: "openai", deleted: true });

      const okSecretList = await apiFetch(`${base}/secrets`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(okSecretList.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it("serves quota snapshots and refresh through the v2 operation catalog", async () => {
    const { daemon } = fakeDaemon();
    let refreshes = 0;
    const response = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "apps/macos/ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/control-quota-response.json",
        ),
        "utf8",
      ),
    ) as unknown;
    await withDaemonServer(
      daemon,
      async (base) => {
        const read = await apiFetch(`${base}/quota`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(read.status).toBe(200);
        expect(await read.json()).toEqual(response);
        const refreshed = await apiFetch(`${base}/quota`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(refreshed.status).toBe(200);
        expect(refreshes).toBe(1);
      },
      undefined,
      {
        quota: async () => response,
        refreshQuota: async () => {
          refreshes += 1;
          return response;
        },
      },
    );
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
      const sse = await apiFetch(`${base}/runs/run-d1/events`, {
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
          await apiFetch(`${base}/runs/run-d1`, { headers: { authorization: `Bearer ${token}` } })
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
          await apiFetch(`${base}/runs`, { headers: { authorization: `Bearer ${token}` } })
        ).json()) as {
          runs: { waitingOnUser: boolean }[];
        };
        expect(list.runs[0]?.waitingOnUser).toBe(true);

        const answer = await apiFetch(`${base}/runs/run-d1/interactions/int-1/answer`, {
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

        const missing = await apiFetch(`${base}/runs/run-d1/interactions/int-404/answer`, {
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

  it("hard-errors the removed live-only /v2/events compatibility alias", async () => {
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
        const res = await apiFetch(`${base}/events`, {
          headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        });
        expect(res.status).toBe(404);
        expect(((await res.json()) as { code: string }).code).toBe("http_404");
      },
      undefined,
      undefined,
      bus,
    );

    await withDaemonServer(daemon, async (base) => {
      const res = await apiFetch(`${base}/events`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
    });
  });

  it("streams durable global/project journal events with partition-scoped resume cursors", async () => {
    const { daemon } = fakeDaemon();
    const calls: string[] = [];
    const emitted = new Set<string>();
    const services: DaemonControlApiOptions["services"] = {
      journalEvents: async (partition, afterCursor) => {
        const call = `${partition}:${afterCursor ?? ""}`;
        calls.push(call);
        if (afterCursor === "stale")
          throw Object.assign(new Error("journal cursor is stale; resnapshot is required"), {
            code: "journal_cursor_invalid",
            status: 409,
          });
        if (emitted.has(call)) return [];
        emitted.add(call);
        return [
          {
            schemaVersion: 1,
            cursor: partition === "global" ? "global-next" : "project-next",
            partition,
            type: "command.enqueued",
            observedAt: "2026-07-14T00:00:00.000Z",
            payload: { id: "cmd-1" },
          },
        ];
      },
    };
    const readOne = async (response: Response): Promise<string> => {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("data:")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      await reader.cancel();
      return text;
    };

    await withDaemonServer(
      daemon,
      async (base) => {
        const global = await apiFetch(`${base}/v2/global/events`, {
          headers: { authorization: `Bearer ${token}`, "Last-Event-ID": "global-prev" },
        });
        expect(global.status).toBe(200);
        expect(await readOne(global)).toContain("id: global-next");

        const project = await apiFetch(`${base}/v2/projects/prj-1/events`, {
          headers: { authorization: `Bearer ${token}`, "Last-Event-ID": "project-prev" },
        });
        expect(project.status).toBe(200);
        const projectBody = await readOne(project);
        expect(projectBody).toContain("id: project-next");
        expect(projectBody).toContain('"partition":"project:prj-1"');

        const stale = await apiFetch(`${base}/v2/global/events`, {
          headers: { authorization: `Bearer ${token}`, "Last-Event-ID": "stale" },
        });
        expect(stale.status).toBe(409);
      },
      undefined,
      services,
    );
    expect(calls).toContain("global:global-prev");
    expect(calls).toContain("project:prj-1:project-prev");
  });

  it("accepts a non-git existing project root (the engine initializes git itself) but 400s a missing one", async () => {
    const { daemon } = fakeDaemon();
    const nonGit = reapMk(join(tmpdir(), "claudexor-nongit-api-"));
    await withDaemonServer(daemon, async (base) => {
      const ok = await apiFetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "build",
          mode: "agent",
          scope: { kind: "project", root: nonGit },
        }),
      });
      expect(ok.status).toBe(200);

      const missing = await apiFetch(`${base}/runs`, {
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
  it("refuses delegate on non-agent modes and accepts it for agent (INV-023 / D32)", () => {
    const root = reapMk(join(tmpdir(), "claudexor-delegate-"));
    try {
      expect(() =>
        normalizeRunStartRequest({
          prompt: "x",
          mode: "ask",
          scope: { kind: "project", root },
          delegate: true,
        }),
      ).toThrow(/delegate is an agent strategy/);
      const ok = normalizeRunStartRequest({
        prompt: "x",
        mode: "agent",
        scope: { kind: "project", root },
        delegate: true,
      });
      expect(ok.delegate).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects client-supplied turnId and thread-less planRunId on POST /runs", async () => {
    const { daemon } = fakeDaemon();
    const server = new DaemonControlApiServer({ ...readyIdentity, token, daemon });
    const { host, port } = await server.start();
    const base = `http://${host}:${port}`;
    const repo = reapMk(join(tmpdir(), "claudexor-turnid-"));
    try {
      const withTurn = await apiFetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "x",
          mode: "agent",
          scope: { kind: "project", root: repo },
          turnId: "tn-foreign",
        }),
      });
      expect(withTurn.status).toBe(400);
      expect(((await withTurn.json()) as { message: string }).message).toContain(
        "turnId is not accepted",
      );

      const withPlan = await apiFetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "x",
          mode: "agent",
          scope: { kind: "project", root: repo },
          planRunId: "run-plan",
        }),
      });
      expect(withPlan.status).toBe(400);
      expect(((await withPlan.json()) as { message: string }).message).toContain(
        "planRunId is not accepted on POST /runs",
      );
    } finally {
      await server.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("operation catalog route descriptors (V12)", () => {
  it("every descriptor carries a summary + auth boundary (code-first, no gaps)", () => {
    expect(OPERATION_CATALOG.operations.length).toBeGreaterThan(0);
    for (const op of OPERATION_CATALOG.operations) {
      expect(op.summary.length, `${op.method} ${op.path} summary`).toBeGreaterThan(0);
      expect(op.auth).toBe("loopback_bearer");
      expect(op.errorSchema).toBe("ControlProblem");
      // JSON operations must declare a response schema (enforced by the DTO too).
      if (op.responseKind === "json") expect(op.responseSchema).not.toBeNull();
    }
  });

  it("advertises the project-scoped Outputs routes with the project response DTO", () => {
    const byKey = new Map(
      OPERATION_CATALOG.operations.map((op) => [`${op.method} ${op.path}`, op]),
    );
    const list = byKey.get("GET /v2/projects/:id/outputs");
    expect(list?.responseSchema).toBe("ControlProjectOutputsResponse");
    expect(list?.mutability).toBe("read_only");
    expect(byKey.has("GET /v2/projects/:id/outputs/<path>")).toBe(true);
  });
});
