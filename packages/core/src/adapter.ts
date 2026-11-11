import type { NativeHomeLifetime } from "./native-home-lifetime.js";
import type { CredentialProfileProbeOptions } from "./credential-selection.js";
import type {
  AccountIdentity,
  AuthPreference,
  AuthSourceKind,
  ConformanceReport,
  CredentialProfile,
  CredentialProfileStatus,
  EffortResolution,
  HarnessCapabilityProfile,
  HarnessEvent,
  HarnessManifest,
  HarnessModel,
  HarnessRunSpec,
  InteractionAnswerSet,
  InteractionRequest,
  ProcessingPreference,
  ProcessingReceipt,
  ProcessingCostBasis,
} from "@claudexor/schema";

/** Accounts-only doctor receipt. Identity never widens generic HarnessStatus. */
export interface HarnessAccountDoctorReceipt {
  report: ConformanceReport;
  identity: AccountIdentity | null;
}

/** Accounts-only profile receipt: one probe owns readiness and identity. */
export interface CredentialAccountProbeReceipt {
  status: CredentialProfileStatus;
  identity: AccountIdentity | null;
}

export interface DoctorSpec {
  cwd: string;
  /** ACP opt-in for one paid conformance prompt; other adapters may ignore it. */
  conformance?: boolean;
  /** Optional scoped env for probes that must mirror a concrete run route. */
  env?: Record<string, string | null | undefined>;
  /** Optional auth route preference for probes that must mirror a concrete run route. */
  authPreference?: AuthPreference;
  /** Bypass every readiness cache for this probe without reading, writing, or clearing shared cache state. */
  fresh?: boolean;
  /** Probe only this concrete auth source; adapters must not verify unrelated routes. */
  authSource?: AuthSourceKind;
  /** Cancels active vendor probes. This runtime-only value is never part of a cache key. */
  abortSignal?: AbortSignal;
}

/** Model-inventory query bound to the credential identity that would run.
 * Kept separate from DoctorSpec so profile identity never enters the shared
 * doctor cache contract. */
export interface HarnessModelSpec extends DoctorSpec {
  credentialProfile?: CredentialProfile | null;
}

/** Why one live model-catalog read produced no catalog (INV-104: a failed read
 * is never a successful empty catalog). `auth_rejected` is an HTTP 401/403
 * answer, `http_status` any other non-OK answer, `incomplete` an answer that
 * declares more rows than it carries, `malformed` a body that is not a complete
 * catalog (unparseable, no list, or one invalid row). */
export interface ModelCatalogFailure {
  cause:
    | "no_credential"
    | "auth_rejected"
    | "http_status"
    | "network"
    | "timeout"
    | "malformed"
    | "incomplete";
  /** The endpoint's HTTP status when it answered; null otherwise. */
  httpStatus: number | null;
  /** Bounded, redacted diagnostic for disclosure; never parsed. */
  detail: string;
}

/** The key one catalog read sent, as its producer names it. Only the
 * non-secret fingerprint is public; the producer may keep the key on the same
 * object, private, so the request of the spawn whose dispatch gate made that
 * read sends exactly the key the read checked (#393 x #147). */
export interface ModelCatalogCredential {
  readonly fingerprint: string;
}

/** One typed read of a live model catalog at one credential identity and time.
 * `listed` proves presence; an empty `listed` answer is a successful empty
 * catalog. `unavailable` proves nothing about any model. `credential` names
 * the key the read sent, absent when the producer names none: two reads share
 * a credential only when both carry the same fingerprint. */
export type ModelCatalogObservation =
  | { status: "listed"; models: HarnessModel[]; credential?: ModelCatalogCredential }
  | { status: "unavailable"; failure: ModelCatalogFailure; credential?: ModelCatalogCredential };

/**
 * What one request that inlines a RawContextPacket may spend, derived for a
 * spec before its packet exists (#147) from the catalog the dispatch gate read
 * for that spawn. Token figures are ceil(characters / 4) estimates of the text
 * the model receives, never a tokenizer count.
 */
export interface RawRequestCapacity {
  /** Model the request names: the spec's model hint, else the instance's choice. */
  model: string;
  /** Window of that model's catalog row (a routing variant resolves to its
   * listed row); null when unknown: no row, no field, or a failed read. */
  contextWindow: number | null;
  /** Tokens kept free for the answer, and whether the catalog supplied them. */
  outputAllowance: number;
  outputAllowanceSource: "catalog" | "default";
  /** Estimated tokens the request carries outside the packet: instructions,
   * user text, the patch protocol and attachments as sent. */
  framingTokens: number;
}

