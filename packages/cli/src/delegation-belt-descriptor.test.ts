import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegationBeltUnavailableError } from "@claudexor/core";
import {
  beltCliEntryCandidates,
  beltDaemonDiscoveryEnv,
  buildDelegationBeltDescriptor,
  resolveCliEntry,
} from "./delegation-belt-descriptor.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

describe("delegation belt descriptor — serve-belt entry resolution", () => {
  it("points serve-belt at cli.js (the host of the subcommand), NEVER at the daemon entry", () => {
    // Regression for the delegation-belt e2e defect: the descriptor is built
    // inside the daemon, where process.argv[1] is claudexord.js. Spawning
    // `node claudexord.js mcp serve-belt` ignores the args and boots a second
    // daemon (dies on the socket lock) instead of serving the belt MCP, so the
    // harness never sees mcp__claudexor__* tools.
    const dist = reapMk(join(tmpdir(), "cdx-belt-dist-"));
    const daemonEntry = join(dist, "claudexord.js");
    writeFileSync(join(dist, "cli.js"), "// cli entry\n");
    const entry = resolveCliEntry(daemonEntry);
    expect(entry).toBe(join(dist, "cli.js"));
    expect(entry).not.toContain("claudexord.js");
  });

  it("builds a belt descriptor whose args run `<cli.js> mcp serve-belt` under node", () => {
    const dist = reapMk(join(tmpdir(), "cdx-belt-dist2-"));
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
      const root = reapMk(join(tmpdir(), "cdx-belt-root-"));
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

  it("existence-validates the fallback candidate too (never returns an unchecked path)", () => {
    // QA-024 root cause: the old fallback returned this module's own
    // `cli.js` WITHOUT checking it exists. In the packaged single-file bundle
    // neither the daemon-adjacent nor the module-adjacent cli.js is present, so
    // resolution must return undefined — a dead descriptor is worse than none.
    const dist = reapMk(join(tmpdir(), "cdx-belt-empty-"));
    const daemonEntry = join(dist, "claudexord.js");
    // No cli.js written next to the daemon entry; the module-relative fallback
    // (this test file's dir) has no cli.js sibling either.
    expect(resolveCliEntry(daemonEntry)).toBeUndefined();
  });

  it("prefers the daemon-adjacent cli.js when it exists (packaged-adjacent win)", () => {
    const dist = reapMk(join(tmpdir(), "cdx-belt-adj-"));
    const daemonEntry = join(dist, "claudexord.js");
    writeFileSync(join(dist, "cli.js"), "// cli entry\n");
    expect(resolveCliEntry(daemonEntry)).toBe(join(dist, "cli.js"));
    expect(beltCliEntryCandidates(daemonEntry)[0]).toBe(join(dist, "cli.js"));
  });

  it("FAILS TYPED at build when no cli.js candidate exists (packaged bundle refusal, QA-024)", () => {
    const dist = reapMk(join(tmpdir(), "cdx-belt-refuse-"));
    const daemonEntry = join(dist, "claudexord.js");
    // Simulate the packaged bundle: no sibling cli.js resolvable.
    const entry = resolveCliEntry(daemonEntry);
    expect(entry).toBeUndefined();
    let thrown: unknown;
    try {
      buildDelegationBeltDescriptor({ kind: "unlimited" }, entry, {
        CLAUDEXOR_CONFIG_DIR: "/real/root",
        CLAUDEXOR_DAEMON_SOCK: "/real/root/daemon/x.sock",
      });
    } catch (err) {
      thrown = err;
    }
    // A typed refusal, never a descriptor that would MODULE_NOT_FOUND in the harness.
    expect(thrown).toBeInstanceOf(DelegationBeltUnavailableError);
    expect((thrown as Error).message).toContain("cli.js");
    expect((thrown as Error).message).toContain("--delegate");
  });
});
