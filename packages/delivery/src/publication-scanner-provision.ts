/**
 * Explicit preparation of the pinned publication scanner (INV-146): take one
 * official Betterleaks archive, by download or from a file, prove it against
 * the pin, and only then make the complete payload visible at its destination.
 * `publication-scanner-pin.ts` owns what is pinned and where it goes; this
 * module owns acquiring, verifying and activating it. Delivery never calls
 * this: it only locates what an explicit step already prepared.
 *
 * Self-contained on purpose (Node built-ins, erasable TypeScript only, the pin
 * passed in): the CLI and the source provisioner, which runs before dependencies
 * are installed, execute this same code.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ScannerRelease } from "./publication-scanner-pin.js";

/** Far above any pinned archive (about 10 MiB); stops an unbounded body or file. */
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
/** One bound for a whole download; a slower link can use an official archive file. */
const DOWNLOAD_TIMEOUT_MS = 600_000;
const EXTRACT_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 30_000;
/** How long a signalled child may take to end before SIGKILL. */
const KILL_GRACE_MS = 5_000;
/** How long a pipe a descendant still holds may delay an exited child's result. */
const PIPE_DRAIN_MS = 500;
const OUTPUT_LIMIT = 8_192;
const LICENSE_FILE = "LICENSE";
const LICENSE_MARKER = "MIT License";

export type ScannerProvisionCode =
  | "scanner_download_failed"
  | "scanner_archive_unreadable"
  | "scanner_archive_mismatch"
  | "scanner_extract_failed"
  | "scanner_payload_invalid"
  | "scanner_install_conflict"
  | "scanner_install_failed"
  | "scanner_prepare_cancelled";

export class ScannerProvisionError extends Error {
  readonly code: ScannerProvisionCode;
  readonly context: Record<string, unknown>;

  constructor(code: ScannerProvisionCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "ScannerProvisionError";
    this.code = code;
    this.context = context;
  }
}

/** The one official archive to prove: fetched from its pinned URL, or a file. */
export type ScannerArchiveSource =
  { kind: "download"; url: string } | { kind: "file"; path: string };

export type ScannerProvisionStage = "acquire" | "extract" | "activate";

interface ArchiveInput {
  key: string;
  release: ScannerRelease;
  source: ScannerArchiveSource;
  signal?: AbortSignal;
  /** Test seams: no surface exposes these. */
  fetchImpl?: typeof fetch;
  tarCommand?: string;
}

export interface ProvisionScannerInput extends ArchiveInput {
  version: string;
  /** The dedicated directory that holds the payload (the provisioned layout). */
  dir: string;
  onStage?: (stage: ScannerProvisionStage) => void;
}

export interface ProvisionScannerResult {
  outcome: "prepared" | "reused";
  /** A preparation running at the same time activated the payload first. */
  concurrent: boolean;
  binary: string;
  license: string;
  /** The verified archive's digest; null when an existing payload was reused. */
  archiveSha256: string | null;
  /** The private staging directory, when it could not be removed. */
  stagingLeft: string | null;
}

export const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const cancelled = () =>
  new ScannerProvisionError(
    "scanner_prepare_cancelled",
    "scanner preparation was cancelled before activation; nothing was activated",
  );

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelled();
}

function installFailed(what: string, error: unknown): ScannerProvisionError {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  return new ScannerProvisionError(
    "scanner_install_failed",
    `${what}: ${errorText(error)}`,
    errno ? { errno } : {},
  );
}

/**
 * Write the archive into `to` (a new private file) while hashing those same
 * bytes, and refuse it unless they are the pinned archive. Copying a local
 * archive means what gets extracted is exactly what was proved, and that a
 * browser's quarantine mark on the user's file is not inherited: the pin, not
 * the download route, is what vouches for these bytes.
 */
