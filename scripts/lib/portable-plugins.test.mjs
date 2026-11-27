import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  HOST_DEFAULT_SKILL,
  PORTABLE_MANIFESTS,
  PORTABLE_PLUGINS,
  SKILL_TARGETS,
  composeHostSkill,
  syncPortableAssets,
} from "./portable-plugins.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const roots = [];
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const skillPath = "skills/claudexor/SKILL.md";
const lf = (text) => text.replace(/\r\n/g, "\n");
// Independent of the generator: its output is checked against this reading of the format.
const frontmatterOf = (text) => {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  expect(match, "missing Skill frontmatter").not.toBeNull();
  return parseYaml(match[1]);
};
const bodyOf = (text) =>
  lf(text)
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .trim();
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "portable-plugins-"));
  roots.push(root);
  for (const path of [
    "LICENSE",
    "plugins",
    "packages/claudexor/host-skills",
    "packages/claudexor/pi",
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
  expect(read(join(repo, "plugins/hermes/plugin.json"))).toMatchObject({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "claudexor",
    extensions: {
      "com.nousresearch.hermes": {
        servers: { claudexor: { trust: "untrusted" } },
      },
    },
  });
  for (const plugin of PORTABLE_PLUGINS) {
    const stdio = { command: "claudexor", args: ["mcp", "serve"] };
    const expected =
      plugin.root === "plugins/hermes"
        ? {
            $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
            mcpServers: { claudexor: { type: "stdio", ...stdio } },
          }
        : { mcpServers: { claudexor: stdio } };
    expect(read(join(repo, plugin.root, plugin.mcp))).toEqual(expected);
  }
  for (const path of PORTABLE_MANIFESTS) {
    expect(read(join(repo, path)).version).toBe(read(join(repo, "package.json")).version);
  }
  const nodeFloor = read(join(repo, "package.json"))
    .engines.node.replace(/^>=/, "")
    .replace(/\.0$/, "");
  const skill = readFileSync(join(repo, "plugins/copilot", skillPath), "utf8");
  expect(frontmatterOf(skill)).toMatchObject({
    name: "claudexor",
    description: expect.stringMatching(/\S/),
  });
  expect(skill).toContain(`Require Node.js ${nodeFloor} or newer`);
});

test("only Hermes and Pi change the shared Skill: a routing line, then a default section above its body", () => {
  const skill = readFileSync(join(repo, "plugins/copilot", skillPath), "utf8");
  const hostSource = readFileSync(join(repo, HOST_DEFAULT_SKILL), "utf8");
  const heading = "# Claudexor\n";
  const sharedRest = bodyOf(skill).slice(heading.length).trim();
  const routing = "Reviewing code? Read this skill, then call claudexor_ask.";
  expect(frontmatterOf(hostSource).description).toBe(routing);
  expect(SKILL_TARGETS.filter((target) => target.hostSkill).map((target) => target.root)).toEqual([
    "plugins/hermes",
    "packages/claudexor/pi",
  ]);
  for (const target of SKILL_TARGETS) {
    const shipped = readFileSync(join(repo, target.root, skillPath), "utf8");
    if (!target.hostSkill) {
      // Cursor, and the Claude-format bundle that OpenClaw loads, keep the shared Skill as it is.
      expect(shipped).toBe(skill);
      continue;
    }
    expect(shipped).toBe(composeHostSkill(skill, hostSource));
    // Every other canonical field survives; the description is the routing line alone.
    expect(frontmatterOf(shipped)).toEqual({ ...frontmatterOf(skill), description: routing });
    expect(lf(shipped)).toContain(`\ndescription: ${routing}\n`);
    // Hermes clips a description in its system-prompt skill index to SKILL_PROMPT_DESC_LIMIT (60
    // characters, agent/skill_utils.py): keep the entire routing line visible.
    expect(routing.length).toBeLessThanOrEqual(60);
    expect(frontmatterOf(shipped).description.slice(0, 60)).toContain("claudexor_ask");
    expect(bodyOf(shipped)).toBe(`${heading}\n${bodyOf(hostSource)}\n\n${sharedRest}`);
  }
});

