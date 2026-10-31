/** Agent and Ask share one per-attempt continuation owner. Before progress,
 * existing fresh-retry/rotation rules apply. After progress, limits move the
 * session to another account (or a packet); transport resumes the same account
 * bounded by max_retries. Deterministic permission/context refusals stop rather
 * than replaying the same limitation. Pins never rotate.
 *
 * Acted is sticky across every try (answer, activity, file change or diff): a
 * silent resumed try never reopens the fresh rung. The capsule, per-try receipts,
 * typed terminal cause and retained output preserve what happened. Hops are
 * bounded by triedProfiles; work never silently becomes a fresh prompt replay.
 * Full mechanism and carrier rationale: ARCHITECTURE "In-run continuation". */
import { CONTINUITY_IDENTITY_MISMATCH_CODE, acceptedTryOutput } from "@claudexor/core";
import {
  HarnessRunSpec as HarnessRunSpecSchema,
  type ContinuityIdentityCheck,
  type HarnessEvent,
  type HarnessRunSpec,
  type ResumableCause,
  type RunContinuityReceipt,
  type RunResumable,
  type SessionCapsule,
  type WorkState,
} from "@claudexor/schema";
import type { AttemptOutputMarkers } from "./attemptOutputMarkers.js";
import {
  carriedRunAttempts,
  composeContinuedTry,
  continuityReceipt,
  relocateCapsule,
  resumableBlock,
  uncertainInputFor,
  type ContinuedTry,
  type LimitEvidenceState,
} from "./inrun-continuity-carrier.js";
import {
  effectiveLimitAction,
  limitSubjectRoute,
  rotateSpecOnTypedLimit,
  type EmitFn,
} from "./credential-profile-rotation.js";
import { inRunRotationArgs } from "./rotation-predicate.js";
import { emitTransientRetryPlan } from "./laneStreamEvents.js";
import { rotatedSpecInLaneHome } from "./orchestrator-credentials.js";
import { transientRetryDelayMs } from "./runSupport.js";
import { readSessionCapsule, writeSessionCapsule } from "./session-capsule.js";

import type { AfterTryVerdict, InRunContinuityDeps, TryFacts } from "./inrun-continuity-types.js";
import { discloseContinuedTry } from "./inrun-continuity-thread.js";
import type { ContinuityTerminalFacts } from "./continuity-terminal.js";
import { RetainedAttemptOutput } from "./inrun-retained-output.js";
import { undeliveredInputs, type UncertainInput } from "./continuation-input.js";
import {
  noteRefusedBeforeProgress,
  type PreProgressRefusalSubject,
} from "./pre-progress-refusal.js";
import { PoolAttemptEvidence, withRotationAttempts } from "./pool-attempt-evidence.js";
import { pinnedTypedLimit, quotaRefusalWithScope } from "./quota-refusal-scope.js";

const TYPED_REFUSALS = new Set(["auth_failed", "capability_refused", "config_error"]);

export class InRunContinuity {
  private capsule: SessionCapsule | null;
  private acted = false;
  private nativeRejected = false;
  private readonly triedProfiles = new Set<string>();
  private sameAccountTries = 0;
  private lastCause: ResumableCause | null = null;
  private limit: LimitEvidenceState | null = null;
  private terminalCode: string | null = null;
  private permissionDenied = false;
  // Per-try state.
  private tryIndex = 0;
  private tryAbort: AbortController | null = null;
  private tryStarted = false;
  /** Some try of this attempt started with an accepted handshake (it carries work). */
  private startedAccepted = false;
  private trySessionId: string | null = null;
  private expectedSessionId: string | null = null;
  private tryModel: string | null = null;
  private tryRequestedModel: string | null = null;
  private tryIdentity: ContinuityIdentityCheck = "not_applicable";
  private tryFirstInputTokens: number | null = null;
  private continued: ContinuedTry | null = null;
  private pending: ContinuedTry | null = null;
  /** History quality of the capsule's session: packet-born stays partial, a seeded
   * native carrier keeps its predecessor's recorded quality. */
  private sessionMemory: RunContinuityReceipt["memory"];
  private threadSwitch: { harness: string; profileId: string | null } | null = null;
  private readonly retainedOutput = new RetainedAttemptOutput();
  /** Carrier of the try that just settled (null = the first try or a fresh replay). */
  private settledCarrier: RunContinuityReceipt["carrier"] | null = null;
  private unstartedInputs: UncertainInput[] = [];
  private refusal: PreProgressRefusalSubject | null = null;
  private readonly poolEvidence: PoolAttemptEvidence;

