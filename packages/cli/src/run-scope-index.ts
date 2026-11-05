/**
 * The daemon's durable run-scope index (`daemon/run-scopes.json`): the
 * discovery record a crashed daemon's next life needs to end what its runs
 * left running, and the live-capture store the directive's second membership
 * source writes to.
 *
 * One entry per run: the marker, the run id, the daemon identity that opened
 * it (measured birth — a stale "running" row of a dead generation is never a
 * live owner), the run's recorded descendants `(pid, pgid, birth)` and the
 * birth floor of its scope. Written BEFORE the first launch; an entry is
 * retired only after a verified settlement (every census source succeeded,
 * nothing survived or stayed unreadable) and is otherwise kept as
 * `unresolved` with its outcome. Daemon start settles or discloses every
 * entry whose owner is not provably live BEFORE the workspace sweep, and never
 * touches a grammar-shaped marker that is not in this index (the embedding
 * host carries its own installation marker). Cooperative shutdown never
 * erases the file: unresolved entries are the next start's duty. While this
 * daemon stays live, a FINISHED run's unresolved entry it opened gets a few
 * separately bounded later attempts (`run-scope-late-settlement.ts`). Writes
 * are compact and coalesced; each change still waits for its own publication.
 *
 * Capture rides the daemon's existing 2 s pids tick (no new timer): one
 * asynchronous process-table snapshot per tick, each live harness root's
 * descendants walked by PPID while the chain is intact (Cursor `setsid`s its
 * shells, so a shell and its `find` are captured within one tick of being
 * spawned), new rows appended to that run's entry and persisted.
 */
import { join } from "node:path";
import {
  compareProcessIdentity,
  createProcessTableReader,
  defaultAsyncProcessIdentityReader,
  descendantProcessRows,
  liveChildProcesses,
  mintRunScopeMarker,
  onChildProcessRegistered,
  reapScopeMembers,
  scopeReapDeadlineMs,
  type AsyncProcessIdentityReader,
  type KnownProcessIdentity,
  type LiveChildProcess,
  type ProcessTableReader,
  type ScopeReapOptions,
  type ScopeReapOutcome,
} from "@claudexor/core";
import type { RunScopeCustodian } from "@claudexor/orchestrator";
import {
  describe,
  earlierBirth,
  reapSources,
  summarize,
  type RunScopeEntry,
} from "./run-scope-index-rows.js";
import {
  loadRunScopeIndex,
  runScopeIndexBody,
  RunScopeIndexPublisher,
} from "./run-scope-index-file.js";
import { LateScopeSettlement, type LaterSettlementListener } from "./run-scope-late-settlement.js";
import { daemonDir, logPath } from "@claudexor/daemon";
import { logLine } from "./log-line.js";

export const RUN_SCOPE_INDEX_FILE = "run-scopes.json";

export interface DaemonRunScopeIndexOptions {
  path: string;
  /** The daemon's own measured identity (memoised; read asynchronously once). */
  owner?: () => Promise<KnownProcessIdentity | null>;
  identity?: AsyncProcessIdentityReader;
  table?: ProcessTableReader;
  reap?: (opts: ScopeReapOptions) => Promise<ScopeReapOutcome>;
  /** Live harness roots with their markers (default: the process registry). */
  /** Live harness roots with their markers (default: the process registry,
   * whose registrations also seed each root's group at spawn). */
  roots?: () => ReadonlyArray<LiveChildProcess>;
  /** The one settlement deadline (ms) a `settle` is bounded by: the wait for
   * in-flight seeds and the reap share it. Default: the reap's own. */
  deadlineMs?: number;
  log?: (message: string) => void;
  now?: () => string;
  /** Later bounded attempts for finished runs this daemon owns (#613); the daemon index sets it. */
  laterAttempts?: boolean;
}

