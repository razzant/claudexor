import { lstatSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { isProvenNonWindowsImage, NOT_WINDOWS_IMAGE } from "./executable-inspection.js";

/** A launch candidate the resolver did not select, and why. */
export interface SkippedLaunchCandidate {
  path: string;
  reason: string;
  /** The provable non-image this candidate would have run (itself, a target, an interpreter). */
  image?: string;
}

/**
 * A launch refused before any process starts, because what the OS would run
 * is provably unable to run there. `code` is the error the spawn itself would
 * report, so callers keep the one spawn-error contract they already handle.
 */
export interface HarnessLaunchRefusal {
  code: "EFTYPE" | "ENOEXEC";
  /** The file the refused launch would have run. */
  path: string;
  message: string;
}

/**
 * A spawn failure caused by the file's format, raised by the OS or by a launch
 * refusal: the same bytes cannot start on a retry. EACCES, a busy file, a
 * missing file or an unknown loader error stay transient for their callers.
 */
export function isExecutableFormatError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return code === "EFTYPE" || code === "ENOEXEC";
}

/** The thrown form, shaped like Node's own spawn error (`code`, `path`). */
export function launchRefusalError(refusal: HarnessLaunchRefusal): Error {
  return Object.assign(new Error(refusal.message), { code: refusal.code, path: refusal.path });
}

/** `path (reason); …` — the one wording of skipped candidates. */
export function describeSkipped(items: readonly SkippedLaunchCandidate[]): string {
  return items.map((item) => `${item.path} (${item.reason})`).join("; ");
}

/** `env`'s own PATH, or undefined; Windows names variables case-insensitively. */
export function envPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  return (
    env.PATH ??
    (platform === "win32"
      ? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1]
      : undefined)
  );
}

/**
 * PATH entries as the platform's own search reads them. POSIX splits on the
 * delimiter. Windows follows libuv's `search_path`: an entry that opens with a
 * `"` or `'` runs to the same quote, so it may contain the delimiter, and one
 * leading and one trailing quote are retained here for PATH normalization.
 * Empty slices are skipped.
 */
export function rawPathEntries(
  value: string,
  platform: NodeJS.Platform,
  separator: string = delimiter,
): string[] {
  if (platform !== "win32") return value.split(separator).filter(Boolean);
  const entries: string[] = [];
  let start = 0;
  while (start < value.length) {
    const open = value[start];
    const close = open === '"' || open === "'" ? value.indexOf(open, start + 1) : start;
    const found = close < 0 ? -1 : value.indexOf(separator, close);
    const end = found < 0 ? value.length : found;
    const entry = value.slice(start, end);
    if (entry) entries.push(entry);
    start = end + 1;
  }
  return entries;
}

/** Search removes enclosing quotes; normalization must preserve their delimiters. */
export function pathEntries(
  value: string,
  platform: NodeJS.Platform,
  separator: string = delimiter,
): string[] {
  const entries = rawPathEntries(value, platform, separator);
  return platform === "win32"
    ? entries.map((entry) => entry.replace(/^["']/, "").replace(/["']$/, ""))
    : entries;
}

/**
 * The directories the resolver searches: PATH entries made absolute where the
 * daemon runs. A run and the probes that vouch for it (version, `--help`,
 * identity memos) then select the same file, and the child is given its
 * absolute path rather than a name it would resolve again in its own cwd. A
 * relative entry is dropped while the daemon's cwd is gone (POSIX allows
 * deleting it); nothing could be found through it anyway.
 */
export function harnessSearchDirs(
  pathValue: string,
  platform: NodeJS.Platform,
  separator: string = delimiter,
): string[] {
  return pathEntries(pathValue, platform, separator).flatMap((dir) => {
    try {
      return dir ? [resolve(dir)] : [];
    } catch {
      return [];
    }
  });
}

/** The remedy the refusal ends with; the resolver serves every harness. */
const REINSTALL = "the install is incomplete or damaged, reinstall it";

/**
 * Nothing selected on win32. Spawning the unresolved name hands it to libuv's
 * own search, cwd first, which can reach the very file the resolver rejected.
 * Refuse with EFTYPE when the resolver proved the install broken, since the
 * search could otherwise start a file nobody selected or inspected (an image in
 * the cwd or under a relative PATH entry), or when the search would reach a
 * provable non-image. The message leads with the refused file and the verdict,
 * so a bounded copy keeps both. An unsupported launcher script keeps ENOEXEC.
 * Otherwise null: the OS keeps its own search, which finds nothing (ENOENT) or
 * nothing proven broken.
 */
export function windowsLaunchRefusal(
  bin: string,
  pathValue: string,
  skipped: readonly SkippedLaunchCandidate[],
  platform: NodeJS.Platform,
  cwd?: string,
): HarnessLaunchRefusal | null {
  if (platform !== "win32") return null;
  const script = /\.(?:cmd|bat|ps1)$/i.test(bin);
  const target = script ? null : windowsSearchTarget(bin, pathValue, cwd ?? process.cwd());
  const searched =
    target !== null && isProvenNonWindowsImage(target)
      ? (skipped.find((item) => item.path === target) ?? {
          path: target,
          reason: NOT_WINDOWS_IMAGE,
          image: target,
        })
      : undefined;
  const refused = searched ?? skipped.find((item) => item.image !== undefined);
  if (refused?.image === undefined) {
    if (!script) return null;
    const message = skipped.length
      ? `Cannot launch ${describeSkipped(skipped)}`
      : `Unsupported Windows launcher: ${bin}`;
    return { code: "ENOEXEC", path: bin, message };
  }
  const via = refused.path === refused.image ? "" : ` (run by ${refused.path})`;
  const others = skipped.filter((item) => item !== refused);
  return {
    code: "EFTYPE",
    path: refused.image,
    message:
      `Cannot launch ${refused.image}: it ${NOT_WINDOWS_IMAGE}${via}; ${REINSTALL}` +
      (others.length ? `; also skipped ${describeSkipped(others)}` : ""),
  };
}

/**
 * The file libuv's Windows `search_path` (src/win/process.c) gives CreateProcess
 * for `file`. A name with a directory part is looked up only there; a bare name
 * in the cwd first (unless NoDefaultCurrentDirectoryInExePath is set), then in
 * each PATH entry as `pathEntries` reads it, relative to the cwd. Each place
 * tries the literal name when it has an extension, then `.com`, then `.exe`;
 * the first existing non-directory wins and the search stops there.
 */
function windowsSearchTarget(file: string, pathValue: string, cwd: string): string | null {
  const nameAt = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"), file.lastIndexOf(":")) + 1;
  const name = file.slice(nameAt);
  const dot = name.indexOf(".");
  const prefix = name.endsWith(".") ? name : `${name}.`;
  const names = [
    ...(dot >= 0 && dot < name.length - 1 ? [name] : []),
    `${prefix}com`,
    `${prefix}exe`,
  ];
  const dirs =
    nameAt > 0
      ? [file.slice(0, nameAt)]
      : [
          ...(process.env.NoDefaultCurrentDirectoryInExePath === undefined ? [""] : []),
          ...pathEntries(pathValue, "win32"),
        ];
  for (const dir of dirs) {
    for (const candidate of names.map((entry) => resolve(cwd, dir, entry))) {
      try {
        if (!lstatSync(candidate).isDirectory()) return candidate;
      } catch {
        // absent here; libuv moves on to the next name and directory
      }
    }
  }
  return null;
}
