import { readFileSync } from "node:fs";

// Host packaging only: Pi lists these read-only run tools for the model directly, so the Skill's
// default second opinion (Ask, wait, result) needs no tool search. Every other tool keeps Pi's own
// default exposure. Listing a tool neither makes the model read the Skill nor changes any schema
// default.
const directTools = [
  "claudexor_ask",
  "claudexor_run_wait",
  "claudexor_run_status",
  "claudexor_run_result",
];

/** @public Pi calls this entry when it loads the extension declared in package.json. */
export default function claudexor(pi) {
  const descriptor = JSON.parse(readFileSync(new URL("./mcp.json", import.meta.url), "utf8"));
  pi.registerMcpServer("claudexor", {
    ...descriptor.mcpServers.claudexor,
    description:
      "Local Claudexor control plane: runs, plans and answers on Claude Code, Codex, Cursor and OpenCode accounts.",
    toolExposure: Object.fromEntries(directTools.map((tool) => [tool, "direct"])),
  });
}
