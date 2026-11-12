import { randomUUID } from "node:crypto";
import { loadConfig } from "@claudexor/config";
import { credentialProfilePolicyState } from "@claudexor/core";
import type { QuotaRefreshCycle, QuotaRefreshResult } from "@claudexor/daemon";
import {
  AGY_BIN,
  AGY_CAPABILITY_PROFILE,
  AGY_QUOTA_MODEL_GROUPS,
  agyProfileRunEnv,
  canonicalAgyProfileHome,
  classifyAgyPrintResult,
  isAgyProfileKeychainUnsafe,
  prepareAgyProfileKeychain,
  runAgyPrintCommand,
  type AgyPrintClassification,
} from "@claudexor/harness-agy";
import {
  QuotaConstraint as QuotaConstraintSchema,
  quotaModelPrefixMatches,
} from "@claudexor/schema";
import type { QuotaAbsence, QuotaConstraint, QuotaSnapshot, QuotaSubject } from "@claudexor/schema";
import { noProjectRepoRoot, redactSecrets } from "@claudexor/util";
import {
  emitQuotaDiagnostic,
  unknownQuotaScopeReason,
  type QuotaDiagnosticSink,
  type QuotaRefreshDiagnostic,
} from "./quota-refresh-diagnostics.js";

/**
 * agy quota (source `agy_command_usage`): the vendor's own `/quota` print-mode
 * slash command returns a JSON envelope WITHOUT spending a turn (1.1.11+). One
 * candidate per enabled agy config_dir_login profile — agy has NO default
 * store (owner decision, PLAN Л-4), so there is no null-subject candidate.
 * A candidate that cannot be observed yields a typed absence CLAIM, never a
 * throw: one account's failure must never blind the others. The refresh
 * cycle decides which candidates spawn at all (selectAgyCycleCandidates).
 */
export async function refreshAgyQuota(
  options: {
    bin?: string;
    baseEnv?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    prepareProfileKeychain?: (home: string) => void;
    diagnostic?: QuotaDiagnosticSink;
  } = {},
  cycle?: QuotaRefreshCycle,
): Promise<QuotaRefreshResult> {
  const bin = options.bin ?? AGY_BIN();
  const snapshots: QuotaSnapshot[] = [];
  const report = agyQuotaReporter(options.diagnostic, cycle);
  const { due, absences } = selectAgyCycleCandidates(
    agyQuotaCandidates(options.platform),
    cycle,
    report,
  );
  // Profiles are read CONCURRENTLY: several accounts is the point of the
  // feature, the daemon awaits every refresher in one cycle, and each read can
  // burn its full timeout — serially that is one stalled vendor per account
  // added to claude's and codex's wait too. Concurrency is BOUNDED (3) so a
  // large registry never turns one cycle into an unthrottled vendor burst.
  // The rate_limited short-circuit is dormant: the AGY print classifier has no
  // typed rate-limit outcome (#240), so no probe returns that reason today and
  // every due candidate is probed.
  const results = await mapBoundedUntilRateLimited(
    due,
    AGY_QUOTA_CONCURRENCY,
    reportedProbe(report, async (candidate) => {
      const home = candidate.home;
      try {
        const env = agyProfileRunEnv(home, options.baseEnv ?? process.env);
        const prepare =
          options.prepareProfileKeychain ??
          ((profileHome: string): void =>
            prepareAgyProfileKeychain(profileHome, { platform: options.platform }));
        const prepareFailure = (): QuotaAbsence | null => {
          try {
            prepare(home);
            return null;
          } catch (error) {
            if (!isAgyProfileKeychainUnsafe(error)) {
              // A custom operational seam may model a recoverable
              // security-tool miss; path and identity failures remain unsafe.
              return null;
            }
            return agyAbsence(
              candidate.subjectId,
              "refresh_failed",
              redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300),
            );
          }
        };
        const beforeQuota = prepareFailure();
        if (beforeQuota) return { absence: beforeQuota };
        const parsed = await readAgyQuota(bin, env, options.platform);
        if (parsed.kind === "auth_revoked")
          return { absence: agyAbsence(candidate.subjectId, "auth_revoked", parsed.detail) };
        if (parsed.kind !== "constraints")
          return { absence: agyAbsence(candidate.subjectId, "refresh_failed", parsed.detail) };
        const note = parsed.unknownScopes.map(unknownQuotaScopeReason).join("; ") || undefined;
        // Windows of unknown scope alone are not a fresh, limit-free reading (#394).
        if (parsed.constraints.length === 0)
          return {
            note,
            absence: agyAbsence(
              candidate.subjectId,
              "refresh_failed",
              "agy quota carried only groups of unknown model scope (not account-wide limits)",
            ),
          };
        // Which window governs a run that names no model depends on the model
        // this profile is actually set to, which the vendor answers for free.
        const beforeModel = prepareFailure();
        if (beforeModel) return { absence: beforeModel };
        const selected = await readAgySelectedModel(bin, env, options.platform);
        return {
          note,
          snapshot: {
            subject: {
              harness: "agy" as const,
              credential_route: "vendor_native" as const,
              plan_label: parsed.planLabel,
              subject_id: candidate.subjectId,
            },
            constraints: scopeUnspecifiedModel(parsed.constraints, selected),
            source: "agy_command_usage" as const,
            observed_at: new Date().toISOString(),
            freshness: "fresh" as const,
          },
        };
      } catch (err) {
        return {
          absence: agyAbsence(
            candidate.subjectId,
            "refresh_failed",
            redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
          ),
        };
      }
    }),
    (candidate) =>
      agyAbsence(
        candidate.subjectId,
        "probe_skipped_rate_limited",
        "a sibling profile's quota probe hit the vendor rate limit this cycle",
      ),
  );
  for (const result of results) {
    if (result.snapshot) snapshots.push(result.snapshot);
    if (result.absence) absences.push(result.absence);
  }
  return { snapshots, absences };
}

