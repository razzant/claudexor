import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlProblem, ControlRunStartResponse } from "@claudexor/schema";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { DaemonControlApiServer, type DaemonFacadeClient } from "./daemon-server.js";
import {
  findAcceptedAroundPreflight,
  normalizeExistingProjectRoot,
  normalizeRunStartRequest,
} from "./run-start.js";
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";

const roots: string[] = [];
const groupCleanups: Array<() => Promise<void>> = [];

afterEachClosed(async () => {
  // This test's entries, taken before its closes: a later test never removes them.
  const ownedRoots = roots.splice(0);
  for (const close of groupCleanups.splice(0).reverse()) await close();
  return () => {
    for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
  };
});

const GROUP = "11111111-1111-4111-8111-111111111111";
const OTHER_GROUP = "33333333-3333-4333-8333-333333333333";

/** Real route, normalization, accepted-command and store identity owners. Only harness execution is absent. */
async function groupedLaunchFixture(
  disposition: "queued" | "bound" | "failed" = "queued",
  withStoreIdentity = true,
) {
  const root = mkdtempSync(join(tmpdir(), "cx-group-start-"));
  roots.push(root);
  const sql = await sqlFixture(root);
  groupCleanups.push(() => sql.close());
  const commands = sql.graph.commands.current(),
    queries = sql.graph.commands.queries;
  let dispatches = 0;
  const daemon: DaemonFacadeClient = {
    async findAccepted(params, options) {
      return commands.find({
        params,
        idempotencyKey: options.idempotencyKey,
        clientId: options.clientId!,
        operation: options.operation,
        idempotencyParams: options.idempotencyRequest,
      });
    },
    async enqueue(params, options) {
      const accepted = commands.accept({
        id: `job-${queries.count() + 1}`,
        params,
        idempotencyKey: options!.idempotencyKey!,
        clientId: options!.clientId!,
        operation: options?.operation,
        idempotencyParams: options?.idempotencyRequest,
      });
      if (!accepted.reused) {
        dispatches += 1;
        if (disposition === "bound")
          commands.update(accepted.record.id, {
            state: "running",
            runId: `run-${accepted.record.id}`,
            runDir: root,
          });
        if (disposition === "failed")
          commands.update(accepted.record.id, {
            state: "failed",
            error: "fixture failed before binding",
            errorCode: "fixture_pre_run_failure",
            errorStatus: 403,
            errorContext: Object.hasOwn(params as object, "taskGroupId")
              ? { taskGroupId: OTHER_GROUP, storeId: "untrusted-producer-context" }
              : {},
          });
      }
      return { id: accepted.record.id, state: commands.get(accepted.record.id)!.state };
    },
    async status(id) {
      const record = commands.get(id);
      if (!record) throw new Error(`missing job ${id}`);
      return record;
    },
    async list(query) {
      return queries.select(query);
    },
    async cancel() {
      throw new Error("unexpected cancellation");
    },
  };
  const server = new DaemonControlApiServer({
    token: "group-test",
    daemon,
    storeId: withStoreIdentity ? () => sql.store.storeId : undefined,
    runStartTimeoutMs: 0,
    pollMs: 1,
  });
  groupCleanups.push(() => server.stop());
  const { host, port } = await server.start();
  const request = {
    prompt: "work",
    mode: "agent",
    access: "readonly",
    scope: { kind: "project", root },
  };
  const post = (body: unknown, key: string, suffix = "") =>
    fetch(`http://${host}:${port}/v2/runs${suffix}`, {
      method: "POST",
      headers: {
        authorization: "Bearer group-test",
        "content-type": "application/json",
        "X-Claudexor-Protocol-Major": "3",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
  return { root, sql, commands, post, request, dispatches: () => dispatches };
}

describe("tagged launch HTTP receipts", () => {
  it("keeps the optional store provider compatible for untagged launches and never invents a tagged store identity", async () => {
    const f = await groupedLaunchFixture("queued", false);
    const legacy = await f.post(f.request, "legacy-no-provider");
    expect(legacy.status).toBe(202);
    expect(await legacy.json()).toEqual({ jobId: "job-1", state: "queued" });
    for (let replay = 0; replay < 2; replay++) {
      const response = await f.post({ ...f.request, taskGroupId: GROUP }, "tagged-no-provider");
      expect(response.status).toBe(503);
      const problem = ControlProblem.parse(await response.json());
      expect(problem).toMatchObject({ code: "store_identity_unavailable", retryable: true });
      expect(problem.context ?? {}).not.toHaveProperty("jobId");
      expect(problem.context ?? {}).not.toHaveProperty("storeId");
    }
    // The tagged launch is refused before acceptance, so no job owns it.
    expect(f.commands.get("job-2")).toBeUndefined();
    expect(f.dispatches()).toBe(1);
  });

  it.each(["queued", "bound", "failed"] as const)(
    "uses durable accepted group and actual store identity for %s handles and replays",
    async (disposition) => {
      const f = await groupedLaunchFixture(disposition);
      const original = { ...f.request, taskGroupId: GROUP };
      const first = await f.post(original, "group-key");
      expect(first.status).toBe(
        disposition === "failed" ? 403 : disposition === "bound" ? 200 : 202,
      );
      const firstBody = await first.json();
      const handle =
        disposition === "failed"
          ? ControlProblem.parse(firstBody).context
          : ControlRunStartResponse.parse(firstBody);
      expect(handle).toMatchObject({
        jobId: "job-1",
        taskGroupId: GROUP,
        storeId: f.sql.store.storeId,
      });
      expect(f.sql.store.storeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(f.commands.get("job-1")?.params).toHaveProperty("taskGroupId", GROUP);
      if (disposition !== "bound") expect(f.commands.get("job-1")).not.toHaveProperty("runId");
      // The first response can be lost: replay recovers the same accepted handle.
      const replay = await f.post(original, "group-key");
      expect(replay.status).toBe(first.status);
      expect(await replay.json()).toEqual(firstBody);
      const conflict = await f.post({ ...original, taskGroupId: OTHER_GROUP }, "group-key");
      expect(conflict.status).toBe(409);
      expect(ControlProblem.parse(await conflict.json()).code).toBe("idempotency_conflict");
      expect(f.commands.get("job-1")?.params).toHaveProperty("taskGroupId", GROUP);
      expect(f.dispatches()).toBe(1);
    },
  );

  it("a later bound reply projects the original queued membership", async () => {
    const f = await groupedLaunchFixture();
    const original = { ...f.request, taskGroupId: GROUP };
    const first = await f.post(original, "bind-key");
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      jobId: "job-1",
      taskGroupId: GROUP,
      storeId: f.sql.store.storeId,
    });
    f.commands.update("job-1", {
      state: "running",
      runId: "actual-run",
      runDir: f.root,
      params: { taskGroupId: OTHER_GROUP },
    });
    const replay = await f.post(original, "bind-key");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      jobId: "job-1",
      runId: "actual-run",
      taskGroupId: GROUP,
      storeId: f.sql.store.storeId,
    });
    expect(f.dispatches()).toBe(1);
  });

  it("Exact Retry retains membership while a new continuation only joins an explicitly supplied group", async () => {
    const f = await groupedLaunchFixture("bound");
    const source = await f.post({ ...f.request, taskGroupId: GROUP }, "source");
    expect(source.status).toBe(200);
    f.commands.update("job-1", { state: "succeeded" });
    const retry = await f.post({}, "retry", "/run-job-1/retry");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ taskGroupId: GROUP, storeId: f.sql.store.storeId });
    expect(f.commands.get("job-2")?.params).toHaveProperty("taskGroupId", GROUP);
    const implicit = await f.post({ continueFrom: "run-job-1" }, "continue");
    expect(implicit.status).toBe(200);
    const untagged = await implicit.json();
    expect(untagged).not.toHaveProperty("taskGroupId");
    expect(untagged).not.toHaveProperty("storeId");
    expect(f.commands.get("job-3")?.params).not.toHaveProperty("taskGroupId");
    // Use an independent source so this assertion does not bypass one-successor admission.
    await f.post({ ...f.request, taskGroupId: GROUP }, "other-source");
    f.commands.update("job-4", { state: "succeeded" });
    const explicit = await f.post(
      { continueFrom: "run-job-4", taskGroupId: OTHER_GROUP },
      "explicit-continue",
    );
    expect(explicit.status).toBe(200);
    expect(await explicit.json()).toMatchObject({
      taskGroupId: OTHER_GROUP,
      storeId: f.sql.store.storeId,
    });
    expect(f.commands.get("job-5")?.params).toHaveProperty("taskGroupId", OTHER_GROUP);
  });

  it("refuses an Exact Retry of a tagged run before acceptance while the store identity is unavailable", async () => {
    const f = await groupedLaunchFixture("bound");
    expect((await f.post({ ...f.request, taskGroupId: GROUP }, "source")).status).toBe(200);
    f.commands.update("job-1", { state: "succeeded" });
    const store = f.sql.store as { storeId: string | undefined };
    const identity = store.storeId;
    store.storeId = undefined;
    const refused = await f.post({}, "retry-during-outage", "/run-job-1/retry");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      code: "store_identity_unavailable",
      retryable: true,
    });
    expect(f.commands.get("job-2")).toBeUndefined();
    expect(f.dispatches()).toBe(1);
    // Nothing was accepted, so the same key retries once the identity returns.
    store.storeId = identity;
    const retried = await f.post({}, "retry-during-outage", "/run-job-1/retry");
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ taskGroupId: GROUP, storeId: identity });
  });

  it.each(["queued", "bound", "failed"] as const)(
    "keeps legacy untagged %s receipt metadata absent",
    async (disposition) => {
      const f = await groupedLaunchFixture(disposition);
      const response = await f.post(f.request, "legacy");
      expect(response.status).toBe(
        disposition === "failed" ? 403 : disposition === "bound" ? 200 : 202,
      );
      const body = await response.json();
      const receipt = disposition === "failed" ? ControlProblem.parse(body).context : body;
      expect(receipt).not.toHaveProperty("taskGroupId");
      expect(receipt).not.toHaveProperty("storeId");
    },
  );

  it("normalizes the explicit UUID without materializing an absent field", () => {
    const root = mkdtempSync(join(tmpdir(), "cx-group-normalize-"));
    roots.push(root);
    const request = { prompt: "work", scope: { kind: "project", root } };
    expect(normalizeRunStartRequest({ ...request, taskGroupId: GROUP })).toHaveProperty(
      "taskGroupId",
      GROUP,
    );
    expect(normalizeRunStartRequest(request)).not.toHaveProperty("taskGroupId");
  });
});

