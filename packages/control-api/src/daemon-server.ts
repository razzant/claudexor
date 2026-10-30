import { handleThreadHistoryRoute, type ThreadHistoryServices } from "./thread-history-routes.js";
import { liveRunEventSeq } from "@claudexor/event-log";
import {
  readPatch,
  validRunOperatorDecision,
  applyTargetRoot,
  applyGateError,
  applyGateInputFor,
  gateSpecsForRun,
} from "./run-apply-projection.js";
import { BulkExecutor } from "./bulk-executor.js";
import { requestGone } from "./request-liveness.js";
import { setTimeout as sleep } from "node:timers/promises";
import { trackRequest } from "./request-timing.js";
import { serveRunDetail } from "./run-detail-route.js";
import { handleDeferredMessageRoute } from "./deferred-message-routes.js";
import { handleAccountResourceRoute, type ResourceRead } from "./account-resource-routes.js";
import { CONTROL_STORE_IDENTITY_HEADER, ControlAccountResetRequest } from "@claudexor/schema";
import { recordedExecutionRoot } from "./run-delivery-state.js";
import { readRawTextArtifact, safeReadStructuredArtifact } from "./run-artifact-read.js";
import { controlRunResult, readDeliveryState, markRunApplyState } from "./run-delivery-state.js";
import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";
import { revertInPlaceFromAnchor, validateApplyGate, verifyAndDeliver } from "@claudexor/delivery";
import { safeArtifactRoot } from "./artifact-paths.js";
import { TERMINAL_STATES } from "./sse-shared.js";
import { readFilesWorkProduct } from "./files-work-product.js";
import { appendRunAuditEvent } from "./run-audit.js";
import { discardRunResult } from "./run-discard.js";
import { applyFilesResult } from "./files-apply-route.js";
import { deliverableWorkspaceChanges } from "@claudexor/workspace";
import { streamRunEvents } from "./run-events-stream.js";
import {
  projectTurnRunCards,
  projectSession,
  projectThread,
  projectThreadList,
  projectTurn,
} from "./thread-projection.js";
import {
  handleThreadTurnCreate,
  handleThreadTurnRetry,
  type ThreadTurnRouteCtx,
} from "./thread-turn-routes.js";
import { chainIdleRunMutation, chainThreadMutation } from "./thread-mutation.js";
import { handleThreadCreate } from "./thread-create-route.js";
import {
  handleThreadLifecycleRoutes,
  type ThreadLifecycleRouteCtx,
} from "./thread-lifecycle-routes.js";
import * as runStart from "./run-start.js";
import { handleRunControlRoute } from "./run-control-routes.js";
import {
  delegatedDescendantsFromRecords,
  type ControlOperatorDecisionRecord,
  type DaemonFacadeClient,
  type DaemonRunRecord,
} from "./run-record.js";
import { handleRunRetryRoute } from "./run-retry-routes.js";
import { handleRunMessageRoute } from "./run-message-routes.js";
import { handleRunEventPartRoute } from "./run-event-part-routes.js";
import { handleRunTimeLimitRoute } from "./run-time-limit-routes.js";
import { handleRunWaitManyRoute } from "./run-wait-many-routes.js";
import { handleTaskGroupRunsRoute } from "./task-group-routes.js";
import type { TaskGroupRunsInput, TaskGroupRunsResult } from "@claudexor/schema";
import type { RunWaitManyHost } from "./run-wait-many.js";
import {
  handleRunApplyRoutes,
  runIdempotentDelivery,
  type DeliveryCommandServices,
  type RunApplyRouteContext,
} from "./run-apply-routes.js";
import { rerunWithFeedback } from "./decision-rerun.js";
import { acceptRiskDecision, type RiskDecisionBody } from "./decision-accept-risk.js";
import { handleProjectRoute, type ProjectRouteServices } from "./project-routes.js";
import { writeBinaryResponse } from "./binary-response.js";
import { handleRecoveryRoute } from "./recovery-routes.js";
import { handleJournalEventRoute, type JournalEventPageRequest } from "./journal-event-routes.js";
import { handleDaemonStatusRoute } from "./daemon-status-routes.js";
import { handleMaintenanceRoute, type MaintenanceRouteServices } from "./maintenance-routes.js";
import { handleResourceRoute, type ResourceRouteServices } from "./resource-routes.js";
import { handleModelRoute, type ModelRouteServices } from "./model-routes.js";
import {
  handleArtifactServeRoute,
  resolveProjectRoot,
  type ResolvedThreadWorkspace,
} from "./artifact-serve-routes.js";
import { runExecutionWorkspaceRoot } from "./run-execution-root.js";
import { bearerCredential } from "./authorization.js";
import { assertOnlyQueryParams, singleQuery } from "./query.js";
import {
  parseCredentialProfilesSnapshotQuery,
  parseHarnessListQuery,
  parseRunApplicabilityQuery,
} from "./catalog-query.js";
import { lruGet, lruSet, serveRunList } from "./run-list.js";
import { type RunListFingerprint } from "./run-list-fingerprint.js";
import {
  controlProblemError,
  normalizeRequestValidationError,
  revertRefusedProblem,
  thrownProblemCode,
} from "./problem-response.js";
import { handleSecurityRoute } from "./security-routes.js";
import {
  ControlAuthReadinessRefreshRequest,
  ControlAuthReadinessRefreshResponse,
  ControlProblem,
  ResourceAttachmentRef,
  ControlApplyRequest,
  AgentCapabilityCatalog,
  ControlHarnessListResponse,
  ControlHarnessModelsQueryResponse,
  ControlSetupJob,
  ControlSetupJobCreateRequest,
  ControlSetupJobInputRequest,
  ControlSetupJobEvent,
  ControlSetupJobSnapshot,
  isTerminalControlSetupJobState,
  ControlSetupJobListFilter,
  ControlSetupJobListResponse,
  ControlRunStartInfo,
  type ControlRunStartRequest,
  ControlRunSummary,
  ControlSettingsSnapshot,
  ControlSettingsUpdateRequest,
  ControlQuotaRefreshRequest,
  type ControlQuotaReadRequest,
  ControlAccountPoolsResponse,
  ControlAccountsMigrationRollbackRequest,
  ControlAccountsMigrationRollbackResponse,
  ControlCredentialProfileCreateRequest,
  ControlCredentialProfileCreateResponse,
  ControlCredentialProfileUpdateRequest,
  ControlCredentialProfileUpdateResponse,
  ControlCredentialProfileDeleteResponse,
  ControlTrustUpdateRequest,
  ControlInteractionAnswerRequest,
  ControlInteractionAnswerResponse,
  type ControlPendingInteraction,
  type LiveMessageDelivery,
  type LiveMessageInput,
  ControlRunDecisionRequest,
  ControlRunDecisionResponse,
  ControlRunApplicabilityResponse,
  ControlThreadTurnRequest,
  ControlThreadUpdateRequest,
  ControlThreadDetail,
  DecisionRecord,
  Id,
  needsDecision,
  needsOperatorAttention,
} from "@claudexor/schema";
import { resolveControlProtocol, type ControlServingMode } from "./control-protocol.js";
import { RefusedBodies, readControlRequestBody } from "./request-body.js";
import { withControlHttpTimeouts } from "./http-server-options.js";
import {
  errorCode,
  redactSecrets,
  safeProblemContext,
  safeProblemRequiredActions,
  sha256,
} from "@claudexor/util";
import { stringify as stringifyYaml } from "yaml";
import { readFailure } from "./run-card-facts.js";
import { runOutcomeFacts, winnerWorkStateFor } from "./run-projection.js";

export {
  type ControlOperatorDecisionRecord,
  type DaemonFacadeClient,
  type DaemonRunRecord,
} from "./run-record.js";
export { normalizeRunStartRequest } from "./run-start.js";
export { inlineContentDisposition } from "./binary-response.js";
export {
  resetRunListFingerprintProbeCountForTests,
  runListFingerprintProbeCountForTests,
} from "./run-list-fingerprint.js";