  constructor(private readonly deps: InRunContinuityDeps) {
    this.poolEvidence =
      deps.poolEvidence ?? new PoolAttemptEvidence(deps.adapter.id, deps.attemptId);
    this.capsule = readSessionCapsule(deps.attemptDir);
    this.acted = deps.seed?.acted === true;
    this.pending = deps.seed?.continued ?? null;
    const seeded = this.pending?.carrier;
    this.sessionMemory =
      seeded === "native" || seeded === "native_moved" ? this.pending!.memory : "full";
  }

  /** The loop calls this before each try spawns; `abort` is THIS try's controller.
   * Returns the try's #363 subject, bound now so a credential change mid-try voids it. */
  beginTry(
    runSpec: HarnessRunSpec,
    nativeTry: number,
    abort: AbortController,
  ): PreProgressRefusalSubject | null {
    this.poolEvidence.begin(runSpec, nativeTry);
    const { runId, attemptId } = this.deps;
    this.refusal = this.deps.bindRefusal(runSpec, { runId, attemptId, tryIndex: nativeTry });
    this.limit = null;
    this.terminalCode = null;
    this.permissionDenied = false;
    this.tryIndex = nativeTry;
    this.tryAbort = abort;
    this.tryStarted = false;
    this.trySessionId = runSpec.session_id;
    this.continued = this.pending;
    this.pending = null;
    if (this.continued) {
      if (this.continued.fromProfileId !== this.continued.toProfileId)
        this.threadSwitch ??= {
          harness: this.deps.adapter.id,
          profileId: this.continued.fromProfileId,
        };
      discloseContinuedTry(this.deps, this.continued, this.threadSwitch);
    }
    this.expectedSessionId = runSpec.resume_session_id ?? null;
    this.tryModel = null;
    this.tryRequestedModel = runSpec.model_hint ?? null;
    this.tryIdentity = "not_applicable";
    this.tryFirstInputTokens = null;
    return this.refusal;
  }

