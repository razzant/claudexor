import {
  readTextArtifact,
  readRawTextArtifact,
  readStructured,
  safeReadStructuredArtifact,
} from "./run-artifact-read.js";
import { controlRunResult, readDeliveryState, markRunApplyState } from "./run-delivery-state.js";
import { timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { basename, extname, join } from "node:path";
import {
  type ApplyGateInput,
  deriveApplyEligibility,
  revertInPlaceFromAnchor,
  validateApplyGate,
  verifyAndDeliver,
} from "@claudexor/delivery";
import { appendRunEvent, lastSeqInFile } from "@claudexor/event-log";
import { isVanishedErrno, safeArtifactPath, safeArtifactRoot } from "./artifact-paths.js";
import { TERMINAL_STATES } from "./sse-shared.js";
import { readFilesWorkProduct } from "./files-work-product.js";
import { applyFilesResult } from "./files-apply-route.js";
import { deliverableWorkspaceChanges } from "@claudexor/workspace";
import { streamRunEvents } from "./run-events-stream.js";
import { boundedArtifactText, outputReadyState, primaryOutput } from "./primary-output.js";
import {
  budgetValuationFromEvents,
  cashEstimatedFromLedgerEvent,
  cashKnowledgeFromEvents,
  normalizeLegacyBudgetComponents,
} from "./budget-valuation.js";
import {
  type RunEventsIntegrity,
  controlWebEvidence,
  eventPayload,
  evidenceLevel,
  latestPlanProgress,
  readRunEvents,
  readRunEventsWithIntegrity,
  timelineEvents,
} from "./run-timeline.js";
import { projectTurnRunCards } from "./thread-projection.js";
import { projectSession, projectThread, projectTurn } from "./thread-projection.js";
import {
  handleThreadTurnCreate,
  handleThreadTurnRetry,
  type ThreadTurnRouteCtx,
} from "./thread-turn-routes.js";
import { chainIdleRunMutation, chainThreadMutation } from "./thread-mutation.js";
import {
  handleThreadLifecycleRoutes,
  type ThreadLifecycleRouteCtx,
} from "./thread-lifecycle-routes.js";
import * as runStart from "./run-start.js";
import { cancelDelegationFamily } from "./delegation-control.js";
import {
  delegatedDescendantsFromRecords,
  paramsRecord,
  type ControlOperatorDecisionRecord,
  type DaemonFacadeClient,
  type DaemonRunRecord,
} from "./run-record.js";
export {
  type ControlOperatorDecisionRecord,
  type DaemonFacadeClient,
  type DaemonRunRecord,
} from "./run-record.js";
import { handleRunRetryRoute } from "./run-retry-routes.js";
import { handleRunMessageRoute } from "./run-message-routes.js";
import {
  handleRunApplyRoutes,
  runIdempotentDelivery,
  type DeliveryCommandServices,
  type RunApplyRouteContext,
} from "./run-apply-routes.js";
import { rerunWithFeedback } from "./decision-rerun.js";
import { acceptRiskDecision, type RiskDecisionBody } from "./decision-accept-risk.js";
export { normalizeRunStartRequest } from "./run-start.js";
import { candidatesFor } from "./candidates.js";
import { handleProjectRoute, type ProjectRouteServices } from "./project-routes.js";
import { writeBinaryResponse } from "./binary-response.js";
export { inlineContentDisposition } from "./binary-response.js";
import { handleRecoveryRoute } from "./recovery-routes.js";
import { handleJournalEventRoute } from "./journal-event-routes.js";
import { handleMaintenanceRoute, type MaintenanceRouteServices } from "./maintenance-routes.js";
import { handleResourceRoute, type ResourceRouteServices } from "./resource-routes.js";
import { handleModelRoute, type ModelRouteServices } from "./model-routes.js";
import {
  handleArtifactServeRoute,
  listArtifacts,
  resolveProjectRoot,
  type ResolvedThreadWorkspace,
} from "./artifact-serve-routes.js";
import { requiredGateSpecsFromTaskArtifact } from "./task-contract-gates.js";
import { bearerCredential } from "./authorization.js";
import { assertOnlyQueryParams, singleQuery } from "./query.js";
import {
  parseCredentialProfilesSnapshotQuery,
  parseHarnessListQuery,
  parseRunApplicabilityQuery,
} from "./catalog-query.js";
import {
  lruGet,
  lruSet,
  parseRunListQuery,
  selectRunListPage,
  type RunListQuery,
} from "./run-list.js";
import { summaryFingerprint } from "./run-list-fingerprint.js";
export {
  resetRunListFingerprintProbeCountForTests,
  runListFingerprintProbeCountForTests,
} from "./run-list-fingerprint.js";
import {
  controlProblemError,
  normalizeRequestValidationError,
  revertRefusedProblem,
  thrownProblemCode,
} from "./problem-response.js";
import { handleSecurityRoute } from "./security-routes.js";
import {
  effectiveTerminalFacts,
  expectedRunFacts,
  projectRunFactsForDetail,
} from "./run-facts-projection.js";
import {
  PlanQuestionsArtifact,
  CouncilProjection,
  derivePlanReadiness,
  directDelegatedChildrenFromRecords,
  type ApplyEligibility,
  ControlAuthReadinessRefreshRequest,
  ControlAuthReadinessRefreshResponse,
  ControlProblem,
  AccessProfile,
  ResourceAttachmentRef,
  ControlApplyCheckRequest,
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
  ControlRunControlRequest,
  ControlRunControlResponse,
  ControlReviewerPanelEntry,
  ControlRunDetail,
  ControlRunListResponse,
  ControlRunSummary,
  ControlBudgetSnapshot,
  PaidBudget,
  ControlSettingsSnapshot,
  ControlSettingsUpdateRequest,
  ControlQuotaRefreshRequest,
  ControlQuotaResponse,
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
  type ControlRouteInfo,
  type LiveMessageDelivery,
  type LiveMessageInput,
  ControlRunDecisionRequest,
  ControlRunDecisionResponse,
  ControlRunApplicabilityResponse,
  ControlThreadCreateRequest,
  ControlThreadTurnRequest,
  ControlThreadUpdateRequest,
  ControlThreadDetail,
  ControlThreadListResponse,
  DecisionRecord,
  Id,
  ModeKind,
  RoutingGoal,
  ReviewFinding,
  RunEventType,
  RunFailure,
  RunTelemetry,
  StructuredOutputConformance,
  TaskContract,
  ProtectedPathApproval,
  type FinalVerifyRecord,
  type RunOutcomeFacts,
  type WorkState,
  isEphemeralRunScope,
  isTerminalLifecycle,
  needsDecision,
  needsOperatorAttention,
  outcomeBanner,
  outcomeFactsFromFailure,
  TestCommandInvocation,
  WorkProduct,
} from "@claudexor/schema";

import { resolveControlProtocol, type ControlServingMode } from "./control-protocol.js";
import { readControlRequestBody } from "./request-body.js";
import {
  assertNoInlineSecretValues,
  containsSecretLikeToken,
  errorCode,
  noProjectRepoRoot,
  redactSecrets,
  safeProblemContext,
  safeProblemRequiredActions,
  sha256,
} from "@claudexor/util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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
  bus?: { subscribe(listener: (event: { run_id: string }) => void): () => void };
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
      journalEvents?: (partition: string, afterCursor?: string) => Promise<unknown>;
      settings?: () => Promise<unknown>;
      updateSettings?: (patch: unknown) => Promise<unknown>;
      quota?: () => Promise<unknown>;
      refreshQuota?: (input?: ControlQuotaRefreshRequest) => Promise<unknown>;
      accountPools?: () => Promise<unknown>;
      rollbackAccountsMigration?: (input: unknown) => Promise<unknown>;
      credentialProfiles?: (input?: { snapshot?: boolean }) => Promise<unknown>;
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

const NO_PROJECT_ROOT = noProjectRepoRoot();

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
  private server?: Server;
  private startPromise: Promise<{ host: string; port: number }> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;
  private readonly sseClients = new Set<ServerResponse>();
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
      this.server = createServer((req, res) => this.onRequest(req, res));
      this.server.once("error", reject);
      this.server.listen(port, host, () => resolve());
    });
    const addr = this.server?.address();
    return { host, port: typeof addr === "object" && addr ? addr.port : port };
  }

  stop(): Promise<void> {
    this.stopping = true;
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    const listenerClosed = this.closeListener();
    this.closeSseClients();
    await Promise.all([listenerClosed, this.drainActiveHandlers()]);
    this.closeSseClients();
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

  private readBody(req: IncomingMessage): Promise<unknown> {
    return readControlRequestBody(req);
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const tracked: Promise<void> = this.handle(req, res)
      .catch((err) => {
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
      });
    } catch (error) {
      return this.requestError(res, error);
    }
    if (protocol.kind === "response") {
      return this.json(res, protocol.status, protocol.body, protocol.contentType);
    }
    const path = protocol.path;
    const dataRoutes = {
      services: this.opts.services,
      readBody: (request: IncomingMessage) => this.readBody(request),
      json: (response: ServerResponse, status: number, body: unknown) =>
        this.json(response, status, body),
      requestError: (response: ServerResponse, error: unknown, fallback?: 400 | 500) =>
        this.requestError(response, error, fallback),
    };
    for (const route of [handleResourceRoute, handleModelRoute, handleMaintenanceRoute]) {
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
          requestError: (response, error) => this.requestError(response, error),
          json: (response, status, body) => this.json(response, status, body),
          respondToAcceptedJob: (response, jobId) => this.respondToAcceptedJob(response, jobId),
          validateResources: this.opts.services?.validateResources,
          preflightRunRequirements: this.opts.services?.preflightRunRequirements,
        },
        req,
        res,
      );
    }

    if (method === "GET" && path === "/runs") {
      return this.handleRunList(url, res);
    }

    if (
      await handleRunRetryRoute(
        {
          daemon: this.opts.daemon,
          services: this.opts.services,
          findRun: (id) => this.findRun(id),
          waitForRunStart: (id) => this.waitForRunStart(id),
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

    const runDetailMatch = /^\/runs\/([^/]+)$/.exec(path);
    if (method === "GET" && runDetailMatch) {
      const rec = await this.findRun(decodeURIComponent(runDetailMatch[1] as string));
      if (!rec) return this.json(res, 404, { error: "no such run" });
      // Fence order: cursor FIRST, every projection (pending interactions
      // included) after it — see the detailFor doc comment.
      const lastSeq = rec.runDir ? lastSeqInFile(join(rec.runDir, "events.jsonl")) : 0;
      const parentRunId = rec.runId ?? rec.id;
      // Addressed child read: the daemon selects this parent's direct children
      // before it projects, so parent detail never pays for the params of every
      // other retained run. The same bounded rule is re-applied here, because an
      // engine that predates the query answers with the whole list.
      const children = directDelegatedChildrenFromRecords(
        parentRunId,
        await this.opts.daemon.list({ delegatedFromRunId: parentRunId }),
      ).map((candidate) => this.summarizeRunOrDiagnostic(candidate));
      return this.json(
        res,
        200,
        detailFor(
          rec,
          this.pendingInteractionsFor(rec),
          lastSeq,
          this.validOperatorDecisionFor(rec),
          children,
        ),
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
        assertNoInlineSecretValues(raw);
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
      const svc = this.opts.services?.createThread;
      if (!svc)
        return this.json(res, 501, { error: "threads are not supported by this engine build" });
      try {
        const body = await this.readBody(req);
        assertNoInlineSecretValues(body);
        const parsed = ControlThreadCreateRequest.parse(body);
        const idempotencyKey = runStart.requiredIdempotencyKey(req);
        let repoRoot: string | null = null;
        if (parsed.scope.kind === "project") {
          repoRoot = runStart.normalizeExistingProjectRoot(parsed.scope.root);
        }
        const thread = await svc({
          title: parsed.title,
          folder: parsed.folder,
          repoRoot,
          // Carried explicitly through the SAME predicate the run route and the
          // partition router use: dropping it here would register a root the
          // wire contract promises never to register.
          ephemeral: isEphemeralRunScope(parsed.scope),
          mode: parsed.mode,
          workspace: parsed.workspace,
          authPreference: parsed.authPreference,
          credentialProfileId: parsed.credentialProfileId ?? null,
          access: parsed.access,
          primaryHarness: parsed.primaryHarness ?? null,
          eligibleHarnesses: parsed.eligibleHarnesses,
          idempotency: {
            key: idempotencyKey,
            client: "control-api",
            request: parsed,
          },
        });
        return this.json(res, 200, projectThread(thread, false));
      } catch (err) {
        return this.requestError(res, err);
      }
    }

    if (method === "GET" && path === "/threads") {
      const svc = this.opts.services?.listThreads;
      if (!svc)
        return this.json(res, 501, { error: "threads are not supported by this engine build" });
      const { threads, problems } = await svc();
      const runs = await this.opts.daemon.list();
      const blocked = new Set(
        runs.filter((r) => this.runNeedsAttention(r)).map((r) => r.runId ?? r.id),
      );
      return this.json(
        res,
        200,
        ControlThreadListResponse.parse({
          threads: threads.map((t) =>
            projectThread(t, blocked.has((t as { head_run_id?: string | null }).head_run_id ?? "")),
          ),
          problems: problems ?? [],
        }),
      );
    }

    const threadDetailMatch = /^\/threads\/([^/]+)$/.exec(path);
    if (method === "GET" && threadDetailMatch) {
      const svc = this.opts.services?.threadDetail;
      if (!svc)
        return this.json(res, 501, { error: "threads are not supported by this engine build" });
      try {
        const detail = await svc(decodeURIComponent(threadDetailMatch[1] as string));
        const runs = await this.opts.daemon.list();
        const byRun = new Map(runs.map((r) => [r.runId ?? r.id, r]));
        const thread = detail.thread as { head_run_id?: string | null };
        const cards = projectTurnRunCards(
          detail.turns as { run_id?: string | null }[],
          runs,
          (record) => this.summarizeRunOrDiagnostic(record),
        );
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
        assertNoInlineSecretValues(raw);
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
        assertNoInlineSecretValues(body);
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
        assertNoInlineSecretValues(raw);
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
                const repoRoot = applyTargetRoot({ kind: "original_project" }, rec);
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
              work: async () => {
                const files = readFilesWorkProduct(rec);
                const state = controlRunResult(rec).applyState;
                if (
                  !TERMINAL_STATES.has(rec.state) ||
                  !files ||
                  files.manifest.isolation !== "envelope" ||
                  (state !== "not_applied" && state !== "discarded")
                )
                  throw Object.assign(
                    new Error(
                      "Only an unapplied copied files result can be discarded; direct effects remain in place",
                    ),
                    { status: 409 },
                  );
                markRunApplyState(rec, "discarded", undefined, true);
                appendRunAuditEvent(rec, "control.applied", {
                  decision: "discard",
                  manifest_sha256: files.manifestSha256,
                });
                return ControlRunDecisionResponse.parse({
                  accepted: true,
                  status: "discarded",
                  message:
                    "Pending file application discarded; retained result follows normal retention.",
                });
              },
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
        const patch = readPatch(rec);
        if (patch === null) return this.json(res, 404, { error: "no patch artifact for this run" });
        if (containsSecretLikeToken(patch))
          return this.json(res, 409, { error: "patch contains secret-like token; refusing apply" });
        const repoRoot = applyTargetRoot(body.target ?? { kind: "original_project" }, rec);
        if (!repoRoot) return this.json(res, 400, { error: "project root is required for apply" });
        const absoluteRepoError = runStart.validateAbsoluteRepoRoot(repoRoot);
        if (absoluteRepoError) return this.json(res, 400, { error: absoluteRepoError });
        try {
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
                    code: "delivery_refused",
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
        assertNoInlineSecretValues(raw);
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
        assertNoInlineSecretValues(raw);
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
        assertNoInlineSecretValues(raw);
        body = ControlSettingsUpdateRequest.parse(raw);
      } catch (err) {
        return this.requestError(res, err);
      }
      return this.service(res, "updateSettings", body, ControlSettingsSnapshot);
    }
    if (method === "GET" && path === "/quota")
      return this.service(res, "quota", undefined, ControlQuotaResponse);
    // Unified account model: the pool-authority read (also the feature marker
    // clients detect through the operation catalog).
    if (method === "GET" && path === "/account-pools")
      return this.service(res, "accountPools", undefined, ControlAccountPoolsResponse);
    if (method === "POST" && path === "/quota") {
      let body: ControlQuotaRefreshRequest;
      try {
        // An absent/empty body keeps the model-agnostic projection.
        body = ControlQuotaRefreshRequest.parse(await this.readBody(req));
      } catch (err) {
        return this.requestError(res, err);
      }
      return this.service(res, "refreshQuota", body, ControlQuotaResponse);
    }
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
        assertNoInlineSecretValues(raw);
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
        assertNoInlineSecretValues(raw);
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
    const controlMatch = /^\/runs\/([^/]+)\/control$/.exec(path);
    if (method === "POST" && controlMatch) {
      const rec = await this.findRun(decodeURIComponent(controlMatch[1] as string));
      if (!rec) return this.json(res, 404, { error: "no such run" });
      let body: ControlRunControlRequest;
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        body = ControlRunControlRequest.parse(raw);
      } catch (err) {
        return this.requestError(res, err);
      }
      appendRunAuditEvent(rec, "control.requested", { control: body.control });
      // Honesty: a control action on a TERMINAL job has no process to stop;
      // claiming "applied" would fabricate an effect that never happened.
      if (rec.state !== "queued" && rec.state !== "running") {
        appendRunAuditEvent(rec, "control.rejected", {
          control: body.control,
          reason: `run is terminal (${rec.state})`,
        });
        return this.json(res, 409, {
          error: `run is ${rec.state}; ${body.control.kind} has nothing to stop`,
        });
      }
      let activeDescendants: DaemonRunRecord[];
      try {
        const cancelled = await cancelDelegationFamily({
          daemon: this.opts.daemon,
          parent: rec,
          descendantsAfterFence: () => this.delegatedDescendants(rec.runId ?? rec.id),
          pollMs: this.opts.pollMs,
          // The typed class rides the abort into the terminal writers; the
          // free-text reason stays audit-only (it was ALWAYS dropped before —
          // even Claudexor's own ctrl-c relay coerced to user_cancelled).
          reasonCode: body.control.reason_code,
        });
        activeDescendants = cancelled.descendants;
      } catch (error) {
        appendRunAuditEvent(rec, "control.rejected", {
          control: body.control,
          reason: error instanceof Error ? error.message : String(error),
        });
        return this.requestError(res, error);
      }
      appendRunAuditEvent(rec, "control.applied", { control: body.control });
      return this.json(
        res,
        200,
        ControlRunControlResponse.parse({
          accepted: true,
          status: "applied",
          runId: rec.runId ?? rec.id,
          cascadeRunIds: activeDescendants.map((child) => child.runId ?? child.id),
          message: `${body.control.kind} requested${activeDescendants.length ? ` for parent and ${activeDescendants.length} delegated descendant(s)` : ""}`,
        }),
      );
    }

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
      if (Date.now() > deadline) return last;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  private async respondToAcceptedJob(res: ServerResponse, jobId: string): Promise<void> {
    const rec = await this.waitForRunStart(jobId);
    if (rec.runId && rec.runDir) {
      return this.json(
        res,
        200,
        ControlRunStartInfo.parse({
          jobId: rec.id,
          runId: rec.runId,
          taskId: rec.taskId,
          runDir: rec.runDir,
        }),
      );
    }
    const { status, body } = runStart.unboundRunStartResponse(rec, TERMINAL_STATES.has(rec.state));
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
    return delegatedDescendantsFromRecords(parentRunId, await this.opts.daemon.list());
  }

  /**
   * GET /v2/runs (QA-052): a bounded, newest-first, keyset-paginated page of run
   * summaries. Ordering, filtering, and slicing all happen on the raw daemon
   * records BEFORE any summary is materialized, so the expensive per-run
   * artifact fingerprint/projection work is bounded by `limit` (page size), not
   * by the total retained-record count. `limit`/`state`/`cursor` are typed and
   * strict — an unknown or malformed param is a typed 400, never silently
   * ignored. The bare (unparametered) call is still valid and now returns the
   * newest `RUN_LIST_DEFAULT_LIMIT` runs with `hasMore`/`nextCursor` to page the
   * rest.
   */
  private async handleRunList(url: URL, res: ServerResponse): Promise<void> {
    let query: RunListQuery;
    try {
      query = parseRunListQuery(url);
    } catch (error) {
      return this.requestError(res, error);
    }
    const { page, hasMore, nextCursor } = selectRunListPage(await this.opts.daemon.list(), query);
    return this.json(
      res,
      200,
      ControlRunListResponse.parse({
        runs: page.map((r) => this.summarizeRunOrDiagnostic(r)),
        nextCursor,
        hasMore,
      }),
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
    const ws = (thread as { workspace?: { mode?: unknown; worktree_path?: unknown } })?.workspace;
    if (!ws) return null;
    return {
      mode: ws.mode === "isolated" ? "isolated" : "in_place",
      worktreePath:
        typeof ws.worktree_path === "string" && ws.worktree_path.trim() ? ws.worktree_path : null,
    };
  }

  private operatorDecisionFor(rec: DaemonRunRecord): ControlOperatorDecisionRecord | null {
    return this.opts.services?.operatorDecision?.(rec.runId ?? rec.id, rec.params) ?? null;
  }

  private validOperatorDecisionFor(rec: DaemonRunRecord): ControlOperatorDecisionRecord | null {
    const decision = this.operatorDecisionFor(rec);
    if (!decision) return null;
    const patch = readTextArtifact(rec, "final/patch.diff", false);
    return patch !== null && decision.patchSha256 === sha256(patch) ? decision : null;
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
      listRuns: () => this.opts.daemon.list(),
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
    { fingerprint: string; summary: ControlRunSummary }
  >();

  /**
   * GET /runs is the app's main screen and used to re-read every artifact for
   * every retained job on every poll (O(jobs x file size) sync I/O). Terminal
   * runs change only when their artifacts change, so summaries are cached on a
   * state+artifact-mtime fingerprint.
   */
  private static readonly SUMMARY_CACHE_MAX = 1_000;

  private summarizeRunCached(rec: DaemonRunRecord): ControlRunSummary {
    const fingerprint = summaryFingerprint(rec);
    const hit = lruGet(this.summaryCache, rec.id);
    if (hit && hit.fingerprint === fingerprint) return hit.summary;
    const summary = summarizeRun(rec);
    // QA-052: LRU-bounded eviction (oldest entry drops) instead of the old
    // wholesale clear at the guard, so a large retained set never pays a full
    // cache rehydration wave.
    lruSet(
      this.summaryCache,
      rec.id,
      { fingerprint, summary },
      DaemonControlApiServer.SUMMARY_CACHE_MAX,
    );
    return summary;
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
  private summarizeRunLive(rec: DaemonRunRecord): ControlRunSummary {
    const summary = this.summarizeRunCached(rec);
    const waiting = this.pendingInteractionsFor(rec).length > 0;
    return summary.waitingOnUser === waiting ? summary : { ...summary, waitingOnUser: waiting };
  }

  /**
   * Degrade contract shared by GET /runs and the thread-detail turn cards:
   * one unprojectable job record becomes a diagnostic row, never a 500 for
   * the whole list/thread.
   */
  private summarizeRunOrDiagnostic(rec: DaemonRunRecord): ControlRunSummary {
    try {
      return this.summarizeRunLive(rec);
    } catch (err) {
      const delegatedFromRunId = Id.safeParse(paramsRecord(rec)["delegatedFromRunId"]);
      let waitingOnUser = false;
      try {
        waitingOnUser = this.pendingInteractionsFor(rec).length > 0;
      } catch {
        // The diagnostic row remains fail-soft even when interaction state is
        // also corrupt; false is the only safe fallback without evidence.
      }
      return ControlRunSummary.parse({
        jobId: rec.id,
        runId: rec.runId ?? rec.id,
        ...(delegatedFromRunId.success ? { delegatedFromRunId: delegatedFromRunId.data } : {}),
        waitingOnUser,
        state: "failed",
        error: redactSecrets(
          `unprojectable job record: ${err instanceof Error ? err.message : String(err)}`,
        ),
      });
    }
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

/* ---- Thread projections (engine snake_case -> control camelCase) ---- */

function projectMetadata(rec: DaemonRunRecord): {
  kind: "project" | "none";
  root: string | null;
  projectName: string | null;
  context: "off" | "auto";
} {
  const p = paramsRecord(rec);
  const scope = p["scope"];
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    const s = scope as Record<string, unknown>;
    if (s["kind"] === "none")
      return { kind: "none", root: null, projectName: null, context: "off" };
    if (s["kind"] === "project" && typeof s["root"] === "string") {
      return {
        kind: "project",
        root: s["root"],
        projectName: basename(s["root"]),
        context: "auto",
      };
    }
  }
  const repoRoot = runRepoRoot(rec);
  const noProject = repoRoot === NO_PROJECT_ROOT;
  return {
    kind: noProject ? "none" : "project",
    root: noProject ? null : repoRoot,
    projectName: noProject || !repoRoot ? null : basename(repoRoot),
    context: noProject ? "off" : "auto",
  };
}

function readFailure(rec: DaemonRunRecord): RunFailure | null {
  const fromArtifact = safeReadStructuredArtifact(rec, "final/failure.yaml", RunFailure);
  if (fromArtifact) return fromArtifact;
  if (!rec.error) return null;
  return RunFailure.parse({
    category: "unknown",
    safeMessage: rec.error,
    runDir: rec.runDir ?? null,
  });
}

function appendRunAuditEvent(
  rec: DaemonRunRecord,
  type: RunEventType,
  payload: Record<string, unknown>,
): void {
  if (!rec.runDir) return;
  try {
    // Single-counter invariant: while the run is active its EventLog owns the
    // seq space, so audit records MUST route through it (appendRunEvent does;
    // file-tail stamping only applies once the run is terminal). A tail-read
    // here would duplicate ids and break SSE Last-Event-ID resume.
    appendRunEvent(
      join(rec.runDir, "events.jsonl"),
      rec.runId ?? rec.id,
      rec.taskId ?? "unknown",
      type,
      payload,
    );
  } catch {
    /* audit append must not change control behavior */
  }
}

/** v0.9 strategy flags projected back so surfaces can tell a race from a repair loop. */
function strategyFromParams(
  p: Record<string, unknown>,
): "race" | "attempts" | "until_clean" | "deep_scan" | "create" | null {
  if (p["untilClean"] === true) return "until_clean";
  if (typeof p["attempts"] === "number" && p["attempts"] > 0) return "attempts";
  if (p["create"] === true) return "create";
  if (p["deepScan"] === true) return "deep_scan";
  if (typeof p["n"] === "number" && p["n"] > 1) return "race";
  return null;
}

/**
 * Honest terminal outcome, projected from final/work_product.yaml's meta (the
 * orchestrator-owned record of what the turn produced). Answers the v0.9 "is the
 * game done?" gap: plan runs report kind=plan with a null diffStat (no files
 * changed), patches report a real diffStat, and a race-adopted patch reports
 * adopted=true.
 */
/** Project the D8 terminal outcome AXES for a run: decision.facts when present
 * (the arbitrated truth), else derived from the typed failure category + the
 * lifecycle (a decision-less plan/readonly/crash terminal). Null while the run
 * is not terminal. Lives here as the ONE control-plane projection; surfaces
 * read `outcomeFacts`, never re-derive. */
function runOutcomeFacts(
  rec: DaemonRunRecord,
  decision: DecisionRecord | null,
  failure: RunFailure | null,
  /** D-16: the winning read-only/plan attempt's work_state (from telemetry),
   * folded into a DECISION-LESS terminal so a needs_input/incomplete ask
   * carries its veto axis just like an arbitrated agent run. */
  workState: WorkState | null = null,
): RunOutcomeFacts | null {
  const legacy = legacyRunOutcomeFacts(rec, decision, failure, workState);
  if (!legacy) return null;
  return effectiveTerminalFacts(rec.runDir, legacy, decision, expectedRunFacts(rec)).outcomeFacts;
}

/** Legacy-only terminal projection retained for active/pre-RunFacts records. */
function legacyRunOutcomeFacts(
  rec: DaemonRunRecord,
  decision: DecisionRecord | null,
  failure: RunFailure | null,
  workState: WorkState | null = null,
): RunOutcomeFacts | null {
  if (!isTerminalLifecycle(rec.state)) return null;
  // Arbitrated runs already carry work_state on decision.facts (INV-116).
  if (decision) return decision.facts;
  const lifecycle = rec.state as RunOutcomeFacts["lifecycle"];
  const base = outcomeFactsFromFailure(lifecycle, failure?.category);
  if (!workState || lifecycle !== "succeeded") return base;
  const vetoed = workState.state === "needs_input" || workState.state === "incomplete";
  return {
    ...base,
    work_state: workState,
    ...(vetoed
      ? {
          reason:
            base.reason ??
            (workState.state === "needs_input" ? "input_required" : "work_incomplete"),
        }
      : {}),
  };
}

/** D-16: the winning attempt's work_state from a run's telemetry.yaml, used to
 * fold the veto axis into a decision-less terminal's outcome facts. */
function winnerWorkStateFor(rec: DaemonRunRecord): WorkState | null {
  const telemetry = safeReadStructuredArtifact(rec, "final/telemetry.yaml", RunTelemetry);
  if (!telemetry) return null;
  const winner = telemetry.final_attempt_id
    ? telemetry.attempts.find((a) => a.attempt_id === telemetry.final_attempt_id)
    : undefined;
  return winner?.outcome.work_state ?? null;
}

function summarizeRun(
  rec: DaemonRunRecord,
  eventsSnapshot?: Record<string, unknown>[],
): ControlRunSummary {
  const p = paramsRecord(rec);
  // safeParse everywhere: one malformed job record (e.g. an old/foreign mode id)
  // must degrade to an unknown field, never 500 the whole run list forever.
  const parsedMode = ModeKind.safeParse(p["mode"]);
  const parsedRoutingGoal = RoutingGoal.safeParse(p["routingGoal"]);
  const parsedAccess = parseAccessMaybe(p["access"]);
  const task = safeReadStructuredArtifact(rec, "context/task.yaml", TaskContract);
  const telemetry = safeReadStructuredArtifact(rec, "final/telemetry.yaml", RunTelemetry);
  const outputConformance = safeReadStructuredArtifact(
    rec,
    "final/structured_output.yaml",
    StructuredOutputConformance,
  );
  // Access truth comes from engine artifacts ONLY (contract/telemetry); client
  // params can request but never assert what was effectively enforced.
  const requestedAccess =
    telemetry?.requested_access ?? task?.access.requested_profile ?? parsedAccess;
  const effectiveAccess = telemetry?.effective_access ?? task?.access.effective_profile;
  const externalContextPolicy = telemetry?.external_context_policy ?? task?.external_context.policy;
  const webEvidence = controlWebEvidence(telemetry, task);
  const decision = safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord);
  const failure = readFailure(rec);
  const workState = telemetry?.final_attempt_id
    ? (telemetry.attempts.find((a) => a.attempt_id === telemetry.final_attempt_id)?.outcome
        .work_state ?? null)
    : null;
  const legacyOutcome = legacyRunOutcomeFacts(rec, decision, failure, workState);
  const terminalFacts = legacyOutcome
    ? effectiveTerminalFacts(rec.runDir, legacyOutcome, decision, expectedRunFacts(rec))
    : { runFacts: null, outcomeFacts: null, decision };
  const budget = budgetSnapshot(rec, decision, eventsSnapshot);
  const parsedReviewerPanel = Array.isArray(p["reviewerPanel"])
    ? ControlReviewerPanelEntry.array().safeParse(p["reviewerPanel"])
    : null;
  const parsedProtectedPathApprovals = Array.isArray(p["protectedPathApprovals"])
    ? ProtectedPathApproval.array().safeParse(p["protectedPathApprovals"])
    : null;
  const requestTests = Array.isArray(p["tests"])
    ? TestCommandInvocation.array().safeParse(p["tests"]).data
    : undefined;
  const contractTests = task?.tests.commands.map(({ program, args, cwd, envAllowlist }) => ({
    program,
    args,
    ...(cwd === undefined ? {} : { cwd }),
    envAllowlist,
  }));
  return ControlRunSummary.parse({
    jobId: rec.id,
    runId: rec.runId ?? rec.id,
    parentRunId:
      (typeof p["parentRunId"] === "string" ? p["parentRunId"] : null) ??
      task?.run_lineage.parent_run_id ??
      null,
    delegatedFromRunId:
      (typeof p["delegatedFromRunId"] === "string" ? p["delegatedFromRunId"] : null) ??
      task?.run_lineage.delegated_from_run_id ??
      null,
    delegation: telemetry?.delegation ?? null,
    taskId: rec.taskId,
    state: rec.state,
    runDir: rec.runDir,
    error: rec.error,
    failure,
    project: projectMetadata(rec),
    mode: parsedMode.success ? parsedMode.data : undefined,
    strategy: strategyFromParams(p),
    prompt: typeof p["prompt"] === "string" ? redactPrompt(p["prompt"]) : undefined,
    harnesses: Array.isArray(p["harnesses"])
      ? p["harnesses"].filter((x): x is string => typeof x === "string")
      : undefined,
    primaryHarness: typeof p["primaryHarness"] === "string" ? p["primaryHarness"] : undefined,
    routingGoal: parsedRoutingGoal.success ? parsedRoutingGoal.data : undefined,
    model: typeof p["model"] === "string" ? p["model"] : undefined,
    review: task?.review_requested ?? (typeof p["review"] === "boolean" ? p["review"] : undefined),
    reviewerPanel: parsedReviewerPanel?.success ? parsedReviewerPanel.data : undefined,
    protectedPathApprovals: parsedProtectedPathApprovals?.success
      ? parsedProtectedPathApprovals.data
      : undefined,
    n: typeof p["n"] === "number" ? p["n"] : undefined,
    paidBudget: PaidBudget.safeParse(p["paidBudget"]).data ?? task?.budget.paid_budget,
    spendUsd: budget.spendUsd,
    spendEstimated: budget.estimated,
    // Token usage is projected straight from the engine-owned telemetry rollup —
    // never re-derived from raw events; runs that predate it report null.
    inputTokens: telemetry?.usage_totals.input_tokens ?? null,
    outputTokens: telemetry?.usage_totals.output_tokens ?? null,
    cachedInputTokens: telemetry?.usage_totals.cached_input_tokens ?? null,
    inputTokenUsage: telemetry?.usage_totals.input_token_usage,
    // The single engine validator's receipt, projected verbatim — surfaces
    // never re-validate the answer (null = no structured-output contract).
    outputConformance: outputConformance?.status ?? null,
    authRoute: telemetry?.auth_route
      ? {
          requested: telemetry.auth_route.requested,
          effective: telemetry.auth_route.effective,
          source: telemetry.auth_route.source,
          reason: telemetry.auth_route.reason,
          harnessId: telemetry.auth_route.harness_id,
          attemptId: telemetry.auth_route.attempt_id,
          profileId: telemetry.auth_route.profile_id,
          modelMismatch: telemetry.auth_route.model_mismatch,
        }
      : null,
    access: effectiveAccess ?? parsedAccess,
    requestedAccess,
    effectiveAccess,
    externalContextPolicy,
    webRequired: telemetry?.web_required ?? task?.external_context.web_required,
    webMode: telemetry?.effective_web_mode ?? task?.external_context.effective_mode,
    webEvidence,
    requestRequirements: telemetry?.request_requirements ?? [],
    toolPermissionPolicy: task?.tool_permission_policy,
    outputReadyState: outputReadyState(
      rec,
      parsedMode.success ? parsedMode.data : null,
      failure,
      terminalFacts.runFacts,
    ),
    toolWarningsTotal: telemetry?.tool_warnings_total ?? 0,
    result: controlRunResult(rec),
    outcomeFacts: terminalFacts.outcomeFacts,
    route: controlRoute(telemetry, p),
    // QA-034: routing rationale projected verbatim from the engine telemetry —
    // surfaces never reconstruct the order from prose.
    routingRationale: telemetry?.routing_rationale ?? null,
    tests: requestTests ?? (contractTests?.length ? contractTests : undefined),
    createdAt: rec.createdAt,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
  });
}

/**
 * Run-level route evidence: observed model comes ONLY from telemetry (the
 * harness stream's own disclosure); the requested model from run params.
 * `verified` is never inferred from the request alone.
 */
function controlRoute(
  telemetry: RunTelemetry | null,
  p: Record<string, unknown>,
): ControlRouteInfo | null {
  if (!telemetry) return null;
  const finalAttempt = telemetry.final_attempt_id
    ? telemetry.attempts.find((a) => a.attempt_id === telemetry.final_attempt_id)
    : undefined;
  const observed =
    finalAttempt?.observed_model ??
    telemetry.attempts.find((a) => a.observed_model)?.observed_model ??
    null;
  const harnessId =
    finalAttempt?.harness_id ??
    telemetry.attempts.find((a) => a.observed_model)?.harness_id ??
    null;
  return {
    // Scalar-only by design until per-candidate route evidence lands:
    // map-only pool members show requestedModel null here, honestly.
    requestedModel: typeof p["model"] === "string" ? p["model"] : null,
    observedModel: observed,
    harnessId,
    verified: observed !== null,
  };
}

function detailFor(
  rec: DaemonRunRecord,
  pendingInteractions: ControlPendingInteraction[] = [],
  cursor?: number,
  operator: ControlOperatorDecisionRecord | null = null,
  children: ControlRunSummary[] = [],
): ControlRunDetail {
  // Snapshot fence: capture the event cursor BEFORE building any projection.
  // The fence promise is "every event with seq <= lastSeq is reflected" — a
  // cursor read AFTER the projections could skip an event that landed in
  // between (the projections would not reflect it, and a client resuming from
  // that cursor would never see it). A pre-projection cursor errs the other
  // way: an in-between event is both reflected AND replayed, which clients
  // absorb (event application is reconciled against the newer snapshot).
  const lastSeq = cursor ?? (rec.runDir ? lastSeqInFile(join(rec.runDir, "events.jsonl")) : 0);
  const failure = readFailure(rec);
  const decision = safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord);
  const operatorDecisionRaw = operator
    ? { action: operator.action, decidedAt: operator.decidedAt }
    : null;
  // RunDetail perf (D15): parse events.jsonl ONCE per detail request and thread
  // the snapshot through every event-consuming projection (timeline, budget
  // fallback, plan progress) — before this each field re-parsed the whole log.
  const { events, integrity } = rec.runDir
    ? readRunEventsWithIntegrity(rec)
    : { events: [] as Record<string, unknown>[], integrity: undefined };
  const summary = summarizeRun(rec, events);
  // applyEligibility is non-null exactly when the run has an applyable patch —
  // the authoritative "something to apply" banner signal (a convergence patch
  // may carry kind:patch with no meta.result_kind, so result.kind alone would
  // miss it).
  const { runFacts, outcomeFacts, applyEligibility, requiredActions } = projectRunFactsForDetail(
    rec.runDir,
    summary.outcomeFacts ?? null,
    operator !== null,
    () => applyEligibilityFor(rec, operator),
    expectedRunFacts(rec),
  );
  const planProjection = planProjectionFor(rec, summary.mode);
  const telemetry = safeReadStructuredArtifact(rec, "final/telemetry.yaml", RunTelemetry);
  return ControlRunDetail.parse({
    attemptExecution: telemetry?.attempts.map((attempt) => ({
      attemptId: attempt.attempt_id,
      harnessId: attempt.harness_id,
      processing: attempt.processing,
      processingCostBasis: attempt.processing_cost_basis,
      usageCost: attempt.usage_cost,
    })),
    summary: {
      ...summary,
      outcomeFacts,
      waitingOnUser: pendingInteractions.length > 0,
    },
    children,
    runFacts,
    // Server-owned outcome headline (D18), from the single projection owner —
    // surfaces render it verbatim above model prose, never re-derive it.
    outcomeBanner: outcomeBanner(outcomeFacts, {
      applyState: summary.result.applyState,
      hasApplyableChange: applyEligibility !== null,
    }),
    lastSeq,
    artifacts: rec.runDir ? listArtifacts(rec.runDir) : [],
    primaryOutput: primaryOutput(rec, summary.mode, failure, runFacts),
    timeline: timelineEvents(rec, events, integrity),
    budget: budgetSnapshot(rec, decision, events, integrity),
    finalSummary: boundedArtifactText(rec, "final/summary.md"),
    decision,
    operatorDecision: operatorDecisionRaw,
    workProduct: safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct),
    // Derived apply-gate verdict (single producer: delivery's
    // deriveApplyEligibility) — null when the run has no patch artifact.
    planReadiness: planProjection.readiness,
    planQuestions: planProjection.questions,
    council: councilFor(rec, summary.mode),
    applyEligibility,
    reviewFindings: readReviewFindings(rec),
    pendingInteractions,
    // Per-candidate evidence cards: projected from the run's attempt/
    // review artifacts; empty for single-envelope modes.
    candidates: rec.runDir ? candidatesFor(rec.runDir, decision) : [],
    // Live plan checklist: the winner's (else last) plan.progress items.
    planProgress: latestPlanProgress(rec, decision?.winner ?? null, events, integrity),
    failure,
    // Minimal typed required-actions (GH #29) for a succeeded-but-blocked run,
    // from the single status-projection owner: review-blocked / checks-failed /
    // needs-decision / work_state needs_input, keyed to the same validated
    // operator decision the needs-decision + apply gates consult — the
    // canonical terminal actions plus legitimate post-terminal overlays.
    requiredActions,
  });
}

function parseAccessMaybe(value: unknown): AccessProfile | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = AccessProfile.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Typed severity per event type — no string matching over event names. */
function budgetSnapshot(
  rec: DaemonRunRecord,
  decision: DecisionRecord | null,
  eventsSnapshot?: Record<string, unknown>[],
  integrity?: RunEventsIntegrity,
): ControlBudgetSnapshot {
  const p = paramsRecord(rec);
  // The ENGINE-EFFECTIVE cap lives in the immutable contract (request input,
  // surface default, or the configured global per-run default); request params
  // alone under-report a config-defaulted cap as "no cap".
  const contractBudget = safeReadStructuredArtifact(rec, "context/task.yaml", TaskContract)?.budget
    .paid_budget;
  const paidBudget = PaidBudget.safeParse(p["paidBudget"]).data ??
    contractBudget ?? { kind: "unlimited" as const };
  const evs = eventsSnapshot ?? readRunEvents(rec);
  let spendUsd = decision?.budget_summary?.spend_usd ?? null;
  let estimated = decision?.budget_summary?.estimated ?? false;
  let source: "decision" | "events" | "settings" | "unknown" =
    spendUsd === null ? "unknown" : "decision";
  // Subscription VALUATION (QA-023c/QA-017b) beside cash — computed by the pure
  // event fold so an UNKNOWN valuation stays null, never a fabricated $0.
  const normalized = normalizeLegacyBudgetComponents(
    decision?.budget_summary ?? null,
    evs,
    budgetValuationFromEvents(evs),
  );
  let { valuationUsd, valuationKnowledge } = normalized;
  estimated = normalized.cashEstimated;
  if (spendUsd === null) {
    // The CASH truth for a decision-less run (plan/ask/explore — they never
    // write a decision record) is the ledger's own `budget.cash` disclosure:
    // cumulative, last-wins, subscription work settles to 0 there (W4.3).
    // budget.observation ticks are vendor VALUATION — for a subscription run
    // they are NON-ZERO while the cash truth is $0.00, so summing them as
    // spend showed valuation under a "real money" label (F4 review lane 1).
    // They remain only as the LEGACY fallback for runs predating budget.cash
    // (every new run settles at least once), disclosed as estimated.
    let lastCash: number | null = null;
    let observationSpend = 0;
    let sawObservation = false;
    let observationEstimated = false;
    let eventSpend = 0;
    let sawCost = false;
    let sawUsage = false;
    for (const ev of evs) {
      const payload = eventPayload(ev);
      if (ev["type"] === "budget.cash") {
        const cash = payload["cash_spend_usd"];
        if (typeof cash === "number" && Number.isFinite(cash)) {
          lastCash = cash;
          estimated = cashEstimatedFromLedgerEvent(payload);
        }
        continue;
      }
      if (ev["type"] === "budget.observation" && payload["kind"] === "spend") {
        const usd = payload["usd"];
        if (typeof usd === "number" && Number.isFinite(usd)) {
          observationSpend += usd;
          sawObservation = true;
        }
        if (payload["estimated"] === true) observationEstimated = true;
        continue;
      }
      if (ev["type"] !== "harness.event") continue;
      const usage = payload["usage"];
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        sawUsage = true;
        const cost = (usage as Record<string, unknown>)["cost_usd"];
        if (typeof cost === "number" && Number.isFinite(cost)) {
          eventSpend += cost;
          sawCost = true;
        }
        if ((usage as Record<string, unknown>)["estimated"] === true) observationEstimated = true;
      }
    }
    if (lastCash !== null) {
      spendUsd = lastCash;
      source = "events";
    } else if (sawObservation) {
      spendUsd = observationSpend;
      source = "events";
      estimated = true; // valuation-derived: at best an estimate of cash
    } else if (sawCost) {
      spendUsd = eventSpend;
      source = "events";
      estimated = true;
    } else if (sawUsage) {
      source = "events";
    }
    if (observationEstimated && lastCash === null) estimated = true;
  }
  const cashKnowledge = cashKnowledgeFromEvents(evs);
  if (cashKnowledge === "unknown") spendUsd = null;
  if (cashKnowledge !== undefined) estimated = cashKnowledge !== "exact";
  const remainingUsd =
    paidBudget.kind === "finite" && spendUsd !== null
      ? Math.max(0, paidBudget.maxUsd - spendUsd)
      : null;
  // Disclose when the spend fallback read incomplete/unreadable canonical
  // events (QA-074): a partial event set can silently drop a spend tick, so the
  // projected spend must never present as clean when its evidence was not.
  const evidence = integrity ? evidenceLevel(integrity) : "complete";
  return ControlBudgetSnapshot.parse({
    cashKnowledge,
    paidBudget,
    spendUsd,
    valuationUsd,
    valuationKnowledge,
    remainingUsd,
    estimated,
    source,
    evidence,
  });
}

function readPatch(rec: DaemonRunRecord): string | null {
  return readRawTextArtifact(rec, "final/patch.diff");
}

function runRepoRoot(rec: DaemonRunRecord): string | null {
  const p = paramsRecord(rec);
  const scope = p["scope"];
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    const s = scope as Record<string, unknown>;
    if (s["kind"] === "project" && typeof s["root"] === "string") return s["root"];
    if (s["kind"] === "none") return NO_PROJECT_ROOT;
  }
  let task: unknown = null;
  try {
    task = readStructured(readRawTextArtifact(rec, "context/task.yaml"), ".yaml", {
      parse: (value: unknown) => value,
    });
  } catch {
    task = null;
  }
  if (task && typeof task === "object" && !Array.isArray(task)) {
    const repo = (task as Record<string, unknown>)["repo"];
    if (repo && typeof repo === "object" && !Array.isArray(repo)) {
      const root = (repo as Record<string, unknown>)["root"];
      if (typeof root === "string") return root;
    }
  }
  return null;
}

function applyTargetRoot(
  target: ControlApplyCheckRequest["target"] | ControlApplyRequest["target"],
  rec: DaemonRunRecord,
): string | null {
  if (target.kind === "project") return target.root;
  return runRepoRoot(rec);
}

/** Project the run record into the delivery package's single-owner apply gate. */
function applyGateError(
  rec: DaemonRunRecord,
  patch: string,
  targetRepoRoot: string,
  operatorDecision: ControlOperatorDecisionRecord | null,
  finalVerify?: FinalVerifyRecord,
): string | null {
  return validateApplyGate({
    ...applyGateInputFor(rec, patch, targetRepoRoot, operatorDecision),
    ...(finalVerify ? { finalVerify } : {}),
  });
}

function applyGateInputFor(
  rec: DaemonRunRecord,
  patch: string,
  targetRepoRoot: string,
  operatorDecision: ControlOperatorDecisionRecord | null,
): ApplyGateInput {
  const files = readFilesWorkProduct(rec);
  const decision = safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord);
  const terminal = effectiveTerminalFacts(
    rec.runDir,
    decision?.facts ?? null,
    decision,
    expectedRunFacts(rec),
  );
  return {
    state: rec.state,
    decision: terminal.decision,
    workProduct: safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct),
    patch,
    ...(files ? { filesManifest: files.manifest, manifestSha256: files.manifestSha256 } : {}),
    originalRepoRoot: runRepoRoot(rec),
    targetRepoRoot,
    operatorDecision: operatorDecision
      ? {
          action: operatorDecision.action,
          ...(files
            ? { manifest_sha256: operatorDecision.patchSha256 }
            : { patch_sha256: operatorDecision.patchSha256 }),
        }
      : null,
    // Effective mutable delivery/apply state from the SAME owner that projects
    // summary.result.applyState (delivery_state overlay → work_product snapshot):
    // an already-applied / reverted run gets a terminal eligibility disposition
    // instead of a stale "rerun a fresh check" (QA-021).
    applyState: controlRunResult(rec).applyState,
    // D-16 work_state veto (INV-116): thread the model-attested work outcome
    // (the canonical terminal facts) so the gate refuses a needs_input/
    // incomplete winner even with a clean legacy review.
    workState: terminal.outcomeFacts?.work_state ?? null,
  };
}

