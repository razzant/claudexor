import { appendFileSync } from "node:fs";
import { measureSync, safeProblemMessage } from "@claudexor/util";

/** One timestamped, redacted line in the daemon log; never throws. It stays
 * synchronous: the startup diagnostics writer rotates the same file with a
 * rename and an exclusive create that an in-flight append could break. The
 * append is labeled in `worstSync`. */
export const logLine = (path: string, message: string): void => {
  try {
    const line = `[${new Date().toISOString()}] ${safeProblemMessage(message)}\n`;
    measureSync("daemon.log_line", () => appendFileSync(path, line));
  } catch {
    /* lifecycle safety must not depend on diagnostic I/O */
  }
};
