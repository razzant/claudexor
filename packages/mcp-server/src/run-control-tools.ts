import { runTimeLimitTool } from "./run-time-limit-tool.js";
import { runMessageTool } from "./run-message-tool.js";
import { runContinueTool } from "./run-continue-tool.js";
import { deferredMessageTools } from "./deferred-message-tools.js";
import type { McpTool, RunnerFn } from "./index.js";

/** Operator run controls and their addressed receipt reads. The belt owns a
 * separate explicit inventory and never imports this group. */
export function runControlTools(runner: RunnerFn): McpTool[] {
  return [
    runTimeLimitTool(runner),
    runMessageTool(runner),
    runContinueTool(runner),
    ...deferredMessageTools(runner),
  ];
}
