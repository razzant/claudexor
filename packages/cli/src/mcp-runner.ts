import {
  ControlProblem,
  ControlThread,
  ControlThreadTurnResponse,
  isTerminalLifecycle,
  ModeKind,
  RunExecution,
  type ProcessingPreference,
  normalizeCancelReasonCode,
  type RunOutcomeFacts,
} from "@claudexor/schema";
import {
  connectDaemonIfRunning,
  daemonOutcomeSummary,
  ensureDaemon,
  enqueueAndAwait,
  fetchRunDetail,
} from "./daemon-run.js";
import {
  describeRunDetailProblem,
  presentRunPrimaryOutput,
  projectRunFailure,
  projectRunPrimaryOutput,
} from "./run-detail-projections.js";
import { primaryOutputForCli } from "./primary-output.js";
import { controlProblemError } from "./cli-error.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";
import { absentDaemonRecovery, BELT_DAEMON_LOST } from "./mcp-daemon-unavailable.js";
import {
  isRecoverableRunDetailIntegrityProblem,
  projectDegradedRecoveryRunDetail,
  projectImmediateRunDetail,
  projectRecoveryRunDetail,
} from "./mcp-run-projections.js";
import { readRunDetailResponse } from "./run-detail-response.js";
import { catalogQuery } from "./mcp-catalog-query.js";

export interface SurfaceRunnerHooks {
  onEvent?: (event: any) => void;
  onInteraction?: (ctx: any) => Promise<any | null>;
  signal?: AbortSignal;
}

export interface McpSurfaceRunnerOptions {
  /** Bind belt subprocesses to their existing parent daemon. */
  requireExistingDaemon?: boolean;
  /** Belt-only lineage bound by the bridge from its injected environment.
   * Raw tool arguments can never switch the generic MCP runner into this path. */
  delegationParentRunId?: string | null;
  /** Original project root from the engine descriptor, never from child arguments. */
  delegationRepoRoot?: string | null;
  delegationProcessingPreference?: ProcessingPreference;
  delegationExecution?: Pick<RunExecution, "workspaceKind" | "scopePaths">;
  /** ACP-aware bridges inject this; the packaged belt does not initialize ACP. */
  acpSessionQuery?: (
    input: any,
    hooks: SurfaceRunnerHooks | undefined,
    bridges: {
      cancel: typeof makeCancelBridge;
      interactions: typeof makeInteractionBridge;
    },
  ) => Promise<unknown>;
}

/**
 * Shared MCP/ACP runner. All product modes cross the daemon's /v2 boundary;
 * interactive questions bridge through pendingInteractions and typed answers.
 */
