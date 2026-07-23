import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostFallbackExamples, recoveryVerbs } from "./command-registry.js";
import { manageClaudeStatusline } from "./claude-statusline.js";
import {
  CLAUDEXOR_VERSION,
  defaultUserConfigDir,
  ensureDir,
  sha256,
  userConfigDir,
  userHomeDir,
  writeJson,
} from "@claudexor/util";

export type PluginHost = "cursor" | "claude" | "codex" | "opencode";
export type PluginTarget = PluginHost | "all";
export type PluginVerb = "install" | "status" | "doctor" | "repair" | "uninstall";
export type PluginInstallState =
  "missing" | "installed" | "registered" | "drifted" | "partial" | "blocked";

export const PLUGIN_HOSTS: PluginHost[] = ["cursor", "claude", "codex", "opencode"];
export const PLUGIN_TARGETS: PluginTarget[] = [...PLUGIN_HOSTS, "all"];
export const PLUGIN_VERBS: PluginVerb[] = ["install", "status", "doctor", "repair", "uninstall"];

const STATE_VERSION = 1;
const MARKER = "claudexor:managed host-plugin-lifecycle";
const MCP_NAME = "claudexor";

interface Artifact {
  path: string;
  content: string;
  description: string;
}

interface RuntimePaths {
  home: string;
  configDir: string;
  nodePath: string;
  cliPath: string;
  backupStamp: string;
  warnings: string[];
}

interface HostDefinition {
  host: PluginHost;
  displayName: string;
  installState: "installed" | "registered";
  root: (home: string) => string;
  artifacts: (home: string, runtime: RuntimePaths) => Artifact[];
  config?: "codex-marketplace" | "opencode-mcp";
  legacy: (home: string) => LegacyTarget[];
  reloadNote: string;
}

interface LegacyTarget {
  path: string;
  root: string;
  expectedFiles: string[];
  verifier: (file: string, text: string) => boolean;
}

interface StateArtifact {
  host: PluginHost;
  path: string;
  hash: string;
  description: string;
  updatedAt: string;
}

interface StateConfigEntry {
  host: PluginHost;
  path: string;
  key: string;
  hash: string;
  updatedAt: string;
}

interface HostState {
  artifacts: Record<string, StateArtifact>;
  configEntries: Record<string, StateConfigEntry>;
  updatedAt: string;
}

interface PluginStateFile {
  version: number;
  hosts: Partial<Record<PluginHost, HostState>>;
}

export interface PluginHostResult {
  host: PluginHost;
  state: PluginInstallState;
  ok: boolean;
  changed: boolean;
  path: string;
  actions: string[];
  notes: string[];
  warnings: string[];
  errors: string[];
}

export interface PluginCommandResult {
  verb: PluginVerb;
  target: PluginTarget;
  dryRun: boolean;
  results: PluginHostResult[];
  ok: boolean;
  exitCode: number;
}

export interface PluginCommandErrorResult {
  verb: string | null;
  target: string | null;
  dryRun: boolean;
  results: [];
  ok: false;
  exitCode: number;
  error: string;
}

export interface PluginCommandOptions {
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
}

function managedComment(kind: "md" | "js" = "md"): string {
  return kind === "js"
    ? `// ${MARKER}; version=${CLAUDEXOR_VERSION}\n`
    : `<!-- ${MARKER}; version=${CLAUDEXOR_VERSION} -->\n`;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function generatedMcpEnv(runtime: RuntimePaths): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDEXOR_MANAGED: MARKER,
    CLAUDEXOR_PLUGIN_VERSION: CLAUDEXOR_VERSION,
  };
  // A DEFAULT-root install serializes NO config root: every generation of the
  // CLI self-selects its own versioned default at serve time, so a stale
  // artifact can never freeze a newer runtime onto an older data root
  // (2026-07-21 incident: a 1.0.0 artifact drove 3.0.2 code against the v1
  // root). An EXPLICIT operator override stays serialized WITH a provenance
  // marker so the serve-time skew check can tell an intentional override from
  // a legacy frozen root.
  if (resolve(runtime.configDir) !== resolve(defaultUserConfigDir())) {
    env.CLAUDEXOR_CONFIG_DIR = runtime.configDir;
    env.CLAUDEXOR_ROOT_MODE = "explicit";
  }
  return env;
}

function mcpServers(runtime: RuntimePaths): Record<string, unknown> {
  return {
    mcpServers: {
      [MCP_NAME]: {
        command: runtime.nodePath,
        args: [runtime.cliPath, "mcp", "serve"],
        env: generatedMcpEnv(runtime),
      },
    },
  };
}

function opencodeMcpEntry(runtime: RuntimePaths): Record<string, unknown> {
  return {
    type: "local",
    command: [runtime.nodePath, runtime.cliPath, "mcp", "serve"],
    environment: generatedMcpEnv(runtime),
    enabled: true,
    timeout: 5000,
  };
}

/** `claudexor inspect <runId>`, `follow <runId>`, ... — from the registry's recovery verbs. */
function recoveryVerbLine(): string {
  const verbs = recoveryVerbs();
  const parts = verbs.map((verb, i) =>
    i === 0 ? `\`claudexor ${verb} <runId>\`` : `\`${verb} <runId>\``,
  );
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`
    : (parts[0] ?? "");
}

/** POSIX single-quote shell quoting so a runtime path containing spaces (or any
 * other shell metacharacter) survives copy-paste into a terminal intact. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The EXECUTABLE absolute CLI prefix, derived from the SAME validated runtime
 * paths the MCP descriptor uses (bundled Node + dist cli.js), shell-quoted.
 * QA-029B: the generated fallback must be a command that actually runs, never a
 * bare `claudexor` that exits 127 because it is not on the user's terminal PATH. */
function absoluteCliPrefix(runtime: RuntimePaths): string {
  return `${shellQuote(runtime.nodePath)} ${shellQuote(runtime.cliPath)}`;
}

/** Render the registry's canonical fallback templates (`claudexor ask "..."`, …)
 * as executable absolute commands by swapping the bare leading `claudexor` token
 * for the absolute Node+CLI prefix (the registry owns the verb/flag grammar; only
 * the prefix is install-specific). The replacement is a FUNCTION, not a string, so
 * a `$` in a nodePath/cliPath isn't read as a `String.replace` `$&`/`$$` pattern. */
function hostFallbackCommands(runtime: RuntimePaths): string[] {
  const prefix = absoluteCliPrefix(runtime);
  return hostFallbackExamples().map((example) => example.replace(/^claudexor\b/, () => prefix));
}

/** The exact Claude slash invocation for the generated skills-directory plugin.
 * Claude Code namespaces plugin skills as `/plugin-name:skill-name`; both the
 * manifest name and the skill name are `claudexor`, so the real command is
 * `/claudexor:claudexor` (QA-029A) — plain `/claudexor` is NOT an alias. */
const CLAUDE_SLASH_COMMAND = "/claudexor:claudexor";

function skillText(host: PluginHost, runtime: RuntimePaths): string {
  return [
    "---",
    "name: claudexor",
    "description: Use Claudexor for harness-agnostic planning, runs, races, and review through its local CLI/MCP bridge.",
    "---",
    managedComment().trimEnd(),
    "# Claudexor",
    "",
    "Use Claudexor when a task benefits from a harness-agnostic control plane, cross-harness review, best-of-N race, or evidence-backed planning.",
    "",
    "Claudexor owns orchestration. This host integration is a bridge to the local CLI and MCP server; it does not add host-local business logic.",
    "",
    "Prefer these routes:",
    "",
    "- MCP tool `claudexor_status` to check available harnesses.",
    "- MCP tool `claudexor_capabilities` for the full machine-readable catalog (harness health, modes, mutability matrix).",
    "- MCP tool `claudexor_ask` for read-only answers (deepScan:true for bounded multi-scout research synthesis).",
    "- MCP tool `claudexor_plan` for read-only implementation plans.",
    "- MCP tool `claudexor_run` for a single agent run.",
    "- MCP tool `claudexor_best_of` for best-of-N attempts.",
    "- MCP tool `claudexor_create` for create-from-scratch runs.",
    "- MCP tools `claudexor_runs` / `claudexor_inspect` / `claudexor_apply_check` to recover a lost run handle (read-only).",
    "",
    "When the host cannot call MCP tools, ask the user to run the local CLI explicitly (these are the exact executable commands for this install — not a bare `claudexor`, which may not be on the terminal PATH):",
    "",
    ...hostFallbackCommands(runtime).map((command) => `\`${command}\``),
    "",
    "MCP support is one-shot and honest: tools return the final Claudexor output, not a live Claudexor thread. Use an explicit `repoPath` when the host cwd may not be the target project.",
    "",
    "Readiness semantics: a harness is usable only when `claudexor_status` reports it `ok` (doctor-backed). An installed binary, a stored key, or an auth file alone is NOT readiness — do not retry a degraded harness expecting different results; surface the doctor reasons instead.",
    "",
    "Setup and login prerequisites (version check, plugin status/repair, and logging in ONLY via `claudexor auth login <harness>` — never a bare vendor login) are the strict sequence in docs/AGENT_ONBOARDING.md (Install And Login).",
    "",
    "Host timeouts: mutating tools can run for many minutes and hosts often cap tool calls. The `runId:` trailer arrives in EVERY result — if the host times out, the run continues daemon-side; recover it with `claudexor_inspect` or the CLI.",
    "",
    `Mutating runs (agent/best-of/create) are daemon-tracked and end with a \`runId:\` trailer — use ${recoveryVerbLine()} for evidence, live progress, delivery, or unblocking a blocked run. Structured results carry \`applyEligibility\`: apply only when \`eligible\` is true; otherwise follow \`requiredAction\`.`,
    "",
    "Safety rules:",
    "",
    "- NEVER paste live credentials into prompts — every ingress hard-blocks secret-like values (typed `inline_secret_rejected`). Store keys with `claudexor secrets set` and reference them.",
    "- NEVER auto-answer `claudexor decision` for a blocked run: risk acceptance (accept-risk/override) is the HUMAN operator's call. Report the blocked state and the decision options.",
    "- Exit codes: 0 = success terminal; 1 = failed/blocked/cancelled run; 2 = usage error (unknown verb/flag/mode). `--json` errors come as `{ok:false, exitCode, error}` on stdout.",
    "",
    // QA-029A: disclose the plugin identity AND the exact slash invocation as two
    // separate typed facts. The old single `Host namespace: claudexor@skills-dir`
    // conflated source identity with the slash command and never told the user the
    // real `/claudexor:claudexor` grammar.
    ...(host === "claude"
      ? [
          "Plugin identity: claudexor@skills-dir",
          `Slash command: ${CLAUDE_SLASH_COMMAND} <request>`,
          `Natural-language activation also works; plain \`/claudexor\` is not an alias — use ${CLAUDE_SLASH_COMMAND}.`,
        ]
      : ["Host namespace: claudexor"]),
    "",
  ].join("\n");
}

