import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { armOrphanExit, labelStreams, runCaptureRaw, spawnProcess } from "./proc.js";
import { ProcessGroupService } from "./process-group.js";
import type { ProcessIdentity, ProcessIdentityReader } from "./process-identity.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-proc-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("spawnProcess", () => {
  it("kills the child when the consumer closes the stream early", async () => {
    const dir = tempDir();
    const marker = join(dir, "survived.txt");
    const script = [
      "console.log('ready')",
      "process.on('SIGINT', () => {})",
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500)`,
      "setTimeout(() => {}, 5000)",
    ].join(";");

    for await (const ev of spawnProcess(process.execPath, ["-e", script], {
      cancelKillDelayMs: 100,
    })) {
      if (ev.type === "stdout" && ev.line === "ready") break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });

  it("kills a silent child when the abort signal fires", async () => {
    const dir = tempDir();
    const marker = join(dir, "survived.txt");
    const script = [
      "console.log('ready')",
      "process.on('SIGINT', () => {})",
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500)`,
      "setTimeout(() => {}, 5000)",
    ].join(";");
    const ac = new AbortController();
    let sawReady = false;
    const done = (async () => {
      for await (const ev of spawnProcess(process.execPath, ["-e", script], {
        abortSignal: ac.signal,
        cancelKillDelayMs: 100,
      })) {
        if (ev.type === "stdout" && ev.line === "ready") {
          sawReady = true;
          ac.abort();
        }
      }
    })();

    await done;
    expect(sawReady).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });

  // QA-027: a vendor tool that setsid'd into its OWN process group and then
  // reparents to pid 1 (its CLI exits on the cooperative signal) must still be
  // dead before the generator returns. A group-kill of the direct child alone
  // leaked exactly this — a `/bin/sleep 60` orphan lived ~40s past terminal.
  it("reaps an ESCAPED descendant process group before the generator returns", async () => {
    const dir = tempDir();
    const marker = join(dir, "escaped.txt");
    // Parent (the direct child) spawns a DETACHED grandchild in a new pgid, then
    // exits promptly on SIGINT — orphaning the grandchild. The grandchild
    // ignores SIGINT and would write the marker at 1500ms if it survives.
    const grandchild = [
      "process.on('SIGINT', () => {})",
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500)`,
      "setTimeout(() => {}, 5000)",
    ].join(";");
    const parent = [
      "const { spawn } = require('node:child_process')",
      `const gc = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' })`,
      "gc.unref()",
      "console.log('ready ' + gc.pid)",
      "process.on('SIGINT', () => process.exit(0))",
      "setTimeout(() => {}, 5000)",
    ].join(";");

    const ac = new AbortController();
    let escapedPgid = 0;
    for await (const ev of spawnProcess(process.execPath, ["-e", parent], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 150,
    })) {
      if (ev.type === "stdout" && ev.line.startsWith("ready ")) {
        escapedPgid = Number(ev.line.slice("ready ".length));
        // Let the grandchild fully establish its own process group.
        await new Promise((resolve) => setTimeout(resolve, 150));
        ac.abort();
      }
    }

    // The for-await completed => the generator returned. Death proof gates that
    // return, so the escaped group must already be gone: NO post-hoc sleep.
    expect(escapedPgid).toBeGreaterThan(0);
    let groupAlive = true;
    try {
      process.kill(-escapedPgid, 0);
    } catch (err) {
      groupAlive = (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
    expect(groupAlive).toBe(false);

    // And the orphan never got to run its side effect.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });
});

