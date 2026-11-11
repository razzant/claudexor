import { realpathSync } from "node:fs";
import { AccessProfileIncompatibleError } from "@claudexor/core";
import type { HarnessRunSpec } from "@claudexor/schema";

/** Tool policy is portable to Windows, where the vendor OS sandbox has no
 * enforcement. Shell, MCP meta-tools, and native subagents cannot escape it. */
export function grokAccessArgs(
  spec: Pick<HarnessRunSpec, "access" | "cwd" | "auxiliary_writable_roots">,
): string[] {
  if (spec.auxiliary_writable_roots.length)
    throw new AccessProfileIncompatibleError("Grok does not support auxiliary writable roots");
  if (spec.access === "full") return ["--always-approve"];
  if (spec.access === "inherit_native") return [];
  const tools = ["read_file", "list_dir", "grep"];
  const args = [
    "--no-subagents",
    "--disallowed-tools",
    "search_tool,use_tool",
    "--permission-mode",
    "dontAsk",
    "--deny",
    "Bash",
    "--deny",
    "MCPTool",
  ];
  if (spec.access === "workspace_write") {
    const root = realpathSync(spec.cwd).replace(/\\/g, "/").replace(/\/$/, "");
    // Glob-bearing roots cannot be represented by a literal permission rule,
    // and a comma splits one `--allow` value into several rules (vendor guide);
    // no escape for it is documented.
    if (/[\[\]*?(),]/.test(root))
      throw new AccessProfileIncompatibleError(
        "Grok workspace path contains permission-rule metacharacters",
      );
    tools.push("search_replace", "write");
    args.push("--allow", `Edit(${root}/**)`, "--allow", `Write(${root}/**)`);
  } else {
    args.push("--deny", "Edit", "--deny", "Write");
  }
  return [...args, "--tools", tools.join(",")];
}
