import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import {
  compareProcessIdentity,
  defaultProcessIdentityService,
  defaultProcessObservationReader,
  isKnownProcessIdentity,
  observeProcess,
  ProcessIdentityService,
  executeWin32ProcessTimes,
  type KnownProcessIdentity,
  type ProcessIdentityReader,
  type ProcessObservation,
  type ProcessObservationReader,
} from "@claudexor/core";
import { daemonDir, isWindowsPipePath } from "./token.js";

const daemonIdentity =
  process.platform === "win32"
    ? new ProcessIdentityService({ runWin32Reader: executeWin32ProcessTimes })
    : defaultProcessIdentityService;

/** Marker file whose presence turns a lease directory into the permanent
 * root-authority barrier (issue #165 D1). The barrier directory deliberately
 * carries NO top-level owner.json: a pre-fix claimant's lease parse fails
 * closed on it forever, so it can never quarantine the barrier and take over
 * a data root last served by a fixed runtime. */
export const ROOT_AUTHORITY_MARKER_FILE = "root-authority-v2.json";
/** Nested slot the fixed daemon's ACTIVE writer claim occupies under a barrier. */
const ROOT_AUTHORITY_ACTIVE_SLOT = "active";

/**
 * Filesystem anchor of the single-writer lease for a control endpoint. A Unix
 * socket FILE anchors its lease right next to itself; a named pipe is not a
 * filesystem entry (nothing can be created in `\\.\pipe\`), so its lease lives
 * in the daemon dir under the pipe's own final segment — which already carries
 * the config-dir digest, keeping concurrent daemons' leases distinct.
 */
export function writerLeaseAnchorPath(socketPath: string): string {
  if (isWindowsPipePath(socketPath)) {
    const pipeName = socketPath.split(/[\\/]/).pop() || "claudexord-pipe";
    return join(daemonDir(), `${pipeName}.writer`);
  }
  return `${socketPath}.writer`;
}

/**
 * Effective single-writer lease address. Once the anchor directory carries the
 * permanent root-authority barrier marker (issue #165 D1/D4), the live claim
 * for every FIXED runtime moves to the nested `active.writer` slot inside the
 * barrier, so inspection, acquisition, termination and operator stop all keep
 * following one canonical address. Pre-fix runtimes never resolve the nested
 * slot — they contend on the anchor itself, where the opaque barrier refuses
 * them. Without a marker the anchor stays the (legacy-compatible) address.
 */
export function writerLeasePath(socketPath: string): string {
  const anchor = writerLeaseAnchorPath(socketPath);
  try {
    if (lstatSync(join(anchor, ROOT_AUTHORITY_MARKER_FILE)).isFile()) {
      return join(anchor, `${ROOT_AUTHORITY_ACTIVE_SLOT}.writer`);
    }
  } catch {
    /* no readable barrier marker -> the anchor is the lease address */
  }
  return anchor;
}

export interface DaemonWriterLease {
  readonly path: string;
  /** Exact owner written into the lease. Runtime replacement binds its
   * admission and termination proof to this process instance, not just the
   * closure version shared by successive daemon processes. */
  readonly owner: DaemonLeaseOwner;
  release(): void;
}

export interface DaemonLeaseOwner {
  pid: number;
  token: string;
  /** Birth identity of the owning daemon, recorded at acquisition so a later
   * terminator can verify it never signals a recycled pid (W3.5/sol #5).
   * Absent on legacy leases or when the platform cannot observe identity. */
  identity?: KnownProcessIdentity;
}

export type DaemonLeaseOwnerCapability =
  | {
      status: "capable";
      reason: "identity_match" | "legacy_process_present";
      observation: ProcessObservation;
    }
  | {
      status: "proven_stale";
      reason: "process_missing" | "identity_mismatch" | "linux_zombie";
      observation: ProcessObservation;
    }
  | {
      status: "unknown";
      reason: "identity_unavailable" | "presence_unknown";
      observation: ProcessObservation;
    };

export type DaemonWriterLeaseUnknownReason =
  | "lease_unreadable"
  | "lease_unstable"
  | "invalid_lease_path"
  | "owner_missing"
  | "owner_unreadable"
  | "owner_malformed";

export type DaemonWriterLeaseStatus =
  | { status: "absent"; path: string }
  | {
      status: "owned";
      path: string;
      owner: DaemonLeaseOwner;
      capability: DaemonLeaseOwnerCapability;
    }
  | { status: "unknown"; path: string; reason: DaemonWriterLeaseUnknownReason };

