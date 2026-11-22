/**
 * The run-deadline warden (run-deadline/1, invariant 4): one small detached
 * process per deadline-bearing run that ends the run at its deadline whether or
 * not the daemon is alive.
 *
 * Why a separate process: a daemon that is SIGKILLed or hangs cannot end
 * anything, and harness children live in their own process groups and sessions
 * by design, so they outlive it. Cleanup at the NEXT daemon start is not
 * enforcement. The warden starts before the run's first process (the thread
 * worktree preparation included), in its own session, without any run marker,
 * and only reads files: the run's durable record (`run-deadline-record.ts`),
 * the records of the Delegate ancestors whose current deadline caps it, and
 * the run-scope index (`daemon/run-scopes.json`). Its one write that matters
 * is the enforcement claim it makes before its first stop of a live run.
 *
 * Time: it reads the host clock (`run-deadline-clock.ts`, CLOCK_BOOTTIME on
 * Linux) BEFORE the record, and acts once the clock passed the governing
 * deadline plus the daemon's head start; the record module explains why a
 * set the daemon confirmed can then never be overtaken.
 *
 * What it ends at the deadline, by measured identity only:
 * - the run's cgroup, whole, through `cgroup.kill` when the daemon proved a
 *   delegated cgroup v2 boundary (`run-deadline-cgroup.ts`);
 * - every process carrying one of the run's scope markers (preparation and run);
 * - the process groups and descendants the daemon recorded for those markers in
 *   the run-scope index while the run was live.
 *
 * When it leaves (its report, `<record>.outcome.json`, is what answers show):
 * - cgroup boundary: once `cgroup.events` reports the cgroup unpopulated and
 *   every marker reap settled (confirmed);
 * - marker boundary on Linux: once a marker census is complete and settled
 *   (confirmed); a census that cannot prove emptiness, or a member that would
 *   not die, is retried with backoff and ends as `unresolved`, with its reason,
 *   only after `UNRESOLVED_AFTER_MS` of enforcement;
 * - where no census can prove emptiness (macOS: not declared): after three
 *   settled passes, as `unresolved`;
 * - at once when its record is removed.
 * After the run's terminal (record `closed` or `expired`) it probes without
 * signals and leaves as soon as the boundary is confirmed empty; otherwise it
 * stays to the deadline that still governs the survivors and enforces it. On
 * the marker boundary on Linux, after a normal terminal (`closed`), it also
 * leaves once a non-signalling pass found the run's recorded process groups
 * and captured descendants empty and no readable environment carrying its
 * marker, even when a same-user process whose environment cannot be read (a
 * non-dumpable agent) keeps the census from proving completeness; it reports
 * that as `unresolved`, naming the residual (a marked process that is both
 * unreadable and outside the recorded tree).
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readRunScopeEntries,
  reapScopeMembers,
  reapSources,
  withoutRunScopeMarkers,
  type ScopeReapOptions,
  type ScopeReapOutcome,
} from "@claudexor/core";
import { clockOfKind, hostClock, type HostClockKind } from "./run-deadline-clock.js";
import { cgroupPopulated, killCgroup, removeRunCgroup } from "./run-deadline-cgroup.js";
import {
  claimEnforcement,
  diskReader,
  governingBound,
  readRecord,
  wardenDonePath,
  wardenOutcomePath,
  wardenReadyPath,
  writeJsonAtomic,
  type DeadlineRecord,
  type WardenOutcome,
} from "./run-deadline-record.js";

/** The daemon's own timer gets this head start before the warden acts, so a
 * live daemon ends the run through the ordinary cancel path first. */
export const WARDEN_HEAD_START_MS = 1_000;
/** Warden poll cadence of its record. */
export const WARDEN_POLL_MS = 200;
/**
 * The declared stop grace: head start (1 s) + one poll (0.2 s) + the first
 * enforcement pass (cgroup.kill at once; a bounded marker reap of at most 5 s),
 * with later passes as margin, inside the contract's 30 s ceiling.
 */
export const RUN_DEADLINE_STOP_GRACE_SEC = 15;
/** Passes that found nothing before a warden without a provable census leaves. */
const UNPROVABLE_SETTLED_PASSES = 3;
/** Enforcement without a confirmed empty boundary ends as `unresolved` after this (Linux). */
export const UNRESOLVED_AFTER_MS = 120_000;

