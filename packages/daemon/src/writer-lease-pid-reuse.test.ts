import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  compareProcessBirth,
  executeWin32ProcessTimes,
  ProcessIdentityService,
  type KnownProcessIdentity,
  type ProcessIdentityReader,
} from "@claudexor/core";
import { awaitDaemonTermination } from "./terminate.js";
import {
  acquireDaemonWriterLease,
  inspectDaemonWriterLease,
  writerLeasePath,
  writerLeaseTombstonePath,
  type DaemonLeaseOwner,
} from "./writer-lease.js";

function windowsIdentity(pid: number, token: string): KnownProcessIdentity {
  return {
    status: "known",
    pid,
    platform: "win32",
    source: "win32_process_times",
    startToken: `win32:${token}`,
    processGroupId: pid,
  };
}

interface OwnedChild {
  child: ChildProcess;
  closed: Promise<number | null>;
  stderr(): string;
}

/** Custody of one exact child: its close and spawn failure are observed, its stderr bounded. */
function ownChild(child: ChildProcess): OwnedChild {
  let stderr = "";
  child.stderr?.on("data", (part) => (stderr = `${stderr}${String(part)}`.slice(-16_384)));
  const closed = new Promise<number | null>((done) => {
    child.once("error", (error) => {
      stderr += `spawn failed: ${error.message}\n`;
      done(null);
    });
    child.once("close", (code) => done(code));
  });
  return { child, closed, stderr: () => stderr };
}

/** Exact bytes of every file at or below `path`. A failed read is named, never thrown. */
function filesBelow(path: string): string[] {
  try {
    if (!statSync(path).isDirectory()) return [`--- ${path}\n${readFileSync(path, "utf8")}`];
    const names = readdirSync(path).sort();
    if (names.length === 0) return [`--- ${path} (empty directory)`];
    return names.flatMap((name) => filesBelow(join(path, name)));
  } catch (error) {
    return [`--- ${path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`];
  }
}

const closesWithin = (owned: OwnedChild, ms: number): Promise<boolean> =>
  Promise.race([owned.closed.then(() => true), delay(ms, false, { ref: false })]);

/** Signals only these exact children, through their own handles. A root is removed only
 * after each of them closed; otherwise it stays, and the failure names it. */
