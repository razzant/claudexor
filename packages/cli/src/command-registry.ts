import { RETRY_COMMAND_SPECS } from "./retry-command-specs.js";

export type CliFlagKind = "boolean" | "value";

export interface CliFlagSpec {
  readonly name: string;
  readonly kind: CliFlagKind;
  readonly valueHint?: string;
  readonly help: string | null;
}

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

/** Flags shared by every run-shaped verb (they funnel into orchestrate()). */
const RUN_FLAGS: readonly string[] = [
  "harness",
  "primary-harness",
  "n",
  "attempts",
  "until-clean",
  "create",
  "synthesis",
  "test",
  "allow-protected-path",
  "max-usd",
  "max-seconds",
  "deny-path",
  "reviewer-panel",
  "reviewer-model",
  "reviewer-effort",
  "access",
  "web",
  "model",
  "effort",
  "portfolio",
  "routing-goal",
  "in-place",
  "spec",
  "instructions",
  "instructions-file",
  "attach",
  "image",
  "json",
];

const valueFlag = (name: string, valueHint: string, help: string | null): CliFlagSpec => ({
  name,
  kind: "value",
  valueHint,
  help,
});

const booleanFlag = (name: string, help: string | null): CliFlagSpec => ({
  name,
  kind: "boolean",
  help,
});

const FROZEN_REVIEW_FLAGS: readonly CliFlagSpec[] = [
  valueFlag("evidence-dir", "<path>", "Sealed evidence packet directory for a frozen review"),
  valueFlag("artifacts-dir", "<path>", "External reviewer telemetry directory for a frozen review"),
  valueFlag("candidate-sha", "<sha>", "Exact committed candidate SHA for a frozen review"),
  valueFlag("candidate-tree", "<tree>", "Exact candidate tree SHA for a frozen review"),
  valueFlag(
    "packet-manifest-digest",
    "<sha256>",
    "Expected SHA-256 identity of the sealed packet manifest",
  ),
];

const FROZEN_REVIEW_FLAG_NAMES = FROZEN_REVIEW_FLAGS.map((flag) => flag.name);

