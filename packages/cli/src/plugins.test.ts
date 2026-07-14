import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { describe, expect, it } from "vitest";
import { pluginCommandErrorResult, runPluginCommand } from "./plugins.js";

const MANAGED_VERSION_MARKER = `claudexor:managed host-plugin-lifecycle; version=${CLAUDEXOR_VERSION}`;

async function withTempHome(
  fn: (paths: {
    dir: string;
    home: string;
    config: string;
    cli: string;
    childEnv: string;
  }) => Promise<void> | void,
): Promise<void> {
  const dir = mkTemp();
  const home = join(dir, "home");
  const config = join(dir, "config");
  const childEnv = join(dir, "child-env.json");
  mkdirSync(home, { recursive: true });
  mkdirSync(config, { recursive: true });
  const cli = join(dir, "mcp-stub.js");
  writeFileSync(
    cli,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import readline from "node:readline";
if (process.argv[2] !== "mcp" || process.argv[3] !== "serve") process.exit(2);
writeFileSync(${JSON.stringify(childEnv)}, JSON.stringify(process.env, Object.keys(process.env).sort()));
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "claudexor", version: "test" }, capabilities: { tools: {} } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    const frame = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "claudexor_status", description: "status", inputSchema: { type: "object" } }] } }) + "\\n";
    process.stdout.write(frame.slice(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.stdout.write(frame.slice(20));
  }
}
`,
    { mode: 0o700 },
  );
  const old = {
    HOME: process.env.HOME,
    CLAUDEXOR_CONFIG_DIR: process.env.CLAUDEXOR_CONFIG_DIR,
    CLAUDEXOR_CLI_PATH: process.env.CLAUDEXOR_CLI_PATH,
    CLAUDEXOR_NODE_PATH: process.env.CLAUDEXOR_NODE_PATH,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    VITEST: process.env.VITEST,
  };
  process.env.HOME = home;
  process.env.CLAUDEXOR_CONFIG_DIR = config;
  process.env.CLAUDEXOR_CLI_PATH = cli;
  process.env.VITEST = "true";
  delete process.env.CLAUDEXOR_NODE_PATH;
  try {
    await fn({ dir, home, config, cli, childEnv });
  } finally {
    restoreEnv(old);
    rmSync(dir, { recursive: true, force: true });
  }
}

function mkTemp(): string {
  return mkdtempSync(join(tmpdir(), "claudexor-plugin-"));
}

function restoreEnv(old: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function hashText(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

function normalizeHome(text: string, home: string, cli: string, config = ""): string {
  const normalized = text
    .replaceAll(home, "<HOME>")
    .replaceAll(cli, "<CLI>")
    .replaceAll(process.execPath, "<NODE>");
  return config ? normalized.replaceAll(config, "<CONFIG>") : normalized;
}

const OLD_THIN_SHIM = `Use the local \`claudexor\` CLI for harness-agnostic, evidence-driven coding.
It orchestrates Codex/Claude/Cursor/OpenCode with best-of-n tournaments,
cross-family review, and budget balancing. Prefer it for multi-harness work.

- \`claudexor ask "<question>"\`        read-only answer/explanation
- \`claudexor explore "<question>"\`    read-only exploration/synthesis
- \`claudexor run "<task>"\`            Agent run (native parity + artifacts)
- \`claudexor race "<task>" --n 4\`     Best-of-N tournament + cross-family review
- \`claudexor plan "<task>"\`           read-only plan
- \`claudexor create "<task>"\`         create a new project
- \`claudexor inspect <run_id>\`        inspect artifacts under .claudexor/runs

These plugins are thin shims: they call the local CLI; all orchestration lives in claudexor.`;

function oldThinShimManifest(): string {
  return (
    JSON.stringify(
      { name: "claudexor", version: "0.10.2", description: "Claudexor control plane (thin shim)" },
      null,
      2,
    ) + "\n"
  );
}