async function releaseRoot(root: string, children: readonly OwnedChild[]): Promise<void> {
  const open: Array<number | undefined> = [];
  for (const owned of children) {
    if (await closesWithin(owned, 0)) continue;
    owned.child.kill();
    if (await closesWithin(owned, 10_000)) continue;
    owned.child.kill("SIGKILL");
    if (!(await closesWithin(owned, 10_000))) open.push(owned.child.pid);
  }
  if (open.length > 0) throw new Error(`kept ${root}: pid ${open.join(", ")} did not close`);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** An unrelated process this test owns; only its answer proves that it kept running. */
function startWitness(): OwnedChild & { answers(): Promise<void> } {
  const owned = ownChild(
    spawn(
      process.execPath,
      ["-e", "process.on('message', (m) => process.send(m)); setInterval(() => {}, 1000);"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true },
    ),
  );
  const { child } = owned;
  const answers = () =>
    new Promise<void>((done, fail) => {
      const nonce = randomUUID();
      const finish = (error?: Error | null) => {
        clearTimeout(timer);
        child.off("message", onMessage);
        if (error) fail(error);
        else done();
      };
      const onMessage = (message: unknown) => {
        if (message === nonce) finish();
      };
      const timer = setTimeout(() => finish(new Error("the witness stopped answering")), 30_000);
      child.on("message", onMessage);
      child.send(nonce, (error) => {
        if (error) finish(error);
      });
    });
  return { ...owned, answers };
}

describe("writer PID reuse", () => {
  it("recovers a recorded Windows identity mismatch without signalling the reused PID", () => {
    const root = mkdtempSync(join(tmpdir(), "cx580-"));
    const socket = join(root, "daemon.sock");
    const path = writerLeasePath(socket);
    const owner = {
      pid: 44,
      token: "recorded",
      identity: windowsIdentity(44, "133000000000000001"),
    };
    mkdirSync(path);
    const bytes = JSON.stringify(owner);
    writeFileSync(join(path, "owner.json"), bytes);
    const identity: ProcessIdentityReader = {
      read: (pid) => windowsIdentity(pid, "133000000000000002"),
      self: () => windowsIdentity(process.pid, "133000000000000003"),
    };
    try {
      expect(inspectDaemonWriterLease(socket, { identity })).toMatchObject({
        status: "owned",
        capability: { status: "proven_stale", reason: "identity_mismatch" },
      });
      const lease = acquireDaemonWriterLease(socket, { identity });
      expect(readFileSync(join(writerLeaseTombstonePath(path, owner), "owner.json"), "utf8")).toBe(
        bytes,
      );
      expect(lease.owner.identity).toEqual(identity.self());
      lease.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not turn legacy file age into identity, including after clock rollback", () => {
    const root = mkdtempSync(join(tmpdir(), "cx580-legacy-"));
    const socket = join(root, "daemon.sock");
    const path = writerLeasePath(socket);
    mkdirSync(path);
    const ownerPath = join(path, "owner.json");
    const bytes = JSON.stringify({ pid: 44, token: "legacy" });
    writeFileSync(ownerPath, bytes);
    utimesSync(ownerPath, 1, 1);
    const future = (BigInt(Date.now() + 86400000) * 10000n + 116444736000000000n).toString();
    const identity: ProcessIdentityReader = {
      read: (pid) => windowsIdentity(pid, future),
      self: () => windowsIdentity(process.pid, future),
    };
    try {
      expect(inspectDaemonWriterLease(socket, { identity })).toMatchObject({
        capability: { status: "capable", reason: "legacy_process_present" },
      });
      expect(() => acquireDaemonWriterLease(socket, { identity })).toThrow(
        /another claudexor daemon/,
      );
      expect(readFileSync(ownerPath, "utf8")).toBe(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps unavailable recorded identity and EPERM conservative", () => {
    const root = mkdtempSync(join(tmpdir(), "cx580-unknown-"));
    const socket = join(root, "daemon.sock");
    const path = writerLeasePath(socket);
    mkdirSync(path);
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({
        pid: 44,
        token: "recorded",
        identity: windowsIdentity(44, "133000000000000001"),
      }),
    );
    const identity: ProcessIdentityReader = {
      read: (pid) => ({ status: "unknown", pid, platform: "win32", reason: "permission_denied" }),
      self: () => ({
        status: "unknown",
        pid: process.pid,
        platform: "win32",
        reason: "permission_denied",
      }),
    };
    const probeProcess = () => {
      throw Object.assign(new Error(), { code: "EPERM" });
    };
    try {
      expect(inspectDaemonWriterLease(socket, { identity, probeProcess })).toMatchObject({
        capability: { status: "unknown" },
      });
      expect(() => acquireDaemonWriterLease(socket, { identity }, { probeProcess })).toThrow(
        /another claudexor daemon/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "records real Windows birth by default and refuses a second writer",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "cx580-native-"));
      const socket = join(root, "daemon.sock");
      const lease = acquireDaemonWriterLease(socket);
      const owned: OwnedChild[] = [];
      let failed = true;
      try {
        expect(lease.owner.identity).toMatchObject({
          status: "known",
          platform: "win32",
          source: "win32_process_times",
          pid: process.pid,
        });
        expect(inspectDaemonWriterLease(socket)).toMatchObject({
          capability: { status: "capable", reason: "identity_match" },
        });
        const script = `import { acquireDaemonWriterLease } from ${JSON.stringify(new URL("../dist/writer-lease.js", import.meta.url).href)}; try { acquireDaemonWriterLease(${JSON.stringify(socket)}); process.exitCode = 2; } catch (error) { if (error.code !== 'daemon_writer_busy') throw error; }`;
        const claimant = ownChild(
          spawn(process.execPath, ["--input-type=module", "-e", script], {
            windowsHide: true,
            stdio: "pipe",
          }),
        );
        owned.push(claimant);
        // It reads its own birth and the owner's, each bounded at 30 seconds.
        const result = await Promise.race([
          claimant.closed,
          delay(90_000, "no close within 90s", { ref: false }),
        ]);
        expect(result, claimant.stderr()).toBe(0);
        const original = readFileSync(join(lease.path, "owner.json"), "utf8");
        const recorded = lease.owner.identity!;
        const stale = {
          ...lease.owner,
          identity: {
            ...recorded,
            startToken: `win32:${BigInt(recorded.startToken.slice(6)) - 1n}`,
          },
        };
        writeFileSync(join(lease.path, "owner.json"), JSON.stringify(stale));
        expect(inspectDaemonWriterLease(socket)).toMatchObject({
          capability: { status: "proven_stale", reason: "identity_mismatch" },
        });
        const replacement = acquireDaemonWriterLease(socket);
        try {
          expect(
            readFileSync(join(writerLeaseTombstonePath(lease.path, stale), "owner.json"), "utf8"),
          ).toBe(JSON.stringify(stale));
          expect(replacement.owner.identity).toEqual(recorded);
          expect(process.kill(process.pid, 0)).toBe(true);
        } finally {
          replacement.release();
          expect(original).toContain(recorded.startToken);
        }
        failed = false;
      } finally {
        // Before release removes the record: a synthetic stale owner shares its pid and token.
        if (failed) console.error(filesBelow(root).join("\n"));
        lease.release();
        await releaseRoot(root, owned);
      }
    },
    180000,
  );

  // Default readers and real processes only. The mismatched record is SYNTHETIC:
  // one seeded digit on a process that really lives. No real PID is recycled, and
  // injected unknown/EPERM stay the labelled seam of the test above.
  it("judges a separate real process by its recorded birth through the default paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx580-witness-"));
    const socket = join(root, "daemon.sock");
    const path = writerLeasePath(socket);
    const reader = new ProcessIdentityService({ runWin32Reader: executeWin32ProcessTimes });
    const witness = startWitness();
    const target = startWitness();
    const birthOf = (pid: number | undefined): KnownProcessIdentity => {
      const birth = reader.read(pid!);
      if (birth.status !== "known") throw new Error(`no birth identity: ${JSON.stringify(birth)}`);
      return birth;
    };
    const seed = (owner: DaemonLeaseOwner): string => {
      rmSync(path, { recursive: true, force: true });
      mkdirSync(path);
      const bytes = JSON.stringify(owner);
      writeFileSync(join(path, "owner.json"), bytes);
      return bytes;
    };
    const held = (bytes: string) => {
      expect(() => acquireDaemonWriterLease(socket)).toThrow(/another claudexor daemon/);
      expect(readFileSync(join(path, "owner.json"), "utf8")).toBe(bytes);
    };
    let failed = true;
    try {
      await witness.answers();
      await target.answers();
      const pid = witness.child.pid!;
      const birth = birthOf(pid);
      if (process.platform === "win32") {
        expect(birth).toMatchObject({ platform: "win32", source: "win32_process_times", pid });
      }
      expect(birthOf(pid)).toEqual(birth);

      const matching = seed({ pid, token: "matching", identity: birth });
      expect(inspectDaemonWriterLease(socket)).toMatchObject({
        capability: { status: "capable", reason: "identity_match" },
      });
      held(matching);

      const legacy = seed({ pid, token: "pid-only" });
      expect(inspectDaemonWriterLease(socket)).toMatchObject({
        capability: { status: "capable", reason: "legacy_process_present" },
      });
      held(legacy);

      const mismatched: DaemonLeaseOwner = {
        pid,
        token: "mismatched",
        identity: {
          ...birth,
          startToken: birth.startToken.replace(/\d$/, (d) => String((Number(d) + 1) % 10)),
        },
      };
      const mismatchedBytes = seed(mismatched);
      expect(inspectDaemonWriterLease(socket)).toMatchObject({
        capability: { status: "proven_stale", reason: "identity_mismatch" },
      });
      // Signal authority and an expired grace window still cannot reach a mismatched birth.
      const spared = await awaitDaemonTermination(socket, {
        expectedOwner: mismatched,
        allowSigkill: true,
        killAfterMs: 0,
        deadlineMs: 120_000,
        requireNoSuccessor: false,
      });
      expect(spared.outcome).toBe("exited");
      expect(spared.detail).toContain("never signalled");
      await witness.answers();
      expect(birthOf(pid)).toEqual(birth);
      const replacement = acquireDaemonWriterLease(socket);
      try {
        expect(
          readFileSync(join(writerLeaseTombstonePath(path, mismatched), "owner.json"), "utf8"),
        ).toBe(mismatchedBytes);
        expect(replacement.owner.pid).toBe(process.pid);
      } finally {
        replacement.release();
      }
      await witness.answers();
      expect(birthOf(pid)).toEqual(birth);

      // Control on a second owned child: the same call does end an exact birth match.
      const targetBirth = birthOf(target.child.pid);
      const exact: DaemonLeaseOwner = {
        pid: target.child.pid!,
        token: "exact",
        identity: targetBirth,
      };
      seed(exact);
      const ended = await awaitDaemonTermination(socket, {
        expectedOwner: exact,
        allowSigkill: true,
        killAfterMs: 0,
        deadlineMs: 120_000,
        requireNoSuccessor: false,
      });
      expect(ended.outcome).toBe("killed");
      expect(await closesWithin(target, 30_000)).toBe(true);
      expect(["missing", "different"]).toContain(
        compareProcessBirth(targetBirth, reader.read(exact.pid)),
      );
      await witness.answers();
      failed = false;
    } finally {
      if (failed) console.error(filesBelow(root).join("\n"));
      await releaseRoot(root, [witness, target]);
    }
  }, 180_000);
});
