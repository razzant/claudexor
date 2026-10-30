/**
 * The publication scanner: pinned Betterleaks over exactly what would leave
 * this machine (INV-146). It is the ONE content check in Claudexor and runs only
 * at the public boundary — `pr` delivery and the repository's own CI — never on
 * private working content.
 *
 * Self-contained on purpose (Node built-ins, erasable TypeScript only): CI runs
 * this same source with Node's type stripping before dependencies are
 * installed, so delivery and CI cannot drift into two detectors. Which binary
 * runs (the release pin and its location) is `publication-scanner-pin.ts`.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Text that leaves with the push but is not file content (commit messages,
 * branch name, PR title and body). */
export interface PublicationMetadata {
  label: string;
  text: string;
}

/** A finding as it may be shown: rule, where, never the matched text. */
export interface PublicationFinding {
  ruleId: string;
  location: string;
  line: number | null;
  commit: string | null;
}

export type PublicationScanResult =
  | { status: "clean" }
  | { status: "findings"; findings: PublicationFinding[] }
  | { status: "failed"; reason: string };

const DEFAULT_TIMEOUT_MS = 300_000;
/** Fixed scanner flags: inline allow comments ignored, values redacted, no live validation. */
const FLAGS = [
  "--ignore-gitleaks-allow",
  "--validation=false",
  "--redact=100",
  "--exit-code",
].concat("0 --report-format json --no-banner --no-color --log-level error".split(" "));

/** What every scanner run of one publication shares: the pinned binary, its
 * flags (explicit config and empty ignore file), environment, bound and
 * private work directory. */
interface ScanContext {
  scanner: string;
  common: (report: string) => string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  work: string;
}
type Report = { ok: true; findings: Record<string, unknown>[] } | { ok: false; reason: string };

/**
 * Scan the outgoing Git range (`git log` options naming exactly what will be
 * sent, so earlier unsent commits, a secret added then deleted included, are in
 * scope), its commit messages and the outgoing metadata. A scan that cannot
 * prove its result is `failed`, never `clean`. Merges are read with
 * `--diff-merges=remerge` (Git 2.36+: only what a merge changed beyond Git's
 * automatic merge); octopus merges, which have no remerge view, are scanned
 * again over their first parent. The subject cannot reconfigure the scanner:
 * the default rule set is explicit, inline allow comments are ignored,
 * Betterleaks environment overrides are dropped, history is read through a
 * neutral root, and live validation is off.
 */