export async function acquireScannerArchive(
  input: ArchiveInput & { to: string },
): Promise<{ archiveSha256: string }> {
  const { key, release, source, to, signal } = input;
  let out: FileHandle;
  try {
    out = await open(to, "wx", 0o600);
  } catch (error) {
    throw installFailed(`could not create the ${key} archive in staging`, error);
  }
  const hash = createHash("sha256");
  let writing = false;
  let size = 0;
  try {
    for await (const chunk of await archiveBody(input)) {
      throwIfCancelled(signal);
      size += chunk.byteLength;
      if (size > MAX_ARCHIVE_BYTES)
        throw new ScannerProvisionError(
          "scanner_archive_mismatch",
          `${key} archive is larger than any pinned archive (over ${MAX_ARCHIVE_BYTES} bytes), so it is not ${release.asset}`,
        );
      hash.update(chunk);
      writing = true;
      await out.writeFile(chunk);
      writing = false;
    }
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (error instanceof ScannerProvisionError) throw error;
    if (writing) throw installFailed(`could not write the ${key} archive to staging`, error);
    throw source.kind === "download"
      ? downloadFailed(release, errorText(error))
      : archiveUnreadable(source.path, errorText(error));
  } finally {
    await out.close();
  }
  const archiveSha256 = hash.digest("hex");
  if (archiveSha256 !== release.archiveSha256)
    throw new ScannerProvisionError(
      "scanner_archive_mismatch",
      `${key} archive digest ${archiveSha256} is not the pinned ${release.archiveSha256} (${release.asset})`,
      { archiveSha256, expected: release.archiveSha256, asset: release.asset },
    );
  return { archiveSha256 };
}

function downloadFailed(release: ScannerRelease, why: string) {
  return new ScannerProvisionError(
    "scanner_download_failed",
    `download of ${release.asset} failed: ${why}`,
  );
}

function archiveUnreadable(path: string, why: string) {
  return new ScannerProvisionError(
    "scanner_archive_unreadable",
    `the archive ${path} cannot be read: ${why}`,
  );
}

async function archiveBody(input: ArchiveInput): Promise<AsyncIterable<Uint8Array>> {
  const { release, source, signal } = input;
  throwIfCancelled(signal);
  if (source.kind === "file") {
    let regular: boolean;
    try {
      regular = statSync(source.path).isFile();
    } catch (error) {
      throw archiveUnreadable(source.path, errorText(error));
    }
    if (!regular) throw archiveUnreadable(source.path, "it is not a regular file");
    return createReadStream(source.path, signal ? { signal } : {});
  }
  const bound = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(source.url, {
      redirect: "follow",
      signal: signal ? AbortSignal.any([signal, bound]) : bound,
    });
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    const cause = (error as { cause?: unknown } | undefined)?.cause;
    throw downloadFailed(
      release,
      cause ? `${errorText(error)} (${errorText(cause)})` : errorText(error),
    );
  }
  if (!response.ok || !response.body) throw downloadFailed(release, `HTTP ${response.status}`);
  return response.body as unknown as AsyncIterable<Uint8Array>;
}

/**
 * Prove one archive against the pin and extract its binary and license into
 * `<work>/payload`. Nothing there is trusted before both digests and the
 * license check pass; the caller owns and removes `work`.
 */
