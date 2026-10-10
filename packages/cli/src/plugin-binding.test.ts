import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalHostBinding } from "@claudexor/schema";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { runPluginCommand } from "./plugins.js";
import { generatedMcpEnv, launchShellCommand } from "./plugin-runtime.js";

const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const sources = [
  ".claude/skills/claudexor/.mcp.json",
  ".codex/plugins/claudexor/.mcp.json",
  ".cursor/plugins/local/claudexor/mcp.json",
];

describe("external host plugin binding", () => {
  let dir: string;
  let home: string;
  let root: string;
  let binding: ExternalHostBinding;
  let selection: string;
  let observed: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cx-bind-"));
    home = join(dir, "host's home");
    root = join(dir, "host's root");
    mkdirSync(home);
    selection = join(dir, "selected-runtime");
    observed = join(dir, "observed.json");
    const locator = join(dir, "host's locator.mjs");
    writeFileSync(
      locator,
      `import { readFileSync } from 'node:fs';\nimport { pathToFileURL } from 'node:url';\nawait import(pathToFileURL(readFileSync(${JSON.stringify(selection)}, 'utf8')).href);\n`,
    );
    binding = {
      schemaVersion: 1,
      command: [process.execPath, locator],
      configDir: root,
      daemonOwner: "external",
    };
    vi.stubEnv("HOME", home);
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(dir, "unrelated-root"));
    vi.stubEnv("CLAUDEXOR_CLI_PATH", locator);
    vi.stubEnv("CLAUDEXOR_DAEMON_SOCK", join(dir, "wrong.sock"));
    vi.stubEnv("CLAUDEXOR_DAEMON_ENTRY", join(dir, "must-not-start.js"));
    vi.stubEnv("CLAUDEXOR_PLUGIN_VERSION", "0.0.1");
    selectRuntime("A");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function selectRuntime(version: string): void {
    const file = join(dir, `runtime-${version}.mjs`);
    writeFileSync(
      file,
      `
import { writeFileSync } from 'node:fs';
import { serveClaudexorMcp, defaultClaudexorTools } from ${JSON.stringify(pathToFileURL(resolve("packages/mcp-server/dist/index.js")).href)};
const observation = { version: ${JSON.stringify(version)}, root: process.env.CLAUDEXOR_CONFIG_DIR, owner: process.env.CLAUDEXOR_DAEMON_OWNER, socket: process.env.CLAUDEXOR_DAEMON_SOCK, entry: process.env.CLAUDEXOR_DAEMON_ENTRY };
writeFileSync(${JSON.stringify(observed)}, JSON.stringify(observation));
if (process.argv[2] === 'mcp') {
  const server = serveClaudexorMcp({ version: ${JSON.stringify(version)}, tools: defaultClaudexorTools(async () => ({ summary: 'fixture' })), transport: { read: process.stdin, write: process.stdout } });
  process.stdin.once('close', () => void server.close());
} else if (process.argv[2] === 'quota') {
  const { runClaudeStatuslineCollector } = await import(${JSON.stringify(pathToFileURL(resolve("packages/cli/dist/claude-statusline.js")).href)});
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  await runClaudeStatuslineCollector(input, process.argv[5]);
} else process.stdout.write(JSON.stringify(observation));
`,
    );
    writeFileSync(selection, file);
  }

  function entries(): any[] {
    return [
      ...sources.map((path) => json(join(home, path)).mcpServers.claudexor),
      json(join(home, ".config/opencode/opencode.json")).mcp.claudexor,
    ];
  }

  it("install, wrong-root repair and uninstall retain all host bindings and the previous statusline", async () => {
    const settings = join(home, ".claude/settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    const previous = { type: "command", command: "printf 'upstream:'; cat", padding: 3 };
    writeFileSync(settings, JSON.stringify({ theme: "dark", statusLine: previous }));
    const install = await runPluginCommand("install", "all", { hostBinding: binding });
    expect(install.results.flatMap((item) => item.errors)).toEqual([]);
    expect(install.exitCode).toBe(0);
    for (const entry of entries()) {
      const env = entry.env ?? entry.environment;
      expect(env).toMatchObject({
        CLAUDEXOR_DAEMON_OWNER: "external",
        CLAUDEXOR_CONFIG_DIR: root,
        CLAUDEXOR_ROOT_MODE: "explicit",
        CLAUDEXOR_HOST_BINDING_VERSION: "1",
      });
      expect(env.CLAUDEXOR_PLUGIN_VERSION).toBeUndefined();
      expect(Array.isArray(entry.command) ? entry.command : [entry.command, ...entry.args]).toEqual(
        [...binding.command, "mcp", "serve"],
      );
    }
    expect(json(join(home, ".codex/plugins/claudexor/.codex-plugin/plugin.json")).version).toBe(
      CLAUDEXOR_VERSION,
    );
    expect(existsSync(join(dir, "unrelated-root"))).toBe(false);
    const repair = await runPluginCommand("repair", "all", { force: true });
    expect(repair.results.flatMap((item) => item.errors)).toEqual([]);
    expect(repair.exitCode).toBe(0);
    expect((await runPluginCommand("repair", "all")).results.every((item) => !item.changed)).toBe(
      true,
    );
    expect(
      Object.values(json(join(root, "plugins/state.json")).hosts).map((item: any) => item.binding),
    ).toEqual(Array(4).fill(binding));
    const relocated = { ...binding, configDir: join(dir, "relocated-root") };
    const move = await runPluginCommand("repair", "all", { hostBinding: relocated });
    expect(move.exitCode, JSON.stringify(move)).toBe(0);
    expect(json(settings).statusLine.command).toContain("relocated-root");
    expect((await runPluginCommand("uninstall", "all")).exitCode).toBe(0);
    expect(json(settings)).toEqual({ theme: "dark", statusLine: previous });
    expect(existsSync(join(dir, "unrelated-root"))).toBe(false);
  });

  it("a stable host command executes runtime A then B through MCP and shell, preserving statusline stdin/stdout", async () => {
    const settings = join(home, ".claude/settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    const upstream = join(dir, "upstream.mjs");
    writeFileSync(
      upstream,
      "process.stdout.write('upstream:'); for await (const chunk of process.stdin) process.stdout.write(chunk);",
    );
    writeFileSync(
      settings,
      JSON.stringify({
        statusLine: { type: "command", command: `"${process.execPath}" "${upstream}"`, padding: 2 },
      }),
    );
    expect((await runPluginCommand("install", "all", { hostBinding: binding })).exitCode).toBe(0);
    expect((await runPluginCommand("doctor", "all")).exitCode).toBe(0);
    expect(json(observed)).toMatchObject({
      version: "A",
      root,
      owner: "external",
      socket: "",
      entry: "",
    });
    selectRuntime("B");
    expect((await runPluginCommand("doctor", "all")).exitCode).toBe(0);
    expect(json(observed).version).toBe("B");
    const skill = readFileSync(
      join(home, ".codex/plugins/claudexor/skills/claudexor/SKILL.md"),
      "utf8",
    );
    const fallback = skill
      .split("\n")
      .find(
        (line) =>
          line.startsWith(process.platform === "win32" ? "`$env:" : "`env ") &&
          line.includes(' ask "..."'),
      )
      ?.slice(1, -1);
    expect(fallback).toBeTruthy();
    const run =
      process.platform === "win32"
        ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", fallback!], {
            encoding: "utf8",
          })
        : spawnSync("/bin/sh", ["-c", fallback!], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ version: "B", root, owner: "external" });
    const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 14 } } });
    const status =
      process.platform === "win32"
        ? spawnSync("cmd.exe", ["/d", "/s", "/c", json(settings).statusLine.command], {
            input,
            encoding: "utf8",
          })
        : spawnSync("/bin/sh", ["-c", json(settings).statusLine.command], {
            input,
            encoding: "utf8",
          });
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toBe(`upstream:${input}`);
    expect(json(join(root, "quota/claude-statusline.json")).constraints[0].used_ratio).toBe(0.14);
    expect(existsSync(join(dir, "unrelated-root"))).toBe(false);
  });

  it("reconstructs a missing source from its ledger and discloses recovery of a lost ledger", async () => {
    expect((await runPluginCommand("install", "all", { hostBinding: binding })).exitCode).toBe(0);
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", root);
    const source = join(home, sources[1]!);
    rmSync(source);
    expect((await runPluginCommand("repair", "codex")).exitCode).toBe(0);
    expect(json(source).mcpServers.claudexor.args).toEqual([
      ...binding.command.slice(1),
      "mcp",
      "serve",
    ]);
    rmSync(join(root, "plugins/state.json"));
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(dir, "wrong-root"));
    const recovered = await runPluginCommand("repair", "all");
    expect(recovered.exitCode, JSON.stringify(recovered)).toBe(0);
    expect(
      recovered.results.every((item) =>
        item.notes.some((note) => note.includes("recovered external host binding")),
      ),
    ).toBe(true);
    rmSync(join(root, "plugins/state.json"));
    rmSync(source);
    const missing = await runPluginCommand("repair", "codex", { force: true });
    expect(missing.exitCode).toBe(1);
    expect(missing.results[0]?.errors.join()).toContain("external host binding is missing");
    expect(existsSync(source)).toBe(false);
    expect(existsSync(join(dir, "wrong-root"))).toBe(false);
  });

  it("all preserves independent host roots rather than copying one host's binding", async () => {
    const second: ExternalHostBinding = { ...binding, configDir: join(dir, "second-root") };
    await runPluginCommand("install", "all", { hostBinding: binding });
    await runPluginCommand("repair", "cursor", { hostBinding: second });
    expect((await runPluginCommand("repair", "all")).exitCode).toBe(0);
    expect(json(join(home, sources[1]!)).mcpServers.claudexor.env.CLAUDEXOR_CONFIG_DIR).toBe(root);
    expect(json(join(home, sources[2]!)).mcpServers.claudexor.env.CLAUDEXOR_CONFIG_DIR).toBe(
      second.configDir,
    );
  });

  it("renders a named PowerShell form and keeps standalone custom roots standalone", () => {
    const runtime = { configDir: root, nodePath: process.execPath, cliPath: "fixture.js", binding };
    expect(launchShellCommand(runtime, "ask 'hello'", "win32")).toContain(
      "$env:CLAUDEXOR_CONFIG_DIR='",
    );
    const wrapped = launchShellCommand(
      runtime,
      "quota ingest-claude-statusline managed-v2",
      "win32",
      true,
    );
    expect(wrapped).toMatch(/^powershell.exe -NoProfile -NonInteractive -EncodedCommand /);
    expect(Buffer.from(wrapped.split(" ").at(-1)!, "base64").toString("utf16le")).toContain(
      "host''s locator.mjs",
    );
    expect(generatedMcpEnv({ ...runtime, binding: undefined })).toMatchObject({
      CLAUDEXOR_CONFIG_DIR: root,
      CLAUDEXOR_DAEMON_OWNER: "standalone",
      CLAUDEXOR_PLUGIN_VERSION: CLAUDEXOR_VERSION,
    });
  });

  it("accepts explicit registration through the acting CLI and repairs a damaged binding", async () => {
    const cli = resolve("packages/cli/dist/cli.js");
    const install = spawnSync(
      process.execPath,
      [cli, "plugin", "install", "codex", "--host-binding-json", JSON.stringify(binding), "--json"],
      { encoding: "utf8", env: process.env },
    );
    expect(install.status, install.stderr).toBe(0);
    expect(JSON.parse(install.stdout).ok).toBe(true);
    const path = join(home, sources[1]!);
    const source = json(path);
    source.mcpServers.claudexor.env.CLAUDEXOR_HOST_BINDING_VERSION = "2";
    writeFileSync(path, JSON.stringify(source));
    expect((await runPluginCommand("repair", "codex")).exitCode).toBe(1);
    expect((await runPluginCommand("repair", "codex", { hostBinding: binding })).exitCode).toBe(0);
    expect(json(path).mcpServers.claudexor.env.CLAUDEXOR_HOST_BINDING_VERSION).toBe("1");
    expect(existsSync(join(dir, "unrelated-root"))).toBe(false);
  });
});