function commandText(host: PluginHost, runtime: RuntimePaths): string {
  const frontmatter =
    host === "claude" || host === "cursor" || host === "opencode"
      ? ["---", "description: Use Claudexor CLI/MCP for harness-agnostic coding workflows", "---"]
      : [];
  return [
    ...frontmatter,
    managedComment().trimEnd(),
    "Use Claudexor for this request when cross-harness planning, review, best-of-N race, or evidence-backed execution is useful.",
    "",
    "First prefer the available MCP tools named `claudexor_*`. If MCP tools are unavailable, tell the user the exact executable local CLI command to run (absolute paths for this install — never a bare `claudexor`, which may not be on the terminal PATH), such as:",
    "",
    ...hostFallbackCommands(runtime).map(
      (command) => `- \`${command.replace('"..."', '"$ARGUMENTS"')}\``,
    ),
    "",
    "Do not claim live thread parity through MCP. Ask for an explicit repo path if the target project is ambiguous.",
    "",
    // QA-029A: this command file is only reached AFTER a correct invocation, but
    // it still records the exact grammar so a reader learns the canonical name.
    ...(host === "claude"
      ? [
          `Explicit invocation: \`${CLAUDE_SLASH_COMMAND} <request>\` — natural-language activation also works; plain \`/claudexor\` is not an alias.`,
          "",
        ]
      : []),
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

function readmeText(host: PluginHost, runtime: RuntimePaths): string {
  return [
    managedComment().trimEnd(),
    `# Claudexor ${host} integration`,
    "",
    `This directory is generated by \`claudexor plugin install ${host}\`.`,
    "",
    "It packages Claudexor instructions and MCP configuration for the host. All orchestration remains in the local Claudexor CLI and engine.",
    "",
    // QA-029A/B: state the exact Claude slash command and an executable fallback
    // right where a user reads how to invoke the plugin.
    ...(host === "claude"
      ? [
          `Explicit invocation: \`${CLAUDE_SLASH_COMMAND} <request>\` (natural-language activation also works; plain \`/claudexor\` is not an alias).`,
          "",
          `When MCP tools are denied, run the equivalent executable CLI command directly, e.g. \`${hostFallbackCommands(runtime)[0]}\`.`,
          "",
        ]
      : []),
    "Long-running MCP tools (claudexor_run, claudexor_best_of, claudexor_create) are daemon-tracked: every result carries a `runId:` trailer, so a call abandoned by a host timeout stays recoverable via `claudexor inspect <runId>` / `claudexor follow <runId>`.",
    "",
  ].join("\n");
}

function manifest(kind: "claude" | "codex" | "cursor"): string {
  const description = `Claudexor control plane host integration (${MARKER})`;
  if (kind === "cursor") {
    // Cursor requires literal path ARRAYS for `commands`/`skills`, never glob strings,
    // and `skills` must name the skill DIRECTORY (not its SKILL.md). Glob strings register
    // nothing, which left the plugin loading empty on install. `displayName`/`publisher`
    // are non-schema and dropped; the root `mcp.json` is auto-detected (kept for the test
    // and as the explicit MCP pointer).
    return jsonText({
      name: "claudexor",
      description,
      version: CLAUDEXOR_VERSION,
      author: { name: "Claudexor" },
      commands: ["commands/claudexor.md"],
      skills: ["skills/claudexor"],
      mcpServers: "./mcp.json",
    });
  }
  if (kind === "codex") {
    return jsonText({
      name: "claudexor",
      version: CLAUDEXOR_VERSION,
      description,
      author: { name: "Claudexor" },
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      interface: {
        displayName: "Claudexor",
        shortDescription: "Harness-agnostic coding through the local Claudexor CLI.",
        longDescription:
          "Use Claudexor for local planning, runs, races, and review through generated skills and one-shot MCP tools.",
        developerName: "Claudexor",
        category: "Productivity",
        capabilities: ["Productivity"],
      },
    });
  }
  const base = {
    name: "claudexor",
    version: CLAUDEXOR_VERSION,
    description,
    interface: {
      displayName: "Claudexor",
      description: "Harness-agnostic coding through the local Claudexor CLI and MCP server.",
    },
    claudexor: {
      managed: true,
      marker: MARKER,
      version: CLAUDEXOR_VERSION,
    },
  };
  if (kind === "claude") {
    return jsonText({
      ...base,
      author: { name: "Claudexor" },
    });
  }
  return jsonText(base);
}

function opencodePluginText(runtime: RuntimePaths): string {
  const hint =
    "Use Claudexor MCP tools or run `claudexor plan/agent/best-of` when cross-harness orchestration, review, or evidence-backed execution is useful.";
  return `${managedComment("js")}export const ClaudexorPlugin = async () => {\n  const hint = ${JSON.stringify(hint)};\n  return {\n    \"experimental.chat.system.transform\": async (_input, output) => {\n      if (!output || typeof output !== \"object\") return;\n      const current = typeof output.system === \"string\" ? output.system : typeof output.prompt === \"string\" ? output.prompt : \"\";\n      if (current.includes(\"Claudexor\")) return;\n      if (typeof output.system === \"string\") output.system = output.system + \"\\n\\n\" + hint;\n      else if (typeof output.prompt === \"string\") output.prompt = output.prompt + \"\\n\\n\" + hint;\n    },\n  };\n};\n\nexport default ClaudexorPlugin;\n\n// OpenCode hook note: uses experimental.chat.system.transform because OpenCode does not expose tui.prompt.append as a plugin hook.\n// MCP command: ${runtime.nodePath} ${runtime.cliPath} mcp serve\n`;
}

const HOST_DEFINITIONS: Record<PluginHost, HostDefinition> = {
  claude: {
    host: "claude",
    displayName: "Claude Code",
    installState: "installed",
    root: (home) => join(home, ".claude"),
    artifacts: (home, runtime) => {
      const root = join(home, ".claude", "skills", "claudexor");
      return [
        {
          path: join(root, ".claude-plugin", "plugin.json"),
          content: manifest("claude"),
          description: "Claude plugin manifest",
        },
        {
          path: join(root, "skills", "claudexor", "SKILL.md"),
          content: skillText("claude", runtime),
          description: "Claude skill",
        },
        {
          path: join(root, "commands", "claudexor.md"),
          content: commandText("claude", runtime),
          description: "Claude command",
        },
        {
          path: join(root, ".mcp.json"),
          content: jsonText(mcpServers(runtime)),
          description: "Claude MCP config",
        },
        {
          path: join(root, "README.md"),
          content: readmeText("claude", runtime),
          description: "Claude integration README",
        },
      ];
    },
    legacy: (home) => [
      {
        path: join(home, ".claude", "plugins", "claudexor"),
        root: join(home, ".claude"),
        expectedFiles: [".claude-plugin/plugin.json", "commands/claudexor.md"],
        verifier: legacyThinShimVerifier,
      },
    ],
    reloadNote:
      "Start a new Claude Code session; skills-directory plugins auto-load from ~/.claude/skills. Invoke with `/claudexor:claudexor <request>` (natural-language activation also works; plain `/claudexor` is not an alias).",
  },
  codex: {
    host: "codex",
    displayName: "Codex",
    installState: "registered",
    root: (home) => join(home, ".codex"),
    artifacts: (home, runtime) => {
      const root = join(home, ".codex", "plugins", "claudexor");
      return [
        {
          path: join(root, ".codex-plugin", "plugin.json"),
          content: manifest("codex"),
          description: "Codex plugin manifest",
        },
        {
          path: join(root, "skills", "claudexor", "SKILL.md"),
          content: skillText("codex", runtime),
          description: "Codex skill",
        },
        {
          path: join(root, ".mcp.json"),
          content: jsonText(mcpServers(runtime)),
          description: "Codex MCP config",
        },
        {
          path: join(root, "README.md"),
          content: readmeText("codex", runtime),
          description: "Codex integration README",
        },
      ];
    },
    config: "codex-marketplace",
    legacy: (home) => [
      {
        path: join(home, ".agents", "skills", "claudexor"),
        root: join(home, ".agents"),
        expectedFiles: ["SKILL.md"],
        verifier: legacyCodexSkillVerifier,
      },
    ],
    reloadNote:
      "Restart Codex, open Plugins, choose the personal marketplace, then install/enable Claudexor.",
  },
  cursor: {
    host: "cursor",
    displayName: "Cursor",
    installState: "installed",
    root: (home) => join(home, ".cursor"),
    artifacts: (home, runtime) => {
      const root = join(home, ".cursor", "plugins", "local", "claudexor");
      return [
        {
          path: join(root, ".cursor-plugin", "plugin.json"),
          content: manifest("cursor"),
          description: "Cursor plugin manifest",
        },
        {
          path: join(root, "skills", "claudexor", "SKILL.md"),
          content: skillText("cursor", runtime),
          description: "Cursor skill",
        },
        {
          path: join(root, "commands", "claudexor.md"),
          content: commandText("cursor", runtime),
          description: "Cursor command",
        },
        {
          path: join(root, "mcp.json"),
          content: jsonText(mcpServers(runtime)),
          description: "Cursor MCP config",
        },
        {
          path: join(root, "README.md"),
          content: readmeText("cursor", runtime),
          description: "Cursor integration README",
        },
      ];
    },
    legacy: (home) => [
      {
        path: join(home, ".cursor", "plugins", "local", "claudexor"),
        root: join(home, ".cursor"),
        expectedFiles: [".cursor-plugin/plugin.json", "commands/claudexor.md"],
        verifier: legacyThinShimVerifier,
      },
    ],
    reloadNote:
      "Reload Cursor and enable the local plugin if it is not auto-enabled; Claudexor does not edit Cursor SQLite/binary state.",
  },
  opencode: {
    host: "opencode",
    displayName: "OpenCode",
    installState: "installed",
    root: (home) => join(home, ".config", "opencode"),
    artifacts: (home, runtime) => {
      const root = join(home, ".config", "opencode");
      return [
        {
          path: join(root, "skills", "claudexor", "SKILL.md"),
          content: skillText("opencode", runtime),
          description: "OpenCode skill",
        },
        {
          path: join(root, "commands", "claudexor.md"),
          content: commandText("opencode", runtime),
          description: "OpenCode command",
        },
        {
          path: join(root, "plugins", "claudexor.js"),
          content: opencodePluginText(runtime),
          description: "OpenCode JS plugin",
        },
      ];
    },
    config: "opencode-mcp",
    legacy: (home) => [
      {
        path: join(home, ".config", "opencode", "claudexor"),
        root: join(home, ".config", "opencode"),
        expectedFiles: ["AGENTS.md"],
        verifier: legacyOpenCodeAgentVerifier,
      },
    ],
    reloadNote:
      "Restart OpenCode; global plugins, commands, skills, and MCP config load from ~/.config/opencode. The JS plugin uses OpenCode's experimental.chat.system.transform hook.",
  },
};

function runtimePaths(): RuntimePaths {
  const home = userHomeDir();
  const configDir = userConfigDir();
  const warnings: string[] = [];
  const allowTestOverrides = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const envNode = allowTestOverrides ? process.env.CLAUDEXOR_NODE_PATH?.trim() : undefined;
  const bundledNode = join(home, ".claudexor", "node", "bin", "node");
  const nodePath = envNode || (existsSync(bundledNode) ? bundledNode : process.execPath);
  if (!isAbsolute(nodePath) || !existsSync(nodePath) || !statSync(nodePath).isFile()) {
    throw new Error(`unable to resolve a safe Node executable for plugin MCP config: ${nodePath}`);
  }
  if (!envNode && nodePath !== bundledNode)
    warnings.push(`using current node instead of ${bundledNode}`);
  if (!allowTestOverrides && process.env.CLAUDEXOR_NODE_PATH?.trim())
    warnings.push("ignored CLAUDEXOR_NODE_PATH outside tests");

  const envCli = allowTestOverrides ? process.env.CLAUDEXOR_CLI_PATH?.trim() : undefined;
  const distCli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const argvCli =
    process.argv[1] && existsSync(resolve(process.argv[1])) ? resolve(process.argv[1]) : "";
  const cliPath = envCli || (existsSync(distCli) ? distCli : argvCli);
  if (!cliPath || !isAbsolute(cliPath) || !existsSync(cliPath) || !statSync(cliPath).isFile()) {
    throw new Error("unable to resolve a safe absolute claudexor CLI entrypoint");
  }
  if (!allowTestOverrides && process.env.CLAUDEXOR_CLI_PATH?.trim())
    warnings.push("ignored CLAUDEXOR_CLI_PATH outside tests");
  return { home, configDir, nodePath, cliPath, backupStamp: safeTimestamp(), warnings };
}

function stateFilePath(configDir = userConfigDir()): string {
  return join(configDir, "plugins", "state.json");
}

function emptyState(): PluginStateFile {
  return { version: STATE_VERSION, hosts: {} };
}

function loadState(configDir = userConfigDir()): PluginStateFile {
  const path = stateFilePath(configDir);
  const text = readText(path);
  if (text === null) return emptyState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `plugin state is not valid JSON: ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== STATE_VERSION
  ) {
    throw new Error(`plugin state has unsupported shape: ${path}`);
  }
  const state = parsed as PluginStateFile;
  state.hosts ??= {};
  return state;
}

function saveState(state: PluginStateFile, configDir = userConfigDir()): void {
  writeJsonFile(stateFilePath(configDir), state);
}

function hostState(state: PluginStateFile, host: PluginHost): HostState {
  const existing = state.hosts[host];
  if (existing) {
    existing.artifacts ??= {};
    existing.configEntries ??= {};
    return existing;
  }
  const created = { artifacts: {}, configEntries: {}, updatedAt: new Date().toISOString() };
  state.hosts[host] = created;
  return created;
}

function hashText(text: string): string {
  return sha256(text);
}

function readText(path: string): string | null {
  assertReadableLeaf(path);
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    )
      return null;
    throw new Error(`unable to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readJsonFile(path: string): unknown | undefined {
  const text = readText(path);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${path} is not strict JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function writeFile(path: string, text: string): void {
  ensureSafeWriteParent(path);
  assertSafeLeaf(path);
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
}

function writeJsonFile(path: string, value: unknown): void {
  ensureSafeWriteParent(path);
  assertSafeLeaf(path);
  writeJson(path, value);
}

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`unable to find an existing ancestor for ${path}`);
    current = parent;
  }
  return current;
}

function ensureSafeWriteParent(path: string): void {
  const parent = dirname(path);
  const existing = nearestExistingAncestor(parent);
  const root = findManagingRoot(path);
  if (root) {
    const rootAnchor = existsSync(root) ? root : nearestExistingAncestor(root);
    assertExistingDirectoryChain(rootAnchor, existing, path);
    const realAnchor = realpathSync(rootAnchor);
    const realExisting = realpathSync(existing);
    if (!isPathInside(realAnchor, realExisting)) {
      throw new Error(`${path} resolves outside managed host/config root`);
    }
  } else {
    assertExistingDirectoryChain(existing, existing, path);
  }
  ensureDir(parent);
}

function assertExistingDirectoryChain(anchor: string, existing: string, managedPath: string): void {
  if (!isPathInside(anchor, existing))
    throw new Error(`${managedPath} resolves outside managed host/config root`);
  let current = anchor;
  const rel = relative(anchor, existing);
  for (const part of ["", ...rel.split(/[\\/]/).filter(Boolean)]) {
    if (part) current = join(current, part);
    const st = lstatSync(current);
    if (st.isSymbolicLink()) {
      throw new Error(
        `${current} is a symlink; refusing to create plugin directories through symlinks`,
      );
    }
    if (!st.isDirectory()) throw new Error(`${current} is not a directory`);
  }
}

function assertReadableLeaf(path: string): void {
  try {
    lstatSync(path);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    )
      return;
    throw err;
  }
  const parent = dirname(path);
  const root = findManagingRoot(path);
  if (root) {
    const anchor = existsSync(root) ? root : nearestExistingAncestor(root);
    assertExistingDirectoryChain(anchor, parent, path);
    const realParent = realpathSync(parent);
    const realRoot = realpathSync(root);
    if (!isPathInside(realRoot, realParent))
      throw new Error(`${path} resolves outside managed host/config root`);
  }
  rejectSymlinkPath(path);
  if (!lstatSync(path).isFile()) throw new Error(`${path} is not a regular file`);
}