type RawDaemonWriterLeaseStatus =
  | { status: "absent"; path: string }
  | { status: "owned"; path: string; owner: DaemonLeaseOwner }
  | { status: "unknown"; path: string; reason: DaemonWriterLeaseUnknownReason };

/** Narrow synchronous seam used to deterministically exercise failure/race branches. */
export interface DaemonWriterLeaseFilesystem {
  lstat(path: string): Stats;
  readText(path: string): string;
  createLeaseDirectory(path: string): void;
  writeOwner(path: string, data: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

export interface DaemonWriterLeaseDependencies {
  identity?: ProcessIdentityReader;
  /** Explicit observation capability; never inferred from an identity reader by property name. */
  observation?: ProcessObservationReader;
  /** Signal-zero probe: return for present, throw an errno-bearing error otherwise. */
  probeProcess?: (pid: number) => void;
  filesystem?: Partial<DaemonWriterLeaseFilesystem>;
}

const DEFAULT_FILESYSTEM: DaemonWriterLeaseFilesystem = {
  lstat: (path) => lstatSync(path),
  readText: (path) => readFileSync(path, "utf8"),
  createLeaseDirectory: (path) => mkdirSync(path, { mode: 0o700 }),
  writeOwner: (path, data) =>
    writeFileSync(path, data, {
      mode: 0o600,
      flag: "wx",
    }),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};

function filesystem(deps: DaemonWriterLeaseDependencies): DaemonWriterLeaseFilesystem {
  return { ...DEFAULT_FILESYSTEM, ...deps.filesystem };
}

/** Resolved filesystem seam. The root-authority in-place migration (C4)
 * shares it so its atomic steps stay deterministically observable in tests. */
export function resolveWriterLeaseFilesystem(
  deps: DaemonWriterLeaseDependencies,
): DaemonWriterLeaseFilesystem {
  return filesystem(deps);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sameOwner(left: DaemonLeaseOwner, right: DaemonLeaseOwner): boolean {
  return left.pid === right.pid && left.token === right.token;
}

function isLinuxZombieObservation(observation: ProcessObservation, pid: number): boolean {
  return (
    observation.linuxState === "Z" &&
    observation.identity.status === "known" &&
    observation.identity.pid === pid &&
    observation.identity.platform === "linux" &&
    observation.identity.source === "procfs_stat"
  );
}

function parseLeaseOwner(raw: string): DaemonLeaseOwner | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!validPositiveInteger(record.pid) || typeof record.token !== "string" || !record.token) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(record, "identity")) {
    return { pid: record.pid, token: record.token };
  }
  if (!isKnownProcessIdentity(record.identity) || record.identity.pid !== record.pid) return null;
  return { pid: record.pid, token: record.token, identity: record.identity };
}

/** Preserve the pre-strict public projection exactly; never use for authority. */
function parseLegacyLeaseOwner(raw: string): DaemonLeaseOwner | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!validPositiveInteger(record.pid) || typeof record.token !== "string") return null;
  return {
    pid: record.pid,
    token: record.token,
    ...(isKnownProcessIdentity(record.identity) ? { identity: record.identity } : {}),
  };
}

