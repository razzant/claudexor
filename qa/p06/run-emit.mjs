#!/usr/bin/env node
/**
 * Portable runner for the synthetic P06 fixture emitters (307 recovered final
 * messages, 697 typed refusals) against a claudexor checkout. Used both by
 * the QA workflow lanes (via run-qa.mjs) and directly by a consumer on their
 * own Linux machine at the published QA-branch SHA. The kit is portable: run
 * it BY ABSOLUTE PATH from any claudexor checkout root (the QA checkout, a
 * base worktree, the product worktree), e.g.
 *
 *   node /abs/path/to/qa/p06/run-emit.mjs --help
 *   node /abs/path/to/qa/p06/run-emit.mjs --out <fresh-dir> [--run-dir <fresh-dir>] [--control base|candidate] [307] [697]
 *
 * Loopback HTTP only: the emitters bind 127.0.0.1 and the Codex adapter's
 * fetch is injected, so no external, network or model calls happen. The
 * output directory is explicit and portable; its layout is whatever the
 * emitters actually write under it:
 *   <out>/307/{complete,partial,gap}/...   (or 307/same-finals with --control)
 *   <out>/697/<case>/...                   (or 697/same-http-503 with --control)
 *
 * Both --out and --run-dir must be FRESH (nonexistent or empty): existing
 * files are never overwritten or merged into. The two directories must be
 * separate and neither may contain the other.
 *
 * Exact prerequisites, in build order, from the claudexor repository root:
 *   1. Node.js from .node-version (24.22.3) and pnpm from `packageManager`
 *      (pnpm@10.34.5), e.g. via corepack.
 *   2. pnpm install --frozen-lockfile
 *   3. pnpm exec turbo run build --filter=@claudexor/schema --concurrency=2
 *   4. pnpm exec turbo run build --concurrency=2 --filter=@claudexor/control-api \
 *        --filter=@claudexor/daemon --filter=@claudexor/harness-codex --filter=@claudexor/orchestrator
 *   5. node /absolute/path/to/qa/p06/run-emit.mjs --out <fresh-dir> [307] [697]
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHECKPOINTS } from "./fixture.config.mjs";

export const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const KIT_FILES = ["emit307.test.mjs", "emit697.test.mjs", "fixture.config.mjs"];

const HELP = `usage: node /abs/path/to/qa/p06/run-emit.mjs --out <fresh-dir> [--run-dir <fresh-dir>] [--control base|candidate] [307] [697]

Synthetic P06 fixture emitters (307 recovered final messages, 697 typed
refusals). Run by absolute path from any claudexor checkout root. Loopback
HTTP only: emitters bind 127.0.0.1 and inject the Codex adapter fetch, so no
external, network or model calls happen.

Both --out and --run-dir must be fresh (nonexistent or empty); existing files
are never overwritten. They must be separate and neither may contain the other.

Exact prerequisites, in build order, from the claudexor repository root:
  1. Node.js from .node-version (24.22.3) and pnpm from packageManager (pnpm@10.34.5), e.g. corepack.
  2. pnpm install --frozen-lockfile
  3. pnpm exec turbo run build --filter=@claudexor/schema --concurrency=2
  4. pnpm exec turbo run build --concurrency=2 --filter=@claudexor/control-api --filter=@claudexor/daemon --filter=@claudexor/harness-codex --filter=@claudexor/orchestrator
  5. node /absolute/path/to/qa/p06/run-emit.mjs --out <fresh-dir> [307] [697]

The kit stays in the QA checkout. For --control base run its absolute path
with cwd at productBase from identity/source.json. For candidate cases, use a
new checkout at productHead, apply export/selected.patch if nonempty with
"git apply --index", and compare "git write-tree" with generatedTree in
export/change.json before building or running the kit. Tag v6.2.0 is required
for the released decoder. --control changes expectations, never the checkout.`;

/** A run dir next to the checkout: `src` and `node_modules` links + kit files.
 *  The dir must be fresh (nonexistent or empty); nothing is ever overwritten. */
export function prepareRunDir(root, dir) {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(
      `run dir ${dir} is not empty; pass a fresh --run-dir (existing files are never overwritten)`,
    );
  }
  mkdirSync(dir, { recursive: true });
  for (const [link, target] of [["src", root], ["node_modules", join(root, "node_modules")]]) {
    const p = join(dir, link);
    if (existsSync(p) || lstatSync(p, { throwIfNoEntry: false }) !== undefined) {
      throw new Error(`run dir ${dir} already contains '${link}'; pass a fresh --run-dir`);
    }
    symlinkSync(target, p, "dir");
  }
  for (const f of KIT_FILES) copyFileSync(join(KIT_DIR, f), join(dir, f), constants.COPYFILE_EXCL);
  return dir;
}

