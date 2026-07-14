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
import {
  controlApiAddress,
  controlApiFetch,
  handshakeControlApi,
  type ControlApiAddress,
} from "./live.js";

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

const TERMINAL_STATES = new Set([
  "succeeded",
  "no_op",
  "ungated",
  "review_not_run",
  "blocked",
  "failed",
  "cancelled",
  "interrupted",
  "exhausted",
  "not_converged",
  "stuck_no_progress",
]);

export interface DaemonRunOutcome {
  runId: string;
  runDir: string;
  /** The daemon job state (honest terminal: succeeded | blocked | failed | no_op | ...). */
  status: string;
  jobId: string;
  error?: string;
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
  const startRes = await controlApiFetch(addr, "/runs", {
    method: "POST",
    headers: { Authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const startText = await startRes.text();
  const start = startText ? (JSON.parse(startText) as Record<string, unknown>) : {};
  if (!startRes.ok) {
    throw new Error(
      typeof start["error"] === "string"
        ? (start["error"] as string)
        : `run enqueue failed (HTTP ${startRes.status})`,
    );
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
        return { runId: rec.runId ?? "", runDir: "", status: rec.state, jobId, error: rec.error };
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
        };
      }
      if (opts.onPollTick) await opts.onPollTick({ runId: rec.runId ?? runId });
      await sleep(250);
    }
  } finally {
    removeSignalHandlers();
  }
}

/** Daemon job state -> CLI exit code (success terminals are 0; everything else 1). */
export function exitCodeForState(state: string): number {
  return state === "succeeded" ||
    state === "no_op" ||
    state === "ungated" ||
    state === "review_not_run"
    ? 0
    : 1;
}

/**
 * The run's derived apply-gate verdict from GET /runs/:id (single producer:
 * the delivery gate via the control API). Soft-fails to null — a detail
 * hiccup must never eat a finished run's result. Shared by the CLI post-run
 * hints and the MCP structured results so both surfaces tell the same truth.
 */
export async function fetchApplyEligibility(
  addr: ControlApiAddress,
  runId: string,
): Promise<{
  eligible: boolean;
  state: string | null;
  reason: string | null;
  requiredAction: string | null;
} | null> {
  if (!runId) return null;
  try {
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
    if (!res.ok) return null;
    const detail = (await res.json()) as Record<string, unknown>;
    const v = detail["applyEligibility"];
    return v && typeof v === "object"
      ? (v as {
          eligible: boolean;
          state: string | null;
          reason: string | null;
          requiredAction: string | null;
        })
      : null;
  } catch {
    return null;
  }
}

/**
 * Machine-readable reason for a non-success DAEMON terminal (P2). `blocked` is a
 * needs-human terminal that carries no `error`, so surface the actionable decision
 * hint (mirrors text mode); other non-success terminals use the error or a state
 * label. Success terminals return undefined (no `summary` key emitted).
 */
export function daemonOutcomeSummary(out: {
  runId: string;
  status: string;
  error?: string;
}): string | undefined {
  if (out.error) return out.error;
  if (exitCodeForState(out.status) === 0) return undefined;
  if (out.status === "blocked") {
    return `run blocked: needs a human decision — claudexor decision ${out.runId} --accept-risk | --rerun --feedback "..."`;
  }
  return `run ${out.status}`;
}
