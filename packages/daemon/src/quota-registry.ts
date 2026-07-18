import type { DurableJournal } from "@claudexor/journal";
import {
  ControlQuotaResponse,
  HarnessEvent,
  QuotaSnapshot as QuotaSnapshotSchema,
  type CredentialRoute,
  type QuotaSnapshot,
} from "@claudexor/schema";

const UPSERTED = "quota.snapshot.upserted";
const REMOVED = "quota.subject.removed";
const POLL_BACKOFF_MS = 60_000;
const MAX_POLL_BACKOFF_MS = 15 * 60_000;
/** Snapshots older than this are pruned from every projection read (W17):
 * a day-old observation is no longer quota truth — surfacing it as a "stale"
 * row forever just clutters the footer with dead subjects. */
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60_000;

export type QuotaRefresher = () => Promise<QuotaSnapshot[]>;

/** Global-journal authority for vendor-owned quota snapshots. */
export class QuotaRegistry {
  private readonly snapshots = new Map<string, QuotaSnapshot>();
  private pollFailures = 0;
  private pollNotBefore = 0;

  constructor(
    private readonly journal: DurableJournal,
    private readonly refreshers: readonly QuotaRefresher[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const record of journal.records()) {
      if (record.type === UPSERTED) this.apply(QuotaSnapshotSchema.parse(record.payload));
      if (record.type === REMOVED) {
        const payload = record.payload as { harness?: unknown; subject_id?: unknown };
        if (typeof payload.harness === "string" && typeof payload.subject_id === "string") {
          this.remove(payload.harness, payload.subject_id);
        }
      }
    }
    this.validateProjection();
  }

  read() {
    return ControlQuotaResponse.parse({
      snapshots: this.activeSnapshots(this.now().getTime()),
      refreshed_at: null,
    });
  }

  /** Freshness-annotated snapshots with expired (>24h) observations pruned.
   * An old observation whose constraint still EXTENDS into the future (a
   * weekly cooldown/reset seen once) is kept and stale-marked: pruning it
   * would hide a live cap from both the footer and the router's ledger. */
  private activeSnapshots(now: number): QuotaSnapshot[] {
    return [...this.snapshots.values()]
      .filter((snapshot) => {
        const observed = Date.parse(snapshot.observed_at);
        if (!Number.isFinite(observed)) return false;
        if (now - observed <= MAX_SNAPSHOT_AGE_MS) return true;
        return snapshot.constraints.some((constraint) =>
          [constraint.cooldown_until, constraint.resets_at].some((raw) => {
            const at = raw ? Date.parse(raw) : Number.NaN;
            return Number.isFinite(at) && at > now;
          }),
        );
      })
      .map((snapshot) => staleAt(snapshot, now));
  }

