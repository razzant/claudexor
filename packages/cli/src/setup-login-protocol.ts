import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { withExecutableInspection, isBoundedRegularExecutable } from "@claudexor/core";
import {
  SetupLoginDeviceCode as SetupLoginDeviceCodeSchema,
  SetupLoginManifest as SetupLoginManifestSchema,
  SetupLoginPermit as SetupLoginPermitSchema,
  SetupLoginRunnerResult as SetupLoginRunnerResultSchema,
  SetupLoginRunnerState as SetupLoginRunnerStateSchema,
  type SetupLoginDeviceCode,
  type SetupLoginManifest,
  type SetupLoginPermit,
  type SetupLoginRunnerResult,
  type SetupLoginRunnerState,
  type SetupExecutableEvidence,
  type SetupProcessGroupHandle,
} from "@claudexor/schema";

export type {
  SetupLoginDeviceCode,
  SetupLoginManifest,
  SetupLoginPermit,
  SetupLoginRunnerResult,
  SetupLoginRunnerState,
  SetupProcessGroupHandle,
  SetupExecutableEvidence,
};

export const SETUP_LOGIN_PROTOCOL_VERSION = 2 as const;
const MAX_SIDECAR_BYTES = 1024 * 1024;

export function readLoginManifest(path: string): SetupLoginManifest {
  const absolutePath = resolve(path);
  const parentStat = lstatSync(dirname(absolutePath));
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("setup-login job directory is unsafe");
  }
  const jobDir = realpathSync(dirname(absolutePath));
  const manifest = SetupLoginManifestSchema.parse(readPrivateJson(absolutePath));
  assertManifestDigests(manifest);
  const declaredJobStat = lstatSync(manifest.jobDir);
  if (declaredJobStat.isSymbolicLink() || !declaredJobStat.isDirectory()) {
    throw new Error("setup-login job directory is unsafe");
  }
  if (realpathSync(manifest.jobDir) !== jobDir) {
    throw new Error("setup-login manifest job directory does not match its daemon-owned parent");
  }
  const stateParent = realpathSync(dirname(resolve(manifest.statePath)));
  const resultParent = realpathSync(dirname(resolve(manifest.resultPath)));
  const permitParent = realpathSync(dirname(resolve(manifest.permitPath)));
  if (
    stateParent !== jobDir ||
    resultParent !== jobDir ||
    permitParent !== jobDir ||
    basename(manifest.statePath) !== "runner-state.json" ||
    basename(manifest.resultPath) !== "runner-result.json" ||
    basename(manifest.permitPath) !== "runner-permit.json"
  ) {
    throw new Error("setup-login sidecar path escapes or relocates its daemon-owned job directory");
  }
  if (manifest.deviceCodePath !== undefined) {
    const deviceCodeParent = realpathSync(dirname(resolve(manifest.deviceCodePath)));
    if (
      deviceCodeParent !== jobDir ||
      basename(manifest.deviceCodePath) !== "runner-devicecode.json"
    ) {
      throw new Error(
        "setup-login device-code sidecar escapes or relocates its daemon-owned job directory",
      );
    }
  }
  const cwd = realpathSync(manifest.cwd);
  if (cwd !== jobDir && !cwd.startsWith(jobDir + sep))
    throw new Error("setup-login cwd escapes its job directory");
  return manifest;
}

export function captureExecutableEvidence(path: string): SetupExecutableEvidence {
  // Shared fact producer (identity + facts, O_NOFOLLOW canonical, same fd handed
  // back for a byte-faithful hash). Evidence pins dev+inode+sha256, which fully
  // identify the exact bytes that will run; the link count is deliberately NOT a
  // rejection here (the official vendor installer hard-links its platform binary,
  // nlink === 2, and Claudexor never writes it). nlink === 1 stays strict only
  // for daemon-OWNED mutable files at their own call-sites (journal, token).
  return withExecutableInspection(path, (info, fd) => {
    if (!isBoundedRegularExecutable(info)) {
      throw new Error("setup executable is not a stable bounded regular file");
    }
    const bytes = readFileSync(fd);
    return {
      realpath: info.realpath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: info.size,
      mode: info.mode,
      device: info.device,
      inode: info.inode,
    };
  });
}

export function commandDigest(
  executable: SetupExecutableEvidence,
  args: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ executable, args: [...args] }))
    .digest("hex");
}

export function sealLoginManifest(
  value: Omit<SetupLoginManifest, "manifestDigest">,
): SetupLoginManifest {
  const manifestDigest = digestJson(value);
  return SetupLoginManifestSchema.parse({ ...value, manifestDigest });
}

export function verifyExecutableEvidence(expected: SetupExecutableEvidence): boolean {
  try {
    return (
      JSON.stringify(captureExecutableEvidence(expected.realpath)) === JSON.stringify(expected)
    );
  } catch {
    return false;
  }
}

function assertManifestDigests(manifest: SetupLoginManifest): void {
  const { manifestDigest, ...unsigned } = manifest;
  if (digestJson(unsigned) !== manifestDigest)
    throw new Error("setup-login manifest digest mismatch");
  if (manifest.binary !== manifest.executable.realpath)
    throw new Error("setup-login manifest binary contradicts executable evidence");
  if (commandDigest(manifest.executable, manifest.args) !== manifest.commandDigest) {
    throw new Error("setup-login manifest command digest mismatch");
  }
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function readRunnerState(path: string): SetupLoginRunnerState | null {
  try {
    return SetupLoginRunnerStateSchema.parse(readPrivateJson(path));
  } catch {
    return null;
  }
}

export function readRunnerResult(path: string): SetupLoginRunnerResult | null {
  try {
    return SetupLoginRunnerResultSchema.parse(readPrivateJson(path));
  } catch {
    return null;
  }
}

export function readRunnerPermit(path: string): SetupLoginPermit | null {
  try {
    return SetupLoginPermitSchema.parse(readPrivateJson(path));
  } catch {
    return null;
  }
}

export function readRunnerDeviceCode(path: string): SetupLoginDeviceCode | null {
  try {
    return SetupLoginDeviceCodeSchema.parse(readPrivateJson(path));
  } catch {
    return null;
  }
}

export function atomicPrivateJson(path: string, value: unknown): void {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`setup-login sidecar parent is unsafe: ${parent}`);
  }
  const tmp = join(parent, `.${randomUUID()}.tmp`);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
  if (bytes.length > MAX_SIDECAR_BYTES) throw new Error("setup-login sidecar exceeds size limit");
  let fd: number | undefined;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("setup-login temporary sidecar is not a regular file");
    fchmodSync(fd, 0o600);
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, absolute);
    fsyncDirectory(parent);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}

function readPrivateJson(path: string): unknown {
  const absolute = resolve(path);
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_SIDECAR_BYTES) {
      throw new Error("setup-login sidecar is not a bounded regular file");
    }
    const named = lstatSync(absolute);
    if (
      named.isSymbolicLink() ||
      !named.isFile() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    ) {
      throw new Error("setup-login sidecar changed during safe open");
    }
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