/**
 * The GET /runs/:id projection of the apply gate: null when the run has no
 * patch artifact (nothing to apply); otherwise the derived verdict against
 * the run's own original project root.
 */

/** Readiness AND open questions of a plan run, from ONE read of the same
 * final/questions.json artifact (D17) — no plan-text re-parse, no double read. */
function planProjectionFor(rec: DaemonRunRecord, mode: string | null | undefined) {
  const empty = { readiness: null, questions: [] };
  if (mode !== "plan" || !rec.runDir) return empty;
  const a = safeReadStructuredArtifact(rec, "final/questions.json", PlanQuestionsArtifact);
  return a ? { readiness: derivePlanReadiness(a), questions: a.questions } : empty;
}

/** Council membership + merge disclosure (INV-031), projected from
 * `council/membership.yaml`. Null for solo plans and non-plan runs — the plan
 * artifacts themselves are shape-identical, so this is purely additive. */
function councilFor(
  rec: DaemonRunRecord,
  mode: string | null | undefined,
): CouncilProjection | null {
  if (mode !== "plan" || !rec.runDir) return null;
  return safeReadStructuredArtifact(rec, "council/membership.yaml", CouncilProjection);
}

function applyEligibilityFor(
  rec: DaemonRunRecord,
  operatorDecision: ControlOperatorDecisionRecord | null,
): ApplyEligibility | null {
  const patch = readPatch(rec);
  const files = readFilesWorkProduct(rec);
  if (!files && (patch === null || patch.trim() === "")) return null;
  const root = runRepoRoot(rec);
  if (!root) return null;
  return deriveApplyEligibility(applyGateInputFor(rec, patch ?? "", root, operatorDecision));
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

function gateSpecsForRun(
  rec: DaemonRunRecord,
): NonNullable<Parameters<typeof verifyAndDeliver>[3]> {
  let raw: string | null = null;
  try {
    raw = readRawTextArtifact(rec, "context/task.yaml");
  } catch {
    // The shared parser maps unreadable authority to the same typed refusal.
  }
  return requiredGateSpecsFromTaskArtifact(raw);
}

function readReviewFindings(rec: DaemonRunRecord): ReviewFinding[] {
  if (!rec.runDir) return [];
  let names: string[];
  try {
    const reviewsDir = safeArtifactPath(rec.runDir, "reviews");
    if (!reviewsDir || !lstatSync(reviewsDir).isDirectory()) return [];
    names = readdirSync(reviewsDir).sort();
  } catch (err) {
    // reviews/ vanished between resolve and read (GH #128 race class): no
    // findings, never a 500. Non-vanish errnos stay loud.
    if (isVanishedErrno(err)) return [];
    throw err;
  }
  const out: ReviewFinding[] = [];
  for (const name of names) {
    const ext = extname(name);
    if (ext !== ".yaml" && ext !== ".yml" && ext !== ".json") continue;
    try {
      const rel = `reviews/${name}`;
      const raw = readTextArtifact(rec, rel);
      if (!raw) continue;
      const doc = ext === ".json" ? JSON.parse(raw) : parseYaml(raw);
      const findings =
        doc && typeof doc === "object" && !Array.isArray(doc)
          ? (doc as Record<string, unknown>)["findings"]
          : [];
      if (!Array.isArray(findings)) continue;
      for (const finding of findings) out.push(ReviewFinding.parse(finding));
    } catch {
      /* malformed review artifact: omit from UI projection, artifact remains fetchable for diagnostics */
    }
  }
  return out;
}

function redactPrompt(prompt: string): string {
  const redacted = redactSecrets(prompt);
  return redacted.length > 240 ? `${redacted.slice(0, 240)}...` : redacted;
}
