import { existsSync } from "node:fs";
import { DelegatedEvidenceIncompleteError, DelegatedHomeUnavailableError } from "@claudexor/core";
import type {
  AccessProfile,
  RecordedAppliedAttemptFacts as HistoricalAppliedAttemptFacts,
  WorkspaceEnvelope,
} from "@claudexor/schema";
import { confinementBoundaryProven, DELIBERATE_NO_OUTER_BOUNDARY_REASON } from "@claudexor/schema";
import type { WorkspaceManager } from "@claudexor/workspace";

/** What one attempt's harness HOME actually resolved to, and whether it is scoped. */
export interface ScopedHarnessHome {
  /** Env patch to spread onto the harness spec; absent when the attempt inherits the operator's env. */
  env?: Record<string, string>;
  /** Applied fact, recorded on the attempt so the caller can verify rather than trust. */
  isolated: boolean;
  /** The scoped home directory, or null when the attempt inherits the operator's. */
  homeDir: string | null;
  /** Why no additional outer boundary applies; null for ordinary/non-mutating runs. */
  outerBoundaryUnavailableReason: string | null;
  /**
   * Durable lane resolver of a delegated thread's in-place candidate (INV-034):
   * the home is re-keyed to `(thread, harness, resolved profile)` once the
   * account is known, and follows an in-run account hop.
   */
  laneHomeFor?: (resolvedProfileId: string | null) => Record<string, string> | null;
  /** The account the live spec actually ran under, once resolved. */
  profileApplied?: string | null;
  /** The Claudexor-owned HOME the adapter actually gave its child when it
   * replaced this one with a named account's HOME (`HarnessAdapter.childHome`). */
  childHome?: string | null;
}

/** Access profiles under which the harness can modify the filesystem. */
export function isMutatingAccess(access: AccessProfile): boolean {
  return access !== "readonly";
}

/**
 * Decide the harness HOME one attempt runs under.
 *
 * Unchanged for ordinary runs: an ISOLATED envelope gets the envelope's scoped
 * home, while an IN-PLACE attempt deliberately inherits the operator's native
 * environment so a harness whose native session store hangs off `$HOME` can
 * resume its vendor conversation.
 *
 * A DELEGATED run (`execution.delegated`) is scoped either way. The scoped HOME
 * redirects native state and profile selection; it is deliberately not called
 * a filesystem boundary. Mutating delegated attempts disclose that Claudexor
 * adds no outer OS boundary and leave the selected harness's native access mode
 * in effect.
 *
 * THE COST of the scoped home, stated plainly: an in-place delegated attempt
 * CANNOT resume a native vendor session whose store lives under the real `$HOME`
 * — cursor (`~/.cursor`) and opencode (XDG data under `$HOME`) lose resume.
 * codex and claude keep it: their native session stores are Claudexor-owned
 * directories that the adapter re-points on top of this env, and the macOS login Keychain is reached through
 * the declared scoped-home bridge (INV-067), so subscription auth is unaffected.
 * A delegated THREAD's in-place candidate is re-keyed onto its durable lane
 * home (`selectLaneHome`), so state a route keeps under that `$HOME` persists
 * across the lane's turns instead of dying with the attempt.
 *
 * Never degrades silently: a delegated attempt whose scoped home is not on disk refuses.
 */
export function scopedHarnessHome(
  wsm: WorkspaceManager,
  envelope: WorkspaceEnvelope,
  inPlaceEnvelope: boolean,
  delegated: boolean,
  access: AccessProfile = "workspace_write",
  laneHomeFor: ScopedHarnessHome["laneHomeFor"] | null = null,
): ScopedHarnessHome {
  if (inPlaceEnvelope && !delegated) {
    return {
      isolated: false,
      homeDir: null,
      outerBoundaryUnavailableReason: null,
    };
  }
  const env = wsm.envFor(envelope);
  const homeDir = env["HOME"];
  if (delegated && (!homeDir || !existsSync(homeDir))) {
    throw new DelegatedHomeUnavailableError(
      `delegated run cannot start: the scoped harness home for attempt ${envelope.attempt_id} is missing (${homeDir || "unset"})`,
    );
  }
  return {
    env,
    isolated: true,
    homeDir: homeDir ?? null,
    outerBoundaryUnavailableReason:
      delegated && isMutatingAccess(access) ? DELIBERATE_NO_OUTER_BOUNDARY_REASON : null,
    // Only the one in-place candidate of a delegated thread owns a durable
    // lane; Best-of and other disposable envelopes keep their scoped home.
    ...(delegated && inPlaceEnvelope && laneHomeFor ? { laneHomeFor } : {}),
  };
}

