#!/usr/bin/env node
/**
 * Real-harness synthetic battery for Claudexor.
 *
 * This is intentionally NOT a unit test. It runs real codex/claude/cursor
 * harnesses against disposable git repositories and asserts engine-owned
 * artifacts (decision/work_product/telemetry/review files), so it covers the
 * quality surfaces the deterministic fake smoke cannot.
 *
 * Safety:
 * - never targets the Claudexor repo as a mutation target;
 * - uses a temp CLAUDEXOR_CONFIG_DIR for daemon/settings state;
 * - keeps HOME native so real harness sessions/Keychain remain available;
 * - never prints secret values.
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { redactSecrets } from "../packages/util/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "cli", "dist", "cli.js");
const nodeBin = process.execPath;
const home = homedir();
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const defaultRoot = join(home, ".claudexor", "dogfood", `battery-${runId}`);
const batteryRoot = resolve(process.env.CLAUDEXOR_BATTERY_DIR ?? defaultRoot);
const configDir = join(batteryRoot, "config");
const resultsDir = join(batteryRoot, "results");
const reposDir = join(batteryRoot, "repos");
const logsDir = join(batteryRoot, "logs");
const maxUsd = process.env.CLAUDEXOR_BATTERY_MAX_USD ?? "1.50";
const timeoutMs = Number(process.env.CLAUDEXOR_BATTERY_TIMEOUT_MS ?? 20 * 60_000);
const requestedHarnesses = (process.env.CLAUDEXOR_BATTERY_HARNESSES ?? "codex,claude,cursor")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const marker = process.env.CLAUDEXOR_BATTERY_IMAGE_MARKER ?? "CLAUDEXOR-7521";
// Optional phase filter (e.g. "10,11,12"): an operator iterating on one
// surface should not re-burn the whole battery. Default: every phase.
const phaseFilter = (process.env.CLAUDEXOR_BATTERY_PHASES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => `phase${s.replace(/^phase/, "")}`);
const phaseEnabled = (id) => phaseFilter.length === 0 || phaseFilter.includes(id);

mkdirSync(configDir, { recursive: true });
mkdirSync(resultsDir, { recursive: true });
mkdirSync(reposDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });

const env = {
  ...process.env,
  PATH: [
    join(home, ".claudexor", "node", "bin"),
    join(home, ".local", "bin"),
    process.env.PATH ?? "",
  ].filter(Boolean).join(":"),
  CLAUDEXOR_CONFIG_DIR: configDir,
  CLAUDEXOR_DOCTOR_TTL_MS: "0",
};
if (existsSync(join(home, ".local", "bin", "cursor-agent"))) {
  env.CLAUDEXOR_CURSOR_BIN = join(home, ".local", "bin", "cursor-agent");
}
if (existsSync(join(home, ".claudexor", "node", "bin", "codex"))) {
  env.CLAUDEXOR_CODEX_BIN = join(home, ".claudexor", "node", "bin", "codex");
}
if (existsSync(join(home, ".claudexor", "node", "bin", "claude"))) {
  env.CLAUDEXOR_CLAUDE_BIN = join(home, ".claudexor", "node", "bin", "claude");
}

const results = [];
const evidence = {
  batteryRoot,
  configDir,
  cli,
  node: nodeBin,
  version: null,
  requestedHarnesses,
  okHarnesses: [],
  harnessReports: {},
};

function rel(path) {
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}

function logPath(name) {
  return join(logsDir, `${name.replace(/[^a-z0-9_.-]+/gi, "_")}.log`);
}

function record(status, phase, name, detail = {}, extras = {}) {
  const item = { status, phase, name, detail: redactDetail(detail), ...redactDetail(extras) };
  results.push(item);
  const tag = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : status === "env" ? "ENV" : "FAIL";
  const summary = typeof item.detail === "string" ? item.detail : JSON.stringify(item.detail);
  process.stdout.write(`${tag.padEnd(5)} ${phase.padEnd(10)} ${name.padEnd(44)} ${summary.slice(0, 180)}\n`);
  return item;
}

function pass(phase, name, detail = {}, extras = {}) { return record("pass", phase, name, detail, extras); }
function fail(phase, name, detail = {}, extras = {}) { return record("fail", phase, name, detail, extras); }
function skip(phase, name, detail = {}, extras = {}) { return record("skip", phase, name, detail, extras); }
function envfail(phase, name, detail = {}, extras = {}) { return record("env", phase, name, detail, extras); }

function isTransientEnvOutput(out) {
  const text = [out.stdout, out.stderr, out.error, JSON.stringify(out.json ?? {})].join("\n").toLowerCase();
  return text.includes("stream disconnected")
    || text.includes("failed to lookup address information")
    || text.includes("nodename nor servname")
    || text.includes("enotfound")
    || text.includes("eai_again")
    || text.includes("econnreset")
    || text.includes("etimedout");
}

function redactDetail(value) {
  if (typeof value === "string") return redactSecrets(value);
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value)));
  } catch {
    return redactSecrets(String(value));
  }
}

function run(cmd, args, opts = {}) {
  const cwd = opts.cwd ?? root;
  const res = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: opts.timeoutMs ?? timeoutMs,
  });
  return {
    code: typeof res.status === "number" ? res.status : 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ? String(res.error) : "",
  };
}

function runGit(args, cwd) {
  const res = run("git", args, { cwd, timeoutMs: 120_000 });
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

function runCli(args, opts = {}) {
  const name = opts.name ?? args.join(" ");
  const cwd = opts.cwd ?? root;
  let out = run(nodeBin, [cli, ...args], { cwd, timeoutMs: opts.timeoutMs ?? timeoutMs });
  let retriedForEnv = false;
  if (out.code !== 0 && isTransientEnvOutput({ ...out, json: null }) && opts.envRetry !== false) {
    retriedForEnv = true;
    out = run(nodeBin, [cli, ...args], { cwd, timeoutMs: opts.timeoutMs ?? timeoutMs });
  }
  const lp = logPath(name);
  writeFileSync(lp, [`$ claudexor ${args.join(" ")}`, `cwd=${cwd}`, `exit=${out.code}`, "", redactSecrets(out.stdout), redactSecrets(out.stderr), redactSecrets(out.error)].join("\n"));
  let json = null;
  if (opts.json !== false && out.stdout.trim().startsWith("{")) {
    try { json = JSON.parse(out.stdout); } catch { /* recorded by caller if needed */ }
  }
  return { ...out, json, log: lp, cwd, retriedForEnv, envFailure: out.code !== 0 && isTransientEnvOutput({ ...out, json }) };
}

function runCliJson(args, opts = {}) {
  return runCli([...args, "--json"], { ...opts, json: true });
}

function runCliText(args, opts = {}) {
  return runCli(args, { ...opts, json: false });
}

function inspectRun(runId, cwd) {
  const out = runCliJson(["inspect", runId], { cwd, name: `inspect ${runId}` });
  return out.json;
}

function artifactExists(runDir, relPath) {
  return existsSync(join(runDir, relPath));
}

