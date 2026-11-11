/**
 * Daemon side of the profile-admission integration fixture: the real engine
 * store, SQL services graph, SQL runtime (its agent runner builds the real
 * Orchestrator), Control API server and control services over isolated config
 * and temp roots. The importing test mocks `../registry.js` with
 * `fixtureRegistry`, so every consumer here resolves the instrumented adapters.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, vi } from "vitest";
import { updateGlobalConfig } from "@claudexor/config";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { runCapture } from "@claudexor/core";
import {
  EngineStore,
  createPartition,
  createSqlDaemonServices,
  setGlobalGenerationInTx,
} from "@claudexor/daemon";
import { canonicalProfileConfigDir } from "@claudexor/harness-claude";
import { canonicalCodexProfileHome } from "@claudexor/harness-codex";
import { CredentialProfile } from "@claudexor/schema";
import { controlServices } from "../control-services.js";
import { createSqlDaemonRuntime } from "../sql-daemon-runtime.js";
import { count, ingress, recorder } from "./profile-admission-adapters.js";

const reap: string[] = [];
const closers: Array<() => Promise<void>> = [];
const observations: Record<string, unknown> = {};

/** Optional test diagnostics for comparing the same scenarios across Git trees. */
export function observe(name: string, value: unknown): void {
  observations[name] = value;
}

/** Folders whose test closed its daemons in time: the only ones removed at file end (#376). */
const closedRoots: string[] = [];

/** The close phase of this fixture's afterEachClosed hook; the tail hands the folders over. */
export async function closeDaemons(): Promise<() => void> {
  // This test's folders, taken before its closes: a later test never hands them over.
  const ownedRoots = reap.splice(0);
  for (const close of closers.splice(0).reverse()) await close();
  return () => {
    closedRoots.push(...ownedRoots);
  };
}

export function finishFixture(observationsPath?: string): void {
  for (const dir of closedRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (observationsPath) writeFileSync(observationsPath, JSON.stringify(observations, null, 2));
}

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  reap.push(dir);
  return dir;
}

export type Row = { id: string; harness: "codex" | "claude"; enabled?: boolean };

/** A fresh isolated config dir with these rows; `ready` rows answer a login probe. */
export function configure(
  rows: Row[],
  ready: string[],
  settings: (
    config: Parameters<Parameters<typeof updateGlobalConfig>[0]>[0],
  ) => object = () => ({}),
) {
  const configDir = temp("cx-b0-config-");
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  const locator = (row: Row) => join(configDir, "profiles", row.harness, row.id);
  for (const row of rows) mkdirSync(locator(row), { recursive: true });
  updateGlobalConfig((config) => ({
    ...config,
    credential_profiles: rows.map((row) =>
      CredentialProfile.parse({
        profile_id: row.id,
        harness_id: row.harness,
        display_name: row.id,
        enabled: row.enabled ?? true,
        credential_kind: "config_dir_login",
        isolation_locator: locator(row),
      }),
    ),
    runtime: {
      ...config.runtime,
      transient_retry: { ...config.runtime.transient_retry, max_retries: 0 },
    },
    ...settings(config),
  }));
  const home = (id: string) => {
    const row = rows.find((candidate) => candidate.id === id)!;
    return row.harness === "codex"
      ? canonicalCodexProfileHome(locator(row))
      : canonicalProfileConfigDir(locator(row));
  };
  recorder.loggedIn = new Set(ready.map((id) => resolve(home(id))));
  return {
    configDir,
    home,
    login: (id: string) => recorder.loggedIn.add(resolve(home(id))),
  };
}