/**
 * Re-key a delegated thread candidate onto its durable lane home once the
 * account is resolved — the SAME `(thread, harness, profile)` home a read-only
 * turn of that lane uses — so vendor-written state survives across turns and
 * modes. Mutates `home` in place: the caller's catch records what ran.
 */
export function selectLaneHome(home: ScopedHarnessHome, resolvedProfileId: string | null): void {
  const env = home.laneHomeFor?.(resolvedProfileId);
  if (!env) return;
  const homeDir = env["HOME"];
  if (!homeDir || !existsSync(homeDir)) {
    throw new DelegatedHomeUnavailableError(
      `delegated thread cannot start: its durable lane home is missing (${homeDir || "unset"})`,
    );
  }
  Object.assign(home, { env, homeDir, profileApplied: resolvedProfileId });
}

/**
 * The applied facts follow the LIVE spec: an in-run account hop moves the spec
 * into the next account's lane, so the recorded home and account move with it
 * on the success and failure paths alike (never profile B with home A). An
 * adapter that gives its child the account's own HOME instead names it, and
 * that is the home recorded.
 */
export function followSpecHome<
  S extends { env?: Record<string, string>; credential_profile?: { profile_id: string } | null },
>(
  home: ScopedHarnessHome,
  spec: S,
  requestedProfileId: string | null,
  adapter?: { childHome?(spec: S): string | null },
): ScopedHarnessHome {
  home.profileApplied = spec.credential_profile?.profile_id ?? requestedProfileId;
  const specHome = spec.env?.["HOME"];
  if (home.laneHomeFor && spec.env && specHome && specHome !== home.homeDir) {
    Object.assign(home, { env: spec.env, homeDir: specHome });
  }
  home.childHome = adapter?.childHome?.(spec) ?? null;
  return home;
}

/**
 * What the CHILD is told, when it is running without an OS boundary.
 *
 * Second of the three places the absence is disclosed (the attempt record and
 * the caller's result are the other two). A model that believes it is sandboxed
 * when it is not is the one reader whose behaviour actually changes on this
 * fact, so it is stated to the model in plain words rather than left in an
 * artifact it never reads.
 */
export function outerBoundaryNotice(
  home: ScopedHarnessHome | null | undefined,
  auxiliaryWritableRoots: readonly string[] = [],
): string | null {
  const reason = home?.outerBoundaryUnavailableReason;
  // An explicit grant is named on every lane that receives it; project work
  // still belongs in the execution workspace.
  const grant = auxiliaryWritableRoots.length
    ? `Caller-granted writable service directories outside the execution workspace (caches or scratch, never part of the project result): ${auxiliaryWritableRoots.join(", ")}.`
    : null;
  if (!reason) return grant;
  return [
    `Engine disclosure: ${reason}`,
    "The scoped HOME selects native state and credentials; it is not containment. Stay within",
    grant
      ? "the execution workspace and the granted service directories below; do not access unrelated operator or Claudexor state."
      : "the execution workspace and do not access unrelated operator or Claudexor state.",
    ...(grant ? [grant] : []),
  ].join("\n");
}

/**
 * What an attempt's harness process ACTUALLY ran under.
 *
 * One shape, written by the success path and the failure path alike. An attempt
 * that spawned a harness and then died still ran a process, and the caller of a
 * delegated run still needs to know what that process could reach — "it failed"
 * is not an answer to "what outer-boundary evidence applied".
 */