export async function scanPublication(input: {
  scanner: string;
  repoRoot: string;
  /** The outgoing commit range as `git log` options; the caller owns it
   * (`pr`: `<commit> --not <destination tips>`; CI: the event's range). */
  logOpts: string;
  /** Also scan this commit's complete tracked tree (CI repository hygiene).
   * Attributes committed in that tree do not apply; the operator's own Git
   * configuration does. */
  treeish?: string;
  metadata: readonly PublicationMetadata[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<PublicationScanResult> {
  const work = mkdtempSync(join(tmpdir(), "claudexor-publication-scan-"));
  try {
    const config = join(work, "betterleaks.toml");
    writeFileSync(config, "[extend]\nuseDefault = true\n", { mode: 0o600 });
    const ignore = join(work, "empty.ignore");
    writeFileSync(ignore, "", { mode: 0o600 });
    const env = scannerEnv(input.env ?? process.env);
    const gitDir = await absoluteGitDir(input.repoRoot, env);
    if (!gitDir)
      return { status: "failed", reason: "the repository's Git directory is unreadable" };
    const neutral = join(work, "history");
    mkdirSync(neutral, { mode: 0o700 });
    writeFileSync(join(neutral, ".git"), `gitdir: ${gitDir}\n`, { mode: 0o600 });
    const flags = ["--config", config, "--gitleaks-ignore-path", ignore, ...FLAGS];
    const common = (report: string) => [...flags, "--report-path", report];
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const ctx: ScanContext = { scanner: input.scanner, common, env, timeoutMs, work };
    const shown = (locations: readonly string[], name: string) =>
      shownLocations(locations, (items) => scanTexts(ctx, items, name));
    const range = input.logOpts.split(/\s+/).filter(Boolean);
    const history = await runGitReport(
      ctx,
      ["git", neutral, "--log-opts", ["--diff-merges=remerge", ...range].join(" ")],
      "history.json",
    );
    if (!history.ok) return { status: "failed", reason: `history scan ${history.reason}` };
    const octopusList = await logToFile(
      input.repoRoot,
      ["--min-parents=3", "--format=%H", ...range],
      join(work, "octopus.txt"),
      env,
      timeoutMs,
    );
    if (octopusList === null)
      return { status: "failed", reason: "the outgoing range's merges could not be listed" };
    const octopus = octopusList.split("\n").filter((sha) => /^[0-9a-f]{40,64}$/.test(sha));
    const octopusOpts = `--diff-merges=first-parent --no-walk=unsorted ${octopus.join(" ")}`;
    const octopusScan: Report = octopus.length
      ? await runGitReport(ctx, ["git", neutral, "--log-opts", octopusOpts], "octopus.json")
      : { ok: true, findings: [] };
    if (!octopusScan.ok)
      return { status: "failed", reason: `octopus merge scan ${octopusScan.reason}` };
    const messageLog = await logToFile(
      input.repoRoot,
      ["--format=%H%x00%B%x00", ...range],
      join(work, "messages.txt"),
      env,
      timeoutMs,
    );
    if (messageLog === null)
      return { status: "failed", reason: "the outgoing commit messages could not be read" };
    const parts = messageLog.split("\0");
    const metadataItems: PublicationMetadata[] = [...input.metadata];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const sha = parts[index]!.trim();
      if (sha)
        metadataItems.push({
          label: `commit message ${sha.slice(0, 12)}`,
          text: parts[index + 1]!,
        });
    }
    const tree: Report = input.treeish
      ? await scanTree(ctx, neutral, input.treeish, shown)
      : { ok: true, findings: [] };
    if (!tree.ok) return { status: "failed", reason: `tree scan ${tree.reason}` };
    const metadata = await scanTexts(
      ctx,
      metadataItems.map((item) => item.text),
      "metadata",
    );
    if (!metadata.ok) return { status: "failed", reason: `metadata scan ${metadata.reason}` };
    const findings = [
      ...[...history.findings, ...octopusScan.findings, ...tree.findings].map((raw) =>
        publicFinding(raw, null),
      ),
      ...metadata.found.map(({ raw, index }) =>
        publicFinding(raw, metadataItems[index]?.label ?? "publication metadata"),
      ),
    ];
    if (!findings.length) return { status: "clean" };
    const show = await shown(
      findings.map((finding) => finding.location),
      "locations",
    );
    return {
      status: "findings",
      findings: findings.map((finding) => ({ ...finding, location: show(finding.location) })),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** One line per finding for refusals and CI logs: rule and place, never a value. */
export function describeFindings(findings: readonly PublicationFinding[], limit = 10): string {
  const lines = findings
    .slice(0, limit)
    .map(
      (f) =>
        `${f.ruleId} in ${f.location}${f.line === null ? "" : `:${f.line}`}${f.commit ? ` (commit ${f.commit.slice(0, 12)})` : ""}`,
    );
  if (findings.length > limit) lines.push(`+${findings.length - limit} more`);
  return lines.join("; ");
}

function scannerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^(BETTERLEAKS|GITLEAKS)_/i.test(key)) continue;
    env[key] = value;
  }
  // The neutral root's index is never used; keep Git from refreshing it.
  env["GIT_OPTIONAL_LOCKS"] = "0";
  return env;
}

/** `git log` over the outgoing range into a private file (never truncated);
 * null when Git cannot read it. Signature display is off so the format is exact. */
async function logToFile(
  repoRoot: string,
  args: string[],
  out: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | null> {
  const result = await run(
    "git",
    ["-C", repoRoot, "-c", "log.showSignature=false", "log", `--output=${out}`, ...args],
    repoRoot,
    env,
    timeoutMs,
  );
  if (result.timedOut || result.code !== 0) return null;
  try {
    return readFileSync(out, "utf8");
  } catch {
    return null;
  }
}

async function absoluteGitDir(repoRoot: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const result = await run(
    "git",
    ["-C", repoRoot, "rev-parse", "--absolute-git-dir"],
    repoRoot,
    env,
    30_000,
  );
  const dir = result.stdout.trim();
  return result.code === 0 && dir ? dir : null;
}

/** The commit's tracked blobs, extracted privately from the neutral root with
 * worktree attributes and no index: attributes committed in the scanned tree
 * (export-ignore, export-subst, encoding, eol, filters) do not apply, the
 * operator's own Git configuration does. Betterleaks loads the scanned root's
 * `.gitleaksignore`/`.betterleaksignore` as ignore lists, so those two are
 * scanned under private names and reported under their tracked paths. The
 * extraction is checked against the commit's inventory first, so a path the
 * file system folded into another (case or Unicode normalization) fails the
 * scan. Limit: a tracked directory whose name differs only in case from
 * another's shares its directory, and a finding there carries its spelling. */
async function scanTree(
  ctx: ScanContext,
  neutral: string,
  treeish: string,
  shown: (names: readonly string[], name: string) => Promise<(name: string) => string>,
): Promise<Report> {
  const { env, timeoutMs, work } = ctx;
  const archive = join(work, "tree.tar");
  const root = join(work, "tree");
  mkdirSync(root, { mode: 0o700 });
  const exported = await run(
    "git",
    ["-C", neutral, "archive", "--worktree-attributes", "--format=tar", "-o", archive, treeish],
    work,
    { ...env, GIT_INDEX_FILE: join(work, "no-index") },
    timeoutMs,
  );
  if (exported.code !== 0) return { ok: false, reason: "could not export the tracked tree" };
  const extracted = await run("tar", ["-xf", archive, "-C", root], work, env, timeoutMs);
  if (extracted.code !== 0) return { ok: false, reason: "could not extract the tracked tree" };
  const listing = join(work, "tree.list");
  const listed = await run(
    "git",
    ["-C", neutral, "ls-tree", "-r", "-z", "--full-tree", treeish],
    work,
    { ...env, GIT_INDEX_FILE: join(work, "no-index") },
    timeoutMs,
    listing,
  );
  if (listed.code !== 0) return { ok: false, reason: "could not list the tracked tree" };
  // The reason names tracked paths; a name may itself be a detected secret.
  const named: string[] = [];
  let materialized = verifyMaterializedTree(root, readFileSync(listing), (n) => (named.push(n), n));
  if (!materialized.ok && named.length)
    materialized = verifyMaterializedTree(
      root,
      readFileSync(listing),
      await shown(named, "tree-locations"),
    );
  if (!materialized.ok) return materialized;
  const aliases = new Map<string, string>();
  try {
    for (const name of [".gitleaksignore", ".betterleaksignore"]) {
      if (!present(join(root, name))) continue;
      let alias: string;
      do alias = `claudexor-scan-${randomBytes(8).toString("hex")}`;
      while (present(join(root, alias)));
      renameSync(join(root, name), join(root, alias));
      aliases.set(alias, name);
    }
  } catch {
    return { ok: false, reason: "could not set aside the tree's ignore files" };
  }
  const result = await runReport(ctx, ["dir", root], "tree.json");
  if (!result.ok) return result;
  // Report tracked paths, not the private extraction directory.
  const prefix = `${root.replaceAll("\\", "/")}/`;
  return {
    ok: true,
    findings: result.findings.map((raw) => {
      const file = typeof raw["File"] === "string" ? raw["File"].replaceAll("\\", "/") : "";
      if (!file.startsWith(prefix)) return { ...raw, File: file };
      const path = file.slice(prefix.length);
      const head = path.split("/", 1)[0]!;
      const tracked = aliases.get(head);
      return { ...raw, File: tracked ? tracked + path.slice(head.length) : path };
    }),
  };
}

/**
 * Check an extracted tree against its `git ls-tree -r -z --full-tree` listing:
 * every blob and symlink exists, regular blobs as regular files, and no two
 * tracked paths share one file (dev, ino) on this file system. Gitlinks are
 * not archived and are skipped. Sizes and bytes are not compared: the
 * operator's own Git configuration may legitimately convert them.
 */
export function verifyMaterializedTree(
  root: string,
  listing: Buffer,
  show: (name: string) => string = (name) => name,
): { ok: true } | { ok: false; reason: string } {
  const missing: string[] = [];
  const shared: string[] = [];
  const seen = new Map<string, string>();
  // latin1 keeps each path's raw bytes for lstat; names are shown as UTF-8.
  for (const record of listing.toString("latin1").split("\0")) {
    const tab = record.indexOf("\t");
    const [mode, type] = record.slice(0, tab).split(" ");
    if (tab < 0 || type === "commit") continue;
    const raw = Buffer.from(record.slice(tab + 1), "latin1");
    const name = raw.toString("utf8");
    let stat;
    try {
      stat = lstatSync(Buffer.concat([Buffer.from(`${root}/`), raw]), { bigint: true });
    } catch {
      stat = null;
    }
    // A symlink may extract as a file (Windows tar); a directory means a collision.
    if (!stat || (mode === "120000" ? stat.isDirectory() : !stat.isFile())) {
      missing.push(show(name));
      continue;
    }
    if (stat.ino === 0n)
      return { ok: false, reason: "found no file identity to verify the extraction" };
    const key = `${stat.dev}:${stat.ino}`;
    const other = seen.get(key);
    if (other === undefined) seen.set(key, name);
    else shared.push(`${show(other)} = ${show(name)}`);
  }
  const some = (items: string[]) =>
    items.slice(0, 3).join(", ") + (items.length > 3 ? ` (+${items.length - 3} more)` : "");
  if (missing.length)
    return { ok: false, reason: `did not extract tracked paths: ${some(missing)}` };
  if (shared.length)
    return { ok: false, reason: `found tracked paths sharing one extracted file: ${some(shared)}` };
  return { ok: true };
}

/** Scan short texts, one private file each, with the same pinned scanner and
 * flags (explicit config, no live validation); each finding carries the index
 * of its text. */
async function scanTexts(
  ctx: ScanContext,
  items: readonly string[],
  name: string,
): Promise<
  | { ok: true; found: Array<{ raw: Record<string, unknown>; index: number }> }
  | { ok: false; reason: string }
> {
  if (!items.length) return { ok: true, found: [] };
  const dir = join(ctx.work, name);
  mkdirSync(dir, { mode: 0o700 });
  items.forEach((text, i) => writeFileSync(join(dir, `text-${i + 1}.txt`), text, { mode: 0o600 }));
  const result = await runReport(ctx, ["dir", dir], `${name}.json`);
  if (!result.ok) return result;
  const index = (raw: Record<string, unknown>) =>
    Number(/text-(\d+)\.txt$/.exec(String(raw["File"]).replaceAll("\\", "/"))?.[1] ?? 0) - 1;
  return { ok: true, found: result.findings.map((raw) => ({ raw, index: index(raw) })) };
}

/** How locations may be shown (INV-146). Betterleaks redacts the value it
 * matched but reports a path or label as given, so each distinct location is
 * scanned itself; one the scanner flags, or every one when that check cannot
 * run, becomes a value-free locator (rule, line and commit stay). */
async function shownLocations(
  locations: readonly string[],
  scan: (items: readonly string[]) => ReturnType<typeof scanTexts>,
): Promise<(location: string) => string> {
  const distinct = [...new Set(locations)];
  const scanned = await scan(distinct.map((location) => `${location}\n`));
  const flagged = new Set(scanned.ok ? scanned.found.map((f) => distinct[f.index]) : distinct);
  return (location) => {
    if (!flagged.has(location)) return location;
    const digest = createHash("sha256").update(location).digest("hex").slice(0, 12);
    return `withheld location (sha256 ${digest})`;
  };
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A git-mode scan whose history stream is proven complete. Betterleaks pipes
 * `git log -p`, and when that process dies by a signal without writing to
 * stderr the scanner still exits 0 with an empty report. Every Git process the
 * scanner starts inherits `GIT_TRACE2_EVENT` pointing at a private directory,
 * where Git itself records start, command name, signal and exit; the scan only
 * counts when that trace proves every `git log` finished with code 0.
 */
async function runGitReport(ctx: ScanContext, target: string[], report: string): Promise<Report> {
  const traceDir = mkdtempSync(join(ctx.work, "git-trace-"));
  const traced: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(ctx.env))
    if (!/^GIT_TRACE2/i.test(key)) traced[key] = value;
  traced["GIT_TRACE2_EVENT"] = traceDir;
  const result = await runReport(ctx, target, report, traced);
  if (!result.ok) return result;
  const stream = verifyGitStreamTrace(traceDir);
  return stream.ok
    ? result
    : { ok: false, reason: `did not read the complete Git history (${stream.reason})` };
}

/**
 * Judge a Git trace2 event directory written by the processes of one scan:
 * at least one `git log` ran, and every `git log` has an exit record with code
 * 0 and no signal record. Other Git commands (the scanner's remote lookup
 * legitimately exits non-zero without a remote) are not judged. A missing or
 * unreadable trace fails.
 */
export function verifyGitStreamTrace(dir: string): { ok: true } | { ok: false; reason: string } {
  let files: string[];
  try {
    files = readdirSync(dir).map((name) => join(dir, name));
  } catch {
    return { ok: false, reason: "the Git trace is unreadable" };
  }
  const processes = new Map<
    string,
    { name: string | null; argv: string[] | null; exits: number[]; signals: number }
  >();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return { ok: false, reason: "the Git trace is unreadable" };
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // a process killed while writing leaves a torn line; its exit is missing too
      }
      const sid = typeof event["sid"] === "string" ? event["sid"] : null;
      if (!sid) continue;
      const record = processes.get(sid) ?? { name: null, argv: null, exits: [], signals: 0 };
      processes.set(sid, record);
      const kind = event["event"];
      if (kind === "cmd_name" && typeof event["name"] === "string") record.name = event["name"];
      else if (kind === "start" && Array.isArray(event["argv"]))
        record.argv = event["argv"].map(String);
      else if ((kind === "exit" || kind === "atexit") && typeof event["code"] === "number")
        record.exits.push(event["code"]);
      else if (kind === "signal") record.signals += 1;
    }
  }
  const logs = [...processes.values()].filter(
    (record) => (record.name ?? gitSubcommand(record.argv)) === "log",
  );
  if (logs.length === 0) return { ok: false, reason: "no git log process was recorded" };
  for (const log of logs) {
    if (log.signals > 0) return { ok: false, reason: "git log ended by a signal" };
    if (log.exits.length === 0) return { ok: false, reason: "git log has no exit record" };
    const failed = log.exits.find((code) => code !== 0);
    if (failed !== undefined) return { ok: false, reason: `git log exited ${failed}` };
  }
  return { ok: true };
}