describe("plugin lifecycle", () => {
  it("formats structured JSON preflight failures for invalid plugin CLI input", () => {
    expect(pluginCommandErrorResult("bogus", "all", false, 2, "bad verb")).toEqual({
      verb: "bogus",
      target: "all",
      dryRun: false,
      results: [],
      ok: false,
      exitCode: 2,
      error: "bad verb",
    });
    expect(pluginCommandErrorResult("status", "bogus", true, 2, "bad target")).toEqual({
      verb: "status",
      target: "bogus",
      dryRun: true,
      results: [],
      ok: false,
      exitCode: 2,
      error: "bad target",
    });
  });

  it("installs all host integrations in a temp HOME and passes status/doctor", async () => {
    await withTempHome(async ({ home, config, cli }) => {
      const install = await runPluginCommand("install", "all");
      expect(install.exitCode).toBe(0);
      expect(install.results.map((r) => [r.host, r.state])).toEqual([
        ["cursor", "installed"],
        ["claude", "installed"],
        ["codex", "registered"],
        ["opencode", "installed"],
      ]);
      const claudeManifest = readJson(
        join(home, ".claude", "skills", "claudexor", ".claude-plugin", "plugin.json"),
      );
      expect(claudeManifest.claudexor.marker).toBe("claudexor:managed host-plugin-lifecycle");

      const codexManifest = readJson(
        join(home, ".codex", "plugins", "claudexor", ".codex-plugin", "plugin.json"),
      );
      expect(codexManifest.skills).toBe("./skills/");
      expect(codexManifest.mcpServers).toBe("./.mcp.json");
      expect(
        existsSync(join(home, ".codex", "plugins", "claudexor", "commands", "claudexor.md")),
      ).toBe(false);
      const codexMcp = readJson(join(home, ".codex", "plugins", "claudexor", ".mcp.json"));
      expect(codexMcp.mcpServers.claudexor.env.CLAUDEXOR_CONFIG_DIR).toBe(config);
      expect(codexMcp.mcpServers.claudexor.env.CLAUDEXOR_MANAGED).toBe(
        "claudexor:managed host-plugin-lifecycle",
      );

      const cursorManifest = readJson(
        join(home, ".cursor", "plugins", "local", "claudexor", ".cursor-plugin", "plugin.json"),
      );
      expect(cursorManifest.interface).toBeUndefined();
      expect(cursorManifest.claudexor).toBeUndefined();
      expect(cursorManifest.mcpServers).toBe("./mcp.json");
      expect(cursorManifest.commands).toEqual(["commands/claudexor.md"]);
      expect(cursorManifest.skills).toEqual(["skills/claudexor"]);
      expect(cursorManifest.displayName).toBeUndefined();
      expect(cursorManifest.publisher).toBeUndefined();
      for (const p of [...cursorManifest.commands, ...cursorManifest.skills])
        expect(p).not.toContain("*");
      expect(existsSync(join(home, ".cursor", "plugins", "local", "claudexor", "mcp.json"))).toBe(
        true,
      );
      expect(existsSync(join(home, ".cursor", "plugins", "local", "claudexor", ".mcp.json"))).toBe(
        false,
      );
      expect(
        existsSync(
          join(home, ".cursor", "plugins", "local", "claudexor", "skills", "claudexor", "SKILL.md"),
        ),
      ).toBe(true);

      const opencodePlugin = readFileSync(
        join(home, ".config", "opencode", "plugins", "claudexor.js"),
        "utf8",
      );
      expect(opencodePlugin).toContain('"experimental.chat.system.transform"');
      const claudeSkill = readFileSync(
        join(home, ".claude", "skills", "claudexor", "skills", "claudexor", "SKILL.md"),
        "utf8",
      );
      expect(claudeSkill.startsWith("---\nname: claudexor\n")).toBe(true);
      expect(claudeSkill).toContain(`---\n<!-- ${MANAGED_VERSION_MARKER} -->\n# Claudexor`);
      const cursorCommand = readFileSync(
        join(home, ".cursor", "plugins", "local", "claudexor", "commands", "claudexor.md"),
        "utf8",
      );
      expect(
        cursorCommand.startsWith(
          "---\ndescription: Use Claudexor CLI/MCP for harness-agnostic coding workflows\n---\n",
        ),
      ).toBe(true);
      expect(cursorCommand).toContain(`---\n<!-- ${MANAGED_VERSION_MARKER} -->\nUse Claudexor`);

      const marketplace = readJson(join(home, ".agents", "plugins", "marketplace.json"));
      expect(marketplace.plugins[0].source.path).toBe("./.codex/plugins/claudexor");
      const opencode = readJson(join(home, ".config", "opencode", "opencode.json"));
      expect(opencode.mcp.claudexor.command.slice(-2)).toEqual(["mcp", "serve"]);
      expect(opencode.mcp.claudexor.environment.CLAUDEXOR_CONFIG_DIR).toBe(config);
      expect(existsSync(join(config, "plugins", "state.json"))).toBe(true);
      const goldenFiles = [
        ".claude/skills/claudexor/.claude-plugin/plugin.json",
        ".claude/skills/claudexor/.mcp.json",
        ".claude/skills/claudexor/commands/claudexor.md",
        ".claude/skills/claudexor/skills/claudexor/SKILL.md",
        ".codex/plugins/claudexor/.codex-plugin/plugin.json",
        ".codex/plugins/claudexor/.mcp.json",
        ".codex/plugins/claudexor/skills/claudexor/SKILL.md",
        ".cursor/plugins/local/claudexor/.cursor-plugin/plugin.json",
        ".cursor/plugins/local/claudexor/commands/claudexor.md",
        ".cursor/plugins/local/claudexor/mcp.json",
        ".config/opencode/commands/claudexor.md",
        ".config/opencode/plugins/claudexor.js",
        ".config/opencode/skills/claudexor/SKILL.md",
      ];
      const snapshot = Object.fromEntries(
        goldenFiles.map((file) => {
          const text = readFileSync(join(home, file), "utf8");
          return [
            file,
            normalizeHome(text, home, cli, config)
              .split("\n")
              .filter(
                (line) =>
                  line.includes("claudexor:managed host-plugin-lifecycle") ||
                  line.includes('"CLAUDEXOR_CONFIG_DIR"') ||
                  line.includes('"skills"') ||
                  line.includes('"mcpServers"') ||
                  line.includes('"experimental.chat.system.transform"') ||
                  line.includes('"command"') ||
                  line.includes("one-shot") ||
                  line.includes("Do not claim live thread parity"),
              ),
          ];
        }),
      );
      expect(snapshot).toEqual({
        ".claude/skills/claudexor/.claude-plugin/plugin.json": [
          '  "description": "Claudexor control plane host integration (claudexor:managed host-plugin-lifecycle)",',
          '    "marker": "claudexor:managed host-plugin-lifecycle",',
        ],
        ".claude/skills/claudexor/.mcp.json": [
          '  "mcpServers": {',
          '      "command": "<NODE>",',
          '        "CLAUDEXOR_CONFIG_DIR": "<CONFIG>",',
          '        "CLAUDEXOR_MANAGED": "claudexor:managed host-plugin-lifecycle",',
        ],
        ".claude/skills/claudexor/commands/claudexor.md": [
          `<!-- ${MANAGED_VERSION_MARKER} -->`,
          "Do not claim live thread parity through MCP. Ask for an explicit repo path if the target project is ambiguous.",
        ],
        ".claude/skills/claudexor/skills/claudexor/SKILL.md": [
          `<!-- ${MANAGED_VERSION_MARKER} -->`,
          "MCP support is one-shot and honest: tools return the final Claudexor output, not a live Claudexor thread. Use an explicit `repoPath` when the host cwd may not be the target project.",
        ],
        ".codex/plugins/claudexor/.codex-plugin/plugin.json": [
          '  "description": "Claudexor control plane host integration (claudexor:managed host-plugin-lifecycle)",',
          '  "skills": "./skills/",',
          '  "mcpServers": "./.mcp.json",',
          '    "longDescription": "Use Claudexor for local planning, runs, races, and review through generated skills and one-shot MCP tools.",',
        ],
        ".codex/plugins/claudexor/.mcp.json": [
          '  "mcpServers": {',
          '      "command": "<NODE>",',
          '        "CLAUDEXOR_CONFIG_DIR": "<CONFIG>",',
          '        "CLAUDEXOR_MANAGED": "claudexor:managed host-plugin-lifecycle",',
        ],
        ".codex/plugins/claudexor/skills/claudexor/SKILL.md": [
          `<!-- ${MANAGED_VERSION_MARKER} -->`,
          "MCP support is one-shot and honest: tools return the final Claudexor output, not a live Claudexor thread. Use an explicit `repoPath` when the host cwd may not be the target project.",
        ],
        ".cursor/plugins/local/claudexor/.cursor-plugin/plugin.json": [
          '  "description": "Claudexor control plane host integration (claudexor:managed host-plugin-lifecycle)",',
          '  "skills": [',
          '  "mcpServers": "./mcp.json"',
        ],
        ".cursor/plugins/local/claudexor/commands/claudexor.md": [
          `<!-- ${MANAGED_VERSION_MARKER} -->`,
          "Do not claim live thread parity through MCP. Ask for an explicit repo path if the target project is ambiguous.",
        ],
        ".cursor/plugins/local/claudexor/mcp.json": [
          '  "mcpServers": {',
          '      "command": "<NODE>",',
          '        "CLAUDEXOR_CONFIG_DIR": "<CONFIG>",',
          '        "CLAUDEXOR_MANAGED": "claudexor:managed host-plugin-lifecycle",',
        ],
        ".config/opencode/commands/claudexor.md": [
          `<!-- ${MANAGED_VERSION_MARKER} -->`,
          "Do not claim live thread parity through MCP. Ask for an explicit repo path if the target project is ambiguous.",
        ],
        ".config/opencode/plugins/claudexor.js": [
          `// ${MANAGED_VERSION_MARKER}`,
          '    "experimental.chat.system.transform": async (_input, output) => {',
        ],
        ".config/opencode/skills/claudexor/SKILL.md": [
          `<!-- ${MANAGED_VERSION_MARKER} -->`,
          "MCP support is one-shot and honest: tools return the final Claudexor output, not a live Claudexor thread. Use an explicit `repoPath` when the host cwd may not be the target project.",
        ],
      });

      const status = await runPluginCommand("status", "all");
      expect(status.exitCode).toBe(0);
      expect(status.ok).toBe(true);
      expect(status.results.every((r) => r.state === "installed" || r.state === "registered")).toBe(
        true,
      );

      const doctor = await runPluginCommand("doctor", "all");
      expect(doctor.exitCode).toBe(0);
      expect(
        doctor.results.every((r) =>
          r.actions.includes("MCP initialize/tools-list self-test passed"),
        ),
      ).toBe(true);

      const dryDoctor = await runPluginCommand("doctor", "all", { dryRun: true });
      expect(dryDoctor.exitCode).toBe(0);
      expect(
        dryDoctor.results.every((r) =>
          r.actions.includes("would run MCP initialize/initialized/tools-list self-test"),
        ),
      ).toBe(true);
    });
  });

  it("dry-run reports actions without writing files or state", async () => {
    await withTempHome(async ({ home, config }) => {
      const result = await runPluginCommand("install", "all", { dryRun: true });
      expect(result.exitCode).toBe(0);
      expect(result.results.every((r) => r.changed)).toBe(true);
      expect(existsSync(join(home, ".codex", "plugins", "claudexor"))).toBe(false);
      expect(existsSync(join(config, "plugins", "state.json"))).toBe(false);
    });
  });

  it("reports config-only Codex and OpenCode installs as partial, not missing", async () => {
    await withTempHome(async ({ home }) => {
      expect((await runPluginCommand("install", "codex")).exitCode).toBe(0);
      rmSync(join(home, ".codex", "plugins", "claudexor"), { recursive: true, force: true });
      const codex = await runPluginCommand("status", "codex");
      expect(codex.exitCode).toBe(0);
      expect(codex.results[0]?.state).toBe("partial");

      expect((await runPluginCommand("install", "opencode")).exitCode).toBe(0);
      rmSync(join(home, ".config", "opencode", "skills", "claudexor"), {
        recursive: true,
        force: true,
      });
      rmSync(join(home, ".config", "opencode", "commands", "claudexor.md"), { force: true });
      rmSync(join(home, ".config", "opencode", "plugins", "claudexor.js"), { force: true });
      const opencode = await runPluginCommand("status", "opencode");
      expect(opencode.exitCode).toBe(0);
      expect(opencode.results[0]?.state).toBe("partial");
    });
  });

  it("does not pass provider secrets into the MCP doctor child process", async () => {
    await withTempHome(async ({ home, config, childEnv }) => {
      process.env.OPENAI_API_KEY = "unit-test-openai-key";
      process.env.ANTHROPIC_API_KEY = "unit-test-anthropic-key";
      process.env.OPENROUTER_API_KEY = "unit-test-openrouter-key";
      process.env.GITHUB_TOKEN = "unit-test-github-token";

      expect((await runPluginCommand("install", "codex")).exitCode).toBe(0);
      expect((await runPluginCommand("doctor", "codex")).exitCode).toBe(0);

      const env = readJson(childEnv);
      expect(env.HOME).toBe(home);
      expect(env.CLAUDEXOR_CONFIG_DIR).toBe(config);
      const generated = readJson(join(home, ".codex", "plugins", "claudexor", ".mcp.json"))
        .mcpServers.claudexor.env;
      expect(env.CLAUDEXOR_CONFIG_DIR).toBe(generated.CLAUDEXOR_CONFIG_DIR);
      expect(env.CLAUDEXOR_MANAGED).toBe(generated.CLAUDEXOR_MANAGED);
      expect(env.CLAUDEXOR_PLUGIN_VERSION).toBe(generated.CLAUDEXOR_PLUGIN_VERSION);
      expect(env.PATH).toBeTruthy();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
    });
  });

  it("refuses unowned conflicts even when force is requested", async () => {
    await withTempHome(async ({ home }) => {
      const path = join(home, ".codex", "plugins", "claudexor", ".codex-plugin", "plugin.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{"name":"someone-else"}\n');
      const result = await runPluginCommand("install", "codex", { force: true });
      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.state).toBe("blocked");
      expect(result.results[0]?.errors.join("\n")).toContain("not Claudexor-owned");
    });
  });

  it("refuses symlinked managed artifact targets", async () => {
    await withTempHome(async ({ home }) => {
      const path = join(home, ".codex", "plugins", "claudexor", ".codex-plugin", "plugin.json");
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(join(home, "missing-plugin.json"), path);

      const result = await runPluginCommand("install", "codex");
      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("symlink");
    });

    await withTempHome(async ({ home }) => {
      const marketplace = join(home, ".agents", "plugins", "marketplace.json");
      mkdirSync(dirname(marketplace), { recursive: true });
      symlinkSync(join(home, "missing-marketplace.json"), marketplace);
      const result = await runPluginCommand("install", "codex");
      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("symlink");
    });
  });

  it("refuses to create missing plugin directories through symlinked parents", async () => {
    await withTempHome(async ({ dir, home }) => {
      const pluginsParent = join(home, ".codex", "plugins");
      const outsidePlugins = join(dir, "outside-codex-plugins");
      mkdirSync(dirname(pluginsParent), { recursive: true });
      mkdirSync(outsidePlugins, { recursive: true });
      symlinkSync(outsidePlugins, pluginsParent, "dir");

      const result = await runPluginCommand("install", "codex");
      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("symlink");
      expect(existsSync(join(outsidePlugins, "claudexor"))).toBe(false);
    });

    await withTempHome(async ({ dir, home }) => {
      const marketplaceParent = join(home, ".agents", "plugins");
      const outsideMarketplace = join(dir, "outside-marketplace");
      mkdirSync(dirname(marketplaceParent), { recursive: true });
      mkdirSync(outsideMarketplace, { recursive: true });
      symlinkSync(outsideMarketplace, marketplaceParent, "dir");

      const result = await runPluginCommand("install", "codex");
      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("symlink");
      expect(existsSync(join(outsideMarketplace, "marketplace.json"))).toBe(false);
    });

    await withTempHome(async ({ dir, home }) => {
      const codexRoot = join(home, ".codex");
      const outsideCodex = join(dir, "outside-codex-root");
      mkdirSync(outsideCodex, { recursive: true });
      symlinkSync(outsideCodex, codexRoot, "dir");

      const result = await runPluginCommand("install", "codex");
      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("symlink");
      expect(existsSync(join(outsideCodex, "plugins", "claudexor"))).toBe(false);
    });

    await withTempHome(async ({ dir, home }) => {
      const claudeRoot = join(home, ".claude");
      const outsideClaude = join(dir, "outside-claude-root");
      mkdirSync(outsideClaude, { recursive: true });
      symlinkSync(outsideClaude, claudeRoot, "dir");
      const oldClaudeManifest = join(
        claudeRoot,
        "plugins",
        "claudexor",
        ".claude-plugin",
        "plugin.json",
      );
      const oldClaudeCommand = join(claudeRoot, "plugins", "claudexor", "commands", "claudexor.md");
      mkdirSync(dirname(oldClaudeManifest), { recursive: true });
      mkdirSync(dirname(oldClaudeCommand), { recursive: true });
      writeFileSync(oldClaudeManifest, oldThinShimManifest());
      writeFileSync(oldClaudeCommand, `---\ndescription: Run Claudexor\n---\n${OLD_THIN_SHIM}\n`);

      const result = await runPluginCommand("install", "claude");
      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("symlink");
      expect(existsSync(join(outsideClaude, "plugins", "claudexor"))).toBe(true);
    });
  });

  it("refuses to create backups through a symlinked backup root", async () => {
    await withTempHome(async ({ dir, home }) => {
      expect((await runPluginCommand("install", "codex")).exitCode).toBe(0);
      const manifest = join(home, ".codex", "plugins", "claudexor", ".codex-plugin", "plugin.json");
      writeFileSync(manifest, readFileSync(manifest, "utf8") + "\nmanual drift\n");
      const backupRoot = join(home, ".codex", ".claudexor-backups");
      const outsideBackups = join(dir, "outside-backups");
      mkdirSync(outsideBackups, { recursive: true });
      symlinkSync(outsideBackups, backupRoot, "dir");

      const result = await runPluginCommand("repair", "codex");
      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("symlink");
      expect(readdirSync(outsideBackups)).toEqual([]);
      expect(readFileSync(manifest, "utf8")).toContain("manual drift");
    });
  });

  it("continues all-host install on partial failure; status exits 1 on the blocked host (scriptable)", async () => {
    await withTempHome(async ({ home }) => {
      const conflict = join(home, ".codex", "plugins", "claudexor", ".codex-plugin", "plugin.json");
      mkdirSync(dirname(conflict), { recursive: true });
      writeFileSync(conflict, '{"name":"someone-else"}\n');

      const install = await runPluginCommand("install", "all");
      expect(install.exitCode).toBe(1);
      expect(install.results).toHaveLength(4);
      expect(install.results.find((r) => r.host === "codex")?.state).toBe("blocked");
      expect(install.results.find((r) => r.host === "opencode")?.state).toBe("installed");

      // status exits 1 when any host is drifted/blocked (actionable problems
      // must be scriptable); absence states alone stay 0.
      const status = await runPluginCommand("status", "all");
      expect(status.exitCode).toBe(1);
      expect(status.ok).toBe(false);
      const codex = status.results.find((r) => r.host === "codex");
      expect(codex?.ok).toBe(false);
      expect(codex?.state).toBe("blocked");
    });
  });

  it("removes verified legacy skill shims before installing Codex plugin-only layout", async () => {
    await withTempHome(async ({ home }) => {
      const legacy = join(home, ".agents", "skills", "claudexor", "SKILL.md");
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        "---\nname: claudexor\ndescription: Harness-agnostic coding via the claudexor CLI\n---\n",
      );
      const result = await runPluginCommand("install", "codex");
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(home, ".agents", "skills", "claudexor"))).toBe(false);
      expect(
        existsSync(join(home, ".codex", "plugins", "claudexor", ".codex-plugin", "plugin.json")),
      ).toBe(true);
    });
  });

  it("blocks user-modified Codex legacy skill paths even when they include the old marker phrase", async () => {
    await withTempHome(async ({ home }) => {
      const legacy = join(home, ".agents", "skills", "claudexor", "SKILL.md");
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        "---\nname: claudexor\ndescription: Harness-agnostic coding via the claudexor CLI\n---\n\nuser edits\n",
      );

      const result = await runPluginCommand("install", "codex");

      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("looks like a legacy Claudexor path");
      expect(readFileSync(legacy, "utf8")).toContain("user edits");
    });
  });

  it("blocks user-modified OpenCode legacy paths even when they include the old marker phrase", async () => {
    await withTempHome(async ({ home }) => {
      const legacy = join(home, ".config", "opencode", "claudexor", "AGENTS.md");
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        "These plugins are thin shims\nHarness-agnostic coding via the claudexor CLI\n\nuser edits\n",
      );

      const result = await runPluginCommand("install", "opencode");

      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("looks like a legacy Claudexor path");
      expect(readFileSync(legacy, "utf8")).toContain("user edits");
    });
  });

  it("blocks user-modified Claude and Cursor legacy commands even when they include old shim phrases", async () => {
    await withTempHome(async ({ home }) => {
      const oldClaudeManifest = join(
        home,
        ".claude",
        "plugins",
        "claudexor",
        ".claude-plugin",
        "plugin.json",
      );
      const oldClaudeCommand = join(
        home,
        ".claude",
        "plugins",
        "claudexor",
        "commands",
        "claudexor.md",
      );
      mkdirSync(dirname(oldClaudeManifest), { recursive: true });
      mkdirSync(dirname(oldClaudeCommand), { recursive: true });
      writeFileSync(oldClaudeManifest, oldThinShimManifest());
      writeFileSync(
        oldClaudeCommand,
        `---\ndescription: Run Claudexor\n---\n${OLD_THIN_SHIM}\n\nuser edits still mention claudexor race\n`,
      );

      const result = await runPluginCommand("install", "claude");

      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("looks like a legacy Claudexor path");
      expect(readFileSync(oldClaudeCommand, "utf8")).toContain("user edits");
    });

    await withTempHome(async ({ home }) => {
      const oldCursorManifest = join(
        home,
        ".cursor",
        "plugins",
        "local",
        "claudexor",
        ".cursor-plugin",
        "plugin.json",
      );
      const oldCursorCommand = join(
        home,
        ".cursor",
        "plugins",
        "local",
        "claudexor",
        "commands",
        "claudexor.md",
      );
      mkdirSync(dirname(oldCursorManifest), { recursive: true });
      mkdirSync(dirname(oldCursorCommand), { recursive: true });
      writeFileSync(oldCursorManifest, oldThinShimManifest());
      writeFileSync(
        oldCursorCommand,
        `---\nname: claudexor\ndescription: Run Claudexor\n---\n${OLD_THIN_SHIM}\n\nuser edits still mention claudexor race\n`,
      );

      const result = await runPluginCommand("install", "cursor");

      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("looks like a legacy Claudexor path");
      expect(readFileSync(oldCursorCommand, "utf8")).toContain("user edits");
    });
  });

  it("migrates exact old Claude and Cursor thin shims whose manifests had no marker", async () => {
    await withTempHome(async ({ home }) => {
      const oldClaudeManifest = join(
        home,
        ".claude",
        "plugins",
        "claudexor",
        ".claude-plugin",
        "plugin.json",
      );
      const oldClaudeCommand = join(
        home,
        ".claude",
        "plugins",
        "claudexor",
        "commands",
        "claudexor.md",
      );
      const oldCursorManifest = join(
        home,
        ".cursor",
        "plugins",
        "local",
        "claudexor",
        ".cursor-plugin",
        "plugin.json",
      );
      const oldCursorCommand = join(
        home,
        ".cursor",
        "plugins",
        "local",
        "claudexor",
        "commands",
        "claudexor.md",
      );
      for (const path of [oldClaudeManifest, oldClaudeCommand, oldCursorManifest, oldCursorCommand])
        mkdirSync(dirname(path), { recursive: true });
      writeFileSync(oldClaudeManifest, oldThinShimManifest());
      writeFileSync(oldClaudeCommand, `---\ndescription: Run Claudexor\n---\n${OLD_THIN_SHIM}\n`);
      writeFileSync(oldCursorManifest, oldThinShimManifest());
      writeFileSync(
        oldCursorCommand,
        `---\nname: claudexor\ndescription: Run Claudexor\n---\n${OLD_THIN_SHIM}\n`,
      );

      const result = await runPluginCommand("install", "all");
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(home, ".claude", "plugins", "claudexor"))).toBe(false);
      expect(
        readJson(join(home, ".claude", "skills", "claudexor", ".claude-plugin", "plugin.json"))
          .claudexor.marker,
      ).toBe("claudexor:managed host-plugin-lifecycle");
      expect(
        readJson(
          join(home, ".cursor", "plugins", "local", "claudexor", ".cursor-plugin", "plugin.json"),
        ).description,
      ).toContain("claudexor:managed host-plugin-lifecycle");
      expect(
        readFileSync(
          join(home, ".cursor", "plugins", "local", "claudexor", "commands", "claudexor.md"),
          "utf8",
        ),
      ).not.toContain("These plugins are thin shims");
    });
  });

  it("removes verified legacy shims on uninstall and blocks ambiguous legacy paths", async () => {
    await withTempHome(async ({ home }) => {
      const oldClaudeManifest = join(
        home,
        ".claude",
        "plugins",
        "claudexor",
        ".claude-plugin",
        "plugin.json",
      );
      const oldClaudeCommand = join(
        home,
        ".claude",
        "plugins",
        "claudexor",
        "commands",
        "claudexor.md",
      );
      const oldCodexSkill = join(home, ".agents", "skills", "claudexor", "SKILL.md");
      const oldCursorManifest = join(
        home,
        ".cursor",
        "plugins",
        "local",
        "claudexor",
        ".cursor-plugin",
        "plugin.json",
      );
      const oldCursorCommand = join(
        home,
        ".cursor",
        "plugins",
        "local",
        "claudexor",
        "commands",
        "claudexor.md",
      );
      const oldOpenCodeAgent = join(home, ".config", "opencode", "claudexor", "AGENTS.md");
      for (const path of [
        oldClaudeManifest,
        oldClaudeCommand,
        oldCodexSkill,
        oldCursorManifest,
        oldCursorCommand,
        oldOpenCodeAgent,
      ])
        mkdirSync(dirname(path), { recursive: true });
      writeFileSync(oldClaudeManifest, oldThinShimManifest());
      writeFileSync(oldClaudeCommand, `---\ndescription: Run Claudexor\n---\n${OLD_THIN_SHIM}\n`);
      writeFileSync(
        oldCodexSkill,
        "---\nname: claudexor\ndescription: Harness-agnostic coding via the claudexor CLI\n---\n",
      );
      writeFileSync(oldCursorManifest, oldThinShimManifest());
      writeFileSync(
        oldCursorCommand,
        `---\nname: claudexor\ndescription: Run Claudexor\n---\n${OLD_THIN_SHIM}\n`,
      );
      writeFileSync(
        oldOpenCodeAgent,
        "These plugins are thin shims\nHarness-agnostic coding via the claudexor CLI\n",
      );

      expect((await runPluginCommand("uninstall", "claude")).exitCode).toBe(0);
      expect((await runPluginCommand("uninstall", "codex")).exitCode).toBe(0);
      expect((await runPluginCommand("uninstall", "cursor")).exitCode).toBe(0);
      expect((await runPluginCommand("uninstall", "opencode")).exitCode).toBe(0);
      expect(existsSync(join(home, ".claude", "plugins", "claudexor"))).toBe(false);
      expect(existsSync(join(home, ".agents", "skills", "claudexor"))).toBe(false);
      expect(existsSync(join(home, ".cursor", "plugins", "local", "claudexor"))).toBe(false);
      expect(existsSync(join(home, ".config", "opencode", "claudexor"))).toBe(false);
    });

    await withTempHome(async ({ home }) => {
      const ambiguous = join(
        home,
        ".claude",
        "plugins",
        "claudexor",
        ".claude-plugin",
        "plugin.json",
      );
      mkdirSync(dirname(ambiguous), { recursive: true });
      writeFileSync(ambiguous, '{"name":"claudexor"}\n');
      const result = await runPluginCommand("uninstall", "claude");
      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("looks like a legacy Claudexor path");
      expect(existsSync(join(home, ".claude", "plugins", "claudexor"))).toBe(true);
    });

    await withTempHome(async ({ home }) => {
      const oldClaudeManifest = join(
        home,
        ".claude",
        "plugins",
        "claudexor",
        ".claude-plugin",
        "plugin.json",
      );
      const oldClaudeCommand = join(
        home,
        ".claude",
        "plugins",
        "claudexor",
        "commands",
        "claudexor.md",
      );
      const extraDir = join(home, ".claude", "plugins", "claudexor", "user-empty-dir");
      mkdirSync(dirname(oldClaudeManifest), { recursive: true });
      mkdirSync(dirname(oldClaudeCommand), { recursive: true });
      mkdirSync(extraDir, { recursive: true });
      writeFileSync(oldClaudeManifest, oldThinShimManifest());
      writeFileSync(oldClaudeCommand, `---\ndescription: Run Claudexor\n---\n${OLD_THIN_SHIM}\n`);
      const result = await runPluginCommand("uninstall", "claude");
      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("looks like a legacy Claudexor path");
      expect(existsSync(extraDir)).toBe(true);
      expect(existsSync(oldClaudeCommand)).toBe(true);
    });

    await withTempHome(async ({ dir, home }) => {
      const pluginsParent = join(home, ".claude", "plugins");
      const outsidePlugins = join(dir, "outside-claude-plugins");
      mkdirSync(dirname(pluginsParent), { recursive: true });
      mkdirSync(outsidePlugins, { recursive: true });
      symlinkSync(outsidePlugins, pluginsParent, "dir");
      const oldClaudeManifest = join(pluginsParent, "claudexor", ".claude-plugin", "plugin.json");
      const oldClaudeCommand = join(pluginsParent, "claudexor", "commands", "claudexor.md");
      mkdirSync(dirname(oldClaudeManifest), { recursive: true });
      mkdirSync(dirname(oldClaudeCommand), { recursive: true });
      writeFileSync(oldClaudeManifest, oldThinShimManifest());
      writeFileSync(oldClaudeCommand, `---\ndescription: Run Claudexor\n---\n${OLD_THIN_SHIM}\n`);
      const result = await runPluginCommand("uninstall", "claude");
      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.errors.join("\n")).toContain("symlink");
      expect(existsSync(join(outsidePlugins, "claudexor"))).toBe(true);
    });

    await withTempHome(async ({ home }) => {
      const marked = join(home, ".claude", "plugins", "claudexor", ".claude-plugin", "plugin.json");
      const unmarked = join(home, ".claude", "plugins", "claudexor", "commands", "claudexor.md");
      mkdirSync(dirname(marked), { recursive: true });
      mkdirSync(dirname(unmarked), { recursive: true });
      writeFileSync(marked, "These plugins are thin shims\n");
      writeFileSync(unmarked, "user command\n");
      const result = await runPluginCommand("uninstall", "claude");
      expect(result.exitCode).toBe(1);
      expect(existsSync(join(home, ".claude", "plugins", "claudexor"))).toBe(true);
    });
  });

  it("uninstalls marker-owned files even if lifecycle state was lost", async () => {
    await withTempHome(async ({ home, config }) => {
      expect((await runPluginCommand("install", "cursor")).exitCode).toBe(0);
      rmSync(join(config, "plugins", "state.json"), { force: true });
      const result = await runPluginCommand("uninstall", "cursor");
      expect(result.exitCode).toBe(0);
      expect(
        existsSync(
          join(home, ".cursor", "plugins", "local", "claudexor", ".cursor-plugin", "plugin.json"),
        ),
      ).toBe(false);
    });
  });

  it("does not uninstall an exact OpenCode MCP entry without state ownership", async () => {
    await withTempHome(async ({ home, config }) => {
      expect((await runPluginCommand("install", "opencode")).exitCode).toBe(0);
      const statePath = join(config, "plugins", "state.json");
      const state = readJson(statePath);
      delete state.hosts.opencode.configEntries["opencode-mcp"];
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

      const uninstall = await runPluginCommand("uninstall", "opencode");
      expect(uninstall.exitCode).toBe(1);
      expect(uninstall.results[0]?.errors.join("\n")).toContain("unowned mcp.claudexor entry");
      const opencode = readJson(join(home, ".config", "opencode", "opencode.json"));
      expect(opencode.mcp.claudexor).toBeDefined();
      expect(existsSync(join(home, ".config", "opencode", "plugins", "claudexor.js"))).toBe(true);
    });
  });

  it("repairs managed drift for all hosts and then uninstalls all owned artifacts/config", async () => {
    await withTempHome(async ({ home }) => {
      expect((await runPluginCommand("install", "all")).exitCode).toBe(0);
      const driftPaths = [
        join(home, ".claude", "skills", "claudexor", "skills", "claudexor", "SKILL.md"),
        join(home, ".codex", "plugins", "claudexor", ".codex-plugin", "plugin.json"),
        join(home, ".cursor", "plugins", "local", "claudexor", "mcp.json"),
        join(home, ".config", "opencode", "plugins", "claudexor.js"),
      ];
      for (const path of driftPaths)
        writeFileSync(path, readFileSync(path, "utf8") + "\nmanual drift\n");

      const repair = await runPluginCommand("repair", "all");
      expect(repair.exitCode).toBe(0);
      expect(repair.results.every((r) => r.ok)).toBe(true);
      expect(
        repair.results.some((r) => r.notes.some((note) => note.includes(".claudexor-backups"))),
      ).toBe(true);
      for (const path of driftPaths)
        expect(readFileSync(path, "utf8")).not.toContain("manual drift");

      const uninstall = await runPluginCommand("uninstall", "all");
      expect(uninstall.exitCode).toBe(0);
      for (const path of driftPaths) expect(existsSync(path)).toBe(false);
      const marketplace = readJson(join(home, ".agents", "plugins", "marketplace.json"));
      expect(marketplace.plugins.some((p: { name?: string }) => p.name === "claudexor")).toBe(
        false,
      );
      const opencode = readJson(join(home, ".config", "opencode", "opencode.json"));
      expect(opencode.mcp.claudexor).toBeUndefined();
    });
  });

  it("blocks forged lifecycle state paths during uninstall", async () => {
    await withTempHome(async ({ home, config }) => {
      expect((await runPluginCommand("install", "codex")).exitCode).toBe(0);
      const outside = join(home, "outside-owned-looking.txt");
      const text = "outside\n";
      writeFileSync(outside, text);
      const statePath = join(config, "plugins", "state.json");
      const state = readJson(statePath);
      state.hosts.codex.artifacts[outside] = {
        host: "codex",
        path: outside,
        hash: hashText(text),
        description: "forged outside path",
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

      const uninstall = await runPluginCommand("uninstall", "codex");
      expect(uninstall.exitCode).toBe(1);
      expect(uninstall.results[0]?.errors.join("\n")).toContain(
        "out-of-scope codex artifact state",
      );
      expect(existsSync(outside)).toBe(true);
    });
  });

  it("blocks forged lifecycle state inside a broad host root but outside Claudexor integration roots", async () => {
    await withTempHome(async ({ home, config }) => {
      expect((await runPluginCommand("install", "codex")).exitCode).toBe(0);
      const unrelated = join(home, ".codex", "unrelated-user-file.txt");
      const text = "user data\n";
      writeFileSync(unrelated, text);
      const statePath = join(config, "plugins", "state.json");
      const state = readJson(statePath);
      state.hosts.codex.artifacts[unrelated] = {
        host: "codex",
        path: unrelated,
        hash: hashText(text),
        description: "forged in-root path",
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

      const repair = await runPluginCommand("repair", "codex");
      expect(repair.exitCode).toBe(1);
      expect(repair.results[0]?.errors.join("\n")).toContain("out-of-scope codex artifact state");
      expect(existsSync(unrelated)).toBe(true);
    });
  });

  it("cleans obsolete state-owned artifacts under the host root during repair", async () => {
    await withTempHome(async ({ home, config }) => {
      expect((await runPluginCommand("install", "cursor")).exitCode).toBe(0);
      const obsolete = join(home, ".cursor", "plugins", "local", "claudexor", ".mcp.json");
      const text = '{"old":true,"marker":"claudexor:managed host-plugin-lifecycle"}\n';
      writeFileSync(obsolete, text);
      const statePath = join(config, "plugins", "state.json");
      const state = readJson(statePath);
      state.hosts.cursor.artifacts[obsolete] = {
        host: "cursor",
        path: obsolete,
        hash: hashText(text),
        description: "obsolete Cursor MCP config",
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

      const repair = await runPluginCommand("repair", "cursor");
      expect(repair.exitCode).toBe(0);
      expect(existsSync(obsolete)).toBe(false);
      expect(repair.results[0]?.actions.join("\n")).toContain("obsolete Claudexor artifact");
    });
  });

  it("blocks obsolete state-owned artifacts that drifted even if the marker remains", async () => {
    await withTempHome(async ({ home, config }) => {
      expect((await runPluginCommand("install", "cursor")).exitCode).toBe(0);
      const obsolete = join(home, ".cursor", "plugins", "local", "claudexor", ".mcp.json");
      const text = '{"old":true,"marker":"claudexor:managed host-plugin-lifecycle"}\n';
      writeFileSync(obsolete, text);
      const statePath = join(config, "plugins", "state.json");
      const state = readJson(statePath);
      state.hosts.cursor.artifacts[obsolete] = {
        host: "cursor",
        path: obsolete,
        hash: hashText(text),
        description: "obsolete Cursor MCP config",
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
      writeFileSync(obsolete, text + "user edits\n");

      const repair = await runPluginCommand("repair", "cursor");

      expect(repair.exitCode).toBe(1);
      expect(repair.results[0]?.errors.join("\n")).toContain(
        "obsolete Claudexor state but no longer matches ownership evidence",
      );
      expect(readFileSync(obsolete, "utf8")).toContain("user edits");
    });
  });

  it("treats invalid Cursor ide_state.json as advisory", async () => {
    await withTempHome(async ({ home }) => {
      const ideState = join(home, ".cursor", "ide_state.json");
      mkdirSync(dirname(ideState), { recursive: true });
      writeFileSync(ideState, "{ broken\n");
      const install = await runPluginCommand("install", "cursor");
      expect(install.exitCode).toBe(0);
      expect(install.results[0]?.warnings.join("\n")).toContain(
        "Cursor JSON state was not parseable",
      );
      const status = await runPluginCommand("status", "cursor");
      expect(status.exitCode).toBe(0);
      expect(status.results[0]?.state).toBe("installed");
      expect(status.results[0]?.warnings.join("\n")).toContain(
        "Cursor JSON state was not parseable",
      );
    });
  });

  it("preserves unrelated JSON config entries and blocks unowned Claudexor config entries", async () => {
    await withTempHome(async ({ home }) => {
      const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
      mkdirSync(dirname(marketplacePath), { recursive: true });
      writeFileSync(
        marketplacePath,
        JSON.stringify(
          {
            name: "personal",
            interface: { displayName: "Personal" },
            plugins: [
              {
                name: "other",
                source: { source: "local", path: "./plugins/other" },
                policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
                category: "Productivity",
              },
            ],
          },
          null,
          2,
        ),
      );
      const opencodePath = join(home, ".config", "opencode", "opencode.json");
      mkdirSync(dirname(opencodePath), { recursive: true });
      writeFileSync(
        opencodePath,
        JSON.stringify({ mcp: { other: { type: "local", command: ["node", "other"] } } }, null, 2),
      );

      expect((await runPluginCommand("install", "all")).exitCode).toBe(0);
      expect(
        readJson(marketplacePath).plugins.some((p: { name?: string }) => p.name === "other"),
      ).toBe(true);
      expect(readJson(opencodePath).mcp.other).toBeDefined();
    });

    await withTempHome(async ({ home }) => {
      const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
      mkdirSync(dirname(marketplacePath), { recursive: true });
      writeFileSync(
        marketplacePath,
        JSON.stringify(
          {
            name: "personal",
            plugins: [{ name: "claudexor", source: { source: "local", path: "./somewhere-else" } }],
          },
          null,
          2,
        ),
      );
      const opencodePath = join(home, ".config", "opencode", "opencode.json");
      mkdirSync(dirname(opencodePath), { recursive: true });
      writeFileSync(
        opencodePath,
        JSON.stringify(
          { mcp: { claudexor: { type: "local", command: ["node", "other"] } } },
          null,
          2,
        ),
      );

      const install = await runPluginCommand("install", "all");
      expect(install.exitCode).toBe(1);
      expect(install.results.find((r) => r.host === "codex")?.errors.join("\n")).toContain(
        "unowned claudexor marketplace entry",
      );
      expect(install.results.find((r) => r.host === "opencode")?.errors.join("\n")).toContain(
        "unowned mcp.claudexor entry",
      );
    });
  });

  it("blocks JSON null host config files instead of treating them as missing", async () => {
    await withTempHome(async ({ home }) => {
      const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
      mkdirSync(dirname(marketplacePath), { recursive: true });
      writeFileSync(marketplacePath, "null\n");
      const codex = await runPluginCommand("install", "codex");
      expect(codex.exitCode).toBe(1);
      expect(codex.results[0]?.errors.join("\n")).toContain(
        "is not a Codex marketplace JSON object with plugins[]",
      );
      expect(readFileSync(marketplacePath, "utf8")).toBe("null\n");
    });

    await withTempHome(async ({ home }) => {
      const opencodePath = join(home, ".config", "opencode", "opencode.json");
      mkdirSync(dirname(opencodePath), { recursive: true });
      writeFileSync(opencodePath, "null\n");
      const opencode = await runPluginCommand("install", "opencode");
      expect(opencode.exitCode).toBe(1);
      expect(opencode.results[0]?.errors.join("\n")).toContain(
        "is not an OpenCode JSON config object",
      );
      expect(readFileSync(opencodePath, "utf8")).toBe("null\n");
    });
  });

  it("reports falsy OpenCode mcp.claudexor values as blocked unowned config", async () => {
    await withTempHome(async ({ home }) => {
      const opencodePath = join(home, ".config", "opencode", "opencode.json");
      mkdirSync(dirname(opencodePath), { recursive: true });
      writeFileSync(opencodePath, JSON.stringify({ mcp: { claudexor: false } }, null, 2) + "\n");
      const status = await runPluginCommand("status", "opencode");
      expect(status.exitCode).toBe(1); // blocked host => status exits 1
      expect(status.ok).toBe(false);
      expect(status.results[0]?.state).toBe("blocked");
      expect(status.results[0]?.errors.join("\n")).toContain("has an unowned mcp.claudexor entry");
    });
  });

  it("validates config state identity and duplicate Codex marketplace entries", async () => {
    await withTempHome(async ({ home, config }) => {
      expect((await runPluginCommand("install", "codex")).exitCode).toBe(0);
      const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
      const statePath = join(config, "plugins", "state.json");
      const state = readJson(statePath);
      state.hosts.codex.configEntries["codex-marketplace"].path = join(
        home,
        "wrong-marketplace.json",
      );
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

      const status = await runPluginCommand("status", "codex");
      expect(status.exitCode).toBe(1); // blocked host => status exits 1
      expect(status.results[0]?.state).toBe("blocked");
      expect(status.results[0]?.errors.join("\n")).toContain("out-of-scope codex config state");

      const marketplace = readJson(marketplacePath);
      marketplace.plugins.push({
        name: "claudexor",
        source: { source: "local", path: "./foreign" },
      });
      writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n");
      state.hosts.codex.configEntries["codex-marketplace"].path = marketplacePath;
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

      const repair = await runPluginCommand("repair", "codex");
      expect(repair.exitCode).toBe(1);
      expect(repair.results[0]?.errors.join("\n")).toContain("unowned claudexor marketplace entry");
      expect(
        readJson(marketplacePath).plugins.filter((p: { name?: string }) => p.name === "claudexor"),
      ).toHaveLength(2);
    });

    await withTempHome(async ({ home }) => {
      const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
      mkdirSync(dirname(marketplacePath), { recursive: true });
      const owned = {
        name: "claudexor",
        source: { source: "local", path: "./.codex/plugins/claudexor" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
        claudexor: { marker: "claudexor:managed host-plugin-lifecycle" },
      };
      writeFileSync(
        marketplacePath,
        JSON.stringify({ name: "personal", plugins: [owned, owned] }, null, 2),
      );
      const result = await runPluginCommand("install", "codex", { force: true });
      expect(result.exitCode).toBe(0);
      expect(
        readJson(marketplacePath).plugins.filter((p: { name?: string }) => p.name === "claudexor"),
      ).toHaveLength(1);
    });
  });

  it("blocks malformed OpenCode config shape on status and uninstall", async () => {
    await withTempHome(async ({ home }) => {
      const opencodePath = join(home, ".config", "opencode", "opencode.json");
      mkdirSync(dirname(opencodePath), { recursive: true });
      writeFileSync(opencodePath, JSON.stringify({ mcp: [] }, null, 2));
      const status = await runPluginCommand("status", "opencode");
      expect(status.exitCode).toBe(1); // blocked host => status exits 1
      expect(status.results[0]?.state).toBe("blocked");
      expect(status.results[0]?.errors.join("\n")).toContain("non-object mcp field");

      const uninstall = await runPluginCommand("uninstall", "opencode");
      expect(uninstall.exitCode).toBe(1);
      expect(uninstall.results[0]?.errors.join("\n")).toContain("non-object mcp field");
    });
  });

  it("blocks unowned Codex marketplace entries during uninstall", async () => {
    await withTempHome(async ({ home }) => {
      const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
      mkdirSync(dirname(marketplacePath), { recursive: true });
      writeFileSync(
        marketplacePath,
        JSON.stringify(
          {
            name: "personal",
            plugins: [{ name: "claudexor", source: { source: "local", path: "./foreign" } }],
          },
          null,
          2,
        ),
      );
      const result = await runPluginCommand("uninstall", "codex");
      expect(result.exitCode).toBe(1);
      expect(readJson(marketplacePath).plugins).toHaveLength(1);
    });
  });

  it("fails loudly on unparseable OpenCode JSONC instead of overwriting it", async () => {
    await withTempHome(async ({ home }) => {
      const cfg = join(home, ".config", "opencode", "opencode.jsonc");
      mkdirSync(dirname(cfg), { recursive: true });
      writeFileSync(cfg, "{ // comment\n}\n");
      const result = await runPluginCommand("install", "opencode");
      expect(result.exitCode).toBe(1);
      expect(result.results[0]?.state).toBe("blocked");
      expect(result.results[0]?.errors.join("\n")).toContain("not strict JSON");
    });
  });

  it("repair restores managed drift", async () => {
    await withTempHome(async ({ home }) => {
      expect((await runPluginCommand("install", "claude")).exitCode).toBe(0);
      const skill = join(home, ".claude", "skills", "claudexor", "skills", "claudexor", "SKILL.md");
      writeFileSync(skill, readFileSync(skill, "utf8") + "\nmanual drift\n");
      const status = await runPluginCommand("status", "claude");
      expect(status.results[0]?.state).toBe("drifted");
      const repair = await runPluginCommand("repair", "claude");
      expect(repair.exitCode).toBe(0);
      expect(readFileSync(skill, "utf8")).not.toContain("manual drift");
    });
  });
});
