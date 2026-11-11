/** Inputs shared by the in-run controller and its I/O helpers. */
import type { AnswerAssembly, HarnessAdapter } from "@claudexor/core";
import type {
  CredentialProfile,
  HarnessRunSpec,
  ImplementationTransport,
  QuotaSnapshot,
  RunEventType,
  RunResumable,
} from "@claudexor/schema";
import type { AttemptOutputMarkers } from "./attemptOutputMarkers.js";
import type { AttemptTelemetry, TransientFailureObservation } from "./attemptTelemetry.js";
import type { ModelGovernedRoute } from "./modelGovernance.js";
import type { ProfilePolicy, rotateSpecOnTypedLimit } from "./credential-profile-rotation.js";
import type { PreProgressRefusalSubject, ServiceProducer } from "./pre-progress-refusal.js";
import type { TransientRetryPolicy } from "./runSupport.js";

import type { ContinuedTry } from "./inrun-continuity-carrier.js";
import type { PoolAttemptEvidence } from "./pool-attempt-evidence.js";
import type { PredecessorEvidenceSource } from "./continuation-evidence.js";
import type { LaterAttempt } from "./continuation-later.js";

type ContinuityEmit = (type: RunEventType, payload: Record<string, unknown>) => void;

export interface InRunContinuityDeps {
  adapter: HarnessAdapter;
  runId: string;
  attemptId: string;
  /** The run dir (`paths.root`) — the evidence index reads `events.jsonl` there. */
  runDir: string;
  attemptDir: string;
  /** Execution root the child runs in. */
  cwd: string;
  workspace: RunResumable["workspace"];
  /** The caller's original prompt (the work order), for the evidence index. */
  workOrder: string;
  /** The first try's full prompt (engine constraints included) — the packet carrier resends it. */
  firstPrompt: string;
  /** A fallback or D-16d checkpoint attempt continues the plan an earlier attempt of
   * the same continued run made; any other attempt never re-plans the predecessor. */
  later?: LaterAttempt;
  /** This attempt chose its own model (fallback_model, budget downgrade): an
   * inherited predecessor model never replaces it. */
  explicitModel?: boolean;
  registry: readonly CredentialProfile[];
  policy: ProfilePolicy;
  /** The quota authority's current projection (#457). Each rotation decision
   * samples it once, after its readiness probes, so a reset or replacement
   * observed after this attempt began still reaches the decision. */
  quotaSnapshots: () => readonly QuotaSnapshot[];
  retryPolicy: TransientRetryPolicy;
  pinned: boolean;
  defaultRouteWasVendorNative: boolean;
  requestedProfileId: string | null;
  /** False when the lane has no RunInput: rotation never fired there, and still does not. */
  rotationEnabled: boolean;
  laneEnvFor: (profileId: string | null) => Record<string, string> | null;
  probeReadyProfiles: (spec: HarnessRunSpec, tried: Set<string>) => Promise<ReadonlySet<string>>;
  /** Bind one try's #363 refusal/service subject before it spawns (null = nothing to record). */
  bindRefusal: (
    spec: HarnessRunSpec,
    producer: ServiceProducer,
  ) => PreProgressRefusalSubject | null;
  rotationObservations: (
    spec: HarnessRunSpec,
    transients: readonly TransientFailureObservation[],
    refusal: PreProgressRefusalSubject | null,
  ) => Pick<
    Parameters<typeof rotateSpecOnTypedLimit>[0],
    "probeCurrentSubject" | "liveUnusable" | "notePreProgressRefusal"
  >;
  emit: ContinuityEmit;
  /** The model-governed route: an attested model is pinned only if it lists the id;
   * its manifest transport tells whether its process can read a file path. */
  route?: ModelGovernedRoute & { implementationTransport?: ImplementationTransport };
  /** The attempt's per-try account rows, owned by a caller whose catch must keep
   * them when finishing the attempt throws; absent = the controller's own. */
  poolEvidence?: PoolAttemptEvidence;
  newSessionId: () => string;
  /** First try of a continueFrom successor: predecessor progress and receipt. */
  seed?: {
    acted: boolean;
    completed?: boolean;
    continued: ContinuedTry;
    evidenceSources?: readonly PredecessorEvidenceSource[];
  } | null;
  /** Thread facts for the moved-session disclosure (INV-137); null outside a thread. */
  thread: {
    threadId: string;
    turnId: string | null;
    onSessionObserved?: (
      harnessId: string,
      nativeSessionId: string,
      observedModel?: string | null,
      profileId?: string | null,
    ) => void;
    onContinuityResolved?: (
      turnId: string,
      disclosure: {
        kind: "native_resume" | "packet" | "fresh";
        packetTurns: number;
        summarized: boolean;
        laneSwitchedFrom: { harness: string; profileId: string | null } | null;
      },
    ) => void;
  } | null;
}

/** What the loop knows when a try has settled. */
export interface TryFacts {
  runSpec: HarnessRunSpec;
  nativeTry: number;
  harnessErrored: boolean;
  /** The lane's own error text for the try (a thrown error has no error event). */
  originalError?: string | null;
  /** The try's own stream was aborted (a cancelled try is no account evidence). */
  aborted: boolean;
  /** The run was cancelled or hit its deadline only after the try settled
   * (during capture): no successor runs, but the try's own facts stand. */
  stopped?: boolean;
  budgetStopped?: boolean;
  requestRefused: boolean;
  newTransients: readonly TransientFailureObservation[];
  sawTypedLimit: boolean;
  sawRetryable: boolean;
  answer: AnswerAssembly;
  /** Today's transient-gate fact (raw: workspace unchanged and no answer text). */
  rawDeliverableEmpty: boolean;
  /** Candidate lane: the workspace diff is non-empty (the read-only lane omits it). */
  workspaceDiffNonEmpty?: boolean;
  /** The current workspace diff when the lane has one (evidence index file list). */
  currentDiff?: string;
  markers: AttemptOutputMarkers;
  lastLimit: { retryDelayMs: number | null; resetsAt: string | null } | null;
  refusal: PreProgressRefusalSubject | null;
  telemetry: AttemptTelemetry;
}

export type AfterTryVerdict =
  | { kind: "continue"; spec: HarnessRunSpec; delayMs: number }
  /** A typed terminal (pinned limit, pool spent): the loop records the error and stops. */
  | { kind: "terminal"; error: Error }
  | { kind: "break" };
