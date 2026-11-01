import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type KnownProcessIdentity, type ProcessIdentityReader } from "@claudexor/core";
import {
  acquireDaemonWriterLease,
  inspectDaemonWriterLease,
  writerLeasePath,
  writerLeaseTombstonePath,
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
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          windowsHide: true,
          stdio: "pipe",
        });
        const result = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        expect(result).toBe(0);
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
      } finally {
        lease.release();
        rmSync(root, { recursive: true, force: true });
      }
    },
    120000,
  );
});
