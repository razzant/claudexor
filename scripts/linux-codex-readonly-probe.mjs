#!/usr/bin/env node
/**
 * Credential-free Linux probe for claudexor#337. Runs the REAL pinned Codex
 * 0.162.1 `codex sandbox -- CMD` (default read-only policy, Linux bubblewrap
 * helper) as the same normal user, directly and inside a disposable systemd
 * unit with the reported hardening, once with Codex's PATH-selected bwrap and
 * once with its bundled one. It never logs in, starts no model turn and hands
 * Codex no credential. Every process it starts leaves complete argv, env,
 * stdout and stderr files beside a small factual summary.
 *
 *   node scripts/linux-codex-readonly-probe.mjs run --out DIR --work DIR
 *
 * `cell --spec FILE` is the internal per-geometry worker. Exit codes: 0 every
 * cell proven in its established geometry; 1 otherwise (an experiment result);
 * 2 unsupported host or harness failure (no verdict).
 * See docs/evidence/linux-codex-readonly-probe.md.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_PIN,
  IDENTITY_SCRIPT,
  LIMITATIONS,
  RECORDED_SYSCTLS,
  STRACE_ARGS,
  SYSTEM_PATH,
  TARGET_TRIPLE,
  UNIT_OUTER_TIMEOUT_MS,
  UNIT_PROPERTIES_RECORDED,
  WRITE_SCRIPT,
  cellPlan,
  classifyCell,
  digestMismatches,
  exitCodeFor,
  kernelLogState,
  parseKeyValues,
  preconditionGaps,
  renderSummary,
  runInTransientUnit,
  serviceGeometry,
  summarize,
} from "./lib/linux-codex-readonly-probe.mjs";

const SELF = fileURLToPath(import.meta.url);
const TOOL_ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
const USAGE = "usage: linux-codex-readonly-probe.mjs run --out DIR --work DIR\n";

/** Runs a process and keeps its complete argv, env, stdout and stderr as
 * `<dir>/<name>.{json,stdout,stderr}`; returns the record with decoded output. */