  async refresh() {
    if (this.refreshers.length === 0) {
      throw Object.assign(new Error("no live vendor-owned quota refresh source is available"), {
        code: "quota_refresh_unavailable",
        status: 503,
      });
    }
    let successfulSources = 0;
    const failures: string[] = [];
    for (const refresher of this.refreshers) {
      try {
        for (const snapshot of await refresher()) this.upsert(snapshot);
        successfulSources += 1;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (successfulSources === 0) {
      throw Object.assign(new Error(`quota refresh failed: ${failures.join("; ")}`), {
        code: "quota_refresh_unavailable",
        status: 503,
      });
    }
    return ControlQuotaResponse.parse({
      snapshots: this.activeSnapshots(this.now().getTime()),
      refreshed_at: this.now().toISOString(),
    });
  }

  /** Background official-source refresh for empty/stale projections with bounded backoff. */
  async pollStale(): Promise<boolean> {
    const now = this.now().getTime();
    const snapshots = this.activeSnapshots(now);
    if (snapshots.length > 0 && snapshots.every((snapshot) => snapshot.freshness === "fresh"))
      return false;
    if (now < this.pollNotBefore) return false;
    try {
      await this.refresh();
      this.pollFailures = 0;
      this.pollNotBefore = now + POLL_BACKOFF_MS;
      return true;
    } catch {
      this.pollFailures += 1;
      this.pollNotBefore =
        now + Math.min(POLL_BACKOFF_MS * 2 ** (this.pollFailures - 1), MAX_POLL_BACKOFF_MS);
      return false;
    }
  }

  ingest(harnessId: string, value: unknown): void {
    const event = HarnessEvent.safeParse(value);
    if (!event.success) return;
    const quota = event.data.quota;
    const credentialRoute = event.data.credential_route;
    if (quota && credentialRoute) {
      this.upsert({
        subject: {
          harness: harnessId,
          credential_route: credentialRoute,
          plan_label: quota.plan_label,
          // Reconcile the subject with the event's Claudexor profile stamp
          // (round-17 #2): a profiled run's quota must never register as the
          // engine-default subject just because the vendor record carries no
          // subject of its own. The profile stamp is the credential identity.
          subject_id: event.data.credential_profile_id ?? quota.subject_id ?? null,
        },
        constraints: quota.constraints,
        source: quota.source,
        observed_at: event.data.ts,
        freshness: "fresh",
      });
    }
    if (event.data.rate_limit && credentialRoute && ["codex", "claude"].includes(harnessId)) {
      this.upsertCooldown(harnessId, credentialRoute, event.data);
    }
  }

  upsert(value: QuotaSnapshot): void {
    const snapshot = QuotaSnapshotSchema.parse(value);
    this.journal.append(UPSERTED, snapshot);
    this.apply(snapshot);
  }

  removeSubject(harness: string, subjectId: string): number {
    const removed = [...this.snapshots.values()].filter(
      (snapshot) =>
        snapshot.subject.harness === harness && snapshot.subject.subject_id === subjectId,
    ).length;
    this.journal.append(REMOVED, { harness, subject_id: subjectId });
    this.remove(harness, subjectId);
    return removed;
  }

  validateProjection(): void {
    for (const snapshot of this.snapshots.values()) QuotaSnapshotSchema.parse(snapshot);
  }

  private upsertCooldown(
    harness: string,
    credentialRoute: CredentialRoute,
    event: ReturnType<typeof HarnessEvent.parse>,
  ): void {
    const reset = event.rate_limit?.resets_at ?? null;
    const delay = event.rate_limit?.retry_delay_ms ?? null;
    const cooldownUntil =
      reset ??
      new Date(
        this.now().getTime() + (typeof delay === "number" ? delay : 5 * 60_000),
      ).toISOString();
    const source = harness === "claude" ? "claude_api_retry" : "codex_rollout";
    // The event's profile stamp scopes the cooldown to ITS subject (release
    // wave round-11): a profiled limit must never cool the default subject
    // down (or vice versa), and two profiles never share one quota key.
    const profileId = event.credential_profile_id ?? null;
    const existing = [...this.snapshots.values()].find(
      (snapshot) =>
        snapshot.subject.harness === harness &&
        snapshot.subject.credential_route === credentialRoute &&
        (snapshot.subject.subject_id ?? null) === profileId &&
        snapshot.source === source,
    );
    this.upsert({
      subject: existing?.subject ?? {
        harness,
        credential_route: credentialRoute,
        plan_label: null,
        subject_id: profileId,
      },
      source,
      observed_at: event.ts,
      freshness: "fresh",
      constraints: [
        ...(existing?.constraints.filter((constraint) => constraint.id !== "cooldown") ?? []),
        {
          id: "cooldown",
          label: "Cooldown",
          used_ratio: null,
          window_seconds: null,
          resets_at: reset,
          cooldown_until: cooldownUntil,
        },
      ],
    });
  }

  private apply(snapshot: QuotaSnapshot): void {
    this.snapshots.set(snapshotKey(snapshot), snapshot);
  }

  private remove(harness: string, subjectId: string): number {
    let removed = 0;
    for (const [key, snapshot] of this.snapshots) {
      if (snapshot.subject.harness === harness && snapshot.subject.subject_id === subjectId) {
        this.snapshots.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

export function quotaProjection(refreshers: readonly QuotaRefresher[] = []) {
  return {
    name: "quota",
    create: (journal: DurableJournal) => new QuotaRegistry(journal, refreshers),
    validate: (registry: QuotaRegistry) => registry.validateProjection(),
  };
}

function snapshotKey(snapshot: QuotaSnapshot): string {
  const subject = snapshot.subject;
  return [
    subject.harness,
    subject.credential_route,
    subject.subject_id ?? "",
    snapshot.source,
  ].join("\0");
}

function staleAt(snapshot: QuotaSnapshot, now: number): QuotaSnapshot {
  if (snapshot.freshness !== "fresh") return snapshot;
  const observed = Date.parse(snapshot.observed_at);
  const resetExpired = snapshot.constraints.some((constraint) => {
    const reset = constraint.resets_at ? Date.parse(constraint.resets_at) : Number.NaN;
    return Number.isFinite(reset) && reset <= now;
  });
  const tooOld = !Number.isFinite(observed) || now - observed > 5 * 60_000;
  return resetExpired || tooOld ? { ...snapshot, freshness: "stale" } : snapshot;
}