export class DaemonRunScopeIndex implements RunScopeCustodian {
  private entries: RunScopeEntry[] | null = null;
  /** Rows this engine cannot parse, kept verbatim in the file (unknown obligations). */
  private unrecognized: Array<{ index: number; value: unknown }> = [];
  private readonly publisher: RunScopeIndexPublisher;
  private readonly late: LateScopeSettlement;
  private ownerIdentity: Promise<KnownProcessIdentity | null> | null = null;
  private capturing: Promise<void> | null = null;
  private readonly identity: AsyncProcessIdentityReader;
  private readonly table: ProcessTableReader | null;
  private readonly reap: (opts: ScopeReapOptions) => Promise<ScopeReapOutcome>;
  private readonly roots: () => ReadonlyArray<LiveChildProcess>;
  private readonly deadlineMs: number;
  /** In-flight seed refinements per marker (a settle waits only for its own run's). */
  private readonly seeding = new Map<string, Set<Promise<void>>>();
  /** Markers whose settlement stopped waiting while refinements were still pending. */
  private readonly expiredSeeds = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  /** Set when the index file had to be preserved aside; surfaced as a startup action. */
  private unreadableNotice: string | null = null;
  private readonly log: (message: string) => void;
  private readonly now: () => string;

  constructor(private readonly options: DaemonRunScopeIndexOptions) {
    this.identity = options.identity ?? defaultAsyncProcessIdentityReader;
    this.table =
      options.table ?? (process.platform === "win32" ? null : createProcessTableReader());
    this.reap = options.reap ?? reapScopeMembers;
    this.roots = options.roots ?? liveChildProcesses;
    this.deadlineMs = options.deadlineMs ?? scopeReapDeadlineMs();
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => new Date().toISOString());
    this.publisher = new RunScopeIndexPublisher(
      options.path,
      () => runScopeIndexBody({ entries: this.load(), unrecognized: this.unrecognized }),
      this.log,
    );
    this.late = new LateScopeSettlement({
      entries: () => this.load(),
      owner: () => this.owner(),
      reap: (opts) => this.reap(opts),
      table: this.table,
      deadlineMs: this.deadlineMs,
      record: async (entry, outcome) => {
        const before = entry.outcome;
        const message = this.retireOrKeep(entry, outcome);
        // Timing/attempt counters remain publication facts, not repeated diagnostics.
        const diagnostic = (value: typeof before) => value && { ...value, duration_ms: 0 };
        if (
          outcome.settled ||
          JSON.stringify(diagnostic(before)) !== JSON.stringify(diagnostic(entry.outcome))
        )
          this.log(`${message}; later attempt ${entry.late_attempts}`);
        await this.persistQuietly(`later settlement of ${entry.run_id}`);
      },
      log: this.log,
      now: Date.now,
      iso: this.now,
    });
    // Production: every harness root the engine spawns seeds its own group the
    // moment it is registered; tests inject `roots` and call `seedRoot` directly.
    if (!options.roots) {
      this.unsubscribe = onChildProcessRegistered((child) => {
        if (child.scopeMarker) void this.seedRoot(child);
      });
    }
  }

  /** Observe later settlement attempts of finished runs (#613); returns the unsubscribe. */
  onLaterSettlement(listener: LaterSettlementListener): () => void {
    return this.late.subscribe(listener);
  }

  /** Stop observing registrations (tests; the daemon's index lives as long as the daemon). */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Record a freshly spawned harness root's own process group (pgid, leader
   * pid, leader birth) and the scope floor BEFORE any capture tick, so a root
   * that exits within milliseconds still leaves its group on record and a
   * same-group leftover (a platform binary started with `&` by that shell) is
   * ended at the barrier. The root's measured identity is checked against the
   * registry's spawn-time handle first; a pid that no longer is that process
   * seeds nothing. Resolves once the seed is persisted (or found impossible).
   */
  seedRoot(child: LiveChildProcess): Promise<void> {
    const job = (async () => {
      try {
        if (!child.scopeMarker) return;
        const entry = this.load().find((item) => item.marker === child.scopeMarker);
        if (!entry || entry.state !== "open") return;
        // SYNCHRONOUS seed from the registry handle (fix round 2 item 10): the
        // group id and the leader's measured identity are known the moment
        // the root is registered, so a root that exits within milliseconds
        // still leaves its group on record; the floor is `opened_at` until a
        // birth is known.
        let group = entry.root_groups.find((g) => g.leader_pid === child.pid);
        if (!group) {
          group = {
            pgid: child.processGroup.pgid,
            leader_pid: child.pid,
            leader_birth: null,
            leader_identity: child.processGroup.leader,
          };
          entry.root_groups.push(group);
          await this.persistQuietly(`root group of ${child.pid}`);
        }
        if (!this.table) return;
        // Refinement: the leader's lstart, read only while it is still the
        // spawn-time leader BEFORE and AFTER the table read (item 8), and only
        // while this run's settlement still waits for it: past that point no
        // read starts and nothing more is recorded (the group above stands).
        const marker = child.scopeMarker;
        const waited = (): boolean => !this.expiredSeeds.has(marker);
        if (!waited() || !(await this.rootStillSame(child)) || !waited()) return;
        const row = await this.table.row(child.pid);
        if (row === null || row === "unreadable") return; // exited already, or unreadable
        if (!waited() || !(await this.rootStillSame(child)) || !waited()) return;
        group.leader_birth = row.birth;
        if (!entry.captured.some((c) => c.pid === row.pid && c.birth === row.birth))
          entry.captured.push({ pid: row.pid, pgid: row.pgid, birth: row.birth });
        entry.scope_start = earlierBirth(entry.scope_start, row.birth);
        await this.persistQuietly(`root birth of ${child.pid}`);
      } catch (error) {
        this.log(
          `run-scope index: seeding root ${child.pid} failed (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      }
    })();
    if (child.scopeMarker) {
      const marker = child.scopeMarker;
      const jobs = this.seeding.get(marker) ?? new Set<Promise<void>>();
      jobs.add(job);
      this.seeding.set(marker, jobs);
      void job.finally(() => {
        jobs.delete(job);
        if (jobs.size === 0 && this.seeding.get(marker) === jobs) {
          this.seeding.delete(marker);
          this.expiredSeeds.delete(marker);
        }
      });
    }
    return job;
  }

  private async persistQuietly(what: string): Promise<void> {
    try {
      await this.persist();
    } catch (error) {
      this.log(
        `run-scope index: ${what} could not be persisted (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  /**
   * Awaited by settle so THIS run's seed refinement in flight (the optional
   * birth/identity read that follows the synchronous group record) is never
   * raced by the reap — for at most the budget remainder: a refinement hung
   * on a `ps -p` or identity read (bounded by their own longer timeouts) must
   * not extend the cancel path, and the reap then runs on what is recorded;
   * a refinement still pending then starts no read and records nothing more.
   * Another run's seeds are never awaited (Astra R3).
   */
  private async seedsSettled(marker: string, deadlineMs: number): Promise<void> {
    const jobs = this.seeding.get(marker);
    if (!jobs || jobs.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.allSettled([...jobs]), expiry]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Settlement waits no longer: what of this run still refines is cut off
    // (`seeding` keeps a marker only while one of its refinements is pending).
    if (this.seeding.has(marker)) this.expiredSeeds.add(marker);
  }

  /** The registry handle's measured leader identity still owns the pid. */
  private async rootStillSame(child: LiveChildProcess): Promise<boolean> {
    const observed = await this.identity.read(child.pid);
    return compareProcessIdentity(child.processGroup.leader, observed) === "same";
  }

  /** The entries as last loaded/written (a fresh read on first use). */
  list(): RunScopeEntry[] {
    return [...this.load()];
  }

  async open(runId: string): Promise<{ marker: string }> {
    const marker = mintRunScopeMarker();
    const owner = await this.owner();
    this.load().push({
      marker,
      run_id: runId,
      owner,
      state: "open",
      opened_at: this.now(),
      scope_start: null,
      root_groups: [],
      captured: [],
    });
    // Durable BEFORE the first launch. A persistence failure degrades to
    // in-process custody for this run (the barrier still reaps) and is
    // disclosed in the daemon log; it never fails the run.
    try {
      await this.persist();
    } catch (error) {
      this.log(
        `run-scope index: could not record scope for ${runId} before launch (${
          error instanceof Error ? error.message : String(error)
        }); crash recovery will not know this run's leftovers`,
      );
    }
    return { marker };
  }

  async settle(runId: string, marker: string): Promise<ScopeReapOutcome> {
    // ONE absolute settlement budget starts HERE, when the custodian enters
    // settlement for this run: this run's own seed refinement wait consumes
    // part of it and the reap gets the remainder (every census, identity and
    // table read and every signal race it; expiry is disclosed by the reap as
    // `incomplete`). Other runs' seeds are never awaited.
    const started = Date.now();
    await this.seedsSettled(marker, this.deadlineMs);
    const entry = this.load().find((item) => item.marker === marker);
    const outcome = await this.reap({
      marker,
      deadlineMs: Math.max(0, this.deadlineMs - (Date.now() - started)),
      ...(entry ? reapSources(entry) : {}),
      ...(this.table ? { table: this.table } : {}),
    });
    if (entry) {
      this.log(this.retireOrKeep(entry, outcome));
      try {
        await this.persist();
      } catch (error) {
        this.log(
          `run-scope index: could not record settlement of ${runId} (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      }
    }
    return outcome;
  }

  /**
   * One capture pass (the daemon's pids tick calls it): record every live
   * harness root's descendants into its run's entry. Coalesced: a tick that
   * arrives while one runs is skipped, never queued.
   */
  captureTick(): Promise<void> {
    // A later settlement attempt rides the same tick but is never waited for here.
    if (this.options.laterAttempts) void this.late.tick();
    this.publisher.repeat();
    if (this.capturing) return this.capturing;
    this.capturing = this.captureOnce().finally(() => {
      this.capturing = null;
    });
    return this.capturing;
  }

  private async captureOnce(): Promise<void> {
    if (!this.table) return;
    const roots = this.roots().filter((root) => root.scopeMarker);
    if (roots.length === 0) return;
    const entries = this.load();
    const rows = await this.table.snapshot();
    if (rows === null) return; // unreadable table: nothing recorded, nothing erased
    let changed = false;
    for (const root of roots) {
      const entry = entries.find(
        (item) => item.marker === root.scopeMarker && item.state === "open",
      );
      if (!entry) continue;
      // A root whose measured identity no longer matches its spawn-time handle
      // (pid freed and reused) must not have a stranger's tree captured: the
      // identity is checked before AND after the snapshot (items 7/8).
      if (!(await this.rootStillSame(root))) continue;
      const walked = descendantProcessRows(root.pid, rows);
      if (!(await this.rootStillSame(root))) continue;
      const known = new Set(entry.captured.map((c) => `${c.pid}:${c.birth}`));
      for (const row of walked) {
        if (row.pid === root.pid) {
          const floor = earlierBirth(entry.scope_start, row.birth);
          if (floor !== entry.scope_start) {
            entry.scope_start = floor;
            changed = true;
          }
          const group = entry.root_groups.find((g) => g.leader_pid === root.pid);
          if (group && group.leader_birth === null) {
            group.leader_birth = row.birth;
            changed = true;
          }
        }
        const key = `${row.pid}:${row.birth}`;
        if (known.has(key)) continue;
        known.add(key);
        entry.captured.push({ pid: row.pid, pgid: row.pgid, birth: row.birth });
        changed = true;
      }
    }
    if (!changed) return;
    try {
      await this.persist();
    } catch (error) {
      this.log(
        `run-scope index: capture could not be persisted (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  /**
   * Daemon start: settle or disclose every entry whose owner is not provably
   * live (its recorded daemon identity no longer matches a live process; an
   * unreadable or unrecorded owner is not proof of life either — a root
   * authority lease admits one daemon per root, so a previous generation's
   * run cannot still be running). Markers absent from the index are never
   * touched. Returns the disclosed actions for the startup diagnostics.
   */
  async settleDeadOwners(): Promise<string[]> {
    const actions: string[] = [];
    const entries = this.load();
    if (this.unreadableNotice) actions.push(this.unreadableNotice);
    if (entries.length === 0) return actions;
    for (const entry of [...entries]) {
      if (await this.ownerLive(entry)) {
        actions.push(
          `scope ${entry.marker.slice(-8)} of run ${entry.run_id}: owner ${entry.owner?.pid} is live; untouched`,
        );
        continue;
      }
      let outcome: ScopeReapOutcome;
      try {
        outcome = await this.reap({
          marker: entry.marker,
          ...reapSources(entry),
          ...(this.table ? { table: this.table } : {}),
        });
      } catch (error) {
        actions.push(
          `scope ${entry.marker.slice(-8)} of run ${entry.run_id}: reap failed (${
            error instanceof Error ? error.message : String(error)
          }); kept`,
        );
        continue;
      }
      actions.push(this.retireOrKeep(entry, outcome));
    }
    try {
      await this.persist();
    } catch (error) {
      actions.push(
        `run-scope index could not be rewritten (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return actions;
  }

  private async ownerLive(entry: RunScopeEntry): Promise<boolean> {
    if (!entry.owner) return false;
    const observed = await this.identity.read(entry.owner.pid);
    return compareProcessIdentity(entry.owner, observed) === "same";
  }

  /** Retire or keep the entry; returns the disclosure, which names a retirement without proof. */
  private retireOrKeep(entry: RunScopeEntry, outcome: ScopeReapOutcome): string {
    const entries = this.load();
    // A host with no census at all (`unsupported`, Windows) can never settle
    // an entry: keeping it would re-reap it at every start and grow the file
    // without bound, so it is retired once its outcome has been disclosed.
    if (outcome.settled || outcome.census === "unsupported") {
      const at = entries.indexOf(entry);
      if (at >= 0) entries.splice(at, 1);
      return outcome.settled
        ? describe(entry, outcome)
        : `${describe(entry, outcome)}; retired without proof (no environment census on this platform)`;
    }
    entry.state = "unresolved";
    entry.settled_at ??= this.now();
    entry.outcome = summarize(outcome);
    return describe(entry, outcome);
  }

  private owner(): Promise<KnownProcessIdentity | null> {
    this.ownerIdentity ??= (async () => {
      if (this.options.owner) return this.options.owner();
      const self = await this.identity.read(process.pid);
      return self.status === "known" ? self : null;
    })();
    return this.ownerIdentity;
  }

  private load(): RunScopeEntry[] {
    if (this.entries) return this.entries;
    const loaded = loadRunScopeIndex(this.options.path, this.log);
    this.entries = loaded.entries;
    this.unrecognized = loaded.unrecognized;
    this.unreadableNotice = loaded.notice;
    return this.entries;
  }

  /** Compact coalesced publication; resolves once a write carrying THIS change landed. */
  private persist(): Promise<void> {
    this.load();
    return this.publisher.publish(this.publisher.changed());
  }
}

let shared: DaemonRunScopeIndex | null = null;

/** The one index of this daemon (lazily bound to the daemon data root). */
export function daemonRunScopeIndex(): DaemonRunScopeIndex {
  shared ??= new DaemonRunScopeIndex({
    path: join(daemonDir(), RUN_SCOPE_INDEX_FILE),
    log: (message) => logLine(logPath(), message),
    laterAttempts: true,
  });
  return shared;
}