  /**
   * Observe one stream event. Returns the typed error that STOPS the try now
   * (the resumed session is not the one requested — a mismatch caught before
   * effects when no agent progress was seen yet; the child is aborted), else
   * null.
   */
  observe(ev: HarnessEvent, runSpec: HarnessRunSpec, markers: AttemptOutputMarkers): string | null {
    this.poolEvidence.observe(ev);
    if (ev.permission_denial) this.permissionDenied = true;
    this.refusal?.observe(ev, markers);
    if (ev.observed_model && this.tryModel === null) this.tryModel = ev.observed_model;
    if (ev.rate_limit) {
      this.limit = {
        resetsAt: ev.rate_limit.resets_at ?? null,
        retryDelayMs: ev.rate_limit.retry_delay_ms ?? null,
        constraintId: ev.rate_limit.constraint_id ?? null,
      };
    }
    if (ev.type === "usage" && this.expectedSessionId && this.tryFirstInputTokens === null) {
      const input = ev.usage?.input_token_usage?.total_tokens ?? ev.usage?.input_tokens ?? null;
      if (input !== null) this.tryFirstInputTokens = input;
    }
    if (
      ev.type === "error" &&
      this.expectedSessionId &&
      ev.payload?.["code"] === CONTINUITY_IDENTITY_MISMATCH_CODE
    ) {
      // The adapter compared the recovered handle at its earliest handshake,
      // before any action (codex thread/resume precedes turn/start).
      this.tryIdentity = "mismatch_before_effects";
      this.nativeRejected = true;
      this.tryAbort?.abort();
      return ev.error ?? "recovered native session differs from the requested session";
    }
    if (this.expectedSessionId && this.deps.adapter.continuity?.rejectsCarriedState?.(ev)) {
      this.nativeRejected = true;
    }
    if (ev.type !== "started") return null;
    this.tryStarted = true;
    const nid = ev.payload?.["native_session_id"];
    if (typeof nid !== "string" || nid.length === 0) {
      this.startedAccepted = true;
      return null;
    }
    // Only an adapter with the `continuity` capability promises that a resume
    // keeps the session id; on any other harness a new id after a resume is the
    // vendor's own answer and is recorded as the session, as before.
    if (this.expectedSessionId && nid !== this.expectedSessionId && this.deps.adapter.continuity) {
      this.tryIdentity = markers.sawAgentProgress
        ? "mismatch_after_possible_effects"
        : "mismatch_before_effects";
      this.nativeRejected = true;
      this.tryAbort?.abort();
      void this.deps.adapter.cancel?.(runSpec.session_id)?.catch(() => {});
      return `resumed native session ${nid} is not the requested ${this.expectedSessionId}; the try was stopped${markers.sawAgentProgress ? " (effects may have occurred)" : " before any effect"}`;
    }
    this.startedAccepted = true;
    if (this.expectedSessionId && nid === this.expectedSessionId)
      this.tryIdentity = "matched_before_effects";
    // Packet-born history lacks earlier thread turns, even on later native resumes.
    if (this.continued?.carrier === "packet") this.sessionMemory = "partial";
    else if (this.capsule?.nativeSessionId !== nid) this.sessionMemory = "full";
    // A new native session (or the resumed one) is the attempt's capsule now.
    this.nativeRejected = false;
    this.capsule = {
      harness: this.deps.adapter.id,
      nativeSessionId: nid,
      holderProfileId: ev.credential_profile_id ?? runSpec.credential_profile?.profile_id ?? null,
      file: this.capsule?.nativeSessionId === nid ? this.capsule.file : null,
      mtimeMs: this.capsule?.nativeSessionId === nid ? this.capsule.mtimeMs : null,
      sidecars: this.capsule?.nativeSessionId === nid ? this.capsule.sidecars : [],
      cwd: runSpec.cwd,
      requestedModel: runSpec.model_hint ?? null,
    };
    writeSessionCapsule(this.deps.attemptDir, this.capsule);
    return null;
  }

  /** Both loops consult this only after the controller accepts the handshake. */
  get mayPublishSession(): boolean {
    return (
      this.tryStarted && !this.tryIdentity.startsWith("mismatch") && this.sessionMemory === "full"
    );
  }

  /** Record the try's account row from its own facts, before workspace capture can throw. */
  settleTry(facts: Parameters<PoolAttemptEvidence["settle"]>[0]): void {
    this.poolEvidence.settle(facts);
  }

  /** Decide what the attempt does after a settled try. */
  async afterTry(facts: TryFacts): Promise<AfterTryVerdict> {
    this.poolEvidence.settle(facts);
    this.retainedOutput.add(facts.answer, facts.harnessErrored, this.tryIdentity);
    const accepted = acceptedTryOutput(facts.answer, facts.harnessErrored);
    this.acted ||=
      accepted.length > 0 ||
      facts.markers.sawAgentProgress ||
      facts.markers.fileChanges > 0 ||
      facts.workspaceDiffNonEmpty === true;
    await this.relocate(facts.runSpec);
    this.settledCarrier = this.continued?.carrier ?? null;
    this.emitReceipt(facts.runSpec);
    // A mismatched handshake delivered nothing, exactly like a try that never started.
    if (this.tryStarted && !this.tryIdentity.startsWith("mismatch")) this.unstartedInputs = [];
    else if (this.tryIndex === 0) this.unstartedInputs = undeliveredInputs(this.deps);
    if (facts.budgetStopped) return this.breakWith("other");
    if (!facts.harnessErrored || facts.aborted) return { kind: "break" };
    // A cancel or deadline after the try settled ends the attempt: nothing
    // probes, rotates or retries. A try that never acted keeps its own #363
    // refusal note, read from the captured facts as `rotate` reads them.
    if (facts.stopped) {
      if (this.deps.rotationEnabled && !this.acted && !facts.telemetry.contextExhausted)
        noteRefusedBeforeProgress({
          ...inRunRotationArgs(facts, false),
          spec: facts.runSpec,
          pinned: this.deps.pinned,
          notePreProgressRefusal: () => facts.refusal?.note(),
        });
      return { kind: "break" };
    }
    if (facts.requestRefused) return this.breakWith("other");
    // A known permission refusal is not repaired by replaying the same rights
    // or rotating accounts. Keep its answer and ordinary continuation evidence.
    if (this.permissionDenied) return this.breakWith("permission_denied");
    if (facts.telemetry.contextExhausted) return this.breakWith("context_exhausted");
    if (!this.acted) return this.legacy(facts);
    const typedRefusal = facts.newTransients.some((t) => TYPED_REFUSALS.has(t.category));
    if (typedRefusal) return this.breakWith("other");
    // A11: a bare backoff frame (a delay, no reset, no constraint) is transport —
    // the same session is simply resumed — when a session exists to resume;
    // without one the typed limit still hops (nothing to resume on this account).
    const backoffOnly =
      this.limit !== null &&
      !this.limit.resetsAt &&
      !this.limit.constraintId &&
      this.limit.retryDelayMs !== null;
    if (facts.sawTypedLimit && (!backoffOnly || this.capsule === null)) {
      return this.afterLimit(facts);
    }
    return this.afterTransport(facts);
  }