describe("normalizeExistingProjectRoot", () => {
  it("accepts a symlink to an existing directory and preserves its spelling", () => {
    const parent = mkdtempSync(join(tmpdir(), "claudexor-root-symlink-"));
    const target = mkdtempSync(join(tmpdir(), "claudexor-root-target-"));
    roots.push(parent, target);
    const linked = join(parent, "project-link");
    symlinkSync(target, linked, "dir");

    expect(normalizeExistingProjectRoot(`  ${linked}  `)).toBe(linked);
  });

  it("keeps missing paths and regular files on the same typed refusal", () => {
    const parent = mkdtempSync(join(tmpdir(), "claudexor-root-invalid-"));
    roots.push(parent);
    const file = join(parent, "file.txt");
    writeFileSync(file, "not a directory");

    for (const value of [join(parent, "missing"), file]) {
      try {
        normalizeExistingProjectRoot(value);
        throw new Error("expected project-root refusal");
      } catch (error) {
        expect(error).toMatchObject({ status: 400 });
        expect(String(error)).toContain("does not exist or is not a directory");
      }
    }
  });
});

describe("findAcceptedAroundPreflight", () => {
  it("returns an earlier accepted command without invoking mutable preflight", async () => {
    const accepted = { id: "job-prior" };
    let preflights = 0;
    await expect(
      findAcceptedAroundPreflight(
        async () => accepted,
        async () => {
          preflights += 1;
          throw new Error("mutable capability disappeared");
        },
      ),
    ).resolves.toBe(accepted);
    expect(preflights).toBe(0);
  });

  it("returns a command accepted while a failing mutable preflight was in flight", async () => {
    const accepted = { id: "job-raced" };
    let durable: typeof accepted | null = null;
    let releasePreflight!: () => void;
    const preflightEntered = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let probes = 0;

    const result = findAcceptedAroundPreflight(
      async () => {
        probes += 1;
        return durable;
      },
      async () => {
        await preflightEntered;
        throw new Error("mutable capability disappeared");
      },
    );
    durable = accepted;
    releasePreflight();

    await expect(result).resolves.toBe(accepted);
    expect(probes).toBe(2);
  });

  it("preserves the original preflight error when the race-closing probe misses", async () => {
    const preflightError = new Error("mutable capability disappeared");
    await expect(
      findAcceptedAroundPreflight(
        async () => null,
        async () => {
          throw preflightError;
        },
      ),
    ).rejects.toBe(preflightError);
  });

  it("keeps custody unknown when the race-closing durable lookup cannot be read", async () => {
    const preflightError = Object.assign(new Error("retired access"), {
      status: 409,
      code: "retired_access_profile",
      retryable: false,
      requiredActions: ["Choose an active access profile."],
    });
    const lookupError = new Error("durable command index unavailable");
    let probes = 0;
    await expect(
      findAcceptedAroundPreflight(
        async () => {
          probes += 1;
          if (probes === 1) return null;
          throw lookupError;
        },
        async () => {
          throw preflightError;
        },
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "idempotency_status_unavailable",
      retryable: true,
      cause: lookupError,
      context: {
        stage: "lookup_after_preflight",
        cause: {
          message: "durable command index unavailable",
          requiredActions: [],
          context: {},
        },
        preflight: {
          message: "retired access",
          code: "retired_access_profile",
          status: 409,
          retryable: false,
          requiredActions: ["Choose an active access profile."],
          context: {},
        },
      },
    });
    expect(probes).toBe(2);
  });

  it("surfaces the daemon's typed project_not_registered as a 404, not an unknown custody 503", async () => {
    // The daemon socket carries code/status/retryable but drops requiredActions.
    const transported = Object.assign(new Error("project is not registered: /tmp/unregistered"), {
      code: "project_not_registered",
      status: 404,
      retryable: false,
    });
    let preflights = 0;
    const refusal = await findAcceptedAroundPreflight(
      async () => {
        throw transported;
      },
      async () => {
        preflights += 1;
      },
    ).catch((error: unknown) => error);
    expect(refusal).toBe(transported);
    expect(refusal).toMatchObject({
      status: 404,
      code: "project_not_registered",
      retryable: false,
      requiredActions: [expect.stringMatching(/POST \/v2\/projects.*scope\.ephemeral=true/)],
    });
    expect(preflights).toBe(0);
  });

  it("keeps an unrelated lookup failure on the retryable 503", async () => {
    await expect(
      findAcceptedAroundPreflight(
        async () => {
          throw Object.assign(new Error("journal partition quarantined"), {
            code: "partition_unavailable",
            status: 503,
          });
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "idempotency_status_unavailable",
      retryable: true,
      context: {
        stage: "lookup_before_preflight",
        cause: {
          code: "partition_unavailable",
          status: 503,
          message: "journal partition quarantined",
        },
      },
    });
  });

  it.each([
    ["idempotency_conflict", 409],
    ["invalid_idempotency_key", 400],
  ])("preserves the canonical %s refusal and its original facts", async (code, status) => {
    const error = Object.assign(new Error("canonical lookup refusal"), {
      code,
      status,
      context: { detail: "original evidence" },
      requiredActions: ["Original remedy."],
    });
    const result = await findAcceptedAroundPreflight(
      async () => {
        throw error;
      },
      async () => {
        throw new Error("must not reach preflight");
      },
    ).catch((failure: unknown) => failure);
    expect(result).toBe(error);
    expect(result).toMatchObject({
      code,
      status,
      retryable: false,
      context: { detail: "original evidence" },
      requiredActions: ["Original remedy."],
    });
  });
});

describe("ephemeral project roots", () => {
  it("carries the one-shot declaration through normalization", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-ephemeral-root-"));
    roots.push(root);

    const declared = normalizeRunStartRequest({
      prompt: "do the thing",
      mode: "agent",
      scope: { kind: "project", root, ephemeral: true },
    });
    // The scope is rebuilt field-by-field during normalization; dropping the
    // flag here would silently register the disposable tree after all.
    expect(declared.scope).toEqual({ kind: "project", root, context: "auto", ephemeral: true });

    const ordinary = normalizeRunStartRequest({
      prompt: "do the thing",
      mode: "agent",
      scope: { kind: "project", root },
    });
    expect(ordinary.scope).toEqual({ kind: "project", root, context: "auto", ephemeral: false });
  });
});