export interface DaemonControlApiOptions {
  token: string;
  daemon: DaemonFacadeClient;
  host?: string;
  port?: number;
  pollMs?: number;
  heartbeatMs?: number;
  runStartTimeoutMs?: number;
  /** Issue #165 D5 admission snapshot; absent embedders always serve normal. */
  servingMode?: () => ControlServingMode;
  /** Current durable store identity; unavailable before open or during replacement. */
  storeId?: () => string | undefined;
  /** Body-free, positional run observations from the current durable store. */
  runObservations?: RunWaitManyHost["snapshot"];
  /** Post-commit notices for those observations; without them waits poll. */
  runObservationChanges?: RunWaitManyHost["subscribe"];
  threadHistoryReads?: ThreadHistoryServices;
  taskGroupRuns?: (input: TaskGroupRunsInput, signal?: AbortSignal) => Promise<TaskGroupRunsResult>;
  bus?: { subscribe(listener: (event: { run_id: string }) => void): () => void };
  /** Internal storage fact; a committed terminal may still need its file effects. */
  terminalFilesPending?: (runIdOrCommandId: string) => boolean;
  services?: DeliveryCommandServices &
    Partial<ModelRouteServices> &
    Partial<ResourceRouteServices> &
    Partial<MaintenanceRouteServices> &
    Partial<ProjectRouteServices> & {
      harnesses?: (input?: {
        fresh?: boolean;
        includeFakes?: boolean;
        harnessIds?: string[];
      }) => Promise<unknown>;
      agentCapabilities?: () => Promise<unknown>;
      preflightRunRequirements?: (request: ControlRunStartRequest) => Promise<void>;
      preflightThreadRunRequirements?: (request: ControlRunStartRequest) => Promise<void>;
      harnessModels?: (input: {
        harnessId: string;
        route?: "local_session" | "api_key";
        view?: "accounts";
        credentialProfileId?: string;
      }) => Promise<unknown>;
      authReadiness?: (input: {
        harnessId: string;
        request: ControlAuthReadinessRefreshRequest;
      }) => Promise<unknown>;
      createSetupJob?: (input: {
        request: ControlSetupJobCreateRequest;
        idempotencyKey: string;
        clientId: string;
      }) => Promise<unknown>;
      listSetupJobs?: (input?: unknown) => Promise<unknown>;
      setupJobStatus?: (input: unknown) => Promise<unknown>;
      setupJobSnapshot?: (input: unknown) => Promise<unknown>;
      setupJobEvents?: (input: unknown) => Promise<unknown>;
      cancelSetupJob?: (input: unknown) => Promise<unknown>;
      setupJobInput?: (input: unknown) => Promise<unknown>;
      reconcileSetupJob?: (input: unknown) => Promise<unknown>;
      extendSetupJob?: (input: unknown) => Promise<unknown>;
      recoveryInspectPartition?: (partition: string) => Promise<unknown>;
      recoveryValidatePartition?: (partition: string) => Promise<unknown>;
      recoveryExportPartition?: (partition: string) => Promise<unknown>;
      recoveryQuarantinePartition?: (partition: string, input: unknown) => Promise<unknown>;
      journalEvents?: (partition: string, request: JournalEventPageRequest) => Promise<unknown>;
      settings?: () => Promise<unknown>;
      updateSettings?: (patch: unknown) => Promise<unknown>;
      quota?: (input?: ControlQuotaReadRequest) => Promise<unknown>;
      createAccountReset?: (input: {
        request: ControlAccountResetRequest;
        idempotencyKey: string;
        clientId: string;
      }) => Promise<unknown>;
      accountReset?: (id: string) => Promise<unknown>;
      refreshQuota?: (input?: ControlQuotaRefreshRequest & ResourceRead) => Promise<unknown>;
      accountPools?: () => Promise<unknown>;
      accountRoutingEvidence?: (includeCapabilities?: boolean) => Promise<unknown>;
      rollbackAccountsMigration?: (input: unknown) => Promise<unknown>;
      credentialProfiles?: (input?: { snapshot?: boolean } & ResourceRead) => Promise<unknown>;
      runApplicability?: (input: { repoRoot: string }) => Promise<unknown>;
      createCredentialProfile?: (input: unknown) => Promise<unknown>;
      updateCredentialProfile?: (input: unknown) => Promise<unknown>;
      deleteCredentialProfile?: (input: unknown) => Promise<unknown>;
      listSecrets?: () => Promise<unknown>;
      setSecret?: (input: unknown) => Promise<unknown>;
      deleteSecret?: (name: string) => Promise<unknown>;
      pendingInteractions?: (runId: string) => ControlPendingInteraction[];
      answerInteraction?: (
        runId: string,
        interactionId: string,
        answers: unknown,
      ) => { status: string; message?: string };
      /** Live message into a running attempt; typed verdict, never a throw for a non-delivery. */
      sendRunMessage?: (input: LiveMessageInput) => Promise<LiveMessageDelivery>;
      operatorDecision?: (runId: string, params: unknown) => ControlOperatorDecisionRecord | null;
      findOperatorDecisionByIdempotency?: (
        runId: string,
        params: unknown,
        idempotency: { key: string; client: string; request: unknown },
      ) => ControlOperatorDecisionRecord | null;
      recordOperatorDecision?: (
        runId: string,
        params: unknown,
        decision: ControlOperatorDecisionRecord,
        idempotency?: { key: string; client: string; request: unknown },
      ) => { record: ControlOperatorDecisionRecord; reused: boolean };
      createThread?: (input: unknown) => Promise<unknown>;
      findThreadCreation?: (input: unknown) => Promise<unknown>;
      listThreads?: () => Promise<{ threads: unknown[]; problems?: unknown[] }>;
      threadDetail?: (
        id: string,
      ) => Promise<{ thread: unknown; sessions: unknown[]; turns: unknown[] }>;
      createThreadTurn?: (
        id: string,
        prompt: string,
        opts: {
          kind?: unknown;
          parentRunId?: string | null;
          planRunId?: string | null;
          planHash?: string | null;
          planOverridden?: boolean;
          attachments?: ResourceAttachmentRef[];
          idempotency?: { key: string; client: string; request: unknown };
        },
      ) => Promise<unknown>;
      findThreadTurnByIdempotency?: (
        id: string,
        idempotency: { key: string; client: string; request: unknown },
      ) => Promise<{ id: string } | null>;
      updateThread?: (
        id: string,
        patch: {
          title?: string;
          folder?: string | null;
          state?: string;
          primaryHarness?: string | null;
          credentialProfileId?: string | null;
          eligibleHarnesses?: string[];
          access?: string | null;
        },
      ) => Promise<unknown>;
      trashThread?: (id: string) => Promise<unknown>;
      restoreThread?: (id: string) => Promise<unknown>;
      purgeThread?: (id: string) => Promise<unknown>;
      applyThread?: (
        id: string,
        opts: {
          mode: string;
          branch?: string;
          message?: string;
          gates?: NonNullable<Parameters<typeof verifyAndDeliver>[3]>;
        },
      ) => Promise<unknown>;
      setTurnEnqueueError?: (
        turnId: string,
        problem: import("@claudexor/schema").TurnEnqueueProblem,
      ) => void;
      listTrust?: (input?: { repoRoot?: string }) => Promise<unknown>;
      updateTrust?: (input: ControlTrustUpdateRequest) => Promise<unknown>;
    };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

interface ValidatedSetupEventBatch {
  events: ControlSetupJobEvent[];
}

function setupEventProtocolError(
  message: string,
): Error & { code: string; requiredActions: string[] } {
  return Object.assign(new Error(message), {
    code: "setup_event_protocol_error",
    requiredActions: ["resnapshot"],
  });
}

function invalidRunCursor(message: string): Error & { status: number; code: string } {
  return Object.assign(new Error(message), {
    status: 400,
    code: "invalid_run_event_cursor",
    requiredActions: ["resnapshot"],
  });
}

function finiteHttpStatus(error: unknown, fallback: number): number {
  if (!error || typeof error !== "object" || !("status" in error)) return fallback;
  const value = Number((error as { status: unknown }).status);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : fallback;
}

function stringArrayProperty(error: unknown, key: "requiredActions" | "evidenceRefs"): string[] {
  if (!error || typeof error !== "object" || !(key in error)) return [];
  const value = (error as Record<string, unknown>)[key];
  if (key === "requiredActions") return safeProblemRequiredActions(value);
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .map(redactSecrets)
    : [];
}

function fieldErrorsProperty(error: unknown): Record<string, string[]> {
  if (!error || typeof error !== "object" || !("fieldErrors" in error)) return {};
  const value = (error as { fieldErrors: unknown }).fieldErrors;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(value)) {
    if (!Array.isArray(messages)) continue;
    const safeMessages = messages
      .filter((item): item is string => typeof item === "string")
      .map(redactSecrets);
    if (safeMessages.length > 0) result[field] = safeMessages;
  }
  return result;
}

function problemBody(
  error: unknown,
  fallbackCode: string,
  fallbackRetryable: boolean,
  fallbackMessage?: string,
): ControlProblem {
  const retryable =
    error && typeof error === "object" && "retryable" in error
      ? (error as { retryable: unknown }).retryable === true
      : fallbackRetryable;
  const message = redactSecrets(
    error instanceof Error ? error.message : (fallbackMessage ?? String(error ?? "request failed")),
  );
  return ControlProblem.parse({
    code: errorCode(error) ?? fallbackCode,
    message,
    retryable,
    fieldErrors: fieldErrorsProperty(error),
    requiredActions: stringArrayProperty(error, "requiredActions"),
    evidenceRefs: stringArrayProperty(error, "evidenceRefs"),
    context:
      error && typeof error === "object" && "context" in error
        ? safeProblemContext((error as { context: unknown }).context)
        : {},
  });
}

/** Validate one whole service batch before exposing any of it on the wire. */
function validateSetupEventBatch(
  raw: unknown,
  input: {
    jobId: string;
    cursor: string | null;
    lastSequence: number;
  },
): ValidatedSetupEventBatch {
  if (!Array.isArray(raw))
    throw setupEventProtocolError("setupJobEvents returned a non-array projection");
  let cursor = input.cursor;
  let sequence = input.lastSequence;
  let terminalObserved = false;
  const events: ControlSetupJobEvent[] = [];
  for (const value of raw) {
    if (terminalObserved)
      throw setupEventProtocolError("setup event batch contains data after a terminal event");
    const parsed = ControlSetupJobEvent.safeParse(value);
    if (!parsed.success)
      throw setupEventProtocolError(
        `setup event failed schema validation: ${parsed.error.message}`,
      );
    const event = parsed.data;
    if (event.jobId !== input.jobId)
      throw setupEventProtocolError("setup event belongs to a different job");
    if (event.previousCursor !== cursor)
      throw setupEventProtocolError(
        "setup event predecessor does not match the acknowledged cursor",
      );
    if (event.cursor === cursor) throw setupEventProtocolError("setup event cursor is duplicated");
    if (event.sequence <= sequence)
      throw setupEventProtocolError("setup event sequence is duplicate or regressive");
    events.push(event);
    cursor = event.cursor;
    sequence = event.sequence;
    terminalObserved = isTerminalControlSetupJobState(event.state);
  }
  return { events };
}

function hostIsLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim();
  const host = h.startsWith("[") ? h.slice(1, h.indexOf("]")) : (h.split(":")[0] ?? "");
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function originIsLoopback(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    return LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}