export interface AppliedAttemptFacts {
  /**
   * ABSENT when the attempt died before its home was decided (`wsm.create` or
   * home selection failed). A literal `false` is a POSITIVE claim — the engine
   * did not replace HOME, so this child inherits the engine's own environment
   * (the operator's HOME unless a host started the engine with another) — and
   * an attempt that never reached the decision made no such claim. Absence
   * keeps it a gap in the record, which is what `appliedEvidenceComplete`
   * already refuses on.
   */
  harness_home_isolated?: boolean;
  harness_home_dir: string | null;
  access_applied: AccessProfile;
  credential_profile_applied: string | null;
  /**
   * OPAQUE mechanism label, never a platform and never a promise: it is written
   * only together with the path below, which is the proof it was enforced.
   */
  confinement_mechanism: string | null;
  confinement_profile_digest: string | null;
  confinement_verified_denied_path: string | null;
  /**
   * Why this attempt ran with NO boundary. This is the field that makes an
   * honestly unconfined attempt DIFFERENT from an attempt whose evidence is
   * simply missing — the first is auditable, the second is not.
   */
  confinement_unavailable_reason: string | null;
}

/**
 * `home` is nullable on purpose: an attempt that died BEFORE its home was
 * decided still writes the block, with every field it cannot answer null. A
 * record that omits the block entirely is indistinguishable from one written by
 * an engine that never had it, which is the ambiguity the terminal check exists
 * to close. `harness_home_isolated` is the one exception — see the field.
 */
export function appliedAttemptFacts(
  home: ScopedHarnessHome | null | undefined,
  access: AccessProfile,
  credentialProfileId: string | null,
): AppliedAttemptFacts {
  // A child moved into an owned account HOME did not run in the operator's.
  const childHome = home?.childHome ?? null;
  return {
    ...(home ? { harness_home_isolated: childHome !== null || home.isolated } : {}),
    harness_home_dir: childHome ?? home?.homeDir ?? null,
    access_applied: access,
    credential_profile_applied:
      home?.profileApplied !== undefined ? home.profileApplied : credentialProfileId,
    confinement_mechanism: null,
    confinement_profile_digest: null,
    confinement_verified_denied_path: null,
    confinement_unavailable_reason: home?.outerBoundaryUnavailableReason ?? null,
  };
}

/**
 * Whether an attempt's record is auditable for a delegated mutating run.
 *
 * The distinction this predicate exists to draw: evidence that is MISSING is
 * still a reason to refuse — an attempt that cannot say what it ran under is
 * indistinguishable from one that ran unconfined behind a green terminal.
 * Evidence that honestly says "no additional boundary, by design" is complete.
 *
 * A named mechanism is a claim, and only `verified_denied_path` discharges it —
 * so a record carrying the name without the proof is NOT complete, and neither
 * is one that claims a boundary and a reason for its absence at the same time.
 */
export function appliedEvidenceComplete(
  facts: AppliedAttemptFacts | HistoricalAppliedAttemptFacts | null | undefined,
): boolean {
  if (!facts || !facts.harness_home_isolated || !facts.harness_home_dir) return false;
  if (facts.confinement_mechanism) {
    return confinementBoundaryProven(facts) && !facts.confinement_unavailable_reason;
  }
  return Boolean(facts.confinement_unavailable_reason);
}

/**
 * The terminal evidence gate, shared by every lane that assembles attempts.
 *
 * A delegated MUTATING run may only reach a terminal when EVERY attempt it ran
 * can state what it ran under, including the deliberate absence of an outer
 * boundary, so the rule lives here and both callers spend it.
 */
export function assertDelegatedEvidence(
  delegated: boolean,
  access: AccessProfile,
  attempts: readonly { attemptId: string; applied?: AppliedAttemptFacts }[],
): void {
  if (!delegated || !isMutatingAccess(access)) return;
  const unauditable = attempts.filter((attempt) => !appliedEvidenceComplete(attempt.applied));
  if (unauditable.length === 0) return;
  throw new DelegatedEvidenceIncompleteError(
    `delegated mutating run cannot terminalize: ${unauditable.length} attempt(s) state neither a historical proven boundary nor the deliberate no-outer-boundary reason (${unauditable.map((attempt) => attempt.attemptId).join(", ")})`,
  );
}