function rejectSymlinkPath(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    )
      return;
    throw err;
  }
  if (st.isSymbolicLink())
    throw new Error(`${path} is a symlink; refusing to manage plugin files through symlinks`);
}

function assertSafeLeaf(path: string): void {
  const parent = dirname(path);
  const realParent = realpathSync(parent);
  const root = findManagingRoot(path);
  if (root && !isPathInside(realpathSync(root), realParent)) {
    throw new Error(`${path} resolves outside managed host/config root`);
  }
  rejectSymlinkPath(path);
  try {
    const st = lstatSync(path);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    )
      return;
    throw err;
  }
}

function findManagingRoot(path: string): string | null {
  const home = userHomeDir();
  const stateRoot = dirname(stateFilePath());
  if (isPathInside(stateRoot, path)) return stateRoot;
  for (const host of PLUGIN_HOSTS) {
    const root = HOST_DEFINITIONS[host].root(home);
    if (isPathInside(root, path)) return root;
  }
  return isPathInside(home, path) ? home : null;
}

interface TreeEntry {
  rel: string;
  kind: "dir" | "file" | "other";
}

function listTreeEntries(root: string): TreeEntry[] {
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink())
    throw new Error(`${root} is a symlink; refusing recursive plugin cleanup`);
  const out: TreeEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path);
      const st = lstatSync(path);
      if (st.isSymbolicLink())
        throw new Error(`${path} is a symlink; refusing recursive plugin cleanup`);
      if (st.isDirectory()) {
        out.push({ rel, kind: "dir" });
        walk(path);
      } else if (st.isFile()) {
        out.push({ rel, kind: "file" });
      } else {
        out.push({ rel, kind: "other" });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function expectedLegacyDirs(files: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    let dir = dirname(file);
    while (dir && dir !== ".") {
      dirs.add(dir);
      dir = dirname(dir);
    }
  }
  return dirs;
}

