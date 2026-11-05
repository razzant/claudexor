/**
 * Scope census and reap: find every live process that still carries a scope
 * marker (`process-scope.ts`) in its environment and end it by measured
 * identity. This is the owner of the "a finished run ends what it left" rule:
 * the PPID/process-group ladder (`process-tree.ts`) stays the fast path for a
 * cancel while the tree is intact; a descendant that `setsid`-ed and was
 * reparented to pid 1 after its parent died (the #449 orphans) is reachable
 * only through the marker it inherited — or, where the kernel hides that
 * marker, through the group and birth the daemon RECORDED while the run was
 * live (DIRECTIVE 1): macOS SIP withholds the environment of Apple platform
 * binaries, so membership on POSIX is the UNION of (a) marker members,
 * (b) members of recorded process groups under the pgid-reuse rule and
 * (c) individually recorded descendants, every one signalled by pid after its
 * birth is re-measured (`capturedCandidates` below).
 *
 * Contract (shared with the embedding host):
 * - one asynchronous process-table read per census: macOS streams
 *   `ps -E -ww -A -o pid=,command=` line by line and keeps only matching pids
 *   (the environment column is never buffered whole, logged or persisted);
 *   Linux reads `/proc/<pid>/environ` with bounded concurrency and matches the
 *   exact NUL-delimited entry `NAME=1`;
 * - affirmative membership (`confirm`) AND the measured birth identity are
 *   checked immediately before every signal; a pid is signalled on its own,
 *   never a dead leader's historical process group;
 * - TERM, a bounded grace, then KILL, with a few bounded rescans for forks;
 * - truncation, timeout or reader failure is `failed` — unknown, never an
 *   empty scope; a known member whose identity turns unreadable is reported
 *   separately from unrelated unreadable processes; a vanished, birth-checked
 *   member is gone;
 * - never pid 1, never this process; nothing is ever read from a process's
 *   environment except whether the exact marker entry is present.
 *
 * Limit, stated plainly: on macOS a random key sits in a text column that
 * mixes argv and environment. A stranger whose argv literally contains
 * `NAME=1` for a 128-bit random NAME would be censused; the random id makes
 * that practically impossible, but it is not structural proof.
 *
 * Windows has no environment census without native code: coverage there is
 * `tree_only` (the existing taskkill tree kill while the parent chain exists),
 * disclosed, never turned into a failure.
 */
import {
  compareProcessBirth,
  compareProcessIdentity,
  defaultAsyncProcessIdentityReader,
  type AsyncProcessIdentityReader,
  type KnownProcessIdentity,
} from "./process-identity.js";
import { isScopeMarkerName } from "./process-scope.js";
import {
  createScopeCensusReader,
  LINUX_CONCURRENCY,
  mapBounded,
  scopeAgeSeconds,
  type ScopeCensusReader,
} from "./process-scope-readers.js";
import {
  birthEpochSeconds,
  createProcessTableReader,
  type CapturedProcess,
  type ProcessTableReader,
  type ProcessTableRow,
} from "./process-table.js";

/** The settlement deadline won a race against a read. */
const DEADLINE: unique symbol = Symbol("deadline");

export interface ScopeMemberRecord {
  pid: number;
  /** The measured birth token the member was signalled under. */
  startToken: string;
}

export interface ScopeUnreadableRecord {
  pid: number;
  reason: string;
}