/**
 * A route whose request cannot omit a model (#395): a chat-completions body needs
 * one and no vendor CLI picks it. The engine invents none, so an operator chooses.
 */
export interface RouteModelRequirement {
  /** The operator's choice for this instance outside Settings (an instance
   * argument or an environment variable) and where it was made; null when none. */
  instanceChoice: { model: string; source: string } | null;
  /** The variable that can make that choice, named by a refusal's remedy. */
  env?: string;
}

export interface HarnessProcessingSpec extends HarnessModelSpec {
  preference?: ProcessingPreference;
  model: string | null;
  effort: string | null;
  /** Existing monetary policy; false requests ordinary fallback before paid work. */
  allowPaid?: boolean;
  /** Receipt this work unit already chose without a preference (routing-time or an
   * earlier try). An adapter that honours it (Codex today) keeps that intent across a
   * retry, rotation or continuation instead of adopting another account's native
   * setting; an adapter that does not implement it ignores the field. */
  chosen?: ProcessingReceipt;
}

export interface PreparedHarnessProcessing {
  model: string | null;
  receipt: ProcessingReceipt;
  costBasis: ProcessingCostBasis;
  /** Effort receipt of a model-id effort carrier (`effortParameter: "--model"`):
   * produced by the SAME preparation that chose `model` and
   * `receipt.submittedNative`, so the native id, the level token and the
   * disclosure cannot disagree. Absent when the level is a separate flag the
   * adapter resolves at spawn, or when the harness has no effort control. */
  effort?: EffortResolution;
  /** The account inventory this preparation read for the spec's own profile,
   * env and cwd. The per-spawn gate resolves that spawn's observed model label
   * against it and nothing else. Absent = no catalog proof. */
  catalog?: HarnessModel[];
}

/**
 * Why a live message did not reach the model, filled from adapter/registry
 * state only — never from vendor error prose (INV-049). The ONE vocabulary is
 * the schema's `LiveMessageReason` (control-run-message.ts); core re-exports
 * it so harness packages keep a single import path.
 */
import type { LiveMessageReason } from "@claudexor/schema";
export type { LiveMessageReason };

/**
 * Typed answer of `HarnessAdapter.message`. `accepted`: the harness's
 * documented acceptance boundary was observed (consumption unproved).
 * `delivered`: a correlated native consumption event was observed (obedience
 * unproved). `rejected`: an explicit refusal of THIS submission on a still
 * active turn. `not_active`: no eligible target existed before dispatch.
 * `unsupported`: this session has no live-input channel. `delivery_unknown`:
 * the message may have landed (transport loss, malformed reply, timeout) —
 * never "safe to resend under a new key".
 */
export interface LiveMessageResult {
  outcome:
    "accepted" | "delivered" | "rejected" | "not_active" | "unsupported" | "delivery_unknown";
  reason?: LiveMessageReason;
  nativeTurnId?: string;
}

/**
 * The contract every harness adapter implements. Adapters translate a native
 * harness's I/O into typed Claudexor events — they never contain orchestration
 * logic. External adapters may implement this as an in-tree HarnessAdapter implementation (the out-of-tree JSON-RPC bridge package was removed in v0.9).
 */
export interface HarnessAdapter {
  readonly program?: import("@claudexor/schema").HarnessProgram;
  /** Explicit maintenance only. The adapter enumerates obsolete profile program files, never credentials. */
  planProfileProgramCleanup?(
    profiles: readonly import("@claudexor/schema").CredentialProfile[],
    selected: import("@claudexor/schema").SelectedHarnessProgram,
    options?: { recoverOnly?: boolean },
  ): {
    paths: string[];
    limitations: string[];
    execute(observe: () => import("@claudexor/schema").SelectedHarnessProgram): {
      removed: string[];
      limitations: string[];
    };
  };
  readonly id: string;
  /** Native effort carrier the adapter resolves at its final route: a separate
   * flag (`--effort`, `model_reasoning_effort`), or `--model` when the level is
   * a token of a compound model id and `prepareProcessing` selects the listed
   * variant of the requested model's family (Cursor, Antigravity). Absent = no
   * effort control; the engine records the preference as omitted. */
  readonly effortParameter?: string;