/** Run the emitters for the given issues into outDir. Throws on test failure. */
export function runEmitTests({ root, runDir, outDir, control, issues, logPath, reportPath }) {
  mkdirSync(outDir, { recursive: true });
  const cfg = mkdtempSync(join(tmpdir(), "qa-p06-cfg-"));
  const checkpoints = join(runDir, "checkpoints");
  mkdirSync(checkpoints, { mode: 0o700 });
  const env = {
    ...process.env,
    P06_CONTROL: control ?? "",
    P06_OUT: resolve(outDir),
    P06_CHECKPOINT_DIR: checkpoints,
    CLAUDEXOR_CONFIG_DIR: cfg,
  };
  const files = issues.map((i) => `emit${i}.test.mjs`);
  const argv = [
    join(root, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--config", join(runDir, "fixture.config.mjs"),
    ...(reportPath ? ["--reporter=json", `--outputFile=${reportPath}`] : []),
    ...files,
  ];
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    const fd = openSync(logPath, "a");
    try {
      execFileSync("node", argv, { cwd: root, env, stdio: ["ignore", fd, fd], maxBuffer: 1 << 28 });
    } finally {
      closeSync(fd);
    }
  } else {
    execFileSync("node", argv, { cwd: root, env, stdio: "inherit", maxBuffer: 1 << 28 });
  }
  return resolve(outDir);
}

export const SCENARIOS = {
  307: ["complete", "partial", "gap"],
  697: ["failed", "failed-no-capture", "http-refusal", "legacy-failure", "ordinary-error", "mixed", "refusal-only", "legacy-mixed", "ordinary-text"],
};
const CONTROLS = { 307: ["same-finals"], 697: ["same-http-503"] };
export function caseFiles(issue, scenario, control) {
  if (issue === "697") return ["detail.json", "result.json", "transport.json", ...(scenario === "failed" ? ["operations.json"] : [])];
  if (control) return ["detail.json", "default-detail.json", "operations.json", "observation.json", "primary.md",
    ...(control === "base" ? ["artifact-error.json"] : ["pointer.json", "final-messages.jsonl"])];
  return ["detail.json", "pointer.json", ...(scenario === "gap" ? [] : ["final-messages.jsonl"]),
    ...(scenario === "complete" ? ["default-detail.json", "operations.json"] : [])];
}

// Never forward a parser or filesystem exception from a private report.
export function readJsonReport(path, maxBytes) {
  let text;
  try {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) return { state: "missing" };
    if (!info.isFile()) return { state: "not_regular" };
    if (info.size > maxBytes) return { state: "too_large" };
    text = readFileSync(path, "utf8");
  } catch {
    return { state: "unreadable" };
  }
  try {
    return { state: "ok", value: JSON.parse(text) };
  } catch {
    return { state: "invalid_json" };
  }
}

function lastCheckpoint(dir, issue, name) {
  const path = join(dir, "checkpoints", `${issue}-${name}.check`);
  try {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info?.isFile() || info.size > 64) return null;
    const id = readFileSync(path, "utf8");
    return CHECKPOINTS[issue].find((allowed) => id === allowed) ?? null;
  } catch {
    return null;
  }
}

// Match only the case table and Vitest's structured assertion status. A
// checkpoint is an observation, never permission to export a failed case.
export function selectPassedCases(report, raw, out, control, issues) {
  const parsed = readJsonReport(report, 16 << 20);
  const results = Array.isArray(parsed.value?.testResults) ? parsed.value.testResults : null;
  const reportState = parsed.state === "ok" && !results ? "invalid_shape" : parsed.state;
  const cases = [];
  for (const [issue, names] of Object.entries(control ? CONTROLS : SCENARIOS)) {
    if (!issues.includes(issue)) continue;
    const suites = results?.filter((r) => typeof r?.name === "string" && r.name.replaceAll("\\", "/").endsWith(`/emit${issue}.test.mjs`)) ?? [];
    const suite = suites.length === 1 ? suites[0] : null;
    for (const name of names) {
      const title = (issue === "307" ? "emits terminal HTTP bytes / " : "emits model HTTP bytes / ") + name;
      const assertions = Array.isArray(suite?.assertionResults) ? suite.assertionResults.filter((a) => a?.title === title) : [];
      const status = assertions.length === 1 ? assertions[0].status : null;
      const files = caseFiles(issue, name, control);
      const source = join(raw, issue, name);
      const target = join(out, issue, name);
      let reason;
      if (!results) reason = "no_usable_report";
      else if (suites.length !== 1) reason = "suite_missing_or_ambiguous";
      else if (status === "failed") reason = "assertion_failed";
      else if (status !== "passed") reason = suite.status === "failed" && !assertions.length ? "suite_failed" : "assertion_not_verified";
      else {
        try {
          if (!files.every((f) => lstatSync(join(source, f), { throwIfNoEntry: false })?.isFile())) {
            reason = "fixture_file_missing_or_not_regular";
          } else {
            mkdirSync(target, { recursive: true });
            for (const f of files) copyFileSync(join(source, f), join(target, f), constants.COPYFILE_EXCL);
            reason = "passed";
          }
        } catch {
          reason = "fixture_export_failed";
        }
      }
      cases.push({
        issue, case: name, reason,
        outcome: reason === "passed" ? "passed" : reason === "assertion_failed" ? "failed" : "unverified",
        checkpoint: lastCheckpoint(dirname(report), issue, name),
      });
    }
  }
  return { report: reportState, cases };
}