describe("readonly strategy admission", () => {
  it.each([
    { attempts: 2 },
    { untilClean: true },
    { tests: [{ program: "sh", args: ["-c", "true"], envAllowlist: [] }] },
  ])("refuses write-backed controls before enqueue (%o)", (strategy) => {
    try {
      normalizeRunStartRequest({
        prompt: "repair without write access",
        mode: "agent",
        access: "readonly",
        ...strategy,
      });
      throw new Error("expected readonly strategy refusal");
    } catch (error) {
      expect(error).toMatchObject({
        status: 400,
        code: "strategy_access_incompatible",
        retryable: false,
        requiredActions: [expect.stringMatching(/workspace_write\/full/)],
      });
    }
  });
});

describe("delegated execution.workspaceRoot", () => {
  function pair() {
    const parent = mkdtempSync(join(tmpdir(), "claudexor-workspace-root-"));
    roots.push(parent);
    const project = join(parent, "stable-project");
    const execution = join(parent, "execution-tree");
    mkdirSync(project);
    mkdirSync(execution);
    return { project, execution };
  }

  it("preserves stable project identity separately from the execution tree", () => {
    const { project, execution } = pair();
    const request = normalizeRunStartRequest({
      prompt: "edit the private tree",
      mode: "agent",
      scope: { kind: "project", root: project },
      execution: { isolation: "live", delegated: true, workspaceRoot: execution },
      access: "workspace_write",
    });
    expect(request.scope).toMatchObject({ kind: "project", root: project });
    expect(request.execution.workspaceRoot).toBe(execution);
  });

  it("requires the field on fresh mutating delegated live runs", () => {
    const { project } = pair();
    expect(() =>
      normalizeRunStartRequest({
        prompt: "edit",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true },
        access: "workspace_write",
      }),
    ).toThrow(/workspaceRoot is required/);
    expect(
      normalizeRunStartRequest({
        prompt: "inspect",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true },
        access: "readonly",
      }).access,
    ).toBe("readonly");
    // Omitted Agent access is project-configured and cannot be guessed by this
    // filesystem-only normalizer. The project-aware preflight resolves it.
    expect(
      normalizeRunStartRequest({
        prompt: "use the project default",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true },
      }).execution.workspaceRoot,
    ).toBeUndefined();
  });

  it("refuses relative, missing, and non-external workspace declarations", () => {
    const { project } = pair();
    const base = {
      prompt: "edit",
      mode: "agent" as const,
      scope: { kind: "project" as const, root: project },
      access: "workspace_write" as const,
    };
    expect(() =>
      normalizeRunStartRequest({
        ...base,
        execution: { isolation: "live", delegated: true, workspaceRoot: "relative/tree" },
      }),
    ).toThrow(/absolute path/);
    expect(() =>
      normalizeRunStartRequest({
        ...base,
        execution: {
          isolation: "live",
          delegated: true,
          workspaceRoot: join(project, "missing"),
        },
      }),
    ).toThrow(/does not exist/);
    expect(() =>
      normalizeRunStartRequest({
        ...base,
        execution: { isolation: "live", delegated: false, workspaceRoot: project },
      }),
    ).toThrow(/only for project-scoped delegated runs/);
  });

  it("allows bounded legacy Exact Retry but revalidates a frozen new-shape workspace", () => {
    const { project, execution } = pair();
    expect(
      normalizeRunStartRequest({
        prompt: "legacy retry",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true },
        access: "workspace_write",
        retryOf: "run-old",
      }).execution.workspaceRoot,
    ).toBeUndefined();
    rmSync(execution, { recursive: true, force: true });
    expect(() =>
      normalizeRunStartRequest({
        prompt: "new-shape retry",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true, workspaceRoot: execution },
        access: "workspace_write",
        retryOf: "run-new",
      }),
    ).toThrow(/does not exist/);
  });
});

