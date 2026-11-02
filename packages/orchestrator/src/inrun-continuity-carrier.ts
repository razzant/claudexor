/**
 * The in-run continuation's I/O-bearing seams, split out of the per-attempt
 * controller (`inrun-continuity.ts`) so the controller stays a readable state
 * machine: composing the spec of a continued try (carrier → prompt/resume id),
 * the moved-session thread disclosure (INV-137), the uncertain-input
 * reference, the per-try receipt and the terminal `resumable` block. Free
 * functions over explicit inputs; the controller owns the mutable state.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HarnessRunSpec as HarnessRunSpecSchema,
  RunContinuityReceipt as RunContinuityReceiptSchema,
  type ContinuityIdentityCheck,
  type HarnessRunSpec,
  type ResumableCause,
  type RunContinuityReceipt,
  type RunResumable,
  type SessionCapsule,
} from "@claudexor/schema";
import { decideCarrier, prepareCarrier, type CarrierFacts } from "./carrier-planner.js";
import { readlessWorkOrder } from "./continuation-evidence.js";
import {
  diffStatFromPatch,
  steeringFromRunLog,
  workOrderFile,
} from "./continuation-evidence-io.js";
import { completeInputPath, type UncertainInput } from "./continuation-input.js";
import { continuationNotice, packetContinuationPrompt } from "./continuity-notice.js";
import type { AfterTryVerdict, InRunContinuityDeps, TryFacts } from "./inrun-continuity-types.js";
import { routeListsModel } from "./modelGovernance.js";
import {
  registryProfile,
  relocateSessionCapsule,
  storeEnvFor,
  writeSessionCapsule,
} from "./session-capsule.js";

/** What the controller remembers about the try it prepared as a continuation. */
export interface ContinuedTry {
  carrier: RunContinuityReceipt["carrier"];
  cause: ResumableCause;
  fromProfileId: string | null;
  toProfileId: string | null;
  memory: RunContinuityReceipt["memory"];
  inputDelivery: RunContinuityReceipt["inputDelivery"];
  /** The first try of a `continueFrom` successor: the predecessor's run and
   * attempt, and whether this run executes in its root. In-run tries leave
   * both unset (this run, same root). */
  from?: { runId: string; attemptId: string };
  workspace?: RunContinuityReceipt["workspace"];
  summarized: boolean;
  /** Set only when a native_moved carrier invoked the source's retirement. */
  sourceRetirement?: RunContinuityReceipt["sourceRetirement"];
}

/** Retire a moved session's source only after its new holder was published:
 * removal that fails, possibly part-way, is not a confirmed retirement. */
export async function retireMovedSource(
  retire: (() => void | Promise<void>) | undefined,
): Promise<Pick<ContinuedTry, "sourceRetirement">> {
  if (!retire) return {};
  try {
    await retire();
    return { sourceRetirement: "retired" };
  } catch {
    return { sourceRetirement: "not_confirmed" };
  }
}

/** Attempts of this run whose work this attempt carries: itself and the earlier
 * serial attempts its seed re-briefs (a fallback or checkpoint continuation). */
export function carriedRunAttempts(deps: InRunContinuityDeps): ReadonlySet<string> {
  const earlier = (deps.seed?.evidenceSources ?? [])
    .filter((source) => source.runDir === deps.runDir)
    .flatMap((source) => source.attemptIds ?? [source.attemptId]);
  return new Set([...earlier, deps.attemptId]);
}

/** The typed limit that ended a try (A11 evidence quality). */
export interface LimitEvidenceState {
  resetsAt: string | null;
  retryDelayMs: number | null;
  constraintId: string | null;
  /** `unknown`: a usage refusal that names no reopening time (#558); never a same-account retry. */
  reopening?: "unknown" | null;
}

export interface ContinuedTryContext {
  deps: InRunContinuityDeps;
  capsule: SessionCapsule | null;
  acted: boolean;
  nativeRejected: boolean;
  /** Index of the try that just settled; the successor is `tryIndex + 1`. */
  tryIndex: number;
  uncertainInput: string | null;
  retainedOutput: string;
  /** History quality of the capsule's session (a packet-born session stays partial). */
  sessionMemory: RunContinuityReceipt["memory"];
}

export interface ComposedContinuedTry {
  verdict: AfterTryVerdict;
  /** Null for a fresh replay (today's rule). */
  continued: ContinuedTry | null;
  /** The capsule after a native location/move (the new holder), or null when unchanged. */
  capsule: SessionCapsule | null;
}

function profileRef(deps: InRunContinuityDeps, spec: HarnessRunSpec, profileId: string | null) {
  const row = registryProfile(deps.registry, profileId, deps.adapter.id);
  return {
    profileId,
    env: storeEnvFor(spec.env, row),
    storeLocator: row?.isolation_locator ?? null,
  };
}