function readLegacyLeaseOwner(path: string): DaemonLeaseOwner | null {
  try {
    return parseLegacyLeaseOwner(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function inspectLeaseAfterOwnerMissing(
  path: string,
  fs: DaemonWriterLeaseFilesystem,
): RawDaemonWriterLeaseStatus {
  try {
    const lease = fs.lstat(path);
    if (lease.isSymbolicLink() || !lease.isDirectory()) {
      return { status: "unknown", path, reason: "invalid_lease_path" };
    }
    return { status: "unknown", path, reason: "owner_missing" };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "absent", path };
    return { status: "unknown", path, reason: "lease_unreadable" };
  }
}

function inspectWriterLeasePath(
  path: string,
  fs: DaemonWriterLeaseFilesystem,
): RawDaemonWriterLeaseStatus {
  let lease: Stats;
  try {
    lease = fs.lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "absent", path };
    return { status: "unknown", path, reason: "lease_unreadable" };
  }
  if (lease.isSymbolicLink() || !lease.isDirectory()) {
    return { status: "unknown", path, reason: "invalid_lease_path" };
  }

  const ownerPath = join(path, "owner.json");
  let ownerStat: Stats;
  try {
    ownerStat = fs.lstat(ownerPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return inspectLeaseAfterOwnerMissing(path, fs);
    return { status: "unknown", path, reason: "owner_unreadable" };
  }
  if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) {
    return { status: "unknown", path, reason: "owner_malformed" };
  }

  let raw: string;
  try {
    raw = fs.readText(ownerPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return inspectLeaseAfterOwnerMissing(path, fs);
    return { status: "unknown", path, reason: "owner_unreadable" };
  }
  const owner = parseLeaseOwner(raw);
  return owner
    ? { status: "owned", path, owner }
    : { status: "unknown", path, reason: "owner_malformed" };
}

type ProcessPresence = "present" | "missing" | "permission_denied" | "unknown";

function probeProcessPresence(pid: number, probe: (pid: number) => void): ProcessPresence {
  try {
    probe(pid);
    return "present";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "missing";
    if (code === "EPERM") return "permission_denied";
    return "unknown";
  }
}

export function classifyDaemonLeaseOwner(
  owner: DaemonLeaseOwner,
  deps: DaemonWriterLeaseDependencies = {},
): DaemonLeaseOwnerCapability {
  const identity =
    deps.identity ?? (owner.identity ? daemonIdentity : defaultProcessIdentityService);
  const observationReader =
    deps.observation ??
    (identity === defaultProcessIdentityService ? defaultProcessObservationReader : undefined);
  const observation = observeProcess(identity, owner.pid, observationReader);
  const probe = deps.probeProcess ?? ((pid: number) => process.kill(pid, 0));

  if (observation.identity.status === "missing") {
    return { status: "proven_stale", reason: "process_missing", observation };
  }

  if (owner.identity && observation.identity.status === "known") {
    if (compareProcessIdentity(owner.identity, observation.identity) !== "same") {
      return { status: "proven_stale", reason: "identity_mismatch", observation };
    }
    if (isLinuxZombieObservation(observation, owner.pid)) {
      return { status: "proven_stale", reason: "linux_zombie", observation };
    }
    return { status: "capable", reason: "identity_match", observation };
  }

  if (!owner.identity && observation.identity.status === "known") {
    if (isLinuxZombieObservation(observation, owner.pid)) {
      return { status: "proven_stale", reason: "linux_zombie", observation };
    }
    return { status: "capable", reason: "legacy_process_present", observation };
  }

  const presence = probeProcessPresence(owner.pid, probe);
  if (presence === "missing") {
    return { status: "proven_stale", reason: "process_missing", observation };
  }
  if (!owner.identity && (presence === "present" || presence === "permission_denied")) {
    return { status: "capable", reason: "legacy_process_present", observation };
  }
  if (presence === "present" || presence === "permission_denied") {
    return { status: "unknown", reason: "identity_unavailable", observation };
  }
  return { status: "unknown", reason: "presence_unknown", observation };
}

/** Strict authority read: only a physically missing lease path is `absent`. */
export function inspectDaemonWriterLease(
  socketPath: string,
  deps: DaemonWriterLeaseDependencies = {},
): DaemonWriterLeaseStatus {
  const path = writerLeasePath(socketPath);
  const fs = filesystem(deps);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = inspectWriterLeasePath(path, fs);
    if (raw.status !== "owned") return raw;
    const capability = classifyDaemonLeaseOwner(raw.owner, deps);
    const confirmed = inspectWriterLeasePath(path, fs);
    if (confirmed.status === "owned" && sameOwner(confirmed.owner, raw.owner)) {
      return { ...confirmed, capability };
    }
    if (attempt === 1) {
      return confirmed.status === "owned"
        ? { status: "unknown", path, reason: "lease_unstable" }
        : confirmed;
    }
  }
  return { status: "unknown", path, reason: "lease_unstable" };
}

export function writerLeaseTombstonePath(leasePath: string, owner: DaemonLeaseOwner): string {
  const digest = createHash("sha256")
    .update(String(owner.pid))
    .update("\0")
    .update(owner.token)
    .digest("hex");
  return `${leasePath}.stale-${owner.pid}-${digest}`;
}

type DaemonWriterLeaseQuarantineResult =
  { status: "quarantined"; path: string } | { status: "contended"; path: string };

/** Move exactly one observed generation; the nonempty tombstone is preserved. */
function quarantineDaemonWriterLeaseGeneration(
  lease: { path: string; owner: DaemonLeaseOwner },
  deps: DaemonWriterLeaseDependencies = {},
): DaemonWriterLeaseQuarantineResult {
  const fs = filesystem(deps);
  const tombstone = writerLeaseTombstonePath(lease.path, lease.owner);
  try {
    fs.rename(lease.path, tombstone);
    return { status: "quarantined", path: tombstone };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") {
      return { status: "contended", path: tombstone };
    }
    if (code === "EPERM") {
      const occupied = inspectWriterLeasePath(tombstone, fs);
      if (occupied.status === "owned" && sameOwner(occupied.owner, lease.owner)) {
        return { status: "contended", path: tombstone };
      }
    }
    throw error;
  }
}

