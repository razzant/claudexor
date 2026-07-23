import process from "node:process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DaemonClient,
  daemonDir,
  defaultSocketPath,
  ensureToken,
  readToken,
  type DaemonClient as DaemonClientType,
} from "@claudexor/daemon";
import { harnessRuntimeEnv } from "@claudexor/core";
import { hashJson } from "@claudexor/util";
import {
  controlApiAddress,
  controlApiFetch,
  handshakeControlApi,
  processExitCodeForRunStatus,
  type ControlApiAddress,
} from "./live.js";
import { TERMINAL_LIFECYCLES, type RunOutcomeFacts, outcomeExitCode } from "@claudexor/schema";
export {
  daemonOutcomeProblemFields,
  fetchRunOutcomeFacts,
  projectRunOutcomeFacts,
  mergeDaemonRunOutcome,
} from "./daemon-outcome.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Is something accepting on the daemon socket right now? (cheap reachability probe). */
async function daemonReachable(client: DaemonClientType): Promise<boolean> {
  try {
    await client.health();
    return true;
  } catch {
    return false;
  }
}

/** Is the daemon's control-api up and answering /healthz right now? */
async function controlApiReachable(): Promise<ControlApiAddress | null> {
  try {
    const addr = controlApiAddress();
    const res = await controlApiFetch(addr, "/healthz", { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    await handshakeControlApi(addr);
    return addr;
  } catch {
    return null;
  }
}

/**
 * Ensure a daemon (and its control API) is running and return a connected
 * client + control-api address. Connects to the existing socket; if unreachable,
 * AUTO-STARTS claudexord as a detached process and waits (bounded) for both the
 * socket and the control-api.json pointer to come up. FAILS LOUDLY if the daemon
 * cannot be started — never silently falls back to an in-process run (the apply
 * gate refuses a run no daemon tracks, so an in-process run is un-unblockable).
 */
export async function ensureDaemon(
  timeoutMs = 30_000,
): Promise<{ client: DaemonClientType; addr: ControlApiAddress }> {
  const token = ensureToken();
  const socketPath = defaultSocketPath();
  let client = new DaemonClient(socketPath, token);

  const ok = await daemonReachable(client);
  if (!ok) {
    // Auto-start the daemon entry (the same one `claudexor daemon start` spawns).
    const daemonScript = fileURLToPath(new URL("./claudexord.js", import.meta.url));
    if (!existsSync(daemonScript)) {
      throw new Error(
        `cannot auto-start the daemon: entry not found at ${daemonScript} (run \`pnpm build\`)`,
      );
    }
    const child = spawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: "ignore",
      env: harnessRuntimeEnv(),
    });
    child.unref();
    // Wait for the socket to accept connections (health round-trip).
    const deadline = Date.now() + timeoutMs;
    let started = false;
    while (Date.now() < deadline) {
      await sleep(150);
      // Re-read the token: ensureToken() above generated it before spawn, and the
      // daemon reuses the same per-user token file, so this client stays valid.
      client = new DaemonClient(socketPath, token);
      if (await daemonReachable(client)) {
        started = true;
        break;
      }
    }
    if (!started) {
      throw new Error(
        `daemon did not come up within ${Math.round(timeoutMs / 1000)}s after auto-start (socket ${socketPath}); check \`claudexor daemon logs\``,
      );
    }
  }

  // The control API (HTTP/SSE viewport over the daemon) is what streams events
  // and resolves the run for apply/decision. Wait for its pointer to be written.
  let addr = await controlApiReachable();
  if (!addr) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !addr) {
      await sleep(150);
      addr = await controlApiReachable();
    }
  }
  if (!addr) {
    throw new Error(
      `daemon is up but its control API is not reachable (no ${daemonDir()}/control-api.json); it may be disabled by CLAUDEXOR_NO_CONTROL_API=1`,
    );
  }
  return { client, addr };
}

/**
 * Connect to an ALREADY-RUNNING daemon + control API WITHOUT ever spawning one.
 * Returns null when no token exists, the socket is unreachable, or the control
 * API is down. Used by read-only-looking run lookups (inspect/apply) so a typo'd
 * run id reports "no such run" instead of silently launching a background daemon
 * (`ensureDaemon`, by contrast, auto-starts and is reserved for paths that act —
 * enqueue/decision).
 */
export async function connectDaemonIfRunning(): Promise<{
  client: DaemonClientType;
  addr: ControlApiAddress;
} | null> {
  const token = readToken();
  if (!token) return null;
  const client = new DaemonClient(defaultSocketPath(), token);
  if (!(await daemonReachable(client))) return null;
  const addr = await controlApiReachable();
  if (!addr) return null;
  return { client, addr };
}

/**
 * Poll until the daemon (socket + control API) is fully ready, or the timeout
 * elapses. Lets `claudexor daemon start` return only once a subsequent `status`
 * is guaranteed to succeed (no start/status race).
 */