function nonEmpty(path) {
  try { return statSync(path).size > 0; } catch { return false; }
}

function cleanName(name) {
  return name.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function initRepo(repo) {
  mkdirSync(repo, { recursive: true });
  runGit(["init", "-b", "main"], repo);
  runGit(["-c", "user.email=battery@claudexor.dev", "-c", "user.name=Claudexor Battery", "commit", "--allow-empty", "-m", "init"], repo);
}

function makeMathRepo(name, opts = {}) {
  const repo = join(reposDir, cleanName(name));
  rmSync(repo, { recursive: true, force: true });
  initRepo(repo);
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  const addBug = opts.addBug !== false;
  const multiplyBug = opts.multiplyBug === true;
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: `claudexor-battery-${cleanName(name)}`,
    version: "0.0.0",
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2) + "\n");
  writeFileSync(join(repo, "src", "math.js"), [
    `export function add(a, b) { return a ${addBug ? "-" : "+"} b; }`,
    multiplyBug
      ? `export function multiply(a, b) { throw new Error("TODO multiply"); }`
      : `export function multiply(a, b) { return a * b; }`,
    "",
  ].join("\n"));
  const tests = [
    `import test from "node:test";`,
    `import assert from "node:assert/strict";`,
    `import { add, multiply } from "../src/math.js";`,
    ``,
    `test("add adds", () => { assert.equal(add(2, 3), 5); });`,
  ];
  if (opts.testMultiply) tests.push(`test("multiply multiplies", () => { assert.equal(multiply(3, 4), 12); });`);
  writeFileSync(join(repo, "test", "math.test.js"), tests.join("\n") + "\n");
  writeFileSync(join(repo, "README.md"), `# Battery ${name}\n\nSynthetic dogfood repo for Claudexor.\n`);
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "ARCHITECTURE.md"), "# Architecture\n\nSmall ESM math module.\n");
  runGit(["add", "-A"], repo);
  runGit(["-c", "user.email=battery@claudexor.dev", "-c", "user.name=Claudexor Battery", "commit", "-m", "fixture"], repo);
  return repo;
}

function makeEmptyCreateRepo(name) {
  const repo = join(reposDir, cleanName(name));
  rmSync(repo, { recursive: true, force: true });
  initRepo(repo);
  writeFileSync(join(repo, "README.md"), "# Empty create target\n");
  runGit(["add", "-A"], repo);
  runGit(["-c", "user.email=battery@claudexor.dev", "-c", "user.name=Claudexor Battery", "commit", "-m", "empty target"], repo);
  return repo;
}

function makeProtectedRepo(name) {
  const repo = makeMathRepo(name, { addBug: false });
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: noop\non: workflow_dispatch\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n");
  runGit(["add", "-A"], repo);
  runGit(["-c", "user.email=battery@claudexor.dev", "-c", "user.name=Claudexor Battery", "commit", "-m", "protected fixture"], repo);
  return repo;
}

function testCmd() {
  return "node --test";
}

function baseRunArgs(prompt, harnesses, extra = []) {
  return [
    "agent", prompt,
    "--harness", Array.isArray(harnesses) ? harnesses.join(",") : harnesses,
    "--effort", "low",
    "--max-usd", maxUsd,
    ...extra,
  ];
}

function assertRunStatus(phase, name, out, wanted = ["success", "succeeded", "no_op", "ungated", "review_not_run"]) {
  if (out.envFailure) return envfail(phase, name, { reason: "transient network/environment failure after retry", exit: out.code, log: rel(out.log), error: out.json?.error ?? out.json?.summary ?? "" });
  if (!out.json) return fail(phase, name, { error: "non-json output", exit: out.code, log: rel(out.log) });
  const status = out.json.status;
  if (!wanted.includes(status)) return fail(phase, name, { status, exit: out.code, error: out.json.error ?? out.json.summary ?? "", log: rel(out.log), runId: out.json.runId });
  return pass(phase, name, { status, runId: out.json.runId, runDir: out.json.runDir ?? out.json.runDir });
}

function assertPrimaryOutput(phase, name, out, kind) {
  const r = assertRunStatus(phase, name, out, ["success", "blocked"]);
  if (r.status === "fail" || !out.json?.runId) return out.json;
  const detail = inspectRun(out.json.runId, out.cwd ?? root);
  const path = detail?.primaryOutput?.path ?? "";
  if (!path.includes(kind)) fail(phase, `${name} primary output`, { expected: kind, path, runId: out.json.runId });
  else pass(phase, `${name} primary output`, { path, runId: out.json.runId });
  return detail;
}

function recordRunEvidence(phase, name, out, cwd) {
  if (out.envFailure) {
    envfail(phase, name, { reason: "transient network/environment failure after retry", exit: out.code, log: rel(out.log), error: out.json?.error ?? out.json?.summary ?? "" });
    return null;
  }
  if (!out.json?.runId) return null;
  const detail = inspectRun(out.json.runId, cwd);
  const wp = detail?.work_product ?? detail?.workProduct ?? null;
  const decision = detail?.decision ?? null;
  const telemetry = detail?.telemetry ?? null;
  const patchPath = detail?.runDir ? join(detail.runDir, "final", "patch.diff") : "";
  return { detail, wp, decision, telemetry, patchPath, patchNonEmpty: patchPath ? nonEmpty(patchPath) : false };
}

function gatePassed(detail) {
  const attempts = detail?.telemetry?.attempts ?? [];
  return attempts.some((a) => a.outcome?.gates_passed === true || (a.gates ?? []).some((g) => g.status === "passed"));
}

function patchLooksReal(ev) {
  const diffstat = ev?.wp?.meta?.diffstat;
  return ev?.patchNonEmpty && (diffstat?.files ?? 0) > 0;
}

function setGlobalConfig(yaml) {
  writeFileSync(join(configDir, "config.yaml"), yaml);
}

function clearGlobalConfig() {
  rmSync(join(configDir, "config.yaml"), { force: true });
}

// Tiny PNG encoder with a 5x7 bitmap font for the marker image.
function crc32(buf) {
  const table = crc32.table ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const FONT = {
  A: ["01110","10001","10001","11111","10001","10001","10001"],
  C: ["01111","10000","10000","10000","10000","10000","01111"],
  D: ["11110","10001","10001","10001","10001","10001","11110"],
  E: ["11111","10000","10000","11110","10000","10000","11111"],
  L: ["10000","10000","10000","10000","10000","10000","11111"],
  O: ["01110","10001","10001","10001","10001","10001","01110"],
  R: ["11110","10001","10001","11110","10100","10010","10001"],
  U: ["10001","10001","10001","10001","10001","10001","01110"],
  X: ["10001","01010","00100","00100","00100","01010","10001"],
  "-": ["00000","00000","00000","11111","00000","00000","00000"],
  "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00010","00100","01000","11111"],
  "5": ["11111","10000","11110","00001","00001","10001","01110"],
  "7": ["11111","00001","00010","00100","01000","01000","01000"],
};