describe("execution.auxiliaryWritableRoots at the run-start boundary", () => {
  function fixture() {
    const parent = mkdtempSync(join(tmpdir(), "claudexor-aux-start-"));
    roots.push(parent);
    const project = join(parent, "project");
    const cache = join(parent, "cache");
    mkdirSync(project);
    mkdirSync(cache);
    const link = join(parent, "cache-link");
    symlinkSync(cache, link);
    return { project, cache, link, missing: join(parent, "missing") };
  }
  const start = (project: string, roots: string[], extra: Record<string, unknown> = {}) =>
    normalizeRunStartRequest({
      prompt: "bootstrap",
      mode: "agent",
      scope: { kind: "project", root: project },
      execution: { auxiliaryWritableRoots: roots },
      ...extra,
    });
  const refusal = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("expected a typed refusal");
  };

  it("keeps the caller spelling; canonicalization belongs to engine admission", () => {
    const { project, link } = fixture();
    expect(start(project, [link]).execution.auxiliaryWritableRoots).toEqual([link]);
    expect(start(project, []).execution.auxiliaryWritableRoots).toEqual([]);
  });

  it("refuses relative and missing paths, deferring only existence for thread-bound runs", () => {
    const { project, missing } = fixture();
    expect(refusal(() => start(project, ["cache"]))).toMatchObject({
      code: "auxiliary_writable_root_invalid",
      status: 400,
      retryable: false,
    });
    expect(refusal(() => start(project, [missing]))).toMatchObject({
      code: "auxiliary_writable_root_invalid",
      retryable: true,
    });
    const deferred = (roots: string[]) =>
      normalizeRunStartRequest(
        {
          prompt: "turn",
          mode: "agent",
          scope: { kind: "project", root: project },
          execution: { auxiliaryWritableRoots: roots },
        },
        { deferExecutionWorkspaceAvailability: true },
      );
    expect(deferred([missing]).execution.auxiliaryWritableRoots).toEqual([missing]);
    expect(refusal(() => deferred(["cache"]))).toMatchObject({
      code: "auxiliary_writable_root_invalid",
    });
  });

  it("refuses read-only modes and explicit non-workspace_write access, never changing access", () => {
    const { project, cache } = fixture();
    for (const extra of [
      { mode: "ask" },
      { mode: "plan" },
      { access: "readonly" },
      { access: "full" },
      { access: "inherit_native" },
    ]) {
      expect(refusal(() => start(project, [cache], extra))).toMatchObject({
        code: "auxiliary_writable_roots_access_conflict",
        status: 400,
      });
    }
    // An omitted Agent access is the project default: the preflight decides it.
    expect(start(project, [cache]).access).toBeUndefined();
    expect(start(project, [cache], { access: "workspace_write" }).access).toBe("workspace_write");
  });
});
