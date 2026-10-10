import { type ParsedArgs, flagBool, flagStr } from "./args.js";
import { print, printJson } from "./cli-io.js";
import { parseHostBinding } from "./plugin-runtime.js";
import {
  PLUGIN_TARGETS,
  PLUGIN_VERBS,
  formatPluginResult,
  pluginCommandErrorResult,
  runPluginCommand,
  type PluginTarget,
  type PluginVerb,
} from "./plugins.js";

export async function pluginCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1];
  const target = args._[2];
  const dryRun = flagBool(args, "dry-run");
  if (!sub || !PLUGIN_VERBS.includes(sub as PluginVerb)) {
    const error =
      "usage: claudexor plugin <install|status|doctor|repair|uninstall> <cursor|claude|codex|opencode|all> [--dry-run] [--force] [--json]";
    if (json) printJson(pluginCommandErrorResult(sub, target, dryRun, 2, error));
    else print(error);
    return 2;
  }
  if (!target || !PLUGIN_TARGETS.includes(target as PluginTarget)) {
    const error = `claudexor: unknown plugin target '${target ?? ""}' (expected ${PLUGIN_TARGETS.join("|")})`;
    if (json) printJson(pluginCommandErrorResult(sub, target, dryRun, 2, error));
    else process.stderr.write(`${error}\n`);
    return 2;
  }
  if (args._.length > 3) {
    const error = `claudexor: unexpected plugin argument(s): ${args._.slice(3).join(" ")}`;
    if (json) printJson(pluginCommandErrorResult(sub, target, dryRun, 2, error));
    else process.stderr.write(`${error}\n`);
    return 2;
  }
  try {
    const bindingJson = flagStr(args, "host-binding-json");
    const r = await runPluginCommand(sub as PluginVerb, target as PluginTarget, {
      ...(bindingJson === undefined
        ? {}
        : { hostBinding: parseHostBinding(JSON.parse(bindingJson)) }),
      dryRun,
      force: flagBool(args, "force"),
      json,
    });
    if (json) printJson(r);
    else print(formatPluginResult(r));
    return r.exitCode;
  } catch (err) {
    if (json) {
      printJson(
        pluginCommandErrorResult(
          sub,
          target,
          dryRun,
          1,
          err instanceof Error ? err.message : String(err),
        ),
      );
      return 1;
    }
    throw err;
  }
}
