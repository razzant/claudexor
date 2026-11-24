/**
 * The run-deadline/1 fault harness (`run-deadline-faults*.test.ts`): numbered
 * record operations with planned failures, deaths and concurrent events
 * (`Ops`), the renewal scenario (`runSet`) and plans grown from dry runs
 * (`growPlans`). The invariant checks and the matrix are in
 * `run-deadline-fault-checks.ts`; the invariants are stated in
 * `run-deadline-faults.test.ts`.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { RunDeadlineSnapshot } from "@claudexor/schema";
import type { RunDeadlineClock } from "../run-deadline-clock.js";
import {
  claimPath,
  diskReader,
  fileRecordIo,
  governingBound,
  readRecord,
  type DeadlineRecord,
  type RecordIo,
} from "../run-deadline-record.js";
import { RunDeadlines, type RunDeadlinesOptions } from "../run-deadlines.js";

const dirs: string[] = [];
/** Remove every directory `temp` made (each test file's afterAll). */
export function removeTemps(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
export const temp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "d-rdf-")));
  dirs.push(dir);
  return dir;
};

export const SEC = 1_000_000_000n;
export const HEAD_MS = 1_000;
export const HEAD = BigInt(HEAD_MS) * 1_000_000n;
export const MARKER = `CLAUDEXOR_RUN_SCOPE_${"c".repeat(32)}`;

/** A frozen clock the plan moves: host and wall together. */
export function frozenClock() {
  let host = 1_000n * SEC;
  let wall = Date.parse("2026-11-22T12:00:00.000Z");
  const clock: RunDeadlineClock = {
    kind: "boottime",
    bootId: () => "boot-fault",
    hostNow: () => host,
    wallNow: () => wall,
  };
  return {
    clock,
    advance(ms: number) {
      host += BigInt(ms) * 1_000_000n;
      wall += ms;
    },
    host: () => host,
    iso: (ms: number) => new Date(wall + ms).toISOString(),
  };
}
export type Clock = ReturnType<typeof frozenClock>;

export class ProcessDied extends Error {
  readonly code = "EPROCESSDIED";
}

export type Hook =
  "requested" | "deadline" | "head-start" | "warden" | "terminal" | "child-terminal";
export type Kind = Hook | "throw" | "crash";
export interface Planned {
  at: number;
  kind: Kind;
}
export const label = (plan: Planned[]) =>
  plan.length ? plan.map((e) => `${e.kind}@${e.at}`).join(" + ") : "no event";

/** One visible change: what the warden enforced around it. */
export interface Change {
  op: number;
  name: "publish" | "remove" | "claim";
  path: string;
  host: bigint;
  before: bigint | null;
  after: bigint | null;
  record: DeadlineRecord | null;
  claimed: boolean;
  terminal: boolean;
}

/** What the warden enforces for a record file now (its own function over the disk). */
export function wardenBound(dir: string, file: string) {
  const record = readRecord(join(dir, file));
  if (!record || record === "unreadable") return null;
  return governingBound(record, diskReader(dir));
}

/**
 * Numbers every record operation while `counting`; applies the plan's events
 * to them and observes every visible change of the watched record.
 */
export class Ops {
  counting = false;
  dead = false;
  readonly names: string[] = [""];
  readonly hostAfter: bigint[] = [];
  readonly fired: Planned[] = [];
  readonly changes: Change[] = [];

  constructor(
    private readonly plan: Planned[],
    private readonly apply: (kind: Kind) => void = () => {},
    private readonly now: () => bigint = () => 0n,
    private readonly watch: { dir: string; file: string; terminal: () => boolean } | null = null,
  ) {}

  get count() {
    return this.names.length - 1;
  }

  private enter(name: string): Planned[] {
    if (this.dead) throw new ProcessDied(`${name} after the process died`);
    if (!this.counting) return [];
    this.names.push(name);
    const events = this.plan.filter((e) => e.at === this.count);
    const fault = events.find((e) => e.kind === "throw" || e.kind === "crash");
    if (fault) {
      this.fired.push(fault);
      if (fault.kind === "crash") {
        this.dead = true;
        throw new ProcessDied(`the process died at ${name}`);
      }
      throw Object.assign(new Error(`injected ${name} failure`), { code: "EIO" });
    }
    return events;
  }

