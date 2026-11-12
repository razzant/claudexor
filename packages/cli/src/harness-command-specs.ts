/** The public command surface; available programs come from the adapters. */
import type { CliCommandSpec } from "./command-registry.js";

export const HARNESS_USAGE_ARGS =
  "list [--all] | install <id> [--vendor-version <exact>] [--dry-run] [--yes] | inspect [<id>] [--latest] | update <id> [--vendor-version <exact>] [--yes]";

export const HARNESS_COMMAND_SPECS: readonly CliCommandSpec[] = [
  {
    id: "harness",
    positionalPatterns: [
      { prefix: ["list"], min: 1, max: 1 },
      { prefix: ["install"], min: 2, max: 2 },
      { prefix: ["inspect"], min: 1, max: 2 },
      { prefix: ["update"], min: 2, max: 2 },
    ],
    usageArgs: HARNESS_USAGE_ARGS,
    summary:
      "List harnesses, install a missing vendor program, or inspect/update the selected program",
    flags: [
      "all",
      "target",
      "dry-run",
      "yes",
      "latest",
      "vendor-version",
      "release-tested",
      "json",
    ],
    subcommandFlags: {
      list: ["all"],
      install: ["target", "dry-run", "yes", "vendor-version", "release-tested"],
      inspect: ["latest"],
      update: ["vendor-version", "yes"],
    },
    mutability: "ops",
    stability: "stable",
  },
];