export async function openDaemon() {
  const root = temp("cx-b0-root-");
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../../daemon/dist/store/flusher-worker.js"),
  });
  if (!store.prepare("SELECT value FROM meta WHERE key='global_pid'").get())
    store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
  const runtime = createSqlDaemonRuntime(graph, {
    server: { socketPath: join(root, "unused.sock"), token: "fixture" },
    authReadiness: () => ({ invalidate: () => {} }),
  });
  // Ingress ends at enqueue: snapshot every adapter read made before it.
  const daemon = new Proxy(runtime.client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "enqueue")
        return (...args: unknown[]) => {
          recorder.enqueues.push(ingress());
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // Thread reads made by the control plane (the runner reads its own graph).
  const controlThreads = new Proxy(Object.assign(graph.threads, { journal: () => undefined }), {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "getThread")
        return (id: string) => {
          count("threads.getThread");
          return (value as (id: string) => unknown).call(target, id);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const services = controlServices(
    graph.interactions,
    graph.liveInputs,
    () => graph.projects,
    controlThreads as never,
    { current: () => ({ list: () => [] }) } as never,
    undefined as never,
    undefined as never,
    () => graph.resources,
    () => graph.quota,
    graph.accounts,
    () => [],
  );
  const control = new DaemonControlApiServer({
    token: "fixture",
    daemon,
    bus: runtime.bus,
    pollMs: 5,
    terminalFilesPending: runtime.terminalFilesPending,
    services,
  });
  const { host, port } = await control.start();
  let closed = false;
  closers.push(async () => {
    if (closed) return;
    closed = true;
    await control.stop();
    await runtime.stop();
    await graph.close();
    await store.close();
  });
  return { graph, base: `http://${host}:${port}` };
}
type Daemon = Awaited<ReturnType<typeof openDaemon>>;

const headers = { authorization: "Bearer fixture", "X-Claudexor-Protocol-Major": "3" };
let keys = 0;
export async function http(
  daemon: Daemon,
  method: string,
  path: string,
  body?: unknown,
  key: string | null = `k-${++keys}`,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (method !== "GET") recorder.mark = { ...recorder.calls };
  const response = await fetch(`${daemon.base}/v2${path}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
  "base64",
);
export async function upload(daemon: Daemon, kind: "image" | "file") {
  const bytes = kind === "image" ? PNG : Buffer.from("plain notes\n");
  const mime = kind === "image" ? "image/png" : "text/plain";
  const created = await http(daemon, "POST", "/uploads", {
    kind,
    mime,
    name: kind === "image" ? "pixel.png" : "notes.txt",
    sizeBytes: bytes.length,
  });
  expect(created.status).toBe(201);
  const uploadId = String(created.body["uploadId"]);
  const written = await fetch(`${daemon.base}/v2/uploads/${uploadId}/bytes`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  expect(written.status).toBe(200);
  const finalized = await http(daemon, "POST", `/uploads/${uploadId}/finalize`, {});
  expect(finalized.status).toBe(201);
  return { resourceId: String(finalized.body["resourceId"]) };
}

export async function repository(
  daemon: Daemon,
  options: { git?: boolean; agents?: boolean } = {},
) {
  const repo = temp("cx-b0-repo-");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  if (options.agents) writeFileSync(join(repo, "AGENTS.md"), "# agent notes\n");
  if (options.git !== false) {
    await runCapture("git", ["-C", repo, "init", "-b", "main"]);
    await runCapture("git", ["-C", repo, "add", "-A"]);
    await runCapture("git", [
      "-C",
      repo,
      ...["-c", "user.email=t@t.dev", "-c", "user.name=t"],
      ...["commit", "-m", "init"],
    ]);
  }
  daemon.graph.projects.register({ root: repo, idempotencyKey: repo, clientId: "fixture" });
  return repo;
}

export async function terminal(daemon: Daemon, runId: string) {
  let detail: Record<string, unknown> = {};
  await vi.waitFor(
    async () => {
      detail = (await http(daemon, "GET", `/runs/${runId}`, undefined, null)).body;
      const state = (detail["summary"] as { state?: string } | undefined)?.state;
      expect(["succeeded", "failed", "cancelled", "interrupted"]).toContain(state);
    },
    { timeout: 60_000, interval: 50 },
  );
  const summary = detail["summary"] as { state: string; runDir: string; error?: string | null };
  const eventsPath = join(summary.runDir, "events.jsonl");
  const events = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
    : [];
  return { state: summary.state, error: summary.error ?? null, runDir: summary.runDir, events };
}

export async function succeeded(
  daemon: Daemon,
  answer: { status: number; body: Record<string, unknown> },
) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  const run = await terminal(daemon, String(answer.body["runId"]));
  expect({ state: run.state, error: run.error }).toEqual({ state: "succeeded", error: null });
  return run;
}