function summarize(outDir) {
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) files.push(`${relative(outDir, p)} (${statSync(p).size} B)`);
    }
  };
  walk(outDir);
  console.log(`emit output (${files.length} files) under ${outDir}:`);
  for (const f of files.sort()) console.log("  " + f);
}

/** Fresh-or-empty check: existing evidence is never overwritten. */
function assertFreshDir(label, dir) {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    console.error(
      `${label} ${dir} is not empty; pass a fresh, empty directory (existing files are never overwritten)\n\n${HELP}`,
    );
    process.exit(2);
  }
}

// Resolve symlinks in the closest existing ancestor even for a fresh path.
// This is a read-only preflight: neither caller directory has been created.
function canonicalFutureDir(value) {
  const abs = resolve(value);
  if (lstatSync(abs, { throwIfNoEntry: false })) {
    const real = realpathSync.native(abs);
    if (!statSync(real).isDirectory()) throw new Error("expected a directory");
    return real;
  }
  const parent = dirname(abs);
  if (parent === abs) throw new Error("cannot resolve directory");
  return join(canonicalFutureDir(parent), basename(abs));
}

export function separateDirectories(out, run) {
  const dirs = { out: canonicalFutureDir(out), run: canonicalFutureDir(run) };
  // Be conservative about case/normalization aliases on macOS, including
  // leaf names that do not yet exist and therefore cannot be compared by inode.
  const comparison = (p) => process.platform === "darwin" ? p.normalize("NFC").toLowerCase() : p;
  const contains = (parent, child) => {
    const rel = relative(comparison(parent), comparison(child));
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  };
  if (contains(dirs.out, dirs.run) || contains(dirs.run, dirs.out)) {
    throw new Error("output and scratch must be separate non-nested directories");
  }
  return dirs;
}

function main() {
  const args = process.argv.slice(2);
  let outDir = null;
  let runDir = null;
  let control = null;
  const issues = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") outDir = args[++i];
    else if (a === "--run-dir") {
      runDir = args[++i];
      if (!runDir || runDir.startsWith("--")) {
        console.error("--run-dir requires a directory");
        process.exit(2);
      }
    } else if (a === "--control") control = args[++i];
    else if (a === "--help" || a === "-h") {
      console.log(HELP);
      return;
    } else if (a === "307" || a === "697") issues.push(a);
    else {
      console.error(`unknown argument: ${a}\n\n${HELP}`);
      process.exit(2);
    }
  }
  if (!outDir) {
    console.error(`--out <fresh output-dir> is required\n\n${HELP}`);
    process.exit(2);
  }
  if (control && control !== "base" && control !== "candidate") {
    console.error(`--control must be base or candidate\n\n${HELP}`);
    process.exit(2);
  }
  const scratch = runDir ?? join(tmpdir(), `qa-p06-run-${randomUUID()}`);
  let dirs;
  try {
    dirs = separateDirectories(outDir, scratch);
    assertFreshDir("--out", dirs.out);
    assertFreshDir("--run-dir", dirs.run);
  } catch {
    console.error("--out and --run-dir must resolve to separate, fresh, non-nested directories");
    process.exit(2);
  }
  const root = process.cwd();
  const pkgPath = join(root, "package.json");
  if (readJsonReport(pkgPath, 1 << 20).value?.name !== "claudexor-monorepo") {
    console.error("run from the claudexor repository root (package.json name claudexor-monorepo)");
    process.exit(2);
  }
  if (!existsSync(join(root, "node_modules", "vitest", "vitest.mjs"))) {
    console.error("node_modules missing; run `pnpm install --frozen-lockfile` first (see --help for the full build order)");
    process.exit(2);
  }
  const use = issues.length ? issues : ["307", "697"];
  if (runDir === null) mkdirSync(dirs.run, { mode: 0o700 });
  const dir = prepareRunDir(root, dirs.run);
  const raw = join(dir, "unchecked");
  const report = join(dir, "vitest.json");
  let exit = 0;
  try {
    runEmitTests({ root, runDir: dir, outDir: raw, control, issues: use, reportPath: report, logPath: join(dir, "vitest.log") });
  } catch (error) { exit = error.status || 1; }
  mkdirSync(dirs.out, { recursive: true });
  const { cases } = selectPassedCases(report, raw, dirs.out, control, use);
  summarize(dirs.out);
  if (exit || cases.some((c) => c.outcome !== "passed")) {
    console.error("Some cases were not verified; see the local scratch report at", dir);
    process.exitCode = exit || 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
