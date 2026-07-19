import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_SUBRUNS, delegationEnv } from "@claudexor/mcp-server";
import { defaultSocketPath } from "@claudexor/daemon";
import { userConfigDir } from "@claudexor/util";
import type { ExtraMcpServer, PaidBudget } from "@claudexor/schema";

/**
 * The daemon-discovery env the belt process needs to reach THIS daemon from
 * inside the harness's scoped HOME. The belt runs as an MCP subprocess of the
 * delegate harness (claude/codex), which remaps HOME to a per-lane scoped dir
 * for credential isolation. Left to default, the belt's `defaultSocketPath()`
 * and token lookup both re-derive under that scoped HOME → a socket/token that
 * does not exist → the belt tries to AUTO-START a fresh daemon there, fails
 * ("daemon did not come up within 30s"), and every belt run tool errors. Pin
 * the belt to the real daemon by injecting the ACTUAL config root (so the token
 * and daemon dir resolve to this daemon's) and the exact socket path — both
 * captured from the live daemon env at descriptor-build time, so this is correct
 * whether or not the daemon itself was launched under an override. These env
 * vars affect ONLY the belt process's own daemon RPC; the sub-run workspaces the
 * belt requests are scoped by this daemon, not by the belt's environment.
 */
export function beltDaemonDiscoveryEnv(): Record<string, string> {
  return {
    CLAUDEXOR_CONFIG_DIR: userConfigDir(),
    CLAUDEXOR_DAEMON_SOCK: defaultSocketPath(),
  };
}

/**
 * Absolute path to the CLI entry (`cli.js`) that hosts `mcp serve-belt`. The
 * belt descriptor is built INSIDE the daemon process, so `process.argv[1]` is
 * `claudexord.js` — the daemon entry, which has NO `mcp serve-belt` subcommand:
 * `node claudexord.js mcp serve-belt` ignores the args and tries to boot a
 * SECOND daemon (which dies on the socket writer lock), so the belt MCP server
 * never registers. That is the delegation-belt e2e defect: a `--delegate`
 * claude/codex run silently saw no `mcp__claudexor__*` tools and answered from
 * its own in-process subagent instead of creating a real Claudexor sub-run.
 *
 * `cli.js` is a sibling of `claudexord.js` in the same `dist/`. This mirrors the
 * browser launcher's resolution: prefer the entry adjacent to the launching
 * process (survives symlinked / wrapped launches), then fall back to this
 * module's own directory.
 */
export function resolveCliEntry(argv1: string | undefined = process.argv[1]): string {
  const adjacent = argv1 ? join(dirname(argv1), "cli.js") : "";
  if (adjacent && existsSync(adjacent)) return adjacent;
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

/**
 * Build the delegation belt MCP-server descriptor injected into a delegate
 * agent run's sandbox (D32). The child harness spawns `node cli.js mcp
 * serve-belt` (which discovers this same daemon and starts bounded isolated
 * sub-runs). The belt process reads its policy from the injected env: depth 0
 * (top-level — the sub-runs it starts carry no belt, so nesting cannot exceed
 * 1), the sub-run cap, and a snapshot of the parent's paid-budget headroom.
 */
export function buildDelegationBeltDescriptor(
  paidBudget: PaidBudget | undefined,
  cliEntry: string = resolveCliEntry(),
  discoveryEnv: Record<string, string> = beltDaemonDiscoveryEnv(),
): ExtraMcpServer {
  return {
    name: "claudexor",
    command: process.execPath,
    args: [cliEntry, "mcp", "serve-belt"],
    env: {
      // Daemon discovery FIRST so the delegation-policy vars can never be
      // clobbered by a discovery key (disjoint namespaces, but explicit).
      ...discoveryEnv,
      ...delegationEnv({
        parentRunId: "",
        depth: 0,
        maxSubRuns: DEFAULT_MAX_SUBRUNS,
        parentBudget: paidBudget ?? { kind: "unlimited" },
      }),
    },
  };
}
