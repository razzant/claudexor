import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { PORTABLE_MANIFESTS, PORTABLE_PLUGINS, syncPortableAssets } from "./portable-plugins.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const roots = [];
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "portable-plugins-"));
  roots.push(root);
  for (const path of [
    "plugins",
    "server.json",
    "scripts/gen-version.mjs",
    "scripts/lib/portable-plugins.mjs",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repo, path), join(root, path), { recursive: true });
  }
  mkdirSync(join(root, "packages/util/src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.8.7" }));
  return root;
}

test("portable packages share the existing preinstalled CLI bridge and exact Skill", () => {
  expect(() => syncPortableAssets(repo, true)).not.toThrow();
  for (const plugin of PORTABLE_PLUGINS) {
    expect(read(join(repo, plugin.root, plugin.mcp))).toEqual({
      mcpServers: { claudexor: { command: "claudexor", args: ["mcp", "serve"] } },
    });
  }
  for (const path of PORTABLE_MANIFESTS) {
    expect(read(join(repo, path)).version).toBe(read(join(repo, "package.json")).version);
  }
  const nodeFloor = read(join(repo, "package.json"))
    .engines.node.replace(/^>=/, "")
    .replace(/\.0$/, "");
  expect(readFileSync(join(repo, "plugins/copilot/skills/claudexor/SKILL.md"), "utf8")).toContain(
    `Require Node.js ${nodeFloor} or newer`,
  );
});

test("both self-hosted indexes resolve the corresponding contained plugin", () => {
  for (const [host, folder, mcp] of [
    ["cursor", ".cursor-plugin", "mcp.json"],
    ["claude", ".claude-plugin", ".mcp.json"],
  ]) {
    const catalog = read(join(repo, folder, "marketplace.json"));
    expect(catalog.name).toBe("claudexor");
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0].source).toBe(`./plugins/${host}`);
    const manifest = read(join(repo, catalog.plugins[0].source, folder, "plugin.json"));
    expect(manifest.name).toBe(catalog.plugins[0].name);
    expect(manifest.mcpServers).toBe(`./${mcp}`);
    expect(manifest.hooks).toBeUndefined();
    const paths = Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills];
    for (const path of paths) {
      expect(path.startsWith("./skills/")).toBe(true);
    }
  }
});

test("generation projects a new version to every manifest and restores asset drift", () => {
  const root = fixture();
  const skill = join(root, "plugins/cursor/skills/claudexor/SKILL.md");
  writeFileSync(skill, "stale copy\n");
  expect(() => syncPortableAssets(root, true)).toThrow("drifted");
  execFileSync(process.execPath, ["scripts/gen-version.mjs"], { cwd: root });
  expect(() => syncPortableAssets(root, true)).not.toThrow();
  for (const path of PORTABLE_MANIFESTS) expect(read(join(root, path)).version).toBe("9.8.7");
  expect(read(join(root, "server.json")).packages[0].version).toBe("9.8.7");
  expect(readFileSync(join(root, "packages/util/src/version.ts"), "utf8")).toContain('"9.8.7"');
});

test("check mode rejects an altered MCP route without rewriting it", () => {
  const root = fixture();
  const target = join(root, "plugins/claude/.mcp.json");
  writeFileSync(target, '{"mcpServers":{}}\n');
  expect(() => syncPortableAssets(root, true)).toThrow("drifted");
  expect(read(target)).toEqual({ mcpServers: {} });
});
