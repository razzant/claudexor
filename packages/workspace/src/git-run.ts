import {
  assertCaptureComplete,
  parseUnifiedDiff,
  runCaptureRaw,
  WorkspaceError,
} from "@claudexor/core";

/** A private operation decides from the bytes, whatever the user's configuration
 * says: `core.ignoreStat` would mark every entry Git adds assume-valid, so a
 * refresh and `diff-files` skip its content, and a filesystem monitor answers
 * from its own last observation instead of looking. */
export const STAT_TRUST_OFF = ["-c", "core.ignoreStat=false", "-c", "core.fsmonitor=false"];

/** A scratch index is always written whole: never as a split index (whose
 * shared part lives in the user's Git directory) and never sparse. It trusts no
 * stat shortcut, and an index copied from the user's carries over neither its
 * monitor state nor its untracked cache (both are dropped as it is read). */
export const SCRATCH_INDEX_CONFIG = [
  "-c",
  "core.splitIndex=false",
  "-c",
  "index.sparse=false",
  ...STAT_TRUST_OFF,
  "-c",
  "core.untrackedCache=false",
];

/** BYTE-FAITHFUL git capture: raw buffers, never readline — CR
 * bytes in CRLF diff content survive, and no trailing newline is fabricated
 * (trim-based consumers like revParse are unaffected: git ends its own
 * output with \n). */
export async function git(
  repo: string,
  args: string[],
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runCaptureRaw("git", ["-C", repo, ...args], {
    timeoutMs: 60_000,
    input,
    windowsConsole: "none",
  });
  assertCaptureComplete(r);
  return r;
}

export async function revParse(repo: string, ref: string): Promise<string> {
  const r = await git(repo, ["rev-parse", ref]);
  if (r.code !== 0) throw new WorkspaceError(`git rev-parse ${ref} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** `git` with extra environment (e.g. a scratch GIT_INDEX_FILE for snapshots). */
export async function gitEnv(
  repo: string,
  args: string[],
  env: Record<string, string>,
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runCaptureRaw("git", ["-C", repo, ...args], {
    timeoutMs: 60_000,
    env,
    input,
    windowsConsole: "none",
  });
  assertCaptureComplete(r);
  return r;
}

/** Capture-time honesty: with --binary a payload-less "Binary files differ"
 * stub should be impossible; if one appears anyway, fail AT CAPTURE with a
 * typed error instead of shipping a patch that cannot apply. */
export function assertNoBinaryStubs(diff: string, label: string): void {
  const stubs = parseUnifiedDiff(diff).files.filter((f) => f.binaryStub);
  if (stubs.length > 0) {
    const names = stubs.map((f) => f.newPath ?? f.oldPath ?? "(unknown)").join(", ");
    throw new WorkspaceError(
      `${label} produced undeliverable binary stub(s) for: ${names}; the work product cannot be applied`,
    );
  }
}
