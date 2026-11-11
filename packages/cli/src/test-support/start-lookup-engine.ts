/**
 * A real accepted-start engine over one private root, for lookup tests and private
 * store regressions: the SQL owners at `<root>/daemon`, the daemon socket with the
 * caller's runner, the HTTP control API and the durable thread services. No harness,
 * credential, installed engine or operator root is involved.
 *
 * `sqlFixture` upgrades an older store schema in place, and starting the daemon runs
 * its ordinary history prune, so point `root` at a private copy and pass `daemon`
 * retention options when old rows must survive. Closing keeps the root; the caller
 * removes it after `close()` settles.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DaemonClient, DaemonServer, type DaemonOptions, type RunnerFn } from "@claudexor/daemon";
import { DaemonControlApiServer, type DaemonFacadeClient } from "@claudexor/control-api";
import { sqlFixture } from "../../../daemon/src/store/test-support/sql-fixture.js";
import { threadTurnServices } from "../thread-turn-services.js";

const TOKEN = "start-lookup-fixture";

type ThreadServices = ReturnType<typeof threadTurnServices>;
type ControlOptions = ConstructorParameters<typeof DaemonControlApiServer>[0];

export interface StartLookupEngineOptions {
  root: string;
  runner: RunnerFn;
  /** Daemon scheduling and retention options (concurrency, history prune, clock). */
  daemon?: Partial<
    Pick<DaemonOptions, "maxConcurrent" | "maxHistory" | "idempotencyRetentionMs" | "now">
  >;
  /** The control API's view of the real daemon client, e.g. a tripwire proxy. */
  facade?: (client: DaemonClient) => DaemonFacadeClient;
  /** The control API's services over the real thread services, e.g. with tripwires. */
  services?: (real: ThreadServices) => NonNullable<ControlOptions["services"]>;
  /** Replaces the real store identity provider. */
  storeId?: (real: () => string | undefined) => () => string | undefined;
  runStartTimeoutMs?: number;
}

export async function startLookupEngine(options: StartLookupEngineOptions) {
  const sql = await sqlFixture(options.root);
  // The daemon's own endpoint convention: a named pipe on Windows, a socket file elsewhere.
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\claudexor-start-lookup-${randomUUID()}`
      : join(options.root, "d.sock");
  const daemon = new DaemonServer({
    socketPath,
    token: TOKEN,
    commands: sql.graph.commands,
    runner: options.runner,
    // As the production composition records it: a turn whose job ended before a run.
    onTurnEnqueueFailed: (turnId, problem) =>
      sql.graph.threads.setTurnEnqueueError(turnId, problem),
    ...options.daemon,
  });
  try {
    await daemon.start();
  } catch (error) {
    await sql.close();
    throw error;
  }
  const client = new DaemonClient(socketPath, TOKEN);
  const real = threadTurnServices(sql.graph.threads, sql.graph.resources);
  const identity = () => sql.store.storeId;
  const control = new DaemonControlApiServer({
    token: TOKEN,
    daemon: options.facade?.(client) ?? client,
    pollMs: 5,
    storeId: options.storeId?.(identity) ?? identity,
    services: options.services?.(real) ?? real,
    ...(options.runStartTimeoutMs === undefined
      ? {}
      : { runStartTimeoutMs: options.runStartTimeoutMs }),
  });
  let address: { host: string; port: number };
  try {
    address = await control.start();
  } catch (error) {
    await daemon.stop();
    await sql.close();
    throw error;
  }
  const baseUrl = `http://${address.host}:${address.port}`;
  const base = `${baseUrl}/v2`;
  const post = async (path: string, body: unknown, key?: string) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "X-Claudexor-Protocol-Major": "3",
        ...(key === undefined ? {} : { "Idempotency-Key": key }),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  let closing: Promise<void> | undefined;
  return {
    sql,
    client,
    storeId: sql.store.storeId,
    /** Attach any control-API client (e.g. an embedding host's gateway): it handshakes itself. */
    testConnection: { baseUrl, token: TOKEN },
    post,
    get: async (path: string) => {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${TOKEN}`, "X-Claudexor-Protocol-Major": "3" },
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    },
    lookupRun: (body: unknown, key: string) => post("/runs/lookup", body, key),
    lookupTurn: (threadId: string, body: unknown, key: string) =>
      post(`/threads/${encodeURIComponent(threadId)}/turns/lookup`, body, key),
    /** One close for every caller: control API, daemon, then the store. */
    close(): Promise<void> {
      return (closing ??= (async () => {
        await control.stop();
        await daemon.stop();
        await sql.close();
      })());
    },
  };
}

export type StartLookupEngine = Awaited<ReturnType<typeof startLookupEngine>>;
