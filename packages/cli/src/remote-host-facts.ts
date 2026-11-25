/**
 * The read-only answer behind `claudexor remote preflight`: who and where the
 * SSH login lands, the server's SSH host public keys, the platform, install
 * prerequisites, the install lock and the runtime pointer with the installed
 * runtime's own `remote probe` answer. Shared failure shapes for the
 * controller-side install live here too.
 */
import { createHash } from "node:crypto";
import { isRuntimeSemver } from "@claudexor/util";
import { CliError, type CliProblemFields } from "./cli-error.js";
import { type RemoteRuntimeTarget, isRemoteRuntimeTarget } from "./remote-host-manifest.js";
import { PREFLIGHT_SCRIPT } from "./remote-host-scripts.js";
import {
  type SshRunResult,
  type SshTransport,
  stderrExcerpt,
  transportLost,
} from "./remote-host-transport.js";

/** One SSH host public key as the server stores it, and its OpenSSH SHA256
 * fingerprint (what `ssh-keygen -l` prints). */
export interface HostKey {
  type: string;
  blob: string;
  fingerprint: string;
}

/** A runtime file whose read failed, or whose line came garbled: no fact
 * about what it holds. */
export const UNREAD = "unread";

/** One runtime file as the check read it: all of its bytes when the read
 * completed, whatever they hold (none for an empty file), null when it is not
 * a regular file there within its bound, or UNREAD. */
export type RuntimeFile = Buffer | null | typeof UNREAD;

export interface HostFacts {
  user: string;
  uid: number;
  hostname: string;
  home: string;
  os: string;
  machine: string;
  /** Distinct keys, ordered by fingerprint. */
  hostKeys: HostKey[];
  tools: boolean;
  writable: boolean;
  lock: boolean;
  /** `foreign_link`: a link that names no directory under `versions/`. A
   * `link` carries that directory's own `runtime.json` (`meta`) and
   * `.archive-sha256` marker exactly as read, never run. A file that could not
   * be read is no fact about its bytes and takes nothing else from the answer:
   * the server and the pointer stand. */
  current:
    | { kind: "absent" }
    | { kind: "not_link" }
    | { kind: "foreign_link" }
    | { kind: "link"; target: string; meta: RuntimeFile; marker: RuntimeFile };
}

/** What an installed runtime declares about itself; not proof that it runs. */
export interface RuntimeIdentity {
  version: string;
  buildSha: string;
  protocolMajor: number;
  target: RemoteRuntimeTarget;
}

const PREFLIGHT_TIMEOUT_MS = 2 * 60_000;
const PRINTABLE = /^[^\p{Cc}\p{Cf}]+$/u;
const FACT_KEYS = [
  "user",
  "uid",
  "hostname",
  "home",
  "os",
  "machine",
  "tools",
  "writable",
  "lock",
  "current",
];
/** The one fact that may repeat: one line per host key file. */
const HOST_KEY = "hostkey";
/** Facts the read-only check reports only for a runtime pointer. */
const RUNTIME_KEYS = ["meta", "marker"];
const MAX_HOST_KEYS = 16;
const POINTER = /^versions\/[A-Za-z0-9._-]+$/;
/** How the transaction names a runtime directory: version, archive digest and,
 * for a controller-side install, its own token. */