  /** Receipts, capsule relocation and the terminal `resumable` block once the attempt ends. */
  async finish(input: {
    runSpec: HarnessRunSpec;
    errored: boolean;
    nonSuccess?: boolean;
    aborted: boolean;
    cancelReason: string | null;
    workState: WorkState | null | undefined;
  }): Promise<RunResumable | null> {
    // A continued try whose attempt ended on a loop exit that skipped
    // `afterTry` (a request or processing refusal) still owes its receipt.
    this.emitReceipt(input.runSpec);
    await this.relocate(input.runSpec);
    const vetoed =
      input.workState?.state === "needs_input" || input.workState?.state === "incomplete";
    if (
      !input.errored &&
      !input.aborted &&
      !vetoed &&
      (!input.nonSuccess || (!this.acted && !this.capsule))
    )
      return null;
    const cause: ResumableCause = vetoed
      ? input.workState?.state === "needs_input"
        ? "input_required"
        : "other"
      : input.aborted
        ? input.cancelReason === "wall_clock_exceeded"
          ? "wall_clock"
          : "cancelled"
        : input.errored
          ? (this.lastCause ?? "other")
          : "other";
    return this.resumable(cause);
  }

  /** Snapshot for gates/review/arbitration failing later; a capture refusal skips those. */
  terminalFacts(resumable: RunResumable | null, captureRefused = false): ContinuityTerminalFacts {
    const facts = { poolAttempts: this.poolEvidence.snapshot(), started: this.startedAccepted };
    if (resumable) return { ...facts, resumable };
    return (this.acted || this.capsule) && !captureRefused
      ? { ...facts, resumableOnFailure: this.resumable("other") }
      : facts;
  }

  resumable(cause: ResumableCause): RunResumable {
    return resumableBlock({
      deps: this.deps,
      cause,
      capsule: this.capsule,
      nativeRejected: this.nativeRejected,
      acted: this.acted,
      limit: this.limit,
      terminalCode: this.terminalCode,
      workspace: this.deps.workspace,
    });
  }

  private poolTerminal(error: Error): AfterTryVerdict {
    this.lastCause = "pool_exhausted";
    this.terminalCode = codeOf(error);
    const resetsAt = (error as { resetsAt?: unknown }).resetsAt;
    this.limit = {
      resetsAt: typeof resetsAt === "string" ? resetsAt : null,
      constraintId: this.limit?.constraintId ?? null,
      retryDelayMs: this.limit?.retryDelayMs ?? null,
    };
    return { kind: "terminal", error };
  }

  private breakWith(cause: ResumableCause): AfterTryVerdict {
    this.lastCause = cause;
    return { kind: "break" };
  }