export class DaemonControlApiServer {
  private readonly bulk = new BulkExecutor();
  private server?: Server;
  private startPromise: Promise<{ host: string; port: number }> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;
  /** Fires first in stop(): long reads end instead of holding the drain. */
  private readonly stopSignal = new AbortController();
  private readonly sseClients = new Set<ServerResponse>();
  private readonly refusedBodies = new RefusedBodies();
  /** Exact request-handler promises. Client disconnect never removes a handler. */
  private readonly activeHandlers = new Set<Promise<void>>();
  /** Per-thread turn submission chains (serialize head_run_id lineage updates). */
  private readonly threadTurnChains = new Map<string, Promise<void>>();

  constructor(private readonly opts: DaemonControlApiOptions) {}

  async start(): Promise<{ host: string; port: number }> {
    if (this.stopping) {
      throw Object.assign(new Error("control API is stopping and cannot be started"), {
        status: 503,
        code: "daemon_stopping",
      });
    }
    this.startPromise ??= this.startOnce();
    const address = await this.startPromise;
    if (this.stopping) {
      await this.stop();
      throw Object.assign(new Error("control API startup was cancelled by shutdown"), {
        status: 503,
        code: "daemon_stopping",
      });
    }
    return address;
  }

  private async startOnce(): Promise<{ host: string; port: number }> {
    const host = this.opts.host ?? "127.0.0.1";
    const port = this.opts.port ?? 0;
    await new Promise<void>((resolve, reject) => {
      this.server = withControlHttpTimeouts(createServer((req, res) => this.onRequest(req, res)));
      this.server.once("error", reject);
      this.server.listen(port, host, () => resolve());
    });
    const addr = this.server?.address();
    return { host, port: typeof addr === "object" && addr ? addr.port : port };
  }

  stop(): Promise<void> {
    this.stopping = true;
    this.stopSignal.abort();
    this.bulk.stop();
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    const listenerClosed = this.closeListener();
    this.closeSseClients();
    this.refusedBodies.close();
    await this.drainActiveHandlers();
    this.closeSseClients(); // Streams that registered while their handlers drained.
    await listenerClosed;
  }