/** The engine's alternate entry role that runs a warden inside the engine bundle. */
export const WARDEN_ENTRY_ROLE = "--run-deadline-warden";
/** The small dedicated warden bundle shipped beside the engine bundle. */
export const WARDEN_BUNDLE = "run-deadline-warden.cjs";
const ENGINE_BUNDLE = "claudexord.bundle.cjs";
const WARDEN_READY_TIMEOUT_MS = 10_000;

/**
 * argv of the warden for this build. An installed package runs the sibling
 * entry (TS under tsx in a source checkout); the engine bundle runs the small
 * `run-deadline-warden.cjs` beside it, or itself in its warden role when that
 * file is absent. Anything else has no warden: the run is refused.
 */
export function wardenCommand(
  moduleUrl: string = import.meta.url,
  exists: (path: string) => boolean = existsSync,
): { command: string; args: string[]; cwd: string } {
  const self = fileURLToPath(moduleUrl);
  const unbundled = /run-deadline-warden\.(ts|js)$/.exec(self);
  if (unbundled) {
    const entry = self.replace(/run-deadline-warden\.(ts|js)$/, `run-deadline-warden-main.$1`);
    return {
      command: process.execPath,
      args: unbundled[1] === "ts" ? ["--import", "tsx", entry] : [entry],
      cwd: dirname(entry),
    };
  }
  if (basename(self) === ENGINE_BUNDLE) {
    const small = join(dirname(self), WARDEN_BUNDLE);
    return exists(small)
      ? { command: process.execPath, args: [small], cwd: dirname(self) }
      : { command: process.execPath, args: [self, WARDEN_ENTRY_ROLE], cwd: dirname(self) };
  }
  throw Object.assign(new Error(`no run-deadline warden entry for ${basename(self)}`), {
    code: "run_deadline_warden_unavailable",
    status: 503,
    retryable: false,
  });
}

/**
 * Start the warden for `recordPath` and resolve once it reported itself running
 * (its ready file), so an exited or foreign entry never passes for enforcement.
 * Detached: its own session and process group, outside every run cgroup, so
 * neither a signal to the daemon's group, the daemon's death nor the run's own
 * cgroup.kill reaches it. Its environment drops every Claudexor run marker, so
 * it is never a member of the scope it ends. One completion listener (exit or
 * error) is registered at once, so an asynchronous spawn error refuses typed.
 */
