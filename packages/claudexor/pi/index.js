import { readFileSync } from "node:fs";

/** @public Pi calls this entry when it loads the extension declared in package.json. */
export default function claudexor(pi) {
  const descriptor = JSON.parse(readFileSync(new URL("./mcp.json", import.meta.url), "utf8"));
  pi.registerMcpServer("claudexor", descriptor.mcpServers.claudexor);
}