/** What one reap of one marker found and did. Pids and birth tokens only. */
export interface ScopeReapOutcome {
  /**
   * `marker+capture`: environment census plus the recorded descendants and
   * process groups (POSIX with the daemon index); `marker`: environment census
   * only; `tree_only`: no census on this host (Windows).
   */
  coverage: "marker+capture" | "marker" | "tree_only";
  census: "ok" | "failed" | "unsupported";
  censusFailure: string | null;
  /** Members found alive, signalled and proven gone. */
  ended: ScopeMemberRecord[];
  /** Members still alive (same identity) when the bounded ladder ended. */
  survivors: ScopeMemberRecord[];
  /** Known members whose identity or membership could not be read; never signalled unverified. */
  unreadable: ScopeUnreadableRecord[];
  /**
   * Recorded groups skipped entirely because the pgid-reuse rule failed (a
   * live leader has a different birth, a member predates the scope, or all
   * live members postdate settlement): disclosed residual, never signalled.
   */
  reusedGroups: number[];
  /** True only when every census source succeeded and nothing survived or stayed unreadable. */
  settled: boolean;
  /**
   * The single settlement deadline expired before discovery, confirmation,
   * probing and escalation finished: scanning and signalling stopped at that
   * moment (no late signal), and what is known is disclosed as incomplete —
   * never a verdict.
   */
  incomplete: boolean;
  /**
   * Whether a settled reap PROVES the scope empty. `complete` only on a host
   * whose census reads every same-uid process environment (Linux /proc) with
   * every source succeeding. `not_provable` on macOS even when settled: SIP
   * hides Apple platform-binary environments, so a system binary started in
   * the background by a shell that exited before any capture cannot be ruled
   * out (owner-accepted, disclosed residual); also whenever a census failed or
   * no census exists (Windows). `completenessReason` says which.
   */
  completeness: "complete" | "not_provable";
  completenessReason: string | null;
  /**
   * The platform hides some processes' environments from the marker census
   * (macOS: SIP withholds KERN_PROCARGS2 for Apple *platform* binaries such as
   * /bin/sleep, /usr/bin/find and /bin/bash). Those are reached through the
   * recorded groups/descendants instead; a platform binary born, setsid-ed and
   * orphaned within one capture tick is the disclosed residual.
   */
  restricted: boolean;
  durationMs: number;
}

