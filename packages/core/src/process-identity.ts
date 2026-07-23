import { constants, accessSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type ProcessIdentityPlatform = "linux" | "darwin";
export type ProcessIdentitySource = "procfs_stat" | "proc_pidinfo";
export type ProcessIdentityUnknownReason =
  | "invalid_pid"
  | "unsupported_platform"
  | "permission_denied"
  | "malformed_response"
  | "helper_unavailable"
  | "helper_failed"
  | "io_error";

export interface KnownProcessIdentity {
  status: "known";
  pid: number;
  platform: ProcessIdentityPlatform;
  source: ProcessIdentitySource;
  /** Opaque locale-independent kernel birth token, compared byte-for-byte. */
  startToken: string;
  /** Kernel-observed process-group id at the same observation. */
  processGroupId: number;
}

export interface MissingProcessIdentity {
  status: "missing";
  pid: number;
  platform: string;
}

export interface UnknownProcessIdentity {
  status: "unknown";
  pid: number;
  platform: string;
  reason: ProcessIdentityUnknownReason;
}

export type ProcessIdentity =
  KnownProcessIdentity | MissingProcessIdentity | UnknownProcessIdentity;
export type ProcessIdentityComparison = "same" | "different" | "missing" | "unknown";

export interface ProcessIdentityReader {
  read(pid: number): ProcessIdentity;
  self(): ProcessIdentity;
}

export interface DarwinHelperExecution {
  status: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export interface ProcessIdentityServiceOptions {
  platform?: string;
  selfPid?: number;
  readTextFile?: (path: string) => string;
  /** Absolute path to the bundled proc_pidinfo helper; null disables it. */
  darwinHelperPath?: string | null;
  runDarwinHelper?: (path: string, pid: number) => DarwinHelperExecution;
}

const LINUX_PROCESS_STATES = new Set(["R", "S", "D", "Z", "T", "t", "X", "x", "K", "W", "P", "I"]);

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalUnsigned(value: string): boolean {
  return value === "0" || /^[1-9][0-9]*$/.test(value);
}

function canonicalPositive(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
}

function unknown(
  pid: number,
  platform: string,
  reason: ProcessIdentityUnknownReason,
): UnknownProcessIdentity {
  return { status: "unknown", pid, platform, reason };
}

/** Parse Linux proc stat field 5 (pgrp) and field 22 (starttime). */
export function parseLinuxProcStat(raw: string, expectedPid: number): ProcessIdentity {
  if (!validPositiveInteger(expectedPid)) return unknown(expectedPid, "linux", "invalid_pid");
  const firstSpace = raw.indexOf(" ");
  const commEnd = raw.lastIndexOf(")");
  if (firstSpace <= 0 || commEnd <= firstSpace + 1)
    return unknown(expectedPid, "linux", "malformed_response");
  const parsedPid = raw.slice(0, firstSpace);
  if (!canonicalPositive(parsedPid) || Number(parsedPid) !== expectedPid) {
    return unknown(expectedPid, "linux", "malformed_response");
  }
  if (raw[firstSpace + 1] !== "(" || raw[commEnd + 1] !== " ") {
    return unknown(expectedPid, "linux", "malformed_response");
  }
  const fieldsFromState = raw
    .slice(commEnd + 2)
    .trim()
    .split(/ +/);
  const state = fieldsFromState[0];
  const processGroup = fieldsFromState[2];
  const startTicks = fieldsFromState[19];
  if (
    !state ||
    !LINUX_PROCESS_STATES.has(state) ||
    !processGroup ||
    !canonicalPositive(processGroup) ||
    !startTicks ||
    !canonicalUnsigned(startTicks)
  ) {
    return unknown(expectedPid, "linux", "malformed_response");
  }
  return {
    status: "known",
    pid: expectedPid,
    platform: "linux",
    source: "procfs_stat",
    startToken: `linux:${startTicks}`,
    processGroupId: Number(processGroup),
  };
}

/** Strict parser for the bundled Darwin helper's locale-independent protocol. */
export function parseDarwinHelperOutput(raw: string, expectedPid: number): ProcessIdentity {
  if (!validPositiveInteger(expectedPid)) return unknown(expectedPid, "darwin", "invalid_pid");
  const line = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (line.includes("\n") || line.includes("\r"))
    return unknown(expectedPid, "darwin", "malformed_response");
  const fields = line.split("\t");
  if (fields.length !== 5 || fields[0] !== "claudexor-process-identity-v2") {
    return unknown(expectedPid, "darwin", "malformed_response");
  }
  const [, pidText, pgidText, seconds, micros] = fields;
  if (
    !pidText ||
    !canonicalPositive(pidText) ||
    Number(pidText) !== expectedPid ||
    !pgidText ||
    !canonicalPositive(pgidText) ||
    !seconds ||
    !canonicalUnsigned(seconds) ||
    !micros ||
    !/^[0-9]{6}$/.test(micros)
  ) {
    return unknown(expectedPid, "darwin", "malformed_response");
  }
  return {
    status: "known",
    pid: expectedPid,
    platform: "darwin",
    source: "proc_pidinfo",
    startToken: `darwin:${seconds}:${micros}`,
    processGroupId: Number(pgidText),
  };
}

export function compareProcessIdentity(
  expected: KnownProcessIdentity,
  observed: ProcessIdentity,
): ProcessIdentityComparison {
  if (observed.status === "missing") return "missing";
  if (observed.status === "unknown") return "unknown";
  return expected.pid === observed.pid &&
    expected.platform === observed.platform &&
    expected.source === observed.source &&
    expected.startToken === observed.startToken &&
    expected.processGroupId === observed.processGroupId
    ? "same"
    : "different";
}

export function isKnownProcessIdentity(value: unknown): value is KnownProcessIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<KnownProcessIdentity>;
  if (
    candidate.status !== "known" ||
    !validPositiveInteger(candidate.pid as number) ||
    !validPositiveInteger(candidate.processGroupId as number)
  )
    return false;
  if (candidate.platform === "linux") {
    return (
      candidate.source === "procfs_stat" &&
      typeof candidate.startToken === "string" &&
      /^linux:(0|[1-9][0-9]*)$/.test(candidate.startToken)
    );
  }
  if (candidate.platform === "darwin") {
    return (
      candidate.source === "proc_pidinfo" &&
      typeof candidate.startToken === "string" &&
      /^darwin:(0|[1-9][0-9]*):[0-9]{6}$/.test(candidate.startToken)
    );
  }
  return false;
}

function bundledDarwinHelperPath(): string | null {
  // The helper is built into `dist/native`. Resolve it whether this module runs
  // from `dist` (production) or `src` (tsx/vitest) — the `dist` fallback keeps
  // process-identity usable under the src-run test harness.
  const candidates = [
    new URL("./native/claudexor-process-identity", import.meta.url),
    new URL("../dist/native/claudexor-process-identity", import.meta.url),
  ];
  for (const url of candidates) {
    const candidate = fileURLToPath(url);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try the next layout */
    }
  }
  return null;
}

