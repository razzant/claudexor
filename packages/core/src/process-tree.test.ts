import { describe, expect, it } from "vitest";
import {
  descendantProcessGroupIds,
  readProcessTable,
  reapProcessTree,
  type ProcessTreeNode,
  type ProcessTreeReader,
} from "./process-tree.js";
import { ProcessGroupService } from "./process-group.js";
import type { ProcessIdentity, ProcessIdentityReader } from "./process-identity.js";

/**
 * Deterministic fake kernel: a set of live pgids (each led by pid==pgid), a
 * controllable clock, recorded signals, and a scriptable process-tree snapshot.
 * SIGKILL removes a group from the live set so the death proof can converge
 * without any wall-clock waiting.
 */
function fakeWorld(opts: {
  alive: number[];
  /** Snapshot returned each time the tree is read (defaults to alive leaders). */
  snapshots?: ProcessTreeNode[][];
  /** pgids that ignore SIGKILL (stay alive forever) — for the unconfirmed case. */
  immortal?: number[];
  /** When true, a cooperative SIGTERM also kills (models a child that obeys it). */
  coopLethal?: boolean;
}) {
  const alive = new Set(opts.alive);
  const immortal = new Set(opts.immortal ?? []);
  const coopLethal = opts.coopLethal ?? false;
  const signals: Array<{ pgid: number; signal: string }> = [];
  let t = 0;
  const snapshots = opts.snapshots ? [...opts.snapshots] : null;

  const identity: ProcessIdentityReader = {
    read(pid: number): ProcessIdentity {
      if (alive.has(pid)) {
        return {
          status: "known",
          pid,
          platform: "linux",
          source: "procfs_stat",
          startToken: `linux:${pid}`,
          processGroupId: pid,
        };
      }
      return { status: "missing", pid, platform: "linux" };
    },
    self(): ProcessIdentity {
      return { status: "missing", pid: 1, platform: "linux" };
    },
  };

  const groups = new ProcessGroupService({
    platform: "linux",
    identity,
    probeProcessGroup: (negPgid: number) => {
      const pgid = -negPgid;
      if (!alive.has(pgid)) {
        throw Object.assign(new Error("no such group"), { code: "ESRCH" });
      }
    },
    signalProcessGroup: (negPgid: number, signal: NodeJS.Signals) => {
      const pgid = -negPgid;
      signals.push({ pgid, signal });
      const lethal = signal === "SIGKILL" || (coopLethal && signal === "SIGTERM");
      if (lethal && !immortal.has(pgid)) alive.delete(pgid);
    },
  });

  const defaultSnapshot = (): ProcessTreeNode[] =>
    [...alive].map((pid) => ({ pid, ppid: pid === 1 ? 0 : 1, pgid: pid }));

  const tree: ProcessTreeReader = {
    snapshot: () => (snapshots && snapshots.length > 0 ? snapshots.shift()! : defaultSnapshot()),
  };

  return {
    groups,
    tree,
    signals,
    isAlive: (pgid: number) => alive.has(pgid),
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("descendantProcessGroupIds", () => {
  it("collects the escaped grandchild pgid even when it left the parent group", () => {
    // root 100 (pgid 100) -> cli 200 (pgid 100) -> tool 300 which setsid'd into
    // its own pgid 300.
    const nodes: ProcessTreeNode[] = [
      { pid: 100, ppid: 1, pgid: 100 },
      { pid: 200, ppid: 100, pgid: 100 },
      { pid: 300, ppid: 200, pgid: 300 },
      { pid: 999, ppid: 1, pgid: 999 }, // unrelated
    ];
    expect(descendantProcessGroupIds(100, nodes).sort((a, b) => a - b)).toEqual([100, 300]);
  });

  it("returns an empty list when the root is already gone", () => {
    expect(descendantProcessGroupIds(100, [{ pid: 999, ppid: 1, pgid: 999 }])).toEqual([]);
  });
});

describe("readProcessTable", () => {
  it("parses pid/ppid/pgid triples and skips malformed lines", () => {
    const nodes = readProcessTable(() => ({
      status: 0,
      stdout: "  100   1   100\n 200 100 100\nbad line\n 300 200 300\n",
    }));
    expect(nodes).toEqual([
      { pid: 100, ppid: 1, pgid: 100 },
      { pid: 200, ppid: 100, pgid: 100 },
      { pid: 300, ppid: 200, pgid: 300 },
    ]);
  });

  it("fails closed to [] on a non-zero ps exit", () => {
    expect(readProcessTable(() => ({ status: 1, stdout: "" }))).toEqual([]);
  });
});

describe("reapProcessTree", () => {
  it("confirms death after the direct group exits on the cooperative signal", async () => {
    const world = fakeWorld({ alive: [100], coopLethal: true });
    const outcome = await reapProcessTree({
      rootPid: 100,
      groups: world.groups,
      tree: world.tree,
      now: world.now,
      sleep: world.sleep,
      graceMs: 1_000,
      cooperativeSignal: "SIGTERM",
      probeIntervalMs: 50,
    });
    expect(outcome.state).toBe("confirmed");
    expect(world.isAlive(100)).toBe(false);
    // Never escalated: the cooperative signal was enough.
    expect(world.signals.every((s) => s.signal === "SIGTERM")).toBe(true);
  });

  it("KILLS an ESCAPED descendant group, not only the direct group", async () => {
    // Direct group 100 plus a tool that escaped into pgid 300. A group-kill of
    // 100 alone would leak 300 — the QA-027 orphan. The tree snapshot exposes
    // both; both must be signalled and proven dead.
    const world = fakeWorld({
      alive: [100, 300],
      snapshots: [
        // captured while the chain is intact
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 200, ppid: 100, pgid: 100 },
          { pid: 300, ppid: 200, pgid: 300 },
        ],
      ],
    });
    const outcome = await reapProcessTree({
      rootPid: 100,
      groups: world.groups,
      tree: world.tree,
      now: world.now,
      sleep: world.sleep,
      graceMs: 100,
      cooperativeSignal: "SIGTERM",
      probeIntervalMs: 50,
    });
    expect(outcome.state).toBe("confirmed");
    expect(world.isAlive(100)).toBe(false);
    expect(world.isAlive(300)).toBe(false);
    const killed = world.signals.filter((s) => s.signal === "SIGKILL").map((s) => s.pgid);
    expect(killed).toContain(100);
    expect(killed).toContain(300); // the escaped group got the hard signal
  });

  it("sends the cooperative signal first and escalates to SIGKILL only after grace", async () => {
    const world = fakeWorld({ alive: [100] });
    await reapProcessTree({
      rootPid: 100,
      groups: world.groups,
      tree: world.tree,
      now: world.now,
      sleep: world.sleep,
      graceMs: 200,
      cooperativeSignal: "SIGTERM",
      probeIntervalMs: 50,
    });
    // First signal is cooperative; SIGKILL appears only once the clock passed grace.
    expect(world.signals[0]).toEqual({ pgid: 100, signal: "SIGTERM" });
    expect(world.signals.some((s) => s.signal === "SIGKILL")).toBe(true);
  });

  it("captures a descendant group that forks AFTER the first signal (fixed point)", async () => {
    // First snapshot has only the direct group; a later snapshot reveals a
    // freshly forked escaped group 400 (alive in the kernel from the start but
    // not yet visible in the tree). The fixed-point re-scan must catch it.
    const world = fakeWorld({
      alive: [100, 400],
      snapshots: [
        [{ pid: 100, ppid: 1, pgid: 100 }],
        [{ pid: 100, ppid: 1, pgid: 100 }],
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 400, ppid: 100, pgid: 400 },
        ],
      ],
    });
    const outcome = await reapProcessTree({
      rootPid: 100,
      groups: world.groups,
      tree: world.tree,
      now: world.now,
      sleep: world.sleep,
      graceMs: 50,
      cooperativeSignal: "SIGTERM",
      probeIntervalMs: 25,
    });
    expect(outcome.state).toBe("confirmed");
    expect(world.isAlive(400)).toBe(false);
    expect(world.signals.filter((s) => s.signal === "SIGKILL").map((s) => s.pgid)).toContain(400);
  });

  it("reports UNCONFIRMED with survivors when a group survives the bounded escalation", async () => {
    const world = fakeWorld({
      alive: [100, 300],
      immortal: [300],
      snapshots: [
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 200, ppid: 100, pgid: 100 },
          { pid: 300, ppid: 200, pgid: 300 },
        ],
      ],
    });
    const outcome = await reapProcessTree({
      rootPid: 100,
      groups: world.groups,
      tree: world.tree,
      now: world.now,
      sleep: world.sleep,
      graceMs: 100,
      deadlineMs: 500,
      cooperativeSignal: "SIGTERM",
      probeIntervalMs: 50,
    });
    expect(outcome.state).toBe("unconfirmed");
    if (outcome.state === "unconfirmed") {
      expect(outcome.survivors).toContain(300);
      expect(outcome.survivors).not.toContain(100); // the killable group did die
    }
  });
});