const RUNTIME_NAME = /^versions\/(\d+\.\d+\.\d+)-([0-9a-f]{64})(?:-[0-9a-f]{32})?$/;
const KEY_TYPE = /^[A-Za-z0-9@._-]{1,64}$/;
const KEY_BLOB = /^(?:[A-Za-z0-9+/]{4}){1,4096}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A typed operational failure of the controller-side install (exit 1). */
export function remoteHostFailure(
  code: string,
  message: string,
  extra: CliProblemFields = {},
): CliError {
  return new CliError("operational", message, { code, retryable: false, ...extra });
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unreadable(reason: string): CliError {
  return remoteHostFailure(
    "remote_unreadable",
    `the server's answer could not be read: ${reason}`,
    {
      retryable: true,
    },
  );
}

function sshUnavailable(result: SshRunResult): CliError {
  const detail = result.localFailure ?? (stderrExcerpt(result) || "ssh exited without detail");
  return remoteHostFailure("ssh_unavailable", `ssh could not run the read-only check: ${detail}`, {
    retryable: true,
    requiredActions: [
      "Make sure `ssh <destination>` connects without a prompt (a key or agent and a known host key).",
      "Claudexor needs OpenSSH 8.5 or newer and checks host keys only against known-hosts files.",
    ],
  });
}

function fact(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (value === undefined) throw unreadable(`it did not report ${key}`);
  return value;
}

/** A fact with a fixed vocabulary: any other value is unreadable, never a
 * guess (an unknown lock is not an absent one). */
function choice(map: Map<string, string>, key: string, yes: string, no: string): boolean {
  const value = fact(map, key);
  if (value !== yes && value !== no) throw unreadable(`${key} is neither ${yes} nor ${no}`);
  return value === yes;
}

function printable(map: Map<string, string>, key: string, max: number): string {
  const value = fact(map, key);
  if (value.length === 0 || value.length > max || !PRINTABLE.test(value)) {
    throw unreadable(`${key} is empty or not printable`);
  }
  return value;
}

/** `<type> <base64>` from a host public key file. The blob must begin with
 * its own key type (the SSH wire format), so a mislabeled key is refused. */
function hostKey(value: string): HostKey {
  const [type = "", blob = "", ...rest] = value.split(" ");
  const bytes = KEY_TYPE.test(type) && KEY_BLOB.test(blob) ? Buffer.from(blob, "base64") : null;
  if (
    rest.length > 0 ||
    !bytes ||
    bytes.length < 4 ||
    bytes.readUInt32BE(0) !== type.length ||
    bytes.subarray(4, 4 + type.length).toString("latin1") !== type
  ) {
    throw unreadable("an SSH host key is malformed");
  }
  const digest = createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "");
  return { type, blob, fingerprint: `SHA256:${digest}` };
}

/** One of the runtime's files as the check read it: null when no line came
 * (not a regular file there, or over its bound), its bytes when the read
 * completed, whatever they hold, an empty line being an empty file. `!` is a
 * read that failed and a line of no whole hex bytes a garbled one: UNREAD,
 * neither a fact about the runtime nor a doubt about the rest of the answer. */
function runtimeFile(map: Map<string, string>, key: string): RuntimeFile {
  const value = map.get(key);
  if (value === undefined) return null;
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) return UNREAD;
  return Buffer.from(value, "hex");
}

function currentOf(value: string, map: Map<string, string>): HostFacts["current"] {
  if (value === "-") return { kind: "absent" };
  if (value === "!") return { kind: "not_link" };
  if (value === "?" || !POINTER.test(value) || value.includes("..")) {
    return { kind: "foreign_link" };
  }
  return {
    kind: "link",
    target: value,
    meta: runtimeFile(map, "meta"),
    marker: runtimeFile(map, "marker"),
  };
}

/** Strict parse between the markers; anything a login shell prints around
 * them is ignored, anything unexpected between them is refused. */
export function parseHostFacts(stdout: string): HostFacts {
  const lines = stdout.split("\n");
  const start = lines.indexOf("claudexor-preflight-v3");
  const end = lines.lastIndexOf("claudexor-preflight-end");
  if (start < 0 || end < start) throw unreadable("the check's markers are missing");
  const map = new Map<string, string>();
  const keys = new Map<string, HostKey>();
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]!;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq) : "";
    if (key === HOST_KEY) {
      if (keys.size >= MAX_HOST_KEYS) {
        throw unreadable(`it reported more than ${MAX_HOST_KEYS} host keys`);
      }
      const parsed = hostKey(line.slice(eq + 1));
      keys.set(parsed.fingerprint, parsed);
      continue;
    }
    if ((!FACT_KEYS.includes(key) && !RUNTIME_KEYS.includes(key)) || map.has(key)) {
      throw unreadable(`unexpected line ${JSON.stringify(line.slice(0, 80))}`);
    }
    map.set(key, line.slice(eq + 1));
  }
  const uid = fact(map, "uid");
  const home = printable(map, "home", 4096);
  if (!/^\d{1,10}$/.test(uid) || !home.startsWith("/"))
    throw unreadable("uid or home is malformed");
  return {
    user: printable(map, "user", 256),
    uid: Number(uid),
    hostname: printable(map, "hostname", 255),
    home,
    os: printable(map, "os", 64),
    machine: printable(map, "machine", 64),
    hostKeys: [...keys.values()].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1)),
    tools: choice(map, "tools", "yes", "no"),
    writable: choice(map, "writable", "yes", "no"),
    lock: choice(map, "lock", "present", "absent"),
    current: currentOf(printable(map, "current", 4096), map),
  };
}