export interface ScopeReapOptions {
  marker: string;
  census?: ScopeCensusReader | null;
  identity?: AsyncProcessIdentityReader;
  /**
   * The scope's recorded descendants (DIRECTIVE 1 sources b and c). Present —
   * even empty — means the daemon captured for this scope: coverage is
   * `marker+capture`. Absent: marker census only.
   */
  captured?: readonly CapturedProcess[];
  /** Birth floor of the scope (the harness root's `lstart` at first capture). */
  scopeStart?: string | null;
  /** Wall-clock floor (ISO) known from the moment the scope was opened; used
   * when no `lstart` floor exists yet (a root that exited within milliseconds). */
  scopeStartAt?: string | null;
  /** Prior settlement time (ISO); a group with only newer members has been reused. */
  settledAt?: string | null;
  /**
   * The harness roots' own process groups, recorded SYNCHRONOUSLY at spawn
   * from the registry handle: pgid plus the leader's measured identity, and
   * the leader's `lstart` once a table read confirmed it (null until then).
   */
  rootGroups?: ReadonlyArray<ScopeRootGroup>;
  table?: ProcessTableReader;
  /** Per-pid signal delivery (default `process.kill`). */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Cooperative grace before KILL (default 1000ms). */
  graceMs?: number;
  /** Overall bound (default graceMs + 4000). */
  deadlineMs?: number;
  /** Probe cadence (default 250ms). */
  probeIntervalMs?: number;
  /** The real-time deadline timer (injectable; default an unref'd setTimeout). */
  deadlineTimer?: (ms: number) => Promise<void>;
  /** Never signalled whatever the census says (default pid 1 and this process). */
  excludePids?: readonly number[];
  platform?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ScopeRootGroup {
  pgid: number;
  leaderPid: number;
  /** `lstart` text of the leader when a table read confirmed it; null if the root never got one. */
  leaderBirth: string | null;
  /** The leader's spawn-time measured identity (proc identity token). */
  leaderIdentity?: KnownProcessIdentity;
}

/** The epoch-seconds floor of a scope: the earlier of its `lstart` and wall-clock floors. */
export function scopeFloorSeconds(
  scopeStart: string | null | undefined,
  scopeStartAt: string | null | undefined,
): number | null {
  const fromBirth = scopeStart ? birthEpochSeconds(scopeStart) : null;
  const fromClock = scopeStartAt ? Math.floor(Date.parse(scopeStartAt) / 1000) : null;
  const floors = [fromBirth, fromClock].filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  return floors.length ? Math.min(...floors) : null;
}

/**
 * The candidates of the recorded sources against one fresh table snapshot:
 * every individually captured pid still alive with its recorded birth, plus
 * every live member of a recorded group G under the pgid-reuse rule — POSIX
 * does not reuse a pid as a group id while that group has members, so G is
 * still ours when every member was born at or after the scope, a live leader
 * matches its recorded birth, and on a re-reap at least one member was alive
 * at the prior settlement. Otherwise G was reused and is skipped. Pure.
 */
export function capturedCandidates(
  captured: readonly CapturedProcess[],
  rows: readonly ProcessTableRow[],
  scopeStart: string | null | undefined,
  options: {
    scopeStartAt?: string | null;
    settledAt?: string | null;
    rootGroups?: ReadonlyArray<ScopeRootGroup>;
    /** For a root group known only by its leader identity: whether a live
     * process with pid == G is still that leader (computed by the caller). */
    leaderVerdict?: ReadonlyMap<number, "same" | "different">;
  } = {},
): { candidates: Map<number, string>; reusedGroups: number[] } {
  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  const candidates = new Map<number, string>();
  const reusedGroups: number[] = [];
  for (const item of captured) {
    const row = byPid.get(item.pid);
    if (row && row.birth === item.birth) candidates.set(row.pid, row.birth);
  }
  const floor = scopeFloorSeconds(scopeStart, options.scopeStartAt);
  const settlement = scopeFloorSeconds(null, options.settledAt);
  const rootByPgid = new Map((options.rootGroups ?? []).map((g) => [g.pgid, g] as const));
  const groups = new Set([...captured.map((item) => item.pgid), ...rootByPgid.keys()]);
  for (const group of groups) {
    const members = rows.filter((row) => row.pgid === group);
    if (members.length === 0) continue; // emptied: simply gone
    const root = rootByPgid.get(group);
    const recordedLeaderBirth =
      captured.find((item) => item.pid === group)?.birth ?? root?.leaderBirth ?? undefined;
    const liveLeader = byPid.get(group);
    // A live leader must match its recorded birth or spawn-time identity.
    const leaderReused =
      liveLeader !== undefined &&
      (recordedLeaderBirth !== undefined
        ? liveLeader.birth !== recordedLeaderBirth
        : options.leaderVerdict?.get(group) !== "same");
    const births = members.map((row) => birthEpochSeconds(row.birth));
    const bornBefore = floor === null || births.some((at) => at === null || at < floor);
    const bornAfter = settlement !== null && births.every((at) => at !== null && at > settlement);
    if (leaderReused || bornBefore || bornAfter) {
      reusedGroups.push(group);
      continue;
    }
    for (const row of members) candidates.set(row.pid, row.birth);
  }
  return { candidates, reusedGroups };
}

type MemberBirth =
  { kind: "identity"; identity: KnownProcessIdentity } | { kind: "table"; birth: string };

interface LiveMember {
  pid: number;
  birth: MemberBirth;
  startToken: string;
  /** The hard signal was delivered under the recorded identity. */
  killed: boolean;
}

function unsupportedOutcome(durationMs: number): ScopeReapOutcome {
  return {
    coverage: "tree_only",
    census: "unsupported",
    censusFailure: null,
    ended: [],
    survivors: [],
    unreadable: [],
    reusedGroups: [],
    settled: false,
    incomplete: false,
    completeness: "not_provable",
    completenessReason: "no environment census exists on this platform",
    restricted: false,
    durationMs,
  };
}

export const DARWIN_COMPLETENESS_LIMIT =
  "macOS hides Apple platform-binary environments (SIP): a system binary started in the background by a shell that exited before any capture cannot be ruled out";

/** The completeness verdict of one reap (see `ScopeReapOutcome.completeness`). */
export function reapCompleteness(
  platform: string,
  censusFailure: string | null,
  incomplete = false,
  censusUnreadable = 0,
): Pick<ScopeReapOutcome, "completeness" | "completenessReason"> {
  if (censusFailure !== null)
    return { completeness: "not_provable", completenessReason: `census failed: ${censusFailure}` };
  if (incomplete)
    return {
      completeness: "not_provable",
      completenessReason: "settlement deadline expired before every source was read",
    };
  if (platform === "darwin")
    return { completeness: "not_provable", completenessReason: DARWIN_COMPLETENESS_LIMIT };
  if (censusUnreadable > 0)
    return {
      completeness: "not_provable",
      completenessReason: `${censusUnreadable} same-uid process environment(s) were unreadable (other uids cannot inherit our environment through ordinary spawn and are not counted; setuid binaries are a disclosed residual)`,
    };
  return { completeness: "complete", completenessReason: null };
}

/** Default grace between TERM and KILL (ms). */
export const SCOPE_REAP_GRACE_MS = 1_000;

/**
 * The ONE settlement deadline (ms) for a scope: every read, signal and wait of
 * a settlement — the daemon index's wait for in-flight seeds included — races
 * it, and expiry is disclosed as `incomplete`, never extended.
 */
export function scopeReapDeadlineMs(graceMs: number = SCOPE_REAP_GRACE_MS): number {
  return graceMs + 4_000;
}

async function reapOnce(opts: ScopeReapOptions): Promise<ScopeReapOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const platform = opts.platform ?? process.platform;
  const start = now();
  const census = opts.census === undefined ? createScopeCensusReader(platform) : opts.census;
  if (!census) return unsupportedOutcome(now() - start);
  const identity = opts.identity ?? defaultAsyncProcessIdentityReader;
  const captured = opts.captured;
  const table = opts.table ?? (captured || opts.rootGroups ? createProcessTableReader() : null);
  const deliver = opts.signal ?? ((pid, signal) => process.kill(pid, signal));
  const graceMs = opts.graceMs ?? SCOPE_REAP_GRACE_MS;
  const deadlineMs = opts.deadlineMs ?? scopeReapDeadlineMs(graceMs);
  const probeIntervalMs = Math.max(1, opts.probeIntervalMs ?? 250);
  const excluded = new Set(opts.excludePids ?? [1, process.pid]);
  const restricted = platform === "darwin";

