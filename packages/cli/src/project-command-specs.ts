import type { CliCommandSpec } from "./command-registry.js";

/** The `project` registry verbs; only `remove` owns a flag (#333 opt-in). */
export const PROJECT_COMMAND_SPECS: readonly CliCommandSpec[] = [
  {
    id: "project",
    positionalPatterns: [
      { min: 0, max: 0 },
      { prefix: ["list"], min: 1, max: 1 },
      { prefix: ["register"], min: 2, max: 2 },
      { prefix: ["relink"], min: 3, max: 3 },
      { prefix: ["remove"], min: 2, max: 2 },
      { prefix: ["outputs"], min: 2, max: 3 },
    ],
    usageArgs:
      "list | register <root> | relink <id> <root> | remove <id> [--purge-trashed-threads] | outputs <id> [path]",
    summary: "Manage the durable v2 project registry",
    flags: ["purge-trashed-threads", "json"],
    subcommandFlags: {
      list: [],
      register: [],
      relink: [],
      remove: ["purge-trashed-threads"],
      outputs: [],
    },
    mutability: "ops",
    stability: "stable",
  },
];