export async function readHostFacts(transport: SshTransport): Promise<HostFacts> {
  const result = await transport.run("sh -s", {
    bytes: PREFLIGHT_SCRIPT,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  });
  if (transportLost(result)) throw sshUnavailable(result);
  if (result.status !== 0) {
    throw unreadable(`the read-only check exited ${result.status}: ${stderrExcerpt(result)}`);
  }
  return parseHostFacts(result.stdout.toString("utf8"));
}

/** The same platform mapping as the app's installer (`uname -s`, `uname -m`). */
export function targetFor(os: string, machine: string): RemoteRuntimeTarget | null {
  const platform = ({ linux: "linux", darwin: "darwin" } as Record<string, string>)[
    os.toLowerCase()
  ];
  const arch = (
    { x86_64: "x64", amd64: "x64", arm64: "arm64", aarch64: "arm64" } as Record<string, string>
  )[machine.toLowerCase()];
  const target = platform && arch ? `${platform}-${arch}` : null;
  return isRemoteRuntimeTarget(target) ? target : null;
}

/** Read bytes as UTF-8 text, or null when they are not; null stays null. */
function utf8(bytes: Buffer | null, maxBytes: number): string | null {
  if (!bytes || bytes.length > maxBytes) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The object `runtime.json` holds, or null for any other content. */
function runtimeObject(bytes: Buffer | null): Record<string, unknown> | null {
  const text = utf8(bytes, 4096);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * What each of an installed runtime's files shows on its own, never run:
 * `meta`, the identity the release-built `runtime.json` declares for its
 * directory name (schema 1, a git build SHA, the name's version), or null when
 * a file read whole declares none; `marker`, whether the `.archive-sha256`
 * marker read whole holds the name's digest as its one line. Absent or
 * malformed content (bad UTF-8 or JSON, `null`, too large) declares nothing;
 * UNREAD, a file that could not be read, says nothing either way.
 */
export function runtimeFiles(current: Extract<HostFacts["current"], { kind: "link" }>): {
  meta: RuntimeIdentity | null | typeof UNREAD;
  marker: boolean | typeof UNREAD;
} {
  const name = RUNTIME_NAME.exec(current.target);
  const marker =
    current.marker === UNREAD
      ? UNREAD
      : !!name && utf8(current.marker, 128)?.replace(/\n$/, "") === name[2];
  if (current.meta === UNREAD) return { meta: UNREAD, marker };
  const m = runtimeObject(current.meta);
  if (
    !m ||
    m["schemaVersion"] !== 1 ||
    !isRemoteRuntimeTarget(m["target"]) ||
    !isRuntimeSemver(m["version"]) ||
    typeof m["buildSha"] !== "string" ||
    !/^[0-9a-f]{40}$/.test(m["buildSha"]) ||
    !Number.isInteger(m["protocolMajor"]) ||
    !name ||
    name[1] !== m["version"]
  ) {
    return { meta: null, marker };
  }
  const meta: RuntimeIdentity = {
    version: m["version"],
    buildSha: m["buildSha"],
    protocolMajor: m["protocolMajor"] as number,
    target: m["target"],
  };
  return { meta, marker };
}

/** What an installed runtime declares when both of its files were read whole
 * and agree with its directory name; not proof that it works. Null when a file
 * read whole disagrees, which no other read can undo; UNREAD when only a file
 * that could not be read stands between it and an identity. */
export function runtimeIdentity(
  current: Extract<HostFacts["current"], { kind: "link" }>,
): RuntimeIdentity | null | typeof UNREAD {
  const { meta, marker } = runtimeFiles(current);
  if (meta === null || marker === false) return null;
  if (meta === UNREAD || marker === UNREAD) return UNREAD;
  return meta;
}