function executeDarwinHelper(path: string, pid: number): DarwinHelperExecution {
  const result = spawnSync(path, ["--pid", String(pid)], {
    encoding: "utf8",
    timeout: 1_500,
    maxBuffer: 64 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
  };
}

export class ProcessIdentityService implements ProcessIdentityReader {
  private readonly platform: string;
  private readonly selfPid: number;
  private readonly readTextFile: (path: string) => string;
  private readonly darwinHelperPath: string | null;
  private readonly runDarwinHelper: (path: string, pid: number) => DarwinHelperExecution;
  private cachedSelf: ProcessIdentity | undefined;

  constructor(options: ProcessIdentityServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.selfPid = options.selfPid ?? process.pid;
    this.readTextFile = options.readTextFile ?? ((path) => readFileSync(path, "utf8"));
    this.darwinHelperPath =
      options.darwinHelperPath === undefined ? bundledDarwinHelperPath() : options.darwinHelperPath;
    this.runDarwinHelper = options.runDarwinHelper ?? executeDarwinHelper;
  }

  read(pid: number): ProcessIdentity {
    if (!validPositiveInteger(pid)) return unknown(pid, this.platform, "invalid_pid");
    if (this.platform === "linux") return this.readLinux(pid);
    if (this.platform === "darwin") return this.readDarwin(pid);
    return unknown(pid, this.platform, "unsupported_platform");
  }

  self(): ProcessIdentity {
    this.cachedSelf ??= this.read(this.selfPid);
    return this.cachedSelf;
  }

  private readLinux(pid: number): ProcessIdentity {
    try {
      return parseLinuxProcStat(this.readTextFile(`/proc/${pid}/stat`), pid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ESRCH")
        return { status: "missing", pid, platform: "linux" };
      if (code === "EACCES" || code === "EPERM") return unknown(pid, "linux", "permission_denied");
      return unknown(pid, "linux", "io_error");
    }
  }

  private readDarwin(pid: number): ProcessIdentity {
    if (!this.darwinHelperPath) return unknown(pid, "darwin", "helper_unavailable");
    let execution: DarwinHelperExecution;
    try {
      execution = this.runDarwinHelper(this.darwinHelperPath, pid);
    } catch {
      return unknown(pid, "darwin", "helper_failed");
    }
    if (execution.errorCode === "ENOENT" || execution.errorCode === "EACCES") {
      return unknown(pid, "darwin", "helper_unavailable");
    }
    if (execution.status === 3) return { status: "missing", pid, platform: "darwin" };
    if (execution.status === 4) return unknown(pid, "darwin", "permission_denied");
    if (execution.status !== 0) return unknown(pid, "darwin", "helper_failed");
    return parseDarwinHelperOutput(execution.stdout, pid);
  }
}

export const defaultProcessIdentityService = new ProcessIdentityService();
