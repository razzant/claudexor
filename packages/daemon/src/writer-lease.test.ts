import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type KnownProcessIdentity,
  type LinuxProcessState,
  type ProcessIdentity,
  type ProcessIdentityReader,
  type ProcessObservation,
  type ProcessObservationReader,
} from "@claudexor/core";
import {
  acquireDaemonWriterLease,
  classifyDaemonLeaseOwner,
  daemonLeaseOwner,
  inspectDaemonWriterLease,
  writerLeasePath,
  writerLeaseTombstonePath,
  type DaemonLeaseOwner,
  type DaemonWriterLeaseDependencies,
} from "./writer-lease.js";

function known(pid: number, start = `linux:${pid}`): KnownProcessIdentity {
  return {
    status: "known",
    pid,
    platform: "linux",
    source: "procfs_stat",
    startToken: start,
    processGroupId: pid,
  };
}

function knownDarwin(pid: number, start = `darwin:${pid}:1`): KnownProcessIdentity {
  return {
    status: "known",
    pid,
    platform: "darwin",
    source: "proc_pidinfo",
    startToken: start,
    processGroupId: pid,
  };
}

function observation(
  identity: ProcessIdentity,
  linuxState: LinuxProcessState | null = null,
): ProcessObservation {
  return { identity, linuxState };
}

function sourceFor(
  observed: ProcessObservation | ((pid: number) => ProcessObservation),
  selfIdentity: ProcessIdentity = known(process.pid, "linux:999"),
): ProcessIdentityReader & ProcessObservationReader {
  const observe = typeof observed === "function" ? observed : () => observed;
  return {
    read: (pid) => observe(pid).identity,
    observe,
    self: () => selfIdentity,
  };
}

