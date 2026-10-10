import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableJournal } from "@claudexor/journal";
import type { ModelAdapter } from "@claudexor/core";
import { loadRuntimeConcurrencyCaps } from "../../config/src/index.js";
import {
  CredentialProfile,
  ControlDaemonStatus,
  ControlModelOperationDetail,
  ModelCallRequest,
  ModelCallResult,
  RuntimeConcurrencyCaps,
  isModelOperation,
  type ModelPayloadRef,
} from "@claudexor/schema";
import { CommandStore } from "./command-store.js";
import { DaemonLocalClient } from "./daemon-local-client.js";
import { DaemonServer, type DaemonOptions } from "./server.js";
import { ModelOperations } from "./model-operations.js";
import { ResourceStore } from "./resource-store.js";
import { DaemonControlApiServer } from "../../control-api/src/daemon-server.js";
import { modelOperationControlServices } from "../../cli/src/model-operation-control.js";
import { settingsSnapshot } from "../../cli/src/settings-service.js";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.unstubAllEnvs();
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
const route = {
  source: "fixture",
  credentialProfileId: "fixture",
  accountFingerprint: "account",
  model: "fixture-model",
};
const answer = () =>
  ModelCallResult.parse({
    outcome: "completed",
    message: { role: "assistant", content: "one answer" },
    route,
    usage: { input_tokens: 3, output_tokens: 2 },
    cost: { knowledge: "unknown", billing: "unknown", source: "fixture", provenance: ["fixture"] },
    appliedOptions: {},
    problem: null,
  });

/** In-process scheduler + real HTTP control boundary, no daemon process,
 * vendor CLI, account store, auth flow or live engine endpoint. */
