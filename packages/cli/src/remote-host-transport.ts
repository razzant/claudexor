/**
 * The system OpenSSH client as the controller-side install transport.
 *
 * Claudexor delegates transport, host keys and authentication to `ssh`, as the
 * macOS app does: the destination is whatever the user's SSH setup resolves,
 * parsed before any call as a `Host` alias or host name, `user@host` or
 * `ssh://[user@]host[:port]` (an IPv6 address bare, or bracketed in the URI;
 * a zone only bare, since a URI may percent-decode it).
 * Every call is non-interactive (`BatchMode=yes`): a host that would prompt
 * for a password, passphrase or host-key confirmation fails instead of
 * waiting for input no one sees. Calls never forward the agent, X11 or
 * configured ports.
 *
 * Every call authenticates the server itself: only known-hosts files, never
 * a KnownHostsCommand, DNS or a first-seen key, and nothing is added to them;
 * a loopback address is checked like any other host. No call reuses or leaves
 * an SSH master connection, so no session opened by anyone else answers for
 * this server, and none outlives the call. The user's alias, port, user,
 * ProxyJump and keys stay theirs. OpenSSH 8.5 or newer is required; an older
 * client refuses these options with its reason.
 *
 * `ssh` launches through core's byte-faithful capture (`runCaptureRaw`, over
 * the run-owned launch point): its own process group, stopped as a group on a
 * timeout or a local read failure, with a bounded wait for the stop, so a call
 * always settles and never leaves its outcome to a process nobody watches.
 *
 * A pinned transport reaches the same destination but admits only a server
 * that proves one of the given host keys: ssh checks them from a private
 * known-hosts file under a fixed alias, so neither the user's known hosts nor
 * a name that now resolves elsewhere can admit another server.
 */
import {
  accessSync,
  constants,
  createReadStream,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isIPv6 } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveHarnessCommandOnPath, runCaptureRaw } from "@claudexor/core";
import { CliError } from "./cli-error.js";

/** One `ssh` invocation's outcome. Status 255 is ssh's own failure. */
export interface SshRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  /** Set when ssh could not start or was stopped by this process (timeout,
   * unreadable input, or the operation's cancellation). */
  localFailure?: string;
}

export interface SshRunInput {
  /** Text written as the remote command's whole stdin. */
  bytes?: string;
  /** A local file streamed as the remote command's whole stdin, in place of
   * `bytes`: a call sends one or the other. */
  file?: string;
  /** Stop waiting (and stop the local ssh) after this long. */
  timeoutMs?: number;
  /** The operation's lifetime: once aborted, a running ssh is stopped and no
   * new one starts. Its listener is removed when the call settles. */
  signal?: AbortSignal;
}

/** Why a call was stopped by its operation's cancellation. */
export const CANCELLED = "the operation was cancelled on this client";

export interface SshTransport {
  /** The one SSH destination every call reaches; preflight and install bind to it. */
  readonly destination: string;
  run(remoteCommand: string, input?: SshRunInput): Promise<SshRunResult>;
}

/** The same destination, admitting only a server that proves one of the host
 * keys it was pinned to; `close` removes its private known-hosts file. */
export interface PinnedSshTransport extends SshTransport {
  close(): void;
}

export interface PinnableSshTransport extends SshTransport {
  /** `hostKeys` are `<type> <base64>` public keys, at least one. */
  pinned(hostKeys: readonly string[]): PinnedSshTransport;
}

/** The known-hosts name a pinned call checks the server's key under. */
export const PINNED_HOST_ALIAS = "claudexor-confirmed-host";
const HOST_KEY_LINE = /^[A-Za-z0-9@._-]{1,64} [A-Za-z0-9+/]+={0,2}$/;

/** How ssh reads a file path from an option value: whitespace needs quotes,
 * and `%` (tokens), `"` and control characters cannot be passed safely. */