function writerBusy(path: string): Error {
  return Object.assign(new Error(`another claudexor daemon owns ${path}`), {
    code: "daemon_writer_busy",
    status: 409,
  });
}

function staleReplacementFailed(path: string): Error {
  return new Error(`could not replace stale daemon writer lease ${path}`);
}

/** Claim single-writer authority before any daemon journal is opened. */
export function acquireDaemonWriterLease(
  socketPath: string,
  deps: { identity?: ProcessIdentityReader } = {},
  acquisitionDeps: Omit<DaemonWriterLeaseDependencies, "identity"> = {},
): DaemonWriterLease {
  // The second argument is a published compatibility boundary. Read only its
  // original `identity` field: downstream objects may already use any newer
  // dependency name for unrelated private/runtime state.
  const identity = deps.identity;
  const effectiveDeps: DaemonWriterLeaseDependencies = {
    identity,
    observation: acquisitionDeps.observation,
    probeProcess: acquisitionDeps.probeProcess,
    filesystem: acquisitionDeps.filesystem,
  };
  const path = writerLeasePath(socketPath);
  const token = randomUUID();
  const ownerPath = join(path, "owner.json");
  const fs = filesystem(effectiveDeps);
  const self = (identity ?? daemonIdentity).self();
  const owner: DaemonLeaseOwner = {
    pid: process.pid,
    token,
    ...(self.status === "known" ? { identity: self } : {}),
  };
  let acquired = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.createLeaseDirectory(path);
      fs.writeOwner(ownerPath, `${JSON.stringify(owner)}\n`);
      acquired = true;
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = inspectWriterLeasePath(path, fs);
      if (existing.status === "absent") continue;
      if (existing.status === "unknown") throw writerBusy(path);

      const capability = classifyDaemonLeaseOwner(existing.owner, effectiveDeps);
      if (capability.status !== "proven_stale") throw writerBusy(path);

      // Classification may have spanned an orderly release. Re-read the main
      // generation before mutation: once the observed owner is positively
      // missing/recycled/Z it cannot itself release after this point, while a
      // concurrent stale takeover leaves the occupied tombstone below as the
      // generation fence.
      const confirmed = inspectWriterLeasePath(path, fs);
      if (confirmed.status === "absent") continue;
      if (confirmed.status === "unknown") throw writerBusy(path);
      if (!sameOwner(confirmed.owner, existing.owner)) {
        if (attempt === 1) throw writerBusy(path);
        continue;
      }
      if (attempt === 1) throw staleReplacementFailed(path);

      const quarantine = quarantineDaemonWriterLeaseGeneration(confirmed, effectiveDeps);
      if (quarantine.status === "quarantined") continue;

      const current = inspectWriterLeasePath(path, fs);
      if (current.status === "unknown") throw writerBusy(path);
      if (current.status === "owned" && sameOwner(current.owner, existing.owner)) {
        throw staleReplacementFailed(path);
      }
      // Another contender changed or removed the main generation. The single
      // remaining creation attempt re-observes it without another quarantine.
    }
  }
  if (!acquired) throw staleReplacementFailed(path);

  let released = false;
  return {
    path,
    owner,
    release: () => {
      if (released) return;
      released = true;
      const current = inspectWriterLeasePath(path, fs);
      if (current.status === "owned" && sameOwner(current.owner, owner)) fs.remove(path);
    },
  };
}

/**
 * Lossy patch-compatible projection. `null` does not prove the lease path is
 * physically absent; authority-sensitive callers must use strict inspection.
 */
export function daemonLeaseOwner(socketPath: string): DaemonLeaseOwner | null {
  return readLegacyLeaseOwner(join(writerLeasePath(socketPath), "owner.json"));
}

/** Raw signal-zero presence helper; daemon serviceability uses the classifier. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}
