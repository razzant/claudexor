import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beltDaemonDiscoveryEnv,
  buildDelegationBeltDescriptor,
  resolveCliEntry,
} from "./delegation-belt-descriptor.js";

describe("delegation belt descriptor — serve-belt entry resolution", () => {
  it("points serve-belt at cli.js (the host of the subcommand), NEVER at the daemon entry", () => {
    // Regression for the delegation-belt e2e defect: the descriptor is built
    // inside the daemon, where process.argv[1] is claudexord.js. Spawning
    // `node claudexord.js mcp serve-belt` ignores the args and boots a second
    // daemon (dies on the socket lock) instead of serving the belt MCP, so the
    // harness never sees mcp__claudexor__* tools.
    const dist = mkdtempSync(join(tmpdir(), "cdx-belt-dist-"));
    const daemonEntry = join(dist, "claudexord.js");
    writeFileSync(join(dist, "cli.js"), "// cli entry\n");
    const entry = resolveCliEntry(daemonEntry);
    expect(entry).toBe(join(dist, "cli.js"));
    expect(entry).not.toContain("claudexord.js");
  });

  it("builds a belt descriptor whose args run `<cli.js> mcp serve-belt` under node", () => {
    const dist = mkdtempSync(join(tmpdir(), "cdx-belt-dist2-"));
    const daemonEntry = join(dist, "claudexord.js");
    writeFileSync(join(dist, "cli.js"), "// cli entry\n");
    const descriptor = buildDelegationBeltDescriptor(
      { kind: "unlimited" },
      resolveCliEntry(daemonEntry),
      { CLAUDEXOR_CONFIG_DIR: "/real/root", CLAUDEXOR_DAEMON_SOCK: "/real/root/daemon/x.sock" },
    );
    expect(descriptor.name).toBe("claudexor");
    expect(descriptor.command).toBe(process.execPath);
    expect(descriptor.args).toEqual([join(dist, "cli.js"), "mcp", "serve-belt"]);
    // The daemon entry must never be the serve-belt target.
    expect(descriptor.args[0]).not.toContain("claudexord");
    // Delegation env rides so the belt enforces depth/cap/budget.
    expect(descriptor.env.CLAUDEXOR_DELEGATION_DEPTH).toBe("0");
    expect(descriptor.env.CLAUDEXOR_DELEGATION_BUDGET).toContain("unlimited");
    // Daemon-discovery env pins the belt to THIS daemon (so it never tries to
    // auto-start a fresh daemon under the harness's scoped HOME).
    expect(descriptor.env.CLAUDEXOR_CONFIG_DIR).toBe("/real/root");
    expect(descriptor.env.CLAUDEXOR_DAEMON_SOCK).toBe("/real/root/daemon/x.sock");
  });

  it("beltDaemonDiscoveryEnv resolves the real daemon's config root and socket from the live env", () => {
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    const prevSock = process.env.CLAUDEXOR_DAEMON_SOCK;
    try {
      const root = mkdtempSync(join(tmpdir(), "cdx-belt-root-"));
      process.env.CLAUDEXOR_CONFIG_DIR = root;
      delete process.env.CLAUDEXOR_DAEMON_SOCK;
      const env = beltDaemonDiscoveryEnv();
      // CONFIG_DIR override is treated as the complete root; the socket derives
      // from it (daemonDir()/claudexord.sock) so token + socket both resolve here.
      expect(env.CLAUDEXOR_CONFIG_DIR).toBe(root);
      expect(env.CLAUDEXOR_DAEMON_SOCK).toBe(join(root, "daemon", "claudexord.sock"));
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      if (prevSock !== undefined) process.env.CLAUDEXOR_DAEMON_SOCK = prevSock;
    }
  });

  it("falls back to this module's own dist dir when the daemon argv is absent", () => {
    const entry = resolveCliEntry(undefined);
    // Falls back to import.meta.url resolution (dist dir of THIS module).
    expect(entry.endsWith("cli.js")).toBe(true);
  });
});
