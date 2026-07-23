import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_SUBRUNS, delegationEnv } from "@claudexor/mcp-server";
import { defaultSocketPath } from "@claudexor/daemon";
import { DelegationBeltUnavailableError } from "@claudexor/core";
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
 * The ordered `cli.js` candidates that host `mcp serve-belt`, most-preferred
 * first: adjacent to the launching process, then adjacent to THIS module. The
 * belt descriptor is built INSIDE the daemon process, so `process.argv[1]` is
 * `claudexord.js` — the daemon entry, which has NO `mcp serve-belt` subcommand.
 * In npm/dev `dist/`, `cli.js` is a genuine sibling of `claudexord.js`. In the
 * single-file macOS app bundle the daemon is `claudexord.bundle.cjs` in
 * `Contents/Resources` with NO sibling `cli.js` — so BOTH candidates can be
 * absent, and the fallback must not be trusted blindly.
 */
export function beltCliEntryCandidates(argv1: string | undefined = process.argv[1]): string[] {
  const out: string[] = [];
  if (argv1) out.push(join(dirname(argv1), "cli.js"));
  const own = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  if (!out.includes(own)) out.push(own);
  return out;
}

/**
 * Absolute path to the CLI entry (`cli.js`) that hosts `mcp serve-belt`, or
 * `undefined` when NO candidate exists on disk. EVERY candidate — including the
 * module-relative fallback — is existence-validated: a descriptor that points
 * at a missing `cli.js` spawns `node <missing> mcp serve-belt`, which
 * MODULE_NOT_FOUNDs inside the harness; the belt reports `failed`, the harness
 * silently answers from its own native subagent, and the run terminalizes a
 * false success (QA-024). Returning `undefined` lets the descriptor builder
 * refuse TYPED at preflight instead of emitting a dead descriptor.
 *
 * This mirrors the browser launcher's resolution: prefer the entry adjacent to
 * the launching process (survives symlinked / wrapped launches), then fall back
 * to this module's own directory — but never return an unchecked path.
 */
export function resolveCliEntry(argv1: string | undefined = process.argv[1]): string | undefined {
  return beltCliEntryCandidates(argv1).find((candidate) => existsSync(candidate));
}

/**
 * Build the delegation belt MCP-server descriptor injected into a delegate
 * agent run's sandbox (D32). The child harness spawns `node cli.js mcp
 * serve-belt` (which discovers this same daemon and starts bounded isolated
 * sub-runs). The belt process reads its policy from the injected env: depth 0
 * (top-level — the sub-runs it starts carry no belt, so nesting cannot exceed
 * 1), the sub-run cap, and a snapshot of the parent's paid-budget headroom.
 *
 * TYPED PREFLIGHT REFUSAL (QA-024): when no `cli.js` entry exists (the packaged
 * single-file bundle without a sibling CLI), this throws
 * `DelegationBeltUnavailableError` naming the probed paths and the remedy — it
 * never emits a descriptor that would MODULE_NOT_FOUND inside the harness and
 * degrade into a silent native-subagent false success. Packaging shipping a
 * real belt entry is Ф4 territory; until then the honest packaged behavior for
 * `--delegate` is this refusal.
 */
export function buildDelegationBeltDescriptor(
  paidBudget: PaidBudget | undefined,
  cliEntry: string | undefined = resolveCliEntry(),
  discoveryEnv: Record<string, string> = beltDaemonDiscoveryEnv(),
): ExtraMcpServer {
  if (!cliEntry) {
    const probed = beltCliEntryCandidates();
    throw new DelegationBeltUnavailableError(
      `--delegate cannot start the Claudexor delegation belt: no 'cli.js' entry that hosts 'mcp serve-belt' exists (probed: ${
        probed.join(", ") || "<none>"
      }). This is the packaged single-file bundle without a bundled CLI entry — the belt would MODULE_NOT_FOUND inside the harness and silently degrade to a native subagent. Re-run without --delegate, or use an install that ships cli.js next to the daemon.`,
    );
  }
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
