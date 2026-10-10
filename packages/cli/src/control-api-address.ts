import { readFileSync } from "node:fs";
import { join } from "node:path";
import { daemonDir, readToken } from "@claudexor/daemon";
import { CliError } from "./cli-error.js";
import { daemonOwner, daemonUnavailableMessage } from "./daemon-owner.js";
import { engineSkewRemedy } from "./engine-skew.js";

export interface ControlApiAddress {
  baseUrl: string;
  token: string;
}

export function controlApiAddress(): ControlApiAddress {
  daemonOwner(); // Validate explicit lifecycle/root before even locating its descriptor.
  const pointer = join(daemonDir(), "control-api.json");
  const absence = (): Error =>
    new Error(
      daemonOwner() === "external"
        ? daemonUnavailableMessage("no action was performed")
        : "daemon control API is not available (run: claudexor daemon start)",
    );
  // Corrupt local state must be LOUD (#93 R1/R2): a pointer that exists but is
  // unreadable, unparsable, or structurally invalid ({} / null / wrong host or
  // port types) is never "daemon not running". Bounded — the path and a short
  // cause only, no raw dump of the file.
  const invalid = (cause: string): CliError =>
    new CliError(
      "operational",
      `daemon control-api pointer ${pointer} is ${cause}; ` +
        (daemonOwner() === "external"
          ? engineSkewRemedy()
          : "run `claudexor daemon stop` and rerun so a healthy daemon rewrites it"),
      { code: "control_pointer_invalid", retryable: false, context: { pointer } },
    );
  let raw: string;
  try {
    raw = readFileSync(pointer, "utf8").trim();
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === "ENOENT" || errno === "ENOTDIR") throw absence();
    throw invalid(`unreadable${errno ? ` (${errno})` : ""}`);
  }
  // An EMPTY (or whitespace-only) pointer stays ABSENCE: the daemon's pointer
  // write has an open-truncate→write window, and a racing reader must keep
  // polling, never fail loud on the transient zero-byte state.
  if (raw === "") throw absence();
  let info: { host?: unknown; port?: unknown };
  try {
    info = (JSON.parse(raw) ?? {}) as { host?: unknown; port?: unknown };
  } catch {
    throw invalid("not valid JSON");
  }
  const { host, port } = info;
  if (typeof host !== "string" || host === "") throw invalid("structurally invalid (bad host)");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    throw invalid("structurally invalid (bad port)");
  const token = readToken();
  if (!token) throw absence();
  return { baseUrl: `http://${host}:${port}`, token };
}
