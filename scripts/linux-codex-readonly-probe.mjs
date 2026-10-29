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
 * The four cells run in three phases on the disposable runner: the host as
 * provisioned, then with an AppArmor profile for /usr/bin/bwrap granting
 * `userns`, then with kernel.apparmor_restrict_unprivileged_userns=0. Each
 * control phase reverts its change and verifies the host state before the next
 * one starts, and a cell whose processes are not shown to have ended stops the
 * comparison. They are diagnostic controls, never recommended host settings.
 *
 *   node scripts/linux-codex-readonly-probe.mjs run --out DIR --work DIR
 *
 * `cell --spec FILE` is the internal per-geometry worker. Exit codes: 0 every
 * planned cell ran with its evidence and every phase ended in its starting host
 * state, whatever the sandbox verdicts; 1 a harness defect (a cell not run,
 * missing evidence, an unverified change or restore, a stopped comparison); 2
 * unsupported host or harness failure. See docs/evidence/linux-codex-readonly-probe.md.
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
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPARMOR_PARSER,
  APPARMOR_PROFILES,
  BWRAP_PROFILE,
  CODEX_PIN,
  DIAGNOSTIC_CONTROL,
  IDENTITY_SCRIPT,
  LIMITATIONS,
  RECORDED_SYSCTLS,
  SANDBOX_RUN_TIMEOUT_MS,
  STRACE_ARGS,
  SYSCTL,
  SYSTEM_BWRAP,
  SYSTEM_PATH,
  TARGET_TRIPLE,
  UNIT_OUTER_TIMEOUT_MS,
  UNIT_PROPERTIES_RECORDED,
  WRITE_SCRIPT,
  classifyCell,
  digestMismatches,
  exitCodeFor,
  hostState,
  kernelAudit,
  kernelLogDiff,
  kernelLogPauseMs,
  parseKeyValues,
  preconditionGaps,
  probeEnds,
  renderSummary,
  runInTransientUnit,
  runPhases,
  serviceGeometry,
  summarize,
  systemHelper,
  tracedHelper,
  unsettledEnd,
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

