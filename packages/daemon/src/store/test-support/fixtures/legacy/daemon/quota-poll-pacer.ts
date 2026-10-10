import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QuotaSubject } from "../schema/index.js";

const POLL_BACKOFF_MS = 60_000;
const MAX_POLL_BACKOFF_MS = 15 * 60_000;
/** Ceiling on the vendor rate-limit floor (7 days, aligned with the
 * Retry-After parser's clamp): valid long vendor floors are honored in full —
 * the plan's max(exponential, retryAfterMs) — while a buggy or hostile value
 * cannot silence a vendor's polling unboundedly. */
const MAX_RATE_LIMIT_FLOOR_MS = 7 * 24 * 60 * 60_000;

/**
 * Daemon-private persistence for poll floors: current subject/route floors and
 * legacy per-vendor floors retained through their recorded deadlines. Deliberately OUTSIDE the quota journal and every quota projection
 * (owner decision 7=A): a throttled POLL is pacing state, never quota truth —
 * journaling it as a cooldown would read as "window exhausted" to rotation
 * and to external consumers of the quota surface.
 */
export interface QuotaPacerStateStore {
  /** Legacy vendor floor, retained for upgrades; 0 = none. */
  load(vendor: string): number;
  loadSubject?(subject: QuotaSubject): number;
  saveSubject?(subject: QuotaSubject, notBeforeMs: number): void;
}

/** File-backed store under the daemon dir. Best-effort durability: a missing,
 * corrupt, or unwritable file only forgets the floor (fail-open to polling),
 * it never breaks the poll cycle. */
