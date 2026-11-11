/**
 * The first try of a `continueFrom` successor (PLAN §2.3, INTERFACES §1 + §7).
 *
 * The in-run controller (`inrun-continuity.ts`) continues later tries of ONE
 * attempt; a successor run continues a terminal PREDECESSOR. Its first try is
 * planned here, once per run, through the same two planner functions: the
 * predecessor's session capsule, terminal `resumable` facts and evidence
 * decide the carrier; the spec is composed the way the controller composes a
 * continued try (a native carrier never resends the original prompt — the
 * notice plus the caller's text ride the user prompt; a packet re-briefs a
 * fresh session with the evidence index); the capsule is written into the
 * successor's attempt, so its later tries resume the same session; and the
 * controller is seeded with the predecessor's sticky `acted` and this try's
 * receipt (`from` = the predecessor, `same_root` / `different_root`), which
 * it emits when the try settles, with THIS try's attested model.
 *
 * A successor's work order is the chain's: the predecessor's work order plus
 * the caller's continuation text, recorded as `context/work-order.md` so the
 * next link reads one file instead of walking the chain. The receipt names the
 * actual source run, attempt and profile (an ancestor when the requested head
 * left no carrier); the requested head stays in the run's `continueFrom`.
 * Later attempts of the same run continue the recorded plan instead
 * (`continuation-later.ts`).
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import {
  HarnessRunSpec as HarnessRunSpecSchema,
  type RunResumable,
  type HarnessRunSpec,
  type ContinuationSources,
  type ResumableCause,
  type RunContinuityReceipt,
  type SessionCapsule,
} from "@claudexor/schema";
import { readTextSafe } from "@claudexor/util";
import {
  ownsContinuationSource,
  readContinuationEvidence,
  retainedEnvelopeInChain,
} from "@claudexor/workspace";
import {
  decideCarrier,
  prepareCarrier,
  type CarrierFacts,
  type CarrierPreference,
} from "./carrier-planner.js";
import type { RunContinuation } from "./continuation-custody.js";
import {
  buildEvidenceIndex,
  readlessWorkOrder,
  uncoveredWorkSection,
  type PredecessorEvidenceSource,
} from "./continuation-evidence.js";
import {
  collectEvidenceIndexInput,
  diffStatFromPatch,
  uncoveredWork,
} from "./continuation-evidence-io.js";
import { continuationNotice, packetContinuationPrompt } from "./continuity-notice.js";
import { unconfirmedContinuationInputs } from "./continuation-input.js";
import { InRunContinuity } from "./inrun-continuity.js";
import type { InRunContinuityDeps } from "./inrun-continuity-types.js";
import { routeListsModel } from "./modelGovernance.js";
import {
  retireMovedSource,
  uncertainInputFor,
  type ContinuedTry,
} from "./inrun-continuity-carrier.js";
import { openLaterAttempt } from "./continuation-later.js";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import { registryProfile, storeEnvFor, writeSessionCapsule } from "./session-capsule.js";

/** The predecessor a successor continues, resolved by the daemon from its own records. */
export interface ContinueFromSource {
  runId: string;
  /** Absolute run directory of the predecessor. */
  runDir: string;
  /** The lifecycle the predecessor ended with. */
  state: string;
  /** The predecessor's work order: every prompt of its chain, root first. */
  workOrder: string;
  preference: CarrierPreference;
  /** Earlier chain links, newest first; a refused head may own no carrier yet. */
  ancestors?: ContinuationSources;
  /** Earlier trees already expired; disclosed but never read as evidence. */
  expiredAncestors?: string[];
  /** Captured before inheritance/defaults; a caller-selected model always wins. */
  inheritModel?: boolean;
  /** Inherited project scope, used only when no capsule/workspace records the root. */
  scopeRoot?: string;
}

const WORK_ORDER_FILE = join("context", "work-order.md");

const DIFFERENT_ROOT_NOTE =
  "This process runs in a different working tree than the previous one: check which of its changes are present here before continuing.";

