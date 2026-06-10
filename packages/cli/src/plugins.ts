import { join } from "node:path";
import { userHomeDir, writeText } from "@claudexor/util";

export type PluginHost = "cursor" | "claude" | "codex" | "opencode";

export const PLUGIN_HOSTS: PluginHost[] = ["cursor", "claude", "codex", "opencode"];

const SHIM = `Use the local \`claudexor\` CLI for harness-agnostic, evidence-driven coding.
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

export interface InstallResult {
  host: PluginHost;
  path: string;
  note: string;
}

/** Write a thin host plugin/skill that points at the local `claudexor` CLI. */
export function installPlugin(host: PluginHost): InstallResult {
  const home = userHomeDir();
  switch (host) {
    case "cursor": {
      const dir = join(home, ".cursor", "plugins", "local", "claudexor");
      writeText(
        join(dir, ".cursor-plugin", "plugin.json"),
        JSON.stringify({ name: "claudexor", version: "0.7.0", description: "Claudexor control plane (thin shim)" }, null, 2) + "\n",
      );
      writeText(join(dir, "commands", "claudexor.md"), `---\nname: claudexor\ndescription: Run Claudexor\n---\n${SHIM}\n`);
      return { host, path: dir, note: "Run 'Developer: Reload Window' in Cursor to load it." };
    }
    case "claude": {
      const dir = join(home, ".claude", "plugins", "claudexor");
      writeText(
        join(dir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "claudexor", version: "0.7.0", description: "Claudexor control plane (thin shim)" }, null, 2) + "\n",
      );
      writeText(join(dir, "commands", "claudexor.md"), `---\ndescription: Run Claudexor\n---\n${SHIM}\n`);
      return { host, path: dir, note: `Load with: claude --plugin-dir ${dir} (or add to a marketplace).` };
    }
    case "codex": {
      const dir = join(home, ".agents", "skills", "claudexor");
      writeText(join(dir, "SKILL.md"), `---\nname: claudexor\ndescription: Harness-agnostic coding via the claudexor CLI\n---\n${SHIM}\n`);
      return { host, path: dir, note: "Codex scans ~/.agents/skills; invoke with $claudexor." };
    }
    case "opencode": {
      const dir = join(home, ".config", "opencode", "claudexor");
      writeText(join(dir, "AGENTS.md"), `# Claudexor\n\n${SHIM}\n`);
      return { host, path: dir, note: "Reference claudexor from your OpenCode agent instructions." };
    }
  }
}