  private closeSseClients(): void {
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {
        /* closed */
      }
    }
    this.sseClients.clear();
  }

  private async closeListener(): Promise<void> {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        return;
      }
    }
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      try {
        this.server.close(() => resolve());
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ERR_SERVER_NOT_RUNNING") resolve();
        else throw error;
      }
    });
  }

  private async drainActiveHandlers(): Promise<void> {
    while (this.activeHandlers.size > 0) {
      await Promise.allSettled([...this.activeHandlers]);
    }
  }

  private tokenMatches(provided: string | undefined): boolean {
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private authorized(req: IncomingMessage): boolean {
    if (
      !hostIsLoopback(req.headers.host) ||
      !originIsLoopback(req.headers.origin as string | undefined)
    )
      return false;
    return this.tokenMatches(bearerCredential(req.headers.authorization));
  }

  private requestError(res: ServerResponse, err: unknown, fallbackStatus: 400 | 500 = 400): void {
    // QA-053: normalize raw Zod issues only at the client-request boundary.
    const normalized = fallbackStatus === 400 ? normalizeRequestValidationError(err) : err;
    this.problem(
      res,
      finiteHttpStatus(normalized, fallbackStatus),
      normalized,
      fallbackStatus === 400 ? "invalid_request" : "internal_error",
      false,
      fallbackStatus === 400 ? "bad request" : "service failed",
    );
  }

  private json(
    res: ServerResponse,
    status: number,
    body: unknown,
    contentType = "application/json",
  ): void {
    if (res.destroyed) return;
    this.refusedBodies.discard(res);
    if (status >= 400 && contentType === "application/json") {
      const error = controlProblemError(status, body);
      return this.problem(res, status, error, error.code, false, error.message);
    }
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": contentType,
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  private problem(
    res: ServerResponse,
    status: number,
    error: unknown,
    fallbackCode: string,
    fallbackRetryable: boolean,
    fallbackMessage?: string,
  ): void {
    this.json(
      res,
      status,
      problemBody(error, fallbackCode, fallbackRetryable, fallbackMessage),
      "application/problem+json",
    );
  }

  private readBody = readControlRequestBody;

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    trackRequest(req, res);
    const tracked: Promise<void> = this.handle(req, res)
      .catch((err) => {
        if (requestGone(req, res)) return;
        try {
          if (!res.headersSent) {
            this.problem(
              res,
              finiteHttpStatus(err, 500),
              err,
              thrownProblemCode(err),
              false,
              "internal server error",
            );
          } else res.end();
        } catch {
          res.destroy();
        }
      })
      .finally(() => {
        this.activeHandlers.delete(tracked);
      });
    this.activeHandlers.add(tracked);
    void tracked;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (requestGone(req, res)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    const requestPath = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && requestPath === "/healthz") {
      if (!hostIsLoopback(req.headers.host)) return this.json(res, 403, { error: "forbidden" });
      return this.json(res, this.stopping ? 503 : 200, { ok: !this.stopping });
    }
    if (!this.authorized(req)) return this.json(res, 401, { error: "unauthorized" });
    if (this.stopping) {
      return this.problem(
        res,
        503,
        Object.assign(new Error("daemon is stopping; no new product request was admitted"), {
          status: 503,
          code: "daemon_stopping",
          retryable: true,
          requiredActions: ["reconnect"],
        }),
        "daemon_stopping",
        true,
      );
    }
    let protocol;
    try {
      protocol = await resolveControlProtocol({
        method,
        requestPath,
        requestedMajor: req.headers["x-claudexor-protocol-major"],
        readBody: () => this.readBody(req),
        servingMode: this.opts.servingMode?.() ?? "normal",
        storeId: this.opts.storeId,
        wantsStoreId: req.headers[CONTROL_STORE_IDENTITY_HEADER] === "1",
      });
    } catch (error) {
      return this.requestError(res, error);
    }
    if (protocol.kind === "response") {
      return this.json(res, protocol.status, protocol.body, protocol.contentType);
    }
    const path = protocol.path;
    const dataRoutes = {
      daemon: this.opts.daemon,
      services: this.opts.services,
      runObservations: this.opts.runObservations,
      runObservationChanges: this.opts.runObservationChanges,
      taskGroupRuns: this.opts.taskGroupRuns,
      threadHistoryReads: this.opts.threadHistoryReads,
      pollMs: this.opts.pollMs,
      stopping: this.stopSignal.signal,
      summarize: (record: DaemonRunRecord) => this.summarizeRunOrDiagnostic(record),
      bulk: this.bulk,
      readBody: (request: IncomingMessage, maxBytes?: number) => this.readBody(request, maxBytes),
      json: (response: ServerResponse, status: number, body: unknown) =>
        this.json(response, status, body),
      requestError: (response: ServerResponse, error: unknown, fallback?: 400 | 500) =>
        this.requestError(response, error, fallback),
    };
    for (const route of [
      handleDeferredMessageRoute,
      handleRunWaitManyRoute,
      handleTaskGroupRunsRoute,
      handleThreadHistoryRoute,
      handleResourceRoute,
      handleModelRoute,
      handleMaintenanceRoute,
      handleDaemonStatusRoute,
    ]) {
      if (await route(dataRoutes, method, path, req, res)) return;
    }
    if (
      await handleProjectRoute(
        {
          services: this.opts.services,
          readBody: (request) => this.readBody(request),
          json: (response, status, body) => this.json(response, status, body),
          requestError: (response, error, fallback) => this.requestError(response, error, fallback),
          binary: writeBinaryResponse,
          findRun: (id) => this.findRun(id),
        },
        method,
        path,
        req,
        res,
      )
    )
      return;

    if (method === "POST" && path === "/runs") {
      return runStart.handleRunCreate(
        {
          daemon: this.opts.daemon,
          readBody: (request) => this.readBody(request),
          requestError: (response, error, fallback) => this.requestError(response, error, fallback),
          json: (response, status, body) => this.json(response, status, body),
          respondToAcceptedJob: (response, jobId) => this.respondToAcceptedJob(response, jobId),
          storeId: this.opts.storeId,
          validateResources: this.opts.services?.validateResources,
          preflightRunRequirements: this.opts.services?.preflightRunRequirements,
        },
        req,
        res,
      );
    }

    if (method === "GET" && path === "/runs") {
      return serveRunList(
        {
          daemon: this.opts.daemon,
          summarize: (record) => this.summarizeRunOrDiagnostic(record),
          requestError: (response, error) => this.requestError(response, error),
          json: (response, status, body) => this.json(response, status, body),
        },
        url,
        req,
        res,
      );
    }

    if (
      await handleRunRetryRoute(
        {
          daemon: this.opts.daemon,
          services: this.opts.services,
          findRun: (id) => this.findRun(id),
          waitForRunStart: (id) => this.waitForRunStart(id),
          storeId: this.opts.storeId,
          serializeThreadMutation: (threadId, work) =>
            chainThreadMutation(this.threadTurnChains, threadId, work),
          json: (response, status, body) => this.json(response, status, body),
          requestError: (response, error, fallbackStatus) =>
            this.requestError(response, error, fallbackStatus),
        },
        method,
        path,
        req,
        res,
      )
    )
      return;

    if (
      await handleRunMessageRoute(
        {
          services: this.opts.services,
          findRun: (id) => this.findRun(id),
          readBody: (request) => this.readBody(request),
          json: (response, status, body) => this.json(response, status, body),
          requestError: (response, error) => this.requestError(response, error),
        },
        method,
        path,
        req,
        res,
      )
    )
      return;

    if (
      await handleRunTimeLimitRoute(
        {
          daemon: this.opts.daemon,
          findRun: (id) => this.findRun(id),
          readBody: (request) => this.readBody(request),
          json: (response, status, body) => this.json(response, status, body),
          requestError: (response, error) => this.requestError(response, error),
        },
        method,
        path,
        req,
        res,
      )
    )
      return;

    const runDetailMatch = /^\/runs\/([^/]+)$/.exec(path);
    if (method === "GET" && runDetailMatch) {
      return serveRunDetail(
        {
          findRun: (id) => this.findRun(id),
          deferred: this.opts.daemon.deferredMessageProjection?.bind(this.opts.daemon),
          children: (id) => this.opts.daemon.list({ delegatedFromRunId: id }),
          cursor: async (rec, signal) => {
            if (!rec.runDir) return 0;
            const path = join(rec.runDir, "events.jsonl");
            // The live owner is authoritative and this lookup does no I/O.
            // Retained/legacy fallback scanning belongs to the worker.
            return (
              liveRunEventSeq(path) ??
              this.bulk.execute({ kind: "cursor", input: { path } }, signal)
            );
          },
          project: (rec, cursor, children, deferred, signal) =>
            this.bulk.execute(
              {
                kind: "detail",
                input: {
                  record: rec,
                  cursor,
                  pending: this.pendingInteractionsFor(rec),
                  operator: this.operatorDecisionFor(rec),
                  children: children.map((record) => ({
                    record,
                    pending: this.pendingInteractionsFor(record).length > 0,
                  })),
                  deferred,
                },
              },
              signal,
            ),
          serialized: (response, body) => {
            response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            response.end(body);
          },
          json: (response, status, body) => this.json(response, status, body),
        },
        decodeURIComponent(runDetailMatch[1] as string),
        req,
        res,
      );
    }

    const interactionAnswerMatch = /^\/runs\/([^/]+)\/interactions\/([^/]+)\/answer$/.exec(path);
    if (method === "POST" && interactionAnswerMatch) {
      const rec = await this.findRun(decodeURIComponent(interactionAnswerMatch[1] as string));
      if (!rec) return this.json(res, 404, { error: "no such run" });
      const answerService = this.opts.services?.answerInteraction;
      if (!answerService)
        return this.json(res, 501, {
          error: "interaction answers are not supported by this engine build",
        });
      let body: ControlInteractionAnswerRequest;
      try {
        const raw = await this.readBody(req);
        body = ControlInteractionAnswerRequest.parse(raw);
      } catch (err) {
        return this.requestError(res, err);
      }
      const interactionId = decodeURIComponent(interactionAnswerMatch[2] as string);
      const answerSet = {
        interaction_id: interactionId,
        answers: body.answers.map((a) => ({
          question_id: a.questionId,
          selected_labels: a.selectedLabels,
          free_text: a.freeText,
        })),
      };
      const result = answerService(rec.runId ?? rec.id, interactionId, answerSet);
      const accepted = result.status === "delivered";
      return this.json(
        res,
        accepted ? 200 : result.status === "not_found" ? 404 : 409,
        ControlInteractionAnswerResponse.parse({
          accepted,
          status: result.status,
          message: result.message,
        }),
      );
    }

    if (
      await handleJournalEventRoute(
        {
          services: this.opts.services,
          pollMs: this.opts.pollMs,
          heartbeatMs: this.opts.heartbeatMs,
          sseClients: this.sseClients,
          json: (response, status, body) => this.json(response, status, body),
          requestError: (response, error) => this.requestError(response, error),
        },
        method,
        path,
        req,
        res,
      )
    )
      return;

    if (method === "POST" && path === "/threads") {
      return handleThreadCreate(
        {
          services: this.opts.services,
          readBody: (request) => this.readBody(request),
          json: (response, status, body) => this.json(response, status, body),
          requestError: (response, error) => this.requestError(response, error),
        },
        req,
        res,
      );
    }

    if (method === "GET" && path === "/threads") {
      const svc = this.opts.services?.listThreads;
      if (!svc)
        return this.json(res, 501, { error: "threads are not supported by this engine build" });
      return this.json(
        res,
        200,
        await projectThreadList(
          this.opts.daemon,
          await svc(),
          (r) => this.runNeedsAttention(r),
          () => !requestGone(req, res),
        ),
      );
    }

    const threadDetailMatch = /^\/threads\/([^/]+)$/.exec(path);
    if (method === "GET" && threadDetailMatch) {
      const svc = this.opts.services?.threadDetail;
      if (!svc)
        return this.json(res, 501, { error: "threads are not supported by this engine build" });
      try {
        const detail = await svc(decodeURIComponent(threadDetailMatch[1] as string));
        const runs = await this.opts.daemon.list({
          threadId: decodeURIComponent(threadDetailMatch[1] as string),
        });
        if (requestGone(req, res)) return;
        const byRun = new Map(runs.map((r) => [r.runId ?? r.id, r]));
        const thread = detail.thread as { head_run_id?: string | null };
        const cards = await projectTurnRunCards(
          detail.turns as { run_id?: string | null }[],
          runs,
          (record) => this.summarizeRunOrDiagnostic(record),
          () => !requestGone(req, res),
        );
        if (requestGone(req, res)) return;
        const headRec = byRun.get(thread.head_run_id ?? "");
        const headNeedsHuman = headRec ? this.runNeedsAttention(headRec) : false;
        return this.json(
          res,
          200,
          ControlThreadDetail.parse({
            thread: projectThread(detail.thread, headNeedsHuman),
            sessions: detail.sessions.map(projectSession),
            turns: detail.turns.map((t) => projectTurn(t, cards)),
          }),
        );
      } catch (err) {
        return this.requestError(res, err);
      }
    }

    if (method === "PATCH" && threadDetailMatch) {
      const svc = this.opts.services?.updateThread;
      if (!svc)
        return this.json(res, 501, { error: "threads are not supported by this engine build" });
      try {
        const raw = await this.readBody(req);
        const patch = ControlThreadUpdateRequest.parse(raw);
        const thread = await svc(decodeURIComponent(threadDetailMatch[1] as string), {
          title: patch.title,
          folder: patch.folder,
          state: patch.state,
          primaryHarness: patch.primaryHarness,
          credentialProfileId: patch.credentialProfileId,
          eligibleHarnesses: patch.eligibleHarnesses,
          access: patch.access,
        });
        return this.json(res, 200, projectThread(thread, false));
      } catch (err) {
        return this.requestError(res, err);
      }
    }

    if (await handleThreadLifecycleRoutes(this.threadLifecycleRouteCtx(), method, path, req, res))
      return;

    const threadTurnMatch = /^\/threads\/([^/]+)\/turns$/.exec(path);
    if (method === "POST" && threadTurnMatch) {
      if (!this.opts.services?.threadDetail || !this.opts.services?.createThreadTurn) {
        return this.json(res, 501, { error: "threads are not supported by this engine build" });
      }
      const threadId = decodeURIComponent(threadTurnMatch[1] as string);
      let body: ControlThreadTurnRequest;
      let idempotencyKey: string;
      try {
        idempotencyKey = runStart.requiredIdempotencyKey(req);
        body = ControlThreadTurnRequest.parse((await this.readBody(req)) ?? {});
      } catch (err) {
        return this.requestError(res, err);
      }
      return handleThreadTurnCreate(this.threadTurnRouteCtx(), res, threadId, body, idempotencyKey);
    }

    const turnRetryMatch = /^\/threads\/([^/]+)\/turns\/([^/]+)\/retry$/.exec(path);
    if (method === "POST" && turnRetryMatch) {
      if (!this.opts.services?.threadDetail)
        return this.json(res, 501, { error: "threads are not supported by this engine build" });
      try {
        return handleThreadTurnRetry(
          this.threadTurnRouteCtx(),
          res,
          decodeURIComponent(turnRetryMatch[1] as string),
          decodeURIComponent(turnRetryMatch[2] as string),
          runStart.requiredIdempotencyKey(req),
        );
      } catch (error) {
        return this.requestError(res, error);
      }
    }

    if (
      await handleArtifactServeRoute(
        {
          findRun: (id) => this.findRun(id),
          resolveProjectRoot: (id) => resolveProjectRoot(this.opts.services?.listProjects, id),
          resolveThreadWorkspace: (id) => this.resolveThreadWorkspace(id),
          readArtifact: (input, signal) => this.bulk.execute({ kind: "artifact", input }, signal),
          json: (response, status, body) => this.json(response, status, body),
        },
        method,
        path,
        res,
      )
    )
      return;

    if (await handleRunApplyRoutes(this.runApplyRouteCtx(), method, path, req, res)) return;

    const decisionMatch = /^\/runs\/([^/]+)\/decision$/.exec(path);
    if (method === "POST" && decisionMatch) {
      const rec = await this.findRun(decodeURIComponent(decisionMatch[1] as string));
      if (!rec?.runDir) return this.json(res, 404, { error: "no such run" });
      let body: ControlRunDecisionRequest;
      let decisionKey: string;
      try {
        decisionKey = runStart.requiredIdempotencyKey(req);
        const raw = await this.readBody(req);
        body = ControlRunDecisionRequest.parse(raw);
      } catch (err) {
        return this.requestError(res, err);
      }

      if (body.action === "accept_risk" || body.action === "override_needs_human") {
        try {
          return await acceptRiskDecision(
            {
              services: this.opts.services,
              chainMutation: (record, work) => this.chainRunMutation(record, work),
              workStateVeto: (record) => this.runWorkStateVeto(record),
              needsDecision: (record) => this.runNeedsDecision(record),
              readPatch: (record) => readFilesWorkProduct(record)?.text ?? readPatch(record),
              writeProjection: writeOperatorDecisionProjection,
              appendAudit: (record, payload) =>
                appendRunAuditEvent(record, "control.applied", payload),
              json: (response, status, responseBody) => this.json(response, status, responseBody),
            },
            rec,
            body as RiskDecisionBody,
            decisionKey,
            res,
          );
        } catch (error) {
          return this.requestError(res, error);
        }
      }

      if (body.action === "revert_run") {
        try {
          const response = await this.chainRunMutation(rec, () =>
            runIdempotentDelivery(this.opts.services, {
              params: rec.params,
              key: decisionKey,
              operation: "run.decision.revert",
              request: { runId: rec.runId ?? rec.id, body },
              work: async () => {
                // Server-owned revert of an in-place turn's live mutation. Restores the
                // tree to the recorded pre-turn snapshot, refusing if the user edited since.
                const result = controlRunResult(rec);
                if (!result.revertable || !result.revertAnchorId) {
                  throw Object.assign(
                    new Error("this run produced no revertable in-place change"),
                    { status: 409 },
                  );
                }
                // A delegated run's live tree is its recorded caller-owned
                // address; it never falls back to the stable project identity.
                const repoRoot =
                  recordedExecutionRoot(rec) ??
                  runExecutionWorkspaceRoot(rec) ??
                  applyTargetRoot({ kind: "original_project" }, rec);
                if (!repoRoot) {
                  throw Object.assign(
                    new Error("cannot resolve the in-place project root to revert"),
                    { status: 400 },
                  );
                }
                const absoluteRepoError = runStart.validateAbsoluteRepoRoot(repoRoot);
                if (absoluteRepoError) {
                  throw Object.assign(new Error(absoluteRepoError), { status: 400 });
                }
                const revert = await revertInPlaceFromAnchor(repoRoot, result.revertAnchorId);
                if (!revert.reverted) {
                  // QA-051: emit a FULL ControlProblem. The raw workspace reason
                  // concatenates a stable English explanation with locale-
                  // dependent Git stderr; that vendor diagnostic must not BE the
                  // semantic message. Present a stable English message + typed
                  // reason code, and keep the redacted, bounded stderr as
                  // context evidence the client can inspect deliberately.
                  const problem = revertRefusedProblem(revert.reason, revert.reasonCode);
                  appendRunAuditEvent(rec, "control.rejected", {
                    decision: "revert_run",
                    reason: problem.context.reason,
                    detail: problem.context.detail,
                  });
                  throw Object.assign(new Error(problem.message), {
                    status: 409,
                    code: "revert_refused",
                    retryable: false,
                    context: problem.context,
                  });
                }
                markRunApplyState(rec, "reverted");
                appendRunAuditEvent(rec, "control.applied", {
                  decision: "revert_run",
                  removed: revert.removed,
                });
                return ControlRunDecisionResponse.parse({
                  accepted: true,
                  status: "applied",
                  message: `reverted to the pre-turn state${revert.removed.length ? ` (removed ${revert.removed.length} turn-added file(s))` : ""}`,
                });
              },
            }),
          );
          return this.json(res, 200, response);
        } catch (error) {
          return this.requestError(res, error);
        }
      }

      if (body.action === "discard") {
        try {
          const response = await this.chainRunMutation(rec, () =>
            runIdempotentDelivery(this.opts.services, {
              params: rec.params,
              key: decisionKey,
              operation: "run.decision.discard",
              request: { runId: rec.runId ?? rec.id, body },
              work: () => discardRunResult(rec),
            }),
          );
          return this.json(res, 200, response);
        } catch (error) {
          return this.requestError(res, error);
        }
      }

      if (body.action === "accept_clean_patch") {
        if (readFilesWorkProduct(rec)) {
          try {
            const target = body.target ?? { kind: "original_project" as const };
            const root = applyTargetRoot(target, rec);
            if (!root) throw Object.assign(new Error("project root is required"), { status: 400 });
            const delivered = await applyFilesResult(
              this.runApplyRouteCtx(),
              rec,
              ControlApplyRequest.parse({ mode: body.applyMode ?? "apply", target }),
              decisionKey,
              root,
            );
            return this.json(
              res,
              200,
              ControlRunDecisionResponse.parse({
                accepted: delivered.applied,
                status: delivered.applied ? "applied" : "rejected",
                message: delivered.detail,
              }),
            );
          } catch (error) {
            return this.requestError(res, error);
          }
        }
        try {
          const patch = readPatch(rec); // typed 409 when the exact bytes are unavailable
          if (patch === null)
            return this.json(res, 404, { error: "no patch artifact for this run" });
          const repoRoot = applyTargetRoot(body.target ?? { kind: "original_project" }, rec);
          if (!repoRoot)
            return this.json(res, 400, { error: "project root is required for apply" });
          const absoluteRepoError = runStart.validateAbsoluteRepoRoot(repoRoot);
          if (absoluteRepoError) return this.json(res, 400, { error: absoluteRepoError });
          const response = await this.chainRunMutation(rec, () =>
            runIdempotentDelivery(this.opts.services, {
              params: rec.params,
              key: decisionKey,
              operation: "run.decision.accept_clean_patch",
              request: {
                runId: rec.runId ?? rec.id,
                body,
                patchSha256: sha256(patch),
                repoRoot,
              },
              work: async () => {
                const delivered = await verifyAndDeliver(
                  repoRoot,
                  patch,
                  { mode: body.applyMode ?? "apply" },
                  gateSpecsForRun(rec),
                  (freshVerify) =>
                    applyGateError(
                      rec,
                      patch,
                      repoRoot,
                      this.operatorDecisionFor(rec),
                      freshVerify,
                    ),
                );
                if (delivered.refused) {
                  throw Object.assign(new Error(delivered.detail ?? "delivery refused"), {
                    status: 409,
                    code: delivered.publicationRefusal?.code ?? "delivery_refused",
                  });
                }
                if (delivered.applied) markRunApplyState(rec, "applied");
                appendRunAuditEvent(rec, "control.applied", {
                  decision: body.action,
                  mode: body.applyMode ?? "apply",
                  applied: delivered.applied,
                });
                return ControlRunDecisionResponse.parse({
                  accepted: delivered.applied,
                  status: delivered.applied ? "applied" : "rejected",
                  message: delivered.detail ?? undefined,
                });
              },
            }),
          );
          return this.json(res, 200, response);
        } catch (error) {
          return this.requestError(res, error);
        }
      }

      try {
        return await rerunWithFeedback(
          {
            daemon: this.opts.daemon,
            services: this.opts.services,
            serializeThreadMutation: (threadId, work) =>
              chainThreadMutation(this.threadTurnChains, threadId, work),
            waitForRunStart: (id) => this.waitForRunStart(id),
            storeId: this.opts.storeId,
            appendAudit: (record, payload) =>
              appendRunAuditEvent(record, "control.applied", payload),
            json: (response, status, responseBody) => this.json(response, status, responseBody),
          },
          rec,
          body,
          decisionKey,
          res,
        );
      } catch (error) {
        return this.requestError(res, error, 500);
      }
    }

    if (method === "GET" && path === "/harnesses") {
      try {
        return this.service(
          res,
          "harnesses",
          parseHarnessListQuery(url),
          ControlHarnessListResponse,
        );
      } catch (err) {
        return this.requestError(res, err);
      }
    }
    if (method === "GET" && path === "/agent-capabilities")
      return this.service(res, "agentCapabilities", undefined, AgentCapabilityCatalog);
    if (method === "GET" && path === "/run-applicability") {
      try {
        return this.service(
          res,
          "runApplicability",
          parseRunApplicabilityQuery(url),
          ControlRunApplicabilityResponse,
        );
      } catch (error) {
        return this.requestError(res, error);
      }
    }
    const harnessModelsMatch = /^\/harnesses\/([^/]+)\/models$/.exec(path);
    if (method === "GET" && harnessModelsMatch) {
      try {
        assertOnlyQueryParams(url, ["route", "view", "credentialProfileId"]);
        const view = singleQuery(url, "view");
        if (view !== undefined && view !== "accounts") throw new Error("view must be accounts");
        const profile = singleQuery(url, "credentialProfileId");
        if (profile !== undefined && view !== "accounts")
          throw new Error("credentialProfileId requires view=accounts");
        const routeParam = url.searchParams.get("route");
        if (routeParam !== null && routeParam !== "local_session" && routeParam !== "api_key") {
          throw new Error("route must be exactly local_session or api_key");
        }
        return this.service(
          res,
          "harnessModels",
          {
            harnessId: decodeURIComponent(harnessModelsMatch[1] as string),
            ...(routeParam ? { route: routeParam } : {}),
            ...(view ? { view } : {}),
            ...(profile !== undefined ? { credentialProfileId: Id.parse(profile) } : {}),
          },
          ControlHarnessModelsQueryResponse,
        );
      } catch (error) {
        return this.requestError(res, error);
      }
    }
    const authReadinessMatch = /^\/harnesses\/([^/]+)\/auth-readiness$/.exec(path);
    if (method === "POST" && authReadinessMatch) {
      try {
        assertOnlyQueryParams(url, []);
        const raw = await this.readBody(req);
        const request = ControlAuthReadinessRefreshRequest.parse(raw);
        return this.service(
          res,
          "authReadiness",
          { harnessId: decodeURIComponent(authReadinessMatch[1] as string), request },
          ControlAuthReadinessRefreshResponse,
        );
      } catch (error) {
        return this.requestError(res, error);
      }
    }
    if (method === "GET" && path === "/setup/jobs") {
      try {
        assertOnlyQueryParams(url, ["harness", "action", "active", "limit"]);
        for (const key of ["harness", "action", "active", "limit"]) {
          if (url.searchParams.getAll(key).length > 1)
            throw new Error(`${key} may be specified only once`);
        }
        const active = url.searchParams.get("active");
        if (active !== null && active !== "true" && active !== "false")
          throw new Error("active must be exactly true or false");
        const limit = url.searchParams.get("limit");
        if (limit !== null && !/^[1-9][0-9]*$/.test(limit))
          throw new Error("limit must be a positive integer");
        const filter = ControlSetupJobListFilter.parse({
          ...(url.searchParams.has("harness") ? { harness: url.searchParams.get("harness") } : {}),
          ...(url.searchParams.has("action") ? { action: url.searchParams.get("action") } : {}),
          ...(active !== null ? { active: active === "true" } : {}),
          ...(limit !== null ? { limit: Number(limit) } : {}),
        });
        return this.service(res, "listSetupJobs", filter, ControlSetupJobListResponse);
      } catch (err) {
        return this.requestError(res, err);
      }
    }
    if (method === "POST" && path === "/setup/jobs") {
      try {
        const idempotencyKey = runStart.requiredIdempotencyKey(req);
        const raw = await this.readBody(req);
        const body = ControlSetupJobCreateRequest.parse(raw);
        return this.service(
          res,
          "createSetupJob",
          { request: body, idempotencyKey, clientId: "control-api" },
          ControlSetupJob,
        );
      } catch (err) {
        return this.requestError(res, err);
      }
    }
    const setupJobMatch = /^\/setup\/jobs\/([^/]+)$/.exec(path);
    if (method === "GET" && setupJobMatch) {
      return this.service(
        res,
        "setupJobStatus",
        { jobId: decodeURIComponent(setupJobMatch[1] as string) },
        ControlSetupJob,
      );
    }
    const setupJobSnapshotMatch = /^\/setup\/jobs\/([^/]+)\/snapshot$/.exec(path);
    if (method === "GET" && setupJobSnapshotMatch) {
      return this.service(
        res,
        "setupJobSnapshot",
        { jobId: decodeURIComponent(setupJobSnapshotMatch[1] as string) },
        ControlSetupJobSnapshot,
      );
    }
    const setupJobCancelMatch = /^\/setup\/jobs\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && setupJobCancelMatch) {
      return this.service(
        res,
        "cancelSetupJob",
        { jobId: decodeURIComponent(setupJobCancelMatch[1] as string) },
        ControlSetupJob,
      );
    }
    const setupJobInputMatch = /^\/setup\/jobs\/([^/]+)\/input$/.exec(path);
    if (method === "POST" && setupJobInputMatch) {
      try {
        const raw = await this.readBody(req);
        // The one-time sign-in value IS the payload here — it rides the
        // transient sidecar to the vendor CLI and is never journaled; the
        // inline-secret fence does not apply to this single sanctioned field.
        const body = ControlSetupJobInputRequest.parse(raw);
        return this.service(
          res,
          "setupJobInput",
          { jobId: decodeURIComponent(setupJobInputMatch[1] as string), value: body.value },
          ControlSetupJob,
        );
      } catch (err) {
        return this.requestError(res, err);
      }
    }
    const setupJobReconcileMatch = /^\/setup\/jobs\/([^/]+)\/reconcile$/.exec(path);
    if (method === "POST" && setupJobReconcileMatch) {
      return this.service(
        res,
        "reconcileSetupJob",
        { jobId: decodeURIComponent(setupJobReconcileMatch[1] as string) },
        ControlSetupJob,
      );
    }
    const setupJobExtendMatch = /^\/setup\/jobs\/([^/]+)\/extend$/.exec(path);
    if (method === "POST" && setupJobExtendMatch) {
      // QA-075/Ф2: Idempotency-Key is OPTIONAL (installed macOS Extend sends
      // none): present → replay-safe, absent → non-idempotent, malformed → 400.
      let idempotencyKey: string | undefined;
      try {
        idempotencyKey = runStart.optionalIdempotencyKey(req);
      } catch (err) {
        return this.requestError(res, err);
      }
      const jobId = decodeURIComponent(setupJobExtendMatch[1] as string);
      return this.service(
        res,
        "extendSetupJob",
        { jobId, ...(idempotencyKey !== undefined ? { idempotencyKey } : {}) },
        ControlSetupJob,
      );
    }
    const setupJobEventsMatch = /^\/setup\/jobs\/([^/]+)\/events$/.exec(path);
    if (method === "GET" && setupJobEventsMatch) {
      return this.streamSetupJobEvents(
        decodeURIComponent(setupJobEventsMatch[1] as string),
        req,
        res,
      );
    }
    if (
      await handleRecoveryRoute(
        {
          services: this.opts.services,
          readBody: (request) => this.readBody(request),
          json: (response, status, body) => this.json(response, status, body),
          requestError: (response, error) => this.requestError(response, error),
        },
        method,
        path,
        req,
        res,
      )
    )
      return;
    if (
      await handleSecurityRoute(
        {
          services: this.opts.services,
          readBody: (request) => this.readBody(request),
          json: (response, status, body) => this.json(response, status, body),
          requestError: (response, error) => this.requestError(response, error),
        },
        method,
        path,
        url,
        req,
        res,
      )
    )
      return;
    if (method === "GET" && path === "/settings")
      return this.service(res, "settings", undefined, ControlSettingsSnapshot);
    if (method === "POST" && path === "/settings") {
      let body: ControlSettingsUpdateRequest;
      try {
        const raw = await this.readBody(req);
        body = ControlSettingsUpdateRequest.parse(raw);
      } catch (err) {
        return this.requestError(res, err);
      }
      return this.service(res, "updateSettings", body, ControlSettingsSnapshot);
    }
    if (
      await handleAccountResourceRoute(
        {
          services: this.opts.services,
          readBody: (request) => this.readBody(request),
          json: (response, status, body) => this.json(response, status, body),
          requestError: (response, error) => this.requestError(response, error),
        },
        method,
        path,
        url,
        req,
        res,
      )
    )
      return;
    // Unified account model: the pool-authority read (also the feature marker
    // clients detect through the operation catalog).
    if (method === "GET" && path === "/account-pools")
      return this.service(res, "accountPools", undefined, ControlAccountPoolsResponse);
    if (method === "GET" && path === "/credential-profiles") {
      try {
        const query = parseCredentialProfilesSnapshotQuery(url);
        return this.service(res, "credentialProfiles", query.input, query.schema);
      } catch (error) {
        return this.requestError(res, error);
      }
    }
    if (method === "POST" && path === "/credential-profiles") {
      let body: ControlCredentialProfileCreateRequest;
      try {
        const raw = await this.readBody(req);
        body = ControlCredentialProfileCreateRequest.parse(raw);
      } catch (err) {
        return this.requestError(res, err);
      }
      return this.service(
        res,
        "createCredentialProfile",
        body,
        ControlCredentialProfileCreateResponse,
      );
    }
    const profileMutateMatch = /^\/credential-profiles\/([^/]+)\/([^/]+)$/.exec(path);
    if (method === "PATCH" && profileMutateMatch) {
      let body: ControlCredentialProfileUpdateRequest;
      try {
        const raw = await this.readBody(req);
        body = ControlCredentialProfileUpdateRequest.parse(raw);
      } catch (err) {
        return this.requestError(res, err);
      }
      return this.service(
        res,
        "updateCredentialProfile",
        {
          harnessId: decodeURIComponent(profileMutateMatch[1] as string),
          profileId: decodeURIComponent(profileMutateMatch[2] as string),
          enabled: body.enabled,
        },
        ControlCredentialProfileUpdateResponse,
      );
    }
    if (method === "DELETE" && profileMutateMatch) {
      return this.service(
        res,
        "deleteCredentialProfile",
        {
          harnessId: decodeURIComponent(profileMutateMatch[1] as string),
          profileId: decodeURIComponent(profileMutateMatch[2] as string),
        },
        ControlCredentialProfileDeleteResponse,
      );
    }
    // Unified-accounts migration rollback (the supported downgrade path).
    if (method === "POST" && path === "/accounts-migration/rollback") {
      let body: ControlAccountsMigrationRollbackRequest;
      try {
        body = ControlAccountsMigrationRollbackRequest.parse(await this.readBody(req));
      } catch (err) {
        return this.requestError(res, err);
      }
      return this.service(
        res,
        "rollbackAccountsMigration",
        body,
        ControlAccountsMigrationRollbackResponse,
      );
    }
    // (legacy /auth alias removed: it duplicated GET /harnesses byte-for-byte)
    if (
      await handleRunControlRoute(
        {
          daemon: this.opts.daemon,
          pollMs: this.opts.pollMs,
          findRun: (id) => this.findRun(id),
          delegatedDescendants: (runId) => this.delegatedDescendants(runId),
          readBody: (request) => this.readBody(request),
          json: (response, status, body) => this.json(response, status, body),
          requestError: (response, error) => this.requestError(response, error),
        },
        method,
        path,
        req,
        res,
      )
    )
      return;

    const eventPartCtx = { findRun: (id: string) => this.findRun(id), json: this.json.bind(this) };
    if (await handleRunEventPartRoute(eventPartCtx, method, path, url, res)) return;

    const eventsMatch = /^\/runs\/([^/]+)\/events$/.exec(path);
    if (method === "GET" && eventsMatch) {
      const id = decodeURIComponent(eventsMatch[1] as string);
      let last: number;
      try {
        last = this.lastEventId(req, url);
      } catch (err) {
        // Validate the resume cursor BEFORE committing SSE headers so a
        // malformed cursor is a typed 400, not a silent full replay (QA-061).
        return this.requestError(res, err);
      }
      return this.streamEvents(id, last, req, res);
    }

    return this.json(res, 404, { error: "not found" });
  }

  private async service(
    res: ServerResponse,
    name: keyof NonNullable<DaemonControlApiOptions["services"]>,
    arg?: unknown,
    schema?: { parse(value: unknown): unknown },
  ): Promise<void> {
    const fn = this.opts.services?.[name] as ((arg?: unknown) => Promise<unknown>) | undefined;
    if (!fn) {
      return this.problem(
        res,
        501,
        new Error(`${name} service is not configured`),
        "service_not_configured",
        false,
      );
    }
    let value: unknown;
    try {
      value = await fn(arg);
    } catch (err) {
      return this.problem(
        res,
        finiteHttpStatus(err, 500),
        err,
        thrownProblemCode(err),
        false,
        "service failed",
      );
    }
    try {
      return this.json(res, 200, schema ? schema.parse(value) : value);
    } catch {
      return this.problem(
        res,
        500,
        new Error(`${String(name)} returned a response that violates its schema`),
        "invalid_service_response",
        false,
      );
    }
  }

  /** Replay and tail setup lifecycle from the durable global-journal cursor. */
  private async streamSetupJobEvents(
    jobId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const statusFn = this.opts.services?.setupJobStatus as
      ((arg?: unknown) => Promise<unknown>) | undefined;
    const eventsFn = this.opts.services?.setupJobEvents as
      ((arg?: unknown) => Promise<unknown>) | undefined;
    if (!statusFn || !eventsFn) {
      return this.problem(
        res,
        501,
        new Error("durable setup-job event services are not configured"),
        "service_not_configured",
        false,
      );
    }
    let job: ControlSetupJob;
    try {
      job = ControlSetupJob.parse(await statusFn({ jobId }));
    } catch (err) {
      const status = finiteHttpStatus(err, 404);
      return this.problem(
        res,
        status,
        err,
        status === 404 ? "setup_job_not_found" : "setup_event_stream_unavailable",
        false,
      );
    }
    let headerCursor: string | undefined;
    try {
      assertOnlyQueryParams(new URL(req.url ?? "/", "http://127.0.0.1"), []);
      const rawHeaderCursor = req.headers["last-event-id"];
      if (Array.isArray(rawHeaderCursor)) throw new Error("Last-Event-ID may appear only once");
      headerCursor = rawHeaderCursor;
      if (headerCursor !== undefined && headerCursor.length === 0)
        throw new Error("Last-Event-ID must not be empty");
    } catch (error) {
      return this.requestError(res, error);
    }
    let cursor = headerCursor ?? null;
    let lastSequence = 0;
    let initialBatch: ValidatedSetupEventBatch | null = null;
    // Validate a supplied cursor before committing SSE headers so stale epochs
    // receive a typed HTTP problem and the client can resnapshot deterministically.
    if (cursor) {
      try {
        initialBatch = validateSetupEventBatch(await eventsFn({ jobId, afterCursor: cursor }), {
          jobId,
          cursor,
          lastSequence,
        });
      } catch (err) {
        return this.problem(
          res,
          finiteHttpStatus(err, 500),
          err,
          "setup_event_projection_invalid",
          false,
        );
      }
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    this.sseClients.add(res);

    let closed = false;
    let terminalizing = false;
    let timer: NodeJS.Timeout | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      this.sseClients.delete(res);
    };
    const writeFrame = async (frame: string): Promise<void> => {
      if (closed || res.destroyed || res.writableEnded)
        throw new Error("setup event transport is closed");
      if (res.write(frame)) return;
      await new Promise<void>((resolveDrain, rejectDrain) => {
        const cleanupWaiters = () => {
          res.off("drain", onDrain);
          res.off("close", onClose);
          res.off("error", onError);
        };
        const onDrain = () => {
          cleanupWaiters();
          resolveDrain();
        };
        const onClose = () => {
          cleanupWaiters();
          rejectDrain(new Error("setup event client closed during backpressure"));
        };
        const onError = (error: Error) => {
          cleanupWaiters();
          rejectDrain(error);
        };
        res.once("drain", onDrain);
        res.once("close", onClose);
        res.once("error", onError);
      });
    };
    const finish = async () => {
      if (closed || terminalizing) return;
      terminalizing = true;
      try {
        await writeFrame("event: end\ndata: {}\n\n");
        res.end();
      } catch {
        res.destroy();
      } finally {
        cleanup();
      }
    };
    const failStream = async (error: unknown) => {
      if (closed || terminalizing) return;
      terminalizing = true;
      try {
        const body = problemBody(
          error,
          "setup_event_stream_failed",
          true,
          "setup event stream failed",
        );
        if (body.requiredActions.length === 0) body.requiredActions.push("resnapshot");
        await writeFrame(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
        res.end();
      } catch {
        res.destroy();
      } finally {
        cleanup();
      }
    };
    heartbeat = setInterval(() => {
      if (!closed && !terminalizing)
        void writeFrame(`: ping ${Date.now()}\n\n`).catch(() => {
          res.destroy();
          cleanup();
        });
    }, this.opts.heartbeatMs ?? 15_000);
    heartbeat.unref?.();

    const tick = async () => {
      if (closed || terminalizing) return;
      try {
        const batch =
          initialBatch ??
          validateSetupEventBatch(await eventsFn({ jobId, afterCursor: cursor }), {
            jobId,
            cursor,
            lastSequence,
          });
        initialBatch = null;
        for (const event of batch.events) {
          await writeFrame(`id: ${event.cursor}\nevent: setup\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = event.cursor;
          lastSequence = event.sequence;
          job = event.job;
        }
        if (isTerminalControlSetupJobState(job.state)) await finish();
      } catch (err) {
        await failStream(err);
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    try {
      await writeFrame(": connected\n\n");
    } catch {
      res.destroy();
      cleanup();
      return;
    }
    await tick();
    if (!closed) {
      const schedule = () => {
        if (closed) return;
        timer = setTimeout(() => {
          void tick().finally(schedule);
        }, this.opts.pollMs ?? 250);
        timer.unref?.();
      };
      schedule();
    }
  }

  private async waitForRunStart(jobId: string): Promise<DaemonRunRecord> {
    const pollMs = this.opts.pollMs ?? 50;
    const deadline = Date.now() + (this.opts.runStartTimeoutMs ?? 30_000);
    let last: DaemonRunRecord | null = null;
    for (;;) {
      const rec = await this.opts.daemon.status(jobId);
      last = rec;
      if (rec.runId && rec.runDir) return rec;
      if (TERMINAL_STATES.has(rec.state)) return rec;
      if (Date.now() > deadline || this.stopSignal.signal.aborted) return last; // Answer the receipt.
      await sleep(pollMs, undefined, { signal: this.stopSignal.signal }).catch(() => {});
    }
  }

  private async respondToAcceptedJob(res: ServerResponse, jobId: string): Promise<void> {
    const rec = await this.waitForRunStart(jobId);
    const metadata = runStart.acceptedTaskGroupReceipt(rec, this.opts.storeId);
    if (rec.runId && rec.runDir) {
      return this.json(
        res,
        200,
        ControlRunStartInfo.parse({
          ...metadata,
          jobId: rec.id,
          runId: rec.runId,
          taskId: rec.taskId,
          runDir: rec.runDir,
        }),
      );
    }
    const { status, body } = runStart.unboundRunStartResponse(
      rec,
      TERMINAL_STATES.has(rec.state),
      {},
      metadata,
    );
    return this.json(res, status, body);
  }

  /** One addressed run by job id or run id, or null when it is not retained.
   * The daemon selects that record before projecting it, so a status poll costs
   * a reference scan instead of every retained run's redacted params. The exact
   * match stays here too: an engine older than the query answers with the full
   * list, and a transport failure THROWS rather than reading as absence. */
  private async findRun(id: string): Promise<DaemonRunRecord | null> {
    const runs = await this.opts.daemon.list({ id });
    return runs.find((r) => r.id === id || r.runId === id) ?? null;
  }

  /** Persisted Delegate-only descendant graph. `parentRunId` alone is broader
   * thread/retry lineage and deliberately does not participate. */
  private async delegatedDescendants(parentRunId: string): Promise<DaemonRunRecord[]> {
    return delegatedDescendantsFromRecords(
      parentRunId,
      await this.opts.daemon.list({ delegatedDescendantsOf: parentRunId }),
    );
  }

  /** Resolve a thread's workspace record (mode + isolated worktree path) from the
   * thread journal — the honest source for QA-038 isolated /produced resolution.
   * Trashed/purged threads are retained by getThread (purge nulls worktree_path),
   * so an isolated run's execution tree is diagnosable, never silently the live
   * project. Absent service or an unknown thread ⇒ null (non-thread fallback). */
  private async resolveThreadWorkspace(threadId: string): Promise<ResolvedThreadWorkspace | null> {
    const svc = this.opts.services?.threadDetail;
    // No thread service / no workspace record ⇒ null (in-place / one-shot: live
    // root is correct). A THROWN lookup is NOT swallowed to null: for a run bound
    // to a thread that fails OPEN to the live project (QA-038), so it propagates
    // and `resolveProducedRoot` fails CLOSED with a typed authority-unavailable.
    if (!svc) return null;
    const { thread } = await svc(threadId);
    const ws = (
      thread as {
        workspace?: { mode?: unknown; worktree_path?: unknown; workspace_root?: unknown };
      }
    )?.workspace;
    if (!ws) return null;
    const mode = ws.mode === "isolated" || ws.mode === "delegated" ? ws.mode : "in_place";
    const tree = mode === "delegated" ? ws.workspace_root : ws.worktree_path;
    return { mode, worktreePath: typeof tree === "string" && tree.trim() ? tree : null };
  }

  private operatorDecisionFor(rec: DaemonRunRecord): ControlOperatorDecisionRecord | null {
    return this.opts.services?.operatorDecision?.(rec.runId ?? rec.id, rec.params) ?? null;
  }

  private validOperatorDecisionFor(rec: DaemonRunRecord): ControlOperatorDecisionRecord | null {
    return validRunOperatorDecision(rec, this.operatorDecisionFor(rec));
  }

  /** The RISK-OVERRIDABLE needs-decision signal: a terminal run whose review is
   * blocked or checks failed, with no valid operator decision recorded. This is
   * the gate for accept_risk / override_needs_human — a D-16 work_state veto is
   * NOT included here (a risk override cannot supply missing input); see
   * `runWorkStateVeto`. */
  private runNeedsDecision(rec: DaemonRunRecord): boolean {
    const arb = safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord);
    const facts = runOutcomeFacts(rec, arb, readFailure(rec), winnerWorkStateFor(rec));
    if (!facts) return false;
    return needsDecision(facts, this.validOperatorDecisionFor(rec) !== null);
  }

  /** The needs-me / inbox signal (D8): EITHER a risk-overridable needs-decision
   * OR a non-overridable D-16 work_state needs-input veto. Inbox/head surfaces
   * fold both so a needs_input run still surfaces as needing the operator. */
  private runNeedsAttention(rec: DaemonRunRecord): boolean {
    if (rec.state !== "succeeded") return false;
    const arb = safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord);
    const facts = runOutcomeFacts(rec, arb, readFailure(rec), winnerWorkStateFor(rec));
    if (!facts) return false;
    return needsOperatorAttention(facts, this.validOperatorDecisionFor(rec) !== null);
  }

  /** D-16: the non-overridable work_state veto on a succeeded run — the model
   * attested it needs input / is incomplete. A risk override cannot resolve it,
   * so the decision endpoint rejects accept_risk with a typed problem instead of
   * a false "Apply is now available" ACK the delivery gate would then refuse. */
  private runWorkStateVeto(rec: DaemonRunRecord): "needs_input" | "incomplete" | null {
    const arb = safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord);
    const facts = runOutcomeFacts(rec, arb, readFailure(rec), winnerWorkStateFor(rec));
    if (!facts || facts.lifecycle !== "succeeded") return null;
    const state = facts.work_state?.state;
    return state === "needs_input" || state === "incomplete" ? state : null;
  }

  private chainRunMutation<T>(rec: DaemonRunRecord, work: () => Promise<T>): Promise<T> {
    return chainIdleRunMutation(this.threadTurnChains, this.opts.daemon, rec, work);
  }

  private threadTurnRouteCtx(): ThreadTurnRouteCtx {
    const services = this.opts.services ?? {};
    return {
      json: (res, status, body) => this.json(res, status, body),
      waitForRunStart: (jobId) => this.waitForRunStart(jobId),
      readRunArtifactText: (runId, rel) => this.readRunArtifactText(runId, rel),
      resolveRunArtifactPath: async (runId, rel) => this.resolveRunArtifactPath(runId, rel),
      normalizeStart: runStart.normalizeRunStart,
      preflightRunRequirements: services.preflightRunRequirements,
      preflightThreadRunRequirements: services.preflightThreadRunRequirements,
      isTerminalState: (state) => TERMINAL_STATES.has(state),
      daemon: this.opts.daemon,
      threadDetail: services.threadDetail as NonNullable<typeof services.threadDetail>,
      createThreadTurn: services.createThreadTurn as NonNullable<typeof services.createThreadTurn>,
      findThreadTurnByIdempotency: services.findThreadTurnByIdempotency,
      setTurnEnqueueError: services.setTurnEnqueueError,
      threadTurnChains: this.threadTurnChains,
    };
  }

  private runApplyRouteCtx(): RunApplyRouteContext {
    return {
      services: this.opts.services,
      findRun: (id) => this.findRun(id),
      readBody: (req) => this.readBody(req),
      json: (res, status, body) => this.json(res, status, body),
      requestError: (res, error) => this.requestError(res, error),
      readPatch,
      targetRoot: applyTargetRoot,
      gateError: (record, patch, root, finalVerify) =>
        applyGateError(record, patch, root, this.operatorDecisionFor(record), finalVerify),
      gateSpecs: gateSpecsForRun,
      chainMutation: (record, work) => this.chainRunMutation(record, work),
      appendAudit: appendRunAuditEvent,
      markApplied: (record) => markRunApplyState(record, "applied"),
      markFilesApplied: (record, paths, manifest) => {
        const applied = [
          ...new Set([...(readDeliveryState(record)?.appliedPaths ?? []), ...paths]),
        ];
        const complete =
          deliverableWorkspaceChanges(manifest).every((entry) => applied.includes(entry.path)) &&
          !manifest.entries.some((entry) => entry.before === "unknown" && entry.after !== null);
        markRunApplyState(record, complete ? "applied" : "not_applied", applied, true);
      },
      deliveredApplyState: (record) => controlRunResult(record).applyState,
    };
  }

  private threadLifecycleRouteCtx(): ThreadLifecycleRouteCtx {
    return {
      turnCtx: this.threadTurnRouteCtx(),
      services: this.opts.services,
      listRuns: (query) => this.opts.daemon.list(query),
      readBody: (req) => this.readBody(req),
      json: (res, status, body) => this.json(res, status, body),
      requestError: (res, error) => this.requestError(res, error),
      requiredIdempotencyKey: runStart.requiredIdempotencyKey,
      runIdempotentDelivery: (input) => runIdempotentDelivery(this.opts.services, input),
      readPatch,
      applyGateError: (record, patch, projectRoot) =>
        validateApplyGate({
          ...applyGateInputFor(record, patch, projectRoot, this.operatorDecisionFor(record)),
          deferFinalVerify: true,
        }),
      appendAudit: appendRunAuditEvent,
      gateSpecs: gateSpecsForRun,
    };
  }

  private async resolveRunArtifactPath(runId: string, rel: string): Promise<string | null> {
    const rec = await this.findRun(runId);
    if (!rec?.runDir) return null;
    const abs = join(rec.runDir, rel);
    return existsSync(abs) ? abs : null;
  }

  private async readRunArtifactText(runId: string, rel: string): Promise<string | null> {
    const rec = await this.findRun(runId);
    if (!rec) return null;
    try {
      return readRawTextArtifact(rec, rel);
    } catch {
      return null;
    }
  }

  private readonly summaryCache = new Map<
    string,
    { fingerprint: RunListFingerprint; summary: ControlRunSummary }
  >();

  /** The summary LRU is invalidated by the worker's state+artifact fingerprint. */
  private static readonly SUMMARY_CACHE_MAX = 1_000;

  private async summarizeRunCached(rec: DaemonRunRecord): Promise<ControlRunSummary> {
    const snapshot = await this.bulk.execute({
      kind: "summary",
      input: { record: rec, cached: lruGet(this.summaryCache, rec.id) },
    });
    if ("fingerprint" in snapshot)
      lruSet(this.summaryCache, rec.id, snapshot, DaemonControlApiServer.SUMMARY_CACHE_MAX);
    return snapshot.summary;
  }

  /** Test-only observability: current summary-cache entry count. Proves QA-052
   * LRU boundedness (the cache never grows past SUMMARY_CACHE_MAX). */
  summaryCacheSizeForTests(): number {
    return this.summaryCache.size;
  }

  /**
   * Cached artifact projection + journal-backed waiting_on_user overlay. Pending
   * interactions are not part of the run artifact fingerprint, so they must
   * never be frozen into the summary cache.
   */
  private async summarizeRunLive(rec: DaemonRunRecord): Promise<ControlRunSummary> {
    const summary = await this.summarizeRunCached(rec);
    const waiting = this.pendingInteractionsFor(rec).length > 0;
    return summary.waitingOnUser === waiting ? summary : { ...summary, waitingOnUser: waiting };
  }

  /**
   * Degrade contract shared by GET /runs and the thread-detail turn cards:
   * artifact corruption becomes a diagnostic row in the worker, never a 500
   * for the whole read; a worker failure stays a typed 503.
   */
  private summarizeRunOrDiagnostic(rec: DaemonRunRecord): Promise<ControlRunSummary> {
    return this.summarizeRunLive(rec);
  }

  /**
   * Strict per-run SSE resume cursor (QA-061). The run cursor is the durable
   * nonnegative integer event `seq` (ControlRunDetail.lastSeq). Mirrors the
   * global/project/setup streams' typed contract instead of permissive
   * `Number()` + fallback-0:
   *   absent                -> 0 (intentional full replay)
   *   canonical decimal 0+  -> that safe integer
   *   present but invalid   -> typed HTTP 400 (before SSE headers)
   * A present-but-invalid header is NOT silently erased in favour of the query
   * alias; the header wins when present, the query is used only when it is absent.
   */
  private lastEventId(req: IncomingMessage, url: URL): number {
    assertOnlyQueryParams(url, ["lastEventId"]);
    const rawHeader = req.headers["last-event-id"];
    if (Array.isArray(rawHeader))
      throw invalidRunCursor("Last-Event-ID may be specified only once");
    const rawQuery = singleQuery(url, "lastEventId");
    const raw = rawHeader !== undefined ? rawHeader : rawQuery;
    if (raw === undefined) return 0;
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw invalidRunCursor(
        "run event cursor must be a nonnegative integer event seq; refetch the run snapshot and resume from its lastSeq",
      );
    }
    return Number(raw);
  }

  private async streamEvents(
    id: string,
    lastEventId: number,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    return streamRunEvents(
      {
        findRun: (runId) => this.findRun(runId),
        json: (r, code, v) => this.json(r, code, v),
        opts: this.opts as never,
        sseClients: this.sseClients,
        readBatch: (input, signal) => this.bulk.execute({ kind: "event-replay", input }, signal),
      },
      id,
      lastEventId,
      req,
      res,
    );
  }

  private pendingInteractionsFor(rec: DaemonRunRecord): ControlPendingInteraction[] {
    try {
      return this.opts.services?.pendingInteractions?.(rec.runId ?? rec.id) ?? [];
    } catch {
      return [];
    }
  }
}

/** Compatibility projection for artifact-only CLI reads; the journal record is authority. */
function writeOperatorDecisionProjection(
  rec: DaemonRunRecord,
  record: ControlOperatorDecisionRecord,
): void {
  const root = rec.runDir ? safeArtifactRoot(rec.runDir) : null;
  if (!root) return;
  mkdirSync(join(root, "arbitration"), { recursive: true });
  writeFileSync(
    join(root, "arbitration", "operator_decision.yaml"),
    stringifyYaml({
      action: record.action,
      finding_ids: record.findingIds,
      accepted_risks: record.acceptedRisks,
      patch_sha256: record.patchSha256,
      decided_at: record.decidedAt,
    }),
    "utf8",
  );
}
