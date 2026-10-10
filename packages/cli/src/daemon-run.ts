import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DaemonClient,
  awaitDaemonTermination,
  inspectDaemonWriterLease,
  canonicalDefaultSocketPath,
  daemonDir,
  defaultSocketPath,
  ensureToken,
  readToken,
  type DaemonClient as DaemonClientType,
} from "@claudexor/daemon";
import { harnessRuntimeEnv } from "@claudexor/core";
import { hashJson } from "@claudexor/util";
import { CliError, controlProblemError } from "./cli-error.js";
import { daemonOwner, managedDaemonUnavailable } from "./daemon-owner.js";
import {
  CLI_DAEMON_LAUNCH_SOURCES,
  launchDetachedDaemon,
  type DetachedDaemonLaunch,
} from "./daemon-launch.js";
import { recordEngineSkew, type EngineIdentity } from "./engine-skew.js";
import {
  controlApiAddress,
  controlApiFetch,
  handshakeControlApi,
  type ControlApiAddress,
} from "./live.js";
import { TERMINAL_LIFECYCLES } from "@claudexor/schema";
export { projectOutcomeBanner } from "./run-detail-projections.js";
export { projectRunOutcomeFacts, mergeDaemonRunOutcome } from "./daemon-outcome.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A real journal-heavy default data root can spend tens of seconds replaying
// and recovering before the socket and control API are ready. Both explicit
// `daemon start` and acting-command auto-start use this one bounded budget so
// neither reports a false failure while the detached daemon is still starting.
export const DAEMON_START_READY_TIMEOUT_MS = 90_000;

// The bounded TAIL of that fresh-start budget spent waiting for the control
// API after the daemon socket already answers (C10): the pointer file lands
// as soon as the control transport binds — on the recovery plane too — so
// this tail covers only bind/pointer-write latency, never journal replay
// (that part is behind the socket wait above).
export const DAEMON_CONTROL_API_FRESH_START_TAIL_MS = 10_000;

/** Is something accepting on the daemon socket right now? (cheap reachability probe). */
async function daemonReachable(client: DaemonClientType): Promise<boolean> {
  return client.health().then(
    () => true,
    () => false,
  );
}

/** Is the daemon's control-api up and answering /healthz right now? Returns
 * the address WITH the handshake's validated engine identity — callers that
 * need capability negotiation (gc's data_root_report) reuse this one
 * handshake instead of performing a second.
 * Absence-vs-refusal (#93): null means ABSENCE only — no pointer file, connect
 * refused/timeout, non-ok healthz (a STOPPING daemon's 503 included, R1 C-C3b),
 * or the same stopping daemon losing the healthz/handshake race and answering
 * the handshake with its typed `daemon_stopping` problem (R2) — and clears the
 * skew record; any OTHER typed handshake problem THROWS, because "not
 * reachable" would send callers into a doomed wait/auto-start. */