function assertLegacyTargetInRoot(target: LegacyTarget): void {
  assertExistingDirectoryChain(target.root, target.path, target.path);
  const root = realpathSync(target.root);
  const path = realpathSync(target.path);
  if (!isPathInside(root, path))
    throw new Error(`${target.path} resolves outside ${target.root}; refusing legacy cleanup`);
}

function isOldThinShimManifest(text: string): boolean {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      keys.join(",") === "description,name,version" &&
      obj.name === "claudexor" &&
      typeof obj.version === "string" &&
      obj.description === "Claudexor control plane (thin shim)"
    );
  } catch {
    return false;
  }
}

const OLD_LEGACY_THIN_SHIM = `Use the local \`claudexor\` CLI for harness-agnostic, evidence-driven coding.
It orchestrates Codex/Claude/Cursor/OpenCode with best-of-n tournaments,
cross-family review, and budget balancing. Prefer it for multi-harness work.

- \`claudexor ask "<question>"\`        read-only answer/explanation
- \`claudexor explore "<question>"\`    read-only exploration/synthesis
- \`claudexor run "<task>"\`            Agent run (native parity + artifacts)
- \`claudexor race "<task>" --n 4\`     Best-of-N tournament + cross-family review
- \`claudexor plan "<task>"\`           read-only plan
- \`claudexor create "<task>"\`         create a new project
- \`claudexor inspect <run_id>\`        inspect artifacts in the external runtime store

These plugins are thin shims: they call the local CLI; all orchestration lives in claudexor.`;

const OLD_LEGACY_CLAUDE_COMMAND = `---
description: Run Claudexor
---
${OLD_LEGACY_THIN_SHIM}
`;

const OLD_LEGACY_CURSOR_COMMAND = `---
name: claudexor
description: Run Claudexor
---
${OLD_LEGACY_THIN_SHIM}
`;

function exactLegacyText(text: string, expected: string): boolean {
  return text === expected || (expected.endsWith("\n") && text === expected.slice(0, -1));
}

function legacyThinShimVerifier(file: string, text: string): boolean {
  if (file.endsWith("plugin.json")) return isOldThinShimManifest(text);
  if (file === "commands/claudexor.md") {
    return (
      exactLegacyText(text, OLD_LEGACY_CLAUDE_COMMAND) ||
      exactLegacyText(text, OLD_LEGACY_CURSOR_COMMAND)
    );
  }
  return false;
}

