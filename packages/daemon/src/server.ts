import { rpcProblem } from "./rpc-problem.js";
import { type Server, type Socket, createServer } from "node:net";

import {
  ControlRunStartRequest,
  TurnEnqueueProblem,
  type TurnEnqueueProblem as TurnEnqueueProblemValue,
  delegatedParentOf,
  resolveRunReviewRequested,
  normalizeCancelReasonCode,
  isTerminalLifecycle,
  type CancelReasonCode,
  type RuntimeConcurrencyCaps,
  type DaemonStoreFacts,
  type ConcurrencyLimit,
  type JobAdmission,
} from "@claudexor/schema";
import { daemonHealth, daemonConcurrencyCaps } from "./daemon-health.js";
import { RpcFollowers } from "./rpc-followers.js";
import { assertNoInlineSecretValues, newId, nowIso, pathExists } from "@claudexor/util";
import {
  commandStoreForId,
  commandStoreForRequest,
  type CommandBackend,
} from "./command-authority.js";
import {
  commandAcceptanceReceipt,
  admitCommandRequest,
  findAcceptedCommand,
  publicAcceptedCommand,
} from "./command-rpc.js";
import { parseCommandListQuery } from "./command-list-select.js";
import { clearStaleUnixSocketPath, listenOnDaemonEndpoint } from "./daemon-listen.js";
import { type DelegationAdmissionAuthority } from "./delegation-admission.js";
import {
  jobStateFromResult,
  publicJobRecord,
  resultReason,
  resultSummary,
  type JobRecord,
} from "./job-record.js";
import { settleJobError } from "./job-settlement.js";
import {
  admissionActivity,
  admissionJob,
  eligibleJobIndex,
  queuedAdmission,
  type AdmissionJob,
} from "./job-admission.js";
import {
  daemonTokenMatches,
  recoveryOnlyRefusal,
  servingModeOf,
  type DaemonServingModeSnapshot,
} from "./serving-admission.js";
import { socketAlive } from "./socket-probe.js";
import { isWindowsPipePath } from "./token.js";
import { dispatchShutdownRpc, type RuntimeReplacementAuthority } from "./daemon-shutdown-rpc.js";
export { jobStateFromResult, socketAlive, type JobRecord };

export interface RunContext {
  jobId: string;
  signal: AbortSignal;
  onRunStart: (info: { runId: string; taskId: string; runDir: string }) => void;
}

export type RunnerFn = (params: unknown, ctx: RunContext) => Promise<unknown>;

export interface DaemonOptions extends RuntimeReplacementAuthority {
  socketPath: string;
  token: string;
  runner: RunnerFn;
  maxConcurrent?: ConcurrencyLimit;
  /** Startup-frozen admission and strategy caps; omission has no finite admission ceiling. */
  runtimeConcurrencyCaps?: RuntimeConcurrencyCaps;
  storeFacts?: () => DaemonStoreFacts;
  commands: CommandBackend;
  delegationAuthority?: DelegationAdmissionAuthority;
  maxHistory?: number;
  idempotencyRetentionMs?: number;
  now?: () => Date;
  /** Called when a job reaches a terminal state (any path) with its runId —
   * used to drop pending interactions so a dead run never advertises
   * waiting_on_user. */
  onRunTerminal?: (runId: string, threadId?: string) => void;
  /** Best-effort observer after a durable terminal; it must not throw. */
  onCommandTerminal?: (record: JobRecord) => void;
  /** Called when a job that carried a pre-created thread turn (params.turnId)
   * settles failure-shaped WITHOUT ever binding a run — i.e. the refusal
   * happened before the run materialized (trust gate, preflight validation).
   * The observer persists one sanitized typed problem on the turn so it is
   * never a silent orphan bubble and no recovery field is dropped. */
  onTurnEnqueueFailed?: (turnId: string, problem: TurnEnqueueProblemValue) => void;
  onShutdownRequested?: () => Promise<void>;
  onRuntimeReplacementRequested?: () => Promise<void>;
  /** Issue #165 D5 admission snapshot; absent embedders always serve normal. */
  servingMode?: DaemonServingModeSnapshot;
  /** Test-only barriers around command authority acquisition. */
  startupBarrier?: (
    barrier: "before_registry_load" | "after_registry_load",
  ) => void | Promise<void>;
}

/** Daemon scheduling uses run lifecycle (D8); outcome quality stays on RunFacts.
 * The injected Orchestrator owns work within a job. */