function sshConfigPath(path: string): string {
  const value = process.platform === "win32" ? path.replaceAll("\\", "/") : path;
  if (/["%\p{Cc}]/u.test(value)) {
    throw new CliError("operational", `the temporary path ${value} cannot be given to ssh`, {
      code: "ssh_unavailable",
      retryable: false,
    });
  }
  return /\s/.test(value) ? `"${value}"` : value;
}

/** With SSH_OPTIONS, the options that make ssh accept only the keys in
 * `knownHosts`: the only known-hosts source left is that one file. */
export function pinnedSshOptions(knownHosts: string): string[] {
  return [
    "-o",
    `HostKeyAlias=${PINNED_HOST_ALIAS}`,
    "-o",
    `UserKnownHostsFile=${sshConfigPath(knownHosts)}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
  ];
}

/** Command-line options come first, so the user's ssh_config cannot undo
 * any of these; it still chooses the host, port, user, jump host and keys. */
export const SSH_OPTIONS: readonly string[] = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "ConnectTimeout=20",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ForwardX11=no",
  // Host keys: no first-seen or changed key is accepted, none is added, and a
  // loopback address gets no exemption from the user's configuration.
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "NoHostAuthenticationForLocalhost=no",
  "-o",
  "UpdateHostKeys=no",
  "-o",
  "CheckHostIP=no",
  "-o",
  "VerifyHostKeyDNS=no",
  "-o",
  "KnownHostsCommand=none",
  // No shared connection: none is reused and none outlives the call.
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
];

/** A user, `Host` alias or host name: letters, digits, `.`, `_` and `-`, led by
 * a letter, digit or `_`. Nothing in it means anything to a shell, to an
 * ssh_config token that expands it (`%h`, `%r`) or to a `Host` pattern, and
 * it never reads as an option. */
const SSH_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** IPv6 text, with an optional zone of name characters (`fe80::1%eth0`), which
 * a destination carries only bare. */
const IPV6_TEXT = /^[0-9A-Fa-f:.]+(?:%[A-Za-z0-9._-]+)?$/;
/** `ssh://[user@]host[:port]`: the user ends at the first `@`, an IPv6 host is
 * bracketed, and nothing follows the port. */
const SSH_URI = /^ssh:\/\/(?:([^@/]*)@)?(\[[^\]]*\]|[^:/[\]]*)(?::([0-9]*))?$/;

/**
 * Parses a destination the way ssh reads it, before any call: `[user@]host`
 * (the user ends at the last `@`; an IPv6 host stays bare) or SSH_URI. The
 * user and host name follow SSH_NAME; a host may also be an IP address.
 * Returns the refusal reason, or null when usable.
 */
export function sshDestinationProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "the SSH destination is empty";
  if (Buffer.byteLength(value, "utf8") > 255) return "the SSH destination is too long";
  if (value.startsWith("-")) return "the SSH destination must not start with '-'";
  let user: string | undefined;
  let host: string;
  let bracketed = false;
  if (value.startsWith("ssh://")) {
    const uri = SSH_URI.exec(value);
    if (!uri) return "the SSH destination URI must be ssh://[user@]host[:port], with no path";
    const port = uri[3];
    if (port !== undefined && !(/^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65_535)) {
      return "the SSH destination port must be a number from 1 to 65535";
    }
    user = uri[1];
    host = uri[2] ?? "";
    bracketed = host.startsWith("[");
    if (bracketed) host = host.slice(1, -1);
  } else {
    const at = value.lastIndexOf("@");
    if (at >= 0) user = value.slice(0, at);
    host = value.slice(at + 1);
    if (host.startsWith("[")) {
      return "the SSH destination brackets an IPv6 address only in ssh://[address]:port";
    }
  }
  if (user !== undefined && !(user.length <= 64 && SSH_NAME.test(user))) {
    return "the SSH destination user must be a name of letters, digits, '.', '_' and '-'";
  }
  if (bracketed || host.includes(":")) {
    // ssh may percent-decode a URI host, which would change the checked zone.
    if (bracketed && host.includes("%")) {
      return (
        "the SSH destination URI cannot carry an IPv6 zone; " +
        "give the address bare (fe80::1%eth0) or use a Host alias"
      );
    }
    if (IPV6_TEXT.test(host) && isIPv6(host)) return null;
    return bracketed
      ? "the SSH destination host in brackets is not an IPv6 address"
      : "the SSH destination host is not an IPv6 address; a port needs ssh://host:port";
  }
  if (host.length <= 253 && SSH_NAME.test(host)) return null;
  return "the SSH destination host must be a Host alias, a host name or an IP address";
}

function noOutcome(localFailure: string): SshRunResult {
  return {
    status: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    localFailure,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The exact `ssh` executable, fixed once for the whole transaction: an
 * absolute path as given, a bare name as the caller's own PATH resolves it.
 * The launch PATH puts system directories first, but the user's SSH setup
 * belongs to the client their PATH selects; nothing is searched anywhere else.
 * A program that does not resolve to an executable file is refused before any
 * launch. */
function exactProgram(program: string): string {
  let entrypoint: string | undefined;
  if (isAbsolute(program)) entrypoint = program;
  else if (!/[\\/]/.test(program)) {
    const path = process.env["PATH"] ?? process.env["Path"] ?? "";
    entrypoint = resolveHarnessCommandOnPath(program, path, process.platform, process.env).command
      ?.entrypoint;
  }
  try {
    if (entrypoint === undefined || !isAbsolute(entrypoint)) throw new Error("not found");
    accessSync(entrypoint, constants.X_OK);
    return entrypoint;
  } catch {
    throw new CliError(
      "operational",
      `${program} is not an executable ssh client${isAbsolute(program) ? "" : " on PATH"}`,
      { code: "ssh_unavailable", retryable: false },
    );
  }
}

export interface SystemSshTransport extends PinnableSshTransport {
  /** The absolute ssh executable every call launches. */
  readonly program: string;
}

/** One `ssh <options> -- <destination> <command>` call. */
async function runSsh(
  ssh: string,
  options: readonly string[],
  destination: string,
  remoteCommand: string,
  input: SshRunInput,
): Promise<SshRunResult> {
  if (input.file !== undefined && input.bytes !== undefined) {
    throw new Error("an ssh call's input is text or a file, never both");
  }
  if (input.signal?.aborted) return noOutcome(CANCELLED);
  const stop = new AbortController();
  let localFailure: string | undefined;
  const halt = (reason: string) => {
    localFailure ??= reason;
    stop.abort();
  };
  const cancel = () => halt(CANCELLED);
  input.signal?.addEventListener("abort", cancel, { once: true });
  const timer =
    input.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => halt(`ssh did not finish within ${Math.round(input.timeoutMs! / 1000)}s`),
          input.timeoutMs,
        );
  const source = input.file === undefined ? undefined : createReadStream(input.file);
  // The remote side then saw a cut stream: ssh is stopped, and the
  // outcome stays the caller's to classify as lost, never as a clean end.
  source?.on("error", (error) => halt(`could not read the local file: ${error.message}`));
  try {
    const result = await runCaptureRaw(ssh, [...options, "--", destination, remoteCommand], {
      ...(source ? { stdinStream: source } : { input: input.bytes ?? "" }),
      abortSignal: stop.signal,
      cancelSignal: "SIGTERM",
    });
    if (result.termination?.status === "unconfirmed") {
      localFailure = `${localFailure ?? "ssh was stopped"}; its exit was not confirmed`;
    }
    return {
      status: result.code,
      signal: result.signal,
      stdout: Buffer.from(result.stdout, "utf8"),
      stderr: Buffer.from(result.stderr, "utf8"),
      ...(localFailure ? { localFailure } : {}),
    };
  } catch (error) {
    // ssh did not start or its output could not be kept (the capture
    // budget): either way nothing reports the remote outcome.
    return noOutcome(localFailure ?? `ssh could not run: ${errorMessage(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    source?.destroy();
  }
}

/** The production transport: `ssh <options> -- <destination> <command>`. */
export function systemSshTransport(destination: string, program = "ssh"): SystemSshTransport {
  const problem = sshDestinationProblem(destination);
  if (problem) throw new Error(problem);
  const ssh = exactProgram(program);
  return {
    destination,
    program: ssh,
    run: (remoteCommand, input = {}) => runSsh(ssh, SSH_OPTIONS, destination, remoteCommand, input),
    pinned(hostKeys) {
      if (hostKeys.length === 0 || hostKeys.some((key) => !HOST_KEY_LINE.test(key))) {
        throw new Error("a pinned ssh transport needs well-formed host keys");
      }
      const dir = mkdtempSync(join(tmpdir(), "claudexor-ssh-pin-"));
      let options: string[];
      try {
        const file = join(dir, "known_hosts");
        options = [...SSH_OPTIONS, ...pinnedSshOptions(file)];
        const lines = hostKeys.map((key) => `${PINNED_HOST_ALIAS} ${key}\n`).join("");
        writeFileSync(file, lines, { mode: 0o600, flag: "wx" });
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      return {
        destination,
        run: (remoteCommand, input = {}) => runSsh(ssh, options, destination, remoteCommand, input),
        // Public keys only, in a private temporary directory: a removal that
        // fails must not replace the install's own outcome with its error.
        close: () => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* left for the system's temporary cleanup */
          }
        },
      };
    },
  };
}

/** A bounded, printable excerpt of ssh or remote stderr for a failure context. */
export function stderrExcerpt(result: SshRunResult): string {
  const text = result.stderr
    .toString("utf8")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .trim();
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

/** True when the command's outcome on the host is unknown: ssh itself failed,
 * was stopped, or never reported an exit status. */
export function transportLost(result: SshRunResult): boolean {
  return result.localFailure !== undefined || result.status === null || result.status === 255;
}
