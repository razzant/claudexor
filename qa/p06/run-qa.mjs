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
 *
 * Evidence policy: QA_OUT receives only selected evidence (identity JSON, the
 * reviewed generated patch, synthetic fixtures, control hashes, release
 * outcome, steps.json, per-lane receipts, final manifest). Raw install/build/
 * test logs and all scratch live under QA_RUN and never enter the uploaded
 * tree. steps.json is rewritten by later lanes, so per-lane receipts do not
 * hash it; the final manifest covers its final bytes.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { caseFiles, prepareRunDir, runEmitTests, SCENARIOS, selectPassedCases } from "./run-emit.mjs";

const ROOT = process.env.GITHUB_WORKSPACE ?? process.cwd();
const { QA_OUT: OUT, QA_RUN: RUN, QA_STORE: STORE } = process.env;
if (!OUT || !RUN || !STORE) throw new Error("this CI harness requires explicit output, scratch and store directories");

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

const stepsPath = join(OUT, "steps.json");
const STEPS = existsSync(stepsPath) ? JSON.parse(readFileSync(stepsPath, "utf8")) : [];

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
function stepFn(name, fn, log) {
  const t0 = Date.now();
  try {
    fn();
    STEPS.push({ step: name, exit: 0, seconds: +((Date.now() - t0) / 1000).toFixed(2) });
    writeSteps();
    console.log(`${name} -> exit 0`);
  } catch (error) {
    STEPS.push({ step: name, exit: 1, seconds: +((Date.now() - t0) / 1000).toFixed(2) });
    writeSteps();
    console.log(`${name} -> exit 1`);
    throw error;
  } finally {
    void log;
  }
}

/** One bounded lane sub-step: argv, exit code and seconds land in steps.json.
 *  Raw logs go to runner scratch (QA_RUN/logs), never into the uploaded QA_OUT. */
function step(name, argv, { cwd = ROOT, env = {}, log } = {}) {
  const t0 = Date.now();
  const logPath = log ?? join(RUN, "logs", `${name}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  let code = 0;
  try {
    execFileSync(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", fd, fd],
      maxBuffer: 1 << 28,
    });
  } catch (error) {
    code = typeof error.status === "number" ? error.status : 1;
  } finally {
    closeSync(fd);
  }
  STEPS.push({
    step: name,
    argv: argv.map((a) => a.replaceAll(OUT, "$QA_OUT").replaceAll(ROOT, "$GITHUB_WORKSPACE").replaceAll(RUN, "$QA_RUN")),
    exit: code,
    seconds: +((Date.now() - t0) / 1000).toFixed(2),
  });
  writeSteps();
  console.log(`${name} -> exit ${code}`);
  if (code !== 0) {
    // Publish only recognized tracked source locations and compiler codes, never raw output.
    const tracked = new Set(execFileSync("git", ["-C", cwd, "ls-files", "-z"], { encoding: "utf8" }).split("\0"));
    const locations = new Set();
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      for (const m of line.matchAll(/([\w.@/-]+\.(?:[mc]?[jt]sx?|md|json))(?:\((\d+),(\d+)\): error (TS\d{3,6})\b|:(\d+):(\d+)\b|\b)/g)) {
        const path = m[1];
        if (tracked.has(path)) locations.add(m[4] ? `${path}:${m[2]}:${m[3]} ${m[4]}` : path);
      }
    }
    writeJson(join(OUT, `${name}.locations.json`), { step: name, exit: code, sourceLocations: [...locations].slice(-80), total: locations.size });
    throw new Error(`${name} exited ${code}`);
  }
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
    ...execFileSync("git", ["-C", root, "ls-files", "-z", GENERATED_DIR], { encoding: "utf8" }).split("\0"),
    ...execFileSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z", GENERATED_DIR], { encoding: "utf8" }).split("\0"),
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
      node: execFileSync("node", ["--version"], { encoding: "utf8" }).trim(),
      pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
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
      { env: idxEnv, stdio: ["ignore", fd, "inherit"] },
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
    { encoding: "utf8" },
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
  const dir = prepareRunDir(tree, join(RUN, `${lane}-run`));
  const raw = join(RUN, `${lane}-raw`);
  const report = join(dir, "vitest.json");
  const out = control ? join(OUT, "control", control) : join(OUT, "emit", "fixtures");
  let exit = 0;
  try {
    runEmitTests({ root: tree, runDir: dir, outDir: raw, control, issues: ["307", "697"], logPath: join(RUN, "logs", `${lane}.log`), reportPath: report });
  } catch (error) { exit = error.status || 1; }
  const cases = selectPassedCases(report, raw, out, control, ["307", "697"]);
  writeJson(join(OUT, `${lane}-cases.json`), { exit, cases });
  if (exit || cases.some((c) => c.outcome !== "passed")) throw new Error(`${lane}: one or more cases failed or were not verified`);
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
        files[`${issue}/${name}/${file}`] = { size: lstatSync(path).size, sha256: sha256File(path) };
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
  let code = 0;
  try {
    step("release-verify", ["pnpm", "release:verify:node"], { cwd: genWt });
  } catch {
    code = 1;
  }
  writeJson(join(out, "release.json"), {
    lane: "release",
    productHead,
    generatedTree,
    generatedCommit,
    exit: code,
    note: "pnpm release:verify:node unmodified, run in a worktree whose HEAD tree is the exact generated tree",
  });
  if (code !== 0) throw new Error("release:verify:node failed on the exact generated tree (log stays in QA_RUN/logs)");
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
};

const lane = process.argv[2];
if (!LANES[lane]) {
  console.error("usage: node qa/p06/run-qa.mjs <identity|export|install|fixture-build|emit|verify-fixtures|control-base|control-candidate|release|manifest>");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
try {
  await LANES[lane]();
  // The manifest is the last published file; it cannot also hash a later receipt for itself.
  if (lane !== "manifest") receipt(lane, true);
} catch (error) {
  // exec/File and assertion errors can contain their raw inputs. Keep them in scratch.
  mkdirSync(join(RUN, "logs"), { recursive: true });
  writeFileSync(join(RUN, "logs", `${lane}.error.txt`), `${error.stack ?? error}\n`);
  writeFileSync(join(OUT, `${lane}.error.txt`), `The ${lane} lane failed.\n`);
  if (lane !== "manifest") receipt(lane, false);
  console.error(`The ${lane} lane failed; see steps.json for the failing command.`);
  process.exit(1);
}
