import { THREAD_HISTORY_COMMAND_SPECS } from "./thread-history-command-specs.js";
import type { CliCommandSpec } from "./command-registry.js";

export const RUN_OBSERVATION_COMMAND_SPECS: readonly CliCommandSpec[] = [
  ...THREAD_HISTORY_COMMAND_SPECS,
  {
    id: "next-message",
    positionalPatterns: [{ min: 1, max: 1 }],
    usageArgs: "'<DeferredMessageCall JSON>' --json",
    summary:
      "Create, replace or clear one operator-owned deferred message with its idempotency key",
    flags: ["json"],
    mutability: "write",
    stability: "stable",
  },
  {
    id: "next-message-read",
    positionalPatterns: [{ min: 1, max: 1 }],
    usageArgs: "<draft-id> --json",
    summary:
      "Read bounded deferred content and exact predecessor/successor handles without dispatch",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "task-group-runs",
    positionalPatterns: [{ min: 1, max: 1 }],
    usageArgs: "<uuid> [--limit N] [--state S] [--cursor C] [--expected-store-id ID] --json",
    summary:
      "Read one retained task group page in current served generations; never starts a daemon",
    flags: ["limit", "state", "cursor", "expected-store-id", "json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "runs-wait",
    positionalPatterns: [{ min: 0, max: 0 }],
    usageArgs: "--targets-json '<array>' [--wait-ms <ms>] [--json | --json-stream]",
    summary: "Observe attention from 1..1000 existing jobs/runs once; never starts a daemon",
    flags: ["targets-json", "wait-ms", "json", "json-stream"],
    mutability: "read",
    stability: "stable",
  },
];
