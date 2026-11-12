import { flagBool, type ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { subcommandFlagScopeError } from "./command-scope.js";
import { HARNESS_USAGE_ARGS } from "./harness-command-specs.js";
import { harnessInstallCommand, retiredInstallFlags } from "./harness-installer.js";
import { harnessInspectCommand, harnessUpdateCommand } from "./harness-maintenance-command.js";
import { buildRegistry } from "./registry.js";

/** Thin CLI projection of adapter declarations and the shared vendor operation. */
export function harnessCommand(args: ParsedArgs, json: boolean): number | Promise<number> {
  const sub = args._[1] ?? "";
  if (sub === "install" || sub === "update") {
    const retired = retiredInstallFlags(args);
    if (retired) return printUsageError(json, retired);
  }
  const scopeError = subcommandFlagScopeError("harness", sub, Object.keys(args.flags));
  if (scopeError) return printUsageError(json, scopeError);
  if (args._[1] === "list") {
    const includeFakes = flagBool(args, "all");
    const ids = [...buildRegistry({ includeFakes }).keys()];
    if (json) printJson({ harnesses: ids });
    else ids.forEach((id) => print(id));
    return 0;
  }
  if (args._[1] === "install") {
    return harnessInstallCommand(args, json);
  }
  if (args._[1] === "inspect") return harnessInspectCommand(args, json);
  if (args._[1] === "update") return harnessUpdateCommand(args, json);
  return printUsageError(json, `usage: claudexor harness ${HARNESS_USAGE_ARGS}`);
}
