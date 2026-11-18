#!/usr/bin/env node
/**
 * TEST-ONLY branch QA runner for the P06 run-results / typed-refusal
 * qualification. It is committed only on the throwaway QA branch
 * (qa/p06-run-results), never on the public product branch or PR.
 *
 * Lanes (each is one step of .github/workflows/qa-p06-run-results.yml):
 *   identity         record the exact tested tree, product base/head and origin;
 *                    rejects the un-injected PRODUCT_HEAD_SHA placeholder and
 *                    verifies the tip differs from the product head by exactly
 *                    the six carrier files (repeated FF carrier revisions OK)
 *   export           generate (schema:gen, gen-endpoints-doc, prettier) in a
 *                    separate PRODUCT worktree at the bound product SHA, export
 *                    the allowlisted generated+format patch (deletions included),
 *                    then materialize the exact generated tree as a test-only
 *                    commit + worktree used by every later lane
 *   emit             run the synthetic emit307/emit697 fixture emitters on that
 *                    generated worktree and export the real HTTP bytes
 *                    (loopback only, no live calls)
 *   verify-fixtures  completeness check of the exported fixture bytes
 *   control          paired baseline control: the same emitters with
 *                    P06_CONTROL=base on a base worktree and
 *                    P06_CONTROL=candidate on the generated worktree
 *   release          pnpm release:verify:node, unmodified, in the generated
 *                    worktree (its HEAD tree IS the generated tree)
 *   manifest         write the one immutable final-manifest.json over QA_OUT,
 *                    with per-lane ran/failed/not_run status (if: always())
 *   scan             scan the entire final QA_OUT with the original scanner
 *                    flags; diagnostics and all scanner output stay separate
 *
 * Evidence policy: QA_OUT receives only selected evidence (identity JSON, the
 * reviewed generated patch, synthetic fixtures, control hashes, release
 * outcome, steps.json, per-lane receipts, final manifest). Raw install/build/
 * test logs and all scratch live under QA_RUN and never enter the uploaded
 * tree. steps.json is rewritten by later lanes, so per-lane receipts do not
 * hash it; the final manifest covers its final bytes.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { caseFiles, prepareRunDir, readJsonReport, runEmitTests, SCENARIOS, selectPassedCases, separateDirectories } from "./run-emit.mjs";

const ROOT = process.env.GITHUB_WORKSPACE ?? process.cwd();
const { QA_OUT: OUT, QA_RUN: RUN, QA_STORE: STORE } = process.env;

const GENERATED_DIR = "packages/schema/generated";
const SCHEMA_RE = /^packages\/schema\/generated\/[A-Za-z0-9_-]+\.schema\.json$/;
const ENDPOINTS_JSON = "docs/reference/endpoints.json";
const ARCH_DOC = "docs/ARCHITECTURE.md";
const EMIT_PACKAGES = [
  "@claudexor/control-api",
  "@claudexor/daemon",
  "@claudexor/harness-codex",
  "@claudexor/orchestrator",
];
/** The only files the QA branch may add on top of the bound product head. */
const CARRIER_FILES = [
  ".github/workflows/qa-p06-run-results.yml",
  "qa/p06/emit307.test.mjs",
  "qa/p06/emit697.test.mjs",
  "qa/p06/fixture.config.mjs",
  "qa/p06/run-emit.mjs",
  "qa/p06/run-qa.mjs",
].sort();
/** Single publication-time placeholder for the product head in the workflow. */
const PRODUCT_HEAD_PLACEHOLDER = "__P06_PRODUCT_HEAD_SHA__";
/** Registry entries (packages/schema/scripts/gen-jsonschema.ts) that must be
 *  present after schema:gen; asserted in the export lane. */
const EXPECTED_GENERATED_SCHEMAS = ["FinalMessagesHeader", "FinalMessagesOutcome", "McpRunResultRead"]
  .map((n) => `${GENERATED_DIR}/${n}.schema.json`)
  .sort();