function readSysctls() {
  return Object.fromEntries(
    RECORDED_SYSCTLS.map((name) => [
      name,
      tryValue(() => readFileSync(`/proc/sys/${name.replaceAll(".", "/")}`, "utf8").trim()),
    ]),
  );
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  const codex = { cwd: spec.project, env, timeoutMs: SANDBOX_RUN_TIMEOUT_MS };
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
    launch: null,
    probes: {},
    trace: null,
    stopped: null,
  };
  // A run that the time limit or a signal ended may have left processes
  // running, so the cell starts nothing after it and names the runs it skipped.
  const step = (name, start) => {
    if (observations.stopped) {
      observations.stopped.skipped.push(name);
      return null;
    }
    const run = start();
    const end = unsettledEnd(run);
    if (end) observations.stopped = { after: name, ended: end, skipped: [] };
    return run;
  };
  // A sandbox result means something only if Codex launches in this very environment.
  observations.launch = step("launch", () =>
    recorded(spec.raw, "launch", spec.node, [spec.launcher, "--version"], codex),
  );
  // Untraced runs decide the verdict; the traced run below is diagnostic only.
  observations.probes.read = step("read", () => sandbox("read", ["/bin/cat", spec.nonceFile]));
  observations.probes.identity = step("identity", () =>
    sandbox("identity", ["/bin/sh", "-c", IDENTITY_SCRIPT]),
  );
  const write = step("write", () =>
    sandbox("write", ["/bin/sh", "-c", WRITE_SCRIPT, "cx337-write", "cx337", spec.writeTarget]),
  );
  if (write) {
    write.targetExists = existsSync(spec.writeTarget);
    if (write.targetExists) {
      write.targetContent = tryValue(() => readFileSync(spec.writeTarget, "utf8"));
      rmSync(spec.writeTarget, { force: true });
    }
  }
  observations.probes.write = write;
  if (spec.strace)
    observations.trace = step("trace", () =>
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
      ),
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
  run("apparmor-profiles", "sudo", ["-n", "cat", APPARMOR_PROFILES]);
  run("apparmor-d", "ls", ["-la", "/etc/apparmor.d"]);
  run("control-tools", "ls", ["-l", APPARMOR_PARSER, SYSCTL]);
  const bwrap = onPath("bwrap");
  if (bwrap) run("system-bwrap-help", bwrap, ["--help"]);
  return {
    os: parseKeyValues(read("/etc/os-release")).PRETTY_NAME?.replace(/^"|"$/g, "") ?? null,
    kernel: run("uname-r", "uname", ["-r"]).stdout.trim() || null,
    sysctl: readSysctls(),
    apparmorEnabled: read("/sys/module/apparmor/parameters/enabled"),
    systemBwrap: bwrap
      ? {
          ...systemHelper(
            bwrap,
            tryValue(() => realpathSync(bwrap)),
          ),
          version: run("system-bwrap-version", bwrap, ["--version"]).stdout.trim(),
        }
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

/** Runs one planned cell and returns its record. `privileged` runs and records
 * the cell's `sudo` commands as `recorded` does: the kernel log reads and the
 * transient unit's steps. The tests inject it; the cell worker always runs. */
export function runPlannedCell({
  phase,
  plan,
  install,
  host,
  out,
  work,
  pauseMs,
  privileged = recorded,
}) {
  const root = join(work, phase, plan.id);
  const evidencePath = join("phases", phase, "cells", plan.id);
  const evidence = join(out, evidencePath);
  rmSync(root, { recursive: true, force: true });
  const dir = (name) => join(root, name);
  for (const name of ["home", "codex-home", "tmp", "project", "path-without-bwrap", "raw"])
    mkdirSync(dir(name), { recursive: true });
  const nonce = `cx337-${randomBytes(16).toString("hex")}`;
  const unit = `cx337-${phase}-${plan.id}-${randomBytes(3).toString("hex")}`;
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
  // A fresh printk rate-limit window, so the previous cell's audit lines cannot use up this one's.
  pause(pauseMs);
  const before = privileged(evidence, "dmesg-before", "sudo", ["-n", "dmesg"]);
  let unitSettled = null;
  let workerRun;
  if (plan.geometry === "direct") {
    workerRun = recorded(evidence, "worker", worker[0], worker.slice(1), {
      cwd: spec.project,
      timeoutMs: UNIT_OUTER_TIMEOUT_MS,
    });
  } else {
    const unitRun = runInTransientUnit({
      run: (step, file, args, timeoutMs) =>
        privileged(evidence, `unit-${step}`, file, args, { cwd: spec.project, timeoutMs }),
      unit,
      user: host.user.name,
      group: host.user.group,
      workingDirectory: spec.project,
      readWritePath: root,
      command: worker,
    });
    unitSettled = unitRun.settled;
    workerRun = unitRun.steps.start;
  }
  const after = privileged(evidence, "dmesg-after", "sudo", ["-n", "dmesg"]);
  const kernel = kernelLogDiff(before, after);
  writeFileSync(
    join(evidence, "kernel-log-diff.txt"),
    kernel.lines.map((line) => `${line}\n`).join(""),
  );
  cpSync(dir("raw"), join(evidence, "raw"), { recursive: true });
  cpSync(specFile, join(evidence, "spec.json"));
  const observationsFile = join(root, "observations.json");
  const observations = tryValue(() => JSON.parse(readFileSync(observationsFile, "utf8")));
  if (observations) cpSync(observationsFile, join(evidence, "observations.json"));
  const classified = observations
    ? classifyCell(nonce, observations)
    : { verdict: "worker_defect", reason: "the cell worker left no observations", facts: null };
  const identity = observations?.probes?.identity;
  const trace = spec.strace
    ? tryValue(() => readFileSync(join(dir("raw"), "strace.txt"), "utf8"))
    : null;
  const bundledBwrap = [install.paths.bwrap, tryValue(() => realpathSync(install.paths.bwrap))];
  const service = plan.geometry === "service";
  return {
    ...plan,
    ...classified,
    evidence: evidencePath,
    worker: {
      status: workerRun?.status ?? null,
      signal: workerRun?.signal ?? null,
      error: workerRun?.error ?? null,
    },
    unit: service ? `${unit}.service` : null,
    serviceGeometry: service ? serviceGeometry(observations, `${unit}.service`) : null,
    unitSettled,
    probes: probeEnds(observations),
    stopped: observations?.stopped ?? null,
    sandboxLabel: identity?.status === 0 ? parseKeyValues(identity.stdout).apparmor || null : null,
    trace: {
      expected: Boolean(spec.strace),
      recorded: Boolean(trace),
      helper: tracedHelper(trace, {
        systemBwrap: host.systemBwrap?.path ?? SYSTEM_BWRAP,
        bundledBwrap,
      }),
    },
    kernelLog: { state: kernel.state, newLines: kernel.lines.length, ...kernelAudit(kernel.lines) },
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
    schema: "claudexor-linux-codex-readonly-probe/5",
    diagnosticControl: DIAGNOSTIC_CONTROL,
    outcome: null,
    defects: [],
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
    const profileFile = join(out, "phases", "apparmor-bwrap-profile", "bwrap.apparmor");
    mkdirSync(dirname(profileFile), { recursive: true });
    writeFileSync(profileFile, BWRAP_PROFILE);
    const pauseMs = kernelLogPauseMs(summary.host.sysctl);
    summary.phases = [];
    summary.cells = [];
    runPhases({
      profileFile,
      systemBwrap: summary.host.systemBwrap,
      phases: summary.phases,
      cells: summary.cells,
      snapshot: (phase, stage) => {
        const dir = join(out, "phases", phase, `host-${stage}`);
        const sysctl = readSysctls();
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "sysctl.json"), `${JSON.stringify(sysctl, null, 2)}\n`);
        const profiles = recorded(dir, "apparmor-profiles", "sudo", [
          "-n",
          "cat",
          APPARMOR_PROFILES,
        ]);
        return hostState(sysctl, profiles);
      },
      command: (phase, step, args) => recorded(join(out, "phases", phase), step, "sudo", args),
      runCell: (phase, plan) =>
        runPlannedCell({ phase, plan, install, host: summary.host, out, work, pauseMs }),
    });
    Object.assign(summary, summarize(summary.phases, summary.cells));
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
if (tryValue(() => realpathSync(process.argv[1])) !== SELF) {
  // Imported, as the tests import runPlannedCell: no command runs.
} else if (mode === "cell" && rest[0] === "--spec" && rest[1]) {
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