export class DaemonServer {
  private server?: Server;
  private readonly followers = new RpcFollowers();
  private readonly queue: AdmissionJob[] = [];
  private readonly activeJobs = new Map<string, AdmissionJob>();
  private readonly cancelled = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly taskFailures: unknown[] = [];
  private readonly commands: CommandBackend;
  private get active(): number {
    return this.activeJobs.size;
  }
  private readonly startedAt = Date.now();
  private stopping = false;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private resolveShutdown!: () => void;
  private readonly shutdownPromise = new Promise<void>((resolve) => {
    this.resolveShutdown = resolve;
  });

  constructor(private readonly opts: DaemonOptions) {
    this.concurrency = daemonConcurrencyCaps(opts);
    this.commands = opts.commands;
  }

  async start(): Promise<void> {
    if (this.stopping) {
      throw Object.assign(new Error("daemon is stopping and cannot be started"), {
        code: "daemon_stopping",
        status: 503,
      });
    }
    this.startPromise ??= this.startOnce();
    await this.startPromise;
    if (this.stopping) {
      await this.stop();
      throw Object.assign(new Error("daemon startup was cancelled by shutdown"), {
        code: "daemon_stopping",
        status: 503,
      });
    }
  }

  private async startOnce(): Promise<void> {
    // A named pipe is not a filesystem entry: existence IS liveness (it
    // vanishes with its owning server), so the alive probe alone decides, and
    // the stale-file unlink/chmod below has nothing to act on.
    const pipeEndpoint = isWindowsPipePath(this.opts.socketPath);
    if (
      (pipeEndpoint || pathExists(this.opts.socketPath)) &&
      (await socketAlive(this.opts.socketPath))
    ) {
      throw new Error(
        `a claudexor daemon is already listening on ${this.opts.socketPath}; stop it first`,
      );
    }
    await this.opts.startupBarrier?.("before_registry_load");
    if (this.stopping) throw this.stoppingError("daemon startup was cancelled before listen");
    // With product admission closed (issue #165 D5 stage 3) the command
    // projections are not activated yet; the registry materializes (and its
    // history is pruned) once normal admission opens — see pruneHistory().
    if (servingModeOf(this.opts.servingMode) === "normal") this.pruneHistory();
    await this.opts.startupBarrier?.("after_registry_load");
    if (this.stopping) throw this.stoppingError("daemon startup was cancelled after registry load");
    if (!pipeEndpoint) clearStaleUnixSocketPath(this.opts.socketPath);
    if (this.stopping) throw this.stoppingError("daemon startup was cancelled before listen");
    this.server = createServer((sock) => this.onConnection(sock));
    await listenOnDaemonEndpoint(this.server, this.opts.socketPath, pipeEndpoint);
  }

  stop(): Promise<void> {
    this.stopping = true;
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  /** Physical store recovery may settle storage-only terminal failures once
   * every runner has exited; process/runner failures still refuse replacement. */
  stopForStoreRecovery(): Promise<void> {
    this.stopping = true;
    this.stopPromise ??= this.stopOnce(true);
    return this.stopPromise;
  }

  private async stopOnce(recoverStore = false): Promise<void> {
    for (const controller of this.controllers.values()) {
      try {
        controller.abort("host_cancelled" satisfies CancelReasonCode);
      } catch {
        /* already gone */
      }
    }

    const settled = await Promise.allSettled([...this.activeTasks]);
    const rejected = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    const failures = [...rejected.map((entry) => entry.reason), ...this.taskFailures];
    if (
      this.active !== 0 ||
      failures.some((error) => !recoverStore || !storageOnlyFailure(error))
    ) {
      const first =
        rejected[0]?.reason ??
        this.taskFailures[0] ??
        new Error(`daemon still owns ${this.active} active runner(s)`);
      throw Object.assign(
        new Error(
          `daemon shutdown drain failed: ${first instanceof Error ? first.message : String(first)}`,
        ),
        {
          code: "daemon_shutdown_unconfirmed",
          status: 503,
          cause: first,
        },
      );
    }
    // A signal may have fenced shutdown while listen() was still resolving.
    // Wait for that raw startup attempt, then close whatever listener exists;
    // start() observes `stopping` and refuses to advertise readiness.
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        /* a failed startup has no usable listener to preserve */
      }
    }
    const serverClosed = new Promise<void>((resolve, reject) => {
      if (!this.server) return resolve();
      try {
        this.server.close((error) => (error ? reject(error) : resolve()));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ERR_SERVER_NOT_RUNNING") resolve();
        else reject(error);
      }
    });