const AGY_QUOTA_CONCURRENCY = 3;

/** `note` is diagnostic evidence for the probe's terminal receipt only. */
type AgyCandidateResult = { snapshot?: QuotaSnapshot; absence?: QuotaAbsence; note?: string };

type AgyQuotaReport = (
  operationId: string,
  subjectId: string,
  outcome: QuotaRefreshDiagnostic["outcome"],
  reason?: string,
) => void;

/** One observation receipt per decision or probe outcome on the production
 * diagnostic sink; it never decides whether the refresh succeeded. A probe's
 * started and terminal receipts share one operation id; each standalone skip
 * has its own. */
function agyQuotaReporter(
  sink: QuotaDiagnosticSink | undefined,
  cycle: QuotaRefreshCycle | undefined,
): AgyQuotaReport {
  return (operationId, subjectId, outcome, reason) =>
    emitQuotaDiagnostic(sink, {
      operationId,
      source: "agy_command_usage",
      profileId: subjectId,
      at: new Date().toISOString(),
      foreground: cycle?.foreground ?? false,
      credentialEpoch: null,
      current: null,
      stage: "poll",
      outcome,
      ...(reason ? { reason } : {}),
    });
}

/** The candidates this cycle may spawn the vendor for. An exact account
 * target never fans out to other accounts (its universe claims are narrowed
 * the same way); a subject under its own poll floor is stated `poll_paced`
 * without a call; a background cycle skips subjects whose primary evidence is
 * not due, keeping their existing snapshot. */
function selectAgyCycleCandidates(
  universe: { candidates: AgyQuotaCandidate[]; absences: QuotaAbsence[] },
  cycle: QuotaRefreshCycle | undefined,
  report: AgyQuotaReport,
): { due: AgyQuotaCandidate[]; absences: QuotaAbsence[] } {
  const target = cycle?.target;
  const targeted = (subjectId: string | null) =>
    !target || (target.harness === "agy" && target.profile_id === subjectId);
  const absences = universe.absences.filter((absence) => targeted(absence.subject.subject_id));
  const due: AgyQuotaCandidate[] = [];
  for (const candidate of universe.candidates) {
    if (!targeted(candidate.subjectId)) continue;
    const subject = agySubject(candidate.subjectId);
    const pacedUntil = cycle?.pacing?.cooldownUntil(subject, Date.now());
    if (pacedUntil !== null && pacedUntil !== undefined) {
      report(randomUUID(), candidate.subjectId, "skipped", "subject_rate_limited");
      absences.push(
        agyAbsence(
          candidate.subjectId,
          "poll_paced",
          `quota poll paused by rate-limit cooldown until ${new Date(pacedUntil).toISOString()}`,
        ),
      );
      continue;
    }
    if (cycle?.shouldRefresh?.(subject) === false) {
      report(randomUUID(), candidate.subjectId, "skipped", "primary_evidence_not_due");
      continue;
    }
    due.push(candidate);
  }
  return { due, absences };
}