const LANE_ORDER = ["identity", "export", "install", "fixture-build", "emit", "verify-fixtures", "control-base", "control-candidate", "release"];

let STEPS = [];

function git(args, opts = {}) {
  return execFileSync("git", ["-C", ROOT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trimEnd();
}

function gitOk(args) {
  try {
    execFileSync("git", ["-C", ROOT, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeSteps() {
  writeJson(join(OUT, "steps.json"), STEPS);
}

/** Time a function-valued lane sub-step; records and rethrows on failure. */
function stepFn(name, fn) {
  const t0 = Date.now();
  try {
    fn();
  } catch (error) {
    console.error(`[p06] stage=${name} exit=1`);
    STEPS.push({ step: name, exit: 1, seconds: +((Date.now() - t0) / 1000).toFixed(2) });
    writeSteps();
    throw error;
  }
  console.log(`[p06] stage=${name} exit=0`);
  STEPS.push({ step: name, exit: 0, seconds: +((Date.now() - t0) / 1000).toFixed(2) });
  writeSteps();
}

function processObservation(status, signal) {
  return {
    exit: Number.isInteger(status) ? status : null,
    process: Number.isInteger(status) ? "exited" : signal ? "signaled" : "no_exit_observed",
  };
}

class CommandFailure extends Error {
  constructor(stage, observation) {
    super(`${stage} command did not succeed`);
    this.observation = observation;
  }
}

// The composite release command cannot be broken up or replaced. pnpm's
// monorepo script headers tell us which named checkpoint was seen, not which
// child failed (several shell checks have no header of their own).
const RELEASE_SCRIPTS = [
  "release:verify:node", "build", "typecheck", "typecheck:tests", "test", "schema:gen",
  "docs:check", "staged:check", "retired:check", "inv:check", "sensitive:check", "knip",
  "fixtures:swift:check", "fixtures:runtime-update:check", "release:workflow:check", "format:check", "canary",
];

function commandDiagnostics(name, cwd, logPath, observation) {
  try {
    if (lstatSync(logPath).size > (16 << 20)) {
      console.error(`[p06] stage=${name} diagnostics=log_limit`);
      return;
    }
    const text = readFileSync(logPath, "utf8");
    // Only literal paths from the already public QA-tip tree can be emitted,
    // never arbitrary paths (or file contents) from the failure transcript.
    const tracked = new Set(git(["ls-tree", "-r", "--name-only", "-z", "HEAD"]).split("\0"));
    const locations = new Set();
    const publicPaths = new Set();
    for (const m of text.matchAll(/(?<![\w.@/-])([\w.@/-]{1,512}\.(?:[mc]?[jt]sx?|md|json))(?:\((\d{1,7}),\d{1,7}\): error TS\d{3,6}\b|:(\d{1,7}):\d{1,7}\b|\b)/g)) {
      const path = m[1].startsWith(`${cwd}/`) ? m[1].slice(cwd.length + 1) : m[1];
      if (path.length > 180 || !/^[A-Za-z0-9_./@-]+$/.test(path) || !tracked.has(path)) continue;
      const line = m[2] ?? m[3];
      locations.add(line ? `${path}:${Number(line)}` : path);
      publicPaths.add(path);
    }
    let lastObservedScript = null;
    if (name === "release-verify") {
      for (const m of text.matchAll(/^> claudexor-monorepo@[\w.+-]+ ([a-z][a-z0-9:-]*)(?: [^\r\n]*)?\r?$/gm)) {
        const known = RELEASE_SCRIPTS.find((script) => script === m[1]);
        if (known) lastObservedScript = known;
      }
      console.error(`[p06] stage=${name} last_observed_script=${lastObservedScript ?? "none"}`);
      for (const path of [...publicPaths].slice(-8)) console.error(`[p06] stage=${name} public_source=${path}`);
    }
    writeJson(join(OUT, `${name}.locations.json`), { step: name, ...observation, lastObservedScript, sourceLocations: [...locations].slice(-80), total: locations.size });
  } catch {
    console.error(`[p06] stage=${name} diagnostics=unavailable`);
  }
}

/** One bounded lane sub-step: argv, exit code and seconds land in steps.json.
 *  Raw logs go to runner scratch (QA_RUN/logs), never into the uploaded QA_OUT. */
function step(name, argv, { cwd = ROOT, env = {}, log } = {}) {
  const t0 = Date.now();
  const logPath = log ?? join(RUN, "logs", `${name}.log`);
  console.log(`[p06] stage=${name} phase=prepare`);
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  let observation = processObservation(0);
  try {
    execFileSync(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", fd, fd],
      maxBuffer: 1 << 28,
    });
  } catch (error) {
    observation = processObservation(error.status, error.signal);
  } finally {
    closeSync(fd);
  }
  console.log(`[p06] stage=${name} exit=${observation.exit ?? "unknown"} process=${observation.process}`);
  STEPS.push({
    step: name,
    argv: argv.map((a) => a.replaceAll(OUT, "$QA_OUT").replaceAll(ROOT, "$GITHUB_WORKSPACE").replaceAll(RUN, "$QA_RUN")),
    ...observation,
    seconds: +((Date.now() - t0) / 1000).toFixed(2),
  });
  if (observation.exit !== 0) {
    commandDiagnostics(name, cwd, logPath, observation);
    writeSteps();
    throw new CommandFailure(name, observation);
  }
  writeSteps();
}

/** Per-lane receipt over the selected evidence. steps.json is excluded: later
 *  lanes rewrite it, and final-manifest.json hashes its final bytes. */
function receipt(lane, ok) {
  const files = {};
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (relative(OUT, p) === "steps.json") continue;
      if (ent.isSymbolicLink()) {
        files[relative(OUT, p)] = { symlink: readlinkSync(p) };
      } else if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile()) {
        files[relative(OUT, p)] = { size: lstatSync(p).size, sha256: sha256File(p) };
      }
    }
  };
  if (existsSync(OUT)) walk(OUT);
  writeJson(join(OUT, `receipt-${lane}.json`), { lane, ok, files });
}

/** Bound product/base ids. The product head never defaults to HEAD~1: with
 *  repeated carrier commits HEAD~1 can be a previous carrier revision. */
function ids() {
  const head = git(["rev-parse", "HEAD"]);
  const rawHead = process.env.PRODUCT_HEAD_SHA?.trim() ?? "";
  if (!rawHead || rawHead === PRODUCT_HEAD_PLACEHOLDER) {
    throw new Error(
      `PRODUCT_HEAD_SHA must be the exact product commit SHA. Before pushing the QA branch, replace the ` +
        `${PRODUCT_HEAD_PLACEHOLDER} placeholder in .github/workflows/qa-p06-run-results.yml with the known ` +
        `product head (publication-time injection); the placeholder itself never runs.`,
    );
  }
  const productHead = git(["rev-parse", "--verify", `${rawHead}^{commit}`]);
  const envBase = process.env.PRODUCT_BASE_SHA?.trim();
  const base = envBase
    ? git(["rev-parse", "--verify", `${envBase}^{commit}`])
    : git(["merge-base", "origin/main", productHead]);
  return { head, productHead, base, productTree: git(["rev-parse", `${productHead}^{tree}`]) };
}

function assertValidPath(name) {
  if (
    !/^[A-Za-z0-9_@.+/-]+$/.test(name) ||
    name.startsWith("/") ||
    name.startsWith("-") ||
    name.split("/").some((p) => p === "" || p === ".." || p === "." || p === ".git") ||
    resolve(ROOT, name) !== join(ROOT, name)
  ) {
    throw new Error(`invalid literal export path: ${name}`);
  }
}

function hashGeneratedDir(root) {
  const listed = [
    ...git(["-C", root, "ls-files", "-z", GENERATED_DIR]).split("\0"),
    ...git(["-C", root, "ls-files", "--others", "--exclude-standard", "-z", GENERATED_DIR]).split("\0"),
  ].filter(Boolean);
  const map = {};
  for (const name of [...new Set(listed)].sort()) {
    const f = join(root, name);
    if (existsSync(f) && statSync(f).isFile()) map[name] = sha256File(f);
  }
  return map;
}

function readChange() {
  const changePath = join(OUT, "export", "change.json");
  if (!existsSync(changePath)) throw new Error("export lane output missing; run export first");
  return JSON.parse(readFileSync(changePath, "utf8"));
}

function buildFixturePackages(cwd, prefix) {
  step(`${prefix}-packages`, ["pnpm", "exec", "turbo", "run", "build", "--concurrency=2", ...EMIT_PACKAGES.map((p) => `--filter=${p}`)], { cwd });
}

function ensureCommit(sha) {
  if (!gitOk(["rev-parse", "--verify", `${sha}^{commit}`])) {
    step("fetch-base", ["git", "fetch", "--no-tags", "origin", sha]);
  }
  return git(["rev-parse", "--verify", `${sha}^{commit}`]);
}

async function laneIdentity() {
  const { head, productHead, base, productTree } = ids();
  if (!gitOk(["merge-base", "--is-ancestor", base, productHead])) {
    throw new Error("product base is not an ancestor of the bound product head");
  }
  if (!gitOk(["merge-base", "--is-ancestor", productHead, "HEAD"])) {
    throw new Error("product head is not an ancestor of the QA branch tip");
  }
  const carrierDiff = git(["diff", "--name-only", "-z", productHead, "HEAD"]).split("\0").filter(Boolean).sort();
  if (JSON.stringify(carrierDiff) !== JSON.stringify([...CARRIER_FILES].sort())) {
    throw new Error(
      "QA branch tip differs from the bound product head by files other than the six carrier files: " +
        carrierDiff.join(", "),
    );
  }
  const describe = (ref) => {
    try {
      return git(["describe", "--tags", "--abbrev=0", "--match", "v*", ref]);
    } catch {
      return null;
    }
  };
  writeJson(join(OUT, "identity", "source.json"), {
    lane: "identity",
    qaBranchTip: head,
    qaBranchTipTree: git(["rev-parse", "HEAD^{tree}"]),
    productHead,
    productTree,
    productBase: base,
    productBaseTree: git(["rev-parse", `${base}^{tree}`]),
    productCommits: git(["log", "--format=%H %s", `${base}..${productHead}`]).split("\n").filter(Boolean),
    carrierFiles: carrierDiff,
    origin: git(["remote", "get-url", "origin"]),
    nearestReleaseTag: { product: describe(productHead), base: describe(base) },
    toolchain: {
      node: execFileSync("node", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
      pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
    },
  });
}

async function laneExport() {
  const out = join(OUT, "export");
  mkdirSync(out, { recursive: true });
  const { head, productHead, base, productTree } = ids();

  ensureCommit(productHead);
  ensureCommit(base);

  // Generation happens in a separate worktree at the bound product SHA, so the
  // test-only carrier files in the QA checkout never influence it.
  const productWt = join(RUN, "product-wt");
  step("worktree-add-product", ["git", "worktree", "add", "--detach", productWt, productHead]);
  step("install-product", ["pnpm", "install", "--frozen-lockfile", "--store-dir", STORE], { cwd: productWt });

  const gwt = (args, opts = {}) =>
    execFileSync("git", ["-C", productWt, "--literal-pathspecs", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    }).trimEnd();

  // Product-changed files between the base and the product head.
  const changed = gwt(["diff", "--name-only", "--diff-filter=ACMR", "-z", base, productHead])
    .split("\0")
    .filter(Boolean);

  // Preserve raw generated-schema SHAs before/after regeneration.
  const before = hashGeneratedDir(productWt);
  step("export-build-schema", ["pnpm", "exec", "turbo", "run", "build", "--filter=@claudexor/schema", "--concurrency=2"], { cwd: productWt });
  step("export-schema-gen", ["pnpm", "schema:gen"], { cwd: productWt });
  step("export-build-control-api", ["pnpm", "exec", "turbo", "run", "build", "--filter=@claudexor/control-api", "--concurrency=2"], { cwd: productWt });
  step("export-gen-endpoints-doc", ["node", "scripts/gen-endpoints-doc.mjs"], { cwd: productWt });
  const after = hashGeneratedDir(productWt);
  for (const expected of EXPECTED_GENERATED_SCHEMAS) {
    if (!(expected in after)) throw new Error(`expected generated schema missing after schema:gen: ${expected}`);
  }
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  const rehashed = Object.keys(after).filter((k) => k in before && after[k] !== before[k]);
  writeJson(join(out, "generated-shas.json"), {
    before,
    after,
    added,
    removed,
    changed: rehashed,
    expectedPresent: EXPECTED_GENERATED_SCHEMAS,
  });

  // Everything the generators touched in the tracked generated/doc outputs.
  // Deletions (git status D) are KEPT: the generator removes stale schemas and
  // the exported patch must carry those removals.
  const genChanged = gwt([
    "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--",
    GENERATED_DIR, ENDPOINTS_JSON, ARCH_DOC,
  ])
    .split("\0")
    .filter(Boolean)
    .map((e) => e.slice(3));

  let paths = [...new Set([...changed, ...genChanged])].sort();
  // The endpoint inventory outputs always export together.
  if (paths.includes(ENDPOINTS_JSON) || paths.includes(ARCH_DOC)) {
    paths = [...new Set([...paths, ENDPOINTS_JSON, ARCH_DOC])].sort();
  }
  for (const name of paths) assertValidPath(name);

  const generated = paths.filter((p) => SCHEMA_RE.test(p));
  const endpointsPair = paths.filter((p) => p === ENDPOINTS_JSON || p === ARCH_DOC);
  const formatted = paths.filter((p) => !SCHEMA_RE.test(p) && p !== ENDPOINTS_JSON && p !== ARCH_DOC);
  if (formatted.length) {
    step("export-prettier", ["pnpm", "exec", "prettier", "--write", "--ignore-unknown", "--", ...formatted], { cwd: productWt });
  }
  for (const name of generated) {
    const f = join(productWt, name);
    if (existsSync(f) && statSync(f).isFile()) JSON.parse(readFileSync(f, "utf8"));
  }

  // Allowlisted patch: scratch index starts from the product tree, only the
  // selected paths enter it (add -A also records working-tree deletions), and
  // the resulting diff is bounded by them.
  mkdirSync(RUN, { recursive: true });
  const idx = join(RUN, "selected.index");
  const idxEnv = { ...process.env, GIT_INDEX_FILE: idx };
  const g = (args) =>
    execFileSync("git", ["-C", productWt, "--literal-pathspecs", ...args], {
      encoding: "utf8",
      env: idxEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  g(["read-tree", productTree]);
  g(["add", "-A", "--", ...paths]);
  const generatedTree = g(["write-tree"]);
  const changedAfter = g(["diff", "--cached", "--no-renames", "--name-only", "-z", productTree])
    .split("\0")
    .filter(Boolean);
  if (!changedAfter.every((p) => paths.includes(p))) {
    throw new Error("patch would include an unselected file");
  }
  const patchPath = join(out, "selected.patch");
  const fd = openSync(patchPath, "w");
  try {
    execFileSync(
      "git",
      ["-C", productWt, "--literal-pathspecs", "diff", "--cached", "--binary", "--full-index",
        "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/",
        productTree, "--", ...paths],
      { env: idxEnv, stdio: ["ignore", fd, "pipe"] },
    );
  } finally {
    closeSync(fd);
  }

  // Materialize the exact generated tree as a test-only commit and a worktree;
  // emit, candidate control and release:verify:node all run on THIS tree, so
  // fixtures and the full battery can never check different versions.
  const generatedCommit = execFileSync(
    "git",
    ["-C", ROOT, "-c", "user.name=qa-p06", "-c", "user.email=qa-p06@invalid",
      "commit-tree", generatedTree, "-p", productHead,
      "-m", "qa-p06: exact generated tree (test-only, never published)"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  const genWt = join(RUN, "gen-wt");
  step("worktree-add-generated", ["git", "worktree", "add", "--detach", genWt, generatedCommit]);
  writeJson(join(out, "change.json"), {
    lane: "export",
    head,
    base,
    productHead,
    productTree,
    generatedTree,
    generatedCommit,
    genWt,
    paths,
    changed: changedAfter,
    generated,
    endpointsPair,
    formatted,
  });
}

// Vitest's full JSON and all unchecked response bytes stay in private scratch.
// Even when one case fails we can export the allowlisted files of a passed sibling.
function runCases(tree, lane, control = null) {
  console.log(`[p06] stage=${lane} phase=prepare_emitters`);
  const dir = prepareRunDir(tree, join(RUN, `${lane}-run`));
  const raw = join(RUN, `${lane}-raw`);
  const report = join(dir, "vitest.json");
  const out = control ? join(OUT, "control", control) : join(OUT, "emit", "fixtures");
  let observation = processObservation(0);
  try {
    runEmitTests({ root: tree, runDir: dir, outDir: raw, control, issues: ["307", "697"], logPath: join(RUN, "logs", `${lane}.log`), reportPath: report });
  } catch (error) {
    observation = processObservation(error.status, error.signal);
  }
  console.log(`[p06] stage=${lane} phase=collect_fixtures exit=${observation.exit ?? "unknown"} process=${observation.process}`);
  const selected = selectPassedCases(report, raw, out, control, ["307", "697"]);
  console.log(`[p06] stage=${lane} report=${selected.report}`);
  for (const c of selected.cases) {
    console.log(`[p06] stage=${lane} case=${c.issue}/${c.case} outcome=${c.outcome} reason=${c.reason} last_checkpoint=${c.checkpoint ?? "none"}`);
  }
  writeJson(join(OUT, `${lane}-cases.json`), { ...observation, ...selected });
  if (observation.exit !== 0 || selected.cases.some((c) => c.outcome !== "passed")) throw new Error(`${lane}: one or more cases failed or were not verified`);
}

async function laneEmit() {
  const { genWt } = readChange();
  stepFn("emit", () => runCases(genWt, "emit"));
}
async function laneVerifyFixtures() {
  const root = join(OUT, "emit", "fixtures");
  const files = {};
  for (const [issue, scenarios] of Object.entries(SCENARIOS)) {
    for (const name of scenarios) {
      for (const file of caseFiles(issue, name, null)) {
        const path = join(root, issue, name, file);
        const id = `${issue}/${name}/${file}`;
        try {
          const info = lstatSync(path);
          if (!info.isFile()) throw new Error("fixture is not a regular file");
          files[id] = { size: info.size, sha256: sha256File(path) };
        } catch (error) {
          console.error(`[p06] stage=verify-fixtures check=${id} outcome=missing_or_unreadable`);
          throw error;
        }
      }
    }
  }
  writeJson(join(OUT, "emit", "fixtures-manifest.json"), { ok: true, files });
}
async function laneControlBase() {
  const { base } = ids();
  ensureCommit(base);
  const baseWt = join(RUN, "base-wt");
  step("worktree-add-base", ["git", "worktree", "add", "--detach", baseWt, base]);
  step("install-base", ["pnpm", "install", "--frozen-lockfile", "--store-dir", STORE], { cwd: baseWt });
  buildFixturePackages(baseWt, "control-base-build");
  stepFn("control-base", () => runCases(baseWt, "control-base", "base"));
}
async function laneControlCandidate() {
  stepFn("control-candidate", () => runCases(readChange().genWt, "control-candidate", "candidate"));
}

async function laneRelease() {
  const out = join(OUT, "release");
  mkdirSync(out, { recursive: true });
  const { genWt, productHead, generatedTree, generatedCommit } = readChange();

  // release:verify:node runs `git diff --exit-code packages/schema/generated`
  // against the worktree HEAD — which here IS the post-generation tree, so
  // the gate compares the committed generated files to themselves and never
  // lets changed generated files slip past a pre-generation HEAD.
  let observation = processObservation(0);
  try {
    step("release-verify", ["pnpm", "release:verify:node"], { cwd: genWt });
  } catch (error) {
    if (!(error instanceof CommandFailure)) throw error;
    observation = error.observation;
  }
  writeJson(join(out, "release.json"), {
    lane: "release",
    productHead,
    generatedTree,
    generatedCommit,
    ...observation,
    note: "pnpm release:verify:node unmodified, run in a worktree whose HEAD tree is the exact generated tree",
  });
  if (observation.exit !== 0) throw new CommandFailure("release-verify", observation);
}

async function laneManifest() {
  const manifestPath = join(OUT, "final-manifest.json");
  const files = {};
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (p === manifestPath) continue;
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile()) {
        files[relative(OUT, p)] = { size: lstatSync(p).size, sha256: sha256File(p) };
      } else if (ent.isSymbolicLink()) {
        files[relative(OUT, p)] = { symlink: readlinkSync(p) };
      }
    }
  };
  if (existsSync(OUT)) walk(OUT);
  const lanes = {};
  for (const name of LANE_ORDER) {
    const hasReceipt = existsSync(join(OUT, `receipt-${name}.json`));
    const hasError = existsSync(join(OUT, `${name}.error.txt`));
    if (hasReceipt && !hasError) lanes[name] = { ran: true, outcome: "ok" };
    else if (hasReceipt && hasError) lanes[name] = { ran: true, outcome: "failed" };
    else lanes[name] = { ran: false, outcome: "not_run", note: "lane was skipped or cancelled; no result is claimed for it" };
  }
  writeJson(manifestPath, { lane: "manifest", generatedAt: new Date().toISOString(), lanes, files });
}

function checkScanTree(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = lstatSync(path);
    if (info.isDirectory()) checkScanTree(path);
    else if (!info.isFile()) throw new Error("output includes a non-regular entry");
  }
}

function scanReportState(reportPath) {
  const report = readJsonReport(reportPath, 16 << 20);
  if (report.state !== "ok") return report.state;
  if (!Array.isArray(report.value)) return "invalid_shape";
  if (!report.value.length) return "empty";
  // Only classify a structured findings list; report fields never leave scratch.
  return report.value.every((entry) => typeof entry?.RuleID === "string" && entry.RuleID.length)
    ? "findings_reported" : "invalid_finding_shape";
}

/** Same pinned binary, flags and complete target as v5. The fresh scanner
 * report and both process streams live outside OUT. This final step is a
 * read-only consumer of OUT; no later step changes the upload tree. */
function laneScan() {
  const scanner = process.env.CLAUDEXOR_BETTERLEAKS_PATH;
  let stage = "scan-paths";
  let child, reportPath;
  try {
    separateDirectories(OUT, RUN);
    if (!lstatSync(OUT).isDirectory() || !lstatSync(RUN).isDirectory()) throw new Error("missing ordinary output or scratch root");
    stage = "scan-inventory";
    checkScanTree(OUT);
    stage = "scan-binary";
    if (!scanner || !statSync(scanner).isFile()) throw new Error("pinned scanner unavailable");
    accessSync(scanner, constants.X_OK);
    stage = "scan-scratch";
    const scratch = mkdtempSync(join(RUN, "scan-"));
    const config = join(scratch, "scan.toml");
    const ignore = join(scratch, "empty.ignore");
    reportPath = join(scratch, "scan.json");
    writeFileSync(config, "[extend]\nuseDefault = true\n", { flag: "wx", mode: 0o600 });
    writeFileSync(ignore, "", { flag: "wx", mode: 0o600 });
    const fd = openSync(join(scratch, "scan.log"), "wx", 0o600);
    stage = "scan-invoke";
    try {
      child = spawnSync(scanner, [
        "dir", OUT, "--config", config, "--gitleaks-ignore-path", ignore,
        "--ignore-gitleaks-allow", "--validation=false", "--redact=100", "--exit-code=1",
        "--report-format", "json", "--report-path", reportPath, "--no-banner", "--no-color", "--log-level", "error",
      ], { cwd: ROOT, stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    console.error(`[p06] stage=${stage} exit=1 scan_exit=${child?.status ?? "unknown"} result=not_verified`);
    throw error;
  }
  const observed = processObservation(child.status, child.signal);
  const report = scanReportState(reportPath);
  let result;
  if (child.error) result = "scanner_process_error";
  else if (observed.exit === null) result = observed.process;
  else if (observed.exit === 0) result = report === "empty" ? "clean" : "report_not_clean";
  else if (observed.exit === 1 && report === "findings_reported") result = "findings_reported";
  else result = "scanner_failed";
  console.log(`[p06] stage=publication-scan exit=${observed.exit ?? "unknown"} process=${observed.process} report=${report} result=${result}`);
  if (result !== "clean") throw new Error("publication scan not clean");
}

const LANES = {
  identity: laneIdentity,
  export: laneExport,
  emit: laneEmit,
  "verify-fixtures": laneVerifyFixtures,
  install: () => step("install-generated", ["pnpm", "install", "--frozen-lockfile", "--store-dir", STORE], { cwd: readChange().genWt }),
  "fixture-build": () => buildFixturePackages(readChange().genWt, "fixture-build"),
  "control-base": laneControlBase,
  "control-candidate": laneControlCandidate,
  release: laneRelease,
  manifest: laneManifest,
  scan: laneScan,
};

const lane = process.argv[2];
if (!Object.hasOwn(LANES, lane)) {
  console.error("usage: node qa/p06/run-qa.mjs <identity|export|install|fixture-build|emit|verify-fixtures|control-base|control-candidate|release|manifest|scan>");
  process.exit(2);
}
if (!OUT || !RUN || (lane !== "scan" && !STORE)) {
  console.error(`[p06] stage=${lane} exit=2 reason=missing_runner_environment`);
  process.exit(2);
}
const receiptLane = lane !== "manifest" && lane !== "scan";
console.log(`[p06] stage=${lane} phase=start`);
try {
  if (lane !== "scan") {
    const steps = readJsonReport(join(OUT, "steps.json"), 16 << 20);
    if (steps.state !== "missing" && (steps.state !== "ok" || !Array.isArray(steps.value))) {
      console.error(`[p06] stage=${lane} phase=read_step_receipts reason=unusable_receipts`);
      throw new Error("step receipts unavailable");
    }
    STEPS = steps.value ?? [];
    mkdirSync(OUT, { recursive: true });
  }
  await LANES[lane]();
  // The manifest is the last published file. The scan never writes to OUT.
  if (receiptLane) receipt(lane, true);
  console.log(`[p06] stage=${lane} phase=end exit=0`);
} catch (error) {
  console.error(`[p06] stage=${lane} phase=end exit=1`);
  process.exitCode = 1;
  if (lane !== "scan") {
    // Recording the failure must not let a second, raw filesystem or parser
    // exception escape to GitHub's log. Only OUT's fixed lane marker is public.
    try {
      mkdirSync(join(RUN, "logs"), { recursive: true });
      writeFileSync(join(RUN, "logs", `${lane}.error.txt`), `${error.stack ?? error}\n`);
    } catch {
      console.error(`[p06] stage=${lane} reason=private_error_receipt_failed`);
    }
    try {
      writeFileSync(join(OUT, `${lane}.error.txt`), `The ${lane} lane failed.\n`);
      if (receiptLane) receipt(lane, false);
    } catch {
      console.error(`[p06] stage=${lane} reason=lane_receipt_failed`);
    }
  }
}
