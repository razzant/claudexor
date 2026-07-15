import type { CliCommandSpec } from "./command-registry.js";

export const RETRY_COMMAND_SPECS: readonly CliCommandSpec[] = [
  {
    id: "retry",
    usageArgs: "<run_id>",
    summary: "Exact Retry with the immutable original request and fresh preflight",
    flags: ["json"],
    mutability: "write",
    stability: "stable",
    recovery: true,
  },
  {
    id: "run-again",
    usageArgs: "<run_id>",
    summary: "Print an editable draft copied from a prior run",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
    recovery: true,
  },
];
