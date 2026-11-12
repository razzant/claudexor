import {
  ControlRunDetail,
  isTerminalLifecycle,
  MCP_RUN_WAIT_INTERACTION_BYTES,
  MCP_RUN_WAIT_RESULT_BYTES,
  McpRunWaitInput,
  McpRunWaitResult,
} from "@claudexor/schema";
import { connectDaemonIfRunning } from "./daemon-run.js";
import type { ControlApiAddress } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";
import { canonicalRunId } from "./mcp-run-projections.js";
import { invalidServiceResponse, readObservationJson } from "./observation-read.js";
import { observeRunEvents, type Observation } from "./run-wait-events.js";

/** Discovery, each snapshot, and a zero-wait replay of available events each get this budget. */
const STAGE_BUDGET_MS = 5_000;

// Consume only schema-owned snapshot fields, never interpret model/event prose.
const Snapshot = ControlRunDetail.pick({
  lastSeq: true,
  pendingInteractions: true,
  deferredMessage: true,
}).extend({
  summary: ControlRunDetail.shape.summary.pick({ jobId: true, runId: true, state: true }),
  lastSeq: McpRunWaitResult.shape.snapshotSeq,
  pendingInteractions: ControlRunDetail.shape.pendingInteractions.removeDefault(),
});

/** The existing discovery API has no signal parameter; bound the caller's wait.
 * Its read-only handshake may still settle in the background after cancellation. */
export async function connectForObservation(signal?: AbortSignal) {
  signal?.throwIfAborted();
  let onAbort = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal?.reason ?? new Error("run observation aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error("run observation daemon discovery timed out"), {
            code: "run_observation_timeout",
            retryable: true,
          }),
        ),
      STAGE_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([connectDaemonIfRunning(), interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function snapshot(addr: ControlApiAddress, runId: string, signal?: AbortSignal) {
  const body = await readObservationJson(
    addr,
    `/runs/${encodeURIComponent(runId)}`,
    { method: "GET", timeoutMs: STAGE_BUDGET_MS, label: "run snapshot" },
    signal,
  );
  const parsed = Snapshot.safeParse(body);
  if (!parsed.success) throw invalidServiceResponse("daemon returned an invalid run snapshot");
  return { ...parsed.data, runId: canonicalRunId(runId, parsed.data.summary) };
}

/** Precedence: abort, terminal lifecycle, a question event in the page or one too large
 * for any page (claudexor_run_interactions reads it complete), then the stream's own stop. */
function wakeReason(
  aborted: boolean,
  terminal: boolean,
  observed: Observation | null,
): McpRunWaitResult["wakeReason"] {
  if (aborted || observed?.stop === "aborted") return "aborted";
  if (terminal) return "terminal";
  if (!observed) return "timeout";
  if (observed.questionRequested || observed.oversizedEvent?.type === "interaction.requested")
    return "interactions";
  if (observed.stop === "limit" || (observed.stop === "ready" && observed.events.length > 0))
    return "events";
  if (observed.stop === "ended" || observed.stop === "disconnected") return "disconnected";
  return "timeout";
}

/** Bounded read-only projection. Aborting observation never invokes makeCancelBridge. */
export async function runWaitQuery(
  rawInput: Record<string, unknown>,
  beltContext = false,
  signal?: AbortSignal,
): Promise<McpRunWaitResult> {
  if (beltContext)
    throw Object.assign(new Error("the delegation belt cannot wait on runs"), {
      code: "delegation_forbidden",
      status: 403,
    });
  const input = McpRunWaitInput.parse(rawInput);
  signal?.throwIfAborted();
  const connection = await connectForObservation(signal);
  if (!connection) throw daemonUnavailableError(false, "run observation does not start one");
  signal?.throwIfAborted();
  let latest = await snapshot(connection.addr, input.runId, signal);
  const result: McpRunWaitResult = {
    runId: latest.runId,
    status: latest.summary.state,
    snapshotSeq: latest.lastSeq,
    snapshotPhase: "before_wait",
    snapshotProblem: null,
    nextSeq: input.afterSeq,
    events: [],
    eventOmission: null,
    oversizedEvent: null,
    pendingInteractions: [],
    pendingInteractionCount: 0,
    omittedInteractions: 0,
    wakeReason: "timeout",
  };
  // Events already written at the fence are returned whether or not a question
  // is pending; only a live wait waits for new ones.
  const live = input.waitMs > 0 && !isTerminalLifecycle(latest.summary.state);
  let observed: Observation | null = null;
  if (latest.lastSeq > input.afterSeq || live) {
    observed = await observeRunEvents(
      connection.addr,
      input,
      {
        fence: latest.lastSeq,
        live,
        deadlineMs: input.waitMs > 0 ? input.waitMs : STAGE_BUDGET_MS,
      },
      signal,
    );
    const { questionRequested: _question, stop: _stop, ...page } = observed;
    Object.assign(result, page);
    if (input.waitMs > 0 && !signal?.aborted) {
      try {
        latest = await snapshot(connection.addr, input.runId, signal);
        result.snapshotPhase = "after_wait";
      } catch {
        result.snapshotProblem = "snapshot_unavailable";
      }
    }
  }
  result.runId = latest.runId;
  result.status = latest.summary.state;
  result.snapshotSeq = latest.lastSeq;
  result.pendingInteractionCount = latest.pendingInteractions.length;
  let interactionBytes = 2;
  for (const pending of latest.pendingInteractions) {
    const bytes =
      Buffer.byteLength(JSON.stringify(pending)) + (result.pendingInteractions.length ? 1 : 0);
    if (interactionBytes + bytes > MCP_RUN_WAIT_INTERACTION_BYTES) break;
    interactionBytes += bytes;
    result.pendingInteractions.push(pending);
  }
  result.deferredMessage = latest.deferredMessage ?? null;
  result.omittedInteractions = result.pendingInteractionCount - result.pendingInteractions.length;
  result.wakeReason = wakeReason(
    signal?.aborted === true,
    isTerminalLifecycle(result.status),
    observed,
  );
  // The event and interaction budgets leave room for all remaining scalar fields.
  if (Buffer.byteLength(JSON.stringify(result)) > MCP_RUN_WAIT_RESULT_BYTES)
    throw new Error("run observation exceeded its response byte budget");
  return result;
}