/** Plan and prepare the carrier for the next try, then compose its spec. */
export async function composeContinuedTry(
  ctx: ContinuedTryContext,
  facts: TryFacts,
  base: HarnessRunSpec,
  cause: ResumableCause,
  delayMs: number,
): Promise<ComposedContinuedTry> {
  const { deps } = ctx;
  const completed = deps.seed?.completed;
  const from = facts.runSpec.credential_profile?.profile_id ?? null;
  const to = base.credential_profile?.profile_id ?? null;
  const effectiveModel = facts.telemetry.observedModel ?? base.model_hint ?? null;
  const carrierFacts: CarrierFacts = {
    capsule: ctx.capsule,
    acted: ctx.acted,
    cause,
    sourceProfile: profileRef(
      deps,
      facts.runSpec,
      ctx.capsule ? ctx.capsule.holderProfileId : from,
    ),
    targetProfile: profileRef(deps, base, to),
    effectiveModel,
    preference: "auto",
    adapter: deps.adapter,
    nativeRejected: ctx.nativeRejected,
  };
  const wholeWorkOrder = readlessWorkOrder(deps.route, deps.workOrder, deps.firstPrompt);
  const prepared = await prepareCarrier(decideCarrier(carrierFacts), {
    facts: carrierFacts,
    evidence: {
      runDir: deps.runDir,
      attemptId: deps.attemptId,
      workOrder: deps.workOrder,
      workOrderPath: wholeWorkOrder ? null : workOrderFile(deps.runDir),
      workOrderInPrompt: wholeWorkOrder !== null,
      steering: [],
      predecessors: deps.seed?.evidenceSources,
    },
    targetCwd: base.cwd,
    retainedOutput: ctx.retainedOutput,
    diffStat: facts.currentDiff ? diffStatFromPatch(facts.currentDiff) : null,
    completed,
  });
  if (prepared.carrier === "fresh") {
    return {
      verdict: { kind: "continue", spec: base, delayMs },
      continued: null,
      capsule: null,
    };
  }
  const notice = continuationNotice({
    cause,
    completed,
    uncertainInput: ctx.uncertainInput,
    callerText: null,
  });
  // A null hint must not re-resolve to another default on any continued try:
  // native and packet carriers pin the attested model, but only an id the route itself
  // lists — an observed display label is never sent as a model id.
  const attested = facts.telemetry.observedModel;
  const pinned =
    base.model_hint == null && attested
      ? !!deps.route && (await routeListsModel(deps.route, base, attested))
      : false;
  const modelHint = base.model_hint ?? (pinned ? attested : null);
  const continued: ContinuedTry = {
    carrier: prepared.carrier,
    summarized: prepared.carrier === "packet" && prepared.packet.summarized,
    cause,
    fromProfileId: from,
    toProfileId: to,
    memory: prepared.carrier === "packet" ? "partial" : ctx.sessionMemory,
    inputDelivery: ctx.uncertainInput === null ? "confirmed" : "uncertain",
  };
  if (prepared.carrier === "packet") {
    const dir = join(deps.attemptDir, "continuation");
    mkdirSync(dir, { recursive: true });
    const evidencePath = join(dir, `evidence-index-try${ctx.tryIndex + 1}.md`);
    writeFileSync(evidencePath, prepared.packet.markdown);
    const spec = HarnessRunSpecSchema.parse({
      ...base,
      model_hint: modelHint,
      resume_session_id: null,
      prompt: packetContinuationPrompt({
        originalPrompt: deps.firstPrompt,
        notice,
        evidencePath,
        evidenceMarkdown: prepared.packet.markdown,
        completed,
        workOrder: wholeWorkOrder,
      }),
    });
    return { verdict: { kind: "continue", spec, delayMs }, continued, capsule: null };
  }
  writeSessionCapsule(deps.attemptDir, prepared.capsule);
  // The capsule names the new holder; a source that cannot be retired (a held
  // file handle, a read-only store) leaves a stale copy, never a failed attempt.
  Object.assign(continued, await retireMovedSource(prepared.retire));
  const spec = HarnessRunSpecSchema.parse({
    ...base,
    model_hint: modelHint,
    resume_session_id: prepared.resumeRef.nativeSessionId,
    prompt: notice,
  });
  return {
    verdict: { kind: "continue", spec, delayMs },
    continued,
    capsule: prepared.capsule,
  };
}

/** The predecessor's input that may not be in the vendor history: the last
 * caller-authored work order if the first try died before `started`, plus unconfirmed
 * steering messages (`message.accepted` with no `message.delivered`), the chain's
 * included while no newer run has started. */
