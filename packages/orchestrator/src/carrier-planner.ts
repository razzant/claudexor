/**
 * Carrier planner (the "continue from the break point" ladder) — the ONE seam
 * both the in-run continuation loop (later tries of an attempt) and the
 * `continueFrom` run chain (first try of a successor run) call.
 *
 * Two functions, deliberately separate: `decideCarrier` is PURE over explicit
 * facts and yields the ordered ladder of carriers to try; `prepareCarrier`
 * does the I/O for that ladder — it locates the session, moves it into the
 * target account's store, or builds the evidence index — and returns the
 * first rung that works. Harness-specific mechanics stay behind the adapter's
 * `continuity` capability; the planner never reads vendor prose (INV-049).
 *
 * The ladder (owner answers 1B + 2A):
 *   hop (target account ≠ source):  native_moved → (acted ? packet : fresh)
 *   same account:                   native       → (acted ? packet : fresh)
 *   packet preference (re-brief):   acted ? packet : fresh
 * A native rung needs a capsule that no typed fact has rejected (identity
 * mismatch, adapter rejection of carried state); `native_moved` also needs
 * the adapter's `continuity`. `fresh` never follows `acted`: a partially
 * acted attempt never replays its original prompt (INV-046 as amended).
 */
import type { ContinuityMoveResult, EnvMap, HarnessAdapter } from "@claudexor/core";
import type { ContinuityCarrier, ResumableCause, SessionCapsule } from "@claudexor/schema";
import {
  buildEvidenceIndex,
  type EvidenceIndex,
  type EvidenceIndexSources,
} from "./continuation-evidence.js";
import {
  collectEvidenceIndexInput,
  keepCompleteRetainedOutput,
} from "./continuation-evidence-io.js";

export type CarrierPreference = "auto" | "packet";

/** Where a session lives now (source) or will run next (target). */
export interface CarrierProfileRef {
  profileId: string | null;
  /** The env the child sees on that account (the spec env) PLUS the store
   * locator key (`storeEnvFor`), so the adapter can resolve the store. */
  env: EnvMap;
  /** The registry row's `isolation_locator`; null = the harness default store. */
  storeLocator: string | null;
}

export interface CarrierFacts {
  /** This attempt's capsule (in-run) or the predecessor's (`continueFrom`); null = no native session known. */
  capsule: SessionCapsule | null;
  /** Sticky per attempt: the predecessor did work (accepted answer text, agent
   * progress, a file change or a workspace diff in ANY try). Never recomputed
   * from the last try alone. */
  acted: boolean;
  cause: ResumableCause;
  sourceProfile: CarrierProfileRef;
  targetProfile: CarrierProfileRef;
  /** The attested model to keep (a null `model_hint` must not re-resolve to another default). */
  effectiveModel: string | null;
  preference: CarrierPreference;
  adapter: Pick<HarnessAdapter, "id" | "continuity">;
  /** A TYPED fact already proved the native carrier unusable on this session
   * (identity mismatch at the handshake, or the adapter's typed rejection of
   * carried state): the native rungs are skipped. */
  nativeRejected: boolean;
}

export interface CarrierDecision {
  /** Ordered rungs; `prepareCarrier` returns the first that works. Never
   * contains `fresh` after `acted` (a partially-acted attempt never replays). */
  ladder: ContinuityCarrier[];
  /** True when the target account differs from the source (a hop). */
  hop: boolean;
  effectiveModel: string | null;
  /** Machine-stable reason for the ladder shape (disclosure, not governance). */
  reason: string;
}

export interface CarrierIo {
  facts: CarrierFacts;
  /** Sources of the evidence index (the run dir, the work order, admitted steering). */
  evidence: EvidenceIndexSources;
  targetCwd: string;
  /** In-memory facts the loop already holds (the collector reads the rest from the run dir);
   * a reader is called only when the ladder reaches the packet rung. */
  retainedOutput?: string | (() => string);
  /** Where the packet keeps the complete retained output its bounded section cuts. */
  retainedOutputFile?: string;
  diffStat?: string | null;
  completed?: boolean;
}

export type CarrierPrepared =
  | {
      carrier: "native" | "native_moved";
      resumeRef: { nativeSessionId: string; path?: string };
      /** The capsule after location/move: the current holder. */
      capsule: SessionCapsule;
      /** Invoke only AFTER persisting the capsule naming the new holder. */
      retire?: () => void | Promise<void>;
    }
  | { carrier: "packet"; packet: EvidenceIndex }
  | { carrier: "fresh" };

