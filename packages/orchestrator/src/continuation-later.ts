/**
 * Later attempts of a continued run: an Ask `fallback_model` or required-web
 * fallback attempt, or the D-16d checkpoint continuation (Ask and Agent),
 * after an earlier attempt of the same run already planned the predecessor
 * (`continue-from.ts`). The predecessor's session is never moved or retired a
 * second time. The new attempt's first try is a fresh session re-briefed by
 * the evidence index over the ancestral sources plus this run's earlier
 * attempts. A checkpoint continuation's checkpoint carries only the exhausted
 * try's last typed final as its report, so its index keeps every other output
 * recorded in this run once (earlier tries of the exhausted attempt and that
 * try's other narration and earlier native-turn finals included). Its receipt names
 * the actual source: this run's latest attempt that started, else the planned
 * predecessor.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRunEvents, retainedOutput } from "@claudexor/event-log";
import {
  HarnessRunSpec as HarnessRunSpecSchema,
  type HarnessRunSpec,
  type ResumableCause,
  type RunContinuityReceipt,
  type RunEvent,
} from "@claudexor/schema";
import {
  carryingAttempt,
  readContinuationSources,
  readSessionCapsule,
  runExecutionFacts,
  unrepresentedOutput,
} from "@claudexor/workspace";
import {
  buildEvidenceIndex,
  readlessWorkOrder,
  type PredecessorEvidenceSource,
} from "./continuation-evidence.js";
import { collectEvidenceIndexInput, workOrderFile } from "./continuation-evidence-io.js";
import { unconfirmedContinuationInputs } from "./continuation-input.js";
import { continuationNotice, packetContinuationPrompt } from "./continuity-notice.js";
import { InRunContinuity } from "./inrun-continuity.js";
import { uncertainInputFor, type ContinuedTry } from "./inrun-continuity-carrier.js";
import type { InRunContinuityDeps } from "./inrun-continuity-types.js";

/** What the first planned attempt of a continued run leaves for its later attempts. */
export interface ContinuationPlan {
  /** The chain's work order (predecessor's plus this run's caller text). */
  workOrder: string;
  /** The ancestral evidence sources, oldest first. */
  evidenceSources: PredecessorEvidenceSource[];
  acted: boolean;
  cause: ResumableCause;
  completed: boolean;
  from: { runId: string; attemptId: string };
  fromProfileId: string | null;
  workspace: RunContinuityReceipt["workspace"];
}

/** A fallback attempt, or the D-16d one-shot checkpoint continuation. */
export type LaterAttempt = "fallback" | "checkpoint";

/** The attempt whose last try's report the D-16d checkpoint carries: its `run.continuation`
 * row is written before the checkpoint attempt is planned. */
function exhaustedAttempt(events: readonly RunEvent[]): string | null {
  const from = events.findLast((event) => event.type === "run.continuation")?.payload[
    "from_attempt"
  ];
  return typeof from === "string" ? from : null;
}

export function openLaterAttempt(
  deps: InRunContinuityDeps,
  first: { spec: HarnessRunSpec; later: LaterAttempt },
  plan: ContinuationPlan,
): { continuity: InRunContinuity; spec: HarnessRunSpec } {
  const { events } = readRunEvents(join(deps.runDir, "events.jsonl"));
  const facts = runExecutionFacts(events);
  const earlier = facts.attempts.filter((id) => id !== deps.attemptId);
  const earlierEvents = events.filter(
    (event) =>
      event.type === "harness.event" && earlier.includes(String(event.payload["attempt_id"])),
  );
  // The source: the attempt of this run that carries its latest work; without
  // one, nothing of this run reached a vendor and the planned predecessor stays it.
  const previous = carryingAttempt(facts) ?? undefined;
  const source: PredecessorEvidenceSource = {
    runDir: deps.runDir,
    attemptId: previous ?? earlier.at(-1) ?? deps.attemptId,
    attemptIds: earlier,
    workOrder: plan.workOrder,
    steering: [],
    retainedOutput:
      (first.later === "checkpoint"
        ? unrepresentedOutput(earlierEvents, facts, exhaustedAttempt(events))
        : retainedOutput(earlierEvents)?.trim()) ?? "",
    diffStat: null,
  };
  const cause: ResumableCause = !previous
    ? plan.cause
    : first.later === "checkpoint"
      ? "context_exhausted"
      : "other";
  const completed = !previous && plan.completed;
  const uncertainInput = uncertainInputFor(
    deps.runDir,
    unconfirmedContinuationInputs([
      { runId: deps.runId, runDir: deps.runDir, state: "running" },
      ...readContinuationSources(deps.runDir),
    ]),
    undefined,
  );
  const wholeWorkOrder = readlessWorkOrder(deps.route, plan.workOrder, first.spec.prompt);
  const index = buildEvidenceIndex(
    collectEvidenceIndexInput(
      {
        ...source,
        workOrderPath: wholeWorkOrder ? null : workOrderFile(deps.runDir),
        workOrderInPrompt: wholeWorkOrder !== null,
        predecessors: plan.evidenceSources,
      },
      { cause, retainedOutput: source.retainedOutput, diffStat: null, completed },
    ),
  );
  const dir = join(deps.attemptDir, "continuation");
  mkdirSync(dir, { recursive: true });
  const evidencePath = join(dir, "evidence-index-try0.md");
  writeFileSync(evidencePath, index.markdown);
  const spec = HarnessRunSpecSchema.parse({
    ...first.spec,
    resume_session_id: null,
    prompt: packetContinuationPrompt({
      originalPrompt: first.spec.prompt,
      notice: continuationNotice({ cause, completed, uncertainInput, callerText: null }),
      evidencePath,
      evidenceMarkdown: index.markdown,
      completed,
      workOrder: wholeWorkOrder,
    }),
  });
  const continued: ContinuedTry = {
    carrier: "packet",
    summarized: index.summarized,
    cause,
    fromProfileId: previous
      ? (readSessionCapsule(join(deps.runDir, "attempts", previous))?.holderProfileId ?? null)
      : plan.fromProfileId,
    toProfileId: spec.credential_profile?.profile_id ?? null,
    memory: "partial",
    inputDelivery: uncertainInput === null ? "confirmed" : "uncertain",
    from: previous ? { runId: deps.runId, attemptId: previous } : plan.from,
    workspace: previous ? "same_root" : plan.workspace,
  };
  const acted = plan.acted || earlier.some((id) => facts.progressed.has(id));
  const evidenceSources = [...plan.evidenceSources, source];
  return {
    continuity: new InRunContinuity({
      ...deps,
      workOrder: plan.workOrder,
      seed: { acted, completed, continued, evidenceSources },
    }),
    spec,
  };
}