// QA-027 fail-closed disclosure: when the whole-tree death proof cannot confirm
// death, spawnProcess must DISCLOSE it as a typed `termination_unconfirmed` event
// on the active stream (not only the optional callback). The reap is injected so
// the unconfirmed outcome is deterministic.
describe("spawnProcess termination_unconfirmed disclosure", () => {
  const quickChild = [
    "console.log('ready')",
    "process.on('SIGINT', () => process.exit(0))",
    "setTimeout(() => {}, 5000)",
  ].join(";");

  it("yields a typed termination_unconfirmed event for a surviving group (after the exit event)", async () => {
    const ac = new AbortController();
    const events: Array<{ type: string; survivors?: number[]; unresolved?: unknown[] }> = [];
    for await (const ev of spawnProcess(process.execPath, ["-e", quickChild], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 50,
      reap: async () => ({ state: "unconfirmed", survivors: [424242], unresolved: [] }),
    })) {
      events.push(ev);
      if (ev.type === "stdout" && ev.line === "ready") ac.abort();
    }
    const disc = events.find((e) => e.type === "termination_unconfirmed");
    expect(disc, "termination_unconfirmed disclosed").toBeTruthy();
    expect(disc?.survivors).toEqual([424242]);
    // It rides AFTER the terminal exit event.
    const exitIdx = events.findIndex((e) => e.type === "exit");
    const discIdx = events.findIndex((e) => e.type === "termination_unconfirmed");
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(discIdx).toBeGreaterThan(exitIdx);
  });

  it("discloses an unreadable-identity group (unresolved) as termination_unconfirmed", async () => {
    const ac = new AbortController();
    const events: Array<{
      type: string;
      survivors?: number[];
      unresolved?: Array<{ pgid: number }>;
    }> = [];
    for await (const ev of spawnProcess(process.execPath, ["-e", quickChild], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 50,
      reap: async () => ({
        state: "unconfirmed",
        survivors: [],
        unresolved: [{ pgid: 999, reason: "leader identity unreadable" }],
      }),
    })) {
      events.push(ev);
      if (ev.type === "stdout" && ev.line === "ready") ac.abort();
    }
    const disc = events.find((e) => e.type === "termination_unconfirmed");
    expect(disc, "termination_unconfirmed disclosed").toBeTruthy();
    expect(disc?.unresolved?.[0]?.pgid).toBe(999);
  });

  it("seeds the direct child's process group identity into the whole-tree reap (round-2 #3)", async () => {
    // The direct child can exit before the cancel-time tree snapshot while a
    // same-pgid grandchild survives; the seeded direct handle keeps that group
    // reapable even though its ppid chain to the root is already gone.
    const ac = new AbortController();
    let seeded: { rootPid?: number; seedHandles?: Array<{ pgid: number }> } | null = null;
    for await (const ev of spawnProcess(process.execPath, ["-e", quickChild], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 50,
      reap: async (opts) => {
        seeded = opts;
        return { state: "confirmed", pgids: [] };
      },
    })) {
      if (ev.type === "stdout" && ev.line === "ready") ac.abort();
    }
    expect(seeded).toBeTruthy();
    expect(seeded!.seedHandles).toHaveLength(1);
    // detached => the direct child is its own group leader (pgid == pid == rootPid).
    expect(seeded!.seedHandles?.[0]?.pgid).toBe(seeded!.rootPid);
  });

  it("does NOT disclose termination_unconfirmed when the reap confirms death", async () => {
    const ac = new AbortController();
    const events: Array<{ type: string }> = [];
    for await (const ev of spawnProcess(process.execPath, ["-e", quickChild], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 50,
      reap: async () => ({ state: "confirmed", pgids: [] }),
    })) {
      events.push(ev);
      if (ev.type === "stdout" && ev.line === "ready") ac.abort();
    }
    expect(events.some((e) => e.type === "termination_unconfirmed")).toBe(false);
  });
});

// Round-4 #1: the direct-group cancel belt must signal ONLY through the captured,
// identity-verified process-group handle — never a raw negative-PID kill that a
// reused PID/PGID could redirect to an unrelated group. When identity cannot be
// proven (capture unknown, or the leader identity changed before escalation) the
// belt sends NOTHING; the whole-tree reap remains the fail-closed disclosure.
describe("spawnProcess identity-proven cancel belt", () => {
  // Child self-exits regardless of signals, so the run terminates cleanly even
  // when the belt (correctly) refuses to signal — isolating the assertion to
  // "was a raw group signal ever emitted?".
  const selfExitChild = ["console.log('ready')", "setTimeout(() => process.exit(0), 300)"].join(
    ";",
  );

  function spyGroupService(identity: ProcessIdentityReader): {
    groups: ProcessGroupService;
    signalled: Array<{ negativePgid: number; signal: string }>;
  } {
    const signalled: Array<{ negativePgid: number; signal: string }> = [];
    const groups = new ProcessGroupService({
      platform: "linux",
      identity,
      probeProcessGroup: () => {},
      signalProcessGroup: (negativePgid, signal) => signalled.push({ negativePgid, signal }),
    });
    return { groups, signalled };
  }

  it("sends NO group signal when the leader identity cannot be captured (unknown)", async () => {
    // Identity is unreadable for every pid -> captureLeader returns `unknown` ->
    // no directGroupHandle -> the belt has nothing it may safely signal.
    const identity: ProcessIdentityReader = {
      read: (pid) => ({ status: "unknown", pid, platform: "linux", reason: "io_error" }),
      self: () => ({ status: "missing", pid: 1, platform: "linux" }),
    };
    const { groups, signalled } = spyGroupService(identity);
    const ac = new AbortController();
    for await (const ev of spawnProcess(process.execPath, ["-e", selfExitChild], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 20,
      processGroups: groups,
      reap: async () => ({ state: "confirmed", pgids: [] }),
    })) {
      if (ev.type === "stdout" && ev.line === "ready") ac.abort();
    }
    expect(signalled).toEqual([]);
  });

  it("refuses to signal when the leader identity CHANGED before escalation (PID reuse)", async () => {
    // First observation is the real leader (captured at spawn); every later read
    // is a different process that reused the pid -> compareLeader='different' ->
    // ProcessGroupService.signal returns `stale_leader` WITHOUT signalling.
    let reads = 0;
    const identity: ProcessIdentityReader = {
      read: (pid): ProcessIdentity => {
        reads += 1;
        return {
          status: "known",
          pid,
          platform: "linux",
          source: "procfs_stat",
          startToken: reads <= 1 ? "linux:leader" : "linux:reused",
          processGroupId: pid,
        };
      },
      self: () => ({ status: "missing", pid: 1, platform: "linux" }),
    };
    const { groups, signalled } = spyGroupService(identity);
    const ac = new AbortController();
    for await (const ev of spawnProcess(process.execPath, ["-e", selfExitChild], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 20,
      processGroups: groups,
      reap: async () => ({ state: "confirmed", pgids: [] }),
    })) {
      if (ev.type === "stdout" && ev.line === "ready") ac.abort();
    }
    // The capture at spawn succeeded, but neither the cooperative nudge nor the
    // delayed SIGKILL fallback signalled the (now-recycled) group.
    expect(signalled).toEqual([]);
    expect(reads).toBeGreaterThan(1); // proves the belt DID attempt (and was refused)
  });

  it("runCaptureRaw signals its group only through the identity-verified handle", async () => {
    // Round-4 #1 residue: capture children must never get a raw kill(-pid)
    // either. With a spy service the timeout SIGKILL must ride the handle;
    // with an unknown identity no group signal may be emitted at all.
    const identity: ProcessIdentityReader = {
      read: (pid): ProcessIdentity => ({
        status: "known",
        pid,
        platform: "linux",
        source: "procfs_stat",
        startToken: "linux:capture-leader",
        processGroupId: pid,
      }),
      self: () => ({ status: "missing", pid: 1, platform: "linux" }),
    };
    const { groups, signalled } = spyGroupService(identity);
    // The spy service records but does not really signal, so the child ends by
    // its own 800ms timer; the assertion is purely "which channel was used".
    const result = await runCaptureRaw(process.execPath, ["-e", "setTimeout(() => {}, 800)"], {
      timeoutMs: 50,
      processGroups: groups,
    });
    expect(result.code).toBe(0);
    expect(signalled.length).toBeGreaterThan(0);
    expect(signalled.every((s) => s.signal === "SIGKILL")).toBe(true);

    const unknownIdentity: ProcessIdentityReader = {
      read: (pid) => ({ status: "unknown", pid, platform: "linux", reason: "io_error" }),
      self: () => ({ status: "missing", pid: 1, platform: "linux" }),
    };
    const unknownSpy = spyGroupService(unknownIdentity);
    const second = await runCaptureRaw(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      timeoutMs: 50,
      processGroups: unknownSpy.groups,
    });
    // No proven handle -> no group signal; the direct child.kill fallback (an
    // object-pinned signal that cannot hit a recycled PID) still ends the child.
    expect(second.signal).toBe("SIGKILL");
    expect(unknownSpy.signalled).toEqual([]);
  });
});

