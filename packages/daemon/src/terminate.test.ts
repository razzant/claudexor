import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KnownProcessIdentity, ProcessIdentity } from "@claudexor/core";
import {
  awaitDaemonTermination,
  type DaemonTerminationDeps,
  type DaemonTerminationLeaseAuthority,
} from "./terminate.js";
import {
  processIsAlive,
  writerLeasePath,
  type DaemonLeaseOwner,
  type DaemonLeaseOwnerCapability,
  type DaemonWriterLeaseStatus,
} from "./writer-lease.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const SOCKET_PATH = "/tmp/claudexor-termination-test.sock";
const LEASE_PATH = `${SOCKET_PATH}.writer`;

const IDENTITY: KnownProcessIdentity = {
  status: "known",
  pid: 4242,
  platform: "linux",
  source: "procfs_stat",
  startToken: "linux:111222",
  processGroupId: 4242,
};

const OWNER: DaemonLeaseOwner = { pid: 4242, token: "old", identity: IDENTITY };
const LEGACY_OWNER: DaemonLeaseOwner = { pid: 4242, token: "legacy" };
const SUCCESSOR_IDENTITY: KnownProcessIdentity = {
  ...IDENTITY,
  pid: 5151,
  startToken: "linux:555555",
  processGroupId: 5151,
};
const SUCCESSOR: DaemonLeaseOwner = {
  pid: 5151,
  token: "new",
  identity: SUCCESSOR_IDENTITY,
};

const absent = (): DaemonWriterLeaseStatus => ({ status: "absent", path: LEASE_PATH });
const unknownLease = (
  reason: "owner_malformed" | "owner_unreadable" = "owner_malformed",
): DaemonWriterLeaseStatus => ({ status: "unknown", path: LEASE_PATH, reason });

function identityMatch(owner: DaemonLeaseOwner = OWNER): DaemonLeaseOwnerCapability {
  return {
    status: "capable",
    reason: "identity_match",
    observation: {
      identity: owner.identity ?? IDENTITY,
      linuxState: "S",
    },
  };
}

function legacyCapable(owner: DaemonLeaseOwner = LEGACY_OWNER): DaemonLeaseOwnerCapability {
  return {
    status: "capable",
    reason: "legacy_process_present",
    observation: {
      identity: { ...IDENTITY, pid: owner.pid },
      linuxState: "S",
    },
  };
}

function stale(
  reason: "process_missing" | "identity_mismatch" | "linux_zombie",
  owner: DaemonLeaseOwner = OWNER,
): DaemonLeaseOwnerCapability {
  let identity: ProcessIdentity;
  let linuxState: "Z" | null = null;
  if (reason === "process_missing") {
    identity = { status: "missing", pid: owner.pid, platform: "linux" };
  } else if (reason === "identity_mismatch") {
    identity = {
      ...(owner.identity ?? IDENTITY),
      pid: owner.pid,
      startToken: "linux:recycled",
    };
  } else {
    identity = owner.identity ?? { ...IDENTITY, pid: owner.pid };
    linuxState = "Z";
  }
  return { status: "proven_stale", reason, observation: { identity, linuxState } };
}

function unknownCapability(owner: DaemonLeaseOwner = OWNER): DaemonLeaseOwnerCapability {
  return {
    status: "unknown",
    reason: "identity_unavailable",
    observation: {
      identity: {
        status: "unknown",
        pid: owner.pid,
        platform: "linux",
        reason: "permission_denied",
      },
      linuxState: null,
    },
  };
}

function owned(
  owner: DaemonLeaseOwner,
  capability: DaemonLeaseOwnerCapability,
): DaemonWriterLeaseStatus {
  return { status: "owned", path: LEASE_PATH, owner, capability };
}

function sequenceAuthority(
  inspections: DaemonWriterLeaseStatus[],
  classify: (owner: DaemonLeaseOwner, call: number) => DaemonLeaseOwnerCapability = (owner) =>
    identityMatch(owner),
): {
  authority: DaemonTerminationLeaseAuthority;
  classified: DaemonLeaseOwner[];
  inspectCalls: () => number;
} {
  let inspection = 0;
  const classified: DaemonLeaseOwner[] = [];
  return {
    authority: {
      inspect: () => inspections[Math.min(inspection++, inspections.length - 1)]!,
      classify: (owner) => {
        classified.push(owner);
        return classify(owner, classified.length - 1);
      },
    },
    classified,
    inspectCalls: () => inspection,
  };
}