export function mcpSurfaceRunner(options: McpSurfaceRunnerOptions = {}) {
  return async (p: any, hooks?: SurfaceRunnerHooks) => {
    if (p?.mode === "__status" || p?.mode === "__capabilities" || p?.mode === "__accounts") {
      return catalogQuery(p.mode, options.requireExistingDaemon === true, {
        fresh: p?.fresh === true,
      });
    }
    if (
      p?.mode === "__runs_list" ||
      p?.mode === "__run_inspect" ||
      p?.mode === "__run_status" ||
      p?.mode === "__run_result" ||
      p?.mode === "__run_cancel" ||
      p?.mode === "__run_interactions" ||
      p?.mode === "__run_answer" ||
      p?.mode === "__apply_check"
    ) {
      return recoveryQuery(
        p.mode,
        typeof p?.runId === "string" ? p.runId : "",
        options.delegationParentRunId
          ? { ...p, delegatedFromRunId: options.delegationParentRunId }
          : p,
        {
          beltContext: options.requireExistingDaemon === true,
        },
      );
    }
    if (p?.mode === "__journal_recovery") return journalRecoveryQuery(p);
    if (p?.mode === "__thread_create" || p?.mode === "__thread_turn") {
      return threadQuery(p, options.requireExistingDaemon === true);
    }
    if (typeof p?.mode === "string" && p.mode.startsWith("__acp_session_")) {
      if (!options.acpSessionQuery) {
        throw new Error("ACP session operation reached a non-ACP surface");
      }
      return options.acpSessionQuery(p, hooks, {
        cancel: makeCancelBridge,
        interactions: makeInteractionBridge,
      });
    }
    const mode = ModeKind.parse(p?.mode ?? "agent");
    const connection = options.requireExistingDaemon
      ? await connectDaemonIfRunning()
      : await ensureDaemon();
    if (!connection) throw new Error(BELT_DAEMON_LOST);
    const { client, addr } = connection;
    const repoRoot =
      options.delegationRepoRoot ??
      (typeof p?.repoPath === "string" && p.repoPath.trim() ? p.repoPath : process.cwd());
    const processingPreference = options.delegationParentRunId
      ? options.delegationProcessingPreference
      : p?.processingPreference;
    const body: Record<string, unknown> = {
      prompt: String(p?.prompt ?? ""),
      mode,
      scope: { kind: "project", root: repoRoot },
      execution: options.delegationParentRunId
        ? { ...options.delegationExecution, isolation: "envelope" }
        : RunExecution.parse(p?.execution ?? { isolation: "envelope" }),
      ...(p?.harness ? { harnesses: [String(p.harness)] } : {}),
      ...(p?.primaryHarness ? { primaryHarness: String(p.primaryHarness) } : {}),
      ...(p?.race === true
        ? { n: typeof p?.n === "number" ? p.n : 2 }
        : typeof p?.n === "number"
          ? { n: p.n }
          : {}),
      ...(p?.create === true ? { create: true } : {}),
      ...(p?.deepScan === true ? { deepScan: true } : {}),
      ...(p?.council === true ? { council: true } : {}),
      ...(Array.isArray(p?.tests) ? { tests: p.tests } : {}),
      ...(p?.paidBudget ? { paidBudget: p.paidBudget } : {}),
      ...(p?.credentialProfileId ? { credentialProfileId: String(p.credentialProfileId) } : {}),
      ...(p?.access ? { access: String(p.access) } : {}),
      // `externalContextPolicy` is the control-api-parity alias of `web`; the
      // validator already enforced equality when both are present. Honor the
      // alias alone too — dropping it would silently run the daemon default.
      ...(p?.web
        ? { web: String(p.web) }
        : p?.externalContextPolicy
          ? { web: String(p.externalContextPolicy) }
          : {}),
      ...(p?.model ? { model: String(p.model) } : {}),
      ...(p?.effort ? { effort: String(p.effort) } : {}),
      ...(processingPreference !== undefined ? { processingPreference } : {}),
      ...(typeof p?.review === "boolean" ? { review: p.review } : {}),
      ...(Array.isArray(p?.reviewerPanel) ? { reviewerPanel: p.reviewerPanel } : {}),
      ...(p?.reviewerModels && typeof p.reviewerModels === "object"
        ? { reviewerModels: p.reviewerModels }
        : {}),
      ...(p?.reviewerEfforts && typeof p.reviewerEfforts === "object"
        ? { reviewerEfforts: p.reviewerEfforts }
        : {}),
      ...(Array.isArray(p?.protectedPathApprovals)
        ? { protectedPathApprovals: p.protectedPathApprovals }
        : {}),
      ...(options.delegationParentRunId
        ? {
            parentRunId: options.delegationParentRunId,
            delegatedFromRunId: options.delegationParentRunId,
          }
        : {}),
    };
    const interactionBridge = hooks?.onInteraction
      ? makeInteractionBridge(addr, hooks.onInteraction)
      : undefined;
    // Host cancellation (MCP notifications/cancelled -> ctx signal) becomes
    // the same TYPED daemon cancel the CLI's Ctrl-C path posts; the wait loop
    // then resolves with the honest cancelled terminal.
    const cancelBridge = hooks?.signal ? makeCancelBridge(addr, hooks.signal) : undefined;
    const onPollTick =
      interactionBridge || cancelBridge
        ? async (info: { runId: string }) => {
            cancelBridge?.(info);
            await interactionBridge?.(info);
          }
        : undefined;
    const out = await enqueueAndAwait(client, addr, body, {
      waitForTerminal: p?.deferred !== true,
      ...(options.delegationParentRunId ? { internalDaemonEnqueue: true } : {}),
      ...(onPollTick ? { onPollTick } : {}),
    });
    try {
      let detail: Record<string, unknown> | null = null;
      let canonicalPrimary: ReturnType<typeof projectRunPrimaryOutput> = null;
      let detailProjection = projectImmediateRunDetail(null, { runId: out.runId });
      let detailProblem: ReturnType<typeof describeRunDetailProblem> | null = null;
      if (p?.deferred !== true || isTerminalLifecycle(out.status)) {
        try {
          detail = await fetchRunDetail(addr, out.runId);
          detailProjection = projectImmediateRunDetail(detail, {
            runId: out.runId,
            ...(isTerminalLifecycle(out.status)
              ? { lifecycle: out.status as RunOutcomeFacts["lifecycle"] }
              : {}),
          });
          canonicalPrimary = projectRunPrimaryOutput(detail);
        } catch (error) {
          detail = null;
          detailProblem = describeRunDetailProblem(error);
          detailProjection = projectImmediateRunDetail(null, { runId: out.runId });
        }
      }
      // Local artifacts remain only the established soft-absence fallback.
      const localFallback =
        (p?.deferred !== true || isTerminalLifecycle(out.status)) &&
        !detail &&
        !detailProblem &&
        out.runDir
          ? primaryOutputForCli(out.runDir, mode, {
              failure: projectRunFailure(detail),
              lifecycle: isTerminalLifecycle(out.status)
                ? (out.status as RunOutcomeFacts["lifecycle"])
                : undefined,
            })
          : null;
      const primary = canonicalPrimary ?? localFallback;
      const presented = presentRunPrimaryOutput(primary);
      const reason = daemonOutcomeSummary({
        ...out,
        outcomeFacts: detailProjection.outcomeFacts ?? undefined,
      });
      const summary =
        presented ??
        detailProjection.outcomeBanner ??
        reason ??
        (primary?.kind === "patch" ? "patch produced (see artifacts)" : `run ${out.status}`);
      return {
        runId: out.runId,
        runDir: out.runDir,
        status: out.status,
        summary,
        ...detailProjection,
        ...(detailProblem ? { detailProblem } : {}),
      };
    } catch (error) {
      // The run's terminal is already durable at this point: mark the throw so
      // the delegation belt keeps the child's slot consumed and reconciles its
      // spend fail-closed instead of treating the child as never-started.
      if (error && typeof error === "object") {
        Object.assign(error, {
          delegationChildTerminal: { runId: out.runId, status: out.status },
        });
      }
      throw error;
    }
  };
}

