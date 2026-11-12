import { COPILOT_PROGRAM } from "./program.js";
import type { VendorCliVersionStamp } from "@claudexor/util";

/** Agent identity stays vendor-specific; the transport is shared. */
export interface AcpEntry {
  id: string;
  program: import("@claudexor/schema").HarnessProgram;
  displayName: string;
  version: VendorCliVersionStamp;
  flags: readonly string[];
  tokenEnv: string;
  homeEnv: string;
  homeDir: string;
  readTools: readonly string[];
  workspaceTools: readonly string[];
  effortLevels: readonly string[];
  modelHints: readonly string[];
  /** Prefix of a single-line first chunk that reports disabled tools: status, not answer. */
  disabledToolsNotice?: string;
}

// Docs-verified 2026-10-03; the version is a fixture reference, not a live conformance claim. --no-remote disables remote control, not network access.
export const copilot: AcpEntry = {
  id: "copilot",
  program: COPILOT_PROGRAM,
  displayName: "GitHub Copilot",
  version: "1.0.91",
  flags: [
    "--acp",
    "--stdio",
    ...(COPILOT_PROGRAM.childUpdateArgs ?? []),
    "--no-ask-user",
    "--no-color",
    "--no-bash-env",
    "--disable-builtin-mcps",
    "--disallow-temp-dir",
    "--no-remote",
  ],
  tokenEnv: "COPILOT_GITHUB_TOKEN",
  homeEnv: "COPILOT_HOME",
  homeDir: ".copilot",
  readTools: ["view", "glob", "grep"],
  workspaceTools: [
    "view",
    "glob",
    "grep",
    "edit",
    "create",
    "apply_patch",
    "bash",
    "read_bash",
    "stop_bash",
    "list_bash",
  ],
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  modelHints: ["claude-sonnet-4.6", "gpt-5.4"],
  disabledToolsNotice: "Info: Disabled tools: ",
};