  /**
   * After an operation: its events. The daemon's own code (a terminal) cannot
   * run inside a synchronous operation, so after one it runs at the next turn
   * of the event loop; the clock and the warden (another process) can move at
   * any instant.
   */
  private leave(events: Planned[], sync = false) {
    for (const event of events) {
      this.fired.push(event);
      if (sync && (event.kind === "terminal" || event.kind === "child-terminal"))
        queueMicrotask(() => this.apply(event.kind));
      else this.apply(event.kind);
    }
    if (this.counting) this.hostAfter[this.count] = this.now();
  }

  /** Observe a visible change of the watched record's files. */
  private observed<T>(name: Change["name"], path: string, work: () => T): T {
    if (!this.watch || !this.counting || !path.startsWith(join(this.watch.dir, this.watch.file)))
      return work();
    const { dir, file } = this.watch;
    const before = wardenBound(dir, file)?.target ?? null;
    const claimed = existsSync(claimPath(join(dir, file)));
    const terminal = this.watch.terminal();
    const host = this.now();
    const result = work();
    const finish = () => {
      const record = readRecord(join(dir, file));
      this.changes.push({
        op: this.count,
        name,
        path,
        host,
        before,
        after: wardenBound(dir, file)?.target ?? null,
        record: record && record !== "unreadable" ? record : null,
        claimed,
        terminal,
      });
    };
    if (result instanceof Promise) return result.then((value) => (finish(), value)) as T;
    finish();
    return result;
  }

  io(): RecordIo {
    return {
      stage: async (path, record) => {
        const events = this.enter("stage");
        const tmp = await fileRecordIo.stage(path, record);
        this.leave(events);
        return tmp;
      },
      publish: async (tmp, path) => {
        const events = this.enter("publish");
        await this.observed("publish", path, () => fileRecordIo.publish(tmp, path));
        this.leave(events);
      },
      flush: async (dir) => {
        const events = this.enter("flush");
        await fileRecordIo.flush(dir);
        this.leave(events);
      },
      discard: async (tmp) => {
        const events = this.enter("discard");
        await fileRecordIo.discard(tmp);
        this.leave(events);
      },
      claim: (path, claim) => {
        const events = this.enter("claim");
        const made = this.observed("claim", path, () => fileRecordIo.claim(path, claim));
        this.leave(events, true);
        return made;
      },
      remove: (path) => {
        const events = this.enter("remove");
        this.observed("remove", path, () => fileRecordIo.remove(path));
        this.leave(events, true);
      },
    };
  }

  /** Every planned event fired (positions come from dry runs of the same plan). */
  assertFired() {
    const key = (e: Planned) => `${e.kind}@${e.at}`;
    expect(this.fired.map(key).sort(), "every planned event fired").toEqual(
      this.plan.map(key).sort(),
    );
  }
}

export const registry = (
  dir: string,
  time: Clock,
  io: RecordIo = fileRecordIo,
  extra: Partial<RunDeadlinesOptions> = {},
) =>
  new RunDeadlines({
    dir,
    clock: time.clock,
    io,
    headStartMs: HEAD_MS,
    spawnWarden: async () => ({ pid: 1 }),
    platform: "linux",
    onFault: () => {},
    ...extra,
  });

export async function hold(
  deadlines: RunDeadlines,
  jobId: string,
  at: string | null,
  parentJobId: string | null = null,
) {
  await deadlines.stage(jobId, {
    own: at ? deadlines.toPoint(at) : null,
    successorOf: null,
    parentJobId,
  });
  deadlines.admit(jobId);
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; code: string };
export const outcome = <T>(work: Promise<T>): Promise<Outcome<T>> =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error: { code?: string }) => ({ ok: false as const, code: error.code ?? String(error) }),
  );

/** Run `work` with the event loop's timers faked: no registry timer fires behind the plan. */
export async function withFakeTimers<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    return await work();
  } finally {
    vi.useRealTimers();
  }
}