async function fixture(
  options: {
    caps?: Partial<RuntimeConcurrencyCaps>;
    maxConcurrent?: DaemonOptions["maxConcurrent"];
    holdModel?: boolean;
    holdPreparation?: boolean;
    delegation?: boolean;
    fromConfig?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-admission-")));
  let configuredCaps: RuntimeConcurrencyCaps | undefined;
  const configFile = join(root, "config", "config.yaml");
  if (options.fromConfig) {
    mkdirSync(join(root, "config"));
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(root, "config"));
    for (const name of [
      "CLAUDEXOR_MAX_CONCURRENT",
      "CLAUDEXOR_MAX_CONCURRENT_NON_MODEL_JOBS",
      "CLAUDEXOR_MAX_CONCURRENT_MODEL_OPERATIONS",
      "CLAUDEXOR_MAX_PARALLEL_CANDIDATES",
      "CLAUDEXOR_MAX_DEEP_SCAN_WIDTH",
      "CLAUDEXOR_MAX_COUNCIL_MEMBERS",
    ])
      vi.stubEnv(name, undefined);
    writeFileSync(configFile, JSON.stringify({ runtime: options.caps ?? {} }));
    configuredCaps = loadRuntimeConcurrencyCaps(root);
  }
  const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
  const store = new CommandStore(journal);
  const commands = { current: () => store };
  const resources = new ResourceStore(join(root, "resources"));
  const preparation = barrier(),
    modelResult = barrier();
  if (!options.holdPreparation) preparation.release();
  if (!options.holdModel) modelResult.release();
  const agents = new Map<string, () => void>();
  const startedAgents: string[] = [];
  let completedAgents = 0;
  let sends = 0;
  let server!: DaemonServer;
  const client = new DaemonLocalClient(() => server);
  const profile = CredentialProfile.parse({
    profile_id: "fixture",
    harness_id: "codex",
    display_name: "Fixture",
    credential_kind: "config_dir_login",
    isolation_locator: join(root, "unused-profile"),
  });
  const adapter: ModelAdapter = {
    id: "fixture",
    catalog: vi.fn(),
    invoke: async (_request, context) => {
      await context.onDispatch(route);
      sends++;
      await modelResult.promise;
      return answer();
    },
  };
  const operations = new ModelOperations({
    commands,
    resources: () => resources,
    enqueue: (envelope) => client.call("claudexor.enqueue", envelope),
    cancel: (id, reason) => client.cancel(id, reason),
    resolve: async () => {
      await preparation.promise;
      return { adapter, profile };
    },
  });
  const identity = { version: "4.0.0", buildSha: "a".repeat(40) },
    lease = { pid: process.pid, token: "fixture-lease" };
  let replacements = 0;
  const acceptedChildren = new Set<string>();
  server = new DaemonServer({
    socketPath: join(root, "unused.sock"),
    token: "fixture-token",
    commands,
    ...(configuredCaps
      ? { runtimeConcurrencyCaps: configuredCaps }
      : options.caps
        ? { runtimeConcurrencyCaps: RuntimeConcurrencyCaps.parse(options.caps) }
        : {}),
    ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
    runtimeIdentity: identity,
    runtimeLeaseOwner: lease,
    onRuntimeReplacementRequested: async () => {
      replacements++;
    },
    ...(options.delegation
      ? {
          delegationAuthority: {
            assertCanAdmitChild: () => {
              if (acceptedChildren.size >= 8) throw new Error("child allowance exhausted");
            },
            noteChildAccepted: (_parent: string, id: string) => {
              acceptedChildren.add(id);
            },
            cancelAcceptedChild: (_parent: string, id: string) => {
              acceptedChildren.delete(id);
            },
            beginParentClose: () => {},
          },
        }
      : {}),
    runner: async (params, context) => {
      if (isModelOperation(params)) return operations.execute(params, context);
      const prompt = (params as { prompt?: string }).prompt ?? context.jobId;
      startedAgents.push(prompt);
      context.onRunStart({
        runId: `run-${context.jobId}`,
        taskId: `task-${context.jobId}`,
        runDir: join(root, context.jobId),
      });
      await new Promise<void>((done) => {
        agents.set(context.jobId, done);
        context.signal.addEventListener("abort", () => done(), { once: true });
      });
      agents.delete(context.jobId);
      completedAgents++;
      return { lifecycle: context.signal.aborted ? "cancelled" : "succeeded" };
    },
    onCommandTerminal: (record) => operations.onCommandTerminal(record),
  });
  const api = new DaemonControlApiServer({
    token: "fixture-token",
    daemon: client,
    runStartTimeoutMs: 0,
    pollMs: 1,
    services: {
      ...modelOperationControlServices(operations, (id) => server.admission(id)),
      ...(configuredCaps ? { settings: async () => settingsSnapshot(root, configuredCaps) } : {}),
    },
  });
  const address = await api.start();
  const headers = {
    Authorization: "Bearer fixture-token",
    "X-Claudexor-Protocol-Major": "3",
    "Content-Type": "application/json",
  };
  const call = async (path: string, method = "GET", body?: unknown, key?: string) => {
    const response = await fetch(`http://${address.host}:${address.port}/v2${path}`, {
      method,
      headers: { ...headers, ...(key ? { "Idempotency-Key": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    expect(response.ok, JSON.stringify(value)).toBe(true);
    return value;
  };
  const upload = (): ModelPayloadRef =>
    resources.publishModel(
      Buffer.from(
        JSON.stringify(
          ModelCallRequest.parse({
            source: "fixture",
            model: "fixture-model",
            account: { mode: "pin", profileId: "fixture" },
            messages: [{ role: "user", content: "one generation" }],
          }),
        ),
      ),
    );
  const health = async () => ControlDaemonStatus.parse(await call("/daemon/status"));
  const createAgent = async (prompt: string) =>
    (await call(
      "/runs",
      "POST",
      { prompt, mode: "agent", scope: { kind: "project", root } },
      prompt,
    )) as { jobId: string };
  const createModel = async (key: string, ref = upload()) =>
    ControlModelOperationDetail.parse(
      await call("/model-operations", "POST", { request: ref }, key),
    );
  const detail = async (id: string) =>
    ControlModelOperationDetail.parse(await call(`/model-operations/${id}`));
  const done = async (id: string) => {
    await vi.waitFor(() =>
      expect(["queued", "running"]).not.toContain(operations.inspect(id).state),
    );
    return detail(id);
  };
  disposers.push(async () => {
    preparation.release();
    modelResult.release();
    for (const release of agents.values()) release();
    await server.stop();
    await api.stop();
    operations.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    configFile,
    store,
    server,
    client,
    health,
    call,
    createAgent,
    createModel,
    detail,
    done,
    upload,
    preparation,
    modelResult,
    agents,
    startedAgents,
    get sends() {
      return sends;
    },
    get completedAgents() {
      return completedAgents;
    },
    get replacements() {
      return replacements;
    },
    target: { ...identity, leaseOwner: lease },
  };
}

describe("single scheduler admission through public control boundaries", () => {
  it("24 Agent runners plus 4 queued Agents cannot block an unlimited raw model class", async () => {
    const f = await fixture({ caps: { max_concurrent_non_model_jobs: 24 }, fromConfig: true });
    for (let n = 0; n < 28; n++) await f.createAgent(`agent-${n}`);
    expect(await f.health()).toMatchObject({
      active: 24,
      queue: 4,
      admission: { active: { non_model: 24, model: 0 }, queued: { non_model: 4, model: 0 } },
    });
    const ref = f.upload();
    const created = await f.createModel("raw", ref);
    const result = await f.done(created.id);
    expect(result).toMatchObject({
      state: "succeeded",
      dispatch: { state: "response_received" },
      response: { state: "ready" },
      admission: null,
      cost: { knowledge: "unknown" },
    });
    expect(f.sends).toBe(1);
    expect(f.completedAgents).toBe(0);
    expect(f.startedAgents).toHaveLength(24);
    expect((await f.createModel("raw", ref)).id).toBe(created.id);
    if (result.response.state !== "ready") throw new Error("model response is not ready");
    await f.call(`/model-operations/${created.id}/ack`, "POST", {
      sha256: result.response.ref.sha256,
    });
    expect((await f.createModel("raw", ref)).id).toBe(created.id);
    expect(f.sends).toBe(1);
    expect(await f.health()).toMatchObject({
      active: 24,
      queue: 4,
      admission: { active: { model: 0, non_model: 24 } },
    });
  });

  it.each([false, true])(
    "an absent default admits the twenty-fifth Agent through POST runs (config=%s)",
    async (fromConfig) => {
      const f = await fixture({ fromConfig });
      for (let n = 0; n < 25; n++) await f.createAgent(`agent-${n}`);
      expect(f.startedAgents).toHaveLength(25);
      expect(await f.health()).toMatchObject({
        active: 25,
        queue: 0,
        capacity: {
          maxConcurrent: "unlimited",
          maxConcurrentNonModelJobs: "unlimited",
          maxConcurrentModelOperations: "unlimited",
          sources: { max_concurrent: "default" },
        },
      });
    },
  );

  it.each([false, true])(
    "explicit global24 keeps raw queued and reports that exact observed blocker (config=%s)",
    async (fromConfig) => {
      const f = await fixture(
        fromConfig ? { fromConfig: true, caps: { max_concurrent: 24 } } : { maxConcurrent: 24 },
      );
      for (let n = 0; n < 24; n++) await f.createAgent(`agent-${n}`);
      const raw = await f.createModel("blocked");
      expect(raw).toMatchObject({
        state: "queued",
        startedAt: null,
        dispatch: { state: "not_started" },
        admission: {
          class: "model",
          phase: "queued",
          blockers: [{ kind: "global_limit", limit: 24 }],
        },
      });
      expect(f.sends).toBe(0);
      expect(await f.health()).toMatchObject({
        active: 24,
        queue: 1,
        admission: { queued: { model: 1, non_model: 0 } },
        capacity: { maxConcurrent: 24 },
      });
      f.agents.values().next().value!();
      await f.done(raw.id);
      expect(f.sends).toBe(1);
      expect(f.completedAgents).toBe(1);
    },
  );

  it("a saturated model class lets an Agent pass and cancels queued raw with zero send", async () => {
    const f = await fixture({ caps: { max_concurrent_model_operations: 1 }, holdModel: true });
    const first = await f.createModel("one");
    await vi.waitFor(() => expect(f.sends).toBe(1));
    const second = await f.createModel("two");
    expect(second).toMatchObject({
      state: "queued",
      admission: { blockers: [{ kind: "class_limit", limit: 1 }] },
    });
    await f.createAgent("independent");
    expect(f.startedAgents).toEqual(["independent"]);
    const cancelled = await f.call(`/model-operations/${second.id}/control`, "POST", {
      action: "cancel",
    });
    expect(cancelled).toMatchObject({
      state: "cancelled",
      dispatch: { state: "not_started" },
      admission: null,
    });
    expect(f.sends).toBe(1);
    expect(await f.health()).toMatchObject({
      active: 2,
      queue: 0,
      admission: { active: { model: 1, non_model: 1 } },
    });
    f.modelResult.release();
    await f.done(first.id);
  });

  it("same-thread serialization remains while independent eligible work passes", async () => {
    const f = await fixture({ caps: { max_concurrent_non_model_jobs: 2 } });
    const first = await f.client.enqueue({ prompt: "first", threadId: "thread-one" });
    const second = await f.client.enqueue({ prompt: "second", threadId: "thread-one" });
    await f.client.enqueue({ prompt: "independent", threadId: "thread-two" });
    expect(f.startedAgents).toEqual(["first", "independent"]);
    expect(f.server.admission(second.id)).toMatchObject({
      phase: "queued",
      blockers: expect.arrayContaining([{ kind: "thread_busy" }]),
    });
    f.agents.get(first.id)!();
    await vi.waitFor(() => expect(f.startedAgents).toEqual(["first", "independent", "second"]));
  });

  it("reports a file edit as pending without resizing either live class", async () => {
    const f = await fixture({ fromConfig: true, caps: { max_concurrent_non_model_jobs: 1 } });
    await f.createAgent("one");
    await f.createAgent("two");
    writeFileSync(
      f.configFile,
      JSON.stringify({ runtime: { max_concurrent: 1, max_concurrent_non_model_jobs: 2 } }),
    );
    expect(await f.call("/settings")).toMatchObject({
      runtime: {
        concurrency: {
          configured: { maxConcurrent: 1, maxConcurrentNonModelJobs: 2 },
          effective: { maxConcurrent: "unlimited", maxConcurrentNonModelJobs: 1 },
          restartRequired: true,
        },
      },
    });
    await f.createAgent("three");
    const model = await f.createModel("still-unlimited-global");
    await f.done(model.id);
    expect(f.startedAgents).toEqual(["one"]);
    expect(f.completedAgents).toBe(0);
    expect(f.sends).toBe(1);
    expect(await f.health()).toMatchObject({
      active: 1,
      queue: 2,
      capacity: { maxConcurrent: "unlimited", maxConcurrentNonModelJobs: 1 },
    });
  });

  it("cancel during preparation never sends and keeps lifetime until preparation settles", async () => {
    const f = await fixture({ holdPreparation: true });
    const raw = await f.createModel("preparing");
    expect(raw).toMatchObject({
      state: "running",
      dispatch: { state: "not_started" },
      admission: { phase: "active" },
    });
    await f.call(`/model-operations/${raw.id}/control`, "POST", { action: "cancel" });
    expect((await f.health()).active).toBe(1);
    expect(f.sends).toBe(0);
    await expect(
      f.client.call("claudexor.shutdownForRuntimeReplacement", f.target),
    ).rejects.toMatchObject({ code: "runtime_replacement_busy" });
    f.preparation.release();
    expect(await f.done(raw.id)).toMatchObject({
      state: "cancelled",
      dispatch: { state: "not_started" },
    });
    expect(f.sends).toBe(0);
  });

  it("running model cancel and shutdown retain active ownership until result settlement", async () => {
    const f = await fixture({ holdModel: true });
    const raw = await f.createModel("settlement");
    await vi.waitFor(() => expect(f.sends).toBe(1));
    await f.call(`/model-operations/${raw.id}/control`, "POST", { action: "cancel" });
    expect(await f.health()).toMatchObject({
      active: 1,
      running: true,
      admission: { active: { model: 1, non_model: 0 } },
    });
    await expect(
      f.client.call("claudexor.shutdownForRuntimeReplacement", f.target),
    ).rejects.toMatchObject({ code: "runtime_replacement_busy" });
    expect(f.replacements).toBe(0);
    let stopped = false;
    const stopping = f.server.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect((await f.health()).active).toBe(1);
    f.modelResult.release();
    await stopping;
    expect(f.sends).toBe(1);
    expect(await f.detail(raw.id)).toMatchObject({
      state: "cancelled",
      response: { state: "ready" },
      dispatch: { state: "response_received" },
      admission: null,
    });
  });

  it("admission/status do not replay retained command history", async () => {
    const f = await fixture({ caps: { max_concurrent_non_model_jobs: 1 } });
    for (let n = 0; n < 100; n++) {
      f.store.accept({
        id: `history-${n}`,
        params: { prompt: "retained" },
        idempotencyKey: `old-${n}`,
        clientId: "fixture",
      });
      f.store.update(`history-${n}`, { state: "succeeded", finishedAt: new Date().toISOString() });
    }
    const all = vi.spyOn(f.store, "records");
    await f.createAgent("one");
    await f.createAgent("two");
    // Legacy count is a map size, and scheduler metadata is live-only.
    all.mockClear();
    await f.health();
    const model = await f.createModel("raw");
    await f.done(model.id);
    // Completion's existing legacy prune may enumerate history; admission itself must not.
    all.mockClear();
    await f.createAgent("three");
    await f.health();
    expect(all).not.toHaveBeenCalled();
  });

  it.each([
    { max_concurrent: 1 },
    { max_concurrent_non_model_jobs: 1 },
    { max_concurrent: 1, max_concurrent_non_model_jobs: 1 },
  ])("preserves exactly one Delegate overflow under %j", async (caps) => {
    const f = await fixture({ caps, delegation: true });
    const parent = await f.client.enqueue({ prompt: "parent", delegate: true });
    const request = (prompt: string) => ({
      prompt,
      mode: "ask",
      parentRunId: `run-${parent.id}`,
      delegatedFromRunId: `run-${parent.id}`,
    });
    const first = await f.client.enqueue(request("child-one"), {
      clientId: "delegation-belt",
      operation: "delegated-run",
    });
    const second = await f.client.enqueue(request("child-two"), {
      clientId: "delegation-belt",
      operation: "delegated-run",
    });
    expect(f.startedAgents).toEqual(["parent", "child-one"]);
    expect(await f.health()).toMatchObject({
      active: 2,
      queue: 1,
      admission: { active: { non_model: 2, model: 0 } },
    });
    expect(f.server.admission(second.id)?.blockers.length).toBeGreaterThan(0);
    f.agents.get(first.id)!();
    await vi.waitFor(() => expect(f.startedAgents).toEqual(["parent", "child-one", "child-two"]));
    expect(f.agents.has(parent.id)).toBe(true);
    expect(f.agents.has(second.id)).toBe(true);
    expect((await f.health()).active).toBe(2);
  });
});
