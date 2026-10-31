/**
 * Envelope custody of a single-candidate Agent run (A9, PLAN §2.2).
 *
 * Start: a `continueFrom` successor adopts its predecessor's retained envelope
 * (same path, base and files); any other single-candidate mutating run gets a
 * fresh isolated envelope with `live` custody recorded before the harness runs.
 * End: the envelope is kept (`retained`) when the work stopped unfinished
 * (a non-success run terminal, or a needs_input / incomplete report) AND there is
 * something to continue (a tree that differs from its base, or a native
 * session capsule); otherwise it is disposed as before. Race candidates,
 * synthesis, review and in-place envelopes are untouched.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventLog } from "@claudexor/event-log";
import {
  RunResumable,
  type EnvelopeCustody,
  type ResumableCause,
  type RunOutcomeFacts,
  type WorkspaceEnvelope,
} from "@claudexor/schema";
import {
  adoptRetainedEnvelope,
  envelopeBaseOf,
  envelopeTreeChanged,
  readEnvelopeCustody,
  retainForContinuation,
  retainedEnvelopeOfRun,
  type CreateEnvelopeOptions,
  type WorkspaceManager,
} from "@claudexor/workspace";
import { hasCandidateChanges, type CandidateRun } from "./candidateEvidence.js";
import type { ContinueFromSource } from "./continue-from.js";
import type { ContinuationPlan } from "./continuation-later.js";
import type { AnnouncedRunContext } from "./runTerminalContext.js";
import { safeErrorMessage } from "./runSupport.js";

interface EnvelopeHolder {
  runId: string;
  runDir: string;
}

/** The per-attempt native session capsule file, written by the in-run
 * continuation loop when `started` reports a native session id. */
export function sessionCapsuleFile(attemptDir: string): string {
  return join(attemptDir, "session-capsule.json");
}

/** What the daemon hands a run about continuation (`RunInput.continuation`). */
export interface RunContinuation {
  /** Keep this run's stopped work for `continueFrom`. Only a daemon-owned run
   * sets it: only the daemon admits a successor or discards a kept envelope. */
  retain: boolean;
  /** The predecessor's retained envelope this run adopts (`continueFrom`). */
  adopt?: EnvelopeCustody | null;
  /** The predecessor whose work the first candidate attempt continues
   * (`continueFrom`); consumed by that attempt (`continue-from.ts`). */
  from?: ContinueFromSource | null;
  /** What that consumed plan leaves for a later fallback or checkpoint attempt. */
  planned?: ContinuationPlan | null;
}

/**
 * The custody hooks of one run's candidate slot: `envelope` creates (or, for a
 * `continueFrom` successor, adopts) the candidate's envelope; `settle` keeps or
 * stages it until the final run outcome. Only a daemon-owned, single-candidate,
 * mutating run (`keepable`) records custody; every other run keeps today's
 * create/dispose behaviour.
 */
export function forRun(
  input: { continuation?: RunContinuation; signal?: AbortSignal },
  keepable: boolean,
  runId: string,
  paths: { root: string; attemptsDir: string },
  log?: EventLog,
) {
  const holder: EnvelopeHolder | null =
    input.continuation?.retain && keepable ? { runId, runDir: paths.root } : null;
  const pending = new Map<
    string,
    { wsm: WorkspaceManager; env: WorkspaceEnvelope; runs: readonly (CandidateRun | undefined)[] }
  >();
  const finish = async (facts: RunOutcomeFacts) => {
    for (const { wsm, env, runs } of pending.values()) {
      await settleCandidateEnvelope(wsm, env, {
        runs,
        signal: input.signal,
        attemptsDir: paths.attemptsDir,
        log,
        facts,
      });
      pending.delete(env.id);
    }
  };
  if (holder && log) {
    log.deferTerminal();
    pendingRuns.set(log, finish);
  }
  return {
    envelope: async (wsm: WorkspaceManager, opts: CreateEnvelopeOptions) => {
      const env = await candidateEnvelope(
        wsm,
        holder,
        holder ? (input.continuation?.adopt ?? null) : null,
        opts,
      );
      if (holder && readEnvelopeCustody(envelopeBaseOf(env))?.holder_run_id === holder.runId)
        pending.set(env.id, { wsm, env, runs: [] });
      return env;
    },
    settle: async (
      wsm: WorkspaceManager,
      env: WorkspaceEnvelope,
      runs: readonly (CandidateRun | undefined)[],
    ) => {
      if (pending.has(env.id)) pending.set(env.id, { wsm, env, runs });
      else await wsm.dispose(env);
    },
    finish,
  };
}

/**
 * The candidate's envelope: the predecessor's retained envelope when `adopt`
 * hands one over (adoption transfers custody, never deletes), else a new one —
 * with `live` custody when `holder` says this run may keep it.
 */
async function candidateEnvelope(
  wsm: WorkspaceManager,
  holder: EnvelopeHolder | null,
  adopt: EnvelopeCustody | null,
  opts: CreateEnvelopeOptions,
): Promise<WorkspaceEnvelope> {
  if (!holder || opts.inPlace || opts.workspaceKind === "directory") return wsm.create(opts);
  if (adopt) return adoptRetainedEnvelope(adopt, holder);
  return wsm.create({ ...opts, custody: holder });
}