export async function extractVerifiedScanner(
  input: ArchiveInput & { work: string; onStage?: (stage: ScannerProvisionStage) => void },
): Promise<{ archiveSha256: string; binary: string; license: string; payload: string }> {
  const { key, release, work, signal } = input;
  input.onStage?.("acquire");
  const archive = join(work, "archive");
  const { archiveSha256 } = await acquireScannerArchive({ ...input, to: archive });
  input.onStage?.("extract");
  const payload = join(work, "payload");
  mkdirSync(payload, { mode: 0o700 });
  // bsdtar (macOS, Windows) reads both formats; GNU tar only meets .tar.gz.
  const extracted = await runOwnedChild(
    input.tarCommand ?? "tar",
    ["-xf", archive, "-C", payload, release.binary, LICENSE_FILE],
    { timeoutMs: EXTRACT_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
  throwIfCancelled(signal);
  if (extracted.failure)
    throw new ScannerProvisionError(
      "scanner_extract_failed",
      `could not extract ${release.asset}: ${extracted.failure}`,
    );
  const binary = join(payload, release.binary);
  const license = join(payload, LICENSE_FILE);
  try {
    chmodSync(binary, 0o755);
  } catch {
    // A binary the archive did not yield is named by the check below.
  }
  const problem = payloadProblem(key, release, binary, license);
  if (problem) throw new ScannerProvisionError("scanner_payload_invalid", problem);
  return { archiveSha256, binary, license, payload };
}

/** What is wrong with a binary and license as the pinned payload, if anything. */
function payloadProblem(
  key: string,
  release: ScannerRelease,
  binary: string,
  license: string,
): string | null {
  let digest: string;
  try {
    if (!statSync(binary).isFile()) return `${binary} is not a regular file`;
    digest = sha256File(binary);
  } catch (error) {
    return `${binary} cannot be read: ${errorText(error)}`;
  }
  if (digest !== release.binarySha256)
    return `${key} binary digest ${digest} is not the pinned ${release.binarySha256}`;
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    return `${binary} is not executable`;
  }
  try {
    if (readFileSync(license, "utf8").includes(LICENSE_MARKER)) return null;
  } catch {
    // Missing or unreadable reads the same to the caller as the wrong text.
  }
  return `${key} LICENSE at ${license} is not the expected MIT license`;
}

/** A pinned build for this host must also run: the same offline `version`
 * probe the engine-resource build uses. Another platform's build cannot run. */
async function probeProblem(input: ProvisionScannerInput, binary: string): Promise<string | null> {
  if (input.key !== `${process.platform}-${process.arch}`) return null;
  const { signal, version } = input;
  const probe = await runOwnedChild(binary, ["version"], {
    timeoutMs: PROBE_TIMEOUT_MS,
    cwd: dirname(binary),
    ...(signal ? { signal } : {}),
  });
  throwIfCancelled(signal);
  if (probe.failure) return `${binary} does not run here: ${probe.failure}`;
  return probe.stdout.split(/\r?\n/).includes(version)
    ? null
    : `${binary} did not report version ${version}`;
}

type TargetState =
  | { state: "absent" }
  | { state: "empty" }
  | { state: "valid" }
  | { state: "invalid"; reason: string };

const payloadPaths = (dir: string, release: ScannerRelease) => ({
  binary: join(dir, release.binary),
  license: join(dir, LICENSE_FILE),
});

async function inspectTarget(input: ProvisionScannerInput): Promise<TargetState> {
  const { dir, release, key } = input;
  const { binary, license } = payloadPaths(dir, release);
  try {
    const entry = lstatSync(dir, { throwIfNoEntry: false });
    if (!entry) return { state: "absent" };
    if (entry.isDirectory() && readdirSync(dir).length === 0) return { state: "empty" };
    if (!statSync(dir).isDirectory())
      return { state: "invalid", reason: `${dir} is not a directory` };
  } catch (error) {
    return { state: "invalid", reason: `${dir} cannot be read: ${errorText(error)}` };
  }
  const problem =
    payloadProblem(key, release, binary, license) ?? (await probeProblem(input, binary));
  return problem ? { state: "invalid", reason: problem } : { state: "valid" };
}

function conflict(input: ProvisionScannerInput, reason: string): ScannerProvisionError {
  const { dir } = input;
  return new ScannerProvisionError(
    "scanner_install_conflict",
    `${dir} already exists but is not the complete pinned Betterleaks ${input.version}, so it was left untouched: ${reason}. Remove it and run this again.`,
    { path: dir, reason },
  );
}

/** Make the payload directory visible in one rename; returns why that did not happen. */
function activate(dir: string, payload: string, emptyTarget: boolean): { failure: unknown } | null {
  // An empty directory holds nothing to clobber, and platforms disagree on
  // renaming onto one. A directory with content always refuses the rename.
  if (emptyTarget) {
    try {
      rmdirSync(dir);
    } catch {
      // Someone else's step; the rename below decides.
    }
  }
  try {
    renameSync(payload, dir);
    return null;
  } catch (failure) {
    return { failure };
  }
}

/**
 * Prepare the pinned scanner in its dedicated directory `dir`. A verified complete payload already
 * there is reused without rewriting it (nothing is read from the network or the
 * archive); anything else there is a typed conflict, left untouched. Otherwise
 * the archive is proved and extracted in a unique sibling staging directory,
 * and the complete payload becomes visible only after every check passed.
 *
 * Cancellation reaches the download or file copy and the owned child, whose exit
 * is awaited. From the last check through activation the code is synchronous, so
 * a cancellation accepted before that point never activates, and one arriving
 * after it finds an activation that already happened: the caller reports that.
 * A concurrent winner is verified and reused. Nothing here syncs to disk: a copy
 * torn by a power loss fails its digest at the next resolve or preparation.
 */
export async function provisionScanner(
  input: ProvisionScannerInput,
): Promise<ProvisionScannerResult> {
  const { dir: at, release, signal } = input;
  const paths = payloadPaths(at, release);
  const existing = await inspectTarget(input);
  throwIfCancelled(signal);
  if (existing.state === "invalid") throw conflict(input, existing.reason);
  if (existing.state === "valid")
    return {
      outcome: "reused",
      concurrent: false,
      ...paths,
      archiveSha256: null,
      stagingLeft: null,
    };
  const parent = dirname(at);
  let staging: string;
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    staging = mkdtempSync(join(parent, `.${basename(at)}.staging-`));
  } catch (error) {
    throw installFailed(`could not create a staging directory beside ${at}`, error);
  }
  const dropStaging = (): string | null => {
    try {
      rmSync(staging, { recursive: true, force: true });
      return null;
    } catch {
      return staging;
    }
  };
  try {
    const payload = await extractVerifiedScanner({ ...input, work: staging });
    const problem = await probeProblem(input, payload.binary);
    if (problem) throw new ScannerProvisionError("scanner_payload_invalid", problem);
    input.onStage?.("activate");
    throwIfCancelled(signal);
    const refused = activate(at, payload.payload, existing.state === "empty");
    if (!refused) {
      const { archiveSha256 } = payload;
      return {
        outcome: "prepared",
        concurrent: false,
        ...paths,
        archiveSha256,
        stagingLeft: dropStaging(),
      };
    }
    const now = await inspectTarget(input);
    if (now.state === "invalid") throw conflict(input, now.reason);
    if (now.state !== "valid")
      throw installFailed(`could not activate the payload at ${at}`, refused.failure);
    return {
      outcome: "reused",
      concurrent: true,
      ...paths,
      archiveSha256: null,
      stagingLeft: dropStaging(),
    };
  } catch (error) {
    const left = dropStaging();
    const typed =
      error instanceof ScannerProvisionError
        ? error
        : signal?.aborted
          ? cancelled()
          : installFailed(`could not prepare the scanner at ${at}`, error);
    if (left) typed.context["stagingLeft"] = left;
    throw typed;
  }
}

