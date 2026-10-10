import { HARNESS_COMMAND_SPECS } from "./harness-command-specs.js";
import { REMOTE_COMMAND_SPECS } from "./remote-command-specs.js";
import { RETRY_COMMAND_SPECS } from "./retry-command-specs.js";
import {
  OPS_COMMAND_SPECS_AFTER_REMOTE,
  OPS_COMMAND_SPECS_BEFORE_REMOTE,
} from "./ops-command-specs.js";
import {
  CLI_FLAGS,
  FROZEN_REVIEW_FLAG_NAMES,
  RUN_FLAGS,
  RUN_FLAGS_BY_MODE,
  type CliFlagKind,
} from "./command-flags.js";
export {
  BOOLEAN_FLAGS,
  CLI_FLAGS,
  KNOWN_FLAGS,
  VALUE_FLAGS,
  type CliFlagKind,
  type CliFlagSpec,
} from "./command-flags.js";

export type CliMutability = "read" | "write" | "delivery" | "ops";

export interface CliPositionalPattern {
  /** Exact leading tokens for action-shaped commands; omitted = any values. */
  readonly prefix?: readonly string[];
  /** Counts exclude the command id itself. */
  readonly min: number;
  /** null = intentionally variadic (run prompts). */
  readonly max: number | null;
}

export interface CliCommandSpec {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly usageArgs?: string;
  readonly positionalPatterns: readonly CliPositionalPattern[];
  readonly summary: string;
  readonly extraUsageLines?: readonly { readonly text: string; readonly help: string }[];
  readonly flags: readonly string[];
  /** Per-subcommand flag ownership for a multi-verb command whose verbs own
   * DISJOINT flags (e.g. `harness list --all` vs `harness install --yes`).
   * `flags` stays the union (the global preflight scope); dispatchers call
   * `subcommandFlagScopeError` (command-scope.ts) so a flag outside its
   * verb's set fails loudly (INV-021) instead of being silently ignored. */
  readonly subcommandFlags?: Readonly<Record<string, readonly string[]>>;
  readonly mutability: CliMutability;
  readonly stability: "stable" | "experimental";
  readonly recovery?: boolean;
  readonly hostFallbackExample?: string;
}