  // ONE deadline for the whole settlement: every read (census, confirmation,
  // identity, table) races it, and once it expires nothing is scanned or
  // signalled any more — the outcome is disclosed as incomplete.
  let expired = false;
  const deadlineTimer =
    opts.deadlineTimer ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  const expiry = deadlineTimer(deadlineMs).then(() => {
    expired = true;
  });
  void expiry.catch(() => {});
  const pastDeadline = (): boolean => expired || now() - start >= deadlineMs;
  // Lazy: no read (on macOS a helper or `ps` process) STARTS past the deadline.
  const bounded = <T>(work: () => Promise<T>): Promise<T | typeof DEADLINE> =>
    pastDeadline()
      ? Promise.resolve<T | typeof DEADLINE>(DEADLINE)
      : Promise.race<T | typeof DEADLINE>([work(), expiry.then(() => DEADLINE)]);
  let censusUnreadable = 0;

  const live = new Map<number, LiveMember>();
  const ended: ScopeMemberRecord[] = [];
  const unreadable = new Map<number, string>();
  const reusedGroups = new Set<number>();
  const seen = new Set<number>();

  const signalMember = (member: LiveMember, signal: NodeJS.Signals): void => {
    if (pastDeadline()) return; // never a late signal after the deadline
    try {
      deliver(member.pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      live.delete(member.pid);
      if (code === "ESRCH") ended.push({ pid: member.pid, startToken: member.startToken });
      else unreadable.set(member.pid, `signal_failed:${code ?? "unknown"}`);
    }
  };

  /** Admit a censused pid: confirm membership + measure identity, then signal. */
  const admitMarker = async (pid: number, signal: NodeJS.Signals): Promise<void> => {
    if (excluded.has(pid) || seen.has(pid)) return;
    seen.add(pid);
    // Bracket the membership read with two identity reads: the marker is
    // accepted only for the ONE process that was alive under the same birth
    // before and after `confirm`, so a pid that was freed and reused between
    // the census and the signal can never enrol a stranger (item 7).
    const before = await bounded(() => identity.read(pid));
    if (before === DEADLINE || before.status === "missing") return;
    if (before.status === "unknown") {
      unreadable.set(pid, `identity_${before.reason}`);
      return;
    }
    const member = await bounded(() => census.confirm(pid, opts.marker));
    if (member === DEADLINE || member === false) return; // vanished (or reused): not ours any more
    if (member === null) {
      unreadable.set(pid, "membership_unreadable");
      return;
    }
    const observed = await bounded(() => identity.read(pid));
    if (observed === DEADLINE || observed.status === "missing") return; // gone between confirm and read
    if (observed.status === "unknown") {
      unreadable.set(pid, `identity_${observed.reason}`);
      return;
    }
    if (compareProcessBirth(before, observed) !== "same") return; // reused across the bracket
    const entry: LiveMember = {
      pid,
      birth: { kind: "identity", identity: observed },
      startToken: observed.startToken,
      killed: signal === "SIGKILL",
    };
    live.set(pid, entry);
    signalMember(entry, signal);
  };

  /** Admit a recorded candidate: re-measure its birth right before the signal. */
  const admitCaptured = async (
    pid: number,
    expectedBirth: string,
    signal: NodeJS.Signals,
  ): Promise<void> => {
    if (!table || excluded.has(pid) || seen.has(pid) || pastDeadline()) return;
    seen.add(pid);
    const row = await bounded(() => table.row(pid));
    if (row === DEADLINE || row === null) return; // gone (or out of time)
    if (row === "unreadable") {
      unreadable.set(pid, "birth_unreadable");
      return;
    }
    if (row.birth !== expectedBirth) return; // the pid was reused since the snapshot
    const entry: LiveMember = {
      pid,
      birth: { kind: "table", birth: row.birth },
      startToken: `ps:${row.birth}`,
      killed: signal === "SIGKILL",
    };
    live.set(pid, entry);
    signalMember(entry, signal);
  };

  const scanMarker = async (signal: NodeJS.Signals): Promise<string | null> => {
    const ageSeconds = scopeAgeSeconds(opts.scopeStartAt);
    const result = await bounded(() => census.census([opts.marker], ageSeconds, pastDeadline));
    if (result === DEADLINE || pastDeadline()) return null; // incomplete, never a failed census
    if (result.status !== "ok") return result.reason;
    censusUnreadable = Math.max(censusUnreadable, result.unreadable);
    const pids = result.members.get(opts.marker) ?? [];
    await mapBounded(pids, LINUX_CONCURRENCY, (pid) => admitMarker(pid, signal));
    return null;
  };

  const scanCaptured = async (signal: NodeJS.Signals): Promise<string | null> => {
    if ((!captured && !opts.rootGroups) || !table || pastDeadline()) return null;
    const rows = await bounded(() => table.snapshot());
    if (rows === DEADLINE) return null;
    if (rows === null) return "process table unreadable";
    // A root group known only by its leader's identity (no lstart yet): if a
    // live process owns pid == G, measure it against the spawn-time identity.
    const leaderVerdict = new Map<number, "same" | "different">();
    for (const root of opts.rootGroups ?? []) {
      if (root.leaderBirth !== null || !root.leaderIdentity) continue;
      if (!rows.some((row) => row.pid === root.pgid)) continue;
      const observed = await bounded(() => identity.read(root.pgid));
      if (observed === DEADLINE) return null;
      leaderVerdict.set(
        root.pgid,
        compareProcessIdentity(root.leaderIdentity, observed) === "same" ? "same" : "different",
      );
    }
    const found = capturedCandidates(captured ?? [], rows, opts.scopeStart, {
      scopeStartAt: opts.scopeStartAt,
      settledAt: opts.settledAt,
      rootGroups: opts.rootGroups,
      leaderVerdict,
    });
    for (const group of found.reusedGroups) reusedGroups.add(group);
    await mapBounded([...found.candidates], LINUX_CONCURRENCY, ([pid, birth]) =>
      admitCaptured(pid, birth, signal),
    );
    return null;
  };

  const scan = async (signal: NodeJS.Signals): Promise<string | null> => {
    const markerFailure = await scanMarker(signal);
    const capturedFailure = await scanCaptured(signal);
    return markerFailure ?? capturedFailure;
  };

  /** Is the member still the process we signalled? Its birth decides, not its current group. */
  const stillSame = async (member: LiveMember): Promise<"same" | "gone" | "unreadable"> => {
    if (member.birth.kind === "identity") {
      const observed = await bounded(() => identity.read(member.pid));
      if (observed === DEADLINE) return "same"; // out of time: still a survivor, never a false "gone"
      const comparison = compareProcessBirth(member.birth.identity, observed);
      if (comparison === "same") return "same";
      if (comparison === "unknown") return "unreadable";
      return "gone"; // missing, or a different process now owns the pid
    }
    if (!table) return "unreadable";
    const row = await bounded(() => table.row(member.pid));
    if (row === DEADLINE) return "same";
    if (row === null) return "gone";
    if (row === "unreadable") return "unreadable";
    return row.birth === member.birth.birth ? "same" : "gone";
  };

  const probe = async (): Promise<void> => {
    await mapBounded([...live.values()], LINUX_CONCURRENCY, async (member) => {
      const state = await stillSame(member);
      if (state === "same") return;
      live.delete(member.pid);
      if (state === "unreadable") unreadable.set(member.pid, "identity_unreadable");
      else ended.push({ pid: member.pid, startToken: member.startToken });
    });
  };

  const outcome = (censusFailure: string | null): ScopeReapOutcome => ({
    coverage: captured || opts.rootGroups ? "marker+capture" : "marker",
    census: censusFailure === null ? "ok" : "failed",
    censusFailure,
    ended,
    survivors: [...live.values()].map((m) => ({ pid: m.pid, startToken: m.startToken })),
    unreadable: [...unreadable].map(([pid, reason]) => ({ pid, reason })),
    reusedGroups: [...reusedGroups],
    settled: censusFailure === null && !pastDeadline() && live.size === 0 && unreadable.size === 0,
    incomplete: pastDeadline(),
    ...reapCompleteness(platform, censusFailure, pastDeadline(), censusUnreadable),
    restricted,
    durationMs: now() - start,
  });

  let censusFailure = await scan("SIGTERM");
  if (live.size === 0) {
    // Members that were already gone at the first signal (ESRCH) count as
    // ended; a fork after that snapshot would be missed without one more look.
    if (ended.length > 0 && !pastDeadline()) censusFailure ??= await scan("SIGTERM");
    if (live.size === 0) return outcome(censusFailure);
  }

  let escalated = false;
  let rescans = 0;
  for (;;) {
    if (pastDeadline()) return outcome(censusFailure);
    await sleep(probeIntervalMs);
    if (pastDeadline()) return outcome(censusFailure); // members stay survivors; no probe starts
    await probe();
    if (pastDeadline()) return outcome(censusFailure);
    const elapsed = now() - start;
    if (elapsed >= graceMs && !escalated) {
      escalated = true;
      // One bounded rescan for forks before the hard signal; late arrivals get KILL.
      rescans += 1;
      censusFailure ??= await scan("SIGKILL");
      for (const member of live.values()) {
        if (member.killed) continue;
        if ((await stillSame(member)) !== "same") continue;
        member.killed = true;
        signalMember(member, "SIGKILL");
      }
    }
    if (live.size === 0) {
      if (rescans < 2) {
        rescans += 1;
        censusFailure ??= await scan(escalated ? "SIGKILL" : "SIGTERM");
        if (live.size === 0) return outcome(censusFailure);
      } else return outcome(censusFailure);
    }
    if (pastDeadline()) return outcome(censusFailure);
  }
}

/**
 * Scope reaper with per-marker coalescing: a second request for a marker
 * whose reap is in flight shares that promise instead of starting a second
 * ladder (different markers keep separate authority and deadlines).
 */
export class ScopeReaper {
  private readonly inflight = new Map<string, Promise<ScopeReapOutcome>>();

  reap(opts: ScopeReapOptions): Promise<ScopeReapOutcome> {
    if (!isScopeMarkerName(opts.marker)) {
      return Promise.reject(new Error("scope marker name does not match the grammar"));
    }
    const pending = this.inflight.get(opts.marker);
    if (pending) return pending;
    const job = reapOnce(opts).finally(() => {
      if (this.inflight.get(opts.marker) === job) this.inflight.delete(opts.marker);
    });
    this.inflight.set(opts.marker, job);
    return job;
  }
}

export const defaultScopeReaper = new ScopeReaper();

/** End every live process of the scope (see the module doc). */
export function reapScopeMembers(opts: ScopeReapOptions): Promise<ScopeReapOutcome> {
  return defaultScopeReaper.reap(opts);
}
