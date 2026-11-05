import {
  compareProcessIdentity,
  type KnownProcessIdentity,
  type ProcessTableReader,
  type ScopeReapOptions,
  type ScopeReapOutcome,
} from "@claudexor/core";
import { reapSources, type RunScopeEntry } from "./run-scope-index-rows.js";

export interface LaterScopeSettlement {
  runId: string;
  marker: string;
  outcome: ScopeReapOutcome;
  attempt: number;
  at: string;
}

export interface LateSettlementDeps {
  entries: () => readonly RunScopeEntry[];
  /** This daemon's own measured identity; null when unreadable (then nothing is provably owned). */
  owner: () => Promise<KnownProcessIdentity | null>;
  reap: (opts: ScopeReapOptions) => Promise<ScopeReapOutcome>;
  table: ProcessTableReader | null;
  /** Each attempt's own absolute budget (the same size as a terminal settlement's). */
  deadlineMs: number;
  /** Record the attempt on its entry (retired only when settled) and await its publication. */
  record: (entry: RunScopeEntry, outcome: ScopeReapOutcome) => Promise<void>;
  log: (message: string) => void;
  now: () => number;
  iso: () => string;
}

/** A listener that throws keeps the attempt's publication owed to it. */
export type LaterSettlementListener = (settlement: LaterScopeSettlement) => void | Promise<void>;

/**
 * A FINISHED run's scope whose terminal settlement stayed unresolved gets
 * separately bounded later attempts while the daemon that opened it is still
 * live. Each attempt is a new reap with a fresh census, the same identity,
 * group and birth rules and its own deadline; it never extends, resumes or
 * signals for the expired terminal attempt (whose reap had finished before the
 * entry became `unresolved`). Open runs, entries of another or an unreadable
 * owner, and hosts without a census are never touched. Attempts are spaced by
 * their own deadline multiple (attempt N waits N deadlines), never back to back,
 * one at a time on the existing capture tick; their number is not capped. The
 * run's terminal record stays historical; the attempt is reported to listeners,
 * and a report a listener failed to take is owed: each later tick reports it
 * again to that listener before any new attempt. A settled report retired its
 * entry, so it is only repeated, never reaped again. An unsettled one is replaced
 * by a newer attempt of its scope, whose report reaches every listener with the
 * fresher fact: a failing listener never stops the reaping, and a run records only
 * its latest attempt. The debt lives with this daemon; after a restart the held
 * draft stays held.
 */
export class LateScopeSettlement {
  private flight: Promise<void> | null = null;
  private readonly listeners = new Set<LaterSettlementListener>();
  /** Earliest next attempt per marker in this daemon life. */
  private readonly due = new Map<string, number>();
  /** Reports still owed per marker, to the listeners that failed them. */
  private readonly owed = new Map<
    string,
    { settlement: LaterScopeSettlement; listeners: Set<LaterSettlementListener> }
  >();

  constructor(private readonly deps: LateSettlementDeps) {}

  subscribe(listener: LaterSettlementListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** At most one attempt in flight; the capture tick starts it and never waits for it. */
  tick(): Promise<void> {
    this.flight ??= this.once()
      .catch((error: unknown) =>
        this.deps.log(`run-scope index: a later settlement attempt failed (${String(error)})`),
      )
      .finally(() => {
        this.flight = null;
      });
    return this.flight;
  }

  private async once(): Promise<void> {
    for (const [marker, debt] of this.owed) {
      const failed = await this.report(debt.settlement, debt.listeners);
      if (failed.size === 0) this.owed.delete(marker);
      else debt.listeners = failed;
    }
    const self = await this.deps.owner();
    if (!self) return;
    const now = this.deps.now();
    const entry = this.deps.entries().find((candidate) => this.eligible(candidate, self, now));
    if (!entry) return;
    const attempt = (entry.late_attempts ?? 0) + 1;
    const outcome = await this.deps.reap({
      marker: entry.marker,
      deadlineMs: this.deps.deadlineMs,
      ...reapSources(entry),
      ...(this.deps.table ? { table: this.deps.table } : {}),
    });
    const at = this.deps.iso();
    entry.late_attempts = attempt;
    entry.last_attempt_at = at;
    this.due.set(entry.marker, this.deps.now() + attempt * this.deps.deadlineMs);
    await this.deps.record(entry, outcome);
    const settlement = { runId: entry.run_id, marker: entry.marker, outcome, attempt, at };
    // A newer attempt of the same scope replaces any unsettled report still owed for it.
    this.owed.delete(entry.marker);
    const failed = await this.report(settlement, this.listeners);
    if (failed.size > 0) this.owed.set(entry.marker, { settlement, listeners: failed });
  }

  /** Report to each still-subscribed listener; returns those that failed. */
  private async report(
    settlement: LaterScopeSettlement,
    listeners: ReadonlySet<LaterSettlementListener>,
  ): Promise<Set<LaterSettlementListener>> {
    const failed = new Set<LaterSettlementListener>();
    for (const listener of [...listeners].filter((item) => this.listeners.has(item))) {
      try {
        await listener(settlement);
      } catch (error) {
        failed.add(listener);
        this.deps.log(`run-scope index: a later settlement report is owed (${String(error)})`);
      }
    }
    return failed;
  }

  private eligible(entry: RunScopeEntry, self: KnownProcessIdentity, now: number): boolean {
    if (entry.state !== "unresolved" || !entry.owner) return false;
    if (compareProcessIdentity(entry.owner, self) !== "same") return false;
    if (entry.outcome?.census === "unsupported") return false;
    const settledAt = Date.parse(entry.settled_at ?? "");
    const first = Number.isFinite(settledAt) ? settledAt + this.deps.deadlineMs : now;
    return now >= (this.due.get(entry.marker) ?? first);
  }
}
