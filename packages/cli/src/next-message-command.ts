import { flagBool, type ParsedArgs } from "./args.js";
import { renderCliFailure, usageError } from "./cli-error.js";
import { printJson } from "./cli-io.js";
import { deferredMessageQuery } from "./mcp-deferred-message.js";

export async function nextMessageCommand(args: ParsedArgs, json: boolean): Promise<number> {
  try {
    const read = args._[0] === "next-message-read";
    const raw = args._[1];
    if (!raw)
      throw usageError(
        "provide a draft ID for read or the complete DeferredMessageCall JSON for mutation",
        { code: "invalid_argument" },
      );
    const input = read ? { draftId: raw } : JSON.parse(raw);
    printJson(
      await deferredMessageQuery({
        ...input,
        mode: read ? "__next_message_read" : "__next_message",
      }),
    );
    return 0;
  } catch (error) {
    return renderCliFailure(json || flagBool(args, "json"), error, {
      messagePrefix: "claudexor next-message:",
    });
  }
}
