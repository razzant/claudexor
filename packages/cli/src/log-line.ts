import { appendFileSync } from "node:fs";
import { measureSync, safeProblemMessage } from "@claudexor/util";
import { daemonLogOwner } from "./startup-diagnostics.js";

/** One timestamped, redacted line in the daemon log; never throws. When this
 * process holds the bounded post-authority writer for `path`, the line goes
 * through it (one owner, one rotation, every generation within its cap). A
 * target that writer refused or closed is not reopened here. Only an unclaimed
 * path (tools and tests) keeps the plain append. It stays synchronous and is
 * labeled in `worstSync`. */
export const logLine = (path: string, message: string): void => {
  try {
    const owner = daemonLogOwner(path);
    if (owner.writer) {
      const writer = owner.writer;
      measureSync("daemon.log_line", () => writer.appendLine(message));
      return;
    }
    if (owner.claimed) return;
    const line = `[${new Date().toISOString()}] ${safeProblemMessage(message)}\n`;
    measureSync("daemon.log_line", () => appendFileSync(path, line));
  } catch {
    /* lifecycle safety must not depend on diagnostic I/O */
  }
};