function reportedProbe(
  report: AgyQuotaReport,
  probe: (candidate: AgyQuotaCandidate) => Promise<AgyCandidateResult>,
): (candidate: AgyQuotaCandidate) => Promise<AgyCandidateResult> {
  return async (candidate) => {
    const operationId = randomUUID();
    report(operationId, candidate.subjectId, "started");
    const result = await probe(candidate);
    report(
      operationId,
      candidate.subjectId,
      result.snapshot ? "succeeded" : "failed",
      [result.absence?.reason, result.note].filter(Boolean).join("; ") || undefined,
    );
    return result;
  };
}

/** Bounded-concurrency map with a rate-limit short-circuit: at most `limit`
 * probes in flight; once any settled result carries a typed `rate_limited`
 * absence, the still-unstarted candidates are not probed and receive the
 * caller's skip absence instead. Results keep candidate order. */
async function mapBoundedUntilRateLimited<T>(
  candidates: readonly T[],
  limit: number,
  probe: (candidate: T) => Promise<AgyCandidateResult>,
  skip: (candidate: T) => QuotaAbsence,
): Promise<AgyCandidateResult[]> {
  const results: AgyCandidateResult[] = new Array<AgyCandidateResult>(candidates.length);
  let next = 0;
  let rateLimited = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= candidates.length) return;
      next += 1;
      if (rateLimited) {
        results[index] = { absence: skip(candidates[index]!) };
        continue;
      }
      const result = await probe(candidates[index]!);
      results[index] = result;
      if (result.absence?.reason === "rate_limited") rateLimited = true;
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, candidates.length)) }, () => worker()),
  );
  return results;
}

/**
 * The model this profile currently routes an unspecified-model run to. The
 * vendor answers `/model` from the CLI without spending a turn; a failure
 * leaves it null and the caller falls back to the Gemini group, which is what
 * a fresh profile selects.
 */