  /** Today's rules for an attempt that did not act: typed-limit / structural
   * rotation onto a fresh session, then the same-profile transient gate. */
  private async legacy(facts: TryFacts): Promise<AfterTryVerdict> {
    const rotated = await this.rotate(facts, false);
    if (rotated && "poolExhausted" in rotated) {
      return this.poolTerminal(rotated.poolExhausted);
    }
    if (rotated) {
      this.hopped(rotated);
      return { kind: "continue", spec: this.inLaneHome(facts.runSpec, rotated), delayMs: 0 };
    }
    this.lastCause = facts.sawTypedLimit ? "vendor_limit" : "transport";
    if (
      !facts.sawRetryable ||
      !facts.rawDeliverableEmpty ||
      facts.nativeTry >= this.deps.retryPolicy.maxRetries
    )
      return { kind: "break" };
    const delayMs = emitTransientRetryPlan(
      (t, p) => this.deps.emit(t, p),
      this.deps.adapter.id,
      this.deps.attemptId,
      facts.telemetry,
      facts.nativeTry,
      this.deps.retryPolicy,
    );
    const spec = HarnessRunSpecSchema.parse({
      ...facts.runSpec,
      session_id: this.deps.newSessionId(),
      resume_session_id: facts.runSpec.resume_session_id ?? null,
      extra: { ...facts.runSpec.extra },
    });
    return { kind: "continue", spec, delayMs };
  }

  /** A typed vendor limit ended a try that acted: hop with the session (2A) or a packet (1B). */
  private async afterLimit(facts: TryFacts): Promise<AfterTryVerdict> {
    const route = limitSubjectRoute(
      facts.runSpec.credential_profile ?? null,
      this.deps.defaultRouteWasVendorNative ? "local_session" : null,
    );
    if (this.deps.pinned) {
      this.lastCause = "pinned_limit";
      this.terminalCode = "subscription_window_exhausted";
      return {
        kind: "terminal",
        error: quotaRefusalWithScope(
          pinnedTypedLimit(
            facts.runSpec.credential_profile?.profile_id ?? "default",
            this.deps.adapter.id,
            this.limit,
            true,
          ),
          {
            harness: this.deps.adapter.id,
            profileId: facts.runSpec.credential_profile?.profile_id ?? null,
            model: facts.runSpec.model_hint,
            requestKind: "text",
            constraintId: this.limit?.constraintId,
          },
        ),
      };
    }
    if (effectiveLimitAction(this.deps.policy, route) !== "rotate")
      return this.breakWith("vendor_limit");
    const rotated = await this.rotate(facts, true);
    if (rotated && "poolExhausted" in rotated) {
      return this.poolTerminal(rotated.poolExhausted);
    }
    if (!rotated) return this.breakWith("vendor_limit");
    this.hopped(rotated);
    this.lastCause = "vendor_limit";
    return this.prepareContinuedTry(
      facts,
      this.inLaneHome(facts.runSpec, rotated),
      "vendor_limit",
      0,
    );
  }

  /** The process died after progress: the same account resumes its session
   * (bounded), or re-briefs once a typed fact rejected that session. With no
   * session recorded at all (the harness never reported one) the same account
   * continues on a new session re-briefed by the evidence index (owner 1B),
   * under the same bound. */
  private async afterTransport(facts: TryFacts): Promise<AfterTryVerdict> {
    this.lastCause = "transport";
    // A packet try that died before doing anything replayed no effect: the
    // structural branch hops it to the next account with the same packet
    // (today's pre-progress failover, now on the packet carrier).
    const packetDiedUnused =
      this.capsule === null &&
      this.settledCarrier === "packet" &&
      !facts.sawRetryable &&
      !facts.markers.sawAgentProgress &&
      facts.markers.fileChanges === 0;
    if (packetDiedUnused) {
      const rotated = await this.rotate(facts, true);
      if (rotated && "poolExhausted" in rotated) {
        return this.poolTerminal(rotated.poolExhausted);
      }
      if (!rotated) return { kind: "break" };
      this.hopped(rotated);
      return this.prepareContinuedTry(
        facts,
        this.inLaneHome(facts.runSpec, rotated),
        "transport",
        0,
      );
    }
    if (this.sameAccountTries >= this.deps.retryPolicy.maxRetries) return { kind: "break" };
    const retryIndex = this.sameAccountTries;
    this.sameAccountTries += 1;
    const spec = HarnessRunSpecSchema.parse({
      ...facts.runSpec,
      session_id: this.deps.newSessionId(),
      extra: { ...facts.runSpec.extra },
    });
    const delayMs = transientRetryDelayMs(
      facts.newTransients.at(-1)?.retryDelayMs ?? this.limit?.retryDelayMs ?? null,
      this.deps.retryPolicy,
      retryIndex,
    );
    return this.prepareContinuedTry(facts, spec, "transport", delayMs);
  }