/** What the predecessor left behind, read from its run directory. */
interface PredecessorFacts {
  /** The run these facts were read from (an ancestor when the head has no carrier). */
  runId: string;
  /** Attempt whose evidence the index reads (the one holding the session, else the final one). */
  attemptId: string;
  /** Every attempt of that run with recorded harness events, in order. */
  attempts: string[];
  /** The attempts whose work the held session never received. */
  uncovered: string[];
  runDir: string;
  capsule: SessionCapsule | null;
  /** Recorded history quality of the capsule's session (null without a capsule). */
  sessionMemory: RunContinuityReceipt["memory"] | null;
  resumable: RunResumable | null;
  cause: ResumableCause;
  acted: boolean;
  hasEvidence: boolean;
  /** This run is its own continuation source (`ownsContinuationSource`). */
  ownsSource: boolean;
  observedModel: string | null;
  profileId: string | null;
  workOrder: string;
  output: string;
  diffStat: string | null;
  /** Execution root the predecessor's work lived in, when known. */
  root: string | null;
}

function readSource(from: ContinueFromSource): PredecessorFacts {
  const evidence = readContinuationEvidence(from.runDir);
  const {
    resumable,
    held,
    sessionMemory,
    attemptId,
    attempts,
    uncovered,
    attempt,
    patch,
    output,
    hasEvidence,
  } = evidence;
  const cause: ResumableCause =
    resumable?.cause ??
    (from.state === "interrupted"
      ? "host_restart"
      : from.state === "cancelled"
        ? "cancelled"
        : "other");
  return {
    runId: from.runId,
    attemptId,
    attempts,
    uncovered,
    runDir: from.runDir,
    capsule: held?.capsule ?? null,
    sessionMemory,
    resumable: resumable ?? null,
    cause,
    // Sticky `acted` of the predecessor: its terminal block lists `packet`
    // exactly when it acted; without the block, the evidence decides.
    acted: resumable
      ? resumable.carriers.includes("packet")
      : hasEvidence || from.state === "succeeded",
    hasEvidence,
    ownsSource: ownsContinuationSource(evidence),
    observedModel: attempt?.observed_model ?? held?.capsule.requestedModel ?? null,
    profileId: held?.capsule.holderProfileId ?? attempt?.profile_id ?? null,
    // What the predecessor itself was given, else the daemon's chain record.
    workOrder: readTextSafe(join(from.runDir, WORK_ORDER_FILE))?.trim() || from.workOrder,
    output,
    diffStat: diffStatFromPatch(patch),
    root: held?.capsule.cwd ?? resumable?.workspace.root ?? from.scopeRoot ?? null,
  };
}

function readPredecessor(from: ContinueFromSource): PredecessorFacts {
  const own = readSource(from);
  for (const source of [from, ...(from.ancestors ?? [])]) {
    const facts =
      source === from ? own : readSource({ ...from, ...source, scopeRoot: source.scopeRoot });
    if (facts.ownsSource) return { ...facts, workOrder: own.workOrder };
  }
  return own;
}

function samePath(a: string | null, b: string): boolean {
  if (a === null) return false;
  const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  return canonical(a) === canonical(b);
}

function profileRef(deps: InRunContinuityDeps, spec: HarnessRunSpec, profileId: string | null) {
  const row = registryProfile(deps.registry, profileId, deps.adapter.id);
  return {
    profileId,
    env: storeEnvFor(spec.env, row),
    storeLocator: row?.isolation_locator ?? null,
  };
}

/**
 * Open the attempt's continuation controller. For the first candidate attempt
 * of a `continueFrom` successor, plan the carrier of its first try and return
 * the composed spec. `continuation.from` is consumed here, so nothing re-plans
 * the predecessor's carrier: a later fallback or D-16d checkpoint attempt
 * (`deps.later`) continues the recorded plan through the evidence index, and
 * every other attempt (synthesis, repair) gets the controller unchanged.
 */
