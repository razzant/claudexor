import { closeSync, openSync, statfsSync, writeSync } from "node:fs";
import {
  assertCaptureComplete,
  runCaptureRaw,
  WorkspaceError,
  type CaptureProjection,
} from "@claudexor/core";

/** Typed classes of a Git child failure on an object path (capture, store, delivery). */
export type GitOperationFailureCode =
  | "capture_space_insufficient"
  | "capture_git_stalled"
  | "capture_git_signal"
  | "capture_read_failed"
  | "capture_object_missing"
  | "capture_failed";

/** A Git child failed on an object path. Its facts are typed; prose is never parsed downstream. */
export class GitOperationError extends WorkspaceError {
  readonly code: GitOperationFailureCode;
  readonly signal?: string;
  readonly stallMs?: number;
  readonly requiredBytes?: number;
  readonly availableBytes?: number;
  constructor(
    code: GitOperationFailureCode,
    message: string,
    facts: {
      signal?: string;
      stallMs?: number;
      requiredBytes?: number;
      availableBytes?: number;
    } = {},
  ) {
    super(message);
    this.name = "GitOperationError";
    this.code = code;
    if (facts.signal !== undefined) this.signal = facts.signal;
    if (facts.stallMs !== undefined) this.stallMs = facts.stallMs;
    if (facts.requiredBytes !== undefined) this.requiredBytes = facts.requiredBytes;
    if (facts.availableBytes !== undefined) this.availableBytes = facts.availableBytes;
  }
}

/** Default stall bound: no output and no probe progress for this long kills the
 * child. Generous on purpose: a silent read of a huge file on a slow, nearly
 * full disk is honest work; only true inactivity this long is a hang. */
export const GIT_STALL_MS = 600_000;

/** The slowest honest rate of a child with nothing to show: about 1 MiB/s. */
const SLOWEST_BYTES_PER_MS = 1024;

/**
 * The stall bound of a child whose only work is bytes it reads: hashing prints
 * nothing and moves no disk blocks, so no observation can tell it from a hang, and
 * a flat bound would refuse any result above what ten minutes can hash.
 */
export function proofStallMs(bytes: number): number {
  return GIT_STALL_MS + Math.ceil(bytes / SLOWEST_BYTES_PER_MS);
}

/**
 * What the blobs of `tree` hold in bytes, from object headers alone (no content is
 * read): the most that re-hashing its tracked files reads without a sign, since a
 * blob the repository already holds is neither printed nor written again. Zero when
 * Git cannot say, which leaves the flat bound.
 */
export async function treeBlobBytes(
  repo: string,
  tree: string,
  env: Record<string, string | null> = {},
): Promise<number> {
  let bytes = 0;
  let carry = "";
  const count = (line: string) => {
    if (/^\d+$/.test(line)) bytes += Number(line);
  };
  const listed = await gitObserved(repo, ["ls-tree", "-r", "--format=%(objectsize)", tree], {
    env,
    label: "ls-tree --format=%(objectsize)",
    allowFailure: true,
    stdout: {
      write(chunk) {
        const lines = (carry + chunk.toString("latin1")).split("\n");
        carry = lines.pop() ?? "";
        lines.forEach(count);
      },
      end: () => "",
    },
  });
  count(carry);
  return listed.code === 0 ? bytes : 0;
}

export interface ObservedGitOptions {
  /** Environment patch; `null` removes an inherited variable. */
  env?: Record<string, string | null>;
  input?: string;
  /** Receives stdout instead of the bounded in-memory capture (patch and pack bytes). */
  stdout?: CaptureProjection;
  stallMs?: number;
  /** Extra progress evidence polled by the stall watchdog (for example bytes written). */
  progress?: () => number;
  /** Short operation name for typed failure messages. */
  label: string;
}

export interface ObservedGitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Git's own diagnostics are read in the C locale so failure classes never depend on translation. */
const C_LOCALE = { LC_ALL: "C", LANGUAGE: "C" };

/** Machine classes of Git's C-locale stderr for a non-zero exit (no model prose is read).
 * EDQUOT reads "Disk quota exceeded" on Linux and "Disc quota exceeded" on macOS. */
