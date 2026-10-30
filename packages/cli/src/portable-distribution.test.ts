import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultClaudexorTools } from "@claudexor/mcp-server";
import { afterEach, describe, expect, it } from "vitest";
import { runPluginCommand } from "./plugins.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const portableRoot = join(repoRoot, "plugins", "copilot");
const tempRoots: string[] = [];

afterEach(() => {
  for (const path of tempRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("portable Agent Skill, Copilot plugin, and MCP distribution", () => {
  it("keeps the portable skill aligned with the real MCP and generated-skill safety surface", async () => {
    const portable = readFileSync(join(portableRoot, "skills", "claudexor", "SKILL.md"), "utf8");
    const tools = defaultClaudexorTools(async () => ({}));
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(portable, `portable skill omits ${tool.name}`).toContain(`\`${tool.name}\``);
      expect(
        typeof tool.annotations?.readOnlyHint,
        `${tool.name} lacks a mutability annotation`,
      ).toBe("boolean");
    }

    const root = mkdtempSync(join(tmpdir(), "claudexor-portable-parity-"));
    tempRoots.push(root);
    const home = join(root, "home");
    const config = join(root, "config");
    const cli = join(root, "cli-stub.js");
    mkdirSync(home, { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(cli, "#!/usr/bin/env node\n", { mode: 0o700 });
    const old = {
      HOME: process.env.HOME,
      CLAUDEXOR_CONFIG_DIR: process.env.CLAUDEXOR_CONFIG_DIR,
      CLAUDEXOR_CLI_PATH: process.env.CLAUDEXOR_CLI_PATH,
      CLAUDEXOR_NODE_PATH: process.env.CLAUDEXOR_NODE_PATH,
      VITEST: process.env.VITEST,
    };
    process.env.HOME = home;
    process.env.CLAUDEXOR_CONFIG_DIR = config;
    process.env.CLAUDEXOR_CLI_PATH = cli;
    process.env.VITEST = "true";
    delete process.env.CLAUDEXOR_NODE_PATH;
    try {
      const installed = await runPluginCommand("install", "codex");
      expect(installed.exitCode).toBe(0);
      const generated = readFileSync(
        join(home, ".codex", "plugins", "claudexor", "skills", "claudexor", "SKILL.md"),
        "utf8",
      );
      for (const name of [
        "claudexor_run_wait",
        "claudexor_runs_wait",
        "claudexor_task_group_runs",
        "claudexor_run_event_read",
        "claudexor_run_message",
        "claudexor_run_continue",
        "claudexor_thread_history",
        "claudexor_thread_prompt",
        "claudexor_store_identity",
        "claudexor_upload_import",
        "claudexor_upload_create",
        "claudexor_upload_import_local",
        "claudexor_upload_status",
        "claudexor_upload_finalize",
        "claudexor_upload_cancel",
        "claudexor_next_message",
        "claudexor_next_message_read",
      ])
        expect(generated, `generated skill omits ${name}`).toContain(`\`${name}\``);
      // Independent API-reference literals shared by the shipped and generated
      // skills. Keep the old safety and host snapshots intact.
      for (const reference of [
        "`taskGroupId`",
        "`--task-group-id`",
        "`storeId`",
        "{taskGroupId, expectedStoreId?, limit?, state?, cursor?}",
        "1..200",
        "2048 characters",
        "131072 UTF-8 bytes",
        "`nextCursor`",
        "`current_served_generations`",
        "`retained_only`",
        "Missing membership grants no resubmission authority.",
        "Exact Retry and a decision",
        "Thread turns, Delegate tools and ACP session settings",
        "With only group/store saved, recover retained",
        "`problems` response keeps healthy summaries",
        "`not_found` against store/receipts/group",
        "`snapshot_unavailable` with bounded backoff",
        "`not_observed` for",
        "MCP-server host",
        "`{idempotencyKey,request:{kind,mime,name,sizeBytes}}`",
        "`{uploadId,path}`",
        "`{uploadId,idempotencyKey,request:{expectedSha256}}`",
        "`uploadId`",
        "`expectedSha256`",
        "`attachments: [{resourceId}]`",
        "`claudexor_run_continue`",
        "Omission adds no new refs; `[]` is explicit empty.",
        "`{expectedStoreId,path,idempotencyKey}`",
        "never a later store answer.",
        "A continuation inherits no attachments:",
        "Never auto-cancel an unknown finalize outcome.",
        "replay the original finalize key/body even after status 404",
        "Model-purpose resources are not ordinary attachments.",
        "plain text, Markdown, JSON, PDF and DOCX",
        "no built-in PDF/DOCX parsing or OCR promise",
        "stable keys and exact bodies",
        'action:"create"',
        'action:"replace"',
        'action:"clear"',
        "expectedRevision",
        "captures controls once",
        "complete replacement resource-ref set",
        "originally applied revision",
        "addressed bounded",
        "terminal predecessor does not resolve the draft",
        "HTTP429/willRetry",
        "Held edits do not rearm",
        "Delegate/belt callers",
      ]) {
        expect(generated).toContain(reference);
        expect(portable).toContain(reference);
      }
      for (const safety of [
        "Credentials Claudexor itself uses belong in",
        "NEVER auto-answer `claudexor decision`",
      ]) {
        expect(generated).toContain(safety);
        expect(portable).toContain(safety);
      }
      expect(portable).toContain("generated Claudexor host integration");
    } finally {
      restoreEnv(old);
    }
  });

  it("binds both portable descriptors and the registry package to the executable CLI", () => {
    const plugin = readJson(join(portableRoot, "plugin.json"));
    const pluginMcpText = readFileSync(join(portableRoot, ".mcp.json"), "utf8");
    const pluginMcp = JSON.parse(pluginMcpText);
    const server = readJson(join(repoRoot, "server.json"));
    const npmPackage = readJson(join(repoRoot, "packages", "claudexor", "package.json"));
    const root = readJson(join(repoRoot, "package.json"));

    expect(plugin.skills).toBe("skills/");
    expect(plugin.mcpServers).toBe(".mcp.json");
    expect(plugin.version).toBe(root.version);
    expect(pluginMcp).toEqual({
      mcpServers: { claudexor: { command: "claudexor", args: ["mcp", "serve"] } },
    });
    expect(pluginMcpText).not.toContain("CLAUDEXOR_PLUGIN_VERSION");
    expect(pluginMcpText).not.toContain("CLAUDEXOR_CONFIG_DIR");
    expect(npmPackage.mcpName).toBe("io.github.razzant/claudexor");
    expect(server.name).toBe(npmPackage.mcpName);
    expect(server.version).toBe(root.version);
    expect(server.packages).toEqual([
      expect.objectContaining({
        registryType: "npm",
        identifier: "claudexor",
        version: root.version,
        transport: { type: "stdio" },
        packageArguments: [
          { type: "positional", value: "mcp" },
          { type: "positional", value: "serve" },
        ],
      }),
    ]);
    expect(server.packages[0].environmentVariables).toBeUndefined();
    expect(existsSync(join(portableRoot, "README.md"))).toBe(false);
  });
});

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