export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    id: "init",
    positionalPatterns: [{ min: 0, max: 0 }],
    summary: "Scaffold repo-local config (.claudexor/config.yaml)",
    flags: ["json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "doctor",
    positionalPatterns: [{ min: 0, max: 0 }],
    usageArgs: "[--harness <id>] [--all]",
    summary: "Detect + conformance-test harnesses",
    flags: ["harness", "all", "json"],
    mutability: "read",
    stability: "stable",
  },
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
    usageArgs: "list | register <root> | relink <id> <root> | remove <id> | outputs <id> [path]",
    summary: "Manage the durable v2 project registry",
    flags: ["json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "ask",
    positionalPatterns: [{ min: 0, max: null }],
    usageArgs: '"<question>" [opts]',
    summary:
      "Read-only answer/explanation route (--deep-scan widens to a multi-scout research sweep)",
    flags: [...RUN_FLAGS_BY_MODE.ask],
    mutability: "read",
    stability: "stable",
    hostFallbackExample: 'claudexor ask "..."',
  },
  {
    id: "agent",
    positionalPatterns: [{ min: 0, max: null }],
    usageArgs: '"<prompt>" [opts]',
    summary: "Run a task (default mode: agent; internal model review is opt-in)",
    flags: [...RUN_FLAGS, "mode"],
    mutability: "write",
    stability: "stable",
    hostFallbackExample: 'claudexor agent "..."',
  },
  {
    id: "best-of",
    positionalPatterns: [{ min: 0, max: null }],
    usageArgs: '"<prompt>" [--n N]',
    summary: "Best-of-N run (agent --n) with cross-family review",
    flags: [...RUN_FLAGS_BY_MODE.agent],
    mutability: "write",
    stability: "stable",
    hostFallbackExample: 'claudexor best-of "..." --n 4',
  },
  {
    id: "plan",
    positionalPatterns: [{ min: 0, max: null }],
    usageArgs: '"<prompt>" [--council [--n N]]',
    summary: "Read-only planning report (--council: multi-harness drafts merged into one plan)",
    flags: [...RUN_FLAGS_BY_MODE.plan],
    mutability: "read",
    stability: "stable",
    hostFallbackExample: 'claudexor plan "..."',
  },
  {
    id: "create",
    positionalPatterns: [{ min: 0, max: null }],
    usageArgs: '"<prompt>"',
    summary: "Create-from-scratch (agent --create)",
    flags: [...RUN_FLAGS_BY_MODE.agent],
    mutability: "write",
    stability: "stable",
  },
  {
    id: "review",
    positionalPatterns: [{ min: 0, max: 0 }],
    usageArgs: "--diff <file> | --evidence-dir <path> --artifacts-dir <path> ...",
    summary: "Reviewer-panel review of a diff or sealed frozen packet",
    flags: [
      "diff",
      "intent",
      "tests",
      ...FROZEN_REVIEW_FLAG_NAMES,
      "reviewer-panel",
      "reviewer-panel-json",
      "json",
    ],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "inspect",
    positionalPatterns: [{ min: 1, max: 1 }],
    usageArgs: "<run_id>",
    summary: "Inspect a run's decision + artifacts",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
    recovery: true,
  },
  {
    id: "follow",
    positionalPatterns: [{ min: 1, max: 1 }],
    usageArgs: "<run_id> [--json]",
    summary: "Live-tail a daemon run (replay + push; answer questions in the TTY)",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
    recovery: true,
  },
  ...RETRY_COMMAND_SPECS,
  {
    id: "apply",
    positionalPatterns: [{ min: 1, max: 1 }],
    usageArgs: "<run_id> [--mode ...]",
    summary: "Apply a run's WorkProduct (apply|commit|branch|pr|--dry-run)",
    flags: ["mode", "dry-run", "json"],
    mutability: "delivery",
    stability: "stable",
    recovery: true,
  },
  {
    id: "decision",
    positionalPatterns: [{ min: 1, max: 1 }],
    usageArgs: "<run_id> <action-flags>",
    summary:
      'Record a run decision: --accept-risk|--override|--revert|--discard|--accept-clean-patch [--apply-mode m]|--rerun --feedback "<text>"',
    flags: [
      "accept-risk",
      "override",
      "revert",
      "discard",
      "accept-clean-patch",
      "rerun",
      "apply-mode",
      "feedback",
      "json",
    ],
    mutability: "delivery",
    stability: "stable",
    recovery: true,
  },
  ...OPS_COMMAND_SPECS_BEFORE_REMOTE,
  ...REMOTE_COMMAND_SPECS,
  ...OPS_COMMAND_SPECS_AFTER_REMOTE,
  {
    id: "mcp",
    positionalPatterns: [
      { prefix: ["serve"], min: 1, max: 1 },
      { prefix: ["serve-belt"], min: 1, max: 1 },
    ],
    usageArgs: "serve",
    summary: "Expose Claudexor as an MCP server (stdio)",
    flags: [],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "acp",
    positionalPatterns: [
      { prefix: ["serve"], min: 1, max: 1 },
      { prefix: ["serve", "auth", "login", "codex"], min: 4, max: 4 },
    ],
    usageArgs: "serve [auth login codex]",
    summary: "Expose Claudexor as an ACP agent (stdio; Terminal Auth is experimental)",
    flags: [],
    mutability: "ops",
    stability: "experimental",
  },
  {
    id: "plugin",
    positionalPatterns: [{ min: 2, max: 2 }],
    usageArgs: "install|status|doctor|repair|uninstall <host|all>",
    summary: "Manage host integrations (cursor|claude|codex|opencode|all)",
    flags: ["json", "dry-run", "force", "host-binding-json", "help", "version"],
    mutability: "ops",
    stability: "stable",
  },
  ...HARNESS_COMMAND_SPECS,
  {
    id: "models",
    positionalPatterns: [{ min: 0, max: 0 }],
    usageArgs: "[--harness <id>] [--route <local_session|api_key>] [--all]",
    summary:
      "List a harness's enumerable models (raw-api: OpenAI GET /v1/models; --route filters route-annotated manifest models; --all includes fakes)",
    flags: ["harness", "route", "all", "json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "capabilities",
    positionalPatterns: [{ min: 0, max: 0 }],
    summary: "Machine-readable capability catalog (harnesses, modes, mutability matrix) for agents",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "about",
    positionalPatterns: [{ min: 0, max: 0 }],
    summary: "Product identity: version, author, license, and links",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "help",
    positionalPatterns: [{ min: 0, max: 0 }],
    summary: "Show this help",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
  },
];

/** REPL slash-command vocabulary (second surface, same registry). */
export const REPL_COMMANDS: readonly {
  readonly name: string;
  readonly args?: string;
  readonly help: string;
}[] = [
  { name: "/ask", args: "<q>", help: "read-only answer turn" },
  { name: "/plan", args: "<prompt>", help: "read-only planning turn" },
  { name: "/best-of", args: "<prompt>", help: "best-of-2 turn (cross-family review)" },
  { name: "/thread", help: "show the current thread (turns + native sessions)" },
  { name: "/new", args: "[title]", help: "start a new thread" },
  {
    name: "/harness",
    args: "[id]",
    help: "set the thread's sticky primary harness (no id clears it)",
  },
  {
    name: "/profile",
    args: "[id|default]",
    help: "set the thread's sticky credential profile (default/none clears it)",
  },
  { name: "/help", help: "this help" },
  { name: "/quit", help: "exit" },
];