function legacyCodexSkillVerifier(file: string, text: string): boolean {
  const expected =
    "---\nname: claudexor\ndescription: Harness-agnostic coding via the claudexor CLI\n---\n";
  return file === "SKILL.md" && exactLegacyText(text, expected);
}

function legacyOpenCodeAgentVerifier(file: string, text: string): boolean {
  const expected = "These plugins are thin shims\nHarness-agnostic coding via the claudexor CLI\n";
  return file === "AGENTS.md" && exactLegacyText(text, expected);
}

function isLegacyOwned(target: LegacyTarget): boolean {
  if (!existsSync(target.path)) return false;
  assertLegacyTargetInRoot(target);
  const entries = listTreeEntries(target.path);
  const files = entries.filter((e) => e.kind === "file").map((e) => e.rel);
  if (files.length === 0) return false;
  const expected = new Set(target.expectedFiles);
  const expectedDirs = expectedLegacyDirs(target.expectedFiles);
  if (entries.some((e) => e.kind === "other")) return false;
  if (entries.some((e) => e.kind === "dir" && !expectedDirs.has(e.rel))) return false;
  if (files.length !== expected.size || files.some((f) => !expected.has(f))) return false;
  return files.every((f) => {
    const text = readText(join(target.path, f));
    if (text === null) return false;
    return target.verifier(f, text);
  });
}

function backupRoot(def: HostDefinition, runtime: RuntimePaths): string {
  return join(def.root(runtime.home), ".claudexor-backups", runtime.backupStamp);
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupFile(def: HostDefinition, runtime: RuntimePaths, path: string): string {
  assertSafeLeaf(path);
  const dest = join(backupRoot(def, runtime), relative(runtime.home, path));
  ensureSafeWriteParent(dest);
  assertSafeLeaf(dest);
  copyFileSync(path, dest);
  return dest;
}

function hasManagedMarker(text: string): boolean {
  return (
    text.includes(MARKER) || text.includes('"marker": "claudexor:managed host-plugin-lifecycle"')
  );
}

function artifactOwned(
  state: PluginStateFile,
  host: PluginHost,
  artifact: Artifact,
  current: string,
  force: boolean,
): boolean {
  const entry = state.hosts[host]?.artifacts[artifact.path];
  return (
    entry?.hash === hashText(current) ||
    (entry !== undefined && hasManagedMarker(current)) ||
    current === artifact.content ||
    (force && hasManagedMarker(current))
  );
}

function isPathInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function recordArtifact(state: PluginStateFile, host: PluginHost, artifact: Artifact): void {
  const hs = hostState(state, host);
  hs.artifacts[artifact.path] = {
    host,
    path: artifact.path,
    hash: hashText(artifact.content),
    description: artifact.description,
    updatedAt: new Date().toISOString(),
  };
  hs.updatedAt = new Date().toISOString();
}

function recordConfig(
  state: PluginStateFile,
  host: PluginHost,
  path: string,
  key: string,
  value: unknown,
): void {
  const hs = hostState(state, host);
  hs.configEntries[key] = {
    host,
    path,
    key,
    hash: hashText(jsonText(value)),
    updatedAt: new Date().toISOString(),
  };
  hs.updatedAt = new Date().toISOString();
}

function desiredCodexMarketplaceEntry(): Record<string, unknown> {
  return {
    name: "claudexor",
    source: { source: "local", path: "./.codex/plugins/claudexor" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
    interface: {
      displayName: "Claudexor",
      description: "Harness-agnostic coding through the local Claudexor CLI and MCP server.",
    },
    claudexor: { managed: true, marker: MARKER, version: CLAUDEXOR_VERSION },
  };
}

function validateConfigEntry(
  stateEntry: StateConfigEntry | undefined,
  host: PluginHost,
  path: string,
  key: string,
  res: PluginHostResult,
): boolean {
  if (!stateEntry) return true;
  if (stateEntry.host === host && stateEntry.path === path && stateEntry.key === key) return true;
  res.errors.push(
    `${stateFilePath()} contains out-of-scope ${host} config state for ${key}; remove that state entry or clean it manually`,
  );
  return false;
}

function configEntryOwned(
  stateEntry: StateConfigEntry | undefined,
  current: unknown,
  desired: unknown,
  force: boolean,
  requireState = false,
): boolean {
  if (requireState && !stateEntry) return false;
  const currentText = JSON.stringify(current);
  const hasMarker = currentText.includes(MARKER);
  const exactMarkedDesired = !requireState && hasMarker && jsonText(current) === jsonText(desired);
  return (
    stateEntry?.hash === hashText(jsonText(current)) ||
    exactMarkedDesired ||
    (stateEntry !== undefined && hasMarker) ||
    (force && hasMarker)
  );
}

function codexMarketplaceEntries(plugins: unknown[]): Array<{ index: number; value: unknown }> {
  return plugins
    .map((value, index) => ({ index, value }))
    .filter(
      ({ value }) =>
        value && typeof value === "object" && (value as { name?: unknown }).name === "claudexor",
    );
}

function mergeCodexMarketplace(
  state: PluginStateFile,
  dryRun: boolean,
  force: boolean,
  def: HostDefinition,
  runtime: RuntimePaths,
  res: PluginHostResult,
): boolean {
  const path = join(userHomeDir(), ".agents", "plugins", "marketplace.json");
  const desired = desiredCodexMarketplaceEntry();
  const parsed = readJsonFile(path);
  const base =
    parsed === undefined
      ? { name: "personal", interface: { displayName: "Personal" }, plugins: [] }
      : parsed;
  if (
    !base ||
    typeof base !== "object" ||
    !Array.isArray((base as { plugins?: unknown }).plugins)
  ) {
    res.errors.push(`${path} is not a Codex marketplace JSON object with plugins[]`);
    return false;
  }
  const obj = base as { plugins: unknown[]; [key: string]: unknown };
  const matches = codexMarketplaceEntries(obj.plugins);
  if (matches.length > 0) {
    const stateEntry = state.hosts.codex?.configEntries["codex-marketplace"];
    if (!validateConfigEntry(stateEntry, "codex", path, "codex-marketplace", res)) return false;
    if (matches.some(({ value }) => !configEntryOwned(stateEntry, value, desired, force))) {
      res.errors.push(`${path} already has an unowned claudexor marketplace entry`);
      return false;
    }
    if (matches.length === 1 && jsonText(matches[0]?.value) === jsonText(desired)) {
      recordConfig(state, "codex", path, "codex-marketplace", desired);
      return true;
    }
    const insertAt = matches[0]?.index ?? obj.plugins.length;
    obj.plugins = obj.plugins.filter(
      (p) => !(p && typeof p === "object" && (p as { name?: unknown }).name === "claudexor"),
    );
    obj.plugins.splice(insertAt, 0, desired);
  } else {
    obj.plugins.push(desired);
  }
  if (!dryRun) {
    if (existsSync(path)) {
      const b = backupFile(def, runtime, path);
      res.notes.push(`backed up marketplace to ${b}`);
    }
    writeJsonFile(path, obj);
    recordConfig(state, "codex", path, "codex-marketplace", desired);
  }
  res.changed = true;
  res.actions.push(`${dryRun ? "would update" : "updated"} Codex personal marketplace`);
  return true;
}

function chooseOpenCodeConfigPath(): string {
  const root = join(userHomeDir(), ".config", "opencode");
  const json = join(root, "opencode.json");
  const jsonc = join(root, "opencode.jsonc");
  if (existsSync(json)) return json;
  if (existsSync(jsonc)) return jsonc;
  return json;
}

function openCodeConfigObject(
  path: string,
  parsed: unknown,
  res: PluginHostResult,
): { obj: { mcp?: unknown; [key: string]: unknown }; mcp: Record<string, unknown> } | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    res.errors.push(`${path} is not an OpenCode JSON config object`);
    return null;
  }
  const obj = parsed as { mcp?: unknown; [key: string]: unknown };
  if (obj.mcp === undefined) obj.mcp = {};
  if (!obj.mcp || typeof obj.mcp !== "object" || Array.isArray(obj.mcp)) {
    res.errors.push(`${path} has a non-object mcp field`);
    return null;
  }
  return { obj, mcp: obj.mcp as Record<string, unknown> };
}

