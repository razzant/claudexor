/**
 * Stdio bridge entrypoints (`claudexor mcp serve` / `acp serve`). Both share
 * the orphaned-bridge lifecycle class (W3.5): a dead host does not always
 * close the pipe (grandchildren holding inherited fds, a SIGKILLed host), so
 * a reparent watchdog bounds the bridge's life to its host's.
 */
import { armOrphanExit } from "@claudexor/core";
import {
  beltClaudexorTools,
  defaultClaudexorTools,
  readDelegationPolicy,
  serveClaudexorMcp,
} from "@claudexor/mcp-server";
import { AcpServer } from "@claudexor/acp-server";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { mcpSurfaceRunner } from "./mcp-runner.js";

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
    tools: defaultClaudexorTools(mcpSurfaceRunner()),
    transport: { read: process.stdin, write: process.stdout },
  });
  armBridgeWatchdog("mcp");
  // Serve until stdin closes (the SDK handle owns the transport).
  await new Promise<void>((resolve) => process.stdin.once("close", resolve));
  return 0;
}

/**
 * Serve the SCOPED delegation belt (D32) over stdio. Injected into a delegate
 * agent run's harness sandbox; it exposes ONLY the six belt tools (ask / plan /
 * isolated run / best-of / status / result) and enforces the depth, sub-run-count
 * and budget policy read from the injected CLAUDEXOR_DELEGATION_* env. The belt
 * crosses the SAME daemon boundary as the public MCP surface (isolated envelope,
 * no thread by construction) — there is no apply/decision/thread/settings tool.
 */
export async function serveBeltBridge(): Promise<number> {
  const policy = readDelegationPolicy(process.env);
  serveClaudexorMcp({
    version: CLAUDEXOR_VERSION,
    tools: beltClaudexorTools(mcpSurfaceRunner(), policy),
    transport: { read: process.stdin, write: process.stdout },
  });
  armBridgeWatchdog("mcp-belt");
  await new Promise<void>((resolve) => process.stdin.once("close", resolve));
  return 0;
}

export async function serveAcpBridge(): Promise<number> {
  armBridgeWatchdog("acp");
  await new AcpServer({
    version: CLAUDEXOR_VERSION,
    runner: mcpSurfaceRunner(),
    transport: { read: process.stdin, write: process.stdout },
  }).serve();
  return 0;
}