  private async rotate(
    facts: TryFacts,
    forceEligible: boolean,
  ): Promise<Awaited<ReturnType<typeof rotateSpecOnTypedLimit>>> {
    if (!this.deps.rotationEnabled) return null;
    const { runSpec } = facts;
    return rotateSpecOnTypedLimit({
      spec: runSpec,
      harnessId: this.deps.adapter.id,
      attemptId: this.deps.attemptId,
      policy: this.deps.policy,
      registry: this.deps.registry,
      quotaSnapshots: this.deps.quotaSnapshots,
      probeReadyProfiles: () => this.deps.probeReadyProfiles(runSpec, this.triedProfiles),
      ...this.deps.rotationObservations(runSpec, facts.newTransients, facts.refusal),
      triedProfiles: this.triedProfiles,
      ...inRunRotationArgs(facts, forceEligible),
      // This try's own limit (with the window it named) when it saw one.
      lastLimit: this.limit ?? facts.lastLimit,
      // An in-run exhaustion names each account's own failed tries (settled first).
      emit: ((type, payload) =>
        this.deps.emit(
          type,
          type === "route.profile.rotation_exhausted"
            ? withRotationAttempts(payload, this.poolEvidence.snapshot())
            : payload,
        )) as EmitFn,
      newSessionId: this.deps.newSessionId,
      defaultRouteWasVendorNative: this.deps.defaultRouteWasVendorNative,
      pinned: this.deps.pinned,
    });
  }

  private hopped(rotated: HarnessRunSpec): void {
    if (rotated.credential_profile) this.triedProfiles.add(rotated.credential_profile.profile_id);
    this.sameAccountTries = 0;
  }

  private inLaneHome(previous: HarnessRunSpec, rotated: HarnessRunSpec): HarnessRunSpec {
    return rotatedSpecInLaneHome(
      previous,
      rotated,
      this.deps.laneEnvFor,
      this.deps.requestedProfileId,
    );
  }

  /** Plan and prepare the carrier for the next try, then compose its spec. */
  private async prepareContinuedTry(
    facts: TryFacts,
    base: HarnessRunSpec,
    cause: ResumableCause,
    delayMs: number,
  ): Promise<AfterTryVerdict> {
    const composed = await composeContinuedTry(
      {
        deps: this.deps,
        capsule: this.capsule,
        acted: this.acted,
        nativeRejected: this.nativeRejected,
        tryIndex: this.tryIndex,
        uncertainInput: uncertainInputFor(
          this.deps.runDir,
          this.unstartedInputs,
          carriedRunAttempts(this.deps),
        ),
        retainedOutput: this.retainedOutput.text(),
        sessionMemory: this.sessionMemory,
      },
      facts,
      base,
      cause,
      delayMs,
    );
    this.pending = composed.continued;
    if (composed.capsule) this.capsule = composed.capsule;
    return composed.verdict;
  }

  private async relocate(runSpec: HarnessRunSpec): Promise<void> {
    if (this.capsule) this.capsule = await relocateCapsule(this.deps, this.capsule, runSpec);
  }

  /** The receipt of a continued try, emitted when the try settles (per-try model attestation). */
  private emitReceipt(runSpec: HarnessRunSpec): void {
    const continued = this.continued;
    if (!continued) return;
    this.continued = null;
    this.deps.emit("run.continuity", {
      harness_id: this.deps.adapter.id,
      attempt_id: this.deps.attemptId,
      // The settled try's own process session joins this receipt to its start.
      session_id: this.trySessionId ?? runSpec.session_id,
      receipt: continuityReceipt({
        deps: this.deps,
        continued,
        tryIndex: this.tryIndex,
        requestedModel: this.tryRequestedModel,
        observedModel: this.tryModel,
        nativeRejected: this.nativeRejected,
        identity: this.tryIdentity,
        reingestedTokens: this.tryFirstInputTokens,
      }),
    });
  }
}

function codeOf(error: Error): string | null {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