function observationDependencies(
  observed: ProcessObservation | ((pid: number) => ProcessObservation),
  selfIdentity?: ProcessIdentity,
): Pick<DaemonWriterLeaseDependencies, "identity" | "observation"> {
  const source = sourceFor(observed, selfIdentity);
  return { identity: source, observation: source };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

let root: string;
let socketPath: string;
let leasePath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claudexor-writer-lease-"));
  socketPath = join(root, "claudexord.sock");
  leasePath = writerLeasePath(socketPath);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function seedOwner(owner: unknown, path = leasePath): string {
  mkdirSync(path, { mode: 0o700 });
  const raw = `${JSON.stringify(owner)}\n`;
  writeFileSync(join(path, "owner.json"), raw, { mode: 0o600 });
  return raw;
}

function replaceOwner(owner: unknown, path = leasePath): void {
  writeFileSync(join(path, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

function depsFor(
  observed: ProcessObservation | ((pid: number) => ProcessObservation),
  extra: Omit<DaemonWriterLeaseDependencies, "identity" | "observation"> = {},
): DaemonWriterLeaseDependencies {
  return { ...extra, ...observationDependencies(observed) };
}

function acquireWithDependencies(
  path: string,
  deps: DaemonWriterLeaseDependencies,
): ReturnType<typeof acquireDaemonWriterLease> {
  return acquireDaemonWriterLease(
    path,
    { identity: deps.identity },
    {
      observation: deps.observation,
      probeProcess: deps.probeProcess,
      filesystem: deps.filesystem,
    },
  );
}

describe("strict writer-lease inspection", () => {
  it("distinguishes physical absence, the owner-write boot window, and invalid paths", () => {
    expect(inspectDaemonWriterLease(socketPath)).toEqual({ status: "absent", path: leasePath });

    mkdirSync(leasePath);
    expect(inspectDaemonWriterLease(socketPath)).toEqual({
      status: "unknown",
      path: leasePath,
      reason: "owner_missing",
    });

    rmSync(leasePath, { recursive: true });
    writeFileSync(leasePath, "not a directory");
    expect(inspectDaemonWriterLease(socketPath)).toMatchObject({
      status: "unknown",
      reason: "invalid_lease_path",
    });

    rmSync(leasePath);
    mkdirSync(join(root, "target"));
    symlinkSync(join(root, "target"), leasePath);
    expect(inspectDaemonWriterLease(socketPath)).toMatchObject({
      status: "unknown",
      reason: "invalid_lease_path",
    });
  });

  it("accepts only strict current and legacy owner records", () => {
    const current = known(process.pid, "linux:999");
    seedOwner({ pid: process.pid, token: "legacy", future: true });
    expect(inspectDaemonWriterLease(socketPath, depsFor(observation(current, "S")))).toMatchObject({
      status: "owned",
      owner: { pid: process.pid, token: "legacy" },
      capability: { status: "capable", reason: "legacy_process_present" },
    });

    rmSync(leasePath, { recursive: true });
    seedOwner({ pid: process.pid, token: "current", identity: current, future: true });
    expect(inspectDaemonWriterLease(socketPath, depsFor(observation(current, "S")))).toMatchObject({
      status: "owned",
      owner: { identity: current },
      capability: { status: "capable", reason: "identity_match" },
    });

    for (const invalid of [
      { pid: 0, token: "x" },
      { pid: process.pid, token: "" },
      { pid: process.pid, token: "x", identity: null },
      { pid: process.pid, token: "x", identity: known(process.pid + 1) },
    ]) {
      rmSync(leasePath, { recursive: true });
      seedOwner(invalid);
      expect(inspectDaemonWriterLease(socketPath)).toMatchObject({
        status: "unknown",
        reason: "owner_malformed",
      });
    }
  });

  it("rejects a symlinked owner and preserves filesystem errors as unknown", () => {
    mkdirSync(leasePath);
    writeFileSync(join(root, "owner-target"), JSON.stringify({ pid: 1, token: "x" }));
    symlinkSync(join(root, "owner-target"), join(leasePath, "owner.json"));
    expect(inspectDaemonWriterLease(socketPath)).toMatchObject({
      status: "unknown",
      reason: "owner_malformed",
    });

    rmSync(leasePath, { recursive: true });
    expect(
      inspectDaemonWriterLease(socketPath, {
        filesystem: {
          lstat: () => {
            throw errno("EACCES");
          },
        },
      }),
    ).toMatchObject({ status: "unknown", reason: "lease_unreadable" });

    seedOwner({ pid: process.pid, token: "x" });
    expect(
      inspectDaemonWriterLease(socketPath, {
        filesystem: {
          readText: () => {
            throw errno("EIO");
          },
        },
      }),
    ).toMatchObject({ status: "unknown", reason: "owner_unreadable" });
  });

  it("retries when classification observes a superseded owner generation", () => {
    const original: DaemonLeaseOwner = {
      pid: 44,
      token: "original",
      identity: known(44, "linux:1"),
    };
    const successor: DaemonLeaseOwner = {
      pid: 55,
      token: "successor",
      identity: known(55, "linux:2"),
    };
    seedOwner(original);
    let swapped = false;
    const observed: number[] = [];

    expect(
      inspectDaemonWriterLease(
        socketPath,
        depsFor(
          (pid) => {
            observed.push(pid);
            if (pid === original.pid && !swapped) {
              swapped = true;
              replaceOwner(successor);
              return observation({ status: "missing", pid, platform: "linux" });
            }
            return observation(successor.identity!, "S");
          },
          { probeProcess: () => expect.fail("known observations must not probe or signal") },
        ),
      ),
    ).toMatchObject({
      status: "owned",
      owner: successor,
      capability: { status: "capable", reason: "identity_match" },
    });
    expect(observed).toEqual([original.pid, successor.pid]);
    expect(JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8"))).toEqual(successor);
  });

  it("fails closed when the owner generation changes on both inspection attempts", () => {
    const owners: DaemonLeaseOwner[] = [
      { pid: 44, token: "first", identity: known(44, "linux:1") },
      { pid: 55, token: "second", identity: known(55, "linux:2") },
      { pid: 66, token: "third", identity: known(66, "linux:3") },
    ];
    seedOwner(owners[0]);
    let generation = 0;
    const observed: number[] = [];

    expect(
      inspectDaemonWriterLease(
        socketPath,
        depsFor(
          (pid) => {
            observed.push(pid);
            generation += 1;
            replaceOwner(owners[generation]);
            return observation({ status: "missing", pid, platform: "linux" });
          },
          { probeProcess: () => expect.fail("missing observations must not probe or signal") },
        ),
      ),
    ).toEqual({ status: "unknown", path: leasePath, reason: "lease_unstable" });
    expect(observed).toEqual([owners[0]!.pid, owners[1]!.pid]);
    expect(JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8"))).toEqual(owners[2]);
  });

  it("keeps the nullable compatibility projection deliberately lossy", () => {
    expect(daemonLeaseOwner(socketPath)).toBeNull();
    mkdirSync(leasePath);
    expect(daemonLeaseOwner(socketPath)).toBeNull();
    writeFileSync(join(leasePath, "owner.json"), "not-json");
    expect(daemonLeaseOwner(socketPath)).toBeNull();
    writeFileSync(join(leasePath, "owner.json"), '{"pid":7,"token":"legacy"}\n');
    expect(daemonLeaseOwner(socketPath)).toEqual({ pid: 7, token: "legacy" });

    replaceOwner({ pid: 7, token: "" });
    expect(daemonLeaseOwner(socketPath)).toEqual({ pid: 7, token: "" });

    replaceOwner({ pid: 7, token: "null-identity", identity: null });
    expect(daemonLeaseOwner(socketPath)).toEqual({ pid: 7, token: "null-identity" });

    replaceOwner({ pid: 7, token: "invalid-identity", identity: { status: "known" } });
    expect(daemonLeaseOwner(socketPath)).toEqual({ pid: 7, token: "invalid-identity" });

    const mismatchedIdentity = known(8, "linux:8");
    replaceOwner({ pid: 7, token: "mismatched-identity", identity: mismatchedIdentity });
    expect(daemonLeaseOwner(socketPath)).toEqual({
      pid: 7,
      token: "mismatched-identity",
      identity: mismatchedIdentity,
    });

    rmSync(join(leasePath, "owner.json"));
    writeFileSync(join(root, "legacy-owner-target"), '{"pid":7,"token":"symlink"}\n');
    symlinkSync(join(root, "legacy-owner-target"), join(leasePath, "owner.json"));
    expect(daemonLeaseOwner(socketPath)).toEqual({ pid: 7, token: "symlink" });
    expect(inspectDaemonWriterLease(socketPath)).toMatchObject({
      status: "unknown",
      reason: "owner_malformed",
    });
  });
});

describe("legacy acquisition dependency compatibility", () => {
  it("ignores unrelated members that collide with new dependency names", () => {
    const stalePid = 999_999_999;
    const identity: ProcessIdentityReader = {
      read: (pid) => ({
        status: "unknown",
        pid,
        platform: process.platform,
        reason: "permission_denied",
      }),
      self: () => known(process.pid, "linux:999"),
    };
    let observationCalls = 0;
    let probeCalls = 0;
    let filesystemCalls = 0;

    class ObservationCollision {
      readonly identity = identity;
      private readonly observation = () => {
        observationCalls += 1;
      };

      constructor() {
        void this.observation;
      }
    }

    class ProbeCollision {
      readonly identity = identity;
      private readonly probeProcess = () => {
        probeCalls += 1;
      };

      constructor() {
        void this.probeProcess;
      }
    }

    class FilesystemCollision {
      readonly identity = identity;
      private readonly filesystem = {
        createLeaseDirectory: () => {
          filesystemCalls += 1;
          throw new Error("unrelated filesystem member was invoked");
        },
      };

      constructor() {
        void this.filesystem;
      }
    }

    const observationSocket = join(root, "observation.sock");
    const probeSocket = join(root, "probe.sock");
    const filesystemSocket = join(root, "filesystem.sock");
    seedOwner({ pid: stalePid, token: "observation" }, writerLeasePath(observationSocket));
    seedOwner({ pid: stalePid, token: "probe" }, writerLeasePath(probeSocket));
    seedOwner({ pid: stalePid, token: "filesystem" }, writerLeasePath(filesystemSocket));

    const observationLease = acquireDaemonWriterLease(
      observationSocket,
      new ObservationCollision(),
    );
    const probeLease = acquireDaemonWriterLease(probeSocket, new ProbeCollision());
    const filesystemLease = acquireDaemonWriterLease(filesystemSocket, new FilesystemCollision());

    expect({ observationCalls, probeCalls, filesystemCalls }).toEqual({
      observationCalls: 0,
      probeCalls: 0,
      filesystemCalls: 0,
    });
    observationLease.release();
    probeLease.release();
    filesystemLease.release();
  });

  it("reads the legacy identity dependency exactly once", () => {
    const identity: ProcessIdentityReader = {
      read: (pid) => ({ status: "missing", pid, platform: process.platform }),
      self: () => known(process.pid, "linux:999"),
    };
    let reads = 0;
    const deps = {
      get identity(): ProcessIdentityReader {
        reads += 1;
        if (reads > 1) throw new Error("identity getter read twice");
        return identity;
      },
    };

    const lease = acquireDaemonWriterLease(join(root, "identity-getter.sock"), deps);
    expect(reads).toBe(1);
    lease.release();
  });
});

describe("daemon lease-owner capability", () => {
  const owner: DaemonLeaseOwner = { pid: 44, token: "owner", identity: known(44, "linux:1") };

  it("proves only missing, recycled, or exact Linux Z owners stale", () => {
    expect(
      classifyDaemonLeaseOwner(
        owner,
        depsFor(observation({ status: "missing", pid: 44, platform: "linux" })),
      ),
    ).toMatchObject({ status: "proven_stale", reason: "process_missing" });
    expect(
      classifyDaemonLeaseOwner(owner, depsFor(observation(known(44, "linux:2"), "S"))),
    ).toMatchObject({ status: "proven_stale", reason: "identity_mismatch" });
    expect(
      classifyDaemonLeaseOwner(owner, depsFor(observation(known(44, "linux:1"), "Z"))),
    ).toMatchObject({ status: "proven_stale", reason: "linux_zombie" });

    for (const state of ["R", "S", "D", "T", "t", "X", "x"] as const) {
      expect(
        classifyDaemonLeaseOwner(owner, depsFor(observation(known(44, "linux:1"), state))),
      ).toMatchObject({ status: "capable", reason: "identity_match" });
    }
  });

  it("handles legacy owners without granting them signal identity", () => {
    const legacy = { pid: 44, token: "legacy" };
    expect(
      classifyDaemonLeaseOwner(legacy, depsFor(observation(known(44, "linux:1"), "Z"))),
    ).toMatchObject({ status: "proven_stale", reason: "linux_zombie" });
    expect(
      classifyDaemonLeaseOwner(legacy, depsFor(observation(known(44, "linux:1"), "S"))),
    ).toMatchObject({ status: "capable", reason: "legacy_process_present" });

    const unsupported = observation({
      status: "unknown",
      pid: 44,
      platform: "win32",
      reason: "unsupported_platform",
    });
    expect(
      classifyDaemonLeaseOwner(legacy, depsFor(unsupported, { probeProcess: () => undefined })),
    ).toMatchObject({ status: "capable", reason: "legacy_process_present" });
    expect(
      classifyDaemonLeaseOwner(
        legacy,
        depsFor(unsupported, {
          probeProcess: () => {
            throw errno("EPERM");
          },
        }),
      ),
    ).toMatchObject({ status: "capable", reason: "legacy_process_present" });
  });

  it("requires a same-pid Linux procfs observation before treating Z as a zombie", () => {
    const darwin = knownDarwin(44);
    const injectedState = depsFor(observation(darwin, "Z"));

    expect(
      classifyDaemonLeaseOwner({ pid: 44, token: "current", identity: darwin }, injectedState),
    ).toMatchObject({ status: "capable", reason: "identity_match" });
    expect(classifyDaemonLeaseOwner({ pid: 44, token: "legacy" }, injectedState)).toMatchObject({
      status: "capable",
      reason: "legacy_process_present",
    });
  });

  it("fails closed when an identity-bearing owner cannot be observed", () => {
    const unavailable = observation({
      status: "unknown",
      pid: 44,
      platform: "linux",
      reason: "permission_denied",
    });
    for (const probeProcess of [
      () => undefined,
      () => {
        throw errno("EPERM");
      },
    ]) {
      expect(classifyDaemonLeaseOwner(owner, depsFor(unavailable, { probeProcess }))).toMatchObject(
        {
          status: "unknown",
          reason: "identity_unavailable",
        },
      );
    }
    expect(
      classifyDaemonLeaseOwner(
        owner,
        depsFor(unavailable, {
          probeProcess: () => {
            throw errno("ESRCH");
          },
        }),
      ),
    ).toMatchObject({ status: "proven_stale", reason: "process_missing" });
    expect(
      classifyDaemonLeaseOwner(
        owner,
        depsFor(unavailable, {
          probeProcess: () => {
            throw errno("EIO");
          },
        }),
      ),
    ).toMatchObject({ status: "unknown", reason: "presence_unknown" });
  });

  it("keeps legacy identity readers with unrelated observe members source-compatible", () => {
    let reads = 0;
    let collidingObserveCalls = 0;
    class LegacyReaderWithUnrelatedObserve implements ProcessIdentityReader {
      constructor() {
        void this.observe;
      }

      private observe(_pid: number): void {
        collidingObserveCalls += 1;
      }

      read(pid: number): ProcessIdentity {
        reads += 1;
        return { status: "missing", pid, platform: "linux" };
      }

      self(): ProcessIdentity {
        return known(process.pid, "linux:999");
      }
    }

    const reader = new LegacyReaderWithUnrelatedObserve();
    const dependencies: NonNullable<Parameters<typeof acquireDaemonWriterLease>[1]> = {
      identity: reader,
    };
    expect(
      classifyDaemonLeaseOwner(
        { pid: 44, token: "legacy-reader", identity: known(44) },
        dependencies,
      ),
    ).toMatchObject({ status: "proven_stale", reason: "process_missing" });
    expect(reads).toBe(1);
    expect(collidingObserveCalls).toBe(0);
  });
});

describe("generation-bound writer-lease recovery", () => {
  const staleOwner: DaemonLeaseOwner = {
    pid: 4444,
    token: "raw-secret-token",
    identity: known(4444, "linux:1"),
  };

  function recoveryDeps(): DaemonWriterLeaseDependencies {
    return {
      ...observationDependencies((pid) =>
        pid === staleOwner.pid
          ? observation(staleOwner.identity!, "Z")
          : observation(known(pid, "linux:999"), "S"),
      ),
      probeProcess: () => {
        throw new Error("known observations must not need signal-zero fallback");
      },
    };
  }

  it("derives one opaque tombstone per exact owner generation", () => {
    const first = writerLeaseTombstonePath(leasePath, staleOwner);
    expect(writerLeaseTombstonePath(leasePath, staleOwner)).toBe(first);
    expect(writerLeaseTombstonePath(leasePath, { ...staleOwner, token: "other" })).not.toBe(first);
    expect(first).toMatch(new RegExp(`\\.stale-${staleOwner.pid}-[0-9a-f]{64}$`));
    expect(first).not.toContain(staleOwner.token);
  });

  it("recovers a matching zombie and preserves its exact nonempty tombstone", () => {
    const original = seedOwner(staleOwner);
    const lease = acquireWithDependencies(socketPath, recoveryDeps());
    const tombstone = writerLeaseTombstonePath(leasePath, staleOwner);

    expect(JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8"))).toMatchObject({
      pid: process.pid,
      token: lease.owner.token,
    });
    expect(readFileSync(join(tombstone, "owner.json"), "utf8")).toBe(original);
    lease.release();
    expect(inspectDaemonWriterLease(socketPath)).toMatchObject({ status: "absent" });
    expect(readFileSync(join(tombstone, "owner.json"), "utf8")).toBe(original);
  });

  it("prevents a delayed contender from moving a fresh successor", () => {
    const original = seedOwner(staleOwner);
    const tombstone = writerLeaseTombstonePath(leasePath, staleOwner);
    let successor: ReturnType<typeof acquireDaemonWriterLease> | undefined;
    let successorBytes = "";
    let interleaved = false;
    const delayedDeps: DaemonWriterLeaseDependencies = {
      ...recoveryDeps(),
      filesystem: {
        rename: (from, to) => {
          if (!interleaved) {
            interleaved = true;
            successor = acquireWithDependencies(socketPath, recoveryDeps());
            successorBytes = readFileSync(join(leasePath, "owner.json"), "utf8");
          }
          renameSync(from, to);
        },
      },
    };

    expect(() => acquireWithDependencies(socketPath, delayedDeps)).toThrowError(
      expect.objectContaining({ code: "daemon_writer_busy", status: 409 }),
    );
    expect(successor).toBeDefined();
    expect(readFileSync(join(leasePath, "owner.json"), "utf8")).toBe(successorBytes);
    expect(readFileSync(join(tombstone, "owner.json"), "utf8")).toBe(original);
    if (!successor) throw new Error("expected interleaved successor");
    successor.release();
  });

  it("rechecks after classification so an orderly release cannot expose its successor", () => {
    seedOwner(staleOwner);
    const successor: DaemonLeaseOwner = {
      pid: 5555,
      token: "clean-successor",
      identity: known(5555, "linux:2"),
    };
    let transitioned = false;
    const deps: DaemonWriterLeaseDependencies = {
      ...observationDependencies((pid) => {
        if (pid === staleOwner.pid) {
          if (!transitioned) {
            transitioned = true;
            rmSync(leasePath, { recursive: true });
            seedOwner(successor);
          }
          return observation({ status: "missing", pid, platform: "linux" });
        }
        return observation(successor.identity!, "S");
      }),
    };

    expect(() => acquireWithDependencies(socketPath, deps)).toThrowError(
      expect.objectContaining({ code: "daemon_writer_busy", status: 409 }),
    );
    expect(JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8"))).toEqual(successor);
    expect(() => lstatSync(writerLeaseTombstonePath(leasePath, staleOwner))).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("fails boundedly when the tombstone exists but the stale main generation is unchanged", () => {
    const original = seedOwner(staleOwner);
    const tombstone = writerLeaseTombstonePath(leasePath, staleOwner);
    seedOwner(staleOwner, tombstone);

    expect(() => acquireWithDependencies(socketPath, recoveryDeps())).toThrow(
      `could not replace stale daemon writer lease ${leasePath}`,
    );
    expect(readFileSync(join(leasePath, "owner.json"), "utf8")).toBe(original);
    expect(readFileSync(join(tombstone, "owner.json"), "utf8")).toBe(original);
  });

  it("returns typed busy when the main owner changes during the final attempt", () => {
    const successor: DaemonLeaseOwner = {
      pid: 5555,
      token: "final-attempt-successor",
      identity: known(5555, "linux:2"),
    };
    let createAttempts = 0;
    let transitioned = false;
    const deps: DaemonWriterLeaseDependencies = {
      ...observationDependencies((pid) => {
        if (pid === staleOwner.pid) {
          if (!transitioned) {
            transitioned = true;
            rmSync(leasePath, { recursive: true });
            seedOwner(successor);
          }
          return observation({ status: "missing", pid, platform: "linux" });
        }
        return observation(successor.identity!, "S");
      }),
      filesystem: {
        createLeaseDirectory: (path) => {
          createAttempts += 1;
          if (createAttempts === 1) throw errno("EEXIST");
          if (createAttempts === 2) {
            seedOwner(staleOwner, path);
            throw errno("EEXIST");
          }
          mkdirSync(path, { mode: 0o700 });
        },
      },
    };

    expect(() => acquireWithDependencies(socketPath, deps)).toThrowError(
      expect.objectContaining({ code: "daemon_writer_busy", status: 409 }),
    );
    expect(JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8"))).toEqual(successor);
  });

  it("normalizes only a proven occupied Windows-style EPERM destination", () => {
    seedOwner(staleOwner);
    const tombstone = writerLeaseTombstonePath(leasePath, staleOwner);
    seedOwner(staleOwner, tombstone);
    const epermDeps: DaemonWriterLeaseDependencies = {
      ...recoveryDeps(),
      filesystem: {
        rename: () => {
          throw errno("EPERM");
        },
      },
    };

    expect(() => acquireWithDependencies(socketPath, epermDeps)).toThrow(
      `could not replace stale daemon writer lease ${leasePath}`,
    );

    rmSync(tombstone, { recursive: true });
    const foreignOwner: DaemonLeaseOwner = { pid: 5555, token: "foreign" };
    seedOwner(foreignOwner, tombstone);
    expect(() => acquireWithDependencies(socketPath, epermDeps)).toThrowError(
      expect.objectContaining({ code: "EPERM" }),
    );
    expect(JSON.parse(readFileSync(join(tombstone, "owner.json"), "utf8"))).toEqual(foreignOwner);
  });

  it("blocks live, unknown, and malformed owners without mutating them", () => {
    const raw = seedOwner(staleOwner);
    const liveDeps = depsFor(observation(staleOwner.identity!, "S"));
    try {
      acquireWithDependencies(socketPath, liveDeps);
      throw new Error("expected busy lease");
    } catch (error) {
      expect(error).toMatchObject({ code: "daemon_writer_busy", status: 409 });
    }
    expect(readFileSync(join(leasePath, "owner.json"), "utf8")).toBe(raw);

    rmSync(leasePath, { recursive: true });
    mkdirSync(leasePath);
    expect(() => acquireWithDependencies(socketPath, recoveryDeps())).toThrowError(
      expect.objectContaining({ code: "daemon_writer_busy", status: 409 }),
    );
  });

  it("fences release to the exact main owner and never removes a successor", () => {
    const lease = acquireWithDependencies(
      socketPath,
      depsFor(observation(known(process.pid, "linux:999"), "S")),
    );
    rmSync(leasePath, { recursive: true });
    const successor = { pid: process.pid + 1, token: "successor" };
    seedOwner(successor);

    lease.release();
    expect(JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8"))).toEqual(successor);
    expect(lstatSync(leasePath).isDirectory()).toBe(true);
  });
});