export function uncertainInputFor(
  runDir: string,
  previousInputs: readonly UncertainInput[],
  attempts: ReadonlySet<string> | undefined,
  currentRunDir = runDir,
): string | null {
  // Caller inputs arrive newest first. Steering is newer than the caller
  // text of its own run, but older than any subsequent continuation's text.
  const inputs = [...previousInputs];
  const sameRun = inputs.findIndex((input) => input.runDir === runDir);
  const steering = steeringFromRunLog(runDir, attempts)
    .filter((message) => message.delivery === "uncertain")
    .reverse()
    .map(({ text }) => ({ text, runDir }))
    .filter((message) => !inputs.some((i) => i.runDir === runDir && i.text === message.text));
  inputs.splice(sameRun < 0 ? inputs.length : sameRun, 0, ...steering);
  let remaining = 2048;
  const parts = inputs.map((input) => {
    const shown = Math.min(remaining, input.text.length);
    remaining -= shown;
    const quote = input.text.slice(0, shown);
    return shown === input.text.length
      ? quote
      : `${quote}\n[cut: ${shown} of ${input.text.length} characters; the complete text is in ${completeInputPath(input, currentRunDir)}]`;
  });
  return parts.length ? parts.join("\n\n") : null;
}

/** The receipt of a continued try (per-try model attestation, never borrowed). */
export function continuityReceipt(input: {
  deps: InRunContinuityDeps;
  continued: ContinuedTry;
  tryIndex: number;
  requestedModel: string | null;
  observedModel: string | null;
  nativeRejected: boolean;
  identity: ContinuityIdentityCheck;
  reingestedTokens: number | null;
}): RunContinuityReceipt {
  const { deps, continued, requestedModel: requested, observedModel: observed } = input;
  return RunContinuityReceiptSchema.parse({
    tryIndex: input.tryIndex,
    attemptId: deps.attemptId,
    carrier: continued.carrier,
    cause: continued.cause,
    from: {
      runId: continued.from?.runId ?? deps.runId,
      attemptId: continued.from?.attemptId ?? deps.attemptId,
      profileId: continued.fromProfileId,
    },
    to: { profileId: continued.toProfileId },
    workspace: continued.workspace ?? "same_root",
    memory: continued.memory === "full" && input.nativeRejected ? "unknown" : continued.memory,
    instructions: "as_sent",
    reingestedTokens: input.reingestedTokens,
    observedModel: observed,
    modelMismatch: requested !== null && observed !== null ? requested !== observed : null,
    identityCheck: continued.carrier === "packet" ? "not_applicable" : input.identity,
    inputDelivery: continued.inputDelivery,
    ...(continued.sourceRetirement ? { sourceRetirement: continued.sourceRetirement } : {}),
  });
}

/** The terminal `resumable` block of an attempt whose work is unfinished. */
export function resumableBlock(input: {
  deps: InRunContinuityDeps;
  cause: ResumableCause;
  capsule: SessionCapsule | null;
  nativeRejected: boolean;
  acted: boolean;
  limit: LimitEvidenceState | null;
  terminalCode: string | null;
  workspace: RunResumable["workspace"];
}): RunResumable {
  const { deps } = input;
  const limitCause = ["vendor_limit", "pinned_limit", "pool_exhausted"].includes(input.cause);
  const limit = limitCause ? input.limit : null;
  const session = input.capsule && !input.nativeRejected ? input.capsule : null;
  const carriers: RunResumable["carriers"] = [];
  if (session) {
    carriers.push("native");
    if (deps.adapter.continuity) carriers.push("native_moved");
  }
  if (input.acted) carriers.push("packet");
  return {
    cause: input.cause,
    resetsAt: limit?.resetsAt ?? null,
    limitWindow: limit?.constraintId ?? null,
    limitEvidence: limit ? (limit.resetsAt || limit.constraintId ? "window" : "unspecified") : null,
    carriers,
    limitCode: limitCause ? (input.terminalCode ?? (limit ? "vendor_limit_rejected" : null)) : null,
    session: session
      ? {
          harness: session.harness,
          nativeSessionId: session.nativeSessionId,
          holderProfileId: session.holderProfileId,
        }
      : null,
    workspace: input.workspace,
  };
}

/** Re-locate the capsule's holder through the adapter after a try settles; a hit is persisted. */
export async function relocateCapsule(
  deps: InRunContinuityDeps,
  capsule: SessionCapsule,
  runSpec: HarnessRunSpec,
): Promise<SessionCapsule> {
  const holder = registryProfile(deps.registry, capsule.holderProfileId, deps.adapter.id);
  const located = await relocateSessionCapsule(
    capsule,
    deps.adapter.continuity,
    storeEnvFor(runSpec.env, holder),
  );
  if (located.located !== true) return capsule;
  writeSessionCapsule(deps.attemptDir, located.capsule);
  return located.capsule;
}