async function readAgySelectedModel(
  bin: string,
  env: Record<string, string | null | undefined>,
  platform?: NodeJS.Platform,
): Promise<string | null> {
  const result = await readAgyCommand(bin, "/model", env, platform);
  if (result.kind !== "success") return null;
  const command = result.envelope["command"];
  if (!command || typeof command !== "object" || Array.isArray(command)) return null;
  const data = (command as Record<string, unknown>)["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const id = (data as Record<string, unknown>)["id"];
  return typeof id === "string" && id ? id : null;
}

/**
 * Stamp the ONE group that governs a run naming no model. Every agy window is
 * model-scoped, and a scoped window deliberately cannot refuse a route whose
 * model is unknowable before spawn — so without this stamp an exhausted
 * account could never refuse a bare run or trigger rotation (Л-2). The stamp
 * follows the profile's SELECTED model rather than an assumption, because a
 * user who picks a Claude slug would otherwise rotate on Gemini exhaustion and
 * never be refused on their own.
 */
function scopeUnspecifiedModel(
  constraints: QuotaConstraint[],
  selectedModel: string | null,
): QuotaConstraint[] {
  // The unreadable default retains the vendor's documented Gemini default.
  // A known family uses the same predicate as admission/budget. An explicit
  // unknown family remains unverified, never assigned every group's quota.
  const selected = selectedModel ?? "gemini-";
  return constraints.map((constraint) =>
    constraint.applies_to_models || constraint.applies_to_model_prefixes?.length
      ? {
          ...constraint,
          applies_to_unspecified_model:
            constraint.applies_to_models?.includes(selected) === true ||
            quotaModelPrefixMatches(constraint.applies_to_model_prefixes, selected),
        }
      : constraint,
  );
}

interface AgyQuotaCandidate {
  home: string;
  subjectId: string;
}

function agyQuotaCandidates(platform: NodeJS.Platform = process.platform): {
  candidates: AgyQuotaCandidate[];
  absences: QuotaAbsence[];
} {
  const global = loadConfig(noProjectRepoRoot()).global;
  if (global.harnesses.agy?.enabled === false) return { candidates: [], absences: [] };
  const candidates: AgyQuotaCandidate[] = [];
  const absences: QuotaAbsence[] = [];
  const enabled = global.credential_profiles.filter(
    (profile) =>
      profile.harness_id === "agy" && profile.enabled && profile.credential_kind !== "api_key",
  );
  const cardinality = credentialProfilePolicyState({
    adapter: { id: "agy", capabilityProfile: AGY_CAPABILITY_PROFILE },
    registry: global.credential_profiles,
    platform,
  });
  if (cardinality.ambiguous) {
    return {
      candidates: [],
      absences: enabled.map((profile) =>
        agyAbsence(
          profile.profile_id,
          "credential_profile_ambiguous",
          `agy has ${cardinality.enabledProfileCount} enabled bindings on ${cardinality.platform}; disable extra profiles before quota can select or probe this OS-user credential`,
        ),
      ),
    };
  }
  for (const profile of global.credential_profiles) {
    if (profile.harness_id !== "agy" || !profile.enabled) continue;
    if (profile.credential_kind !== "config_dir_login") continue;
    // A profile the subject universe still lists must yield a CLAIM either
    // way: silently skipping a malformed or locator-less row would degrade it
    // to `no_source` with no reason anyone can read (review Ф2 #9).
    try {
      if (!profile.isolation_locator) throw new Error("profile has no isolation locator");
      candidates.push({
        home: canonicalAgyProfileHome(profile.isolation_locator),
        subjectId: profile.profile_id,
      });
    } catch (err) {
      absences.push(
        agyAbsence(
          profile.profile_id,
          "refresh_failed",
          redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
        ),
      );
    }
  }
  return { candidates, absences };
}

function agySubject(subjectId: string): QuotaSubject {
  return {
    harness: "agy",
    credential_route: "vendor_native",
    plan_label: null,
    subject_id: subjectId,
  };
}

function agyAbsence(
  subjectId: string,
  reason: QuotaAbsence["reason"],
  detail: string,
): QuotaAbsence {
  return {
    subject: agySubject(subjectId),
    reason,
    detail,
    observed_at: new Date().toISOString(),
  };
}

/** A measured window of a quota group the adapter does not recognize. */
interface AgyUnknownScope {
  id: string;
  group: string;
  used_ratio: number | null;
  resets_at: string | null;
}

type AgyQuotaParse =
  | {
      kind: "constraints";
      constraints: QuotaConstraint[];
      unknownScopes: AgyUnknownScope[];
      planLabel: string | null;
    }
  | { kind: "auth_revoked"; detail: string }
  | { kind: "failed"; detail: string };

/**
 * Shared adapter-owned bounded runner/classifier. No token/keyring precheck:
 * only the vendor envelope proves auth, and every operational failure stays a
 * refresh failure rather than a false logout.
 */
async function readAgyCommand(
  bin: string,
  command: "/model" | "/quota",
  env: Record<string, string | null | undefined>,
  platform?: NodeJS.Platform,
): Promise<AgyPrintClassification> {
  return classifyAgyPrintResult(await runAgyPrintCommand(bin, command, env, { platform }));
}

/** Spawn the vendor's own `/quota` slash command and parse it tolerantly. */
async function readAgyQuota(
  bin: string,
  env: Record<string, string | null | undefined>,
  platform?: NodeJS.Platform,
): Promise<AgyQuotaParse> {
  const result = await readAgyCommand(bin, "/quota", env, platform);
  if (result.kind === "unauthenticated") return { kind: "auth_revoked", detail: result.detail };
  if (result.kind === "probe_failed") return { kind: "failed", detail: result.detail };
  return parseAgyQuotaSuccessEnvelope(result.envelope);
}

/**
 * Tolerant parser for the `/quota` envelope (fixtures/agy-quota-print*.json).
 * DIFFERENT account tiers return DIFFERENT window sets (a lower tier has no
 * 5-hour windows — PLAN §1.2a), so a missing window is normal, never an error.
 * Each of the two vendor GROUPS ("Gemini Models", "Claude and GPT models")
 * becomes constraints tagged with its group's model slugs, so a spent Claude
 * window can never block Gemini routing (INV-136 model scope; roast E2/grok).
 */
export function parseAgyQuotaEnvelope(raw: string): AgyQuotaParse {
  const classified = classifyAgyPrintResult({
    kind: "completed",
    code: 0,
    signal: null,
    stdout: raw,
    stderr: "",
  });
  if (classified.kind === "unauthenticated")
    return { kind: "auth_revoked", detail: classified.detail };
  if (classified.kind === "probe_failed") return { kind: "failed", detail: classified.detail };
  return parseAgyQuotaSuccessEnvelope(classified.envelope);
}

function parseAgyQuotaSuccessEnvelope(parsed: Record<string, unknown>): AgyQuotaParse {
  const command = parsed["command"];
  const data =
    command && typeof command === "object" && !Array.isArray(command)
      ? (command as Record<string, unknown>)["data"]
      : null;
  const groups =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)["groups"]
      : null;
  if (!Array.isArray(groups)) return { kind: "failed", detail: "agy quota envelope had no groups" };
  const constraints: QuotaConstraint[] = [];
  const unknownScopes: AgyUnknownScope[] = [];
  for (const group of groups) {
    const scope = modelsForGroup(String(group?.name ?? ""));
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const remaining =
        typeof bucket?.remaining_fraction === "number" ? bucket.remaining_fraction : null;
      const usedRatio = remaining === null ? null : Math.min(1, Math.max(0, 1 - remaining));
      const window = String(bucket?.window ?? "");
      const groupName = String(group?.name ?? "agy");
      const candidate = {
        // `??` alone is not enough: the vendor's blank string is not nullish,
        // and a blank id/label fails the schema's min(1) (review Ф2 #3).
        id: nonBlank(bucket?.id) ?? `${groupName}-${window || "window"}`,
        label: nonBlank(bucket?.name) ?? nonBlank(window) ?? "Requests",
        ...scope,
        // Which window governs a run that NAMES NO MODEL is stamped by
        // scopeUnspecifiedModel from the profile's actually selected model —
        // one owner, so the parser never guesses it.
        used_ratio: usedRatio,
        // Own-property lookup only: a `window` of `__proto__`/`toString`
        // otherwise resolves to an inherited value, not a number.
        window_seconds: Object.hasOwn(WINDOW_SECONDS, window) ? WINDOW_SECONDS[window]! : null,
        resets_at: isoOrNull(bucket?.reset_time),
        cooldown_until: null,
      };
      // One unparseable window must never cost the account its whole batch:
      // the daemon drops the ENTIRE agy result — snapshots and absences — when
      // a single constraint fails schema validation downstream.
      const checked = QuotaConstraintSchema.safeParse(candidate);
      if (!checked.success) continue;
      // An unrecognized group's models are unknown: its window is evidence,
      // never an account-wide restriction (#394).
      if (scope) constraints.push(checked.data);
      else
        unknownScopes.push({
          id: checked.data.id,
          group: groupName,
          used_ratio: checked.data.used_ratio,
          resets_at: checked.data.resets_at,
        });
    }
  }
  if (constraints.length === 0 && unknownScopes.length === 0)
    return { kind: "failed", detail: "agy quota envelope carried no windows" };
  return { kind: "constraints", constraints, unknownScopes, planLabel: null };
}

/** A vendor string that is neither missing nor blank. */
function nonBlank(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** The vendor's reset stamp only when it really is a date; a garbage string
 * would otherwise fail the schema's datetime check and drop the batch. */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const WINDOW_SECONDS: Record<string, number> = {
  "5h": 5 * 60 * 60,
  weekly: 7 * 24 * 60 * 60,
};

/** Group names are vendor fields; model ids themselves never pick a group.
 * An unrecognized group has no known model scope (null). */
function modelsForGroup(
  groupName: string,
): Pick<QuotaConstraint, "applies_to_models" | "applies_to_model_prefixes"> | null {
  const n = groupName.toLowerCase();
  if (n.includes("gemini")) return AGY_QUOTA_MODEL_GROUPS.gemini;
  if (n.includes("claude") || n.includes("gpt")) return AGY_QUOTA_MODEL_GROUPS.thirdParty;
  return null;
}