  /**
   * Static capability declaration available without spawning the vendor CLI.
   * Policy/admission consumers use this exact object before any live probe;
   * discover() may only overlay runtime facts such as the preferred auth
   * source. Keeping the declaration on the adapter prevents a profile-policy
   * conflict from spending a vendor call merely to learn that it must refuse.
   */
  readonly capabilityProfile?: HarnessCapabilityProfile;

  /** Detect installation/version/auth and declare capabilities. */
  discover(): Promise<HarnessManifest>;

  /** Probe capabilities and report which intents this adapter may play. */
  doctor(spec: DoctorSpec): Promise<ConformanceReport>;

  /**
   * Optional Accounts projection of the same doctor probe. Implementations
   * return readiness plus a narrow non-secret identity in one receipt so an
   * Accounts caller never launches a second native status process.
   */
  doctorForAccounts?(spec: DoctorSpec): Promise<HarnessAccountDoctorReceipt>;

  /** Run a task, streaming normalized events. */
  run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent>;

  /** Optional dedicated review path (defaults to run with intent=review). */
  review?(spec: HarnessRunSpec): AsyncIterable<HarnessEvent>;

  /**
   * Optional model enumeration. Only adapters that can HONESTLY list models
   * implement this (e.g. raw-api via OpenAI-compatible `GET /v1/models`);
   * native-CLI adapters that cannot enumerate simply omit it. Must fail soft
   * (return [] on network/auth error) — never throw into a picker/consumer.
   * Consumers read through `readModelCatalog`, which prefers `modelCatalog`.
   */
  models?(spec?: HarnessModelSpec): Promise<HarnessModel[]>;

  /**
   * Optional typed read of the same catalog for a producer that can tell a
   * failed read from an empty catalog. Its `models()` is then only the
   * fail-soft projection of this answer. Never throws.
   */
  modelCatalog?(spec?: HarnessModelSpec): Promise<ModelCatalogObservation>;

  /** Capacity facts for a spec whose transport inlines a RawContextPacket
   * (#147), from `catalog`: the rows of the dispatch gate's own read for this
   * spawn's credential identity ([] when that read failed). Reads nothing; null
   * when the spec names no model, which no capacity can be read for. */
  rawRequestCapacity?(
    spec: HarnessRunSpec,
    catalog: readonly HarnessModel[],
  ): RawRequestCapacity | null;

  /** Declared only by a route that cannot omit a model; absent means the vendor
   * chooses when a run names none. */
  readonly modelRequirement?: RouteModelRequirement;

  /** Translate service intent using this account's inventory before ranking or
   * reserving spend. Discovery only; never starts a generation or changes auth. */
  prepareProcessing?(spec: HarnessProcessingSpec): Promise<PreparedHarnessProcessing>;

  /** Optional cancellation. */
  cancel?(sessionId: string): Promise<void>;

  /**
   * Optional live input into an ALREADY RUNNING session (the
   * `POST /v2/runs/:id/messages` capability). Only adapters whose
   * `capabilityProfile.live_input` is not `none` implement it; the daemon
   * answers `unsupported` when the method is absent. The adapter never
   * cancels or fails the run because of a message: every outcome is typed.
   */
  message?(
    sessionId: string,
    input: { messageId: string; text: string },
  ): Promise<LiveMessageResult>;

  /**
   * Optional per-profile readiness probe (INV-135): the doctor projection for
   * one credential profile, without asserting anything about other routes.
   * Adapters that support no profile transport simply omit it — the service
   * layer reports `unknown` availability for their profiles.
   */
  probeCredentialProfile?(
    profile: CredentialProfile,
    abortSignal?: AbortSignal,
    options?: CredentialProfileProbeOptions,
  ): Promise<CredentialProfileStatus>;

  /**
   * Optional Accounts-only profile probe. This is the rich counterpart of
   * `probeCredentialProfile`, not an additional probe: callers choose one.
   */
  probeCredentialAccount?(
    profile: CredentialProfile,
    abortSignal?: AbortSignal,
  ): Promise<CredentialAccountProbeReceipt>;