/** A new generation over a directory: reconcile it with the jobs' states. */
export async function generation(
  dir: string,
  time: Clock,
  states: Record<string, string>,
  io: RecordIo = fileRecordIo,
) {
  const next = registry(dir, time, io);
  await next.reconcile(
    (ids) => new Map(ids.filter((id) => states[id]).map((id) => [id, states[id]!])),
  );
  return next;
}

export interface TerminalFacts {
  at: bigint;
  claim: boolean;
  expiredBefore: boolean;
}

export interface SetRun {
  plan: Planned[];
  ops: Ops;
  answer: Outcome<RunDeadlineSnapshot>;
  live: RunDeadlineSnapshot | null;
  T0: bigint;
  t0At: string;
  R: bigint;
  rAt: string;
  terminal: TerminalFacts | null;
  dir: string;
  time: Clock;
}

/** One change of the deadline (now+10 s → now+`target` ms) under a plan. */
export function runSet(plan: Planned[], target = 60_000): Promise<SetRun> {
  return withFakeTimers(async () => {
    const dir = temp();
    const time = frozenClock();
    const path = join(dir, "job.json");
    let deadlines!: RunDeadlines;
    let T0 = 0n;
    let R = 0n;
    let t0At = "";
    let expireCalls = 0;
    let terminal: TerminalFacts | null = null;
    const apply = (kind: Kind) => {
      // Just past the requested deadline (a shortening's), before the replaced one.
      if (kind === "requested" && time.host() <= R)
        time.advance(Number((R - time.host()) / 1_000_000n) + 500);
      if (kind === "deadline") time.advance(10_500); // past the replaced deadline, inside the head start
      if (kind === "head-start" || kind === "warden") time.advance(12_000); // past the head start too
      if (kind === "warden" && !existsSync(claimPath(path)))
        // The warden read the clock, then the replaced revision, and claims it.
        writeFileSync(
          claimPath(path),
          JSON.stringify({ revision: 0, at: t0At, targetNs: T0.toString(), by: "warden" }),
        );
      if (kind === "terminal") {
        terminal = {
          at: time.host(),
          claim: existsSync(claimPath(path)),
          expiredBefore: expireCalls > 0,
        };
        deadlines.close("job");
      }
    };
    const ops = new Ops(plan, apply, time.host, {
      dir,
      file: "job.json",
      terminal: () => terminal !== null,
    });
    deadlines = registry(dir, time, ops.io(), { onExpire: () => void (expireCalls += 1) });
    await hold(deadlines, "job", time.iso(10_000));
    const t0 = wardenBound(dir, "job.json")!;
    T0 = t0.target;
    t0At = t0.at;
    const rAt = time.iso(target);
    R = T0 + BigInt(target - 10_000) * 1_000_000n;
    ops.counting = true;
    const answer = await outcome(
      deadlines.set("job", { at: rAt, expectedRevision: 0 }, { delegated: false }),
    );
    let live: RunDeadlineSnapshot | null = null;
    if (!ops.dead) {
      await deadlines.dispose(); // every chain settled: the terminal's write, a stop
      live = deadlines.peek("job");
    }
    ops.counting = false;
    return {
      plan,
      ops,
      answer,
      live,
      T0,
      t0At,
      R,
      rAt,
      terminal,
      dir,
      time,
    };
  });
}

/** Plans grown from dry runs: every event exists in the run of the plan before it. */
export async function growPlans(
  dry: (plan: Planned[]) => Promise<{ ops: Ops }>,
  kinds: Kind[],
  depth: number,
  first: Kind[] = kinds,
): Promise<Planned[][]> {
  const plans: Planned[][] = [];
  const grow = async (prefix: Planned[], left: number) => {
    const total = (await dry(prefix)).ops.count;
    const after = prefix.length ? prefix[prefix.length - 1]!.at : 0;
    for (let at = after + 1; at <= total; at++)
      for (const kind of prefix.length ? kinds : first) {
        if (kind !== "throw" && prefix.some((e) => e.kind === kind)) continue;
        const plan = [...prefix, { at, kind }];
        plans.push(plan);
        if (left > 1 && kind !== "crash") await grow(plan, left - 1);
      }
  };
  await grow([], depth);
  return plans;
}