/** Deterministic clock: every sleep advances the injected time by pollMs. */
function deterministicDeps(
  kill: (pid: number, signal: NodeJS.Signals) => void = () => {
    throw new Error("kill must not be called");
  },
): DaemonTerminationDeps {
  let clock = 0;
  return {
    // These legacy fields remain source-compatible, but the strict lease
    // authority is the sole owner of process capability policy.
    identity: {
      read: () => {
        throw new Error("legacy identity dependency must not classify termination");
      },
      self: () => IDENTITY,
    },
    isAlive: () => {
      throw new Error("legacy isAlive dependency must not classify termination");
    },
    kill,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

function physicallyAbsentSocketPath(): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-terminate-"));
  roots.push(root);
  return join(root, "daemon.sock");
}

function physicalLeaseFor(owner: DaemonLeaseOwner): string {
  const socketPath = physicallyAbsentSocketPath();
  const leasePath = writerLeasePath(socketPath);
  mkdirSync(leasePath);
  writeFileSync(join(leasePath, "owner.json"), `${JSON.stringify(owner)}\n`);
  return socketPath;
}

describe("awaitDaemonTermination", () => {
  it("preserves its public runtime arity", () => {
    expect(awaitDaemonTermination.length).toBe(1);
  });

  it("uses strict production inspection for physical absence", async () => {
    await expect(awaitDaemonTermination(physicallyAbsentSocketPath())).resolves.toMatchObject({
      outcome: "exited",
    });
  });

  it("preserves processIsAlive as the raw signal-zero compatibility helper", () => {
    expect(processIsAlive(process.pid)).toBe(true);
  });

  it("preserves the supplied legacy isAlive runtime seam without a fourth authority", async () => {
    const recordedIdentity: KnownProcessIdentity = {
      ...IDENTITY,
      pid: process.pid,
      processGroupId: process.pid,
    };
    const socketPath = physicalLeaseFor({
      pid: process.pid,
      token: "legacy-is-alive",
      identity: recordedIdentity,
    });
    let identityGetterReads = 0;
    let identityReads = 0;
    let isAliveGetterReads = 0;
    let isAliveCalls = 0;
    const deps: DaemonTerminationDeps = {
      get identity() {
        identityGetterReads += 1;
        return {
          read: () => {
            identityReads += 1;
            return recordedIdentity;
          },
          self: () => recordedIdentity,
        };
      },
      get isAlive() {
        isAliveGetterReads += 1;
        return () => {
          isAliveCalls += 1;
          return false;
        };
      },
    };

    const result = await awaitDaemonTermination(socketPath, {}, deps);
    expect(result).toMatchObject({ outcome: "exited" });
    expect(result.detail).toContain(String(process.pid));
    expect({ identityGetterReads, identityReads, isAliveGetterReads, isAliveCalls }).toEqual({
      identityGetterReads: 1,
      identityReads: 0,
      isAliveGetterReads: 1,
      isAliveCalls: 1,
    });
  });

  it("preserves the supplied legacy identity runtime seam without a fourth authority", async () => {
    const recordedIdentity: KnownProcessIdentity = {
      ...IDENTITY,
      pid: process.pid,
      processGroupId: process.pid,
    };
    const socketPath = physicalLeaseFor({
      pid: process.pid,
      token: "legacy-identity",
      identity: recordedIdentity,
    });
    let getterReads = 0;
    let reads = 0;
    const deps: DaemonTerminationDeps = {
      get identity() {
        getterReads += 1;
        return {
          read: (pid: number): ProcessIdentity => {
            reads += 1;
            return { status: "missing", pid, platform: process.platform };
          },
          self: () => recordedIdentity,
        };
      },
    };

    const result = await awaitDaemonTermination(socketPath, {}, deps);
    expect(result).toMatchObject({ outcome: "exited" });
    expect(result.detail).toContain(String(process.pid));
    expect({ getterReads, reads }).toEqual({ getterReads: 1, reads: 1 });
  });

  it("keeps strict malformed-lease handling when a legacy process seam is supplied", async () => {
    const socketPath = physicallyAbsentSocketPath();
    const leasePath = writerLeasePath(socketPath);
    mkdirSync(leasePath);
    writeFileSync(join(leasePath, "owner.json"), "{not-json\n");
    let calls = 0;

    const result = await awaitDaemonTermination(
      socketPath,
      {},
      {
        isAlive: () => {
          calls += 1;
          return false;
        },
      },
    );
    expect(result).toMatchObject({ outcome: "still_alive" });
    expect(result.detail).toContain("activity is unknown");
    expect(calls).toBe(0);
  });

  it("does not inspect legacy policy getters when a fourth authority is explicit", async () => {
    let identityGetterReads = 0;
    let isAliveGetterReads = 0;
    const deps: DaemonTerminationDeps = {
      get identity() {
        identityGetterReads += 1;
        return {
          read: () => {
            throw new Error("explicit authority must own classification");
          },
          self: () => IDENTITY,
        };
      },
      get isAlive() {
        isAliveGetterReads += 1;
        return () => {
          throw new Error("explicit authority must own classification");
        };
      },
    };
    const fixture = sequenceAuthority([absent()]);

    await expect(
      awaitDaemonTermination(SOCKET_PATH, {}, deps, fixture.authority),
    ).resolves.toMatchObject({ outcome: "exited" });
    expect({ identityGetterReads, isAliveGetterReads }).toEqual({
      identityGetterReads: 0,
      isAliveGetterReads: 0,
    });
  });

  it("reclassifies the pinned owner after time advances and before SIGKILL", async () => {
    let recycled = false;
    let nowCalls = 0;
    const classified: DaemonLeaseOwner[] = [];
    const kills: Array<[number, NodeJS.Signals]> = [];
    const authority: DaemonTerminationLeaseAuthority = {
      inspect: () => owned(OWNER, identityMatch()),
      classify: (owner) => {
        classified.push(owner);
        return recycled ? stale("identity_mismatch", owner) : identityMatch(owner);
      },
    };
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      {
        expectedOwner: OWNER,
        deadlineMs: 500,
        killAfterMs: 0,
        pollMs: 100,
        allowSigkill: true,
      },
      {
        kill: (pid, signal) => kills.push([pid, signal]),
        sleep: async () => undefined,
        now: () => {
          nowCalls += 1;
          if (nowCalls === 2) recycled = true;
          return nowCalls === 1 ? 0 : 100;
        },
      },
      authority,
    );
    expect(result).toMatchObject({ outcome: "exited" });
    expect(result.detail).toContain("recycled");
    expect({ nowCalls, classified, kills }).toEqual({
      nowCalls: 2,
      classified: [OWNER, OWNER],
      kills: [],
    });
  });

  it.each([
    {
      name: "capable successor",
      freshLease: owned(SUCCESSOR, identityMatch(SUCCESSOR)),
      outcome: "still_alive",
      detail: "successor pid 5151",
    },
    {
      name: "unknown-capability successor",
      freshLease: owned(SUCCESSOR, unknownCapability(SUCCESSOR)),
      outcome: "still_alive",
      detail: "successor pid 5151",
    },
    {
      name: "unknown lease",
      freshLease: unknownLease("owner_unreadable"),
      outcome: "still_alive",
      detail: "writer-lease activity is unknown (owner_unreadable)",
    },
    {
      name: "proven-stale successor",
      freshLease: owned(SUCCESSOR, stale("linux_zombie", SUCCESSOR)),
      outcome: "exited",
      detail: "stale pid 5151",
    },
  ] as const)(
    "rechecks a $name after the pre-signal target becomes stale",
    async ({ freshLease, outcome, detail }) => {
      let transitioned = false;
      let nowCalls = 0;
      let sleepCalls = 0;
      let requireNoSuccessorReads = 0;
      const kills: Array<[number, NodeJS.Signals]> = [];
      const fixture = sequenceAuthority([owned(OWNER, identityMatch()), freshLease], (owner) =>
        transitioned ? stale("identity_mismatch", owner) : identityMatch(owner),
      );

      const result = await awaitDaemonTermination(
        SOCKET_PATH,
        {
          expectedOwner: OWNER,
          deadlineMs: 500,
          killAfterMs: 0,
          pollMs: 100,
          allowSigkill: true,
          get requireNoSuccessor() {
            requireNoSuccessorReads += 1;
            return requireNoSuccessorReads === 1;
          },
        },
        {
          kill: (pid, signal) => kills.push([pid, signal]),
          sleep: async () => {
            sleepCalls += 1;
          },
          now: () => {
            nowCalls += 1;
            if (nowCalls === 2) transitioned = true;
            return nowCalls === 1 ? 0 : 100;
          },
        },
        fixture.authority,
      );

      expect(result).toMatchObject({ outcome });
      expect(result.detail).toContain(detail);
      expect({
        nowCalls,
        sleepCalls,
        requireNoSuccessorReads,
        inspectCalls: fixture.inspectCalls(),
        kills,
      }).toEqual({
        nowCalls: 2,
        sleepCalls: 0,
        requireNoSuccessorReads: 1,
        inspectCalls: 2,
        kills: [],
      });
      expect(fixture.classified).toEqual([OWNER, OWNER]);
    },
  );

  it("does not add a successor inspection when the caller permits takeover", async () => {
    let transitioned = false;
    let nowCalls = 0;
    const kills: Array<[number, NodeJS.Signals]> = [];
    const fixture = sequenceAuthority(
      [owned(OWNER, identityMatch()), owned(SUCCESSOR, identityMatch(SUCCESSOR))],
      (owner) => (transitioned ? stale("identity_mismatch", owner) : identityMatch(owner)),
    );

    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      {
        expectedOwner: OWNER,
        deadlineMs: 500,
        killAfterMs: 0,
        pollMs: 100,
        allowSigkill: true,
        requireNoSuccessor: false,
      },
      {
        kill: (pid, signal) => kills.push([pid, signal]),
        sleep: async () => undefined,
        now: () => {
          nowCalls += 1;
          if (nowCalls === 2) transitioned = true;
          return nowCalls === 1 ? 0 : 100;
        },
      },
      fixture.authority,
    );

    expect(result).toMatchObject({ outcome: "exited" });
    expect({ nowCalls, inspectCalls: fixture.inspectCalls(), kills }).toEqual({
      nowCalls: 2,
      inspectCalls: 1,
      kills: [],
    });
    expect(fixture.classified).toEqual([OWNER, OWNER]);
  });

  it("preserves legacy match-to-mismatch pre-signal call counts", async () => {
    const socketPath = physicalLeaseFor(OWNER);
    const recycledIdentity: KnownProcessIdentity = {
      ...IDENTITY,
      startToken: "linux:999888",
    };
    let identityGetterReads = 0;
    let identityReads = 0;
    let isAliveGetterReads = 0;
    let isAliveCalls = 0;
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await awaitDaemonTermination(
      socketPath,
      {
        expectedOwner: OWNER,
        deadlineMs: 500,
        killAfterMs: 0,
        pollMs: 100,
        allowSigkill: true,
        requireNoSuccessor: true,
      },
      {
        get identity() {
          identityGetterReads += 1;
          return {
            read: () => {
              identityReads += 1;
              return identityReads === 1 ? IDENTITY : recycledIdentity;
            },
            self: () => IDENTITY,
          };
        },
        get isAlive() {
          isAliveGetterReads += 1;
          return () => {
            isAliveCalls += 1;
            return true;
          };
        },
        kill: (pid, signal) => kills.push([pid, signal]),
        sleep: async () => undefined,
        now: () => 0,
      },
    );
    expect(result).toMatchObject({ outcome: "exited" });
    expect(result.detail).toContain("recycled");
    expect({ identityGetterReads, identityReads, isAliveGetterReads, isAliveCalls, kills }).toEqual(
      {
        identityGetterReads: 1,
        identityReads: 2,
        isAliveGetterReads: 1,
        isAliveCalls: 1,
        kills: [],
      },
    );
  });

  it("preserves legacy unknown-to-match pre-signal authority", async () => {
    const socketPath = physicalLeaseFor(OWNER);
    let identityGetterReads = 0;
    let identityReads = 0;
    let isAliveGetterReads = 0;
    let isAliveCalls = 0;
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await awaitDaemonTermination(
      socketPath,
      {
        expectedOwner: OWNER,
        deadlineMs: 500,
        killAfterMs: 0,
        pollMs: 100,
        allowSigkill: true,
      },
      {
        get identity() {
          identityGetterReads += 1;
          return {
            read: (pid: number): ProcessIdentity => {
              identityReads += 1;
              return identityReads === 1
                ? { status: "unknown", pid, platform: "linux", reason: "permission_denied" }
                : IDENTITY;
            },
            self: () => IDENTITY,
          };
        },
        get isAlive() {
          isAliveGetterReads += 1;
          return () => {
            isAliveCalls += 1;
            return true;
          };
        },
        kill: (pid, signal) => {
          kills.push([pid, signal]);
          rmSync(writerLeasePath(socketPath), { recursive: true, force: true });
        },
        sleep: async () => undefined,
        now: () => 0,
      },
    );
    expect(result).toMatchObject({ outcome: "killed" });
    expect({ identityGetterReads, identityReads, isAliveGetterReads, isAliveCalls, kills }).toEqual(
      {
        identityGetterReads: 1,
        identityReads: 2,
        isAliveGetterReads: 1,
        isAliveCalls: 1,
        kills: [[OWNER.pid, "SIGKILL"]],
      },
    );
  });

  it("fails closed when the initial lease authority is unknown", async () => {
    const fixture = sequenceAuthority([unknownLease("owner_unreadable")]);
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      {},
      deterministicDeps(),
      fixture.authority,
    );
    expect(result).toMatchObject({ outcome: "still_alive" });
    expect(result.detail).toContain("activity is unknown");
    expect(fixture.inspectCalls()).toBe(1);
    expect(fixture.classified).toEqual([]);
  });

  it("treats a matching Linux zombie as exited without signalling it", async () => {
    const fixture = sequenceAuthority([owned(OWNER, stale("linux_zombie"))]);
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      { allowSigkill: true },
      deterministicDeps((pid, signal) => kills.push([pid, signal])),
      fixture.authority,
    );
    expect(result).toMatchObject({ outcome: "exited" });
    expect(result.detail).toContain("Linux zombie");
    expect(kills).toEqual([]);
  });

  it("waits through a transient unknown lease and accepts later physical absence", async () => {
    const fixture = sequenceAuthority([unknownLease(), absent()], () => unknownCapability());
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      { expectedOwner: OWNER, deadlineMs: 500, killAfterMs: 0, pollMs: 100, allowSigkill: true },
      deterministicDeps(),
      fixture.authority,
    );
    expect(result).toMatchObject({ outcome: "exited" });
    expect(result.detail).toContain("released its lease");
    expect(fixture.inspectCalls()).toBe(2);
  });

  it.each([
    ["process_missing", "is gone"],
    ["identity_mismatch", "recycled"],
  ] as const)("treats a %s pinned owner as exited", async (reason, detail) => {
    const fixture = sequenceAuthority([owned(OWNER, stale(reason))], () => stale(reason));
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      { expectedOwner: OWNER, allowSigkill: true },
      deterministicDeps(),
      fixture.authority,
    );
    expect(result).toMatchObject({ outcome: "exited" });
    expect(result.detail).toContain(detail);
  });

  it("escalates only an explicit same-generation identity match", async () => {
    let signalled = false;
    const classified: DaemonLeaseOwner[] = [];
    const kills: Array<[number, NodeJS.Signals]> = [];
    const authority: DaemonTerminationLeaseAuthority = {
      inspect: () => (signalled ? absent() : owned(OWNER, identityMatch())),
      classify: (owner) => {
        classified.push(owner);
        return identityMatch(owner);
      },
    };
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      {
        expectedOwner: OWNER,
        deadlineMs: 500,
        killAfterMs: 0,
        pollMs: 100,
        allowSigkill: true,
      },
      deterministicDeps((pid, signal) => {
        kills.push([pid, signal]);
        signalled = true;
      }),
      authority,
    );
    expect(kills).toEqual([[OWNER.pid, "SIGKILL"]]);
    expect(classified).toEqual([OWNER, OWNER]);
    expect(result).toMatchObject({ outcome: "killed" });
  });

  it("withholds SIGKILL without an explicit expected owner even when allowSigkill is true", async () => {
    const fixture = sequenceAuthority([owned(OWNER, identityMatch())]);
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      { deadlineMs: 300, killAfterMs: 100, pollMs: 100, allowSigkill: true },
      deterministicDeps((pid, signal) => kills.push([pid, signal])),
      fixture.authority,
    );
    expect(result).toMatchObject({ outcome: "still_alive" });
    expect(result.detail).toContain("no explicit expected owner");
    expect(kills).toEqual([]);
  });

  it("withholds SIGKILL when the explicit caller has no signal authority", async () => {
    const fixture = sequenceAuthority([owned(OWNER, identityMatch())]);
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      {
        expectedOwner: OWNER,
        deadlineMs: 300,
        killAfterMs: 100,
        pollMs: 100,
        allowSigkill: false,
      },
      deterministicDeps((pid, signal) => kills.push([pid, signal])),
      fixture.authority,
    );
    expect(result).toMatchObject({ outcome: "still_alive" });
    expect(result.detail).toContain("caller has no signal authority");
    expect(kills).toEqual([]);
  });

  it("never signals a capable legacy owner without birth identity", async () => {
    const fixture = sequenceAuthority([owned(LEGACY_OWNER, legacyCapable())], () =>
      legacyCapable(),
    );
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      {
        expectedOwner: LEGACY_OWNER,
        deadlineMs: 300,
        killAfterMs: 100,
        pollMs: 100,
        allowSigkill: true,
      },
      deterministicDeps((pid, signal) => kills.push([pid, signal])),
      fixture.authority,
    );
    expect(result).toMatchObject({ outcome: "still_alive" });
    expect(result.detail).toContain("no recorded birth identity");
    expect(kills).toEqual([]);
  });

  it("does not borrow signal authority from a same-generation record changed after pinning", async () => {
    const rewrittenOwner: DaemonLeaseOwner = { ...LEGACY_OWNER, identity: IDENTITY };
    const fixture = sequenceAuthority([owned(rewrittenOwner, identityMatch(rewrittenOwner))], () =>
      legacyCapable(),
    );
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      {
        expectedOwner: LEGACY_OWNER,
        deadlineMs: 300,
        killAfterMs: 100,
        pollMs: 100,
        allowSigkill: true,
      },
      deterministicDeps((pid, signal) => kills.push([pid, signal])),
      fixture.authority,
    );
    expect(result).toMatchObject({ outcome: "still_alive" });
    expect(result.detail).toContain("no recorded birth identity");
    expect(kills).toEqual([]);
  });

  it("classifies the pinned birth identity instead of a same pid/token record's identity", async () => {
    const recycledIdentity: KnownProcessIdentity = {
      ...IDENTITY,
      startToken: "linux:999888",
    };
    const rewrittenOwner: DaemonLeaseOwner = { ...OWNER, identity: recycledIdentity };
    const fixture = sequenceAuthority([owned(rewrittenOwner, identityMatch(rewrittenOwner))], () =>
      stale("identity_mismatch", OWNER),
    );
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      {
        expectedOwner: OWNER,
        deadlineMs: 300,
        killAfterMs: 0,
        pollMs: 100,
        allowSigkill: true,
      },
      deterministicDeps((pid, signal) => kills.push([pid, signal])),
      fixture.authority,
    );
    expect(result).toMatchObject({ outcome: "exited" });
    expect(result.detail).toContain("recycled");
    expect(fixture.classified).toEqual([OWNER]);
    expect(kills).toEqual([]);
  });

  it("never signals an owner whose current identity is unknown", async () => {
    const fixture = sequenceAuthority([owned(OWNER, unknownCapability())], () =>
      unknownCapability(),
    );
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      {
        expectedOwner: OWNER,
        deadlineMs: 300,
        killAfterMs: 100,
        pollMs: 100,
        allowSigkill: true,
      },
      deterministicDeps((pid, signal) => kills.push([pid, signal])),
      fixture.authority,
    );
    expect(result).toMatchObject({ outcome: "still_alive" });
    expect(result.detail).toContain("identity unverifiable");
    expect(kills).toEqual([]);
  });

  it("withholds signal authority while the physical lease is unknown", async () => {
    const fixture = sequenceAuthority([unknownLease()], () => identityMatch());
    const kills: Array<[number, NodeJS.Signals]> = [];
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      {
        expectedOwner: OWNER,
        deadlineMs: 300,
        killAfterMs: 0,
        pollMs: 100,
        allowSigkill: true,
      },
      deterministicDeps((pid, signal) => kills.push([pid, signal])),
      fixture.authority,
    );
    expect(result).toMatchObject({ outcome: "still_alive" });
    expect(result.detail).toContain("writer-lease authority unknown");
    expect(kills).toEqual([]);
  });

  it("refuses a capable or unknown successor after the pinned owner exits", async () => {
    for (const capability of [identityMatch(SUCCESSOR), unknownCapability(SUCCESSOR)]) {
      const fixture = sequenceAuthority([owned(SUCCESSOR, capability)], () =>
        stale("process_missing", OWNER),
      );
      const result = await awaitDaemonTermination(
        SOCKET_PATH,
        { expectedOwner: OWNER, requireNoSuccessor: true, allowSigkill: true },
        deterministicDeps(),
        fixture.authority,
      );
      expect(result).toMatchObject({ outcome: "still_alive" });
      expect(result.detail).toContain("successor pid 5151");
    }
  });

  it("does not promote a stale successor record into a live successor", async () => {
    const fixture = sequenceAuthority([owned(SUCCESSOR, stale("linux_zombie", SUCCESSOR))], () =>
      stale("process_missing", OWNER),
    );
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      { expectedOwner: OWNER, requireNoSuccessor: true, allowSigkill: true },
      deterministicDeps(),
      fixture.authority,
    );
    expect(result).toMatchObject({ outcome: "exited" });
    expect(result.detail).toContain("stale pid 5151");
  });

  it("fails closed on an unknown successor authority even after the old target exits", async () => {
    const fixture = sequenceAuthority([unknownLease()], () => stale("process_missing", OWNER));
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      { expectedOwner: OWNER, requireNoSuccessor: true, allowSigkill: true },
      deterministicDeps(),
      fixture.authority,
    );
    expect(result).toMatchObject({ outcome: "still_alive" });
    expect(result.detail).toContain("writer-lease activity is unknown");
  });

  it("signals only the pinned old target when a successor already owns the lease", async () => {
    let oldKilled = false;
    const classified: DaemonLeaseOwner[] = [];
    const kills: Array<[number, NodeJS.Signals]> = [];
    const authority: DaemonTerminationLeaseAuthority = {
      inspect: () => owned(SUCCESSOR, identityMatch(SUCCESSOR)),
      classify: (owner) => {
        classified.push(owner);
        return oldKilled ? stale("process_missing", owner) : identityMatch(owner);
      },
    };
    const result = await awaitDaemonTermination(
      SOCKET_PATH,
      {
        expectedOwner: OWNER,
        deadlineMs: 500,
        killAfterMs: 100,
        pollMs: 100,
        allowSigkill: true,
      },
      deterministicDeps((pid, signal) => {
        kills.push([pid, signal]);
        oldKilled = true;
      }),
      authority,
    );
    expect(kills).toEqual([[OWNER.pid, "SIGKILL"]]);
    expect(kills.some(([pid]) => pid === SUCCESSOR.pid)).toBe(false);
    expect(classified.every((owner) => owner === OWNER)).toBe(true);
    expect(result).toMatchObject({ outcome: "killed" });
  });

  it("keeps legacy dependency objects source-compatible with inspect/classify collisions", async () => {
    let inspectCollisionCalls = 0;
    let classifyCollisionCalls = 0;

    class InspectCollision {
      private readonly inspect = () => {
        inspectCollisionCalls += 1;
      };

      now(): number {
        return 0;
      }

      constructor() {
        void this.inspect;
      }
    }

    class ClassifyCollision {
      private readonly classify = () => {
        classifyCollisionCalls += 1;
      };

      now(): number {
        return 0;
      }

      constructor() {
        void this.classify;
      }
    }

    const inspectDeps: DaemonTerminationDeps = new InspectCollision();
    const classifyDeps: DaemonTerminationDeps = new ClassifyCollision();
    const fixture = sequenceAuthority([absent()]);

    await expect(
      awaitDaemonTermination(SOCKET_PATH, {}, inspectDeps, fixture.authority),
    ).resolves.toMatchObject({ outcome: "exited" });
    await expect(
      awaitDaemonTermination(SOCKET_PATH, {}, classifyDeps, fixture.authority),
    ).resolves.toMatchObject({ outcome: "exited" });
    expect({ inspectCollisionCalls, classifyCollisionCalls }).toEqual({
      inspectCollisionCalls: 0,
      classifyCollisionCalls: 0,
    });
  });
});
