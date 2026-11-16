/**
 * A2: the WIDENED reactive rotation predicate (W5.4 + the structural branch).
 *
 * Two independent ways an attempt becomes rotation-eligible:
 *
 * 1. TYPED fast path (W5.4 canon, unchanged): the attempt saw a TYPED vendor
 *    rate-limit signal. Deliberately NOT hardened against thinking/tool
 *    activity — the canon guard is no-deliverable/no-mutation, not
 *    no-progress.
 *
 * 2. STRUCTURAL branch (owner decision 7=A): the attempt ended in a TERMINAL,
 *    non-transient death BEFORE the agent demonstrably did any work. This
 *    deliberately covers ANY pre-progress non-transient death — an invalid
 *    flag, a missing binary, an untyped vendor refusal — bounded by the
 *    profile pool size, and is NEVER narrowed by error-text matching.
 *    Transient-retryable deaths are excluded: the transient machinery retries
 *    them on the SAME profile first (rotation never fires on a plain
 *    transient).
 *
 * Both branches require an empty deliverable and no observed workspace
 * mutation — a partially-acted attempt never silently reruns under another
 * credential. After progress, the work itself moves instead (the in-run
 * controller's carrier); `refusedBeforeOwnWork` names the one typed refusal
 * that moves it.
 */
import { acceptedTryOutput } from "@claudexor/core";
import type { AttemptOutputMarkers } from "./attemptOutputMarkers.js";
import type { ContinuedTry } from "./inrun-continuity-carrier.js";
import type { TryFacts } from "./inrun-continuity-types.js";

/** Typed evidence one native try presents to the rotation predicate. */
export interface RotationEvidence {
  requestRefused?: boolean;
  /** A TYPED vendor rate-limit signal was observed this try (W5.4). */
  sawTypedLimit: boolean;
  /** No POLICY-ACCEPTED answer material (`acceptedTryOutput`: an errored try's
   * mid-stream narration — e.g. a vendor refusal arriving as MESSAGE prose —
   * never counts, for ANY adapter) and (candidate lane) no workspace diff. */
  deliverableEmpty: boolean;
  /** A workspace mutation was OBSERVED: a non-empty diff (candidate lane) or
   * any typed file_change event (both lanes — the read-only lane has no
   * workspace diff, so disclosed file changes are its only mutation truth). */
  mutationObserved: boolean;
  /** The try ended in a terminal error that is NOT transient-retryable (the
   * transient machinery owns same-profile retries for the retryable class). */
  terminalNonTransientDeath: boolean;
  /** The agent demonstrably started working (attemptOutputMarkers policy:
   * thinking/tool/file/patch/compaction — deliberately NOT message/error). */
  sawAgentProgress: boolean;
}

/**
 * `rotation_retry_eligible`: the one predicate both lanes and both branches
 * read. Optional fields default CONSERVATIVELY (absent evidence never widens
 * eligibility), so the frozen truth-table pins keep their meaning.
 */
export function rotationRetryEligible(input: {
  requestRefused?: boolean;
  sawTypedLimit: boolean;
  deliverableEmpty: boolean;
  mutationObserved?: boolean;
  terminalNonTransientDeath?: boolean;
  sawAgentProgress?: boolean;
}): boolean {
  if (input.requestRefused) return false;
  if (!input.deliverableEmpty || input.mutationObserved === true) return false;
  if (input.sawTypedLimit) return true;
  return input.terminalNonTransientDeath === true && input.sawAgentProgress !== true;
}

/**
 * Fold one native try's lane-local facts + the attempt's typed output markers
 * into RotationEvidence. `attemptErrored` / `sawRetryable` come from the
 * lane's per-try failure state; `workspaceDiffNonEmpty` exists only in the
 * candidate lane (the read-only lane omits it and relies on file_change
 * markers alone).
 */