export function quotaPacerFileStore(dir: string): QuotaPacerStateStore {
  const path = join(dir, "quota-pacer-state.json");
  const read = (): {
    vendors: Record<string, { not_before?: unknown }>;
    subjects: Record<string, { not_before?: unknown }>;
  } => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        version?: unknown;
        vendors?: unknown;
      };
      const record = (value: unknown): Record<string, { not_before?: unknown }> =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, { not_before?: unknown }>)
          : {};
      return parsed?.version === 1 || parsed?.version === 2
        ? {
            vendors: record(parsed.vendors),
            subjects: record((parsed as { subjects?: unknown }).subjects),
          }
        : { vendors: {}, subjects: {} };
    } catch {
      return { vendors: {}, subjects: {} };
    }
  };
  const load = (section: "vendors" | "subjects", key: string): number => {
    const iso = read()[section][key]?.not_before;
    const at = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(at) ? at : 0;
  };
  const save = (section: "vendors" | "subjects", key: string, until: number): void => {
    const state = read();
    state[section][key] = { not_before: new Date(until).toISOString() };
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ version: 2, ...state }, null, 2)}\n`);
    renameSync(tmp, path);
  };
  return {
    load: (vendor) => load("vendors", vendor),
    loadSubject: (subject) => load("subjects", subjectKey(subject)),
    saveSubject: (subject, until) => save("subjects", subjectKey(subject), until),
  };
}

function subjectKey(subject: QuotaSubject): string {
  return JSON.stringify([subject.harness, subject.credential_route, subject.subject_id]);
}

/** One vendor lane's demand ladder plus subject/route poll floors. Healthy
 * renewals retain the existing single serial sweep. Only legacy persisted
 * vendor floors suppress the whole lane; new 429s never infer vendor scope. */
export class QuotaPollPacer {
  private readonly subjectFloors = new Map<string, { until: number; observed: number }>();
  private credentialAliases = new Map<string, readonly QuotaSubject[]>();
  private readonly subjectFailures = new Map<string, { observedAt: number; count: number }>();
  private failures = 0;
  private notBefore = 0;
  /** Completion instant of the cycle that armed the current retry ladder
   * (0 = no ladder armed). Evidence observed AFTER it was not known to the
   * ladder and may bypass it. */
  private armedAt = 0;
  private rateLimitedNotBefore = 0;
  /** When the active floor was observed (0 = unknown, e.g. store-loaded). */
  private rateLimitedSince = 0;

  constructor(
    private readonly vendor: string | null = null,
    private readonly store?: QuotaPacerStateStore,
  ) {
    if (this.vendor !== null && this.store) {
      try {
        this.rateLimitedNotBefore = this.store.load(this.vendor);
      } catch {
        /* fail-open: a broken store never blocks polling */
      }
    }
  }

  /** Credential/routability changes reset retry ladders, never recorded poll
   * floors: a profile toggle or restart must not become a 429 amplifier. */
  noteCredentialChange(): void {
    this.failures = 0;
    this.notBefore = 0;
    this.armedAt = 0;
    this.subjectFailures.clear();
  }

  /** May the lane poll now? The vendor rate-limit floor is absolute. The retry
   * ladder is not: `renewalDueObservedAt` — the latest observation instant of
   * satisfying evidence whose renewal is due by the next tick — bypasses the
   * ladder when it post-dates the ladder's arm, because that evidence (a
   * foreground refresh, an ingested harness event) was installed after the
   * ladder was armed and the ladder must not postpone its renewal. Evidence
   * the arming cycle itself produced is capped by `armBackoff` instead. */
  pollEligible(now: number, renewalDueObservedAt: number | null = null): boolean {
    if (now < this.rateLimitedNotBefore) return false;
    if (now >= this.notBefore) return true;
    return renewalDueObservedAt !== null && renewalDueObservedAt > this.armedAt;
  }

  /** Active floor for a subject, or legacy whole-lane floor when omitted. */
  rateLimitCooldownUntil(now: number, subject?: QuotaSubject): number | null {
    const floor = subject === undefined ? 0 : this.subjectFloor(subject).until;
    const until = Math.max(this.rateLimitedNotBefore, floor);
    return now < until ? until : null;
  }

  /** Bind the current source's token-identical rows without retaining tokens or
   * hashes on disk. Pre-binding the complete read makes profile order irrelevant
   * after restart: an alias preceding the cooled row inherits its saved floor. */
  bindCredentials(
    bindings: ReadonlyArray<{ subject: QuotaSubject; credentialHash: string }>,
  ): void {
    const groups = new Map<string, QuotaSubject[]>();
    for (const { subject, credentialHash } of bindings) {
      const identity = JSON.stringify([subject.harness, subject.credential_route, credentialHash]);
      const group = groups.get(identity) ?? [];
      group.push(subject);
      groups.set(identity, group);
    }
    this.credentialAliases = new Map();
    for (const group of groups.values()) {
      const floor = group.reduce(
        (current, subject) => {
          const candidate = this.subjectFloor(subject);
          return candidate.until > current.until ? candidate : current;
        },
        { until: 0, observed: 0 },
      );
      for (const subject of group) {
        this.credentialAliases.set(subjectKey(subject), group);
        this.saveSubjectFloor(subject, floor.until, floor.observed);
      }
    }
  }

  private subjectFloor(subject: QuotaSubject): { until: number; observed: number } {
    const key = subjectKey(subject);
    let floor = this.subjectFloors.get(key);
    if (floor === undefined) {
      let until = 0;
      try {
        until = this.store?.loadSubject?.(subject) ?? 0;
      } catch {
        /* fail-open */
      }
      floor = { until, observed: 0 };
      this.subjectFloors.set(key, floor);
    }
    return floor;
  }

  private saveSubjectFloor(subject: QuotaSubject, until: number, observed: number): void {
    if (until <= this.subjectFloor(subject).until) return;
    this.subjectFloors.set(subjectKey(subject), { until, observed });
    try {
      this.store?.saveSubject?.(subject, until);
    } catch {
      /* fail-open */
    }
  }

  /** Stable observation stamp for the ACTIVE floor's derived gap rows: the
   * instant the floor was observed. A store-loaded floor (daemon restart)
   * has no recorded observation, so the first read anchors it — stability of
   * the projection signature matters more than the exact historical instant,
   * and the anchor is honest ("known paused since at least then"). */
  rateLimitObservedAt(now: number, subject?: QuotaSubject): number {
    if (subject !== undefined && this.subjectFloor(subject).until > this.rateLimitedNotBefore) {
      const floor = this.subjectFloor(subject);
      if (floor.observed === 0) floor.observed = now;
      return floor.observed;
    }
    if (this.rateLimitedSince === 0) this.rateLimitedSince = now;
    return this.rateLimitedSince;
  }

  /** A cycle for this lane completed: reset on fully satisfied demand, else
   * exponential backoff anchored at completion (never the stale start) and
   * capped at `renewalNotBefore` — the tick by which evidence this cycle DID
   * satisfy must be renewed. The ladder paces subjects that produced no
   * evidence; it never postpones the renewal of those that did (one revoked or
   * never-logged-in profile used to pin every healthy sibling of its vendor to
   * the 15-minute ceiling). Null = no satisfied evidence is due later. */
  notePollSuccess(
    completedAt: number,
    demandRemains: boolean,
    renewalNotBefore: number | null = null,
  ): void {
    if (!demandRemains) {
      this.failures = 0;
      this.notBefore = 0;
      this.armedAt = 0;
      return;
    }
    this.armBackoff(completedAt, renewalNotBefore);
  }

  notePollFailure(completedAt: number, renewalNotBefore: number | null = null): void {
    this.armBackoff(completedAt, renewalNotBefore);
  }

  /** A primary observation resets this subject's missing-header retry ladder.
   * Its already-recorded Retry-After floor is still honored until its deadline. */
  noteSubjectSuccess(subject: QuotaSubject): void {
    for (const alias of this.credentialAliases.get(subjectKey(subject)) ?? [subject]) {
      this.subjectFailures.delete(subjectKey(alias));
    }
  }

  /** A 429 paces only its subject and known token-identical aliases. The
   * no-header exponential ladder belongs to that identity too: a healthy
   * sibling's successful renewal must neither reset it nor acquire it. */
  noteRateLimited(observedAt: number, retryAfterMs: number | null, subject: QuotaSubject): void {
    const prior = this.subjectFailures.get(subjectKey(subject));
    const count = prior?.observedAt === observedAt ? prior.count : (prior?.count ?? 0) + 1;
    const exponential = Math.min(POLL_BACKOFF_MS * 2 ** (count - 1), MAX_POLL_BACKOFF_MS);
    const floor = Math.max(exponential, Math.min(retryAfterMs ?? 0, MAX_RATE_LIMIT_FLOOR_MS));
    const until = observedAt + floor;
    for (const alias of this.credentialAliases.get(subjectKey(subject)) ?? [subject]) {
      this.subjectFailures.set(subjectKey(alias), { observedAt, count });
      this.saveSubjectFloor(alias, until, observedAt);
    }
  }

  private armBackoff(completedAt: number, renewalNotBefore: number | null): void {
    this.failures += 1;
    this.armedAt = completedAt;
    const ladder =
      completedAt + Math.min(POLL_BACKOFF_MS * 2 ** (this.failures - 1), MAX_POLL_BACKOFF_MS);
    this.notBefore = renewalNotBefore === null ? ladder : Math.min(ladder, renewalNotBefore);
  }
}
