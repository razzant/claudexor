import { nextMessageCommand } from "./next-message-command.js";
import type { ParsedArgs } from "./args.js";
import { runsWaitCommand } from "./runs-wait-command.js";
import { taskGroupRunsCommand } from "./task-group-runs.js";
import { threadExportCommand, threadRetireCommand } from "./thread-export-command.js";
import { threadHistoryCommand } from "./thread-history.js";
export function dispatchRetainedCommand(command: string, args: ParsedArgs, json: boolean) {
  if (command === "runs-wait") return runsWaitCommand(args, json);
  if (command === "task-group-runs") return taskGroupRunsCommand(args, json);
  if (command === "thread-retire") return threadRetireCommand(args, json);
  if (command === "thread")
    return args._[1] === "export" || args._[1] === "retirement"
      ? threadExportCommand(args, json)
      : threadHistoryCommand(args, json);
  if (command === "next-message" || command === "next-message-read")
    return nextMessageCommand(args, json);
  return null;
}