export async function spawnWarden(recordPath: string): Promise<{ pid: number }> {
  const { command, args, cwd } = wardenCommand();
  rmSync(wardenReadyPath(recordPath), { force: true });
  const unavailable = (message: string) =>
    Object.assign(new Error(message), {
      code: "run_deadline_warden_unavailable",
      status: 503,
      retryable: true,
    });
  // A warden must stay outside the run's boundary: it is spawned here, by the
  // daemon, deliberately not through the run-owned spawn point.
  const child = spawn(command, [...args, recordPath], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: withoutRunScopeMarkers({ ...process.env }) as NodeJS.ProcessEnv,
  });
  let ended: string | null = null;
  child.once("exit", () => (ended ??= "the run-deadline warden exited before it was ready"));
  child.once(
    "error",
    (error) => (ended ??= `the run-deadline warden did not start: ${error.message}`),
  );
  const end = Date.now() + WARDEN_READY_TIMEOUT_MS;
  while (!existsSync(wardenReadyPath(recordPath))) {
    if (ended || Date.now() > end) {
      if (!ended && child.pid !== undefined) child.kill("SIGKILL");
      throw unavailable(ended ?? "the run-deadline warden did not start");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.unref();
  return { pid: child.pid! };
}

export interface WardenLoopDeps {
  now?: (kind: HostClockKind) => bigint;
  sleep?: (ms: number) => Promise<void>;
  reap?: (opts: ScopeReapOptions) => Promise<ScopeReapOutcome>;
  pollMs?: number;
  headStartMs?: number;
  unresolvedAfterMs?: number;
  platform?: NodeJS.Platform;
  cgroup?: {
    /** false: proven unpopulated (or gone); true: populated; null: unreadable. */
    populated(dir: string): Promise<boolean | null>;
    kill(dir: string): Promise<boolean>;
    remove(dir: string): Promise<void>;
  };
}

/** A non-signalling reap: any member it would signal makes the group "not empty". */
const PROBE = Object.assign(new Error("probe"), { code: "EPROBE" });

interface Pass {
  settled: boolean;
  confirmed: boolean;
  outcomes: ScopeReapOutcome[];
  cgroupPopulated: boolean | null;
  /** Why it is not confirmed, when that is known better than the census says. */
  detail?: string;
}

const TERMINAL_RELEASE_DETAIL =
  "left after the run's normal terminal: its recorded process groups and descendants are gone and no readable environment carries its marker; a marked process whose environment is unreadable and that left the recorded tree is not ruled out";

/**
 * After a normal terminal on the marker boundary (Linux): every census source
 * ran, nothing was found or left unidentified, and the run's recorded groups
 * and descendants were part of it. Completeness may still be unprovable
 * because of unrelated unreadable same-user processes.
 */
function releasableAfterTerminal(
  record: DeadlineRecord,
  probe: Pass,
  platform: NodeJS.Platform,
): boolean {
  return (
    platform === "linux" &&
    record.cgroup === null &&
    record.runScopes !== null &&
    probe.settled &&
    probe.outcomes.length > 0 &&
    probe.outcomes.every(
      (o) => o.census === "ok" && !o.incomplete && o.coverage === "marker+capture",
    )
  );
}

const terminal = (record: DeadlineRecord) =>
  record.state === "closed" || record.state === "expired";

/**
 * The warden's whole life (see the module doc). Returns why it left.
 */
export async function runWarden(
  recordPath: string,
  deps: WardenLoopDeps = {},
): Promise<WardenOutcome["reason"]> {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? ((kind: HostClockKind) => clockOfKind(kind)());
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const reap = deps.reap ?? reapScopeMembers;
  const cgroups = deps.cgroup ?? {
    populated: cgroupPopulated,
    kill: killCgroup,
    remove: removeRunCgroup,
  };
  const headStartNs = BigInt(Math.round((deps.headStartMs ?? WARDEN_HEAD_START_MS) * 1e6));
  const unresolvedAfterNs = BigInt(
    Math.round((deps.unresolvedAfterMs ?? UNRESOLVED_AFTER_MS) * 1e6),
  );
  const dir = dirname(recordPath);
  const read = diskReader(dir);
  const finish = (reason: WardenOutcome["reason"], pass?: Pass): WardenOutcome["reason"] => {
    const outcomes = pass?.outcomes ?? [];
    const survivors = outcomes.reduce((sum, o) => sum + o.survivors.length, 0);
    try {
      if (pass)
        writeJsonAtomic(wardenOutcomePath(recordPath), {
          reason,
          at: new Date().toISOString(),
          confirmed: pass.confirmed,
          detail: pass.confirmed ? null : (pass.detail ?? unresolvedDetail(pass, survivors)),
          ended: outcomes.reduce((sum, o) => sum + o.ended.length, 0),
          survivors,
        } satisfies WardenOutcome);
      if (existsSync(dir))
        writeJsonAtomic(wardenDonePath(recordPath), { reason, pid: process.pid });
    } catch {
      /* evidence only: the stop already happened */
    }
    return reason;
  };
  try {
    writeJsonAtomic(wardenReadyPath(recordPath), { pid: process.pid });
  } catch {
    return "removed"; // no directory any more: nothing to guard
  }

  const sources = (record: DeadlineRecord, marker: string): Partial<ScopeReapOptions> => {
    const entry = record.runScopes
      ? readRunScopeEntries(record.runScopes)?.find((row) => row.marker === marker)
      : undefined;
    if (!entry) return {};
    const recorded = reapSources(entry);
    // The census age filter is measured on the wall clock (macOS only); never
    // let a clock step hide a member there.
    return platform === "linux" ? recorded : { ...recorded, scopeStartAt: null };
  };
  /** One pass over every boundary source; `probe` signals nothing. */
  const pass = async (record: DeadlineRecord, probe: boolean): Promise<Pass> => {
    const outcomes: ScopeReapOutcome[] = [];
    let populated: boolean | null = false;
    if (record.cgroup) {
      if (!probe) await cgroups.kill(record.cgroup);
      populated = await cgroups.populated(record.cgroup);
    }
    for (const marker of record.markers) {
      outcomes.push(
        await reap({
          scopeStartAt: null,
          ...sources(record, marker),
          marker,
          ...(probe
            ? {
                signal: () => {
                  throw PROBE;
                },
              }
            : {}),
        }),
      );
    }
    if (record.cgroup && !probe && populated !== false)
      populated = await cgroups.populated(record.cgroup);
    const settled = populated === false && outcomes.every((o) => o.settled);
    // With a cgroup the boundary itself is proven empty (hierarchically, from
    // cgroup.events); without one only a complete census proves that no
    // marked process is left.
    const confirmed =
      settled && (record.cgroup !== null || outcomes.every((o) => o.completeness === "complete"));
    return { settled, confirmed, outcomes, cgroupPopulated: populated };
  };

  // Waiting: the clock is read BEFORE the record (see the record module).
  let last: DeadlineRecord | null = null;
  let probeAt = 0n;
  let probeBackoffMs = 1_000;
  for (;;) {
    const clockNow = now(last?.clock ?? hostClock(platform).kind);
    const current = readRecord(recordPath);
    if (current === null) return finish("removed");
    if (current !== "unreadable") {
      last = current;
      const bound = governingBound(current, read);
      if (bound !== null && clockNow >= bound.target + headStartNs) break;
      if (terminal(current) && clockNow >= probeAt) {
        const probe = await pass(current, true);
        if (probe.confirmed) {
          if (current.cgroup) await cgroups.remove(current.cgroup);
          return finish("released", probe);
        }
        if (current.state === "closed" && releasableAfterTerminal(current, probe, platform))
          return finish("released", {
            ...probe,
            detail: TERMINAL_RELEASE_DETAIL,
          });
        probeAt = now(current.clock) + BigInt(probeBackoffMs) * 1_000_000n;
        probeBackoffMs = Math.min(probeBackoffMs * 2, 30_000);
      }
    }
    await sleep(deps.pollMs ?? WARDEN_POLL_MS);
  }

  // The deadline won: claim it (with the deadline it judged) before the first
  // stop of a live run.
  if (!terminal(last)) {
    const bound = governingBound(last, read);
    try {
      if (bound)
        claimEnforcement(recordPath, {
          revision: last.revision,
          at: bound.at,
          targetNs: bound.target.toString(),
          by: "warden",
        });
    } catch {
      /* the stop matters more than its record; the daemon's clock reaches the same verdict */
    }
  }

  // Enforcement: repeat until the boundary is confirmed empty, the record is
  // removed, or (see the module doc) the warden reports it unresolved.
  const enforcingSince = now(last.clock);
  let settledPasses = 0;
  let backoffMs = 500;
  for (;;) {
    const current = readRecord(recordPath);
    if (current === null) return finish("removed");
    if (current !== "unreadable") last = current;
    const result = await pass(last, false);
    if (result.confirmed) {
      if (last.cgroup) await cgroups.remove(last.cgroup);
      return finish("reaped", result);
    }
    if (platform !== "linux") {
      settledPasses = result.settled ? settledPasses + 1 : 0;
      if (settledPasses >= UNPROVABLE_SETTLED_PASSES) return finish("unresolved", result);
    } else if (now(last.clock) - enforcingSince >= unresolvedAfterNs) {
      return finish("unresolved", result);
    }
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 10_000);
  }
}

/** Why a pass could not confirm the boundary empty. */
function unresolvedDetail(pass: Pass, survivors: number): string {
  const reasons: string[] = [];
  if (pass.cgroupPopulated === true) reasons.push("the run's cgroup is still populated");
  if (pass.cgroupPopulated === null) reasons.push("the run's cgroup could not be read");
  if (survivors > 0) reasons.push(`${survivors} member(s) survived every signal`);
  for (const outcome of pass.outcomes) {
    if (outcome.unreadable.length > 0)
      reasons.push(`${outcome.unreadable.length} known member(s) could not be identified`);
    if (outcome.completeness !== "complete" && outcome.completenessReason)
      reasons.push(outcome.completenessReason);
  }
  return [...new Set(reasons)].join("; ") || "membership could not be established";
}
