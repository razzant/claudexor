/**
 * Run lookup for `claudexor inspect` (claudexor#235): find the ArtifactStore
 * that owns a run from any cwd, or say exactly why the lookup stopped.
 *
 * Order: the cwd project store, the user-level Ask store, then the run
 * registry of an ALREADY-running daemon (GET /runs/:id). A read-only lookup
 * never auto-starts a daemon (#93), so a typo'd id cannot launch one. A local
 * retained run answers even while the daemon is down; its files prove the run
 * exists, not that it is live.
 *
 * Only the run registry's own 404 from a running daemon says `no such run`, and
 * it speaks for one store: `context.storeId` names the store that answered, when
 * known. A caller holding the run's receipt compares the two; a different or
 * missing store leaves the run unknown, and even the same store only proves that
 * it retains no such record, not that the run never started.
 * Every other stop is its own typed problem: a malformed id is a usage error;
 * without a reachable daemon, runs from other projects were not checked; a
 * lost connection is an incomplete lookup; daemon problems, other 404s and
 * invalid success bodies keep their codes; a known run with no run directory,
 * or whose recorded directory is missing or unreadable, names its state and
 * that exact path. Nothing here scans directories or infers liveness.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  ControlProblem,
  ControlRunDetail,
  ControlRunSummary,
  isTerminalLifecycle,
  TaskGroupReceipt,
} from "@claudexor/schema";
import { noProjectRepoRoot, userConfigDir } from "@claudexor/util";
import { CliError, controlProblemError, usageError } from "./cli-error.js";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { EXTERNAL_DAEMON_REMEDY, daemonOwner } from "./daemon-owner.js";
import { controlApiFetch } from "./live.js";
import { readRunDetailResponse } from "./run-detail-response.js";

export interface ResolvedRunStore {
  store: ArtifactStore;
  root: string;
  /** The id naming `root`: the caller's for a local hit, else the recorded run tree's (a job id resolves to its run). */
  runId: string;
}

// ArtifactStore.runPaths' id-shape fence, checked first so a malformed id is a
// typed usage error instead of a raw throw that breaks --json purity.
const RUN_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEGMENT_RULE = "a single path segment ([A-Za-z0-9._-], no separators)";

// The run-detail fields this lookup uses, with their canonical definitions. The
// rest of the detail is left unvalidated, as the loose read before #235 left
// it, so an additive same-major field elsewhere cannot fail the lookup.
const LOOKUP_RUN_DETAIL = ControlRunDetail.pick({ summary: true }).extend({
  summary: ControlRunSummary.pick({ state: true, runDir: true }),
});
type LookupSummary = Pick<ControlRunSummary, "state" | "runDir">;

