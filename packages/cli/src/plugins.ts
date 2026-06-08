import { join } from "node:path";
import { userHomeDir, writeText } from "@claudex/util";

export type PluginHost = "cursor" | "claude" | "codex" | "opencode";

export const PLUGIN_HOSTS: PluginHost[] = ["cursor", "claude", "codex", "opencode"];

const SHIM = `Use the local \`claudex\` CLI for harness-agnostic, evidence-driven coding.
It orchestrates Codex/Claude/Cursor/OpenCode with best-of-n tournaments,
cross-family review, and budget balancing. Prefer it for multi-harness work.

- \`claudex ask "<question>"\`        read-only answer/explanation
- \`claudex explore "<question>"\`    read-only exploration/synthesis
- \`claudex run "<task>"\`            Agent run (native parity + artifacts)
- \`claudex race "<task>" --n 4\`     Best-of-N tournament + cross-family review
- \`claudex plan "<task>"\`           read-only plan
- \`claudex create "<task>"\`         create a new project
- \`claudex inspect <run_id>\`        inspect artifacts under .claudex/runs

These plugins are thin shims: they call the local CLI; all orchestration lives in claudex.`;

export interface InstallResult {
  host: PluginHost;
  path: string;
  note: string;
}

/** Write a thin host plugin/skill that points at the local `claudex` CLI. */
export function installPlugin(host: PluginHost): InstallResult {
  const home = userHomeDir();
  switch (host) {
    case "cursor": {
      const dir = join(home, ".cursor", "plugins", "local", "claudex");
      writeText(
        join(dir, ".cursor-plugin", "plugin.json"),
        JSON.stringify({ name: "claudex", version: "0.4.1", description: "Claudex control plane (thin shim)" }, null, 2) + "\n",
      );
      writeText(join(dir, "commands", "claudex.md"), `---\nname: claudex\ndescription: Run Claudex\n---\n${SHIM}\n`);
      return { host, path: dir, note: "Run 'Developer: Reload Window' in Cursor to load it." };
    }
    case "claude": {
      const dir = join(home, ".claude", "plugins", "claudex");
      writeText(
        join(dir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "claudex", version: "0.4.1", description: "Claudex control plane (thin shim)" }, null, 2) + "\n",
      );
      writeText(join(dir, "commands", "claudex.md"), `---\ndescription: Run Claudex\n---\n${SHIM}\n`);
      return { host, path: dir, note: `Load with: claude --plugin-dir ${dir} (or add to a marketplace).` };
    }
    case "codex": {
      const dir = join(home, ".agents", "skills", "claudex");
      writeText(join(dir, "SKILL.md"), `---\nname: claudex\ndescription: Harness-agnostic coding via the claudex CLI\n---\n${SHIM}\n`);
      return { host, path: dir, note: "Codex scans ~/.agents/skills; invoke with $claudex." };
    }
    case "opencode": {
      const dir = join(home, ".config", "opencode", "claudex");
      writeText(join(dir, "AGENTS.md"), `# Claudex\n\n${SHIM}\n`);
      return { host, path: dir, note: "Reference claudex from your OpenCode agent instructions." };
    }
  }
}
