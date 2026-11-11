/**
 * Minimal stdio entry for the scoped delegation belt.
 *
 * Keep this separate from bridge-serve.ts: the packaged daemon self-entry must
 * not initialize the ACP surface merely to expose six belt tools. Starting the
 * server is side-effect-free with respect to daemon state; a tool invocation
 * connects to the already-running parent daemon through the injected discovery
 * env.
 */
import { armOrphanExit } from "@claudexor/core";
import { beltClaudexorTools, readDelegationPolicy, serveClaudexorMcp } from "@claudexor/mcp-server";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { mcpSurfaceRunner } from "./mcp-runner.js";

export async function serveBeltBridge(): Promise<number> {
  const policy = readDelegationPolicy(process.env);
  serveClaudexorMcp({
    version: CLAUDEXOR_VERSION,
    tools: beltClaudexorTools(
      mcpSurfaceRunner({
        requireExistingDaemon: true,
        delegationParentRunId: policy.parentRunId,
        delegationRepoRoot: policy.repoRoot,
        delegationProcessingPreference: policy.processingPreference,
        delegationPromptCacheTtl: policy.promptCacheTtl,
        delegationExecution: { workspaceKind: policy.workspaceKind, scopePaths: policy.scopePaths },
      }),
      policy,
    ),
    transport: { read: process.stdin, write: process.stdout },
  });
  armOrphanExit({
    onOrphaned: () => process.stderr.write("claudexor mcp-belt: host process died; exiting\n"),
  });
  await new Promise<void>((resolve) => process.stdin.once("close", resolve));
  return 0;
}