async function threadQuery(
  input: Record<string, unknown>,
  requireExistingDaemon: boolean,
): Promise<Record<string, unknown>> {
  const connection = requireExistingDaemon ? await connectDaemonIfRunning() : await ensureDaemon();
  if (!connection) throw new Error(BELT_DAEMON_LOST);
  const creating = input["mode"] === "__thread_create";
  const threadId = typeof input["threadId"] === "string" ? input["threadId"] : "";
  const path = creating ? "/threads" : `/threads/${encodeURIComponent(threadId)}/turns`;
  const body: Record<string, unknown> = creating
    ? {
        ...(input["title"] ? { title: input["title"] } : {}),
        scope: { kind: "project", root: String(input["repoPath"] ?? process.cwd()) },
        ...(input["defaultMode"] ? { mode: input["defaultMode"] } : {}),
        ...(input["workspace"] ? { workspace: input["workspace"] } : {}),
        ...(input["credentialProfileId"]
          ? { credentialProfileId: input["credentialProfileId"] }
          : {}),
        ...(input["primaryHarness"] ? { primaryHarness: input["primaryHarness"] } : {}),
        ...(input["eligibleHarnesses"] ? { eligibleHarnesses: input["eligibleHarnesses"] } : {}),
        ...(input["access"] ? { access: input["access"] } : {}),
      }
    : {
        prompt: String(input["prompt"] ?? ""),
        ...(input["runMode"] ? { mode: input["runMode"] } : {}),
        ...(input["harness"] ? { harnesses: [input["harness"]] } : {}),
        ...(input["primaryHarness"] ? { primaryHarness: input["primaryHarness"] } : {}),
        ...(input["model"] ? { model: input["model"] } : {}),
        ...(input["effort"] ? { effort: input["effort"] } : {}),
        ...(input["credentialProfileId"]
          ? { credentialProfileId: input["credentialProfileId"] }
          : {}),
        ...(input["access"] ? { access: input["access"] } : {}),
        ...(input["web"] ? { web: input["web"] } : {}),
        ...(input["maxSeconds"] ? { maxSeconds: input["maxSeconds"] } : {}),
      };
  const response = await controlApiFetch(connection.addr, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw controlProblemError(
      response.status,
      result,
      `thread ${creating ? "create" : "turn"} failed (HTTP ${response.status})`,
    );
  }
  if (creating) {
    const parsed = ControlThread.safeParse(result);
    if (!parsed.success) {
      throw controlProblemError(
        502,
        { code: "invalid_response", error: "daemon returned an invalid thread response" },
        "daemon returned an invalid thread response",
      );
    }
    return {
      ...parsed.data,
      threadId: parsed.data.id,
      summary: `created thread ${parsed.data.id}`,
    };
  }
  const parsed = ControlThreadTurnResponse.safeParse(result);
  if (!parsed.success) {
    throw controlProblemError(
      502,
      { code: "invalid_response", error: "daemon returned an invalid thread-turn response" },
      "daemon returned an invalid thread-turn response",
    );
  }
  return {
    ...parsed.data,
    summary: `queued turn ${parsed.data.turnId} on thread ${parsed.data.threadId}`,
  };
}