test("the default section calls only Ask, wait and result", () => {
  // Registration is not provable by grepping sources: the private `claudexor_ask` tool is
  // registered by delegation-belt.ts, and tool names can appear in comments or strings.
  // The production registry check lives in packages/cli/src/portable-distribution.test.ts,
  // which builds the shipped MCP tool list via defaultClaudexorTools.
  const section = readFileSync(join(repo, HOST_DEFAULT_SKILL), "utf8");
  expect(section.match(/`claudexor_[a-z_]+`/g)?.length).toBeGreaterThan(0);
  // The default adds no probe of its own: Ask, then wait, then result.
  expect(section.match(/calls only([^.]*)\./)?.[1].match(/claudexor_[a-z_]+/g)).toEqual([
    "claudexor_ask",
    "claudexor_run_wait",
    "claudexor_run_result",
  ]);
});

test("composition keeps every canonical field and quotes the description safely", () => {
  const canonical =
    "---\nname: claudexor\nlicense: MIT\ndescription: 'Use it: \"carefully\" # not a comment'\n---\n\n" +
    "# Claudexor\n\nShared.\n";
  const host = '---\ndescription: "Review code? Call it: now."\n---\n\n## Default\n\nHost rule.\n';
  const composed = composeHostSkill(canonical, host);
  expect(frontmatterOf(composed)).toEqual({
    name: "claudexor",
    license: "MIT",
    description: "Review code? Call it: now.",
  });
  expect(bodyOf(composed)).toBe("# Claudexor\n\n## Default\n\nHost rule.\n\nShared.");
  expect(() => composeHostSkill(canonical, "---\nname: x\ndescription: y\n---\n\nz\n")).toThrow(
    "may only set its description",
  );
  for (const description of [">\n  folded", "one\n  two", "", "plain # comment"]) {
    const folded = canonical.replace(/description: .*/, `description: ${description}`);
    expect(() => composeHostSkill(folded, host)).toThrow("one-line YAML scalar");
  }
  // YAML 1.1 boolean/null words must round-trip as strings, not coerce in a host that
  // reads the frontmatter with a YAML parser: quote them on write and read them back.
  for (const description of ["true", "false", "null", "yes", "42"]) {
    const quoted = host.replace(/description: .*/, `description: ${JSON.stringify(description)}`);
    const roundTrip = composeHostSkill(canonical, quoted);
    expect(frontmatterOf(roundTrip).description).toBe(description);
  }
});

test("a quoted source description keeps its quotes through composition", () => {
  const canonical =
    "---\nname: claudexor\nlicense: MIT\ndescription: plain-index-line\n---\n\n" +
    "# Claudexor\n\nShared.\n";
  const host = "---\ndescription: '0b10'\n---\n\n## Default\n\nHost rule.\n";
  const composed = composeHostSkill(canonical, host);
  // An independent YAML parser must read the description back as the string.
  expect(frontmatterOf(composed).description).toBe("0b10");
  expect(lf(composed)).toContain('\ndescription: "0b10"\n');
});

test("both self-hosted indexes resolve the corresponding contained plugin", () => {
  for (const [host, folder, mcp, skills] of [
    ["cursor", ".cursor-plugin", "mcp.json", ["./skills/claudexor"]],
    ["claude", ".claude-plugin", ".mcp.json", "./skills/"],
  ]) {
    const catalog = read(join(repo, folder, "marketplace.json"));
    expect(catalog.name).toBe("claudexor");
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0].source).toBe(`./plugins/${host}`);
    const manifest = read(join(repo, catalog.plugins[0].source, folder, "plugin.json"));
    expect(manifest.name).toBe(catalog.plugins[0].name);
    expect(manifest.mcpServers).toBe(`./${mcp}`);
    expect(manifest.hooks).toBeUndefined();
    expect(manifest.skills).toEqual(skills);
  }
});