function mergeOpenCodeMcp(
  state: PluginStateFile,
  dryRun: boolean,
  force: boolean,
  def: HostDefinition,
  runtime: RuntimePaths,
  res: PluginHostResult,
): boolean {
  const path = chooseOpenCodeConfigPath();
  const desired = opencodeMcpEntry(runtime);
  const parsed = readJsonFile(path);
  const base =
    parsed === undefined ? { $schema: "https://opencode.ai/config.json", mcp: {} } : parsed;
  const validated = openCodeConfigObject(path, base, res);
  if (!validated) return false;
  const { obj, mcp } = validated;
  const current = mcp[MCP_NAME];
  if (current !== undefined) {
    const stateEntry = state.hosts.opencode?.configEntries["opencode-mcp"];
    if (!validateConfigEntry(stateEntry, "opencode", path, "opencode-mcp", res)) return false;
    const owned = configEntryOwned(stateEntry, current, desired, force);
    if (!owned) {
      res.errors.push(`${path} already has an unowned mcp.claudexor entry`);
      return false;
    }
    if (jsonText(current) === jsonText(desired)) {
      recordConfig(state, "opencode", path, "opencode-mcp", desired);
      return true;
    }
  }
  mcp[MCP_NAME] = desired;
  if (!dryRun) {
    if (existsSync(path)) {
      const b = backupFile(def, runtime, path);
      res.notes.push(`backed up OpenCode config to ${b}`);
    }
    writeJsonFile(path, obj);
    recordConfig(state, "opencode", path, "opencode-mcp", desired);
  }
  res.changed = true;
  res.actions.push(`${dryRun ? "would update" : "updated"} OpenCode MCP config`);
  return true;
}

