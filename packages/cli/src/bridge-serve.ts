/**
 * Stdio bridge entrypoints (`claudexor mcp serve` / `acp serve`). Both share
 * the orphaned-bridge lifecycle class (W3.5): a dead host does not always
 * close the pipe (grandchildren holding inherited fds, a SIGKILLed host), so
 * a reparent watchdog bounds the bridge's life to its host's.
 */
import { armOrphanExit } from "@claudexor/core";
import { defaultClaudexorTools, serveClaudexorMcp } from "@claudexor/mcp-server";
import { AcpServer, type AcpServerOptions } from "@claudexor/acp-server";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { acpTerminalAuthMethods } from "./acp-auth.js";
import { acpSessionQuery } from "./acp-surface-runner.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";
export { serveBeltBridge } from "./belt-bridge.js";

function armBridgeWatchdog(label: string): void {
  armOrphanExit({
    onOrphaned: () => process.stderr.write(`claudexor ${label}: host process died; exiting\n`),
  });
}

export async function serveMcpBridge(): Promise<number> {
  // SDK-owned protocol core; mutating verbs are daemon-tracked, so a
  // run started from an MCP host is visible/unblockable like a CLI run.
  serveClaudexorMcp({
    version: CLAUDEXOR_VERSION,
    tools: defaultClaudexorTools(mcpSurfaceRunner({ acpSessionQuery })),
    transport: { read: process.stdin, write: process.stdout },
  });
  armBridgeWatchdog("mcp");
  // Serve until stdin closes (the SDK handle owns the transport).
  await new Promise<void>((resolve) => process.stdin.once("close", resolve));
  return 0;
}

/** The ACP server `acp serve` runs: the official SDK projection over the
 * daemon-thread session runner, on any transport (stdio in production). */
export function acpBridgeServer(transport: AcpServerOptions["transport"]): AcpServer {
  return new AcpServer({
    version: CLAUDEXOR_VERSION,
    runner: mcpSurfaceRunner({ acpSessionQuery }),
    transport,
    terminalAuthMethods: acpTerminalAuthMethods(process.platform),
  });
}

export async function serveAcpBridge(): Promise<number> {
  armBridgeWatchdog("acp");
  await acpBridgeServer({ read: process.stdin, write: process.stdout }).serve();
  return 0;
}