describe("labelStreams", () => {
  it("returns null when both streams are blank", () => {
    expect(labelStreams("", "  \n")).toBeNull();
  });

  it("labels which stream said what", () => {
    expect(labelStreams("boom", "")).toBe("stderr: boom");
    expect(labelStreams("", "hello")).toBe("stdout: hello");
    expect(labelStreams("boom", "hello")).toBe("stderr: boom | stdout: hello");
  });

  it("runs the transform (redactor) on the FULL stream BEFORE truncation", () => {
    // The secret sits beyond the truncation budget: redact-after-truncate
    // would slice the token into an unrecognizable, partially visible prefix.
    // (Assembled at runtime so the diff itself never carries a key-shaped literal.)
    const secret = ["sk", "live", "0123456789abcdef".repeat(2)].join("-");
    const noisy = "x".repeat(280) + " token=" + secret;
    const out = labelStreams(noisy, "", {
      maxLen: 100,
      transform: (s) => s.replaceAll(secret, "[redacted]"),
    });
    expect(out).not.toContain(["sk", "live"].join("-"));
    expect([...(out ?? "")].length).toBeLessThanOrEqual(100 + "stderr: ".length);
  });

  it("gives each present stream its own budget so one cannot evict the other", () => {
    const out = labelStreams("e".repeat(500), "o".repeat(500), { maxLen: 100 });
    expect(out).toContain("stderr: ");
    expect(out).toContain("| stdout: ");
    expect(out).toContain("ooo");
  });

  it("never splits a surrogate pair at the truncation boundary", () => {
    const out = labelStreams("🙂".repeat(400), "", { maxLen: 301 });
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe("armOrphanExit", () => {
  it("exits when the bridge reparents to pid 1 (dead host) and discloses once", async () => {
    const exits: number[] = [];
    let disclosed = 0;
    let ppid = 777;
    const watchdog = armOrphanExit({
      intervalMs: 5,
      getppid: () => ppid,
      exit: (code) => exits.push(code),
      onOrphaned: () => {
        disclosed += 1;
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(exits).toEqual([]); // live host: never exits
    ppid = 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(exits.length).toBeGreaterThan(0);
    expect(exits[0]).toBe(0);
    expect(disclosed).toBeGreaterThan(0);
    watchdog.stop();
  });

  it("stop() cancels the watchdog", async () => {
    const exits: number[] = [];
    const watchdog = armOrphanExit({
      intervalMs: 5,
      getppid: () => 1,
      exit: (code) => exits.push(code),
    });
    watchdog.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(exits).toEqual([]);
  });
});