/** Why the candidate's work is unfinished (null = unfinished, cause not known
 * at this layer), or undefined when it finished. */
function unfinishedCause(
  run: CandidateRun | undefined,
  signal: AbortSignal | undefined,
  facts: RunOutcomeFacts,
): ResumableCause | null | undefined {
  if (signal?.aborted) return signal.reason === "wall_clock_exceeded" ? "wall_clock" : "cancelled";
  const state = run?.telemetry.outcome?.workState?.state;
  if (state === "needs_input") return "input_required";
  if (facts.lifecycle !== "succeeded")
    return facts.reason === "context_capacity_exhausted"
      ? "context_exhausted"
      : (run?.resumable?.cause ?? null);
  return state === "incomplete" ? null : undefined;
}

async function worthKeeping(
  env: WorkspaceEnvelope,
  run: CandidateRun | undefined,
  attemptsDir: string,
): Promise<boolean> {
  if (run && hasCandidateChanges(run)) return true;
  const attempts = new Set([env.attempt_id, ...(run ? [run.attemptId] : [])]);
  if ([...attempts].some((id) => existsSync(sessionCapsuleFile(join(attemptsDir, id))))) {
    return true;
  }
  return (await envelopeTreeChanged(env)) === true;
}

type SettlementStage = "custody" | "dispose" | "retain" | "resumable";

/**
 * One typed diagnostic for a settlement failure, emitted before the deferred
 * terminal is published (MCP run detail carries no timeline). It never changes
 * the outcome: its own failure is ignored, and the original error keeps its path.
 */
function settlementFailed(
  log: EventLog | undefined,
  env: WorkspaceEnvelope,
  stage: SettlementStage,
  error: unknown,
): void {
  try {
    log?.emit("workspace.settlement_failed", {
      attempt_id: env.attempt_id,
      envelope_id: env.id,
      root: env.worktree_path,
      stage,
      cause: safeErrorMessage(error),
    });
  } catch {
    // Best effort: the terminal is still flushed and nothing is retried.
  }
}

/**
 * End of a candidate: keep or dispose its envelope. Only an envelope under
 * this run's `live` custody can be kept; everything else is disposed exactly
 * as before. Keeping is durable before the run's terminal is reported and is
 * disclosed with a `workspace.retained` event (disk use measured once); a
 * failure at any stage is disclosed as `workspace.settlement_failed`.
 */
async function settleCandidateEnvelope(
  wsm: WorkspaceManager,
  env: WorkspaceEnvelope,
  ctx: {
    runs: readonly (CandidateRun | undefined)[];
    signal?: AbortSignal;
    attemptsDir: string;
    log?: EventLog;
    facts: RunOutcomeFacts;
  },
): Promise<void> {
  let stage: SettlementStage = "custody";
  try {
    const custody = readEnvelopeCustody(envelopeBaseOf(env));
    if (custody?.state !== "live" || custody.envelope.id !== env.id) {
      stage = "dispose";
      return await wsm.dispose(env);
    }
    const run = ctx.runs.find((candidate) => candidate?.reviewCwd === env.worktree_path);
    const cause = unfinishedCause(run, ctx.signal, ctx.facts);
    stage = "retain";
    if (cause === undefined || !(await worthKeeping(env, run, ctx.attemptsDir))) {
      stage = "dispose";
      return await wsm.dispose(env);
    }
    const holder = { runId: custody.holder_run_id, runDir: custody.holder_run_dir };
    const retained = retainForContinuation(env, holder, cause);
    // The terminal `resumable` block (written after this settle) names the kept tree.
    // Deferred terminal payloads share these workspace objects, including a
    // resumableOnFailure promoted by the final budget verdict.
    for (const resumable of [run?.resumable, run?.resumableOnFailure])
      if (resumable)
        Object.assign(resumable.workspace, { kind: "retained_envelope", root: env.worktree_path });
    ctx.log?.emit("workspace.retained", {
      attempt_id: run?.attemptId ?? env.attempt_id,
      root: env.worktree_path,
      cause,
      bytes: retained.bytes,
    });
  } catch (error) {
    settlementFailed(ctx.log, env, stage, error);
    throw error;
  }
}

const pendingRuns = new WeakMap<EventLog, (facts: RunOutcomeFacts) => Promise<void>>();

/** Settle custody after the strategy and Delegate budget verdict, before terminal publication. */
export async function flushContinuationTerminal(
  context: AnnouncedRunContext,
  facts: RunOutcomeFacts,
): Promise<void> {
  const finish = pendingRuns.get(context.log);
  try {
    if (finish) {
      await finish(facts);
      const kept = retainedEnvelopeOfRun(context.paths.root, context.runId);
      const path = join(context.paths.finalDir, "resumable.yaml");
      const resumable = RunResumable.safeParse(context.store.readYaml(path)).data;
      try {
        if (kept && resumable)
          context.store.writeYaml(path, {
            ...resumable,
            workspace: { kind: "retained_envelope", root: kept.envelope.worktree_path },
          });
      } catch (error) {
        if (kept) settlementFailed(context.log, kept.envelope, "resumable", error);
        throw error;
      }
    }
  } finally {
    pendingRuns.delete(context.log);
    context.log.flushDeferredTerminal();
  }
}
