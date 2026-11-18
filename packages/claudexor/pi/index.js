import { readFileSync } from "node:fs";

export default function claudexor(pi) {
  const descriptor = JSON.parse(readFileSync(new URL("./mcp.json", import.meta.url), "utf8"));
  pi.registerMcpServer("claudexor", descriptor.mcpServers.claudexor);
}