    // Existing local RPC sockets can otherwise keep server.close() pending
    // forever. They are destroyed only after every accepted command settled.
    this.followers.destroyAll();
    await serverClosed;
    this.resolveShutdown();
  }

  /** Resolves when the daemon is shut down via RPC. */
  waitForShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  private onConnection(sock: Socket): void {
    this.followers.attach(sock, (line) => void this.handle(line, sock));
  }

  private send(sock: Socket, obj: unknown): void {
    this.followers.send(sock, obj);
  }

  private async handle(line: string, sock: Socket): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    const { id, method, params, token } = msg;
    if (!daemonTokenMatches(typeof token === "string" ? token : "", this.opts.token)) {
      this.send(sock, { id, error: { message: "unauthorized" } });
      return;
    }
    try {
      this.send(sock, { id, result: await this.dispatch(method, params) });
    } catch (err) {
      this.send(sock, { id, error: rpcProblem(err) });
    }
  }

  /** The one RPC dispatcher: the token-checked socket handler and the daemon's
   * in-process `DaemonLocalClient` both enter here with JSON wire values. */
  async dispatch(method: string, params: any): Promise<unknown> {
    const shutdown = dispatchShutdownRpc(
      method,
      params,
      this.queue.length + this.active + this.activeTasks.size,
      () => this.commands.queries.active(),
      this.opts.onShutdownRequested ?? (() => this.stop()),
      this.opts.onRuntimeReplacementRequested,
      this.opts.runtimeIdentity,
      this.opts.runtimeLeaseOwner,
    );
    if (shutdown) return shutdown;
    const servingMode = servingModeOf(this.opts.servingMode);
    if (method === "claudexor.health") {
      const health = daemonHealth(
        this.startedAt,
        this.queue.length,
        this.active,
        servingMode === "normal" ? this.commands.queries.count() : 0,
        this.stopping,
        servingMode,
        this.concurrency,
        admissionActivity(this.activeJobs.values(), this.queue),
        this.opts.runtimeConcurrencyCaps !== undefined,
      );
      return this.opts.storeFacts ? { ...health, store: this.opts.storeFacts() } : health;
    }
    // Issue #165 D5: with product admission closed, every product RPC gets
    // one typed refusal; health above and the shutdown RPCs stay reachable.
    if (servingMode !== "normal") throw recoveryOnlyRefusal(method);
    switch (method) {
      case "claudexor.enqueue": {
        if (this.stopping) {
          throw Object.assign(new Error("daemon is stopping; retry after reconnect"), {
            code: "daemon_stopping",
            status: 503,
          });
        }
        const envelope = params as {
          request?: unknown;
          idempotencyKey?: unknown;
          clientId?: unknown;
          idempotencyRequest?: unknown;
          operation?: unknown;
        };
        const rawRequest = envelope?.request;
        const operation = typeof envelope.operation === "string" ? envelope.operation : undefined;
        const idempotencyKey = String(envelope?.idempotencyKey ?? "");
        const clientId = String(envelope?.clientId ?? "daemon-client");
        assertNoInlineSecretValues(rawRequest, "$", "daemon job params");
        // Idempotency precedes Delegate admission: replaying the exact command
        // must keep returning its durable job even after the parent is fenced
        // or its monotonic eight-child allowance is full. A different request
        // under the same key still conflicts inside find().
        const replay = findAcceptedCommand(this.commands, envelope);
        if (replay) return commandAcceptanceReceipt(replay, true);
        // Journal-owned belt admission spans retries/processes; ordinary
        // parentRunId alone never establishes delegated lineage.
        const request = admitCommandRequest(
          this.commands,
          rawRequest,
          operation,
          this.opts.delegationAuthority,
        );
        const delegatedFrom = delegatedParentOf(request);
        const accepted = this.acceptCommand(
          request,
          idempotencyKey,
          clientId,
          envelope.idempotencyRequest,
          operation,
        );
        if (!accepted.reused && delegatedFrom) {
          this.opts.delegationAuthority!.noteChildAccepted(delegatedFrom, accepted.record.id);
        }
        if (!accepted.reused) this.queue.push(admissionJob(accepted.record));
        void this.drain();
        return commandAcceptanceReceipt(accepted.record, accepted.reused);
      }
      case "claudexor.status": {
        const rec = this.getRecord(String(params?.id));
        if (!rec) throw new Error(`no such job: ${params?.id}`);
        return publicJobRecord(rec);
      }
      case "claudexor.findAccepted": {
        return publicAcceptedCommand(this.commands, params);
      }
      case "claudexor.list":
        return this.commands.queries.publicList(parseCommandListQuery(params?.query));
      case "claudexor.cancel": {
        return this.cancelJob(String(params?.id), normalizeCancelReasonCode(params?.reason_code));
      }
      case "claudexor.delegationFence": {
        const runId = String(params?.runId ?? "");
        const rec = this.commands.queries.getByRunId(runId);
        if (!rec || rec.state !== "running") {
          throw Object.assign(new Error(`no running Delegate parent run ${runId}`), {
            code: "delegation_parent_invalid",
            status: 409,
          });
        }
        if (!this.opts.delegationAuthority) {
          throw Object.assign(new Error(`no Delegate authority available for parent ${runId}`), {
            code: "delegation_budget_parent_unavailable",
            status: 409,
          });
        }
        this.opts.delegationAuthority.beginParentClose(runId);
        return { runId, fenced: true };
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private readonly concurrency: RuntimeConcurrencyCaps;

  /** One synchronous observation for the exact operation; never inferred by a
   * client from aggregate health. Missing means this scheduler owns no live job. */
  admission(id: string): JobAdmission | null {
    const running = this.activeJobs.get(id);
    if (running) return { class: running.class, phase: "active", blockers: [] };
    const queued = this.queue.find((job) => job.id === id);
    return queued
      ? queuedAdmission(queued, this.activeJobs.values(), this.concurrency, this.stopping)
      : null;
  }

  /** Daemon-owned cancellation primitive used by RPC and the Delegate drain
   * barrier. It is safe to repeat and preserves queued-admission cleanup. */
  cancelJob(jid: string, reasonCode?: CancelReasonCode): { id: string; cancelled: true } {
    const rec = this.getRecord(jid);
    if (!rec) throw new Error(`no such job: ${jid}`);
    this.cancelled.add(jid);
    if (rec.state === "queued") {
      this.updateRecord(rec, { state: "cancelled", finishedAt: nowIso() });
      const index = this.queue.findIndex((job) => job.id === jid);
      if (index !== -1) this.queue.splice(index, 1);
      const delegatedFrom = delegatedParentOf(rec.params);
      if (delegatedFrom) this.opts.delegationAuthority?.cancelAcceptedChild(delegatedFrom, rec.id);
    }
    if (rec.runId) this.opts.delegationAuthority?.beginParentClose(rec.runId);
    // The abort reason is the one channel a cancel's provenance rides into
    // the terminal writers. Only enum members reach this parameter: RunControl
    // validates the HTTP boundary, normalizeCancelReasonCode the raw RPC.
    this.controllers.get(jid)?.abort(reasonCode || undefined);
    return { id: jid, cancelled: true };
  }

  private stoppingError(message: string): Error & { code: string; status: number } {
    return Object.assign(new Error(message), { code: "daemon_stopping", status: 503 });
  }

  /** Age/cap and params-byte command retention: at normal admission and after every terminal. */
  pruneHistory(): void {
    const removed = this.commands.pruneHistory(
      this.opts.maxHistory ?? 500,
      this.opts.idempotencyRetentionMs ?? 30 * 24 * 60 * 60 * 1_000,
      (this.opts.now ?? (() => new Date()))().getTime(),
    );
    for (const id of removed) this.cancelled.delete(id);
  }

  private acceptCommand(
    params: unknown,
    idempotencyKey: string,
    clientId: string,
    idempotencyParams?: unknown,
    operation?: string,
  ) {
    const store = commandStoreForRequest(this.commands, params);
    const parsed = ControlRunStartRequest.safeParse(params);
    const acceptedParams =
      parsed.success && parsed.data.mode === "agent"
        ? { ...(params as Record<string, unknown>), review: resolveRunReviewRequested(parsed.data) }
        : params;
    return store.accept({
      id: newId("job"),
      params: acceptedParams,
      idempotencyKey,
      clientId,
      // Resolved defaults belong to accepted execution, never the wire digest.
      idempotencyParams: idempotencyParams ?? params,
      operation,
    });
  }

  private getRecord(id: string): JobRecord | undefined {
    return commandStoreForId(this.commands, id)?.get(id);
  }

  private updateRecord(record: JobRecord, patch: Partial<JobRecord>): JobRecord {
    const store = commandStoreForId(this.commands, record.id);
    if (!store) throw new Error(`command authority lost job ${record.id}`);
    const next = store.update(record.id, patch);
    if (isTerminalLifecycle(next.state) && !isTerminalLifecycle(record.state)) {
      this.opts.onCommandTerminal?.(next);
    }
    return next;
  }

  private threadIdOf(rec: JobRecord): string | undefined {
    const p = rec.params as { threadId?: unknown } | null | undefined;
    return p && typeof p.threadId === "string" ? p.threadId : undefined;
  }

  /**
   * Schedule queued jobs up to the concurrency limit (non-blocking), plus the
   * single Delegate-child overflow lane documented below.
   *
   * One active run per thread: a thread is a linear conversation and an in-place
   * turn mutates the live tree, so two concurrent turns on the same thread would
   * race the same files. We pick the first queued job whose thread is idle rather
   * than always taking the head; thread-less jobs (CLI/MCP) keep running in
   * parallel as before. drain() re-runs on every completion, so a thread's next
   * turn starts as soon as its previous one settles.
   */
  private drain(): void {
    if (this.stopping || servingModeOf(this.opts.servingMode) !== "normal") return;
    while (this.queue.length > 0) {
      // Existing child precedence and one overflow remain; a blocked ordinary
      // class never prevents the next eligible job of another class from running.
      const pickIdx = eligibleJobIndex(this.queue, this.activeJobs.values(), this.concurrency);
      if (pickIdx === -1) break;
      const job = this.queue.splice(pickIdx, 1)[0];
      const id = job.id,
        rec = this.getRecord(id);
      if (!rec) continue;
      if (this.cancelled.has(id)) {
        this.updateRecord(rec, { state: "cancelled", finishedAt: nowIso() });
        continue;
      }
      this.activeJobs.set(id, job);
      const task = this.runJob(id, rec);
      this.activeTasks.add(task);
      void task.then(
        () => this.activeTasks.delete(task),
        (error) => {
          this.activeTasks.delete(task);
          this.taskFailures.push(error);
        },
      );
    }
  }

  private async runJob(id: string, rec: JobRecord): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    rec = this.updateRecord(rec, { state: "running", startedAt: nowIso() });
    try {
      const result = await this.opts.runner(rec.params, {
        jobId: id,
        signal: controller.signal,
        onRunStart: (info) => {
          rec = this.updateRecord(rec, info);
        },
      });
      const state = jobStateFromResult(result, controller.signal.aborted);
      if (state === "failed" || state === "interrupted") {
        const reason = resultReason(result);
        rec = this.updateRecord(rec, {
          state,
          result,
          error: resultSummary(result) ?? `run ended ${state}${reason ? ` (${reason})` : ""}`,
          finishedAt: nowIso(),
        });
      } else {
        rec = this.updateRecord(rec, { state, result, finishedAt: nowIso() });
      }
    } catch (thrown) {
      rec = settleJobError({
        thrown,
        record: rec,
        aborted: controller.signal.aborted,
        commands: this.commands,
        update: (record, patch) => this.updateRecord(record, patch),
      });
    } finally {
      this.controllers.delete(id);
      this.activeJobs.delete(id);
      // An admitted child can fail before the orchestrator attaches its
      // task-scoped ledger (contract/preflight/artifact setup). Clear that
      // pending admission at the daemon-owned job boundary; after attachment
      // this is intentionally a no-op and the orchestrator releases by runId.
      const delegatedFrom = delegatedParentOf(rec.params);
      if (delegatedFrom) {
        this.opts.delegationAuthority?.cancelAcceptedChild(delegatedFrom, id);
      }
      if (rec.runId) {
        try {
          this.opts.onRunTerminal?.(rec.runId, this.threadIdOf(rec));
        } catch {
          /* observer failure must not corrupt terminal bookkeeping */
        }
      } else if (rec.error) {
        // Failure-shaped terminal with NO run ever bound: the refusal happened
        // before the run materialized. If this job carried a pre-created thread
        // turn, persist the reason on it (honest inline refusal, INV-093).
        const turnId = (rec.params as { turnId?: unknown } | null | undefined)?.turnId;
        if (typeof turnId === "string" && turnId) {
          try {
            this.opts.onTurnEnqueueFailed?.(
              turnId,
              TurnEnqueueProblem.parse({
                message: rec.error,
                code: rec.errorCode ?? null,
                retryable: rec.errorRetryable ?? true,
                required_actions: rec.errorRequiredActions ?? [],
                context: rec.errorContext ?? {},
              }),
            );
          } catch {
            /* observer failure must not corrupt terminal bookkeeping */
          }
        }
      }
      this.pruneHistory();
      if (!this.stopping) this.drain();
    }
  }
}

function storageOnlyFailure(error: unknown): boolean {
  if (error instanceof AggregateError)
    return error.errors.length > 0 && error.errors.every(storageOnlyFailure);
  return ["store_corrupt", "store_flush_unavailable"].includes(
    (error as { code?: string })?.code ?? "",
  );
}
