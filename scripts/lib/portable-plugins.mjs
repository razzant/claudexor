import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PORTABLE_PLUGINS = [
  { root: "plugins/copilot", manifest: "plugin.json", mcp: ".mcp.json" },
  { root: "plugins/cursor", manifest: ".cursor-plugin/plugin.json", mcp: "mcp.json" },
  { root: "plugins/claude", manifest: ".claude-plugin/plugin.json", mcp: ".mcp.json" },
  { root: "plugins/hermes", manifest: "plugin.json", mcp: "mcp.json", hostSkill: true },
];

export const PORTABLE_MANIFESTS = PORTABLE_PLUGINS.map(
  ({ root, manifest }) => `${root}/${manifest}`,
);

/** Source of the default second opinion that Hermes and Pi add above the shared Skill body. */
export const HOST_DEFAULT_SKILL = "packages/claudexor/host-skills/default-second-opinion.md";

/**
 * Every copy of the canonical Skill and MCP descriptor, in one list. A `hostSkill` target ships
 * the shared body below HOST_DEFAULT_SKILL; every other target ships the canonical Skill byte
 * for byte, whatever its line endings.
 */
export const SKILL_TARGETS = [
  ...PORTABLE_PLUGINS.slice(1),
  { root: "packages/claudexor/pi", mcp: "mcp.json", hostSkill: true },
];

const SKILL_PATH = "skills/claudexor/SKILL.md";

/** Split a Skill file into its frontmatter lines and its body, both with LF endings. */
function splitSkill(text) {
  const lf = text.replace(/\r\n/g, "\n");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(lf);
  if (!match) throw new Error("Skill file has no frontmatter");
  return { lines: match[1].split("\n"), body: lf.slice(match[0].length) };
}

/** The description line of a frontmatter and its value; only the one-line forms are supported. */
function descriptionOf(lines) {
  const index = lines.findIndex((line) => line.startsWith("description:"));
  const raw = index < 0 ? "" : lines[index].slice("description:".length).trim();
  const quote = /^(["'])([\s\S]*)\1$/.exec(raw);
  let value = raw;
  try {
    if (quote?.[1] === '"') value = JSON.parse(raw);
    else if (quote) value = quote[2].replaceAll("''", "'");
  } catch {
    value = "";
  }
  if (
    value === "" ||
    /^[>|&*!\[{]/.test(raw) ||
    (!quote && / #/.test(raw)) ||
    /^[ \t]/.test(lines[index + 1] ?? "")
  ) {
    throw new Error("a Skill description must be a non-empty one-line YAML scalar");
  }
  return { index, value, quoted: Boolean(quote) };
}

/** YAML 1.1 boolean and null words that a plain scalar would silently coerce. */
const plainNonString =
  /^(?:0x[0-9a-fA-F_]+|0o[0-7_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|true|false|yes|no|on|off|null)$/i;

/**
 * A YAML scalar for a description: plain when every parser reads it back
 * unchanged, else quoted. A quoted source description keeps explicit quotes
 * on write, so a host reading the frontmatter with a YAML parser cannot
 * coerce it (YAML 1.1 reads the plain `0b10` as the integer 2).
 */
const yamlScalar = (description) =>
  !description.quoted &&
  /^[A-Za-z0-9]/.test(description.value) &&
  !plainNonString.test(description.value) &&
  !/[\r\n\t]|: | #|:$/.test(description.value)
    ? description.value
    : JSON.stringify(description.value);

/**
 * Compose one host Skill: replace only the canonical description with the host's routing line,
 * then insert the host's default section above the shared body. The canonical Skill stays the
 * single source of every shared rule and other frontmatter field. The result
 * keeps the canonical line endings. This module imports nothing but node built-ins because
 * workflows run it without installed dependencies.
 */
export function composeHostSkill(canonical, hostSource) {
  const shared = splitSkill(canonical);
  const host = splitSkill(hostSource);
  const routing = descriptionOf(host.lines);
  if (host.lines.some((line) => /^[^\s#]/.test(line) && !line.startsWith("description:"))) {
    throw new Error("host Skill source may only set its description");
  }
  const { index } = descriptionOf(shared.lines);
  const lines = [...shared.lines];
  lines[index] = `description: ${yamlScalar(routing)}`;
  const heading = "# Claudexor\n";
  const sharedBody = shared.body.replace(/^\n+/, "");
  if (!sharedBody.startsWith(heading)) {
    throw new Error("canonical Skill lost its # Claudexor heading");
  }
  const text =
    `---\n${lines.join("\n")}\n---\n\n${heading}\n` +
    `${host.body.trim()}\n\n${sharedBody.slice(heading.length).replace(/^\n+/, "")}`;
  return canonical.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
}

export function syncPortableAssets(root, check = false) {
  const source = PORTABLE_PLUGINS[0];
  const skill = readFileSync(join(root, source.root, SKILL_PATH));
  const mcp = readFileSync(join(root, source.root, source.mcp));
  const license = readFileSync(join(root, "LICENSE"));
  const hostSkill = Buffer.from(
    composeHostSkill(skill.toString("utf8"), readFileSync(join(root, HOST_DEFAULT_SKILL), "utf8")),
  );

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

  for (const target of SKILL_TARGETS) {
    project(join(target.root, SKILL_PATH), target.hostSkill ? hostSkill : skill);
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