export function classifyGitFailure(stderr: string): GitOperationFailureCode {
  if (/No space left on device|ENOSPC|Dis[ck] quota exceeded/i.test(stderr))
    return "capture_space_insufficient";
  if (
    /\bmissing (?:blob|tree|commit|tag|object)\b|\bbad object\b|unable to read [0-9a-f]{40,64}|not a valid object name|invalid object [0-9a-f]{40,64}|did not receive expected object|object [0-9a-f]{40,64} is missing/i.test(
      stderr,
    )
  )
    return "capture_object_missing";
  if (
    /read error|Input\/output error|unable to index file|short read|could not open .* for reading/i.test(
      stderr,
    )
  )
    return "capture_read_failed";
  return "capture_failed";
}

/**
 * Run one Git child on an object path. There is no wall-clock limit: a large
 * honest operation may take long, so only a STALL (no output and no probe
 * progress for `stallMs`) kills it. A stall, an external signal and a
 * non-zero exit become typed {@link GitOperationError}s; callers that accept
 * a non-zero exit (for example a refused `git apply`) pass `allowFailure`.
 */
export async function gitObserved(
  repo: string,
  args: string[],
  options: ObservedGitOptions & { allowFailure?: boolean },
): Promise<ObservedGitResult> {
  const stallMs = options.stallMs ?? GIT_STALL_MS;
  const watchdog = new AbortController();
  let lastActivity = Date.now();
  let lastProgress = options.progress?.() ?? 0;
  let stalled = false;
  const timer = setInterval(
    () => {
      const progress = options.progress?.() ?? 0;
      if (progress !== lastProgress) {
        lastProgress = progress;
        lastActivity = Date.now();
      }
      if (Date.now() - lastActivity >= stallMs) {
        stalled = true;
        watchdog.abort();
      }
    },
    Math.max(50, Math.min(2_000, Math.floor(stallMs / 4))),
  );
  timer.unref?.();
  try {
    const result = await runCaptureRaw("git", ["-C", repo, ...args], {
      env: { ...C_LOCALE, ...options.env },
      input: options.input,
      windowsConsole: "none",
      abortSignal: watchdog.signal,
      cancelSignal: "SIGKILL",
      cancelKillDelayMs: 0,
      // Output is activity whether it is buffered or goes to a sink.
      onOutput: () => {
        lastActivity = Date.now();
      },
      ...(options.stdout ? { stdoutProjection: options.stdout } : {}),
    });
    assertCaptureComplete(result);
    if (stalled) {
      throw new GitOperationError(
        "capture_git_stalled",
        `git ${options.label} made no progress for ${stallMs} ms and was stopped`,
        { stallMs },
      );
    }
    if (result.signal) {
      throw new GitOperationError(
        "capture_git_signal",
        `git ${options.label} was terminated by ${result.signal}`,
        { signal: result.signal },
      );
    }
    if (result.code !== 0 && !options.allowFailure) {
      throw new GitOperationError(
        classifyGitFailure(result.stderr),
        `git ${options.label} failed: ${result.stderr.trim().slice(0, 2_000)}`,
      );
    }
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  } finally {
    clearInterval(timer);
  }
}

/**
 * Progress evidence for a Git child that writes files without stdout (checkout,
 * `add`, clone): free blocks on the filesystem it writes move as it writes. A
 * busy filesystem can only make a stall look like progress, never the reverse.
 */
export function diskProgress(path: string): () => number {
  return () => {
    try {
      return Number(statfsSync(path).bavail);
    } catch {
      return 0;
    }
  };
}

/** Stream stdout straight to a file (patch and pack bytes never become a JS string). */
export function fileSink(path: string): CaptureProjection & { bytes: () => number } {
  const fd = openSync(path, "w", 0o600);
  let bytes = 0;
  let closed = false;
  return {
    write(chunk) {
      let done = 0;
      while (done < chunk.length) done += writeSync(fd, chunk, done, chunk.length - done);
      bytes += chunk.length;
    },
    end() {
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
      return "";
    },
    bytes: () => bytes,
  };
}
