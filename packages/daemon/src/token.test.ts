import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonDir, defaultSocketPath, isWindowsPipePath } from "./token.js";
import { writerLeasePath } from "./writer-lease.js";

/**
 * Platform-parameterized pins for the control-endpoint construction (claim 7):
 * win32 Node IPC rides named pipes (`\\.\pipe\...`), never a Unix-style .sock
 * path, and concurrent daemons with distinct CLAUDEXOR_CONFIG_DIRs (the D30
 * shape) must get distinct endpoints on every platform.
 */

let base: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "claudexor-token-test-"));
  for (const key of ["CLAUDEXOR_CONFIG_DIR", "CLAUDEXOR_DAEMON_SOCK"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.CLAUDEXOR_CONFIG_DIR = base;
  delete process.env.CLAUDEXOR_DAEMON_SOCK;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(base, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("defaultSocketPath", () => {
  it("builds a Unix socket path under the daemon dir on POSIX platforms", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(defaultSocketPath(platform)).toBe(join(daemonDir(), "claudexord.sock"));
    }
  });

  it("builds a \\\\.\\pipe\\ named pipe on win32, never a filesystem .sock path", () => {
    const pipe = defaultSocketPath("win32");
    expect(pipe).toMatch(/^\\\\\.\\pipe\\claudexord-[0-9a-f]{16}$/);
    expect(isWindowsPipePath(pipe)).toBe(true);
    expect(pipe).not.toContain(".sock");
  });

  it("derives distinct pipe names for distinct config dirs (concurrent daemons)", () => {
    const first = defaultSocketPath("win32");
    const other = mkdtempSync(join(tmpdir(), "claudexor-token-test-other-"));
    try {
      process.env.CLAUDEXOR_CONFIG_DIR = other;
      expect(defaultSocketPath("win32")).not.toBe(first);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("is stable for the same config dir", () => {
    expect(defaultSocketPath("win32")).toBe(defaultSocketPath("win32"));
  });

  it("honors the CLAUDEXOR_DAEMON_SOCK override verbatim on every platform", () => {
    process.env.CLAUDEXOR_DAEMON_SOCK = "/custom/endpoint.sock";
    expect(defaultSocketPath("darwin")).toBe("/custom/endpoint.sock");
    expect(defaultSocketPath("win32")).toBe("/custom/endpoint.sock");
  });
});

describe("isWindowsPipePath", () => {
  it("recognizes the \\\\.\\pipe\\ and \\\\?\\pipe\\ namespaces only", () => {
    expect(isWindowsPipePath("\\\\.\\pipe\\claudexord-abc")).toBe(true);
    expect(isWindowsPipePath("\\\\?\\pipe\\claudexord-abc")).toBe(true);
    expect(isWindowsPipePath("/home/op/.claudexor/v3/daemon/claudexord.sock")).toBe(false);
    expect(isWindowsPipePath("C:\\Users\\op\\claudexord.sock")).toBe(false);
  });
});

describe("writerLeasePath", () => {
  it("anchors a socket-file lease next to the socket itself", () => {
    const sock = join(daemonDir(), "claudexord.sock");
    expect(writerLeasePath(sock)).toBe(`${sock}.writer`);
  });

  it("anchors a named-pipe lease in the daemon dir (nothing can live in \\\\.\\pipe\\)", () => {
    const pipe = defaultSocketPath("win32");
    const lease = writerLeasePath(pipe);
    expect(lease.startsWith(daemonDir())).toBe(true);
    expect(lease.endsWith(".writer")).toBe(true);
    expect(isWindowsPipePath(lease)).toBe(false);
  });
});
