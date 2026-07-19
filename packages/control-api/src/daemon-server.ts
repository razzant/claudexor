import { timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
import { safeArtifactPath, safeArtifactRoot } from "./artifact-paths.js";
import { TERMINAL_STATES } from "./sse-shared.js";
import { streamRunEvents } from "./run-events-stream.js";
import { boundedArtifactText, outputReadyState, primaryOutput } from "./primary-output.js";
import {
  controlWebEvidence,
  eventPayload,
  latestPlanProgress,
  readRunEvents,
  timelineEvents,
} from "./run-timeline.js";
import { projectSession, projectThread, projectTurn, turnRunCard } from "./thread-projection.js";
import {
  chainThreadMutation,
  handleThreadTurnCreate,
  handleThreadTurnRetry,
  type ThreadTurnRouteCtx,
} from "./thread-turn-routes.js";
import { assertThreadIdle, threadIdOfRun } from "./thread-mutation.js";
import {
  handleThreadLifecycleRoutes,
  type ThreadLifecycleRouteCtx,
} from "./thread-lifecycle-routes.js";
import * as runStart from "./run-start.js";
import { handleRunRetryRoute } from "./run-retry-routes.js";
import {
  handleRunApplyRoutes,
  runIdempotentDelivery,
  type DeliveryCommandServices,
  type RunApplyRouteContext,
} from "./run-apply-routes.js";
import { rerunWithFeedback } from "./decision-rerun.js";
export { normalizeRunStartRequest } from "./run-start.js";
import { candidatesFor } from "./candidates.js";
import { handleProjectRoute } from "./project-routes.js";
import { handleRecoveryRoute } from "./recovery-routes.js";
import { handleJournalEventRoute } from "./journal-event-routes.js";
import { handleMaintenanceRoute, type MaintenanceRouteServices } from "./maintenance-routes.js";
import { handleResourceRoute, type ResourceRouteServices } from "./resource-routes.js";
import { handleArtifactServeRoute, listArtifacts } from "./artifact-serve-routes.js";
import { requiredGateSpecsFromTaskArtifact } from "./task-contract-gates.js";
import { assertOnlyQueryParams, optionalBooleanQuery } from "./query.js";
import { controlProblemError } from "./problem-response.js";
import { handleSecurityRoute } from "./security-routes.js";
import { handleSpecRoute, type SpecRouteServices } from "./spec-routes.js";
import {
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
  ControlHarnessModelsResponse,
  ControlSetupJob,
  ControlSetupJobCreateRequest,
  ControlSetupJobEvent,
  ControlSetupJobSnapshot,
  isTerminalControlSetupJobState,
  ControlSetupJobListFilter,
  ControlSetupJobListResponse,
  ControlRunStartInfo,
  type ControlRunStartRequest,
  ControlQueuedRunInfo,
  ControlRunControlRequest,
  ControlRunControlResponse,
  ControlReviewerPanelEntry,
  ControlRunDetail,
  ControlRunListResponse,
  ControlRunSummary,
  ControlRunResult,
  ControlBudgetSnapshot,
  PaidBudget,
  ControlSettingsSnapshot,
  ControlSettingsUpdateRequest,
  ControlQuotaResponse,
  ControlCredentialProfilesResponse,
  ControlCredentialProfileCreateRequest,
  ControlCredentialProfileCreateResponse,
  ControlCredentialProfileDeleteResponse,
  ControlTrustUpdateRequest,
  ControlInteractionAnswerRequest,
  ControlInteractionAnswerResponse,
  type ControlPendingInteraction,
  type ControlRouteInfo,
  ControlRunDecisionRequest,
  ControlRunDecisionResponse,
  ControlThreadCreateRequest,
  ControlThreadTurnRequest,
  ControlThreadUpdateRequest,
  ControlThreadDetail,
  ControlThreadListResponse,
  ControlTurnRunCard,
  DecisionRecord,
  ModeKind,
  OrchestratePlanProgress,
  RoutingGoal,
  ReviewFinding,
  RunEventType,
  RunFailure,
  RunTelemetry,
  StructuredOutputConformance,
  TaskContract,
  ProtectedPathApproval,
  type FinalVerifyRecord,
  TestCommandInvocation,
  WorkProduct,
} from "@claudexor/schema";
import { resolveControlProtocol } from "./operation-catalog.js";
import {
  assertNoInlineSecretValues,
  containsSecretLikeToken,
  errorCode,
  noProjectRepoRoot,
  nowIso,
  redactSecrets,
  sha256,
} from "@claudexor/util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
export interface DaemonRunRecord {
  id: string;
  state: string;
  runId?: string;
  taskId?: string;
  runDir?: string;
  error?: string;
  /** Machine-readable code of a typed pre-start refusal (e.g. the trust gate's
   * trust_full_access_required) — surfaces key remedies on the CODE and the
   * turn-turn route maps it to a client-actionable 4xx (W24). */
  errorCode?: string;
  /** HTTP status persisted from the typed throw (refusal semantics are born
   * at the throw); the turn route serves it verbatim when 400-599. */
  errorStatus?: number;
  params?: unknown;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ControlOperatorDecisionRecord {
  action: "accept_risk" | "override_needs_human";
  findingIds: string[];
  acceptedRisks: string[];
  patchSha256: string;
  decidedAt: string;
}

export interface DaemonFacadeClient {
  enqueue(
    params: unknown,
    options?: {
      idempotencyKey?: string;
      clientId?: string;
      idempotencyRequest?: unknown;
      operation?: string;
    },
  ): Promise<{ id: string; state: string }>;
  findAccepted?(
    params: unknown,
    options: { idempotencyKey: string; clientId?: string; operation?: string },
  ): Promise<DaemonRunRecord | null>;
  status(id: string): Promise<DaemonRunRecord>;
  list(): Promise<DaemonRunRecord[]>;
  cancel(id: string): Promise<unknown>;
}

export interface DaemonControlApiOptions {
  token: string;
  daemon: DaemonFacadeClient;
  host?: string;
  port?: number;
  pollMs?: number;
  heartbeatMs?: number;
  runStartTimeoutMs?: number;
  bus?: { subscribe(listener: (event: { run_id: string }) => void): () => void };
  services?: DeliveryCommandServices &
    Partial<ResourceRouteServices> &
    Partial<MaintenanceRouteServices> & {
      listProjects?: () => Promise<{ projects: unknown[] }>;
      registerProject?: (input: {
        root: string;
        idempotencyKey: string;
        clientId: string;
      }) => Promise<unknown>;
      relinkProject?: (id: string, root: string) => Promise<unknown>;
      harnesses?: (input?: {
        fresh?: boolean;
        includeFakes?: boolean;
        harnessIds?: string[];
      }) => Promise<unknown>;
      agentCapabilities?: () => Promise<unknown>;
      preflightRunRequirements?: (request: ControlRunStartRequest) => Promise<void>;
      harnessModels?: (input: {
        harnessId: string;
        route?: "local_session" | "api_key";
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
      refreshQuota?: () => Promise<unknown>;
      credentialProfiles?: () => Promise<unknown>;
      createCredentialProfile?: (input: unknown) => Promise<unknown>;
      deleteCredentialProfile?: (input: unknown) => Promise<unknown>;
      listSecrets?: () => Promise<unknown>;
      setSecret?: (input: unknown) => Promise<unknown>;
      deleteSecret?: (name: string) => Promise<unknown>;
      createSpecSession?: SpecRouteServices["createSpecSession"];
      listSpecSessions?: SpecRouteServices["listSpecSessions"];
      getSpecSession?: SpecRouteServices["getSpecSession"];
      answerSpecSession?: SpecRouteServices["answerSpecSession"];
      freezeSpecSession?: SpecRouteServices["freezeSpecSession"];
      cancelSpecSession?: SpecRouteServices["cancelSpecSession"];
      resumeSpecSession?: SpecRouteServices["resumeSpecSession"];
      pendingInteractions?: (runId: string) => ControlPendingInteraction[];
      answerInteraction?: (
        runId: string,
        interactionId: string,
        answers: unknown,
      ) => { status: string; message?: string };
      operatorDecision?: (runId: string, params: unknown) => ControlOperatorDecisionRecord | null;
      recordOperatorDecision?: (
        runId: string,
        params: unknown,
        decision: ControlOperatorDecisionRecord,
        idempotency?: { key: string; client: string; request: unknown },
      ) => ControlOperatorDecisionRecord;
      createThread?: (input: unknown) => Promise<unknown>;
      listThreads?: () => Promise<{ threads: unknown[] }>;
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
          attachments?: ResourceAttachmentRef[];
          idempotency?: { key: string; client: string; request: unknown };
        },
      ) => Promise<unknown>;
      updateThread?: (
        id: string,
        patch: {
          title?: string;
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
        message: string,
        code: string | null,
        retryable?: boolean,
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

function finiteHttpStatus(error: unknown, fallback: number): number {
  if (!error || typeof error !== "object" || !("status" in error)) return fallback;
  const value = Number((error as { status: unknown }).status);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : fallback;
}

function stringArrayProperty(error: unknown, key: "requiredActions" | "evidenceRefs"): string[] {
  if (!error || typeof error !== "object" || !(key in error)) return [];
  const value = (error as Record<string, unknown>)[key];
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
        ? ((error as { context: Record<string, unknown> }).context ?? {})
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
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    return this.tokenMatches(m?.[1]?.trim());
  }

  private requestError(res: ServerResponse, err: unknown): void {
    this.problem(res, finiteHttpStatus(err, 400), err, "invalid_request", false, "bad request");
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

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 10 * 1024 * 1024)
        throw Object.assign(new Error("request body too large"), { status: 413 });
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error("invalid JSON body"), { status: 400 });
    }
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    let tracked: Promise<void>;
    tracked = this.handle(req, res)
      .catch((err) => {
        try {
          if (!res.headersSent) {
            this.problem(
              res,
              finiteHttpStatus(err, 500),
              err,
              "internal_error",
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
      });
    } catch (error) {
      return this.requestError(res, error);
    }
    if (protocol.kind === "response") {
      return this.json(res, protocol.status, protocol.body, protocol.contentType);
    }
    const path = protocol.path;
    if (
      await handleResourceRoute(
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
      await handleMaintenanceRoute(
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
      await handleProjectRoute(
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

    if (method === "POST" && path === "/runs") {
      return runStart.handleRunCreate(
        {
          daemon: this.opts.daemon,
          readBody: (request) => this.readBody(request),
          requestError: (response, error) => this.requestError(response, error),
          json: (response, status, body) => this.json(response, status, body),
          respondToAcceptedJob: (response, jobId) => this.respondToAcceptedJob(response, jobId),
          createThreadTurn: this.opts.services?.createThreadTurn,
          threadDetail: this.opts.services?.threadDetail,
          setTurnEnqueueError: this.opts.services?.setTurnEnqueueError,
          chainThreadMutation: (threadId, work) =>
            chainThreadMutation(this.threadTurnRouteCtx(), threadId, work),
          validateResources: this.opts.services?.validateResources,
          preflightRunRequirements: this.opts.services?.preflightRunRequirements,
        },
        req,
        res,
      );
    }

    if (method === "GET" && path === "/runs") {
      const runs = await this.opts.daemon.list();
      return this.json(
        res,
        200,
        ControlRunListResponse.parse({
          runs: runs.map((r) => this.summarizeRunOrDiagnostic(r)),
        }),
      );
    }

    if (
      await handleRunRetryRoute(
        {
          daemon: this.opts.daemon,
          services: this.opts.services,
          findRun: (id) => this.findRun(id),
          waitForRunStart: (id) => this.waitForRunStart(id),
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
      return this.json(
        res,
        200,
        detailFor(
          rec,
          this.pendingInteractionsFor(rec),
          lastSeq,
          this.validOperatorDecisionFor(rec),
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
          repoRoot = parsed.scope.root.trim();
          const absoluteRepoError = runStart.validateAbsoluteRepoRoot(repoRoot);
          if (absoluteRepoError) throw Object.assign(new Error(absoluteRepoError), { status: 400 });
          if (!existsSync(repoRoot) || !lstatSync(repoRoot).isDirectory()) {
            throw Object.assign(
              new Error(`project root does not exist or is not a directory: ${repoRoot}`),
              { status: 400 },
            );
          }
        }
        const thread = await svc({
          title: parsed.title,
          repoRoot,
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
      const { threads } = await svc();
      const runs = await this.opts.daemon.list();
      const blocked = new Set(
        runs
          .filter((r) => r.state === "blocked" && this.validOperatorDecisionFor(r) === null)
          .map((r) => r.runId ?? r.id),
      );
      return this.json(
        res,
        200,
        ControlThreadListResponse.parse({
          threads: threads.map((t) =>
            projectThread(t, blocked.has((t as { head_run_id?: string | null }).head_run_id ?? "")),
          ),
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
        const cards = new Map<string, ControlTurnRunCard>();
        for (const turn of detail.turns as { run_id?: string | null }[]) {
          const runId = turn.run_id ?? null;
          if (runId && !cards.has(runId)) {
            const rec = byRun.get(runId);
            if (rec) cards.set(runId, turnRunCard(this.summarizeRunOrDiagnostic(rec)));
          }
        }
        const headRec = byRun.get(thread.head_run_id ?? "");
        const headNeedsHuman =
          headRec?.state === "blocked" && this.validOperatorDecisionFor(headRec) === null;
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
        const decisionBody = body;
        const decisionAction: "accept_risk" | "override_needs_human" = body.action;
        try {
          return await this.chainRunMutation(rec, async () => {
            // The override unblocks a BLOCKED run; recording one elsewhere would claim an
            // apply permission that does not exist.
            if (rec.state !== "blocked") {
              return this.json(res, 409, {
                error:
                  rec.state === "succeeded"
                    ? "run already succeeded; apply it directly (no risk override needed)"
                    : `run is ${rec.state}; risk overrides only unblock blocked runs (use rerun_with_feedback instead)`,
              });
            }
            const patch = readPatch(rec);
            if (patch === null)
              return this.json(res, 409, {
                error: "no patch artifact; there is nothing to unblock for apply",
              });
            const decision = this.recordOperatorDecision(
              rec,
              {
                action: decisionAction,
                findingIds: decisionBody.findingIds,
                acceptedRisks: decisionBody.acceptedRisks,
                patchSha256: sha256(patch),
                decidedAt: nowIso(),
              },
              {
                key: decisionKey,
                client: "control-api",
                request: { runId: rec.runId ?? rec.id, body: decisionBody },
              },
            );
            try {
              writeOperatorDecisionProjection(rec, decision);
              appendRunAuditEvent(rec, "control.applied", {
                decision: decisionAction,
                finding_ids: decisionBody.findingIds,
                accepted_risks: decisionBody.acceptedRisks,
              });
            } catch {
              // Journal authority remains queryable and replayable by Idempotency-Key.
            }
            return this.json(
              res,
              200,
              ControlRunDecisionResponse.parse({
                accepted: true,
                status: "applied",
                message: `${decisionAction} recorded; apply is now permitted for this exact patch`,
              }),
            );
          });
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
                  appendRunAuditEvent(rec, "control.rejected", {
                    decision: "revert_run",
                    reason: revert.reason ?? "revert refused",
                  });
                  throw Object.assign(new Error(revert.reason ?? "revert refused"), {
                    status: 409,
                    code: "revert_refused",
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

      if (body.action === "accept_clean_patch") {
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

      return rerunWithFeedback(
        {
          daemon: this.opts.daemon,
          services: this.opts.services,
          waitForRunStart: (id) => this.waitForRunStart(id),
          appendAudit: (record, payload) => appendRunAuditEvent(record, "control.applied", payload),
          json: (response, status, responseBody) => this.json(response, status, responseBody),
        },
        rec,
        body,
        decisionKey,
        res,
      );
    }

    if (method === "GET" && path === "/harnesses") {
      try {
        assertOnlyQueryParams(url, ["fresh", "all", "harness"]);
        const fresh = optionalBooleanQuery(url, "fresh");
        const includeFakes = optionalBooleanQuery(url, "all");
        const harnessIds = url.searchParams
          .getAll("harness")
          .map((id) => id.trim())
          .filter(Boolean);
        return this.service(
          res,
          "harnesses",
          {
            ...(fresh === undefined ? {} : { fresh }),
            ...(includeFakes === undefined ? {} : { includeFakes }),
            ...(harnessIds.length === 0 ? {} : { harnessIds }),
          },
          ControlHarnessListResponse,
        );
      } catch (err) {
        return this.requestError(res, err);
      }
    }
    if (method === "GET" && path === "/agent-capabilities")
      return this.service(res, "agentCapabilities", undefined, AgentCapabilityCatalog);
    const harnessModelsMatch = /^\/harnesses\/([^/]+)\/models$/.exec(path);
    if (method === "GET" && harnessModelsMatch) {
      try {
        assertOnlyQueryParams(url, ["route"]);
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
          },
          ControlHarnessModelsResponse,
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
      return this.service(
        res,
        "extendSetupJob",
        { jobId: decodeURIComponent(setupJobExtendMatch[1] as string) },
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
    if (
      await handleSpecRoute(
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
    if (method === "POST" && path === "/quota")
      return this.service(res, "refreshQuota", undefined, ControlQuotaResponse);
    if (method === "GET" && path === "/credential-profiles")
      return this.service(res, "credentialProfiles", undefined, ControlCredentialProfilesResponse);
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
    const profileDeleteMatch = /^\/credential-profiles\/([^/]+)\/([^/]+)$/.exec(path);
    if (method === "DELETE" && profileDeleteMatch) {
      return this.service(
        res,
        "deleteCredentialProfile",
        {
          harnessId: decodeURIComponent(profileDeleteMatch[1] as string),
          profileId: decodeURIComponent(profileDeleteMatch[2] as string),
        },
        ControlCredentialProfileDeleteResponse,
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
      await this.opts.daemon.cancel(rec.id);
      appendRunAuditEvent(rec, "control.applied", { control: body.control });
      return this.json(
        res,
        200,
        ControlRunControlResponse.parse({
          accepted: true,
          status: "applied",
          runId: rec.runId ?? rec.id,
          message: `${body.control.kind} requested`,
        }),
      );
    }

    const eventsMatch = /^\/runs\/([^/]+)\/events$/.exec(path);
    if (method === "GET" && eventsMatch) {
      const id = decodeURIComponent(eventsMatch[1] as string);
      const last = this.lastEventId(req, url);
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
        "internal_error",
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
    const status = TERMINAL_STATES.has(rec.state) ? 500 : 202;
    const body = ControlQueuedRunInfo.parse({ jobId: rec.id, state: rec.state, error: rec.error });
    return this.json(res, status, body);
  }

  private async findRun(id: string): Promise<DaemonRunRecord | null> {
    const runs = await this.opts.daemon.list();
    return runs.find((r) => r.id === id || r.runId === id) ?? null;
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

  private recordOperatorDecision(
    rec: DaemonRunRecord,
    decision: ControlOperatorDecisionRecord,
    idempotency?: { key: string; client: string; request: unknown },
  ): ControlOperatorDecisionRecord {
    const record = this.opts.services?.recordOperatorDecision;
    if (!record) {
      throw Object.assign(new Error("operator decisions are not supported by this engine build"), {
        status: 501,
      });
    }
    return record(rec.runId ?? rec.id, rec.params, decision, idempotency);
  }
  private chainRunMutation<T>(rec: DaemonRunRecord, work: () => Promise<T>): Promise<T> {
    const threadId = threadIdOfRun(rec);
    if (!threadId) return work();
    return chainThreadMutation(this.threadTurnRouteCtx(), threadId, async () => {
      await assertThreadIdle(rec, () => this.opts.daemon.list());
      return work();
    });
  }

  private threadTurnRouteCtx(): ThreadTurnRouteCtx {
    const services = this.opts.services ?? {};
    return {
      json: (res, status, body) => this.json(res, status, body),
      waitForRunStart: (jobId) => this.waitForRunStart(jobId),
      readRunArtifactText: (runId, rel) => this.readRunArtifactText(runId, rel),
      normalizeStart: runStart.normalizeRunStart,
      preflightRunRequirements: services.preflightRunRequirements,
      isTerminalState: (state) => TERMINAL_STATES.has(state),
      daemon: this.opts.daemon,
      threadDetail: services.threadDetail as NonNullable<typeof services.threadDetail>,
      createThreadTurn: services.createThreadTurn as NonNullable<typeof services.createThreadTurn>,
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
        applyGateError(record, patch, projectRoot, this.operatorDecisionFor(record)),
      appendAudit: appendRunAuditEvent,
      gateSpecs: gateSpecsForRun,
    };
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
  private summarizeRunCached(rec: DaemonRunRecord): ControlRunSummary {
    const fingerprint = summaryFingerprint(rec);
    const hit = this.summaryCache.get(rec.id);
    if (hit && hit.fingerprint === fingerprint) return hit.summary;
    const summary = summarizeRun(rec);
    if (this.summaryCache.size > 1_000) this.summaryCache.clear(); // bounded; repopulates on the next poll
    this.summaryCache.set(rec.id, { fingerprint, summary });
    return summary;
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
      return ControlRunSummary.parse({
        jobId: rec.id,
        runId: rec.runId ?? rec.id,
        state: "failed",
        error: `unprojectable job record: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private lastEventId(req: IncomingMessage, url: URL): number {
    const rawHeader = req.headers["last-event-id"];
    const headerId = rawHeader !== undefined ? Number(rawHeader) : Number.NaN;
    const rawQuery = url.searchParams.get("lastEventId");
    const queryId = rawQuery !== null ? Number(rawQuery) : Number.NaN;
    return Number.isFinite(headerId) ? headerId : Number.isFinite(queryId) ? queryId : 0;
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

function paramsRecord(rec: DaemonRunRecord): Record<string, unknown> {
  return rec.params && typeof rec.params === "object" && !Array.isArray(rec.params)
    ? (rec.params as Record<string, unknown>)
    : {};
}

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

function summaryFingerprint(rec: DaemonRunRecord): string {
  const mtime = (rel: string): number => {
    if (!rec.runDir) return 0;
    const path = safeArtifactPath(rec.runDir, rel);
    if (!path) return 0;
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  };
  return [
    rec.state,
    paramsFingerprint(rec),
    rec.finishedAt ?? "",
    rec.error ?? "",
    mtime("events.jsonl"),
    mtime("arbitration/decision.yaml"),
    mtime("final/telemetry.yaml"),
    mtime("final/failure.yaml"),
    mtime("final/summary.md"),
    // Primary outputs feed outputReadyState; a summary cached before the
    // answer/plan/report/patch landed must invalidate when it does.
    mtime("final/answer.md"),
    mtime("final/plan.md"),
    mtime("final/explore.md"),
    mtime("final/report.md"),
    mtime("final/patch.diff"),
    // Orchestrate output is the prose plan + the typed plan; a summary cached
    // before they land (or after a revert re-stamps work_product) must invalidate.
    mtime("final/orchestration.md"),
    mtime("final/orchestration.yaml"),
    // Executor progress (auto_safe/auto_full) lands after the plan; a detail
    // cached before steps ran (or as they advance) must invalidate.
    mtime("final/orchestration_progress.yaml"),
    // The honest outcome (result kind / diffstat / adopted / apply_state) is
    // projected from work_product.yaml; a summary cached before it landed (or
    // before a revert flipped apply_state) must invalidate.
    mtime("final/work_product.yaml"),
  ].join("|");
}

function paramsFingerprint(rec: DaemonRunRecord): string {
  try {
    return sha256(JSON.stringify(rec.params ?? null));
  } catch {
    return "unserializable-params";
  }
}

/** v0.9 strategy flags projected back so surfaces can tell a race from a repair loop. */
function strategyFromParams(
  p: Record<string, unknown>,
): "race" | "attempts" | "until_clean" | "swarm" | "create" | null {
  if (p["untilClean"] === true) return "until_clean";
  if (typeof p["attempts"] === "number" && p["attempts"] > 0) return "attempts";
  if (p["create"] === true) return "create";
  if (p["swarm"] === true) return "swarm";
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
function controlRunResult(rec: DaemonRunRecord): ControlRunResult {
  const wp = safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct);
  const meta = (wp?.meta ?? {}) as Record<string, unknown>;
  const kindRaw = meta["result_kind"];
  const kind =
    kindRaw === "patch" || kindRaw === "answer" || kindRaw === "plan" || kindRaw === "report"
      ? kindRaw
      : "none";
  const ds = meta["diffstat"] as
    { files?: unknown; additions?: unknown; deletions?: unknown } | undefined;
  const diffStat =
    ds && typeof ds.files === "number"
      ? {
          files: ds.files,
          additions: typeof ds.additions === "number" ? ds.additions : 0,
          deletions: typeof ds.deletions === "number" ? ds.deletions : 0,
        }
      : null;
  const applyStateRaw = meta["apply_state"];
  const applyState =
    applyStateRaw === "applied" ||
    applyStateRaw === "applied_review_blocked" ||
    applyStateRaw === "reverted"
      ? applyStateRaw
      : "not_applied";
  const preTurnSha = typeof meta["pre_turn_sha"] === "string" ? meta["pre_turn_sha"] : null;
  const postTurnSha = typeof meta["post_turn_sha"] === "string" ? meta["post_turn_sha"] : null;
  const revertAnchorId =
    typeof meta["revert_anchor_id"] === "string" ? meta["revert_anchor_id"] : null;
  const revertable =
    (applyState === "applied" || applyState === "applied_review_blocked") &&
    revertAnchorId !== null;
  return ControlRunResult.parse({
    kind,
    diffStat,
    blockers: typeof meta["blockers"] === "number" ? meta["blockers"] : 0,
    adopted: typeof meta["adopted"] === "boolean" ? meta["adopted"] : null,
    applyState,
    preTurnSha,
    postTurnSha,
    revertAnchorId,
    revertable,
  });
}

/** Flip the persisted work_product apply_state after a successful apply or
 * revert — ONE owner of the durable outcome fact that controlRunResult
 * projects AND retention's hasActionableWorkProduct consumes (round-15 #2: an
 * applied-but-unmarked patch would read as actionable forever and pin the run
 * against GC). Idempotent and best-effort: the delivery/revert already
 * happened; a metadata write failure must not 500 the response. */
function markRunApplyState(rec: DaemonRunRecord, state: "applied" | "reverted"): void {
  try {
    if (!rec.runDir) return;
    const root = safeArtifactRoot(rec.runDir);
    if (!root) return;
    const wpPath = join(root, "final", "work_product.yaml");
    if (!existsSync(wpPath)) return;
    const doc = (parseYaml(readFileSync(wpPath, "utf8")) ?? {}) as Record<string, unknown>;
    const meta = (doc["meta"] && typeof doc["meta"] === "object" ? doc["meta"] : {}) as Record<
      string,
      unknown
    >;
    meta["apply_state"] = state;
    doc["meta"] = meta;
    // Atomic tmp+rename: a crash mid-write must never leave work_product.yaml
    // half-written (it would degrade the run projection to kind: none).
    const tmp = `${wpPath}.tmp-${process.pid}`;
    writeFileSync(tmp, stringifyYaml(doc), "utf8");
    renameSync(tmp, wpPath);
  } catch {
    /* best-effort: the revert succeeded regardless of this metadata flip */
  }
}

function summarizeRun(rec: DaemonRunRecord): ControlRunSummary {
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
  const budget = budgetSnapshot(rec, decision);
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
    taskId: rec.taskId,
    state: rec.state,
    runDir: rec.runDir,
    error: rec.error,
    failure: readFailure(rec),
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
    // The single engine validator's receipt, projected verbatim — surfaces
    // never re-validate the answer (null = no structured-output contract).
    outputConformance: outputConformance?.status ?? null,
    // Route receipt projected verbatim (INV-061 disclosure); never re-derived.
    authRoute: telemetry?.auth_route
      ? {
          requested: telemetry.auth_route.requested,
          effective: telemetry.auth_route.effective,
          source: telemetry.auth_route.source,
          reason: telemetry.auth_route.reason,
          harnessId: telemetry.auth_route.harness_id,
          attemptId: telemetry.auth_route.attempt_id,
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
      readFailure(rec),
    ),
    toolWarningsTotal: telemetry?.tool_warnings_total ?? 0,
    result: controlRunResult(rec),
    route: controlRoute(telemetry, p),
    tests: requestTests ?? (contractTests?.length ? contractTests : undefined),
    specId: typeof p["specId"] === "string" ? p["specId"] : undefined,
    specHash: typeof p["specHash"] === "string" ? p["specHash"] : undefined,
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
  const summary = summarizeRun(rec);
  return ControlRunDetail.parse({
    summary: { ...summary, waitingOnUser: pendingInteractions.length > 0 },
    lastSeq,
    artifacts: rec.runDir ? listArtifacts(rec.runDir) : [],
    primaryOutput: primaryOutput(rec, summary.mode, failure),
    timeline: timelineEvents(rec),
    budget: budgetSnapshot(rec, decision),
    finalSummary: boundedArtifactText(rec, "final/summary.md"),
    decision,
    operatorDecision: operatorDecisionRaw,
    workProduct: safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct),
    // Derived apply-gate verdict (single producer: delivery's
    // deriveApplyEligibility) — null when the run has no patch artifact.
    applyEligibility: applyEligibilityFor(rec, operator),
    reviewFindings: readReviewFindings(rec),
    pendingInteractions,
    // Typed executor progress for an orchestrate auto_safe/auto_full run; null
    // for suggest / non-orchestrate runs. Thin projection of the engine artifact.
    orchestrate: safeReadStructuredArtifact(
      rec,
      "final/orchestration_progress.yaml",
      OrchestratePlanProgress,
    ),
    // Per-candidate evidence cards: projected from the run's attempt/
    // review artifacts; empty for single-envelope modes.
    candidates: rec.runDir ? candidatesFor(rec.runDir, decision) : [],
    // Live plan checklist: the winner's (else last) plan.progress items.
    planProgress: latestPlanProgress(rec, decision?.winner ?? null),
    failure,
  });
}

function readTextArtifact(rec: DaemonRunRecord, relPath: string, redact = true): string | null {
  const text = readRawTextArtifact(rec, relPath);
  return text === null ? null : redact ? redactSecrets(text) : text;
}

function readRawTextArtifact(rec: DaemonRunRecord, relPath: string): string | null {
  if (!rec.runDir) return null;
  const path = safeArtifactPath(rec.runDir, relPath);
  if (!path) return null;
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.isDirectory()) return null;
  return readFileSync(path, "utf8");
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
): ControlBudgetSnapshot {
  const p = paramsRecord(rec);
  // The ENGINE-EFFECTIVE cap lives in the immutable contract (request input,
  // surface default, or the configured global per-run default); request params
  // alone under-report a config-defaulted cap as "no cap".
  const contractBudget = safeReadStructuredArtifact(rec, "context/task.yaml", TaskContract)?.budget
    .paid_budget;
  const paidBudget = PaidBudget.safeParse(p["paidBudget"]).data ??
    contractBudget ?? { kind: "unlimited" as const };
  let spendUsd = decision?.budget_summary?.spend_usd ?? null;
  let estimated = decision?.budget_summary?.estimated ?? false;
  let source: "decision" | "events" | "settings" | "unknown" =
    spendUsd === null ? "unknown" : "decision";
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
    for (const ev of readRunEvents(rec)) {
      const payload = eventPayload(ev);
      if (ev["type"] === "budget.cash") {
        const cash = payload["cash_spend_usd"];
        if (typeof cash === "number" && Number.isFinite(cash)) lastCash = cash;
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
  const remainingUsd =
    paidBudget.kind === "finite" && spendUsd !== null
      ? Math.max(0, paidBudget.maxUsd - spendUsd)
      : null;
  return ControlBudgetSnapshot.parse({ paidBudget, spendUsd, remainingUsd, estimated, source });
}

function readStructured<T>(
  text: string | null,
  ext: string,
  schema: { parse(value: unknown): T },
): T | null {
  if (text === null) return null;
  if (ext === ".json") {
    return schema.parse(JSON.parse(text));
  }
  if (ext === ".yaml" || ext === ".yml") {
    return schema.parse(parseYaml(text));
  }
  throw new Error(`unsupported structured artifact extension: ${ext}`);
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
  return {
    state: rec.state,
    decision: safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord),
    workProduct: safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct),
    patch,
    originalRepoRoot: runRepoRoot(rec),
    targetRepoRoot,
    operatorDecision: operatorDecision
      ? { action: operatorDecision.action, patch_sha256: operatorDecision.patchSha256 }
      : null,
  };
}

/**
 * The GET /runs/:id projection of the apply gate: null when the run has no
 * patch artifact (nothing to apply); otherwise the derived verdict against
 * the run's own original project root.
 */
function applyEligibilityFor(
  rec: DaemonRunRecord,
  operatorDecision: ControlOperatorDecisionRecord | null,
): ApplyEligibility | null {
  const patch = readPatch(rec);
  if (patch === null || patch.trim() === "") return null;
  const root = runRepoRoot(rec);
  if (!root) return null;
  return deriveApplyEligibility(applyGateInputFor(rec, patch, root, operatorDecision));
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

function safeReadStructuredArtifact<T>(
  rec: DaemonRunRecord,
  relPath: string,
  schema: { parse(value: unknown): T },
): T | null {
  try {
    return readStructured(readTextArtifact(rec, relPath), extname(relPath), schema);
  } catch {
    return null;
  }
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
  const reviewsDir = safeArtifactPath(rec.runDir, "reviews");
  if (!reviewsDir || !lstatSync(reviewsDir).isDirectory()) return [];
  const out: ReviewFinding[] = [];
  for (const name of readdirSync(reviewsDir).sort()) {
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
