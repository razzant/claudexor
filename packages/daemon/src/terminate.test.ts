import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KnownProcessIdentity, ProcessIdentity } from "@claudexor/core";
import { awaitDaemonTermination } from "./terminate.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const IDENTITY: KnownProcessIdentity = {
  status: "known",
  pid: 4242,
  platform: "linux",
  source: "procfs_stat",
  startToken: "linux:111222",
  processGroupId: 4242,
};

function leaseFor(owner: Record<string, unknown> | null): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-terminate-"));
  roots.push(root);
  const socketPath = join(root, "daemon.sock");
  if (owner) {
    mkdirSync(`${socketPath}.writer`);
    writeFileSync(`${socketPath}.writer/owner.json`, `${JSON.stringify(owner)}\n`);
  }
  return socketPath;
}

/** Deterministic clock: every sleep advances the injected time by pollMs. */
function deps(overrides: {
  isAlive?: (pid: number) => boolean;
  read?: (pid: number) => ProcessIdentity;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}) {
  let clock = 0;
  return {
    isAlive: overrides.isAlive ?? (() => true),
    identity: {
      read: overrides.read ?? ((): ProcessIdentity => IDENTITY),
      self: (): ProcessIdentity => IDENTITY,
    },
    kill:
      overrides.kill ??
      (() => {
        throw new Error("kill must not be called");
      }),
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("awaitDaemonTermination", () => {
  it("confirms death when the lease was released", async () => {
    const socketPath = leaseFor(null);
    const result = await awaitDaemonTermination(socketPath, {}, deps({}));
    expect(result).toMatchObject({ outcome: "exited" });
  });

  it("confirms death when the recorded pid is gone (stale lease)", async () => {
    const socketPath = leaseFor({ pid: 4242, token: "t", identity: IDENTITY });
    const result = await awaitDaemonTermination(socketPath, {}, deps({ isAlive: () => false }));
    expect(result).toMatchObject({ outcome: "exited" });
    expect(result.detail).toContain("4242");
  });

  it("treats a RECYCLED pid as dead and never signals it (sol #5)", async () => {
    const socketPath = leaseFor({ pid: 4242, token: "t", identity: IDENTITY });
    const recycled: ProcessIdentity = { ...IDENTITY, startToken: "linux:999888" };
    const result = await awaitDaemonTermination(socketPath, {}, deps({ read: () => recycled }));
    expect(result).toMatchObject({ outcome: "exited" });
    expect(result.detail).toContain("recycled");
  });

  it("escalates an identity-VERIFIED SIGKILL past the graceful window", async () => {
    const socketPath = leaseFor({ pid: 4242, token: "t", identity: IDENTITY });
    const kills: Array<[number, string]> = [];
    let alive = true;
    const result = await awaitDaemonTermination(
      socketPath,
      { deadlineMs: 2_000, killAfterMs: 500, pollMs: 100 },
      deps({
        isAlive: () => alive,
        kill: (pid, signal) => {
          kills.push([pid, signal]);
          alive = false;
        },
      }),
    );
    expect(kills).toEqual([[4242, "SIGKILL"]]);
    expect(result).toMatchObject({ outcome: "killed" });
  });

  it("fails closed to an honest still_alive when no birth identity was recorded", async () => {
    const socketPath = leaseFor({ pid: 4242, token: "t" }); // legacy lease shape
    const result = await awaitDaemonTermination(
      socketPath,
      { deadlineMs: 1_000, killAfterMs: 300, pollMs: 100 },
      deps({}),
    );
    expect(result).toMatchObject({ outcome: "still_alive" });
    expect(result.detail).toContain("no recorded birth identity");
  });

  it("withholds the SIGKILL when the live identity is unverifiable", async () => {
    const socketPath = leaseFor({ pid: 4242, token: "t", identity: IDENTITY });
    const unknown: ProcessIdentity = {
      status: "unknown",
      pid: 4242,
      platform: "linux",
      reason: "permission_denied",
    };
    const result = await awaitDaemonTermination(
      socketPath,
      { deadlineMs: 1_000, killAfterMs: 300, pollMs: 100 },
      deps({ read: () => unknown }),
    );
    expect(result).toMatchObject({ outcome: "still_alive" });
    expect(result.detail).toContain("identity unverifiable");
  });
});