  /**
   * Optional continuity capability: locate the native session's holder file,
   * move it into another account's store, type the vendor's rejection of
   * carried state. Absent = no `native_moved` carrier for this harness;
   * same-account resume keeps using `resume_session_id`, guarded by the
   * engine-side session-id comparison.
   */
  continuity?: HarnessContinuityCapability;
  /** Adapter owns its native store format and safe retirement boundary. */
  nativeHomeLifetime?: NativeHomeLifetime;
  /** Where one exact session's material lives, for a thread's exact export. Absent
   * leaves every session of this harness a named gap that cannot retire. */
  nativeSessionExport?: NativeSessionExport;
  /**
   * The HOME this adapter's vendor child actually receives for `spec` when the
   * adapter replaces the engine-scoped HOME with a named account's own
   * Claudexor-owned HOME (a vendor store selected only by HOME). Applied
   * attempt facts record this path. Absent or null: the child receives
   * `spec.env.HOME`.
   */
  childHome?(spec: HarnessRunSpec): string | null;
  /**
   * The vendor access setting this adapter passes for `spec`, in the vendor's
   * own spelling, computed by the SAME helper that builds the argv or request
   * (#413). Disclosure only, recorded on the per-spawn route receipt. Absent
   * or null: the adapter passes no access setting or does not disclose it.
   */
  nativeAccess?(spec: HarnessRunSpec): string | null;
}