function writeMarkerPng(path, text) {
  const scale = 8;
  const marginX = 28;
  const marginY = 58;
  const width = Math.max(520, marginX * 2 + text.length * 6 * scale);
  const height = Math.max(180, marginY * 2 + 7 * scale);
  const rgba = Buffer.alloc(width * height * 4, 255);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  };
  for (let x = 0; x < width; x++) { set(x, 0, 220, 0, 0); set(x, height - 1, 220, 0, 0); }
  for (let y = 0; y < height; y++) { set(0, y, 220, 0, 0); set(width - 1, y, 220, 0, 0); }
  let ox = marginX;
  const oy = marginY;
  for (const ch of text) {
    const glyph = FONT[ch] ?? FONT["-"];
    for (let gy = 0; gy < glyph.length; gy++) {
      for (let gx = 0; gx < glyph[gy].length; gx++) {
        if (glyph[gy][gx] !== "1") continue;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) set(ox + gx * scale + sx, oy + gy * scale + sy, 0, 0, 0);
      }
    }
    ox += (6 * scale);
  }
  if (ox + marginX > width) throw new Error(`marker PNG too narrow for ${text}`);
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    rawRows.push(Buffer.from([0]));
    rawRows.push(rgba.subarray(y * width * 4, (y + 1) * width * 4));
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rawRows))),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

function harnessOk(h) {
  return evidence.okHarnesses.includes(h);
}

function harnessIntent(h, intent) {
  const report = evidence.harnessReports[h] ?? {};
  return (report.enabledIntents ?? report.enabled_intents ?? []).includes(intent);
}

function available(list) {
  return list.filter(harnessOk);
}

function needHarness(phase, h, label = h) {
  if (!harnessOk(h)) {
    skip(phase, label, { reason: "doctor not ok / not available" });
    return false;
  }
  return true;
}