/** Pure: the ordered ladder of carriers for these facts. */
export function decideCarrier(facts: CarrierFacts): CarrierDecision {
  const hop = (facts.sourceProfile.profileId ?? null) !== (facts.targetProfile.profileId ?? null);
  const floor: ContinuityCarrier = facts.acted ? "packet" : "fresh";
  const base = { hop, effectiveModel: facts.effectiveModel };
  if (facts.preference === "packet") {
    return { ...base, ladder: [floor], reason: "packet_preference" };
  }
  const nativeUsable = facts.capsule !== null && !facts.nativeRejected;
  if (!nativeUsable) {
    return {
      ...base,
      ladder: [floor],
      reason: facts.capsule === null ? "no_session" : "native_rejected",
    };
  }
  if (hop) {
    return facts.adapter.continuity
      ? { ...base, ladder: ["native_moved", floor], reason: "hop_with_session" }
      : { ...base, ladder: [floor], reason: "hop_move_unsupported" };
  }
  return { ...base, ladder: ["native", floor], reason: "same_account_session" };
}

/** I/O: walk the ladder — locate, move, or build the evidence index — and return the first rung that works. */
export async function prepareCarrier(
  decision: CarrierDecision,
  io: CarrierIo,
): Promise<CarrierPrepared> {
  const { facts } = io;
  const continuity = facts.adapter.continuity;
  for (const rung of decision.ladder) {
    if (rung === "native" && facts.capsule) {
      const located = await locateSafe(continuity, facts.capsule, facts.sourceProfile.env);
      if (located === "miss") continue;
      const capsule = located === "unverified" ? facts.capsule : located;
      return {
        carrier: "native",
        resumeRef: {
          nativeSessionId: capsule.nativeSessionId,
          ...(capsule.file ? { path: capsule.file } : {}),
        },
        capsule,
      };
    }
    if (rung === "native_moved" && facts.capsule && continuity) {
      const source = await locateSafe(continuity, facts.capsule, facts.sourceProfile.env);
      if (source === "miss" || source === "unverified") continue;
      const moved = await moveSafe(continuity, source, facts, io.targetCwd);
      if (!moved) continue;
      // The holder is the file the TARGET resume looks at: re-locate there so
      // the capsule names the new holder. The caller must publish it before
      // invoking the returned retirement step (copy → verify → publish → retire).
      const target = await locateSafe(
        continuity,
        { ...source, holderProfileId: facts.targetProfile.profileId, cwd: io.targetCwd },
        facts.targetProfile.env,
      );
      const capsule: SessionCapsule =
        target === "miss" || target === "unverified"
          ? { ...source, holderProfileId: facts.targetProfile.profileId, cwd: io.targetCwd }
          : target;
      return {
        carrier: "native_moved",
        retire: moved.retire,
        resumeRef: {
          nativeSessionId: moved.resumeRef.nativeSessionId,
          ...(capsule.file ? { path: capsule.file } : {}),
        },
        capsule,
      };
    }
    if (rung === "packet") return preparePacket(io);
    if (rung === "fresh") return { carrier: "fresh" };
  }
  return facts.acted ? preparePacket(io) : { carrier: "fresh" };
}

function preparePacket(io: CarrierIo): CarrierPrepared {
  const input = collectEvidenceIndexInput(io.evidence, {
    cause: io.facts.cause,
    retainedOutput:
      typeof io.retainedOutput === "function" ? io.retainedOutput() : (io.retainedOutput ?? ""),
    diffStat: io.diffStat ?? null,
    completed: io.completed,
  });
  return {
    carrier: "packet",
    packet: buildEvidenceIndex(keepCompleteRetainedOutput(input, io.retainedOutputFile)),
  };
}

/** Locate through the adapter: the refreshed capsule, "miss", or "unverified"
 * when the adapter has no `continuity` (resume by id; a new id is recorded as before). */
async function locateSafe(
  continuity: HarnessAdapter["continuity"],
  capsule: SessionCapsule,
  env: EnvMap,
): Promise<SessionCapsule | "miss" | "unverified"> {
  if (!continuity) return "unverified";
  try {
    const found = await continuity.locate(
      { nativeSessionId: capsule.nativeSessionId, cwd: capsule.cwd },
      env,
    );
    if (!found.found) return "miss";
    return { ...capsule, file: found.file, mtimeMs: found.mtimeMs, sidecars: found.sidecars };
  } catch {
    return "miss";
  }
}

async function moveSafe(
  continuity: NonNullable<HarnessAdapter["continuity"]>,
  source: SessionCapsule,
  facts: CarrierFacts,
  targetCwd: string,
): Promise<Extract<ContinuityMoveResult, { ok: true }> | null> {
  if (!source.file) return null;
  try {
    const moved = await continuity.move(
      { file: source.file, sidecars: source.sidecars, nativeSessionId: source.nativeSessionId },
      facts.sourceProfile.env,
      facts.targetProfile.env,
      targetCwd,
    );
    return moved.ok ? moved : null;
  } catch {
    return null;
  }
}