export const CLI_FLAGS: readonly CliFlagSpec[] = [
  valueFlag("harness", "<id[,id...]>", "Force harness(es)"),
  valueFlag(
    "mode",
    "<mode>",
    "agent verb: ask | plan | audit | agent | orchestrate (strategies are flags, not modes);\n                           apply verb: delivery mode apply | commit | branch | pr",
  ),
  valueFlag("n", "<N>", "Best-of-N width (agent): N isolated candidates + cross-review"),
  valueFlag("synthesis", "<mode>", "Best-of-N synthesis: auto (default, only n>=3)|always|never"),
  valueFlag("attempts", "<N>", "Convergence cap (agent): repair loop up to N attempts"),
  booleanFlag("until-clean", "Convergence (agent): iterate until the review/gates are clean"),
  booleanFlag("swarm", "Research swarm (audit): bounded read-only explorer fan-out"),
  booleanFlag("create", "Create-from-scratch intent (agent)"),
  valueFlag(
    "autonomy",
    "<level>",
    "Orchestrate: how much the orchestrator may act without confirmation:\n                           suggest (default, read-only plan) | auto_safe | auto_full",
  ),
  valueFlag("test", "'<json-argv>'", 'Deterministic gate argv; repeat, e.g. \'["pnpm","test"]\''),
  valueFlag(
    "allow-protected-path",
    "<glob[,glob...]>",
    "Explicitly approve protected gate/test path changes for this run",
  ),
  valueFlag("max-usd", "<amount>", "Hard per-run spend cap (USD)"),
  valueFlag(
    "max-seconds",
    "<n>",
    "Hard wall-clock deadline for the whole run (seconds); on expiry the run is cancelled (wall_clock_exceeded)",
  ),
  valueFlag(
    "deny-path",
    "<glob>",
    "Glob no candidate may touch at all (repeatable); isolated runs only — a violating patch is blocked before delivery",
  ),
  valueFlag("max-tool-calls", "<n>", "Orchestrate executor: cap on plan tool calls"),
  valueFlag("diff", "<file>", "Diff file for the review verb (per-commit gate)"),
  valueFlag("intent", '"<text>"', "Review intent context for the review verb"),
  valueFlag("tests", '"<evidence>"', "Test evidence text for the review verb"),
  ...FROZEN_REVIEW_FLAGS,
  valueFlag(
    "reviewer-panel",
    "<list>",
    'Explicit reviewers, e.g. "claude=claude-opus-4-8:max,cursor=gemini-3.1-pro,cursor=gemini-3.5-flash,cursor=gpt-5.5-extra-high"',
  ),
  valueFlag(
    "reviewer-model",
    "<map>",
    'Per-family reviewer model, e.g. "openai=gpt-4o-mini,anthropic=claude-haiku"',
  ),
  valueFlag("reviewer-effort", "<map>", 'Per-family reviewer effort, e.g. "anthropic=max"'),
  valueFlag(
    "access",
    "<profile>",
    "Access profile: readonly|workspace_write|full|external_sandbox_full|inherit_native",
  ),
  valueFlag("web", "<mode>", "External web/search policy: off|auto|cached|live"),
  valueFlag("model", "<id>", "Model hint forwarded to the selected harness route"),
  valueFlag("effort", "<level>", "Reasoning effort hint: low|medium|high|xhigh|max"),
  valueFlag("primary-harness", "<id>", "Bias single-route modes and first candidate choice"),
  valueFlag("portfolio", "<id>", "Removed in v2; always errors (use --routing-goal)"),
  valueFlag("routing-goal", "<goal>", "Routing goal: auto|quality|economy"),
  booleanFlag("refresh", "Refresh vendor-owned quota sources before reading"),
  booleanFlag(
    "in-place",
    "Run write turns against the live project tree (single-candidate\n                           in-place; best-of-N candidates stay isolated and the winner is adopted)\n                           instead of a throwaway envelope",
  ),
  valueFlag("answers", "<file>", "Answers JSON for claudexor spec (batch mode)"),
  valueFlag("spec", "<spec.json>", "Frozen SpecPack context for agent/best-of/create/convergence"),
  valueFlag(
    "instructions",
    '"<text>"',
    "System-level instructions layered onto task-producing lanes (not reviewers/synthesis)",
  ),
  valueFlag(
    "instructions-file",
    "<file>",
    "Read --instructions from a file (avoids ARG_MAX and ps leakage)",
  ),
  valueFlag("attach", "<path[,path...]>", "Attach file(s) to ask/agent/best-of/plan/audit"),
  valueFlag(
    "image",
    "<path[,path...]>",
    "Attach image file(s) (alias for --attach with image kind)",
  ),
  booleanFlag("json", "Machine-readable JSON output"),
  booleanFlag("all", null),
  booleanFlag("dry-run", "Plugin: show lifecycle actions; apply: check patch without mutating"),
  booleanFlag(
    "force",
    "Reapply verified Claudexor-owned plugin drift; never overwrites unowned files",
  ),
  valueFlag("from-env", "<VAR>", null),
  booleanFlag("allow-full-access", null),
  booleanFlag("revoke-full-access", null),
  valueFlag("access-default", "<profile>", null),
  valueFlag("grant-test", "'<json-argv>'", null),
  valueFlag("revoke-test", "<sha256:digest>", null),
  booleanFlag("accept-risk", null),
  booleanFlag("override", null),
  booleanFlag("revert", null),
  booleanFlag("accept-clean-patch", null),
  booleanFlag("rerun", null),
  valueFlag("apply-mode", "<m>", null),
  valueFlag("feedback", '"<text>"', null),
  booleanFlag("help", "Show this help"),
  booleanFlag("version", "Print the CLI version"),
];

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
    usageArgs: "list | register <absolute-root> | relink <project-id> <absolute-root>",
    summary: "Manage the durable v2 project registry",
    flags: ["json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "ask",
    usageArgs: '"<question>" [opts]',
    summary: "Read-only answer/explanation route",
    flags: [...RUN_FLAGS],
    mutability: "read",
    stability: "stable",
    hostFallbackExample: 'claudexor ask "..."',
  },
  {
    id: "agent",
    usageArgs: '"<prompt>" [opts]',
    summary: "Run a task (default mode: agent)",
    flags: [...RUN_FLAGS, "mode", "swarm", "autonomy", "max-tool-calls"],
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
    usageArgs: '"<prompt>"',
    summary: "Read-only planning report",
    flags: [...RUN_FLAGS],
    mutability: "read",
    stability: "stable",
    hostFallbackExample: 'claudexor plan "..."',
  },
  {
    id: "orchestrate",
    usageArgs: '"<goal>"',
    summary: "Typed orchestration plan over the tool belt",
    flags: [...RUN_FLAGS, "autonomy", "max-tool-calls"],
    mutability: "write",
    stability: "stable",
  },
  {
    id: "spec",
    usageArgs: '"<prompt>" [--answers file]',
    summary: "Multi-harness plan grounding -> quiz -> frozen SpecPack",
    flags: [
      "harness",
      "n",
      "web",
      "effort",
      "max-usd",
      "reviewer-panel",
      "reviewer-model",
      "reviewer-effort",
      "answers",
      "json",
    ],
    mutability: "read",
    stability: "stable",
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
    id: "audit",
    aliases: ["map"],
    summary: "Read-only repo audit / map",
    flags: [...RUN_FLAGS, "swarm"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "explore",
    usageArgs: '"<question>"',
    summary: "Read-only research swarm (audit --swarm)",
    flags: [...RUN_FLAGS],
    mutability: "read",
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
    flags: ["all", "json"],
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
    usageArgs: "check-name <name>",
    summary: "Naming gate (npm/pypi/crates/github)",
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
    usageArgs: "[--harness <id>] [--all]",
    summary:
      "List a harness's enumerable models (raw-api: OpenAI GET /v1/models; --all includes fakes)",
    flags: ["harness", "all", "json"],
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
  { name: "/audit", args: "[prompt]", help: "read-only audit turn" },
  { name: "/best-of", args: "<prompt>", help: "best-of-2 turn (cross-family review)" },
  { name: "/orchestrate", args: "<g>", help: "typed orchestration plan over the tool belt" },
  { name: "/thread", help: "show the current thread (turns + native sessions)" },
  { name: "/new", args: "[title]", help: "start a new thread" },
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

function usageLabel(cmd: CliCommandSpec): string {
  const verb =
    cmd.aliases && cmd.aliases.length > 0 ? `${cmd.id} | ${cmd.aliases.join(" | ")}` : cmd.id;
  return cmd.usageArgs ? `claudexor ${verb} ${cmd.usageArgs}` : `claudexor ${verb}`;
}

function padded(left: string, help: string, column = USAGE_COLUMN): string {
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
