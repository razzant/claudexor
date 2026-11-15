import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { processTiming } from "@claudexor/util";
import { runCaptureRaw, spawnProcess } from "./proc.js";
import { defaultProcessIdentityService } from "./process-identity.js";
import {
  liveChildProcesses,
  onChildProcessRegistered,
  registerChildProcess,
  unregisterChildProcess,
} from "./process-registry.js";
import { mintRunScopeMarker } from "./process-scope.js";

describe.runIf(process.platform !== "win32")("one identity read per spawned child (#688)", () => {
  it("runs the identity helper once per child at spawn, labeled, and keeps the group handle", async () => {
    const reads = vi.spyOn(defaultProcessIdentityService, "read");
    const recorded = vi.spyOn(processTiming, "recordSync");
    const registered: { pid: number; pgid: number }[] = [];
    const off = onChildProcessRegistered((child) =>
      registered.push({ pid: child.pid, pgid: child.processGroup.pgid }),
    );
    const children: number[] = [];
    try {
      for (let i = 0; i < 3; i += 1) {
        for await (const ev of spawnProcess(process.execPath, ["-e", "console.log('up')"])) {
          if (ev.type === "stdout") children.push(registered.at(-1)?.pid ?? 0);
        }
      }
      for (let i = 0; i < 2; i += 1) {
        const before = registered.length;
        const result = await runCaptureRaw(process.execPath, ["-e", "process.stdout.write('x')"]);
        expect(result.code).toBe(0);
        children.push(registered[before]?.pid ?? 0);
      }
      // Direction 1: helper runs equal the number of children (not twice each).
      expect(children).toHaveLength(5);
      expect(new Set(children).size).toBe(5);
      const childReads = reads.mock.calls.filter(([pid]) => children.includes(pid));
      expect(childReads).toHaveLength(children.length);
      for (const pid of children)
        expect(childReads.filter(([read]) => read === pid)).toHaveLength(1);
      // Direction 2: each child still registered as its own group's leader, and
      // the deliberately synchronous capture names itself in worstSync.
      for (const pid of children)
        expect(registered.find((child) => child.pid === pid)?.pgid).toBe(pid);
      expect(
        recorded.mock.calls.filter(([op]) => op === "process.identity_capture").length,
      ).toBeGreaterThanOrEqual(children.length);
    } finally {
      off();
      reads.mockRestore();
      recorded.mockRestore();
    }
  });

  it("still ends a cancelled child through the reused group handle, re-reading its identity", async () => {
    const reads = vi.spyOn(defaultProcessIdentityService, "read");
    const ac = new AbortController();
    let pid = 0;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    try {
      for await (const ev of spawnProcess(
        process.execPath,
        ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
        {
          abortSignal: ac.signal,
          cancelKillDelayMs: 50,
          reap: async () => ({ state: "confirmed", pgids: [] }),
        },
      )) {
        if (ev.type === "stdout" && ev.line === "ready") {
          pid = liveChildProcesses().at(-1)?.pid ?? 0;
          ac.abort();
        }
        if (ev.type === "exit") exit = { code: ev.code, signal: ev.signal };
      }
      // The child died by the group signal the captured handle allowed, and the
      // signal compared the leader identity fresh (compareLeader keeps its read).
      expect(pid).toBeGreaterThan(0);
      expect(exit?.signal).toBeTruthy();
      expect(reads.mock.calls.filter(([read]) => read === pid).length).toBeGreaterThan(1);
    } finally {
      reads.mockRestore();
    }
  });
});

describe("process registry scope marker", () => {
  it("never registers or announces a child whose leader identity was not measured", () => {
    // Today's default no-known-root fact, portably: registration needs a known
    // leader identity. On win32 the default identity service has none (see
    // process-identity.test.ts), so no Windows root is ever seeded with one.
    // This is a portable pin, not native Windows evidence.
    const announced: number[] = [];
    const off = onChildProcessRegistered((child) => announced.push(child.pid));
    const gone = 2 ** 22 + 12_345; // above every default pid_max: never a live process
    try {
      registerChildProcess(gone, "harness", mintRunScopeMarker());
      expect(liveChildProcesses().some((c) => c.pid === gone)).toBe(false);
      expect(announced).toEqual([]);
    } finally {
      off();
    }
  });

  it.runIf(process.platform !== "win32")(
    "records the marker NAME a group-leader child was registered under, and nothing without one",
    async () => {
      const marker = mintRunScopeMarker();
      // Only a process-group LEADER registers (its kernel identity is captured);
      // a detached child is one, the vitest worker itself is not.
      const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], {
        detached: true,
        stdio: "ignore",
      });
      const pid = child.pid!;
      try {
        registerChildProcess(pid, "leader", marker);
        expect(liveChildProcesses().find((c) => c.pid === pid)?.scopeMarker).toBe(marker);
        registerChildProcess(pid, "leader");
        expect(liveChildProcesses().find((c) => c.pid === pid)?.scopeMarker).toBeUndefined();
      } finally {
        unregisterChildProcess(pid);
        child.kill("SIGKILL");
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "a spawned harness child is registered under the run marker found in its env, then unregistered on close",
    async () => {
      const marker = mintRunScopeMarker();
      let seen: string | undefined | null = null;
      let pid = 0;
      for await (const ev of spawnProcess(process.execPath, ["-e", "console.log('up')"], {
        env: { [marker]: "1" },
      })) {
        if (ev.type === "stdout") {
          const live = liveChildProcesses().filter((c) => c.scopeMarker === marker);
          seen = live[0]?.scopeMarker;
          pid = live[0]?.pid ?? 0;
        }
      }
      expect(seen).toBe(marker);
      expect(pid).toBeGreaterThan(0);
      expect(liveChildProcesses().some((c) => c.pid === pid)).toBe(false);
    },
  );
});