async function controlApiReachable(): Promise<{
  addr: ControlApiAddress;
  engine: EngineIdentity;
} | null> {
  try {
    const addr = controlApiAddress();
    const res = await controlApiFetch(addr, "/healthz", { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const engine = await handshakeControlApi(addr);
      return { addr, engine };
    }
  } catch (err) {
    if (err instanceof CliError && err.code !== "daemon_stopping") throw err;
  }
  recordEngineSkew(null); // absence (stopping included): no live connection to be skewed with
  return null;
}

/**
 * Ensure a daemon (and its control API) is running and return a connected
 * client + control-api address. Connects to the existing socket; if unreachable,
 * AUTO-STARTS claudexord as a detached process and waits (bounded) for both the
 * socket and the control-api.json pointer to come up. FAILS LOUDLY if the daemon
 * cannot be started — never silently falls back to an in-process run (the apply
 * gate refuses a run no daemon tracks, so an in-process run is un-unblockable).
 * A daemon that is up but REFUSES the typed handshake fails IMMEDIATELY with
 * that typed problem — including after an auto-start that lost the singleton
 * race to a foreign daemon (macOS app relaunch) this CLI then handshakes (#93).
 */
export async function ensureDaemon(
  timeoutMs = DAEMON_START_READY_TIMEOUT_MS,
): Promise<{ client: DaemonClientType; addr: ControlApiAddress; engine: EngineIdentity }> {
  // Attach before any token/root creation. Recovery-only is a real connection;
  // its existing route admission errors remain authoritative.
  if (daemonOwner() === "external") {
    const connection = await connectDaemonIfRunning();
    if (!connection) throw managedDaemonUnavailable();
    return connection;
  }
  const token = ensureToken();
  const socketPath = defaultSocketPath();
  let client = new DaemonClient(socketPath, token);
  let launch: DetachedDaemonLaunch | null = null;
  // ONE shared budget for the whole readiness sequence (socket, pointer,
  // normal admission): a journal-heavy startup may spend most of it in any
  // single phase, and stacking per-phase budgets would multiply the worst case.
  const overallDeadline = Date.now() + timeoutMs;

  const ok = await daemonReachable(client);
  if (!ok) {
    // Auto-start the daemon entry (the same one `claudexor daemon start` spawns).
    const daemonScript =
      process.env["CLAUDEXOR_DAEMON_ENTRY"] ??
      fileURLToPath(new URL("./claudexord.js", import.meta.url));
    launch = launchDetachedDaemon({
      entryPath: daemonScript,
      launchSource: CLI_DAEMON_LAUNCH_SOURCES.ensureDaemon,
      env: harnessRuntimeEnv(),
    });
    // Wait for the socket to accept connections (health round-trip).
    let started = false;
    while (Date.now() < overallDeadline) {
      await sleep(150);
      // Re-read the token: ensureToken() above generated it before spawn, and the
      // daemon reuses the same per-user token file, so this client stays valid.
      client = new DaemonClient(socketPath, token);
      if (await daemonReachable(client)) {
        started = true;
        break;
      }
      if (launch.failure()) throw launch.callerError("socket_wait", timeoutMs);
    }
    if (!started) throw launch.callerError("socket_wait", timeoutMs);
  }

  // The control API (HTTP/SSE viewport over the daemon) is what streams events
  // and resolves the run for apply/decision. Wait for its pointer to be written.
  let reached = await controlApiReachable();
  if (!reached) {
    const deadline = Date.now() + DAEMON_CONTROL_API_FRESH_START_TAIL_MS;
    while (Date.now() < deadline && !reached) {
      await sleep(150);
      reached = await controlApiReachable();
      if (!reached && launch?.failure()) {
        throw launch.callerError("control_api_wait", DAEMON_CONTROL_API_FRESH_START_TAIL_MS);
      }
    }
  }
  if (!reached) {
    if (launch)
      throw launch.callerError("control_api_wait", DAEMON_CONTROL_API_FRESH_START_TAIL_MS);
    throw new Error(
      `daemon is up but its control API is not reachable (no ${daemonDir()}/control-api.json); it may be disabled by CLAUDEXOR_NO_CONTROL_API=1`,
    );
  }
  launch?.markReady();
  // C7d × D5: the daemon binds its transport and writes the pointer in
  // startup stage 3 with product admission still CLOSED (handshake reports
  // recovery_only), and only stage 4 — journal revalidation, crash-GC, the
  // full recover(), activation — opens normal admission. On journal-heavy
  // roots stage 4 takes the tens of seconds this shared start budget exists
  // for, so a recovery_only handshake here is AMBIGUOUS between "still
  // starting" and "genuinely blocked". Keep re-handshaking until the budget
  // expires; a genuinely blocked root never opens normal and still gets the
  // typed error below (the macOS app connect loop waits the same way).
  while (reached.engine.servingMode !== "normal" && Date.now() < overallDeadline) {
    await sleep(150);
    if (launch?.failure()) throw launch.callerError("normal_admission_wait", timeoutMs);
    // Absence mid-wait (daemon died or is restarting) keeps the last observed
    // identity: the loop stays bounded and the deadline names the state.
    reached = (await controlApiReachable()) ?? reached;
  }
  // C7d: acting paths must not proceed into a wall of daemon_recovery_only
  // route refusals — name the recovery state once, typed and retryable.
  if (reached.engine.servingMode !== "normal") {
    throw new CliError(
      "operational",
      "daemon is serving recovery only; product routes are closed until journal recovery completes",
      {
        code: "daemon_recovery_only",
        retryable: true,
        requiredActions: [
          "inspect `claudexor daemon logs` and the /recovery control surface",
          "retry after journal recovery completes",
        ],
      },
    );
  }
  return { client, addr: reached.addr, engine: reached.engine };
}

/**
 * Connect to an ALREADY-RUNNING daemon + control API WITHOUT ever spawning one.
 * Returns null when no token exists, the socket is unreachable, or the control
 * API is down. Used by read-only-looking run lookups (inspect/apply) so a typo'd
 * run id reports "no such run" instead of silently launching a background daemon
 * (`ensureDaemon`, by contrast, auto-starts and is reserved for paths that act —
 * enqueue/decision). A daemon that REFUSES the typed handshake is NOT "not
 * running": the typed problem propagates — still without spawning (#93).
 */
export async function connectDaemonIfRunning(): Promise<{
  client: DaemonClientType;
  addr: ControlApiAddress;
  /** Handshake identity incl. servingMode (C7): read-only paths stay
   * connectable to a recovery-only daemon and report the mode honestly. */
  engine: EngineIdentity;
} | null> {
  const external = daemonOwner() === "external";
  const token = readToken();
  if (!token) return null;
  const client = new DaemonClient(
    external ? canonicalDefaultSocketPath() : defaultSocketPath(),
    token,
  );
  if (!(await daemonReachable(client))) return null;
  const reached = await controlApiReachable();
  if (!reached) return null;
  return { client, addr: reached.addr, engine: reached.engine };
}

/**
 * Poll until the daemon (socket + control API) is fully ready, or the timeout
 * elapses. Lets `claudexor daemon start` return only once a subsequent `status`
 * is guaranteed to succeed (no start/status race). A typed handshake refusal
 * propagates — waiting cannot fix an incompatible daemon (#93).
 */
export async function waitForDaemonReady(
  timeoutMs = DAEMON_START_READY_TIMEOUT_MS,
  abort?: () => Error | null,
): Promise<{ client: DaemonClientType; addr: ControlApiAddress; engine: EngineIdentity } | null> {
  const deadline = Date.now() + timeoutMs;
  // D5: a reachable daemon may still be mid-startup (stage 3 binds the
  // transport recovery-only; stage 4 opens normal admission after journal
  // recovery). Report the TERMINAL mode, not the transient stage-3 value:
  // keep polling a recovery_only handshake until it opens normal or the
  // budget expires — a genuinely blocked root is then reported honestly.
  let last: Awaited<ReturnType<typeof connectDaemonIfRunning>> = null;
  for (;;) {
    const conn = await connectDaemonIfRunning();
    if (conn?.engine.servingMode === "normal") return conn;
    last = conn ?? last;
    const failure = abort?.();
    if (failure) throw failure;
    if (Date.now() >= deadline) return last;
    await sleep(150);
  }
}

// The daemon job state IS the run lifecycle (D8): the terminal set is the ONE
// projection-owned TERMINAL_LIFECYCLES, never a local re-derivation.
const TERMINAL_STATES: ReadonlySet<string> = TERMINAL_LIFECYCLES;

export interface DaemonRunOutcome {
  runId: string;
  runDir: string;
  /** The daemon job state (honest terminal: succeeded | blocked | failed | no_op | ...). */
  status: string;
  jobId: string;
  error?: string;
  errorCode?: string;
  errorStatus?: number;
  errorRetryable?: boolean;
  errorRequiredActions?: string[];
  errorContext?: Record<string, unknown>;
}

/**
 * Enqueue a run via the control API and wait until the daemon binds its
 * runId/runDir, then (optionally) wait for it to reach a terminal state.
 * The run lives under the DAEMON dir, not project-local: apply/decision/inspect
 * resolve it via the daemon/registry, and a blocked run is unblockable through
 * `claudexor decision`.
 */
export async function enqueueAndAwait(
  client: DaemonClientType,
  addr: ControlApiAddress,
  body: Record<string, unknown>,
  opts: {
    waitForTerminal: boolean;
    /** Belt-only path: enqueue through the authenticated daemon socket so
     * server-owned delegation lineage never becomes forgeable on POST /runs. */
    internalDaemonEnqueue?: boolean;
    startTimeoutMs?: number;
    /** Invoked each terminal-wait iteration once the run is bound (MCP uses
     * this to bridge pendingInteractions -> host elicitation). Awaited: a
     * long answer round-trip pauses status polling, never the run itself. */
    onPollTick?: (info: { runId: string }) => void | Promise<void>;
  } = { waitForTerminal: true },
): Promise<DaemonRunOutcome> {
  await ensureRunProject(addr, body);
  // D10 transport split: a thread continuation (`--thread`/`--resume`) ALWAYS
  // goes through POST /threads/:id/turns — the route owns scope resolution,
  // turn lineage, and the continuation packet. POST /runs is the one-shot,
  // thread-less surface and now REFUSES threadId. Server-owned keys (scope,
  // execution, lineage) are stripped: the turns request schema is strict and
  // the route derives them from the thread.
  let jobId = "";
  let runId = "";
  let runDir = "";
  if (opts.internalDaemonEnqueue) {
    const accepted = await client.enqueue(body, {
      clientId: "delegation-belt",
      operation: "delegated-run",
    });
    jobId = accepted.id;
  } else {
    const turnThreadId = typeof body["threadId"] === "string" ? (body["threadId"] as string) : "";
    const { url, postBody } = turnThreadId
      ? {
          url: `/threads/${encodeURIComponent(turnThreadId)}/turns`,
          postBody: threadTurnBody(body),
        }
      : { url: "/runs", postBody: body };
    const startRes = await controlApiFetch(addr, url, {
      method: "POST",
      headers: { Authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
      body: JSON.stringify(postBody),
    });
    const startText = await startRes.text();
    const start = startText ? (JSON.parse(startText) as Record<string, unknown>) : {};
    if (!startRes.ok) {
      throw controlProblemError(
        startRes.status,
        start,
        `run enqueue failed (HTTP ${startRes.status})`,
      );
    }
    jobId = String(start["jobId"] ?? "");
    runId = typeof start["runId"] === "string" ? (start["runId"] as string) : "";
    runDir = typeof start["runDir"] === "string" ? (start["runDir"] as string) : "";
  }

  // Ctrl-C while the CLI waits on a daemon run must CANCEL THE RUN, not just
  // kill the waiting CLI (which would leave the daemon mutating the tree with
  // nobody watching — the orphan the audit called out). First signal posts the
  // typed cancel and keeps waiting for the honest terminal; a second signal
  // force-quits the CLI (the daemon still owns the cancel).
  let sigCount = 0;
  const onSignal = (): void => {
    sigCount += 1;
    if (sigCount >= 2) process.exit(130);
    process.stderr.write("\ncancelling daemon run (Ctrl-C again to detach)...\n");
    void controlApiFetch(addr, `/runs/${encodeURIComponent(jobId)}/control`, {
      method: "POST",
      headers: { Authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        control: {
          kind: "cancel",
          reason: "ctrl-c on the waiting CLI",
          reason_code: "user_cancelled",
        },
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          process.stderr.write(
            `cancel request failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}\n`,
          );
        }
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `cancel request failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const removeSignalHandlers = (): void => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };

  try {
    // A 202 (queued) response carries only the jobId; poll the daemon socket
    // until the run binds its id/dir (single canonical state source).
    const startDeadline = Date.now() + (opts.startTimeoutMs ?? 30_000);
    while ((!runId || !runDir) && Date.now() < startDeadline) {
      if (!jobId) break;
      const rec = await client.status(jobId);
      if (rec.runId && rec.runDir) {
        runId = rec.runId;
        runDir = rec.runDir;
        break;
      }
      if (TERMINAL_STATES.has(rec.state) && !rec.runDir) {
        // Terminal with no runDir = the run never materialized (e.g. validation
        // failure pre-run-dir). Surface it honestly.
        return {
          runId: rec.runId ?? "",
          runDir: "",
          status: rec.state,
          jobId,
          error: rec.error,
          errorCode: rec.errorCode,
          errorStatus: rec.errorStatus,
          errorRetryable: rec.errorRetryable,
          errorRequiredActions: rec.errorRequiredActions,
          errorContext: rec.errorContext,
        };
      }
      await sleep(120);
    }
    if (!runId || !runDir) {
      throw new Error(`run did not start within the timeout (jobId ${jobId})`);
    }

    if (!opts.waitForTerminal) {
      // The caller keeps watching this run (text mode streams it); hand the
      // signal responsibility back with the outcome.
      const rec = jobId ? await client.status(jobId) : null;
      return {
        runId,
        runDir,
        status: rec?.state ?? "running",
        jobId,
        error: rec?.error,
        errorCode: rec?.errorCode,
        errorStatus: rec?.errorStatus,
        errorRetryable: rec?.errorRetryable,
        errorRequiredActions: rec?.errorRequiredActions,
        errorContext: rec?.errorContext,
      };
    }

    // Poll the daemon socket for the terminal job state (the canonical outcome).
    for (;;) {
      const rec = await client.status(jobId);
      if (TERMINAL_STATES.has(rec.state)) {
        return {
          runId: rec.runId ?? runId,
          runDir: rec.runDir ?? runDir,
          status: rec.state,
          jobId,
          error: rec.error,
          errorCode: rec.errorCode,
          errorStatus: rec.errorStatus,
          errorRetryable: rec.errorRetryable,
          errorRequiredActions: rec.errorRequiredActions,
          errorContext: rec.errorContext,
        };
      }
      if (opts.onPollTick) await opts.onPollTick({ runId: rec.runId ?? runId });
      await sleep(250);
    }
  } finally {
    removeSignalHandlers();
  }
}

/**
 * Strip the server-owned keys the strict ControlThreadTurnRequest schema
 * rejects (scope/execution/lineage/frozen-plan reference):
 * POST /threads/:id/turns derives them from the thread itself. Everything else
 * the user passed (mode, prompt, harness pool, budget, ...) rides through.
 */
function threadTurnBody(body: Record<string, unknown>): Record<string, unknown> {
  const {
    threadId: _threadId,
    scope: _scope,
    execution: _execution,
    turnId: _turnId,
    parentRunId: _parentRunId,
    delegatedFromRunId: _delegatedFromRunId,
    retryOf: _retryOf,
    planRef: _planRef,
    ...rest
  } = body;
  return rest;
}

async function ensureRunProject(
  addr: ControlApiAddress,
  body: Record<string, unknown>,
): Promise<void> {
  const scope = body["scope"];
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return;
  const project = scope as Record<string, unknown>;
  if (project["kind"] !== "project" || typeof project["root"] !== "string") return;
  const root = project["root"];
  const response = await controlApiFetch(addr, "/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": `auto-register-${hashJson(root)}`,
    },
    body: JSON.stringify({ root }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    let problem: unknown;
    try {
      problem = JSON.parse(detail);
    } catch {
      /* untyped transport body */
    }
    throw controlProblemError(
      response.status,
      problem,
      `project registration failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
}

// Run-detail fetch wrappers + terminal projections live in run-detail-fetch.ts
// (ratchet split); re-exported so existing import sites stay stable.
export {
  exitCodeForState,
  fetchPlanReadiness,
  fetchPlanQuestions,
  fetchCouncil,
  fetchRunDetail,
  fetchApplyEligibility,
  fetchRunOutcomeFacts,
  fetchOutcomeBanner,
  daemonOutcomeSummary,
} from "./run-detail-fetch.js";

interface OperatorDaemonStopDeps {
  inspectLease: typeof inspectDaemonWriterLease;
  shutdown(): Promise<unknown>;
  awaitTermination: typeof awaitDaemonTermination;
}

/** Pin strict signal authority before the asynchronous operator-stop RPC. */
export async function stopDaemonForOperator(
  socketPath: string,
  deps: OperatorDaemonStopDeps,
): ReturnType<typeof awaitDaemonTermination> {
  const lease = deps.inspectLease(socketPath);
  const expectedOwner =
    lease.status === "owned" && lease.capability.status === "capable" ? lease.owner : null;
  await deps.shutdown();
  return deps.awaitTermination(socketPath, {
    allowSigkill: expectedOwner !== null,
    ...(expectedOwner === null ? {} : { expectedOwner }),
    requireNoSuccessor: false,
  });
}