/**
 * Recovery queries — thin read-only projections over the daemon control API
 * (auto-starting it like every daemon-tracked path). A host that lost a run
 * handle finds it again without shelling out to the CLI.
 */
async function recoveryQuery(
  mode: string,
  runId: string,
  input: Record<string, unknown> = {},
  context: { beltContext?: boolean } = {},
): Promise<unknown> {
  // Read-only recovery must not BOOT a daemon: with no daemon there are no
  // daemon-tracked runs to recover — say so instead of spawning one.
  const conn = await connectDaemonIfRunning();
  if (!conn) return absentDaemonRecovery(mode, context.beltContext);
  const { addr } = conn;
  const get = async (path: string, runDetail = false): Promise<Record<string, unknown>> => {
    const res = await controlApiFetch(addr, path, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
    if (res.ok) {
      return runDetail
        ? readRunDetailResponse(res)
        : ((await res.json()) as Record<string, unknown>);
    }
    const body: unknown = await res.json().catch(() => ({}));
    const error = controlProblemError(res.status, body, `HTTP ${res.status} for ${path}`);
    Object.assign(error, {
      mcpRecoveryTypedControlProblem: ControlProblem.safeParse(body).success,
    });
    throw error;
  };
  if (mode === "__runs_list") {
    // GET /runs is a BOUNDED keyset page (QA-052): a single read undercounts the
    // daemon-tracked total whenever more pages exist. Walk the opaque cursor to
    // completion so the count and list are honest, with a hard page ceiling that
    // keeps the walk finite even against a huge retained set. Truncation (the
    // ceiling was hit) is disclosed rather than silently reported as the total.
    const MAX_PAGES = 50;
    const PAGE_LIMIT = 1_000; // RUN_LIST_MAX_LIMIT; 50 * 1000 = 50k hard ceiling
    // The recovery listing returns only the FIRST page's rows (the newest runs,
    // enough to recover a lost handle). Deeper pages are walked ONLY to keep the
    // count honest — their rows are counted then discarded, so the walk never
    // holds up to 50k row objects in memory. `total` is the SUM of page lengths;
    // `truncated` discloses when the page ceiling cut the walk short.
    let total = 0;
    let sample: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    let truncated = false;
    for (let page = 0; ; page += 1) {
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) query.set("cursor", cursor);
      const body = await get(`/runs?${query.toString()}`);
      const runs = Array.isArray(body["runs"]) ? (body["runs"] as Record<string, unknown>[]) : [];
      total += runs.length;
      if (page === 0) sample = runs;
      const next = typeof body["nextCursor"] === "string" ? (body["nextCursor"] as string) : null;
      if (body["hasMore"] !== true || !next) break;
      if (page + 1 >= MAX_PAGES) {
        truncated = true;
        break;
      }
      cursor = next;
    }
    return {
      summary: truncated
        ? `${total}+ daemon-tracked run(s) (listing truncated at ${MAX_PAGES} pages)`
        : `${total} daemon-tracked run(s)`,
      truncated,
      total,
      runs: sample.map((r) => ({
        runId: r["runId"] ?? r["id"] ?? null,
        status: r["status"] ?? r["state"] ?? null,
        mode: r["mode"] ?? null,
        createdAt: r["createdAt"] ?? null,
      })),
    };
  }
  if (!runId) throw new Error("runId is required");
  if (mode === "__run_inspect" || mode === "__run_status" || mode === "__run_result") {
    const parent =
      typeof input["delegatedFromRunId"] === "string"
        ? (input["delegatedFromRunId"] as string)
        : undefined;
    const scopedRecovery = context.beltContext || parent !== undefined;
    try {
      const detail = await get(`/runs/${encodeURIComponent(runId)}`, true);
      return projectRecoveryRunDetail(mode, runId, detail, parent);
    } catch (error) {
      if (scopedRecovery || !isRecoverableRunDetailIntegrityProblem(error)) {
        throw error;
      }
      return projectDegradedRecoveryRunDetail(runId, error);
    }
  }
  if (mode === "__run_cancel") {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}/control`, {
      method: "POST",
      headers: { authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        control: {
          kind: "cancel",
          reason: "MCP host requested durable run cancellation",
          reason_code: "host_cancelled",
        },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        typeof body["message"] === "string"
          ? (body["message"] as string)
          : `run cancel failed (HTTP ${res.status})`,
      );
    }
    return { summary: `cancellation acknowledged for run ${runId}`, runId, acknowledged: true };
  }
  if (mode === "__run_interactions") {
    const detail = await get(`/runs/${encodeURIComponent(runId)}`);
    const interactions = Array.isArray(detail["pendingInteractions"])
      ? detail["pendingInteractions"]
      : [];
    return {
      summary: `${interactions.length} pending interaction(s) for run ${runId}`,
      runId,
      interactions,
    };
  }
  if (mode === "__run_answer") {
    const interactionId = String(input["interactionId"] ?? "");
    if (!interactionId) throw new Error("interactionId is required");
    const res = await controlApiFetch(
      addr,
      `/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(interactionId)}/answer`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answers: input["answers"] }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        typeof body["message"] === "string"
          ? (body["message"] as string)
          : `interaction answer failed (HTTP ${res.status})`,
      );
    }
    return {
      summary: `answer acknowledged for interaction ${interactionId}`,
      runId,
      interactionId,
    };
  }
  // __apply_check: the server-side dry gate + patch check (no mutation).
  const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}/apply/check`, {
    method: "POST",
    headers: { authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      summary: `apply check refused: ${typeof body["message"] === "string" ? body["message"] : `HTTP ${res.status}`}`,
      runId,
      eligible: false,
    };
  }
  // HTTP 200 carries the ApplyResult; `ok:false` means `git apply --check`
  // itself failed — an honest conflict verdict, never "applies cleanly".
  if (body["ok"] !== true) {
    const stderr =
      typeof body["stderr"] === "string" && body["stderr"].trim()
        ? `: ${body["stderr"].trim()}`
        : "";
    return {
      summary: `apply check failed: the patch does NOT apply cleanly${stderr}`,
      runId,
      eligible: false,
      check: body,
    };
  }
  return {
    summary: "apply check passed: the patch applies cleanly to the original project",
    runId,
    eligible: true,
    check: body,
  };
}

