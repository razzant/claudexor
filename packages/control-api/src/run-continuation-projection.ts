/**
 * Run-status projection of the `continueFrom` chain: the terminal `resumable`
 * block (INTERFACES §2), the per-try `continuity` receipts (§3), the
 * predecessor link and a kept envelope's disk use. Projected verbatim from
 * engine artifacts; surfaces never re-derive these facts.
 *
 * `resumable` comes from `final/resumable.yaml` (written by the engine at its
 * terminal) with the CURRENT workspace overlaid: the envelope a run keeps
 * (custody `retained`) or, once a successor adopted it or the run was
 * discarded, none. A run the daemon found running at its restart never reached
 * an engine terminal: its block is derived here from the source the
 * successor's planner would use (`continuationSource`, its
 * `ownsContinuationSource` rule) and the custody record (cause `host_restart`),
 * so it can be continued.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  RunContinuityReceipt,
  RunResumable,
  type ControlRunSummary,
  type RunEvent,
  type SessionCapsule,
} from "@claudexor/schema";
import {
  continuationSource,
  executionFactsOf,
  readContinuationSources,
  retainedEnvelopeInChain,
  retainedEnvelopeOfRun,
  runExecutionFacts,
  type ExecutionFold,
  type RunExecutionFacts,
} from "@claudexor/workspace";
import { safeReadStructuredArtifact } from "./run-artifact-read.js";
import { paramsRecord, type DaemonRunRecord } from "./run-record.js";
import { TERMINAL_STATES } from "./sse-shared.js";

function inPlaceRoot(params: Record<string, unknown>): string | null {
  const execution = params["execution"] as Record<string, unknown> | undefined;
  if (execution?.["isolation"] !== "live") return null;
  const scope = params["scope"] as Record<string, unknown> | undefined;
  const root = execution["workspaceRoot"] ?? scope?.["root"];
  return typeof root === "string" ? root : null;
}

type Continuation = Pick<
  ControlRunSummary,
  "continueFrom" | "resumable" | "retainedEnvelope" | "continuity"
>;

/** One `run.continuity` event's typed per-try receipt, else null. */
export function continuityReceiptOf(event: Record<string, unknown>): RunContinuityReceipt | null {
  if (event["type"] !== "run.continuity") return null;
  const payload = event["payload"] as Record<string, unknown> | undefined;
  const receipt = RunContinuityReceipt.safeParse(payload?.["receipt"]);
  return receipt.success ? receipt.data : null;
}

/** The chain facts of one run; run detail adds the per-try receipts, from its
 * events or already folded from them. `foldedFacts` reads an ancestor's
 * execution facts from run detail's bounded event fold, when the caller has one. */
export function continuationSummary(
  rec: DaemonRunRecord,
  events?:
    | readonly Record<string, unknown>[]
    | { continuity: RunContinuityReceipt[]; execution?: ExecutionFold },
  foldedFacts?: (runDir: string) => RunExecutionFacts,
): Continuation {
  const params = paramsRecord(rec);
  const continueFrom = typeof params["continueFrom"] === "string" ? params["continueFrom"] : null;
  const continuity = !events
    ? undefined
    : "continuity" in events
      ? events.continuity
      : events.flatMap((event) => continuityReceiptOf(event) ?? []);
  const base = { continueFrom, ...(continuity ? { continuity } : {}) };
  if (!rec.runDir || !TERMINAL_STATES.has(rec.state)) {
    return { ...base, resumable: null, retainedEnvelope: null };
  }
  const kept = retainedEnvelopeOfRun(rec.runDir, rec.runId ?? rec.id);
  const retainedEnvelope = kept
    ? {
        root: kept.envelope.worktree_path,
        bytes: kept.bytes,
        retainedAt: kept.retained_at ?? "",
        cause: kept.cause,
      }
    : null;
  const sources = readContinuationSources(rec.runDir);
  const available = kept ?? retainedEnvelopeInChain(sources);
  const keptWorkspace = available
    ? { kind: "retained_envelope" as const, root: available.envelope.worktree_path }
    : null;
  let written = safeReadStructuredArtifact(rec, "final/resumable.yaml", RunResumable);
  // The successor planner's own source and chain walk, read only for a derived
  // block: the head is its own source when it holds a session or recorded work
  // (`ownsContinuationSource`), else the nearest ancestor that is. A run's
  // events are asked for only when its terminal records do not decide: run
  // detail's bounded event fold (the head's, an ancestor's through
  // `foldedFacts`), else one read, once per cached list summary.
  const runDir = rec.runDir;
  const fold = events && "continuity" in events ? events.execution : undefined;
  const recorded = !events
    ? undefined
    : "continuity" in events
      ? fold && (() => executionFactsOf(fold))
      : () => runExecutionFacts(events as readonly RunEvent[]);
  const own = () => continuationSource(runDir, recorded);
  let capsule: SessionCapsule | null = null;
  let inherited = false;
  let inheritedState: string | null = null;
  if (!written && rec.state !== "succeeded") {
    const head = own();
    capsule = head.held?.capsule ?? null;
    if (!head.owns)
      for (const source of sources) {
        const ancestor = continuationSource(
          source.runDir,
          foldedFacts && (() => foldedFacts(source.runDir)),
        );
        if (!ancestor.owns) continue;
        const record = { ...source, id: source.runId };
        written = safeReadStructuredArtifact(record, "final/resumable.yaml", RunResumable);
        capsule = ancestor.held?.capsule ?? null;
        inherited = true;
        inheritedState = source.state;
        break;
      }
  }
  if (written) {
    const workspace =
      keptWorkspace ??
      (written.workspace.kind === "retained_envelope"
        ? { kind: "none" as const, root: null }
        : written.workspace);
    return { ...base, resumable: { ...written, workspace }, retainedEnvelope };
  }
  const restarted =
    rec.state === "interrupted" && !existsSync(join(rec.runDir, "final", "run_facts.yaml"));
  if (!restarted && !kept && !inherited) return { ...base, resumable: null, retainedEnvelope };
  if (rec.state === "succeeded") capsule = own().held?.capsule ?? null;
  const root = inPlaceRoot(params);
  return {
    ...base,
    retainedEnvelope,
    resumable: {
      cause: restarted
        ? "host_restart"
        : (available?.cause ?? (inheritedState === "interrupted" ? "host_restart" : "other")),
      resetsAt: null,
      limitWindow: null,
      limitEvidence: null,
      // A fresh session briefed by the evidence index is always available; the
      // native session when its capsule survived.
      carriers: capsule ? ["native", "packet"] : ["packet"],
      limitCode: null,
      session: capsule
        ? {
            harness: capsule.harness,
            nativeSessionId: capsule.nativeSessionId,
            holderProfileId: capsule.holderProfileId,
          }
        : null,
      workspace:
        keptWorkspace ?? (root ? { kind: "in_place", root } : { kind: "none", root: null }),
    },
  };
}
