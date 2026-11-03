import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DelegationBeltUnavailableError } from "@claudexor/core";
import {
  beltDaemonDiscoveryEnv,
  buildDelegationBeltDescriptor,
  delegationBeltForRun,
  resolveDaemonEntry,
} from "./delegation-belt-descriptor.js";

const reapDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  reapDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("delegation belt descriptor — exact daemon self-entry", () => {
  it("uses the exact running daemon entry for the belt in dev, npm, and app layouts", () => {
    for (const name of ["claudexord.js", "claudexord-wrapper.js", "claudexord.bundle.cjs"]) {
      const dir = tempDir("cdx-belt-entry-");
      const daemonEntry = join(dir, name);
      writeFileSync(daemonEntry, "// self-dispatching daemon entry\n");
      expect(resolveDaemonEntry(daemonEntry)).toBe(resolve(daemonEntry));

      const descriptor = buildDelegationBeltDescriptor(
        { kind: "unlimited" },
        resolveDaemonEntry(daemonEntry),
        {
          CLAUDEXOR_CONFIG_DIR: "/real/root",
          CLAUDEXOR_DAEMON_SOCK: "/real/root/daemon/x.sock",
        },
      );
      expect(descriptor.name).toBe("claudexor");
      expect(descriptor.required).toBe(true);
      expect(descriptor.command).toBe(process.execPath);
      expect(descriptor.args).toEqual([resolve(daemonEntry), "mcp", "serve-belt"]);
      expect(descriptor.env.CLAUDEXOR_DELEGATION_DEPTH).toBe("0");
      expect(descriptor.env.CLAUDEXOR_DELEGATION_REPO_ROOT).toBe("");
      expect(descriptor.env.CLAUDEXOR_DELEGATION_BUDGET).toContain("unlimited");
      expect(descriptor.env.CLAUDEXOR_CONFIG_DIR).toBe("/real/root");
      expect(descriptor.env.CLAUDEXOR_DAEMON_SOCK).toBe("/real/root/daemon/x.sock");
    }
  });

  it("resolves the parent daemon and marks its child-scoped root override explicit", () => {
    const previousRoot = process.env.CLAUDEXOR_CONFIG_DIR;
    const previousSocket = process.env.CLAUDEXOR_DAEMON_SOCK;
    try {
      const root = tempDir("cdx-belt-root-");
      process.env.CLAUDEXOR_CONFIG_DIR = root;
      delete process.env.CLAUDEXOR_DAEMON_SOCK;
      expect(beltDaemonDiscoveryEnv()).toEqual({
        CLAUDEXOR_CONFIG_DIR: root,
        CLAUDEXOR_DAEMON_SOCK: join(root, "daemon", "claudexord.sock"),
        CLAUDEXOR_ROOT_MODE: "explicit",
      });
    } finally {
      if (previousRoot === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousRoot;
      if (previousSocket === undefined) delete process.env.CLAUDEXOR_DAEMON_SOCK;
      else process.env.CLAUDEXOR_DAEMON_SOCK = previousSocket;
    }
  });

  it("fails typed when the exact running entry is absent instead of guessing cli.js", () => {
    const missing = join(tempDir("cdx-belt-missing-"), "claudexord.bundle.cjs");
    expect(resolveDaemonEntry(missing)).toBeUndefined();
    expect(() =>
      buildDelegationBeltDescriptor({ kind: "unlimited" }, null, {
        CLAUDEXOR_CONFIG_DIR: "/real/root",
        CLAUDEXOR_DAEMON_SOCK: "/real/root/daemon/x.sock",
      }),
    ).toThrow(DelegationBeltUnavailableError);
  });

  it("composes known pre-start absence into an ordinary-Agent null belt", () => {
    const env = {
      CLAUDEXOR_CONFIG_DIR: "/real/root",
      CLAUDEXOR_DAEMON_SOCK: "/real/root/daemon/x.sock",
    };
    expect(delegationBeltForRun(false, { kind: "unlimited" }, null, env)).toBeNull();
    expect(delegationBeltForRun(true, { kind: "unlimited" }, null, env)).toBeNull();
    const entry = join(tempDir("cdx-belt-composition-"), "claudexord.bundle.cjs");
    writeFileSync(entry, "// self-dispatching daemon entry\n");
    expect(delegationBeltForRun(true, { kind: "unlimited" }, entry, env)).toMatchObject({
      name: "claudexor",
      required: true,
      args: [entry, "mcp", "serve-belt"],
    });
  });
});
