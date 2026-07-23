import { RETRY_COMMAND_SPECS } from "./retry-command-specs.js";
import {
  CLI_FLAGS,
  FROZEN_REVIEW_FLAG_NAMES,
  RUN_FLAGS,
  type CliFlagKind,
} from "./command-flags.js";
export { CLI_FLAGS, type CliFlagKind, type CliFlagSpec } from "./command-flags.js";

export type CliMutability = "read" | "write" | "delivery" | "ops";

export interface CliCommandSpec {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly usageArgs?: string;
  readonly summary: string;
  readonly extraUsageLines?: readonly { readonly text: string; readonly help: string }[];
  readonly flags: readonly string[];
  readonly mutability: CliMutability;
  readonly stability: "stable" | "experimental";
  readonly recovery?: boolean;
  readonly hostFallbackExample?: string;
}

export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    id: "init",
    summary: "Scaffold repo-local config (.claudexor/config.yaml)",
    flags: ["json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "doctor",
    usageArgs: "[--harness <id>] [--all]",
    summary: "Detect + conformance-test harnesses",
    flags: ["harness", "all", "json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "project",
    usageArgs: "list | register <root> | relink <id> <root> | outputs <id> [path]",
    summary: "Manage the durable v2 project registry",
    flags: ["json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "ask",
    usageArgs: '"<question>" [opts]',
    summary:
      "Read-only answer/explanation route (--deep-scan widens to a multi-scout research sweep)",
    flags: [...RUN_FLAGS, "deep-scan"],
    mutability: "read",
    stability: "stable",
    hostFallbackExample: 'claudexor ask "..."',
  },
  {
    id: "agent",
    usageArgs: '"<prompt>" [opts]',
    summary: "Run a task (default mode: agent)",
    flags: [...RUN_FLAGS, "mode"],
    mutability: "write",
    stability: "stable",
    hostFallbackExample: 'claudexor agent "..."',
  },
  {
    id: "best-of",
    usageArgs: '"<prompt>" [--n N]',
    summary: "Best-of-N run (agent --n) with cross-family review",
    flags: [...RUN_FLAGS],
    mutability: "write",
    stability: "stable",
    hostFallbackExample: 'claudexor best-of "..." --n 4',
  },
  {
    id: "plan",
    usageArgs: '"<prompt>" [--council [--n 2..4]]',
    summary: "Read-only planning report (--council: multi-harness drafts merged into one plan)",
    flags: [...RUN_FLAGS],
    mutability: "read",
    stability: "stable",
    hostFallbackExample: 'claudexor plan "..."',
  },
  {
    id: "create",
    usageArgs: '"<prompt>"',
    summary: "Create-from-scratch (agent --create)",
    flags: [...RUN_FLAGS],
    mutability: "write",
    stability: "stable",
  },
  {
    id: "review",
    usageArgs: "--diff <file> | --evidence-dir <path> --artifacts-dir <path> ...",
    summary: "Reviewer-panel review of a diff or sealed frozen packet",
    flags: ["diff", "intent", "tests", ...FROZEN_REVIEW_FLAG_NAMES, "reviewer-panel", "json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "inspect",
    usageArgs: "<run_id>",
    summary: "Inspect a run's decision + artifacts",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
    recovery: true,
  },
  {
    id: "follow",
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
    usageArgs: "<run_id> [--mode ...]",
    summary: "Apply a run's WorkProduct (apply|commit|branch|pr|--dry-run)",
    flags: ["mode", "dry-run", "json"],
    mutability: "delivery",
    stability: "stable",
    recovery: true,
  },
  {
    id: "decision",
    usageArgs: "<run_id> <action>",
    summary:
      'Decide a blocked run: --accept-risk|--override|--revert|--accept-clean-patch [--apply-mode m]|--rerun --feedback "<text>"',
    flags: [
      "accept-risk",
      "override",
      "revert",
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
  {
    id: "quota",
    usageArgs: "[--json] [--refresh]",
    summary: "Show every vendor-owned quota window with provenance and freshness",
    flags: ["json", "refresh"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "settings",
    usageArgs: "show|set",
    summary: "Show/update user defaults",
    flags: ["json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "trust",
    summary: "Show/update this repo's user-local trust",
    extraUsageLines: [
      { text: "--allow-full-access", help: "Permit access=full (unsandboxed) for this repo" },
      { text: "--revoke-full-access", help: "Revoke the full-access allow" },
      {
        text: "--access-default <profile>",
        help: "readonly|workspace_write default for write modes",
      },
      { text: "--grant-test '<json-argv>'", help: "Grant one exact typed-argv project gate" },
      { text: "--revoke-test <digest>", help: "Revoke an exact project gate grant" },
    ],
    flags: "allow-full-access,revoke-full-access,access-default,grant-test,revoke-test,json".split(
      ",",
    ),
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "auth",
    usageArgs: "status|login",
    summary: "Inspect native harness auth",
    flags: ["all", "json", "browser-redirect"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "secrets",
    usageArgs: "list|set|delete",
    summary: "Manage stored API-key refs (v2 0600 file store)",
    flags: ["from-env", "json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "recovery",
    usageArgs:
      "inspect|validate|export <partition> | quarantine <partition> <fingerprint> quarantine_and_start_fresh",
    summary: "Inspect or recover a durable journal partition",
    flags: ["json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "release",
    usageArgs: "check-name <name> | check | stats",
    summary: "Naming gate, engine runtime update check, and owner-facing install counter",
    flags: ["json"],
    mutability: "read",
    stability: "experimental",
  },
  {
    id: "daemon",
    usageArgs: "start|status|stop|logs|rotate-token",
    summary: "Optional local daemon (claudexord)",
    flags: ["json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "gc",
    usageArgs: "[--dry-run]",
    summary: "Reclaim expired run/review artifact trees (daemon retention pass)",
    flags: ["dry-run", "json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "profiles",
    usageArgs: "[list | add|login|enable|disable|remove <harness> <profile-id>]",
    summary:
      "Credential profiles: registry + doctor readiness, per-profile toggle, and vendor login",
    flags: ["json", "display-name"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "mcp",
    usageArgs: "serve",
    summary: "Expose Claudexor as an MCP server (stdio)",
    flags: [],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "acp",
    usageArgs: "serve",
    summary: "Expose Claudexor as an ACP agent (stdio)",
    flags: [],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "plugin",
    usageArgs: "install|status|doctor|repair|uninstall <host|all>",
    summary: "Manage host integrations (cursor|claude|codex|opencode|all)",
    flags: ["json", "dry-run", "force", "help", "version"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "harness",
    usageArgs: "list [--all]",
    summary: "List real harnesses (--all includes fakes)",
    flags: ["all", "json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "models",
    usageArgs: "[--harness <id>] [--route <local_session|api_key>] [--all]",
    summary:
      "List a harness's enumerable models (raw-api: OpenAI GET /v1/models; --route filters route-annotated manifest models; --all includes fakes)",
    flags: ["harness", "route", "all", "json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "capabilities",
    summary: "Machine-readable capability catalog (harnesses, modes, mutability matrix) for agents",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "help",
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

/** Every flag the CLI accepts anywhere (the unknown-flag preflight set). */
export const KNOWN_FLAGS: ReadonlySet<string> = new Set(CLI_FLAGS.map((f) => f.name));

/** Flags that require a non-empty value. */
export const VALUE_FLAGS: readonly string[] = CLI_FLAGS.filter((f) => f.kind === "value").map(
  (f) => f.name,
);

/** Flags that never consume a following token as a value. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(
  CLI_FLAGS.filter((f) => f.kind === "boolean").map((f) => f.name),
);

export function commandFlagScopeError(
  commandId: string,
  flagNames: readonly string[],
): string | null {
  const cmd = CLI_COMMANDS.find((c) => c.id === commandId || (c.aliases ?? []).includes(commandId));
  if (!cmd) return null;
  const allowed = new Set([...cmd.flags, "json", "help", "version"]);
  const unexpected = flagNames.filter((flag) => !allowed.has(flag));
  if (unexpected.length === 0) return null;
  return `claudexor: flag(s) not valid for the ${cmd.id} command: ${unexpected.map((flag) => `--${flag}`).join(", ")} (see \`claudexor help\`)`;
}

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