export async function openContinuity(
  deps: InRunContinuityDeps,
  first: {
    spec: HarnessRunSpec;
    continuation: RunContinuation | undefined;
    store: ArtifactStore;
    telemetry: Pick<AttemptTelemetry, "requestedModel">;
  },
): Promise<{ continuity: InRunContinuity; spec: HarnessRunSpec }> {
  const { spec, continuation, store } = first;
  const from = continuation?.from;
  if (continuation?.planned && !from && deps.later)
    return openLaterAttempt(deps, { spec, later: deps.later }, continuation.planned);
  if (!continuation || !from) return { continuity: new InRunContinuity(deps), spec };
  continuation.from = null;
  const pred = readPredecessor(from);
  const completed = pred.resumable === null && from.state === "succeeded";
  const evidenceSources: PredecessorEvidenceSource[] = [from, ...(from.ancestors ?? [])]
    .reverse()
    .map((source) => {
      const facts = readSource({ ...from, ...source });
      return {
        runDir: facts.runDir,
        attemptId: facts.attemptId,
        attemptIds: facts.attempts,
        workOrder: facts.workOrder,
        steering: [],
        retainedOutput: facts.output,
        diffStat: facts.diffStat,
      };
    });
  const model =
    !deps.explicitModel &&
    from.inheritModel &&
    pred.observedModel &&
    deps.route &&
    (await routeListsModel(deps.route, spec, pred.observedModel))
      ? pred.observedModel
      : spec.model_hint;
  const callerText = deps.workOrder;
  const workOrder = [pred.workOrder.trim(), callerText.trim()].filter(Boolean).join("\n\n");
  store.writeText(join(deps.runDir, WORK_ORDER_FILE), `${workOrder}\n`);
  // Another harness cannot resume this session: the evidence index carries it.
  const capsule = pred.capsule?.harness === deps.adapter.id ? pred.capsule : null;
  const targetId = spec.credential_profile?.profile_id ?? null;
  const sourceId = capsule ? capsule.holderProfileId : targetId;
  const facts: CarrierFacts = {
    capsule,
    acted: pred.acted,
    cause: pred.cause,
    sourceProfile: profileRef(deps, spec, sourceId),
    targetProfile: profileRef(deps, spec, targetId),
    effectiveModel: pred.observedModel ?? spec.model_hint ?? null,
    preference: from.preference,
    adapter: deps.adapter,
    // A terminal block that dropped the session names none: no capsule is held.
    nativeRejected: false,
  };
  // A route that cannot read files gets the complete work order the index cuts inline.
  const wholeWorkOrder = readlessWorkOrder(deps.route, pred.workOrder, spec.prompt);
  const evidence = {
    runDir: pred.runDir,
    attemptId: pred.attemptId,
    attemptIds: pred.attempts,
    workOrder: pred.workOrder,
    workOrderPath: wholeWorkOrder ? null : join(deps.runDir, WORK_ORDER_FILE),
    workOrderInPrompt: wholeWorkOrder !== null,
    steering: [],
    predecessors: evidenceSources.filter((source) => source.runDir !== pred.runDir),
  };
  const extras = {
    cause: pred.cause,
    retainedOutput: pred.output,
    diffStat: pred.diffStat,
    completed,
  };
  const prepared = await prepareCarrier(decideCarrier(facts), {
    facts,
    evidence,
    targetCwd: deps.cwd,
    retainedOutput: pred.output,
    diffStat: pred.diffStat,
    completed,
  });
  const uncertainInput = uncertainInputFor(
    pred.runDir,
    unconfirmedContinuationInputs([from, ...(from.ancestors ?? [])]),
    undefined,
    deps.runDir,
  );
  const retainedRoot =
    continuation.adopt?.envelope.worktree_path ??
    retainedEnvelopeInChain([from, ...(from.ancestors ?? [])])?.envelope.worktree_path ??
    null;
  const sameRoot = samePath(retainedRoot, deps.cwd) || samePath(pred.root, deps.cwd);
  // The notice says the workspace is as it was left; in another tree that is
  // not known, so the child is told to check before relying on it.
  const patchPath = join(pred.runDir, "final", "patch.diff");
  const treeNote = sameRoot
    ? ""
    : [
        DIFFERENT_ROOT_NOTE,
        existsSync(patchPath) ? `The predecessor's saved patch is at: ${patchPath}` : "",
      ]
        .filter(Boolean)
        .join("\n");
  const expiredNote = from.expiredAncestors?.length
    ? `Earlier continuation evidence expired by retention: ${from.expiredAncestors.join(", ")}. Continue using the intact predecessor's evidence; the expired trees are unavailable.`
    : "";
  const native = prepared.carrier === "native" || prepared.carrier === "native_moved";
  // Work of the predecessor's other attempts that the resumed session never
  // received arrives as labelled evidence; a packet already carries them all.
  const outside = native
    ? uncoveredWorkSection(
        uncoveredWork(
          pred.runDir,
          pred.uncovered,
          pred.attempts.filter((id) => !pred.uncovered.includes(id)),
        ),
      )
    : "";
  const withNote = (text: string) =>
    [expiredNote, treeNote, outside, text.trim()].filter(Boolean).join("\n\n");
  let composed: HarnessRunSpec;
  let retirement: Pick<ContinuedTry, "sourceRetirement"> = {};
  if (prepared.carrier === "native" || prepared.carrier === "native_moved") {
    writeSessionCapsule(deps.attemptDir, prepared.capsule);
    // The published capsule is authoritative even if a stale source copy remains.
    retirement = await retireMovedSource(prepared.retire);
    // A follow-up on finished work is the caller's text alone; unfinished
    // work, or work its session never received, gets the continuation notice
    // (cause, undelivered input, that work) first.
    const followUp = completed && callerText.trim() && uncertainInput === null && !outside;
    composed = HarnessRunSpecSchema.parse({
      ...spec,
      model_hint: model,
      resume_session_id: prepared.resumeRef.nativeSessionId,
      prompt: followUp
        ? withNote(callerText)
        : continuationNotice({
            cause: pred.cause,
            completed,
            uncertainInput,
            callerText: withNote(callerText),
          }),
    });
  } else {
    // `fresh` (the predecessor did not act) still needs the work order: the
    // same index is the brief, it simply carries no work.
    const index =
      prepared.carrier === "packet"
        ? prepared.packet
        : buildEvidenceIndex(collectEvidenceIndexInput(evidence, extras));
    const dir = join(deps.attemptDir, "continuation");
    mkdirSync(dir, { recursive: true });
    const evidencePath = join(dir, "evidence-index-try0.md");
    writeFileSync(evidencePath, index.markdown);
    composed = HarnessRunSpecSchema.parse({
      ...spec,
      resume_session_id: null,
      model_hint: model,
      prompt: packetContinuationPrompt({
        originalPrompt: spec.prompt,
        notice: continuationNotice({
          cause: pred.cause,
          completed,
          uncertainInput,
          callerText: withNote(""),
        }),
        evidencePath,
        evidenceMarkdown: index.markdown,
        completed,
        workOrder: wholeWorkOrder,
      }),
    });
  }
  const continued: ContinuedTry = {
    carrier: prepared.carrier,
    summarized: prepared.carrier === "packet" && prepared.packet.summarized,
    cause: pred.cause,
    fromProfileId: capsule ? capsule.holderProfileId : pred.profileId,
    toProfileId: targetId,
    // History quality follows the chosen session's own record, never the carrier word.
    memory: native ? (pred.sessionMemory ?? "unknown") : "partial",
    inputDelivery: uncertainInput === null ? "confirmed" : "uncertain",
    from: { runId: pred.runId, attemptId: pred.attemptId },
    workspace: sameRoot ? "same_root" : "different_root",
    ...retirement,
  };
  first.telemetry.requestedModel = composed.model_hint ?? null;
  continuation.planned = {
    workOrder,
    evidenceSources,
    acted: pred.acted,
    cause: pred.cause,
    completed,
    from: continued.from!,
    fromProfileId: continued.fromProfileId,
    workspace: continued.workspace!,
  };
  return {
    continuity: new InRunContinuity({
      ...deps,
      workOrder,
      seed: { acted: pred.acted, completed, continued, evidenceSources },
    }),
    spec: composed,
  };
}
