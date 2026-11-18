import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PORTABLE_PLUGINS = [
  { root: "plugins/copilot", manifest: "plugin.json", mcp: ".mcp.json" },
  { root: "plugins/cursor", manifest: ".cursor-plugin/plugin.json", mcp: "mcp.json" },
  { root: "plugins/claude", manifest: ".claude-plugin/plugin.json", mcp: ".mcp.json" },
  { root: "plugins/hermes", manifest: "plugin.json", mcp: "mcp.json" },
];

export const PORTABLE_MANIFESTS = PORTABLE_PLUGINS.map(
  ({ root, manifest }) => `${root}/${manifest}`,
);

export function syncPortableAssets(root, check = false) {
  const source = PORTABLE_PLUGINS[0];
  const skillPath = "skills/claudexor/SKILL.md";
  const skill = readFileSync(join(root, source.root, skillPath));
  const mcp = readFileSync(join(root, source.root, source.mcp));
  const license = readFileSync(join(root, "LICENSE"));

  function project(path, bytes) {
    const output = join(root, path);
    if (check) {
      if (!bytes.equals(readFileSync(output))) {
        throw new Error(`${path} drifted; run pnpm gen:version`);
      }
    } else {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, bytes);
    }
  }

  for (const target of [
    ...PORTABLE_PLUGINS.slice(1),
    { root: "packages/claudexor/pi", mcp: "mcp.json" },
  ]) {
    project(join(target.root, skillPath), skill);
    project(
      join(target.root, target.mcp),
      target.root === "plugins/hermes" ? agentPluginsMcp(mcp) : mcp,
    );
  }
  // These two subdirectories also ship independently as MIT bundles.
  for (const bundle of ["plugins/hermes", "plugins/claude"])
    project(join(bundle, "LICENSE"), license);
}

function agentPluginsMcp(source) {
  const servers = JSON.parse(source).mcpServers;
  const mcpServers = Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, { type: "stdio", ...server }]),
  );
  const descriptor = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers,
  };
  return Buffer.from(JSON.stringify(descriptor, null, 2) + "\n");
}