export function hostFallbackExamples(): readonly string[] {
  const tier = (m: CliMutability): number => (m === "read" ? 0 : 1);
  return CLI_COMMANDS.filter((c) => c.hostFallbackExample)
    .slice()
    .sort((a, b) => tier(a.mutability) - tier(b.mutability))
    .map((c) => c.hostFallbackExample as string);
}

/** Post-run recovery verbs (inspect/follow/apply/decision). */
export function recoveryVerbs(): readonly string[] {
  return CLI_COMMANDS.filter((c) => c.recovery).map((c) => c.id);
}

const USAGE_COLUMN = 42;

export function usageLabel(cmd: CliCommandSpec): string {
  const verb =
    cmd.aliases && cmd.aliases.length > 0 ? `${cmd.id} | ${cmd.aliases.join(" | ")}` : cmd.id;
  return cmd.usageArgs ? `claudexor ${verb} ${cmd.usageArgs}` : `claudexor ${verb}`;
}

export function padded(left: string, help: string, column = USAGE_COLUMN): string {
  const gap = Math.max(column - left.length, 3);
  return `  ${left}${" ".repeat(gap)}${help}`;
}

/** The `claudexor help` text — generated, never hand-edited. */
export function renderHelp(version: string): string {
  const lines: string[] = [];
  lines.push(`claudexor — harness-agnostic AI coding control plane (v${version})`);
  lines.push("");
  lines.push("Usage:");
  for (const cmd of CLI_COMMANDS) {
    lines.push(padded(usageLabel(cmd), cmd.summary));
    for (const extra of cmd.extraUsageLines ?? []) {
      lines.push(padded(`  ${extra.text}`, extra.help));
    }
  }
  lines.push("");
  lines.push("Options:");
  for (const flag of CLI_FLAGS) {
    if (flag.help === null) continue;
    const label =
      flag.kind === "value" ? `--${flag.name} ${flag.valueHint ?? "<value>"}` : `--${flag.name}`;
    lines.push(padded(label, flag.help, 25));
  }
  lines.push("");
  lines.push(
    "First time (or driving Claudexor as an agent)? docs/AGENT_ONBOARDING.md — Install And Login.",
  );
  return lines.join("\n") + "\n";
}

/** The REPL `/help` text — generated from REPL_COMMANDS. */
export function renderReplHelp(): string {
  const lines: string[] = [];
  lines.push("claudexor REPL — a thread of turns over your harnesses");
  lines.push(padded("<text>", "run an agent turn (plan first with /plan if you prefer)", 18));
  for (const c of REPL_COMMANDS) {
    const label = c.args ? `${c.name} ${c.args}` : c.name;
    lines.push(padded(label, c.help, 18));
  }
  lines.push('Turns run "in-place" in the project (or the thread\'s worktree), so each harness');
  lines.push("RESUMES its own native CLI session and the next turn sees the previous turn's");
  lines.push("work. A best-of-N run races candidates in isolated envelopes and auto-applies");
  lines.push("the winner.");
  return lines.join("\n");
}

export interface HelpJson {
  readonly ok: true;
  readonly version: string;
  readonly commands: readonly {
    readonly id: string;
    readonly aliases: readonly string[];
    readonly usage: string;
    readonly positional_patterns: readonly {
      readonly prefix: readonly string[];
      readonly min: number;
      readonly max: number | null;
    }[];
    readonly summary: string;
    readonly flags: readonly string[];
    readonly mutability: CliMutability;
    readonly stability: "stable" | "experimental";
    readonly recovery: boolean;
  }[];
  readonly flags: readonly {
    readonly name: string;
    readonly kind: CliFlagKind;
    readonly value_hint: string | null;
    readonly description: string | null;
  }[];
  readonly repl_commands: readonly {
    readonly name: string;
    readonly args: string | null;
    readonly description: string;
  }[];
}

/** Machine-readable help (`claudexor help --json`). */
export function helpJson(version: string): HelpJson {
  return {
    ok: true,
    version,
    commands: CLI_COMMANDS.map((c) => ({
      id: c.id,
      aliases: c.aliases ?? [],
      usage: usageLabel(c),
      positional_patterns: c.positionalPatterns.map((pattern) => ({
        prefix: pattern.prefix ?? [],
        min: pattern.min,
        max: pattern.max,
      })),
      summary: c.summary,
      flags: c.flags,
      mutability: c.mutability,
      stability: c.stability,
      recovery: c.recovery === true,
    })),
    flags: CLI_FLAGS.map((f) => ({
      name: f.name,
      kind: f.kind,
      value_hint: f.valueHint ?? null,
      description: f.help === null ? null : f.help.replace(/\n\s+/g, " "),
    })),
    repl_commands: REPL_COMMANDS.map((c) => ({
      name: c.name,
      args: c.args ?? null,
      description: c.help,
    })),
  };
}
