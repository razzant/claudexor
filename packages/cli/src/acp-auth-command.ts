import process from "node:process";
import type { ParsedArgs } from "./args.js";
import { parseArgs } from "./args.js";
import { ACP_SERVE_USAGE, resolveAcpServeAuthHarness } from "./acp-auth.js";
import { serveAcpBridge } from "./bridge-serve.js";
import { printUsageError } from "./cli-io.js";
import { authCommand } from "./ops-commands.js";

export async function dispatchAcpCommand(args: ParsedArgs, json: boolean): Promise<number> {
  if (args._[1] !== "serve") {
    return printUsageError(json, `usage: claudexor acp ${ACP_SERVE_USAGE}`);
  }
  if (args._.length === 2) return serveAcpBridge();
  const harness = resolveAcpServeAuthHarness(args._, process.platform);
  if (!harness) return printUsageError(json, `usage: claudexor acp ${ACP_SERVE_USAGE}`);
  return authCommand(parseArgs(["auth", "login", harness]), false, { acpTerminal: true });
}