export async function resolveRunStore(runId: string): Promise<ResolvedRunStore> {
  if (!RUN_ID_SEGMENT.test(runId)) {
    throw usageError(`invalid run id '${runId}': a run id is ${SEGMENT_RULE}`, {
      code: "invalid_argument",
      fieldErrors: { runId: [`must be ${SEGMENT_RULE}`] },
    });
  }
  for (const store of [
    new ArtifactStore(process.cwd()),
    new ArtifactStore(noProjectRepoRoot(), { claudexorDir: userConfigDir() }),
  ]) {
    const root = store.runPaths(runId).root;
    if (existsSync(root)) return { store, root, runId };
  }
  const connection = await connectDaemonIfRunning(); // a typed refusal (#93) propagates
  if (!connection) throw daemonAbsent(runId);
  let response: Response;
  let text: string;
  try {
    response = await controlApiFetch(connection.addr, `/runs/${encodeURIComponent(runId)}`);
    // The body is read inside the same guard, so a connection lost after the
    // headers is an incomplete lookup too.
    text = await response.text();
  } catch (error) {
    throw connectionLost(runId, error);
  }
  if (!response.ok) {
    const body = knownProblem(parseJson(text));
    // A fenced id always reaches the run-detail route, whose `http_404` problem
    // is the registry's absence verdict; any other 404 keeps its own problem.
    const problem = ControlProblem.safeParse(body).data;
    if (response.status === 404 && problem?.code === "http_404") {
      const store = TaskGroupReceipt.shape.storeId.safeParse(problem.context["storeId"]);
      throw new CliError(
        "operational",
        store.success
          ? `no such run ${runId} in engine store ${store.data}`
          : `no such run ${runId}`,
        {
          code: "run_not_found",
          retryable: false,
          ...(store.success ? { context: { storeId: store.data } } : {}),
        },
      );
    }
    throw controlProblemError(response.status, body, `run lookup failed (HTTP ${response.status})`);
  }
  const detail = await readRunDetailResponse(
    { json: async () => JSON.parse(text) as unknown },
    LOOKUP_RUN_DETAIL,
  );
  return knownRunStore(runId, detail["summary"] as LookupSummary);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A problem body's canonical fields when they form a valid ControlProblem, so
 * additive same-major fields cannot cost a known problem its recovery
 * metadata; any other body is passed on unchanged. */
function knownProblem(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const known = Object.fromEntries(
    Object.entries(body).filter(([key]) => key in ControlProblem.shape),
  );
  return ControlProblem.safeParse(known).success ? known : body;
}

/** A run the daemon knows: its recorded run directory, verbatim, is the only location used. */
function knownRunStore(runId: string, summary: LookupSummary): ResolvedRunStore {
  const { state, runDir } = summary;
  if (!runDir) {
    const ended = isTerminalLifecycle(state);
    throw new CliError(
      "operational",
      `run ${runId} is known to the daemon (state ${state}) but ${ended ? "ended without a run directory" : "has no run directory yet"}`,
      { code: "run_not_materialized", retryable: !ended, context: { state } },
    );
  }
  // <runtime>/runs/<tree id>: read exactly that tree, never a re-derived path.
  const treeId = basename(runDir);
  const claudexorDir = dirname(dirname(runDir));
  const store = new ArtifactStore(dirname(claudexorDir), { claudexorDir });
  const root = RUN_ID_SEGMENT.test(treeId) ? store.runPaths(treeId).root : "";
  if (!isAbsolute(runDir) || root !== resolve(runDir)) {
    throw new CliError(
      "operational",
      `run ${runId} is known to the daemon (state ${state}) but its recorded run directory ${runDir} is not a run store directory`,
      { code: "invalid_service_response", retryable: false, context: { state, runDir } },
    );
  }
  const unavailable = unavailableRunDir(root);
  if (unavailable) {
    throw new CliError(
      "operational",
      `run ${runId} is known to the daemon (state ${state}) but its run directory ${runDir} is ${unavailable.text}`,
      {
        code: "run_artifacts_unavailable",
        retryable: false,
        context: { state, runDir, reason: unavailable.reason },
      },
    );
  }
  return { store, root, runId: treeId };
}

function unavailableRunDir(root: string): { reason: string; text: string } | null {
  try {
    if (!statSync(root).isDirectory())
      return { reason: "not_a_directory", text: "not a directory" };
    accessSync(root, constants.R_OK | constants.X_OK);
    return null;
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code ?? "unknown";
    return errno === "ENOENT" || errno === "ENOTDIR"
      ? { reason: "missing", text: "missing" }
      : { reason: "not_accessible", text: `not accessible (${errno})` };
  }
}

function daemonAbsent(runId: string): CliError {
  const external = daemonOwner() === "external";
  const daemon = external
    ? "the managed Claudexor daemon is unavailable"
    : "no Claudexor daemon is reachable";
  return new CliError(
    "operational",
    `run ${runId} is not in the local run stores, and ${daemon} to look up runs from other projects`,
    {
      code: "daemon_unavailable",
      retryable: true,
      requiredActions: [
        external
          ? EXTERNAL_DAEMON_REMEDY
          : "start the daemon with `claudexor daemon start`, then retry",
      ],
    },
  );
}

function connectionLost(runId: string, error: unknown): CliError {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return new CliError(
    "operational",
    `the Claudexor daemon connection failed while looking up run ${runId}${typeof cause === "string" ? ` (${cause})` : ""}; retry the lookup`,
    { code: "daemon_unavailable", retryable: true },
  );
}