function runReadonlyPhase() {
  const phase = "phase1";
  for (const h of requestedHarnesses) {
    if (!needHarness(phase, h, `${h} read-only`)) continue;
    assertPrimaryOutput(phase, `${h} ask 2+2`, runCliJson(["ask", "Answer exactly: 4", "--harness", h, "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-${h}-ask` }), "answer.md");
    assertPrimaryOutput(phase, `${h} audit`, runCliJson(["audit", "Briefly map this repository: files, tests, and the math bug. Do not edit files.", "--harness", h, "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-${h}-audit` }), "report.md");
    assertPrimaryOutput(phase, `${h} plan`, runCliJson(["plan", "Plan adding a multiply feature to this tiny repo. Keep it concise.", "--harness", h, "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-${h}-plan` }), "plan.md");
    assertPrimaryOutput(phase, `${h} explore`, runCliJson(["explore", "Find where add is implemented and tested. Keep it concise.", "--harness", h, "--n", "1", "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-${h}-explore` }), "explore.md");
  }
  const multi = available(requestedHarnesses);
  if (multi.length >= 2) {
    const plan = runCliJson(["plan", "Plan adding multiply; reconcile disagreements between planners.", "--harness", multi.join(","), "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-multi-plan` });
    const detail = assertPrimaryOutput(phase, "multi plan", plan, "plan.md");
    if (detail?.runDir) {
      const plansDir = join(detail.runDir, "plans");
      const hasReview = artifactExists(detail.runDir, "reviews/plan-review.yaml");
      pass(phase, "multi plan artifacts", { hasReview, plansDirExists: existsSync(plansDir), runId: plan.json?.runId });
    }
    const exp = runCliJson(["explore", "Find where add is implemented and tested; each explorer should take a distinct slice.", "--harness", multi.join(","), "--n", String(Math.min(3, multi.length)), "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-multi-explore` });
    const ed = assertPrimaryOutput(phase, "multi explore", exp, "explore.md");
    if (ed?.runDir) {
      pass(phase, "multi explore artifacts", {
        findings: existsSync(join(ed.runDir, "findings")),
        exploreFindings: artifactExists(ed.runDir, "final/explore-findings.yaml"),
        omissions: artifactExists(ed.runDir, "final/omissions.md"),
      });
    }
  } else skip(phase, "multi read-only", { reason: "need >=2 doctor-ok harnesses" });
}

function runWritePhase() {
  const phase = "phase2";
  for (const h of requestedHarnesses) {
    if (!needHarness(phase, h, `${h} run`)) continue;
    const repo = makeMathRepo(`${phase}-${h}`, { addBug: true });
    const out = runCliJson(baseRunArgs("Fix src/math.js add(a,b) so node --test passes. Do not change tests.", h, ["--test", testCmd()]), { cwd: repo, name: `${phase}-${h}-run` });
    const ev = recordRunEvidence(phase, `${h} run evidence`, out, repo);
    if (!ev) continue;
    const applyable = ["success", "succeeded"].includes(out.json?.status) && ev.decision?.status === "success" && ev.decision?.verification_basis === "both";
    if (patchLooksReal(ev) && gatePassed(ev.detail) && applyable) pass(phase, `${h} run patch+gate`, { runId: out.json.runId, status: out.json.status, basis: ev.decision?.verification_basis ?? "none" });
    else fail(phase, `${h} run patch+gate`, { runId: out.json?.runId, status: out.json?.status, patch: ev.patchNonEmpty, gatePassed: gatePassed(ev.detail), decision: ev.decision });
    state.verifiedRuns.push({ harness: h, repo, out, ev });
  }
}

function runMultiWritePhase() {
  const phase = "phase3";
  const multi = available(requestedHarnesses);
  if (multi.length < 2) { skip(phase, "multi write features", { reason: "need >=2 doctor-ok harnesses" }); return; }
  {
    const repo = makeMathRepo(`${phase}-race`, { addBug: true });
    const out = runCliJson(["best-of", "Fix add(a,b) in src/math.js so tests pass. Do not change tests.", "--harness", multi.join(","), "--n", String(Math.min(3, multi.length)), "--test", testCmd(), "--effort", "low", "--max-usd", maxUsd], { cwd: repo, name: `${phase}-race` });
    const ev = recordRunEvidence(phase, "multi race evidence", out, repo);
    if (out.envFailure) return;
    if (ev?.decision?.status === "success" && ev.decision.verification_basis === "both" && patchLooksReal(ev) && gatePassed(ev.detail)) pass(phase, "multi race decision", { runId: out.json.runId, status: out.json.status, winner: ev.decision.winner, basis: ev.decision.verification_basis, outcome: ev.decision.outcome });
    else fail(phase, "multi race decision", { status: out.json?.status, error: out.json?.error, log: rel(out.log) });
    state.multiRace = { repo, out, ev };
  }
  {
    const repo = makeMathRepo(`${phase}-synthesis`, { addBug: true });
    const out = runCliJson(["best-of", "Fix add(a,b) in src/math.js so tests pass. Do not change tests.", "--harness", multi.join(","), "--n", "3", "--synthesis", "always", "--test", testCmd(), "--effort", "low", "--max-usd", maxUsd], { cwd: repo, name: `${phase}-synthesis` });
    const ev = recordRunEvidence(phase, "synthesis evidence", out, repo);
    if (out.envFailure) return;
    const synth = ev?.detail?.runDir ? artifactExists(ev.detail.runDir, "arbitration/synthesis.yaml") : false;
    if (synth && ev?.decision?.status === "success" && ev.decision.verification_basis === "both" && patchLooksReal(ev) && gatePassed(ev.detail)) pass(phase, "synthesis artifact", { runId: out.json?.runId, status: out.json?.status, basis: ev.decision.verification_basis });
    else fail(phase, "synthesis artifact", { runId: out.json?.runId, status: out.json?.status, decision: ev?.decision, error: out.json?.error, log: rel(out.log) });
  }
  {
    const repo = makeMathRepo(`${phase}-convergence`, { addBug: true });
    const out = runCliJson(["agent", "Fix add(a,b) in src/math.js so tests pass. Do not change tests.", "--harness", multi.join(","), "--until-clean", "--test", testCmd(), "--effort", "low", "--max-usd", maxUsd], { cwd: repo, name: `${phase}-convergence`, timeoutMs: 30 * 60_000 });
    const ev = recordRunEvidence(phase, "convergence evidence", out, repo);
    if (out.envFailure) return;
    if (ev?.wp?.meta?.status === "success" && ev.wp.meta.review_verified === true && ["success", "succeeded"].includes(out.json?.status)) pass(phase, "convergence work_product", { runId: out.json?.runId, status: ev.wp.meta.status, attempts: ev.wp.meta.attempts, reviewVerified: ev.wp.meta.review_verified });
    else fail(phase, "convergence work_product", { status: out.json?.status, error: out.json?.error, log: rel(out.log) });
  }
  runDegradationControl(phase, multi[0]);
}

function runDegradationControl(phase, onlyHarness) {
  const disabled = requestedHarnesses.filter((h) => h !== onlyHarness);
  setGlobalConfig([
    "version: 1",
    "harnesses:",
    ...disabled.flatMap((h) => [`  ${h}:`, "    enabled: false"]),
    "",
  ].join("\n"));
  try {
    const repo = makeMathRepo(`${phase}-single-family-control`, { addBug: true });
    const out = runCliJson(["best-of", "Fix add(a,b) in src/math.js so tests pass. Do not change tests.", "--harness", onlyHarness, "--n", "1", "--test", testCmd(), "--effort", "low", "--max-usd", maxUsd], { cwd: repo, name: `${phase}-single-family-control` });
    const ev = recordRunEvidence(phase, "single-family control", out, repo);
    if (ev?.decision) {
      const basis = ev.decision.verification_basis ?? "unknown";
      const rec = basis === "none" ? pass : fail;
      rec(phase, "single-family verification_basis=none", { runId: out.json?.runId, status: out.json?.status, outcome: ev.decision.outcome, basis });
      const apply = runCliJson(["apply", out.json.runId, "--dry-run"], { cwd: repo, name: `${phase}-single-family-apply-refusal` });
      if (apply.code !== 0 && /not verified|refusing apply|not applyable|decision status/.test(apply.stdout + apply.stderr)) pass(phase, "single-family apply refused", { runId: out.json.runId });
      else fail(phase, "single-family apply refused", { exit: apply.code, stdout: apply.stdout, stderr: apply.stderr, log: rel(apply.log) });
    } else {
      fail(phase, "single-family control decision", { status: out.json?.status, error: out.json?.error, log: rel(out.log) });
    }
    const convRepo = makeMathRepo(`${phase}-single-family-convergence`, { addBug: true });
    const conv = runCliJson(["agent", "Fix add(a,b) in src/math.js so tests pass. Do not change tests.", "--harness", onlyHarness, "--until-clean", "--test", testCmd(), "--effort", "low", "--max-usd", maxUsd], { cwd: convRepo, name: `${phase}-single-family-convergence` });
    if (conv.code !== 0 && /cross-family|review/.test(JSON.stringify(conv.json ?? {}) + conv.stdout + conv.stderr)) pass(phase, "single-family convergence refused", { status: conv.json?.status, error: conv.json?.error ?? conv.json?.summary });
    else fail(phase, "single-family convergence refused", { exit: conv.code, json: conv.json, log: rel(conv.log) });
  } finally {
    clearGlobalConfig();
  }
}

function chooseVerifiedRun() {
  return state.verifiedRuns.find((r) => r.out.json?.status === "succeeded" && r.ev?.decision?.status === "success")
    ?? (state.multiRace?.out?.json?.status === "succeeded" && state.multiRace?.ev?.decision?.status === "success" ? state.multiRace : null);
}

function runLifecyclePhase() {
  const phase = "phase4";
  const multi = available(requestedHarnesses);
  if (multi.length < 2) { skip(phase, "apply/decision lifecycle", { reason: "need >=2 doctor-ok harnesses" }); return; }
  const verified = chooseVerifiedRun();
  if (verified?.out?.json?.runId) {
    const dry = runCliJson(["apply", verified.out.json.runId, "--dry-run"], { cwd: verified.repo, name: `${phase}-apply-dry-run` });
    if (dry.code === 0) pass(phase, "apply --dry-run", { runId: verified.out.json.runId });
    else fail(phase, "apply --dry-run", { exit: dry.code, json: dry.json, log: rel(dry.log) });
  } else skip(phase, "apply --dry-run", { reason: "no verified applyable run from earlier phases" });

  for (const mode of ["branch", "commit"]) {
    const repo = makeMathRepo(`${phase}-apply-${mode}`, { addBug: true });
    const out = runCliJson(["best-of", "Fix add(a,b) in src/math.js so tests pass. Do not change tests.", "--harness", multi.join(","), "--n", String(Math.min(3, multi.length)), "--test", testCmd(), "--effort", "low", "--max-usd", maxUsd], { cwd: repo, name: `${phase}-${mode}-source` });
    const ev = recordRunEvidence(phase, `apply ${mode} source`, out, repo);
    if (out.json?.status === "succeeded" && ev?.decision?.status === "success") {
      const applied = runCliJson(["apply", out.json.runId, "--mode", mode], { cwd: repo, name: `${phase}-apply-${mode}` });
      if (applied.code === 0 && applied.json?.applied) pass(phase, `apply --mode ${mode}`, applied.json);
      else fail(phase, `apply --mode ${mode}`, { exit: applied.code, json: applied.json, log: rel(applied.log) });
    } else skip(phase, `apply --mode ${mode}`, { reason: "source run not applyable", status: out.json?.status, decision: ev?.decision });
  }

  runBlockedDecisionScenario(phase, multi);
  runRevertScenario(phase, multi);
}

function runBlockedDecisionScenario(phase, multi) {
  const repo = makeProtectedRepo(`${phase}-blocked-risk`);
  const prompt = "Make a harmless wording-only change to .github/workflows/release.yml by changing the echo text to 'battery ok'. Do not touch other files.";
  const out = runCliJson(["agent", prompt, "--harness", multi.join(","), "--test", "true", "--effort", "low", "--max-usd", maxUsd], { cwd: repo, name: `${phase}-blocked-risk` });
  const ev = recordRunEvidence(phase, "blocked risk evidence", out, repo);
  if (out.json?.status === "blocked" && ev?.patchNonEmpty) {
    pass(phase, "blocked high-risk run", { runId: out.json.runId, outcome: ev.decision?.outcome, status: ev.decision?.status });
    const dec = runCliJson(["decision", out.json.runId, "--accept-risk"], { cwd: repo, name: `${phase}-accept-risk` });
    if (dec.code === 0 && dec.json?.accepted) pass(phase, "decision --accept-risk", dec.json);
    else fail(phase, "decision --accept-risk", { exit: dec.code, json: dec.json, log: rel(dec.log) });
    const op = ev.detail?.runDir ? existsSync(join(ev.detail.runDir, "arbitration", "operator_decision.yaml")) : false;
    if (op) pass(phase, "operator_decision.yaml", { runId: out.json.runId });
    else fail(phase, "operator_decision.yaml", { runId: out.json.runId });
  } else {
    skip(phase, "blocked high-risk decision", { reason: "scenario did not produce blocked patch", status: out.json?.status, decision: ev?.decision, log: rel(out.log) });
  }

  const rerunRepo = makeProtectedRepo(`${phase}-blocked-rerun`);
  const rerunSrc = runCliJson(["agent", prompt, "--harness", multi.join(","), "--test", "true", "--effort", "low", "--max-usd", maxUsd], { cwd: rerunRepo, name: `${phase}-blocked-rerun-source` });
  if (rerunSrc.json?.status === "blocked") {
    const rerun = runCliJson(["decision", rerunSrc.json.runId, "--rerun", "--feedback", "Use a smaller harmless wording change only."], { cwd: rerunRepo, name: `${phase}-rerun-feedback` });
    if (rerun.code === 0 && rerun.json?.newRunId) pass(phase, "decision --rerun", { newRunId: rerun.json.newRunId });
    else fail(phase, "decision --rerun", { exit: rerun.code, json: rerun.json, log: rel(rerun.log) });
  } else skip(phase, "decision --rerun", { reason: "source did not block", status: rerunSrc.json?.status });
}

function runRevertScenario(phase, multi) {
  const repo = makeMathRepo(`${phase}-revert`, { addBug: true });
  const out = runCliJson(["agent", "Fix add(a,b) in src/math.js so tests pass. Do not change tests.", "--harness", multi.join(","), "--in-place", "--test", testCmd(), "--effort", "low", "--max-usd", maxUsd], { cwd: repo, name: `${phase}-in-place-revert` });
  if (out.json?.runId && ["succeeded", "success"].includes(out.json.status)) {
    const rev = runCliJson(["decision", out.json.runId, "--revert"], { cwd: repo, name: `${phase}-revert` });
    if (rev.code === 0 && rev.json?.accepted) pass(phase, "decision --revert", rev.json);
    else fail(phase, "decision --revert", { exit: rev.code, json: rev.json, log: rel(rev.log) });
  } else skip(phase, "decision --revert", { reason: "in-place source not succeeded", status: out.json?.status, error: out.json?.error, log: rel(out.log) });

  const repo2 = makeMathRepo(`${phase}-revert-diverged`, { addBug: true });
  const out2 = runCliJson(["agent", "Fix add(a,b) in src/math.js so tests pass. Do not change tests.", "--harness", multi.join(","), "--in-place", "--test", testCmd(), "--effort", "low", "--max-usd", maxUsd], { cwd: repo2, name: `${phase}-in-place-diverge-source` });
  if (out2.json?.runId && ["succeeded", "success"].includes(out2.json.status)) {
    writeFileSync(join(repo2, "src", "extra.js"), "export const diverged = true;\n");
    const rev = runCliJson(["decision", out2.json.runId, "--revert"], { cwd: repo2, name: `${phase}-revert-diverged` });
    if (rev.code !== 0 && /diverged|rejected/.test(JSON.stringify(rev.json ?? {}) + rev.stdout + rev.stderr)) pass(phase, "revert divergence fence", { runId: out2.json.runId });
    else fail(phase, "revert divergence fence", { exit: rev.code, json: rev.json, log: rel(rev.log) });
  } else skip(phase, "revert divergence fence", { reason: "in-place source not succeeded", status: out2.json?.status });
}

function runCreatePhase() {
  const phase = "phase5";
  const multi = available(requestedHarnesses);
  for (const h of requestedHarnesses) {
    if (!needHarness(phase, h, `${h} create`)) continue;
    const repo = makeEmptyCreateRepo(`${phase}-${h}`);
    const out = runCliJson(["create", "Create a tiny ESM Node project with src/hello.js exporting hello(name) and a node:test test in test/hello.test.js. Keep it minimal.", "--harness", h, "--test", testCmd(), "--effort", "low", "--max-usd", maxUsd], { cwd: repo, name: `${phase}-${h}-create` });
    const ev = recordRunEvidence(phase, `${h} create evidence`, out, repo);
    if (out.envFailure) continue;
    if (ev?.patchNonEmpty && ev?.wp?.kind === "new_repo") pass(phase, `${h} create patch`, { runId: out.json?.runId, status: out.json?.status, kind: ev.wp.kind });
    else fail(phase, `${h} create patch`, { runId: out.json?.runId, status: out.json?.status, kind: ev?.wp?.kind, patch: ev?.patchNonEmpty, error: out.json?.error });
  }
  if (multi.length >= 2) {
    const repo = makeEmptyCreateRepo(`${phase}-multi`);
    const out = runCliJson(["create", "Create a tiny ESM Node project with src/hello.js exporting hello(name) and a node:test test in test/hello.test.js. Keep it minimal.", "--harness", multi.join(","), "--n", String(Math.min(3, multi.length)), "--test", testCmd(), "--effort", "low", "--max-usd", maxUsd], { cwd: repo, name: `${phase}-multi-create` });
    const ev = recordRunEvidence(phase, "multi create evidence", out, repo);
    if (out.envFailure) return;
    if (ev?.patchNonEmpty && ev?.wp?.kind === "new_repo") pass(phase, "multi create patch", { runId: out.json?.runId, status: out.json?.status, kind: ev.wp.kind, basis: ev.decision?.verification_basis });
    else fail(phase, "multi create patch", { runId: out.json?.runId, status: out.json?.status, kind: ev?.wp?.kind, patch: ev?.patchNonEmpty, error: out.json?.error });
  } else skip(phase, "multi create", { reason: "need >=2 doctor-ok harnesses" });
}

function runVisionPhase() {
  const phase = "phase6";
  const png = join(batteryRoot, "marker.png");
  writeMarkerPng(png, marker);
  const visionHarnesses = available(["codex", "claude"]);
  for (const h of visionHarnesses) {
    const out = runCliJson(["ask", `Read the image. What exact marker text is shown? Answer only the marker text.`, "--harness", h, "--image", png, "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-${h}-image` });
    const detail = assertPrimaryOutput(phase, `${h} image`, out, "answer.md");
    const answer = detail?.primaryOutput?.text ?? "";
    if (answer.includes(marker)) pass(phase, `${h} image marker`, { marker, runId: out.json?.runId });
    else fail(phase, `${h} image marker`, { marker, answer: answer.slice(0, 200), runId: out.json?.runId });
  }
  if (visionHarnesses.length >= 2) {
    const out = runCliJson(["ask", `Read the image. What exact marker text is shown? Answer only the marker text.`, "--harness", visionHarnesses.join(","), "--image", png, "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-multi-image` });
    const detail = assertPrimaryOutput(phase, "multi image", out, "answer.md");
    const answer = detail?.primaryOutput?.text ?? "";
    if (answer.includes(marker)) pass(phase, "multi image marker", { marker, runId: out.json?.runId });
    else fail(phase, "multi image marker", { marker, answer: answer.slice(0, 200), runId: out.json?.runId });
  } else skip(phase, "multi image", { reason: "need codex+claude ok" });
  if (harnessOk("cursor")) {
    const out = runCliJson(["ask", "Read the image.", "--harness", "cursor", "--image", png, "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-cursor-image-negative` });
    if (out.code !== 0 && /cannot accept image/.test(JSON.stringify(out.json ?? {}) + out.stdout + out.stderr)) pass(phase, "cursor image fail-loud", { status: out.json?.status, error: out.json?.error ?? out.json?.summary });
    else fail(phase, "cursor image fail-loud", { exit: out.code, json: out.json, log: rel(out.log) });
  } else skip(phase, "cursor image negative", { reason: "cursor not ok" });
}

function runWebPhase() {
  const phase = "phase7";
  const prompt = "Use live web/search evidence to fetch https://example.com and answer with the page heading/domain in one sentence.";
  const webHarnesses = available(["codex", "claude"]);
  for (const h of webHarnesses) {
    const out = runCliJson(["ask", prompt, "--harness", h, "--web", "live", "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-${h}-web` });
    const detail = inspectRun(out.json?.runId ?? "", repos.readonly);
    const st = detail?.telemetry?.web?.status;
    if (out.code === 0 && st === "satisfied") pass(phase, `${h} web satisfied`, { runId: out.json?.runId, status: st, tool: detail.telemetry.web.tool, target: detail.telemetry.web.target });
    else fail(phase, `${h} web satisfied`, { runId: out.json?.runId, status: st, error: out.json?.error ?? out.json?.summary, log: rel(out.log) });
  }
  if (webHarnesses.length >= 2) {
    const out = runCliJson(["ask", prompt, "--harness", webHarnesses.join(","), "--web", "live", "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-multi-web` });
    const detail = inspectRun(out.json?.runId ?? "", repos.readonly);
    const st = detail?.telemetry?.web?.status;
    if (out.code === 0 && st === "satisfied") pass(phase, "multi web satisfied", { runId: out.json?.runId, status: st });
    else fail(phase, "multi web satisfied", { runId: out.json?.runId, status: st, error: out.json?.error ?? out.json?.summary, log: rel(out.log) });
  } else skip(phase, "multi web", { reason: "need codex+claude ok" });
  if (harnessOk("cursor")) {
    const out = runCliJson(["ask", prompt, "--harness", "cursor", "--web", "live", "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-cursor-web-negative` });
    if (out.code !== 0 && /web policy|web-capable|uncontrolled/.test(JSON.stringify(out.json ?? {}) + out.stdout + out.stderr)) pass(phase, "cursor web fail-loud", { status: out.json?.status, error: out.json?.error ?? out.json?.summary });
    else fail(phase, "cursor web fail-loud", { exit: out.code, json: out.json, log: rel(out.log) });
  } else skip(phase, "cursor web negative", { reason: "cursor not ok" });
}

function answerQuestionsFile(path) {
  const draft = JSON.parse(readFileSync(path, "utf8"));
  const answers = (draft.questions ?? []).map((q) => {
    if (q.kind === "text" || q.allow_text || !q.options?.length) return { question_id: q.id, option_ids: [], text: "Use the simplest public API and include node:test coverage." };
    const first = q.options[0]?.id;
    return { question_id: q.id, option_ids: first ? [first] : [], text: null };
  });
  const answered = { ...draft, answers };
  const out = path.replace(/questions\.json$/, "answers.json");
  writeFileSync(out, JSON.stringify(answered, null, 2) + "\n");
  return out;
}

function runSpecPhase() {
  const phase = "phase8";
  const multi = available(requestedHarnesses);
  if (multi.length < 2) { skip(phase, "spec interview", { reason: "need >=2 doctor-ok harnesses" }); return; }
  const repo = makeMathRepo(`${phase}-spec`, { addBug: true, multiplyBug: true, testMultiply: true });
  const prompt = "Add a multiply feature and fix math so all node:test tests pass. Use a small public API. Ask material open questions if ambiguous.";
  const q = runCliJson(["spec", prompt, "--harness", multi.join(","), "--n", String(Math.min(3, multi.length)), "--effort", "low", "--max-usd", maxUsd], { cwd: repo, name: `${phase}-questions`, timeoutMs: 30 * 60_000 });
  if (q.code !== 0 || !q.json?.questionsPath) { fail(phase, "spec questions", { exit: q.code, json: q.json, log: rel(q.log) }); return; }
  pass(phase, "spec questions", { questions: q.json.questions?.length ?? 0, path: q.json.questionsPath });
  const answers = answerQuestionsFile(q.json.questionsPath);
  const frozen = runCliJson(["spec", prompt, "--answers", answers, "--harness", multi.join(","), "--effort", "low", "--max-usd", maxUsd], { cwd: repo, name: `${phase}-freeze` });
  if (frozen.code === 0 && frozen.json?.specDir) pass(phase, "spec freeze", { specId: frozen.json.specId, specDir: frozen.json.specDir });
  else { fail(phase, "spec freeze", { exit: frozen.code, json: frozen.json, log: rel(frozen.log) }); return; }
  const specPath = join(frozen.json.specDir, "spec.json");
  const runOut = runCliJson(["best-of", "--spec", specPath, "--harness", multi.join(","), "--n", String(Math.min(3, multi.length)), "--test", testCmd(), "--effort", "low", "--max-usd", maxUsd], { cwd: repo, name: `${phase}-race-spec`, timeoutMs: 30 * 60_000 });
  const ev = recordRunEvidence(phase, "race --spec evidence", runOut, repo);
  if (runOut.envFailure) return;
  if (ev?.patchNonEmpty) pass(phase, "race --spec patch", { runId: runOut.json?.runId, status: runOut.json?.status, basis: ev.decision?.verification_basis });
  else fail(phase, "race --spec patch", { status: runOut.json?.status, error: runOut.json?.error, log: rel(runOut.log) });
}

function runOrchestratePhase() {
  const phase = "phase9";
  const candidates = available(requestedHarnesses).filter((h) => harnessIntent(h, "orchestrate"));
  for (const h of candidates) {
    const out = runCliJson(["orchestrate", "Plan how to fix add() and verify with node --test in this repo. Suggest only.", "--harness", h, "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-${h}-orchestrate` });
    const detail = assertPrimaryOutput(phase, `${h} orchestrate`, out, "orchestration.md");
    if (detail?.runDir && artifactExists(detail.runDir, "final/orchestration.yaml")) pass(phase, `${h} orchestration.yaml`, { runId: out.json?.runId });
    else fail(phase, `${h} orchestration.yaml`, { runId: out.json?.runId, status: out.json?.status });
  }
  if (candidates.length >= 2) {
    const out = runCliJson(["orchestrate", "Plan how to fix add() and verify with node --test in this repo. Suggest only.", "--harness", candidates.join(","), "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-multi-orchestrate` });
    const detail = assertPrimaryOutput(phase, "multi orchestrate", out, "orchestration.md");
    if (detail?.runDir && artifactExists(detail.runDir, "final/orchestration.yaml")) pass(phase, "multi orchestration.yaml", { runId: out.json?.runId });
    else fail(phase, "multi orchestration.yaml", { runId: out.json?.runId, status: out.json?.status });
  } else skip(phase, "multi orchestrate", { reason: "need >=2 doctor-ok harnesses" });
  if (harnessOk("cursor") && !harnessIntent("cursor", "orchestrate")) {
    const out = runCliJson(["orchestrate", "Plan how to fix add() and verify with node --test in this repo. Suggest only.", "--harness", "cursor", "--effort", "low", "--max-usd", maxUsd], { cwd: repos.readonly, name: `${phase}-cursor-orchestrate-negative` });
    if (out.code !== 0 && /cannot orchestrate/.test(JSON.stringify(out.json ?? {}) + out.stdout + out.stderr)) pass(phase, "cursor orchestrate fail-loud", { status: out.json?.status, error: out.json?.error ?? out.json?.summary });
    else fail(phase, "cursor orchestrate fail-loud", { exit: out.code, json: out.json, log: rel(out.log) });
  }
}

/** Drive a stdio JSON-RPC server (mcp/acp serve) for one battery phase. */
function stdioServer(args, cwd) {
  const child = spawn(nodeBin, [cli, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += String(c); });
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (l) => { if (l.trim()) { try { messages.push(JSON.parse(l)); } catch { /* non-JSON noise is a finding surfaced by timeouts */ } } });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const waitFor = async (pred, timeout) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const hit = messages.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const close = async () => {
    child.stdin.end();
    await new Promise((r) => setTimeout(r, 200));
    child.kill();
  };
  return { send, waitFor, messages, close, stderrText: () => stderr };
}

/** MCP serve smoke against a REAL doctor-ok harness. */
async function runMcpServePhase() {
  const phase = "phase10";
  const [h] = available(requestedHarnesses);
  if (!h) { skip(phase, "mcp serve smoke", { reason: "no doctor-ok harness" }); return; }
  const repo = makeMathRepo(`${phase}-mcp`, { addBug: true });
  const srv = stdioServer(["mcp", "serve"], repo);
  try {
    srv.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "battery", version: "1.0" } } });
    const init = await srv.waitFor((m) => m.id === 0, 20_000);
    if (init?.result?.protocolVersion === "2025-06-18") pass(phase, "mcp initialize", { serverVersion: init.result?.serverInfo?.version });
    else { fail(phase, "mcp initialize", { init, stderr: srv.stderrText().slice(-300) }); return; }
    srv.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    srv.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = await srv.waitFor((m) => m.id === 1, 15_000);
    const names = (tools?.result?.tools ?? []).map((t) => t.name);
    if (names.length === 12 && names.includes("claudexor_ask") && names.includes("claudexor_best_of")) pass(phase, "mcp tools/list", { count: names.length });
    else { fail(phase, "mcp tools/list", { names }); return; }
    srv.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "claudexor_ask", arguments: { prompt: "Answer exactly: 4. What is 2+2?", repoPath: repo, harness: h, effort: "low", maxUsd: Number(maxUsd) } } });
    // Host-timeout canary: ping must answer while the ask runs.
    srv.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    const ping = await srv.waitFor((m) => m.id === 3, 15_000);
    if (ping) pass(phase, "mcp ping during call", {});
    else fail(phase, "mcp ping during call", { stderr: srv.stderrText().slice(-300) });
    const startedAt = Date.now();
    const call = await srv.waitFor((m) => m.id === 2, timeoutMs);
    const text = String(call?.result?.content?.[0]?.text ?? "");
    if (call && !call.result?.isError && text.includes("runId: ")) {
      pass(phase, "mcp ask result", { harness: h, ms: Date.now() - startedAt, runId: /runId: (\S+)/.exec(text)?.[1] });
    } else {
      fail(phase, "mcp ask result", { isError: call?.result?.isError, head: text.slice(0, 200), stderr: srv.stderrText().slice(-300) });
    }
  } finally {
    await srv.close();
  }
}

/** ACP serve smoke against a REAL doctor-ok harness. */
async function runAcpServePhase() {
  const phase = "phase11";
  const [h] = available(requestedHarnesses);
  if (!h) { skip(phase, "acp serve smoke", { reason: "no doctor-ok harness" }); return; }
  const repo = makeMathRepo(`${phase}-acp`, { addBug: true });
  const srv = stdioServer(["acp", "serve"], repo);
  try {
    srv.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const init = await srv.waitFor((m) => m.id === 1, 20_000);
    if (init?.result?.protocolVersion === 1 && Array.isArray(init.result?.authMethods)) pass(phase, "acp initialize", { authMethods: init.result.authMethods.length });
    else { fail(phase, "acp initialize", { init }); return; }
    srv.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: repo } });
    const sess = await srv.waitFor((m) => m.id === 2, 15_000);
    if (!sess?.result?.sessionId) { fail(phase, "acp session/new", { sess }); return; }
    pass(phase, "acp session/new", {});
    srv.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: sess.result.sessionId, prompt: "Answer exactly: 4. What is 2+2?", mode: "ask", harness: h, effort: "low", maxUsd: Number(maxUsd) } });
    const done = await srv.waitFor((m) => m.id === 3, timeoutMs);
    const chunk = srv.messages.find((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk");
    if (done?.result?.stopReason === "end_turn" && chunk) pass(phase, "acp prompt round-trip", { harness: h });
    else fail(phase, "acp prompt round-trip", { stopReason: done?.result?.stopReason, sawChunk: Boolean(chunk) });
  } finally {
    await srv.close();
  }
}

/** plugin lifecycle in a SCRATCH HOME (never the real one). */
function runPluginLifecyclePhase() {
  const phase = "phase12";
  const scratchHome = join(batteryRoot, "plugin-home");
  mkdirSync(scratchHome, { recursive: true });
  const scratchEnv = { ...env, HOME: scratchHome };
  const runPlugin = (args, name) => {
    const out = spawnSync(nodeBin, [cli, "plugin", ...args, "--json"], { env: scratchEnv, cwd: batteryRoot, encoding: "utf8", timeout: 120_000 });
    const stdout = out.stdout ?? "";
    let json = null;
    try { json = JSON.parse(stdout.slice(stdout.indexOf("{"))); } catch { /* non-JSON output is the failure the caller reports */ }
    writeFileSync(logPath(`${phase}-${name}`), redactSecrets(stdout + (out.stderr ?? "")));
    return { code: out.status, json };
  };
  const install = runPlugin(["install", "all"], "install");
  if (install.code === 0 && install.json?.ok) pass(phase, "plugin install all (scratch HOME)", { hosts: (install.json.results ?? []).map((r) => `${r.host}:${r.state}`) });
  else { fail(phase, "plugin install all (scratch HOME)", { exit: install.code, ok: install.json?.ok }); return; }
  const doctor = runPlugin(["doctor", "all"], "doctor");
  if (doctor.code === 0 && doctor.json?.ok) pass(phase, "plugin doctor all", {});
  else fail(phase, "plugin doctor all", { exit: doctor.code, ok: doctor.json?.ok });
  const uninstall = runPlugin(["uninstall", "all"], "uninstall");
  if (uninstall.code === 0 && uninstall.json?.ok) pass(phase, "plugin uninstall all", {});
  else fail(phase, "plugin uninstall all", { exit: uninstall.code, ok: uninstall.json?.ok });
  const cursorManifest = join(scratchHome, ".cursor", "plugins", "local", "claudexor", ".cursor-plugin", "plugin.json");
  if (!existsSync(cursorManifest)) pass(phase, "owned artifacts removed", {});
  else fail(phase, "owned artifacts removed", { survivor: cursorManifest });
}

function phase0(harnessPhasesRequested = true) {
  const phase = "phase0";
  const version = runCliText(["--version"], { name: "version" });
  evidence.version = version.stdout.trim();
  pass(phase, "cli version", { version: evidence.version });
  const doctor = runCliJson(["doctor"], { name: "doctor" });
  if (doctor.code !== 0 || !doctor.json?.harnesses) {
    fail(phase, "doctor", { exit: doctor.code, stdout: doctor.stdout, stderr: doctor.stderr, log: rel(doctor.log) });
    return false;
  }
  const byId = new Map(doctor.json.harnesses.map((h) => [h.id, h]));
  for (const h of requestedHarnesses) {
    const s = byId.get(h);
    if (s) evidence.harnessReports[h] = s;
    if (s?.status === "ok") {
      evidence.okHarnesses.push(h);
      pass(phase, `${h} doctor-ok`, { intents: s.enabledIntents ?? s.enabled_intents ?? [] });
    } else if (harnessPhasesRequested) {
      fail(phase, `${h} doctor-ok`, { status: s?.status ?? "missing", reasons: s?.reasons ?? [] });
    } else {
      // Only harness-INDEPENDENT phases were requested (e.g. PHASES=12):
      // a missing real harness is context, not a battery failure.
      skip(phase, `${h} doctor-ok`, { status: s?.status ?? "missing" });
    }
  }
  evidence.okHarnesses = [...new Set(evidence.okHarnesses)];
  const auth = runCliJson(["auth", "status"], { name: "auth-status" });
  if (auth.code === 0) pass(phase, "auth status", { harnesses: (auth.json?.harnesses ?? []).length });
  else fail(phase, "auth status", { exit: auth.code, log: rel(auth.log) });
  if (harnessPhasesRequested) {
    const models = runCliJson(["models", "--harness", requestedHarnesses.join(",")], { name: "models" });
    if (models.code === 0) pass(phase, "models", { harnesses: (models.json?.harnesses ?? []).map((h) => `${h.harnessId}:${h.source}`) });
    else fail(phase, "models", { exit: models.code, log: rel(models.log) });
  }
  return evidence.okHarnesses.length > 0;
}

const repos = {
  readonly: makeMathRepo("readonly", { addBug: true, multiplyBug: true, testMultiply: false }),
};
const state = { verifiedRuns: [], multiRace: null };

async function main() {
  process.stdout.write(`Claudexor real-harness battery\nroot=${batteryRoot}\nconfig=${configDir}\nharnesses=${requestedHarnesses.join(",")}\nmaxUsd=${maxUsd}\n\n`);
  // Phase 12 (plugin lifecycle in a scratch HOME) needs NO real harness —
  // the readiness gate applies only to harness-dependent phases.
  const harnessPhasesRequested =
    phaseFilter.length === 0 || phaseFilter.some((p) => p !== "phase12");
  const ready = phase0(harnessPhasesRequested);
  if (!ready && harnessPhasesRequested) {
    fail("phase0", "readiness gate", { reason: "no requested harness is doctor-ok; harness-dependent phases cannot proceed" });
  }
  if (ready) {
    if (phaseEnabled("phase1")) runReadonlyPhase();
    if (phaseEnabled("phase2")) runWritePhase();
    if (phaseEnabled("phase3")) runMultiWritePhase();
    if (phaseEnabled("phase4")) runLifecyclePhase();
    if (phaseEnabled("phase5")) runCreatePhase();
    if (phaseEnabled("phase6")) runVisionPhase();
    if (phaseEnabled("phase7")) runWebPhase();
    if (phaseEnabled("phase8")) runSpecPhase();
    if (phaseEnabled("phase9")) runOrchestratePhase();
    if (phaseEnabled("phase10")) await runMcpServePhase();
    if (phaseEnabled("phase11")) await runAcpServePhase();
  }
  if (phaseEnabled("phase12")) runPluginLifecyclePhase();
  runCliText(["daemon", "stop"], { name: "daemon-stop" });
  const summary = {
    generatedAt: new Date().toISOString(),
    evidence,
    counts: {
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      env: results.filter((r) => r.status === "env").length,
      skip: results.filter((r) => r.status === "skip").length,
    },
    results,
  };
  const jsonPath = join(resultsDir, "real-harness-battery.json");
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + "\n");
  const md = [
    `# Real-Harness Battery ${runId}`,
    "",
    `- root: \`${batteryRoot}\``,
    `- cli: \`${cli}\``,
    `- version: \`${evidence.version ?? "unknown"}\``,
    `- requested harnesses: ${requestedHarnesses.join(", ")}`,
    `- doctor-ok harnesses: ${evidence.okHarnesses.join(", ") || "(none)"}`,
    `- counts: PASS=${summary.counts.pass} FAIL=${summary.counts.fail} ENV=${summary.counts.env} SKIP=${summary.counts.skip}`,
    "",
    "| status | phase | name | detail |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.status} | ${r.phase} | ${r.name} | \`${JSON.stringify(r.detail).replaceAll("|", "\\|").slice(0, 500)}\` |`),
    "",
  ].join("\n");
  const mdPath = join(resultsDir, "real-harness-battery.md");
  writeFileSync(mdPath, md);
  process.stdout.write(`\nRESULT PASS=${summary.counts.pass} FAIL=${summary.counts.fail} ENV=${summary.counts.env} SKIP=${summary.counts.skip}\nreport=${jsonPath}\nsummary=${mdPath}\n`);
  process.exit(summary.counts.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  fail("fatal", "unhandled error", { error: err instanceof Error ? err.stack ?? err.message : String(err) });
  process.exit(1);
});