async function journalRecoveryQuery(input: Record<string, unknown>): Promise<unknown> {
  const conn = await connectDaemonIfRunning();
  if (!conn) throw new Error("the Claudexor daemon is not running");
  const action = String(input["action"] ?? "inspect");
  const partition = String(input["partition"] ?? "");
  if (!partition) throw new Error("partition is required");
  const base = `/recovery/partitions/${encodeURIComponent(partition)}`;
  const suffix =
    action === "inspect"
      ? ""
      : action === "validate" || action === "export" || action === "quarantine"
        ? `/${action}`
        : null;
  if (suffix === null) throw new Error(`unknown journal recovery action '${action}'`);
  const body =
    action === "quarantine"
      ? {
          expectedFingerprint: String(input["expectedFingerprint"] ?? ""),
          confirmation: String(input["confirmation"] ?? ""),
        }
      : undefined;
  const response = await controlApiFetch(conn.addr, `${base}${suffix}`, {
    method: action === "inspect" ? "GET" : "POST",
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof result["message"] === "string"
        ? (result["message"] as string)
        : `journal recovery failed (HTTP ${response.status})`,
    );
  }
  return result;
}

/**
 * Once a run is bound, forward a typed abort cause, defaulting untyped host
 * signals to host_cancelled. Poll ticks preserve aborts that race run-binding.
 */
