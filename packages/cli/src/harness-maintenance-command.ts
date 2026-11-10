import { flagBool, type ParsedArgs } from "./args.js";
import { print, printJson } from "./cli-io.js";
import { harnessPrograms } from "./harness-programs.js";
import { inspectHarness } from "./harness-maintenance.js";
import { harnessMutationCommand } from "./harness-installer.js";

export async function harnessInspectCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const ids = args._[2] ? [args._[2]] : harnessPrograms().map((program) => program.id);
  try {
    const harnesses = [];
    for (const id of ids)
      harnesses.push(await inspectHarness(id, { latest: flagBool(args, "latest") }));
    if (json) printJson({ observedAt: new Date().toISOString(), harnesses });
    else
      for (const row of harnesses)
        print(
          `${row.harness}: ${row.selection.path ?? "not installed"} (${row.selection.version ?? "version unknown"}); newest: ${row.newest.status === "available" ? row.newest.version : row.newest.status}`,
        );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printJson({ ok: false, error: message });
    else print(message);
    return 1;
  }
}
export const harnessUpdateCommand = harnessMutationCommand;