export function reactiveRotationEvidence(args: {
  requestRefused?: boolean;
  markers: AttemptOutputMarkers;
  sawTypedLimit: boolean;
  sawRetryable: boolean;
  attemptErrored: boolean;
  deliverableEmpty: boolean;
  workspaceDiffNonEmpty?: boolean;
}): RotationEvidence {
  return {
    requestRefused: args.requestRefused,
    sawTypedLimit: args.sawTypedLimit,
    deliverableEmpty: args.deliverableEmpty,
    mutationObserved: (args.workspaceDiffNonEmpty ?? false) || args.markers.fileChanges > 0,
    terminalNonTransientDeath: args.attemptErrored && !args.sawRetryable,
    sawAgentProgress: args.markers.sawAgentProgress,
  };
}

/**
 * One settled in-run try's facts as that fold's input. After progress
 * (`forceEligible`) the no-deliverable/no-mutation fence scopes only the
 * `fresh` carrier: the planner picks the carrier, rotation only the account.
 */
export function inRunRotationArgs(
  facts: TryFacts,
  forceEligible: boolean,
): Parameters<typeof reactiveRotationEvidence>[0] {
  const accepted = acceptedTryOutput(facts.answer, facts.harnessErrored);
  return {
    markers: forceEligible
      ? { sawAgentProgress: false, fileChanges: 0, sawSessionStart: facts.markers.sawSessionStart }
      : facts.markers,
    requestRefused: facts.requestRefused,
    sawTypedLimit: facts.sawTypedLimit,
    sawRetryable: facts.sawRetryable,
    attemptErrored: facts.harnessErrored,
    deliverableEmpty: forceEligible
      ? true
      : facts.workspaceDiffNonEmpty !== true && accepted.length === 0,
    workspaceDiffNonEmpty: forceEligible ? false : facts.workspaceDiffNonEmpty,
  };
}

/** Deterministic refusals: after progress the attempt stops on them, except as below. */
export const TYPED_REFUSALS = new Set(["auth_failed", "capability_refused", "config_error"]);

/** A continued try this attempt's own hop composed onto another account; a
 * successor's or later attempt's first try names the run it came `from`. */
function isInRunHop(continued: ContinuedTry | null): boolean {
  return continued !== null && !continued.from && continued.fromProfileId !== continued.toProfileId;
}

/**
 * After progress, the hop target's refusal before work of its own (owner
 * decision of 15 Nov 2026, scope fixed here): this attempt's own hop moved the
 * acted work to another account, whose try ended in the adapter-PROVEN
 * account-wide denial (`entitlementDenied`): Claude's exact `verification_required`
 * (the vendor holds the account until a verification step) or the organization's
 * exact refusal (`oauth_not_allowed_for_organization`, the `oauth_org_not_allowed`
 * retry code or its recorded result, #318/#609). That refusal is the account's,
 * not the work's: the controller moves the same work on. Every typed refusal of
 * the try must be such a proof; an auth, model, request, permission or
 * configuration refusal, and a category only prose inferred, still stop. Only
 * THIS try is judged, never the sticky `acted`: no agent progress (a started tool
 * with an unknown outcome counts), no file change, no accepted answer, and in a
 * writable lane the same tree identity as the previous try left. A same-account resume, a
 * successor's first try and an unknown tree keep the stop.
 */
export function refusedBeforeOwnWork(
  facts: Pick<
    TryFacts,
    "newTransients" | "markers" | "answer" | "harnessErrored" | "workspaceIdentity"
  >,
  /** The settled try's continuation record (null: the attempt's first or a fresh try). */
  continued: ContinuedTry | null,
  /** The tree identity the previous try left (absent: read-only access). */
  before: string | null | undefined,
): boolean {
  const refusals = facts.newTransients.filter((t) => TYPED_REFUSALS.has(t.category));
  if (!isInRunHop(continued) || refusals.length === 0) return false;
  if (!refusals.every((t) => t.entitlementDenied)) return false;
  if (facts.markers.sawAgentProgress || facts.markers.fileChanges > 0) return false;
  if (acceptedTryOutput(facts.answer, facts.harnessErrored).length > 0) return false;
  // Read-only access (Ask, Agent) has no tree to prove; a writable lane proves it unchanged.
  return facts.workspaceIdentity === undefined
    ? before === undefined
    : facts.workspaceIdentity !== null && facts.workspaceIdentity === before;
}