/** The Git subcommand in a recorded argv (`git [-C dir] [-c k=v] <command> …`). */
function gitSubcommand(argv: string[] | null): string | null {
  if (!argv) return null;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "-C" || arg === "-c") {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) return arg;
  }
  return null;
}

/** One scanner run writing `report` (a name in the work directory). */
async function runReport(
  ctx: ScanContext,
  target: string[],
  name: string,
  env = ctx.env,
): Promise<Report> {
  const report = join(ctx.work, name);
  const args = [...target, ...ctx.common(report)];
  const result = await run(ctx.scanner, args, ctx.work, env, ctx.timeoutMs);
  if (result.timedOut) return { ok: false, reason: "timed out" };
  if (result.code !== 0)
    return {
      ok: false,
      reason: `exited ${result.code ?? "by signal"} (the report is not trusted)`,
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(report, "utf8"));
  } catch {
    return { ok: false, reason: "wrote no readable JSON report" };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: "report is not a finding list" };
  if (!parsed.every((item) => item && typeof item === "object" && typeof item.RuleID === "string"))
    return { ok: false, reason: "report holds a malformed finding" };
  return { ok: true, findings: parsed as Record<string, unknown>[] };
}

function publicFinding(raw: Record<string, unknown>, label: string | null): PublicationFinding {
  const file = typeof raw["File"] === "string" ? raw["File"] : "";
  return {
    ruleId: String(raw["RuleID"]),
    location: label ?? (file || "(unknown file)"),
    line: typeof raw["StartLine"] === "number" ? raw["StartLine"] : null,
    commit: typeof raw["Commit"] === "string" && raw["Commit"] ? raw["Commit"] : null,
  };
}

/** `stdoutPath` receives the complete stdout instead of the bounded copy. */
function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  stdoutPath?: string,
): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let timedOut = false;
    let child;
    let fd: number | undefined;
    try {
      if (stdoutPath !== undefined) fd = openSync(stdoutPath, "w", 0o600);
      child = spawn(command, args, { cwd, env, stdio: ["ignore", fd ?? "pipe", "ignore"] });
    } catch {
      resolve({ code: null, stdout: "", timedOut: false });
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 65_536) stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, timedOut });
    });
  });
}