function recorded(dir, name, file, args, { cwd = "/", env = TOOL_ENV, timeoutMs = 120_000 } = {}) {
  const started = Date.now();
  const result = spawnSync(file, args, {
    cwd,
    env,
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  const record = {
    argv: [file, ...args],
    cwd,
    env,
    timeoutMs,
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error.code ?? result.error.message) : null,
    ms: Date.now() - started,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(dir, `${name}.stdout`), result.stdout ?? "");
  writeFileSync(join(dir, `${name}.stderr`), result.stderr ?? "");
  return { ...record, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function tryValue(read) {
  try {
    return read();
  } catch {
    return null;
  }
}

// ---- cell worker: runs inside the geometry under test ----

/** The worker's own kernel view, copied raw, plus the few facts verdicts use. */
function processFacts(raw) {
  const copy = (name, path) => {
    const bytes = tryValue(() => readFileSync(path));
    if (bytes) writeFileSync(join(raw, name), bytes);
    return bytes ? String(bytes) : null;
  };
  const status = copy("proc-self-status.txt", "/proc/self/status") ?? "";
  const cgroup = copy("proc-self-cgroup.txt", "/proc/self/cgroup") ?? "";
  copy("proc-self-mountinfo.txt", "/proc/self/mountinfo");
  const apparmor =
    copy("proc-self-attr-apparmor-current.txt", "/proc/self/attr/apparmor/current") ??
    copy("proc-self-attr-current.txt", "/proc/self/attr/current");
  const statusFacts = {};
  for (const line of status.split("\n")) {
    const match = /^(NoNewPrivs|Seccomp|CapEff|CapBnd|CapAmb):\s*(.*)$/.exec(line);
    if (match) statusFacts[match[1]] = match[2].trim();
  }
  return {
    uid: process.getuid(),
    gid: process.getgid(),
    groups: process.getgroups(),
    namespaces: Object.fromEntries(
      ["user", "mnt", "net", "pid"].map((ns) => [
        ns,
        tryValue(() => readlinkSync(`/proc/self/ns/${ns}`)),
      ]),
    ),
    status: statusFacts,
    apparmor: apparmor?.trim() ?? null,
    cgroupUnit:
      cgroup
        .split("\n")
        .map((line) => line.split("/").at(-1))
        .find((name) => /\.(?:service|scope)$/.test(name ?? "")) ?? null,
  };
}

function controls(spec) {
  const read = tryValue(() => readFileSync(spec.nonceFile, "utf8").trim());
  try {
    writeFileSync(spec.controlTarget, "cx337-control\n", { flag: "wx" });
    const back = readFileSync(spec.controlTarget, "utf8");
    unlinkSync(spec.controlTarget);
    return { read, write: { ok: back === "cx337-control\n" } };
  } catch (error) {
    return { read, write: { ok: false, error: String(error?.code ?? error) } };
  }
}

function runCell(specFile) {
  const spec = JSON.parse(readFileSync(specFile, "utf8"));
  const env = {
    PATH: spec.path,
    HOME: spec.home,
    CODEX_HOME: spec.codexHome,
    TMPDIR: spec.tmp,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
  };
  // Four Codex runs per cell at most 60 s each keep a hung cell inside the job budget.
  const codex = { cwd: spec.project, env, timeoutMs: 60_000 };
  const codexSandbox = [spec.launcher, "sandbox", "--"];
  const sandbox = (name, command) =>
    recorded(spec.raw, name, spec.node, [...codexSandbox, ...command], codex);
  const outside = processFacts(spec.raw);
  const unitShow = outside.cgroupUnit
    ? recorded(spec.raw, "unit-show", "systemctl", [
        "show",
        outside.cgroupUnit,
        "--no-pager",
        `--property=${UNIT_PROPERTIES_RECORDED.join(",")}`,
      ])
    : null;
  const observations = {
    outside,
    unit: {
      name: outside.cgroupUnit,
      properties: unitShow ? parseKeyValues(unitShow.stdout) : null,
    },
    controls: controls(spec),
    probes: {},
  };
  // Untraced runs decide the verdict; the traced run below is diagnostic only.
  observations.probes.read = sandbox("read", ["/bin/cat", spec.nonceFile]);
  observations.probes.identity = sandbox("identity", ["/bin/sh", "-c", IDENTITY_SCRIPT]);
  const write = sandbox("write", [
    "/bin/sh",
    "-c",
    WRITE_SCRIPT,
    "cx337-write",
    "cx337",
    spec.writeTarget,
  ]);
  write.targetExists = existsSync(spec.writeTarget);
  if (write.targetExists) {
    write.targetContent = tryValue(() => readFileSync(spec.writeTarget, "utf8"));
    rmSync(spec.writeTarget, { force: true });
  }
  observations.probes.write = write;
  if (spec.strace)
    recorded(
      spec.raw,
      "strace-read",
      spec.strace,
      [
        ...STRACE_ARGS,
        "-o",
        join(spec.raw, "strace.txt"),
        "--",
        spec.node,
        ...codexSandbox,
        "/bin/cat",
        spec.nonceFile,
      ],
      codex,
    );
  writeFileSync(join(spec.root, "observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
}

// ---- orchestrator: host facts, exact Codex bytes, cells, evidence ----

function hostFacts(dir) {
  const run = (name, file, args) => recorded(dir, name, file, args);
  const read = (path) => tryValue(() => readFileSync(path, "utf8").trim());
  const onPath = (name) =>
    SYSTEM_PATH.split(":")
      .map((entry) => join(entry, name))
      .find((path) => existsSync(path)) ?? null;
  run("os-release", "cat", ["/etc/os-release"]);
  run("uname", "uname", ["-a"]);
  run("id", "id", []);
  run("packages", "dpkg-query", ["-W", "bubblewrap", "strace", "systemd", "apparmor"]);
  run("systemd-version", "systemctl", ["--version"]);
  run("apparmor-profiles", "sudo", ["-n", "cat", "/sys/kernel/security/apparmor/profiles"]);
  run("apparmor-d", "ls", ["-la", "/etc/apparmor.d"]);
  const bwrap = onPath("bwrap");
  if (bwrap) run("system-bwrap-help", bwrap, ["--help"]);
  return {
    os: parseKeyValues(read("/etc/os-release")).PRETTY_NAME?.replace(/^"|"$/g, "") ?? null,
    kernel: run("uname-r", "uname", ["-r"]).stdout.trim() || null,
    sysctl: Object.fromEntries(
      RECORDED_SYSCTLS.map((name) => [name, read(`/proc/sys/${name.replaceAll(".", "/")}`)]),
    ),
    apparmorEnabled: read("/sys/module/apparmor/parameters/enabled"),
    systemBwrap: bwrap
      ? { path: bwrap, version: run("system-bwrap-version", bwrap, ["--version"]).stdout.trim() }
      : null,
    strace: onPath("strace"),
    user: {
      name: run("id-un", "id", ["-un"]).stdout.trim(),
      group: run("id-gn", "id", ["-gn"]).stdout.trim(),
    },
  };
}

/** The npm global layout the managed installer produces, from verified bytes. */
async function installCodex(work, dir) {
  const root = join(work, `codex-${CODEX_PIN.version}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pkg = join(root, "lib", "node_modules", "@openai", "codex");
  const platformPkg = join(pkg, "node_modules", "@openai", "codex-linux-x64");
  const receipt = { version: CODEX_PIN.version, tarballs: [] };
  const keep = () =>
    writeFileSync(join(dir, "install.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  for (const [name, tarball, target] of [
    ["main", CODEX_PIN.main, pkg],
    ["linux-x64", CODEX_PIN.linux, platformPkg],
  ]) {
    const response = await fetch(tarball.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`GET ${tarball.url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    receipt.tarballs.push({
      url: tarball.url,
      bytes: bytes.length,
      integrity,
      pinned: tarball.integrity,
    });
    keep();
    if (integrity !== tarball.integrity) throw new Error(`${tarball.url} integrity is not pinned`);
    const archive = join(root, `${name}.tgz`);
    mkdirSync(target, { recursive: true });
    writeFileSync(archive, bytes);
    const tar = ["-xzf", archive, "-C", target, "--strip-components=1", "--no-same-owner"];
    const extracted = recorded(dir, `tar-${name}`, "tar", tar, { timeoutMs: 300_000 });
    if (extracted.status !== 0) throw new Error(`tar ${name} exited ${extracted.status}`);
    rmSync(archive);
  }
  const vendor = join(platformPkg, "vendor", TARGET_TRIPLE);
  const paths = {
    launcher: join(pkg, "bin", "codex.js"),
    codex: join(vendor, "bin", "codex"),
    bwrap: join(vendor, "codex-resources", "bwrap"),
  };
  receipt.paths = paths;
  receipt.sha256 = Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [
      name,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
  );
  keep();
  const mismatches = digestMismatches(receipt.sha256);
  if (mismatches.length > 0) throw new Error(mismatches.join("; "));
  const scratch = join(root, "version-home");
  mkdirSync(scratch);
  const scratchEnv = {
    PATH: SYSTEM_PATH,
    HOME: scratch,
    CODEX_HOME: scratch,
    TMPDIR: scratch,
    LANG: "C.UTF-8",
  };
  receipt.versionOutput = recorded(
    dir,
    "codex-version",
    process.execPath,
    [paths.launcher, "--version"],
    { cwd: scratch, env: scratchEnv },
  ).stdout.trim();
  recorded(dir, "bundled-bwrap-version", paths.bwrap, ["--version"]);
  keep();
  return { paths, receipt };
}

function runPlannedCell(plan, install, host, out, work) {
  const root = join(work, "cells", plan.id);
  const evidence = join(out, "cells", plan.id);
  rmSync(root, { recursive: true, force: true });
  const dir = (name) => join(root, name);
  for (const name of ["home", "codex-home", "tmp", "project", "path-without-bwrap", "raw"])
    mkdirSync(dir(name), { recursive: true });
  const nonce = `cx337-${randomBytes(16).toString("hex")}`;
  const unit = `cx337-${plan.id}-${randomBytes(3).toString("hex")}`;
  const spec = {
    node: process.execPath,
    launcher: install.paths.launcher,
    root,
    raw: dir("raw"),
    project: dir("project"),
    home: dir("home"),
    codexHome: dir("codex-home"),
    tmp: dir("tmp"),
    path: plan.helper === "system" ? SYSTEM_PATH : dir("path-without-bwrap"),
    nonceFile: join(dir("project"), "cx337-nonce.txt"),
    writeTarget: join(dir("project"), "cx337-write-target.txt"),
    controlTarget: join(dir("project"), "cx337-control.txt"),
    strace: host.strace,
  };
  writeFileSync(spec.nonceFile, `${nonce}\n`);
  const specFile = join(root, "spec.json");
  writeFileSync(specFile, `${JSON.stringify(spec, null, 2)}\n`);
  const worker = [process.execPath, SELF, "cell", "--spec", specFile];
  const before = recorded(evidence, "dmesg-before", "sudo", ["-n", "dmesg"]);
  let unitSettled = null;
  if (plan.geometry === "direct") {
    recorded(evidence, "worker", worker[0], worker.slice(1), {
      cwd: spec.project,
      timeoutMs: UNIT_OUTER_TIMEOUT_MS,
    });
  } else {
    unitSettled = runInTransientUnit({
      run: (step, file, args, timeoutMs) =>
        recorded(evidence, `unit-${step}`, file, args, { cwd: spec.project, timeoutMs }),
      unit,
      user: host.user.name,
      group: host.user.group,
      workingDirectory: spec.project,
      readWritePath: root,
      command: worker,
    }).settled;
  }
  const after = recorded(evidence, "dmesg-after", "sudo", ["-n", "dmesg"]);
  cpSync(dir("raw"), join(evidence, "raw"), { recursive: true });
  cpSync(specFile, join(evidence, "spec.json"));
  const observationsFile = join(root, "observations.json");
  const observations = tryValue(() => JSON.parse(readFileSync(observationsFile, "utf8")));
  if (observations) cpSync(observationsFile, join(evidence, "observations.json"));
  const classified = observations
    ? classifyCell(nonce, observations)
    : { verdict: "inconclusive", reason: "the cell worker left no observations", facts: null };
  const service = plan.geometry === "service";
  return {
    ...plan,
    ...classified,
    unit: service ? `${unit}.service` : null,
    serviceGeometry: service ? serviceGeometry(observations, `${unit}.service`) : null,
    unitSettled,
    kernelLog: kernelLogState(before, after),
  };
}

function finish(out, summary) {
  summary.finishedAt = new Date().toISOString();
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const markdown = renderSummary(summary);
  writeFileSync(join(out, "summary.md"), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.stdout.write(markdown);
  process.exitCode = exitCodeFor(summary.outcome);
}

async function runProbe({ out, work }) {
  mkdirSync(out, { recursive: true });
  mkdirSync(work, { recursive: true });
  const linux = process.platform === "linux";
  const hostDir = join(out, "host");
  const summary = {
    schema: "claudexor-linux-codex-readonly-probe/2",
    codex: CODEX_PIN.version,
    startedAt: new Date().toISOString(),
    ci: Object.fromEntries(
      ["GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF", "GITHUB_RUN_ID", "ImageOS", "ImageVersion"]
        .filter((name) => process.env[name])
        .map((name) => [name, process.env[name]]),
    ),
    limitations: LIMITATIONS,
  };
  try {
    summary.gaps = preconditionGaps({
      platform: process.platform,
      arch: process.arch,
      uid: process.getuid?.(),
      systemdRun:
        linux &&
        recorded(hostDir, "systemd-run-version", "systemd-run", ["--version"]).status === 0,
      sudo: linux && recorded(hostDir, "sudo-n-true", "sudo", ["-n", "true"]).status === 0,
    });
    if (summary.gaps.length > 0) {
      summary.outcome = "unsupported";
      return finish(out, summary);
    }
    summary.host = hostFacts(hostDir);
    const install = await installCodex(work, join(out, "codex"));
    summary.codexInstall = {
      versionOutput: install.receipt.versionOutput,
      sha256: install.receipt.sha256,
    };
    summary.cells = cellPlan().map((plan) =>
      runPlannedCell(plan, install, summary.host, out, work),
    );
    Object.assign(summary, summarize(summary.cells));
  } catch (error) {
    summary.outcome = "harness_error";
    summary.error = String(error?.stack ?? error);
  }
  return finish(out, summary);
}

function parseRunArgs(argv) {
  const options = { out: null, work: null };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--out") options.out = resolve(value);
    else if (flag === "--work") options.work = resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.out || !options.work) throw new Error("--out and --work are required");
  return options;
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "cell" && rest[0] === "--spec" && rest[1]) {
  runCell(rest[1]);
} else if (mode === "run") {
  let options = null;
  try {
    options = parseRunArgs(rest);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}`);
    process.exitCode = 2;
  }
  if (options) await runProbe(options);
} else {
  process.stderr.write(USAGE);
  process.exitCode = 2;
}