/** Run one child this process owns; `failure` is null only for a clean exit 0. A
 * started child's result, on a cancellation or timeout too, comes only after it
 * has exited. */
function runOwnedChild(
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; cwd?: string },
): Promise<{ failure: string | null; stdout: string }> {
  const { signal, timeoutMs, cwd } = options;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(cwd ? { cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    const keep = (text: string, chunk: string) =>
      text.length >= OUTPUT_LIMIT ? text : (text + chunk).slice(0, OUTPUT_LIMIT);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout = keep(stdout, chunk)));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr = keep(stderr, chunk)));
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    signal?.addEventListener("abort", stop, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const finish = (failure: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(drain);
      signal?.removeEventListener("abort", stop);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ failure, stdout });
    };
    if (signal?.aborted) stop();
    // Only a failed spawn has no exit to wait for; a failed kill keeps waiting.
    child.once("error", (error) => {
      if (child.pid === undefined) finish(errorText(error));
    });
    const outcome = (code: number | null, killed: NodeJS.Signals | null) =>
      timedOut
        ? `timed out after ${timeoutMs} ms`
        : code === 0
          ? null
          : `${killed ? `killed by ${killed}` : `exit ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
    child.once("exit", (code, killed) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      // Exit is the proof of termination; a descendant still holding a pipe must
      // not hold this result, so its output gets only a short drain.
      drain = setTimeout(() => finish(outcome(code, killed)), PIPE_DRAIN_MS);
      child.once("close", () => finish(outcome(code, killed)));
    });
  });
}