export async function waitForDaemonReady(
  timeoutMs = 15_000,
): Promise<{ client: DaemonClientType; addr: ControlApiAddress } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const conn = await connectDaemonIfRunning();
    if (conn) return conn;
    if (Date.now() >= deadline) return null;
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
  const turnThreadId = typeof body["threadId"] === "string" ? (body["threadId"] as string) : "";
  const { url, postBody } = turnThreadId
    ? { url: `/threads/${encodeURIComponent(turnThreadId)}/turns`, postBody: threadTurnBody(body) }
    : { url: "/runs", postBody: body };
  const startRes = await controlApiFetch(addr, url, {
    method: "POST",
    headers: { Authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
    body: JSON.stringify(postBody),
  });
  const startText = await startRes.text();
  const start = startText ? (JSON.parse(startText) as Record<string, unknown>) : {};
  if (!startRes.ok) {
    const message =
      typeof start["message"] === "string"
        ? (start["message"] as string)
        : `run enqueue failed (HTTP ${startRes.status})`;
    const code = typeof start["code"] === "string" ? (start["code"] as string) : undefined;
    // Output-schema refusals are born before a job exists. Preserve their
    // typed public contract as a terminal outcome instead of throwing through
    // the CLI's legacy string-only catch; the general problem projector is
    // intentionally owned by #28.
    if (code === "unsupported_schema_dialect" || code === "invalid_output_schema") {
      return {
        runId: "",
        runDir: "",
        status: "failed",
        jobId: "",
        error: message,
        errorCode: code,
        errorStatus: startRes.status,
        errorRetryable:
          typeof start["retryable"] === "boolean" ? (start["retryable"] as boolean) : false,
      };
    }
    throw new Error(message);
  }
  const jobId = String(start["jobId"] ?? "");
  let runId = typeof start["runId"] === "string" ? (start["runId"] as string) : "";
  let runDir = typeof start["runDir"] === "string" ? (start["runDir"] as string) : "";

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
      body: JSON.stringify({ control: { kind: "cancel", reason: "ctrl-c on the waiting CLI" } }),
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
      return { runId, runDir, status: rec?.state ?? "running", jobId };
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
 * rejects (scope/execution/lineage): POST /threads/:id/turns derives them from
 * the thread itself. Everything else the user passed (mode, prompt, harness
 * pool, budget, ...) rides through unchanged.
 */
function threadTurnBody(body: Record<string, unknown>): Record<string, unknown> {
  const {
    threadId: _threadId,
    scope: _scope,
    execution: _execution,
    turnId: _turnId,
    parentRunId: _parentRunId,
    retryOf: _retryOf,
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
    throw new Error(
      `project registration failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
}

/** Daemon job state (= run lifecycle, D8) -> CLI exit code via the ONE
 * projection owner: a succeeded lifecycle is 0 (a "Done · needs review" run
 * included); everything else is 1. When the run's terminal outcome `facts` are
 * available, the D-16 outcome-aware projection is used instead so a
 * needs_input/incomplete work_state exits non-zero on a succeeded lifecycle. */
export function exitCodeForState(state: string, facts?: RunOutcomeFacts | null): number {
  if (facts) return outcomeExitCode(facts);
  return processExitCodeForRunStatus(state);
}

/**
 * The run's derived apply-gate verdict from GET /runs/:id (single producer:
 * the delivery gate via the control API). Soft-fails to null — a detail
 * hiccup must never eat a finished run's result. Shared by the CLI post-run
 * hints and the MCP structured results so both surfaces tell the same truth.
 */
/** Server-derived plan readiness projection (mode=plan runs). */
export async function fetchPlanReadiness(
  addr: ControlApiAddress,
  runId: string,
): Promise<{ state: string; questionCount: number } | null> {
  if (!runId) return null;
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
    if (!res.ok) return null;
    const detail = (await res.json()) as Record<string, unknown>;
    const v = detail["planReadiness"];
    return v && typeof v === "object" ? (v as { state: string; questionCount: number }) : null;
  } catch {
    return null;
  }
}

/** The plan run's open questions (D17), projected from GET /runs/:id — the
 * SAME server artifact readiness derives from, never a client re-parse. Empty
 * for ready/unverified plans and every non-plan run. */
export async function fetchPlanQuestions(
  addr: ControlApiAddress,
  runId: string,
): Promise<import("@claudexor/schema").PlanQuestion[]> {
  if (!runId) return [];
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
    if (!res.ok) return [];
    const detail = (await res.json()) as Record<string, unknown>;
    const v = detail["planQuestions"];
    return Array.isArray(v) ? (v as import("@claudexor/schema").PlanQuestion[]) : [];
  } catch {
    return [];
  }
}

/** Council membership + merge disclosure (INV-031) for a --council plan run;
 * null for solo plans and non-plan runs. Server-projected — the CLI never
 * re-derives membership. */
export async function fetchCouncil(
  addr: ControlApiAddress,
  runId: string,
): Promise<{
  requested: number;
  drafted: number;
  degraded: boolean;
  mergedBy: string | null;
  members: { harnessId: string; role: string; status: string; error: string | null }[];
} | null> {
  if (!runId) return null;
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
    if (!res.ok) return null;
    const detail = (await res.json()) as Record<string, unknown>;
    const v = detail["council"];
    return v && typeof v === "object"
      ? (v as {
          requested: number;
          drafted: number;
          degraded: boolean;
          mergedBy: string | null;
          members: { harnessId: string; role: string; status: string; error: string | null }[];
        })
      : null;
  } catch {
    return null;
  }
}

/**
 * The sub-run's settled cash spend (USD) as projected by the control-plane
 * budget owner (`GET /runs/:id` → `summary.spendUsd`). Single producer of the
 * real drawn amount the delegation belt reconciles its reservation against;
 * null when the run has no known settled cost yet. Soft-fail — a detail hiccup
 * yields null, never an inflated commit.
 */
export async function fetchRunSpendUsd(
  addr: ControlApiAddress,
  runId: string,
): Promise<number | null> {
  if (!runId) return null;
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
    if (!res.ok) return null;
    const detail = (await res.json()) as Record<string, unknown>;
    const summary = detail["summary"];
    const spend =
      summary && typeof summary === "object"
        ? (summary as { spendUsd?: unknown }).spendUsd
        : undefined;
    return typeof spend === "number" && Number.isFinite(spend) ? spend : null;
  } catch {
    return null;
  }
}

/**
 * ONE GET /runs/:id for the terminal path (INV-120/122): fetch the run detail
 * once and feed every pure projection below, instead of one round-trip per
 * projection. Soft-fails to null (a detail hiccup must never eat a finished
 * run's result). The per-projection `fetch*` wrappers stay for callers that
 * need exactly one projection.
 */
export async function fetchRunDetail(
  addr: ControlApiAddress,
  runId: string,
): Promise<Record<string, unknown> | null> {
  if (!runId) return null;
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type ApplyEligibilityProjection = {
  eligible: boolean;
  state: string | null;
  reason: string | null;
  requiredAction: string | null;
};

/** Pure projection of the delivery-gate verdict from an already-fetched detail. */
export function projectApplyEligibility(
  detail: Record<string, unknown> | null,
): ApplyEligibilityProjection | null {
  if (!detail) return null;
  const v = detail["applyEligibility"];
  return v && typeof v === "object" ? (v as ApplyEligibilityProjection) : null;
}

export async function fetchApplyEligibility(
  addr: ControlApiAddress,
  runId: string,
): Promise<ApplyEligibilityProjection | null> {
  return projectApplyEligibility(await fetchRunDetail(addr, runId));
}

/**
 * The server-owned outcome banner for a run (D18): the single honest headline,
 * derived by the control-plane projection owner. The CLI PRINTS it verbatim —
 * it never re-derives a headline of its own, so model prose can never outrank
 * the arbitrated truth. Null while the run is not terminal or unavailable.
 */
/** Pure projection of the server-owned outcome banner from a fetched detail. */
export function projectOutcomeBanner(detail: Record<string, unknown> | null): string | null {
  if (!detail) return null;
  const banner = detail["outcomeBanner"];
  return typeof banner === "string" && banner.length > 0 ? banner : null;
}

export async function fetchOutcomeBanner(
  addr: ControlApiAddress,
  runId: string,
): Promise<string | null> {
  return projectOutcomeBanner(await fetchRunDetail(addr, runId));
}

/**
 * Machine-readable reason for a non-clean DAEMON terminal (P2, D8). A
 * needs-decision run (review blocked / checks failed) has a SUCCEEDED lifecycle
 * and no `error`, so key the actionable decision hint on the run FACTS, not on
 * the lifecycle; other non-succeeded lifecycles use the error or a reason
 * label. A clean succeeded run returns undefined (no `summary` key emitted).
 */
export function daemonOutcomeSummary(out: {
  runId: string;
  status: string;
  error?: string;
  outcomeFacts?: RunOutcomeFacts | null;
}): string | undefined {
  const facts = out.outcomeFacts ?? null;
  const needsDecision =
    !!facts &&
    facts.lifecycle === "succeeded" &&
    (facts.review === "blocked" || facts.checks === "failed");
  if (needsDecision) {
    return `run needs a human decision — claudexor decision ${out.runId} --accept-risk | --rerun --feedback "..."`;
  }
  if (out.error) return out.error;
  if (exitCodeForState(out.status) === 0) return undefined;
  return `run ${out.status}${facts?.reason ? ` (${facts.reason})` : ""}`;
}