function checkConfig(
  host: PluginHost,
  state: PluginStateFile,
  res: PluginHostResult,
  runtime: RuntimePaths,
): boolean {
  if (host === "codex") {
    const path = join(userHomeDir(), ".agents", "plugins", "marketplace.json");
    const parsed = readJsonFile(path);
    if (parsed === undefined) {
      res.notes.push("Codex personal marketplace is missing");
      return false;
    }
    const desired = desiredCodexMarketplaceEntry();
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !Array.isArray((parsed as { plugins?: unknown }).plugins)
    ) {
      res.errors.push(`${path} is not a Codex marketplace JSON object with plugins[]`);
      return false;
    }
    const plugins = (parsed as { plugins: unknown[] }).plugins;
    const matches = codexMarketplaceEntries(plugins);
    const stateEntry = state.hosts.codex?.configEntries["codex-marketplace"];
    if (!validateConfigEntry(stateEntry, "codex", path, "codex-marketplace", res)) return false;
    if (matches.length === 1 && jsonText(matches[0]?.value) === jsonText(desired)) {
      recordConfig(state, "codex", path, "codex-marketplace", desired);
      return true;
    }
    if (matches.some(({ value }) => !configEntryOwned(stateEntry, value, desired, false))) {
      res.errors.push(`${path} has an unowned claudexor marketplace entry`);
      return false;
    }
    res.notes.push(
      matches.length > 0
        ? "Codex marketplace entry is drifted"
        : "Codex marketplace entry is missing",
    );
    return false;
  }
  if (host === "opencode") {
    const path = chooseOpenCodeConfigPath();
    const parsed = readJsonFile(path);
    if (parsed === undefined) {
      res.notes.push("OpenCode config is missing");
      return false;
    }
    const validated = openCodeConfigObject(path, parsed, res);
    if (!validated) return false;
    const current = validated.mcp[MCP_NAME];
    const desired = opencodeMcpEntry(runtime);
    const stateEntry = state.hosts.opencode?.configEntries["opencode-mcp"];
    if (!validateConfigEntry(stateEntry, "opencode", path, "opencode-mcp", res)) return false;
    if (current !== undefined && !configEntryOwned(stateEntry, current, desired, false)) {
      res.errors.push(`${path} has an unowned mcp.claudexor entry`);
      return false;
    }
    if (jsonText(current) === jsonText(desired)) {
      recordConfig(state, "opencode", path, "opencode-mcp", desired);
      return true;
    }
    res.notes.push(
      current !== undefined ? "OpenCode MCP entry is drifted" : "OpenCode MCP entry is missing",
    );
    return false;
  }
  if (host === "cursor") {
    const ideState = join(userHomeDir(), ".cursor", "ide_state.json");
    if (existsSync(ideState)) {
      try {
        readJsonFile(ideState);
        res.notes.push(
          "Cursor JSON state detected and parseable; no SQLite/binary enablement was touched",
        );
      } catch (err) {
        res.warnings.push(
          `Cursor JSON state was not parseable and was not changed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      res.notes.push(
        "Cursor plugin files are managed directly; no stable JSON registration file was found",
      );
    }
  }
  return true;
}

function removeConfig(
  host: PluginHost,
  state: PluginStateFile,
  dryRun: boolean,
  force: boolean,
  def: HostDefinition,
  runtime: RuntimePaths,
  res: PluginHostResult,
): boolean {
  if (host === "codex") {
    const path = join(userHomeDir(), ".agents", "plugins", "marketplace.json");
    const parsed = readJsonFile(path);
    if (parsed === undefined) return true;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { plugins?: unknown }).plugins)
    ) {
      res.errors.push(`${path} is not a Codex marketplace JSON object with plugins[]`);
      return false;
    }
    const obj = parsed as { plugins: unknown[] };
    const stateEntry = state.hosts.codex?.configEntries["codex-marketplace"];
    if (!validateConfigEntry(stateEntry, "codex", path, "codex-marketplace", res)) return false;
    const matches = codexMarketplaceEntries(obj.plugins);
    if (matches.length === 0) return true;
    if (
      matches.some(
        ({ value }) =>
          !configEntryOwned(stateEntry, value, desiredCodexMarketplaceEntry(), force, true),
      )
    ) {
      res.errors.push(`${path} has an unowned claudexor marketplace entry`);
      return false;
    }
    obj.plugins = obj.plugins.filter(
      (p) => !(p && typeof p === "object" && (p as { name?: unknown }).name === "claudexor"),
    );
    if (!dryRun) {
      const b = backupFile(def, runtime, path);
      res.notes.push(`backed up marketplace to ${b}`);
      writeJsonFile(path, obj);
      delete hostState(state, "codex").configEntries["codex-marketplace"];
    }
    res.changed = true;
    res.actions.push(`${dryRun ? "would remove" : "removed"} Codex marketplace entry`);
  }
  if (host === "opencode") {
    const path = chooseOpenCodeConfigPath();
    const parsed = readJsonFile(path);
    if (parsed === undefined) return true;
    const validated = openCodeConfigObject(path, parsed, res);
    if (!validated) return false;
    const { obj, mcp } = validated;
    const current = mcp[MCP_NAME];
    if (current === undefined) return true;
    const stateEntry = state.hosts.opencode?.configEntries["opencode-mcp"];
    if (!validateConfigEntry(stateEntry, "opencode", path, "opencode-mcp", res)) return false;
    const owned = configEntryOwned(stateEntry, current, opencodeMcpEntry(runtime), force, true);
    if (!owned) {
      res.errors.push(`${path} has an unowned mcp.claudexor entry`);
      return false;
    }
    if (!dryRun) {
      const b = backupFile(def, runtime, path);
      res.notes.push(`backed up OpenCode config to ${b}`);
      delete mcp[MCP_NAME];
      writeJsonFile(path, obj);
      delete hostState(state, "opencode").configEntries["opencode-mcp"];
    }
    res.changed = true;
    res.actions.push(`${dryRun ? "would remove" : "removed"} OpenCode MCP entry`);
  }
  return true;
}

function checkArtifacts(
  def: HostDefinition,
  artifacts: Artifact[],
  state: PluginStateFile,
  res: PluginHostResult,
): { all: boolean; any: boolean; drift: boolean; blocked: boolean } {
  let all = true;
  let any = false;
  let drift = false;
  let blocked = false;
  for (const artifact of artifacts) {
    const current = readText(artifact.path);
    if (current === null) {
      all = false;
      continue;
    }
    any = true;
    if (current === artifact.content) {
      recordArtifact(state, def.host, artifact);
      continue;
    }
    all = false;
    if (artifactOwned(state, def.host, artifact, current, false)) {
      drift = true;
      res.notes.push(`${artifact.description} is drifted`);
    } else {
      blocked = true;
      res.errors.push(`${artifact.path} exists and is not Claudexor-owned`);
    }
  }
  return { all, any, drift, blocked };
}

function applyArtifacts(
  def: HostDefinition,
  artifacts: Artifact[],
  state: PluginStateFile,
  dryRun: boolean,
  force: boolean,
  runtime: RuntimePaths,
  res: PluginHostResult,
): boolean {
  for (const artifact of artifacts) {
    const current = readText(artifact.path);
    if (current === artifact.content) {
      recordArtifact(state, def.host, artifact);
      continue;
    }
    if (current !== null && !artifactOwned(state, def.host, artifact, current, force)) {
      res.errors.push(`${artifact.path} exists and is not Claudexor-owned`);
      return false;
    }
    if (!dryRun) {
      if (current !== null) {
        const b = backupFile(def, runtime, artifact.path);
        res.notes.push(`backed up ${artifact.description} to ${b}`);
      }
      writeFile(artifact.path, artifact.content);
      recordArtifact(state, def.host, artifact);
    }
    res.changed = true;
    res.actions.push(`${dryRun ? "would write" : "wrote"} ${artifact.description}`);
  }
  return true;
}

function obsoleteArtifactRoots(host: PluginHost, home: string): string[] {
  switch (host) {
    case "claude":
      return [
        join(home, ".claude", "skills", "claudexor"),
        join(home, ".claude", "plugins", "claudexor"),
      ];
    case "codex":
      return [
        join(home, ".codex", "plugins", "claudexor"),
        join(home, ".agents", "skills", "claudexor"),
      ];
    case "cursor":
      return [join(home, ".cursor", "plugins", "local", "claudexor")];
    case "opencode":
      return [
        join(home, ".config", "opencode", "skills", "claudexor"),
        join(home, ".config", "opencode", "claudexor"),
      ];
  }
}

function artifactStatePathAllowed(
  def: HostDefinition,
  artifacts: Artifact[],
  path: string,
): boolean {
  if (artifacts.some((a) => a.path === path)) return true;
  return obsoleteArtifactRoots(def.host, userHomeDir()).some((root) => isPathInside(root, path));
}

function removeObsoleteStateArtifacts(
  def: HostDefinition,
  artifacts: Artifact[],
  state: PluginStateFile,
  dryRun: boolean,
  _force: boolean,
  res: PluginHostResult,
): boolean {
  const hs = hostState(state, def.host);
  const allowed = new Set(artifacts.map((a) => a.path));
  for (const [path, entry] of Object.entries(hs.artifacts)) {
    if (
      entry.host !== def.host ||
      entry.path !== path ||
      !artifactStatePathAllowed(def, artifacts, path)
    ) {
      res.errors.push(
        `${stateFilePath()} contains out-of-scope ${def.host} artifact state for ${path}; remove that state entry or clean it manually`,
      );
      return false;
    }
    if (allowed.has(path)) continue;
    const current = readText(path);
    if (current === null) {
      delete hs.artifacts[path];
      continue;
    }
    const owned = entry.hash === hashText(current);
    if (!owned) {
      res.errors.push(
        `${path} is obsolete Claudexor state but no longer matches ownership evidence`,
      );
      return false;
    }
    if (!dryRun) {
      rmSync(path, { force: true });
      delete hs.artifacts[path];
    }
    res.changed = true;
    res.actions.push(`${dryRun ? "would remove" : "removed"} obsolete Claudexor artifact ${path}`);
  }
  return true;
}

function removeArtifacts(
  def: HostDefinition,
  artifacts: Artifact[],
  state: PluginStateFile,
  dryRun: boolean,
  force: boolean,
  res: PluginHostResult,
): boolean {
  if (!removeObsoleteStateArtifacts(def, artifacts, state, dryRun, force, res)) return false;
  const hs = hostState(state, def.host);
  const paths = artifacts.map((a) => a.path).sort((a, b) => b.length - a.length);
  for (const path of paths) {
    const current = readText(path);
    if (current === null) {
      delete hs.artifacts[path];
      continue;
    }
    const desired = artifacts.find((a) => a.path === path);
    const owned =
      hs.artifacts[path]?.hash === hashText(current) ||
      current === desired?.content ||
      (force && hasManagedMarker(current));
    if (!owned) {
      res.errors.push(`${path} exists but no longer matches Claudexor ownership state`);
      return false;
    }
    if (!dryRun) {
      rmSync(path, { force: true });
      delete hs.artifacts[path];
    }
    res.changed = true;
    res.actions.push(`${dryRun ? "would remove" : "removed"} ${path}`);
  }
  pruneEmptyDirs(def.root(userHomeDir()));
  return true;
}

function pruneEmptyDirs(_root: string): void {}

function removeVerifiedLegacy(
  def: HostDefinition,
  dryRun: boolean,
  res: PluginHostResult,
): boolean {
  for (const legacy of def.legacy(userHomeDir())) {
    if (!existsSync(legacy.path)) continue;
    if (isLegacyOwned(legacy)) {
      if (!dryRun) rmSync(legacy.path, { recursive: true, force: true });
      res.changed = true;
      res.actions.push(
        `${dryRun ? "would remove" : "removed"} verified legacy shim ${legacy.path}`,
      );
      continue;
    }
    const entries = listTreeEntries(legacy.path);
    const files = entries.filter((e) => e.kind === "file").map((e) => e.rel);
    const hasModernMarker = files.some((f) => readText(join(legacy.path, f))?.includes(MARKER));
    if (hasModernMarker) continue;
    const hasLegacyShape = files.some((f) => legacy.expectedFiles.includes(f));
    if (hasLegacyShape) {
      res.errors.push(
        `${legacy.path} looks like a legacy Claudexor path but is not verified as old shim content`,
      );
      return false;
    }
  }
  return true;
}

async function mcpSelfTest(runtime: RuntimePaths): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn(runtime.nodePath, [runtime.cliPath, "mcp", "serve"], {
      cwd: process.cwd(),
      env: mcpSelfTestEnv(runtime),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let pending = "";
    const lines: unknown[] = [];
    let stderr = "";
    let sentToolsList = false;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolve("MCP self-test timed out");
    }, 5000);
    child.stdout.on("data", (d) => {
      if (settled) return;
      const chunk = String(d);
      stdout += chunk;
      pending += chunk;
      const frames = pending.split("\n");
      pending = frames.pop() ?? "";
      try {
        for (const frame of frames.filter(Boolean)) lines.push(JSON.parse(frame));
        const init = lines.find(
          (line) => line && typeof line === "object" && (line as { id?: unknown }).id === 1,
        ) as { result?: { serverInfo?: { name?: string } } } | undefined;
        if (init?.result?.serverInfo?.name && !sentToolsList) {
          sentToolsList = true;
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) +
              "\n",
          );
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n",
          );
        }
        const tools = lines.find(
          (line) => line && typeof line === "object" && (line as { id?: unknown }).id === 2,
        ) as { result?: { tools?: unknown } } | undefined;
        if (tools && !settled) {
          settled = true;
          const listed = tools.result?.tools;
          clearTimeout(timer);
          child.kill("SIGTERM");
          if (
            Array.isArray(listed) &&
            listed.some((t: { name?: string }) => t.name === "claudexor_status")
          ) {
            resolve(null);
          } else {
            resolve("MCP self-test returned an unexpected tools-list response");
          }
        }
      } catch (err) {
        if (!settled && stdout.includes("\n")) {
          settled = true;
          clearTimeout(timer);
          child.kill("SIGTERM");
          resolve(
            `MCP self-test response parse failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(`MCP self-test failed to start: ${err.message}`);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!stdout)
        resolve(`MCP self-test exited before response (${code ?? "signal"}): ${stderr.trim()}`);
      else
        resolve(
          `MCP self-test exited before tools-list completed (${code ?? "signal"}): ${stderr.trim()}`,
        );
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "claudexor-plugin-doctor", version: CLAUDEXOR_VERSION },
        },
      }) + "\n",
    );
  });
}