/** One display string for native arguments: empty or spaced tokens are quoted. */
export function formatNativeArgs(args: readonly string[]): string | null {
  if (args.length === 0) return null;
  return args.map((arg) => (arg === "" || /\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

/** A recorded session's reach. It never extends to another version or entry. */
export interface NativeSessionFormatEvidence {
  fixture: string;
  /** Exact vendor versions recorded; a session's own transcript must name only these. */
  vendorVersions: readonly string[];
  /** The platforms a session was actually recorded on; no other host's copy qualifies. */
  platforms: readonly NodeJS.Platform[];
  /** The store-relative JSONL transcript a recorded entry of this session belongs
   * with (the transcript itself for the transcript), or null when the recording
   * never held such an entry. A copy holding an entry without its transcript is
   * missing required material; the transcript is read for its versions and store
   * references. Entries the recording held without one stay optional. */
  transcriptOf(rel: string, nativeSessionId: string): string | null;
  /** The transcript's top-level vendor-version field; null for a format that has none. */
  versionField: string | null;
}

/** An adapter's declaration of its on-disk session material. Export reads only
 * these locations, by exact session id, and copies bytes it never interprets. */
export interface NativeSessionExport {
  /** The store this env selects: a named profile's or the default native one. */
  storeRoot(env: EnvMap): string | null;
  /** Store directories holding session-bound entries, with those entries' depth
   * below each (`todos/<sid>` is 1, `projects/<cwd>/<sid>.jsonl` is 2). */
  sessionLocations: Readonly<Record<string, number>>;
  /** Exact credential stores a lane's HOME can hold, relative to it. Never opened. */
  laneCredentialStores: readonly string[];
  /** What a recorded real on-disk session proves about this layout, and no more:
   * those vendor versions and those entries. Anything else stays a named
   * `native_format_unqualified` gap: its bytes are preserved, and the thread
   * cannot retire. Null means no such session has been recorded. */
  formatEvidence: NativeSessionFormatEvidence | null;
  /** Known vendor state no record binds to a session, named on every manifest. */
  outOfClosure: readonly { source: string; reason: string }[];
}

/** A registry of available adapters keyed by harness id. */
export type AdapterRegistry = Map<string, HarnessAdapter>;

/** Environment a harness child sees (the `HarnessRunSpec.env` shape, nullable values allowed). */
export type EnvMap = Record<string, string | null | undefined>;

/**
 * The env key the engine sets on the EnvMap it hands to `continuity.locate` /
 * `continuity.move`: the registry `isolation_locator` of the credential profile
 * whose store holds (or will hold) the session. Absent = the harness's default
 * native store. Each adapter maps it onto its own vendor variable with the same
 * canonicalization its run route uses (claude `CLAUDE_CONFIG_DIR`, codex
 * `CODEX_HOME`), so the engine never spells a vendor variable (INV-135).
 */
export const CONTINUITY_PROFILE_LOCATOR_ENV = "CLAUDEXOR_PROFILE_LOCATOR";

/**
 * The typed `payload.code` of the error event an adapter yields when the
 * session it recovered at its earliest handshake is NOT the one
 * `resume_session_id` asked for (codex: the `thread/resume` reply before
 * `turn/start`). The engine reads only this code (never prose) and records
 * `identityCheck: mismatch_before_effects`.
 */
export const CONTINUITY_IDENTITY_MISMATCH_CODE = "resume_identity_mismatch";

/** A native session the adapter located: the concrete history file (the holder) plus sidecars. */
export interface LocatedNativeSession {
  found: true;
  /** Absolute path of the history file that holds the session. */
  file: string;
  mtimeMs: number;
  /** Absolute paths of sibling state a move must carry (claude `<sid>/`, codex rollout parts). */
  sidecars: string[];
}

export type ContinuityLocateResult = LocatedNativeSession | { found: false };

export type ContinuityMoveResult =
  | { ok: true; resumeRef: { nativeSessionId: string }; retire?: () => void | Promise<void> }
  | { ok: false; reason: string };

/**
 * Optional per-adapter continuity capability (session carriers across
 * processes and accounts). Harness-specific mechanics live HERE; the engine
 * sees typed results only.
 *
 * `move` places the session where the TARGET resume looks (claude:
 * `<target locator>/projects/<enc(targetCwd)>/<sid>.jsonl` + `<sid>/`; codex:
 * the same relative `sessions/` path under the target `CODEX_HOME`, every
 * part), so resume by id works and `HarnessRunSpec` needs no path field.
 * Order: copy → verify destination → the engine publishes the new holder in
 * the capsule → invokes the returned `retire` step. Failed moves remove their
 * destination copies and preserve the source. A failed destination never destroys the
 * only history. Never credentials: no `auth.json`, no claude credential files.
 */
export interface HarnessContinuityCapability {
  locate(
    ref: { nativeSessionId: string; cwd: string },
    env: EnvMap,
  ): Promise<ContinuityLocateResult>;
  move(
    located: { file: string; sidecars: string[]; nativeSessionId?: string },
    fromEnv: EnvMap,
    toEnv: EnvMap,
    targetCwd: string,
  ): Promise<ContinuityMoveResult>;
  /** Adapter-internal typing of its vendor's own rejection of carried state
   * (claude: an API 400 on a thinking signature; codex: `invalid_encrypted_content`).
   * The orchestrator reads only this boolean, never the prose. */
  rejectsCarriedState?(ev: HarnessEvent): boolean;
}

/**
 * Imperative answer channel for interactive harness sessions.
 *
 * The adapter calls `request()` when its native session raises a user
 * question (e.g. Claude's AskUserQuestion via the stream-json control
 * protocol). A blocking request holds that tool until the promise settles; an
 * async one (`delivery: "async"`) is consumed without holding the event pump:
 * - resolved with answers -> the adapter delivers them into the live session;
 * - resolved with null (an explicit decline, an expiry, a withdrawal or the
 *   run's end; the run's interaction events say which) -> nothing answers the
 *   question: a blocking one declines benignly and the model continues with
 *   assumptions, an async one sends nothing;
 * - rejected with {@link InteractionChannelError} -> the answer surface itself
 *   failed, so nobody was asked or no answer can arrive. That is never the
 *   user's decline; the adapter says so in its own record.
 *
 * The channel is smuggled through `spec.extra` (duck-typed, same pattern as
 * the abort signal) because HarnessRunSpec is a serializable schema shape.
 */
export interface InteractionChannel {
  /** Optional signal revokes only this obsolete native request, not the run. */
  request(req: InteractionRequest, signal?: AbortSignal): Promise<InteractionAnswerSet | null>;
  /** Number of questions currently awaiting an answer. Lets stream watchdogs
   * treat waiting-on-user as legitimate silence instead of a wedged harness. */
  pendingCount?(): number;
  /** Monotonic begin/end transition counter. Unlike a boolean poll, this lets
   * watchdogs detect a complete wait-and-answer cycle between timer ticks. */
  suspensionVersion?(): number;
}

/** The answer surface behind an InteractionChannel failed (it could not
 * register or keep the question). `cause` is the surface's own failure. */
export class InteractionChannelError extends Error {
  readonly code = "answer_channel_failed" as const;

  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : typeof cause === "string" && cause
          ? cause
          : "the interaction answer surface failed",
      { cause },
    );
    this.name = "InteractionChannelError";
  }
}

export function interactionChannelFromSpec(spec: HarnessRunSpec): InteractionChannel | undefined {
  const channel = spec.extra?.["interactionChannel"];
  if (!channel || typeof channel !== "object") return undefined;
  const candidate = channel as Partial<InteractionChannel>;
  return typeof candidate.request === "function" ? (channel as InteractionChannel) : undefined;
}