test("generation projects a new version to every manifest and restores asset drift", () => {
  const root = fixture();
  const copy = (target) => join(root, target.root, skillPath);
  const skill = copy({ root: "plugins/cursor" });
  const hostCopies = SKILL_TARGETS.filter((target) => target.hostSkill).map(copy);
  writeFileSync(skill, "stale copy\n");
  for (const path of hostCopies) writeFileSync(path, "stale copy\n");
  expect(() => syncPortableAssets(root, true)).toThrow("SKILL.md drifted");
  const pi = join(root, "packages/claudexor/pi/mcp.json");
  writeFileSync(pi, '{"mcpServers":{}}\n');
  writeFileSync(join(root, "LICENSE"), "updated fixture license\n");
  execFileSync(process.execPath, ["scripts/gen-version.mjs"], { cwd: root });
  expect(() => syncPortableAssets(root, true)).not.toThrow();
  expect(readFileSync(skill)).toEqual(readFileSync(join(root, "plugins/copilot", skillPath)));
  const hostSource = join(root, HOST_DEFAULT_SKILL);
  for (const path of hostCopies) {
    expect(readFileSync(path, "utf8")).toBe(
      composeHostSkill(
        readFileSync(join(root, "plugins/copilot", skillPath), "utf8"),
        readFileSync(hostSource, "utf8"),
      ),
    );
  }
  // An edited default section reaches both host Skills, and no other host.
  writeFileSync(hostSource, `${readFileSync(hostSource, "utf8")}\nExtra rule.\n`);
  expect(() => syncPortableAssets(root, true)).toThrow("SKILL.md drifted");
  syncPortableAssets(root);
  for (const path of hostCopies) expect(readFileSync(path, "utf8")).toContain("Extra rule.");
  expect(readFileSync(skill, "utf8")).not.toContain("Extra rule.");
  expect(readFileSync(pi)).toEqual(readFileSync(join(root, "plugins/copilot/.mcp.json")));
  for (const bundle of ["plugins/hermes", "plugins/claude"]) {
    expect(readFileSync(join(root, bundle, "LICENSE"), "utf8")).toBe("updated fixture license\n");
  }
  for (const path of PORTABLE_MANIFESTS) expect(read(join(root, path)).version).toBe("9.8.7");
  expect(read(join(root, "server.json")).packages[0].version).toBe("9.8.7");
  expect(readFileSync(join(root, "packages/util/src/version.ts"), "utf8")).toContain('"9.8.7"');
});

test.each([
  ["LF", "\n"],
  ["CRLF", "\r\n"],
])("a %s checkout keeps its line endings and rewrites no unchanged host", (_name, eol) => {
  const root = fixture();
  const skills = [
    join(root, "plugins/copilot", skillPath),
    join(root, HOST_DEFAULT_SKILL),
    ...SKILL_TARGETS.map((target) => join(root, target.root, skillPath)),
  ];
  // What a checkout with core.autocrlf produces: every tracked text file in one line ending.
  for (const path of skills)
    writeFileSync(path, lf(readFileSync(path, "utf8")).replace(/\n/g, eol));
  const before = skills.map((path) => readFileSync(path));
  expect(() => syncPortableAssets(root, true)).not.toThrow();
  syncPortableAssets(root);
  skills.forEach((path, index) => expect(readFileSync(path)).toEqual(before[index]));
  for (const target of SKILL_TARGETS) {
    const text = readFileSync(join(root, target.root, skillPath), "utf8");
    expect(text.replaceAll(eol, "")).not.toMatch(/[\r\n]/);
  }
});

test.each(["plugins/claude/.mcp.json", "packages/claudexor/pi/mcp.json"])(
  "check mode rejects changes to %s without rewriting it",
  (path) => {
    const root = fixture();
    const target = join(root, path);
    writeFileSync(target, '{"mcpServers":{}}\n');
    expect(() => syncPortableAssets(root, true)).toThrow("mcp.json drifted");
    expect(read(target)).toEqual({ mcpServers: {} });
  },
);