export function makeCancelBridge(
  addr: ControlApiAddress,
  signal: AbortSignal,
): (info: { runId: string }) => Promise<void> {
  let posted = false;
  let inFlight = false;
  return async ({ runId }) => {
    if (posted || inFlight || !signal.aborted || !runId) return;
    inFlight = true;
    try {
      const response = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}/control`, {
        method: "POST",
        headers: { Authorization: `Bearer ${addr.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          control: {
            kind: "cancel",
            reason: "calling surface cancelled the run",
            reason_code: normalizeCancelReasonCode(signal.reason) ?? "host_cancelled",
          },
        }),
      });
      posted = response.ok;
    } catch {
      posted = false;
    } finally {
      inFlight = false;
    }
  };
}

/**
 * Poll-tick bridge: watch the run's pendingInteractions on the control API and
 * forward each NEW interaction to the caller's hook exactly once; answers go
 * back through the typed answer endpoint. A stale answer (engine already
 * timed out and declined) is the endpoint's problem to refuse — the bridge
 * never fakes delivery.
 */
export function makeInteractionBridge(
  addr: ControlApiAddress,
  onInteraction: (ctx: any) => Promise<any | null>,
): (info: { runId: string }) => Promise<void> {
  const delivered = new Set<string>();
  const answerCache = new Map<string, any | null>();
  let lastCheck = 0;
  let handling = false;
  return async ({ runId }) => {
    if (handling || Date.now() - lastCheck < 1_000) return;
    lastCheck = Date.now();
    let pending: Array<{
      interactionId?: string;
      questions?: unknown[];
      timeoutAt?: string | null;
    }> = [];
    try {
      const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
        headers: { Authorization: `Bearer ${addr.token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) return;
      const detail = (await res.json()) as { pendingInteractions?: typeof pending };
      pending = detail.pendingInteractions ?? [];
    } catch {
      return; // transient control-api hiccup: the next tick retries
    }
    for (const pi of pending) {
      const id = typeof pi.interactionId === "string" ? pi.interactionId : "";
      if (!id || delivered.has(id)) continue;
      handling = true;
      try {
        const result = answerCache.has(id)
          ? answerCache.get(id)
          : await onInteraction({
              run_id: runId,
              request: {
                interaction_id: id,
                questions: Array.isArray(pi.questions) ? pi.questions : [],
              },
              ...(Object.hasOwn(pi, "timeoutAt") ? { timeoutAt: pi.timeoutAt } : {}),
            });
        answerCache.set(id, result);
        const answers = result && Array.isArray(result.answers) ? result.answers : null;
        if (answers) {
          const response = await controlApiFetch(
            addr,
            `/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(id)}/answer`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${addr.token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                answers: answers.map((a: any) => ({
                  questionId: a.question_id,
                  selectedLabels: a.selected_labels ?? [],
                  ...(a.free_text ? { freeText: a.free_text } : {}),
                })),
              }),
            },
          ).catch(() => null);
          if (response?.ok) {
            delivered.add(id);
            answerCache.delete(id);
          }
        } else {
          // A deliberate decline has no answer mutation to acknowledge.
          delivered.add(id);
          answerCache.delete(id);
        }
      } finally {
        handling = false;
      }
    }
  };
}