function mcpSelfTestEnv(runtime: RuntimePaths): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "HOME",
    "PATH",
    "CLAUDEXOR_CONFIG_DIR",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  Object.assign(env, generatedMcpEnv(runtime));
  return env;
}

function verbNote(def: HostDefinition, verb: PluginVerb): string {
  if (verb === "uninstall")
    return `${def.displayName} integration removed from managed Claudexor files/config; restart the host to unload cached plugin state.`;
  return def.reloadNote;
}

function initialResult(
  def: HostDefinition,
  verb: PluginVerb,
  runtime: RuntimePaths,
): PluginHostResult {
  return {
    host: def.host,
    state: "missing",
    ok: false,
    changed: false,
    path: def.root(runtime.home),
    actions: [],
    notes: [verbNote(def, verb), ...runtime.warnings],
    warnings: [],
    errors: [],
  };
}

async function runHost(
  def: HostDefinition,
  verb: PluginVerb,
  options: PluginCommandOptions,
  state: PluginStateFile,
  runtime: RuntimePaths,
): Promise<PluginHostResult> {
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const res = initialResult(def, verb, runtime);
  const artifacts = def.artifacts(runtime.home, runtime);

  try {
    if (verb === "status" || verb === "doctor") {
      const art = checkArtifacts(def, artifacts, state, res);
      const configOk =
        checkConfig(def.host, state, res, runtime) &&
        (def.host !== "claude" || manageClaudeStatusline(verb, { ...runtime, dryRun }, res));
      const hasConfig = def.config !== undefined || def.host === "claude";
      if (res.errors.length > 0 || art.blocked) res.state = "blocked";
      else if (art.all && configOk) res.state = def.installState;
      else if (art.drift) res.state = "drifted";
      else if (art.any || (hasConfig && configOk)) res.state = "partial";
      else res.state = "missing";
      if (
        verb === "doctor" &&
        dryRun &&
        (res.state === "installed" || res.state === "registered")
      ) {
        res.actions.push("would run MCP initialize/initialized/tools-list self-test");
      } else if (verb === "doctor" && (res.state === "installed" || res.state === "registered")) {
        const mcpError = await mcpSelfTest(runtime);
        if (mcpError) {
          res.errors.push(mcpError);
          res.state = "blocked";
        } else {
          res.actions.push("MCP initialize/tools-list self-test passed");
        }
      }
      res.ok = res.errors.length === 0 && (res.state === "installed" || res.state === "registered");
      return res;
    }

    if (verb === "uninstall") {
      if (def.host === "claude" && !manageClaudeStatusline(verb, { ...runtime, dryRun }, res)) {
        res.state = "blocked";
        return res;
      }
      if (!removeVerifiedLegacy(def, dryRun, res)) {
        res.state = "blocked";
        return res;
      }
      if (!removeConfig(def.host, state, dryRun, force, def, runtime, res)) {
        res.state = "blocked";
        return res;
      }
      if (!removeArtifacts(def, artifacts, state, dryRun, force, res)) {
        res.state = "blocked";
        return res;
      }
      res.state = "missing";
      res.ok = res.errors.length === 0;
      return res;
    }

    if (!removeVerifiedLegacy(def, dryRun, res)) {
      res.state = "blocked";
      return res;
    }
    if (!removeObsoleteStateArtifacts(def, artifacts, state, dryRun, force, res)) {
      res.state = "blocked";
      return res;
    }
    if (!applyArtifacts(def, artifacts, state, dryRun, force, runtime, res)) {
      res.state = "blocked";
      return res;
    }
    if (
      def.config === "codex-marketplace" &&
      !mergeCodexMarketplace(state, dryRun, force, def, runtime, res)
    ) {
      res.state = "blocked";
      return res;
    }
    if (
      def.config === "opencode-mcp" &&
      !mergeOpenCodeMcp(state, dryRun, force, def, runtime, res)
    ) {
      res.state = "blocked";
      return res;
    }
    if (def.host === "claude" && !manageClaudeStatusline(verb, { ...runtime, dryRun }, res)) {
      res.state = "blocked";
      return res;
    }
    if (def.host === "cursor") checkConfig("cursor", state, res, runtime);
    res.state = def.installState;
    // a dry-run must be legible even when nothing needs doing — otherwise an
    // already-current host prints only its status and reads as if --dry-run was
    // ignored. Disclose that the lifecycle was evaluated and found no changes.
    if (dryRun && res.actions.length === 0) {
      res.actions.push("no changes needed — Claudexor-owned files and config are already current");
    }
    res.ok = res.errors.length === 0;
    return res;
  } catch (err) {
    res.state = "blocked";
    res.errors.push(err instanceof Error ? err.message : String(err));
    return res;
  }
}

function targets(target: PluginTarget): PluginHost[] {
  return target === "all" ? PLUGIN_HOSTS : [target];
}

function exitCodeFor(verb: PluginVerb, result: PluginCommandResult): number {
  // `status` reports, but drift/blocked are actionable problems that must be
  // scriptable: exit 1 so CI/agents can gate on them. Absence states
  // (missing/partial/installed/registered) stay 0 — not-installed is not an error.
  if (verb === "status") {
    return result.results.some((r) => r.state === "drifted" || r.state === "blocked") ? 1 : 0;
  }
  return result.results.every((r) => r.ok) ? 0 : 1;
}

export async function runPluginCommand(
  verb: PluginVerb,
  target: PluginTarget,
  options: PluginCommandOptions = {},
): Promise<PluginCommandResult> {
  if (!PLUGIN_VERBS.includes(verb)) throw new Error(`unknown plugin command '${verb}'`);
  if (!PLUGIN_TARGETS.includes(target))
    throw new Error(`unknown plugin target '${target}' (expected ${PLUGIN_TARGETS.join("|")})`);
  const runtime = runtimePaths();
  const state = loadState(runtime.configDir);
  const results: PluginHostResult[] = [];
  for (const host of targets(target)) {
    results.push(await runHost(HOST_DEFINITIONS[host], verb, options, state, runtime));
  }
  if (!options.dryRun && (verb === "install" || verb === "repair" || verb === "uninstall"))
    saveState(state, runtime.configDir);
  const result = {
    verb,
    target,
    dryRun: options.dryRun === true,
    results,
    ok: results.every((r) => r.ok),
    exitCode: 0,
  };
  result.exitCode = exitCodeFor(verb, result);
  return result;
}

export function formatPluginResult(result: PluginCommandResult): string {
  const lines: string[] = [];
  for (const r of result.results) {
    const marker = r.ok ? "ok" : result.verb === "status" ? "warn" : "blocked";
    lines.push(`[${marker}] ${r.host}: ${r.state}${r.changed ? " (changed)" : ""}`);
    for (const action of r.actions) lines.push(`  - ${action}`);
    for (const note of r.notes) lines.push(`  note: ${note}`);
    for (const warning of r.warnings) lines.push(`  warning: ${warning}`);
    for (const error of r.errors) lines.push(`  error: ${error}`);
  }
  return lines.join("\n");
}

export function pluginCommandErrorResult(
  verb: string | undefined,
  target: string | undefined,
  dryRun: boolean,
  exitCode: number,
  error: string,
): PluginCommandErrorResult {
  return {
    verb: verb ?? null,
    target: target ?? null,
    dryRun,
    results: [],
    ok: false,
    exitCode,
    error,
  };
}
