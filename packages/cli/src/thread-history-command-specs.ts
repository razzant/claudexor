import type { CliCommandSpec } from "./command-registry.js";
export const THREAD_HISTORY_COMMAND_SPECS: readonly CliCommandSpec[] = [
  {
    id: "thread",
    positionalPatterns: [
      { prefix: ["history"], min: 2, max: 2 },
      { prefix: ["prompt"], min: 3, max: 3 },
      { prefix: ["export"], min: 2, max: 2 },
      { prefix: ["retirement"], min: 2, max: 2 },
    ],
    usageArgs:
      "history <id> [--limit N] [--cursor C | --before ID | --after ID | --around ID] [--json]",
    summary:
      "Read bounded thread history, one complete-prompt part, the thread's exact export, or its retirement state; never starts a daemon",
    flags: [
      "limit",
      "cursor",
      "before",
      "after",
      "around",
      "offset",
      "max-bytes",
      "expected-store-id",
      "out",
      "operation-id",
      "json",
    ],
    subcommandFlags: {
      history: ["limit", "cursor", "before", "after", "around", "expected-store-id", "json"],
      prompt: ["offset", "max-bytes", "expected-store-id", "json"],
      export: ["out", "expected-store-id", "json"],
      retirement: ["operation-id", "expected-store-id", "json"],
    },
    extraUsageLines: [
      {
        text: "claudexor thread prompt <id> <turn-id> [--offset N] [--max-bytes N] --json",
        help: "Read a UTF-8 prompt part (including runless refusals).",
      },
      {
        text: "claudexor thread export <id> --out <dir> [--expected-store-id ID] [--json]",
        help: "Copy the thread's exact closure into a new directory, hashing every byte; exit 1 when partial.",
      },
      {
        text: "claudexor thread retirement <id> [--operation-id ID] [--expected-store-id ID] [--json]",
        help: "Read retirement state and one operation's bound outcome.",
      },
    ],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "thread-retire",
    positionalPatterns: [{ min: 1, max: 1 }],
    usageArgs: "<id> --export <dir> [--operation-id ID] [--json]",
    summary:
      "Purge a thread now if that verified export still matches its finished closure; never starts a daemon",
    flags: ["export", "operation-id", "abandon", "json"],
    extraUsageLines: [
      {
        text: "claudexor thread-retire <id> --abandon --operation-id ID [--json]",
        help: "Settle an unanswered retirement operation so it can never accept.",
      },
    ],
    mutability: "ops",
    stability: "stable",
  },
];
