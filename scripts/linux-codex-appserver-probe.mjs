#!/usr/bin/env node
/**
 * Credential-free Linux probe of the REAL Codex 0.162.1 sandbox as Claudexor's managed Codex
 * route reaches it, under the reported systemd hardening (plus loopback-only networking),
 * before, during and after Ubuntu noble's packaged `bwrap-userns-restrict` AppArmor profile,
 * with one conditional comparison against the prior minimal per-binary profile. Per phase:
 * `system` and `bundled` cells spawn one app-server through the built product's own launch
 * (command/exec under readonly, workspace-write and full access, then one scripted readonly
 * turn with `exec_command`, a project write and `view_image`); the `daemon` cell runs the real
 * built daemon, orchestrator and Codex adapter on one readonly ask (api_key route, labelled
 * dummy key; Codex's system config layer names the loopback scripted provider).
 *
 *   node scripts/linux-codex-appserver-probe.mjs run --out DIR --work DIR
 *   node scripts/linux-codex-appserver-probe.mjs restore --out DIR   (idempotent)
 *   node scripts/linux-codex-appserver-probe.mjs cell --spec FILE    (the unit's worker)
 *
 * Exit: 0 every planned cell ran with known capture and cleanup and every phase ended in its
 * starting host state, whatever the sandbox verdicts; 1 a harness defect; 2 unsupported host
 * or harness failure. See docs/evidence/linux-codex-appserver-probe.md.
 */
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISTRO_PROFILE } from "./lib/apparmor-profile-control.mjs";
import { CODEX_SYSTEM_CONFIG } from "./lib/codex-system-config-control.mjs";
import {
  freeLoopbackPort,
  installProviderRoute,
  phaseControls,
  removeProviderRoute,
  restoreRecorded,
} from "./lib/linux-codex-appserver-controls.mjs";
import {
  fetchDistroProfile,
  fileState,
  hostFacts,
  installCodex,
  json,
  readSysctls,
  recorded,
} from "./lib/linux-codex-appserver-host.mjs";
import {
  APPARMOR_PROFILES,
  CODEX_PIN,
  hostState,
  kernelAudit,
  kernelLogDiff,
  kernelLogPauseMs,
  PHASES,
  runInTransientUnit,
  runPhases,
  serviceGeometry,
  SYSTEM_PATH,
  UNIT_PROPERTIES_RECORDED,
  workerEndProblem,
} from "./lib/linux-codex-appserver-phases.mjs";
import {
  DIAGNOSTIC_CONTROL,
  exitCodeFor,
  LIMITATIONS,
  renderSummary,
  summarize,
} from "./lib/linux-codex-appserver-summary.mjs";
import { deadProxyEnv } from "./lib/linux-codex-appserver-cell.mjs";
import { loadProduct, runCellWorker } from "./lib/linux-codex-appserver-worker.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SELF), "..");
const USAGE =
  "usage: linux-codex-appserver-probe.mjs run --out DIR --work DIR | restore --out DIR\n";
/** A valid 1x1 PNG for the scripted view_image call. */
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const REQUIRED_DIST = [
  "packages/core/dist/index.js",
  "packages/harness-codex/dist/app-server-session.js",
  "packages/schema/dist/index.js",
  "packages/cli/dist/cli.js",
  "packages/cli/dist/claudexord.js",
  "packages/cli/dist/daemon-run.js",
];

function tryValue(read) {
  try {
    return read();
  } catch {
    return null;
  }
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Creates one cell's directories and fixture and returns its spec. The project holds
 * `research/input.txt` (32 random bytes as hex, learned by a model only through a tool output)
 * and `research/pixel.png`. A `daemon` cell also gets its own Claudexor data root and a
 * labelled dummy API key that selects the product's api_key route and is never sent. */
export function prepareCell({ phase, plan, prefix, user, root, providerPort, egress }) {
  rmSync(root, { recursive: true, force: true });
  const dir = (name) => join(root, name);
  for (const name of [
    "home/.claudexor",
    "codex-home",
    "tmp",
    "project/research",
    "outside",
    "full-control",
    "raw",
  ])
    mkdirSync(dir(name), { recursive: true });
  symlinkSync(prefix, join(dir("home/.claudexor"), "node"));
  const nonce = randomBytes(32).toString("hex");
  writeFileSync(join(dir("project/research"), "input.txt"), `${nonce}\n`);
  writeFileSync(join(dir("project/research"), "pixel.png"), PIXEL_PNG);
  const spec = {
    phase,
    cell: plan.id,
    kind: plan.kind,
    helper: plan.helper,
    repo: REPO,
    root,
    raw: dir("raw"),
    project: dir("project"),
    home: dir("home"),
    codexHome: dir("codex-home"),
    tmp: dir("tmp"),
    outside: dir("outside"),
    fullControl: dir("full-control"),
    nonce,
    nonceFile: join(dir("project/research"), "input.txt"),
    imageFile: join(dir("project/research"), "pixel.png"),
    marker: `cx-probe-marker-${randomBytes(8).toString("hex")}`,
    model: "claudexor-probe-scripted",
    codexVersion: CODEX_PIN.version,
    unitProperties: UNIT_PROPERTIES_RECORDED,
    egress,
    providerPort: plan.kind === "daemon" ? providerPort : 0,
    writeTargets: {
      readonly: join(dir("project/research"), "probe-readonly-write.txt"),
      project: join(dir("project"), "probe-workspace-write.txt"),
      outside: join(dir("outside"), "probe-outside-write.txt"),
      full: join(dir("full-control"), "probe-full-write.txt"),
    },
    env: {
      PATH: SYSTEM_PATH,
      HOME: dir("home"),
      USER: user,
      LOGNAME: user,
      LANG: "C.UTF-8",
      TMPDIR: dir("tmp"),
      ...deadProxyEnv(),
      ...(plan.kind === "daemon"
        ? {
            // The daemon refuses a data root whose parent is not canonical (macOS /var).
            CLAUDEXOR_CONFIG_DIR: join(realpathSync(root), "c"),
            CLAUDEXOR_DISABLE_STORED_SECRETS: "1",
            OPENAI_API_KEY: `cx337-fixture-dummy-key-not-a-credential-${randomBytes(8).toString("hex")}`,
          }
        : {}),
    },
  };
  json(join(root, "spec.json"), spec);
  return spec;
}

/** One cell as the main process of a disposable unit, with its evidence under `out`. */
export function runPlannedCell({ phase, plan, install, host, out, work, pauseMs, providerPort }) {
  const root = join(work, "cells", phase, plan.id);
  const evidencePath = join("phases", phase, "cells", plan.id);
  const evidence = join(out, evidencePath);
  const spec = prepareCell({
    phase,
    plan,
    prefix: install.prefix,
    user: host.user.name,
    root,
    providerPort,
    egress: { required: "blocked" },
  });
  const specFile = join(root, "spec.json");
  const dir = (name) => join(root, name);
  const unit = `cx-appserver-${phase}-${plan.id}-${randomBytes(3).toString("hex")}`;
  pause(pauseMs);
  const before = recorded(evidence, "dmesg-before", "sudo", ["-n", "dmesg"]);
  const unitRun = runInTransientUnit({
    run: (step, file, args, timeoutMs) =>
      recorded(evidence, `unit-${step}`, file, args, { cwd: spec.project, timeoutMs }),
    unit,
    user: host.user.name,
    group: host.user.group,
    workingDirectory: spec.project,
    readWritePath: root,
    command: [process.execPath, SELF, "cell", "--spec", specFile],
  });
  const kernel = kernelLogDiff(before, recorded(evidence, "dmesg-after", "sudo", ["-n", "dmesg"]));
  writeFileSync(
    join(evidence, "kernel-log-diff.txt"),
    kernel.lines.map((line) => `${line}\n`).join(""),
  );
  cpSync(dir("raw"), join(evidence, "raw"), { recursive: true });
  cpSync(specFile, join(evidence, "spec.json"));
  const obs = tryValue(() => JSON.parse(readFileSync(join(root, "observations.json"), "utf8")));
  if (obs) cpSync(join(root, "observations.json"), join(evidence, "observations.json"));
  const audit = kernelAudit(kernel.lines);
  const r = obs?.result;
  const cleanupProblems = [
    ...(r?.cleanup?.problems ?? []),
    ...(unitRun.settled ? [] : ["the transient unit was not shown stopped"]),
  ];
  // The worker's own end decides whether its observations are complete: an overflowed
  // (ENOBUFS), timed-out, signalled or failed worker leaves the cell unknown.
  const ended = workerEndProblem(unitRun.steps.start);
  const captureProblems = [
    ...(r?.capture?.problems ?? ["the cell worker left no observations"]),
    ...(ended ? [ended] : []),
  ];
  const landed = Object.entries(obs?.probes ?? {})
    .filter(([, p]) => p.verdict === "landed")
    .map(([id, p]) => `${id} landed at ${p.params.command.at(-1)}`);
  return {
    ...plan,
    verdict: obs ? "ran" : "worker_defect",
    evidence: evidencePath,
    unit: `${unit}.service`,
    unitSettled: unitRun.settled,
    worker: {
      status: unitRun.steps.start?.status ?? null,
      signal: unitRun.steps.start?.signal ?? null,
      error: unitRun.steps.start?.error ?? null,
    },
    serviceGeometry: obs ? serviceGeometry(obs, `${unit}.service`) : null,
    egress: obs?.egress ?? null,
    capture: { known: Boolean(r?.capture?.known) && !ended, problems: captureProblems },
    cleanup: {
      known: Boolean(r) && cleanupProblems.length === 0,
      problems: r ? cleanupProblems : ["the cell worker left no observations", ...cleanupProblems],
    },
    controls: obs?.controls ?? null,
    fixture: obs
      ? {
          unchanged: !obs.fixture.differences.length && !landed.length,
          differences: [...landed, ...obs.fixture.differences],
        }
      : null,
    probes: r?.probes ?? null,
    access: r?.access ?? null,
    turn: r?.turn ?? null,
    daemon: r?.daemon ?? null,
    startup: obs?.startup ?? null,
    sessionWarnings: obs?.sessionWarnings ?? null,
    helperEvidence: {
      pathBwrap: obs?.launch?.pathBwrap?.realpath ?? (plan.kind === "daemon" ? null : "none"),
      removedFromPath: obs?.launch?.removedFromPath ?? [],
      actualPath: r?.helperPath ?? null,
      executed: (r?.helpers ?? []).map(
        (entry) => entry.exe ?? `${entry.argv0} (${entry.exeError})`,
      ),
      sampler: obs?.executed
        ? { available: obs.executed.available, samples: obs.executed.samples ?? 0 }
        : null,
      codexAppServer: (r?.codexProcesses ?? []).map(({ exe, argv, sha256 }) => ({
        exe,
        argv,
        sha256,
        pinned: sha256 === CODEX_PIN.sha256.codex,
      })),
      inside: r?.identity ?? null,
      turnInside: r?.turn?.execIdentity ?? null,
      kernelExecpaths: [...new Set(audit.apparmor.map((group) => group.execpath).filter(Boolean))],
    },
    kernelLog: { state: kernel.state, newLines: kernel.lines.length, ...audit },
  };
}

function finish(out, summary) {
  summary.finishedAt = new Date().toISOString();
  json(join(out, "summary.json"), summary);
  const markdown = renderSummary(summary);
  writeFileSync(join(out, "summary.md"), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.stdout.write(markdown);
  process.exitCode = exitCodeFor(summary.outcome);
}

/** The longest Unix socket path a daemon cell gets; Linux allows 107 bytes. */
function longestDaemonSocket(work) {
  const phase = PHASES.map((p) => p.id).sort((a, b) => b.length - a.length)[0];
  return join(realpathSync(work), "cells", phase, "daemon", "c", "daemon", "claudexord.sock");
}

async function runProbe({ out, work }) {
  mkdirSync(out, { recursive: true });
  mkdirSync(work, { recursive: true });
  const linux = process.platform === "linux";
  const hostDir = join(out, "host");
  const summary = {
    schema: "claudexor-linux-codex-appserver-probe/2",
    diagnosticControl: DIAGNOSTIC_CONTROL,
    outcome: null,
    defects: [],
    codex: CODEX_PIN.version,
    startedAt: new Date().toISOString(),
    limitations: LIMITATIONS,
  };
  summary.ci = Object.fromEntries(
    ["GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF", "GITHUB_RUN_ID", "ImageOS", "ImageVersion"]
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  let route = null;
  try {
    const socket = longestDaemonSocket(work);
    summary.gaps = [
      ...(linux ? [] : [`platform is ${process.platform}, not linux`]),
      ...(process.arch === "x64" ? [] : [`architecture is ${process.arch}, not x64`]),
      ...(process.getuid?.() === 0
        ? ["running as root; the reported geometry is a normal user"]
        : []),
      ...(linux &&
      recorded(hostDir, "systemd-run-version", "systemd-run", ["--version"]).status === 0
        ? []
        : ["systemd-run is unavailable"]),
      ...(linux && recorded(hostDir, "sudo-n-true", "sudo", ["-n", "true"]).status === 0
        ? []
        : ["non-interactive sudo is unavailable"]),
      ...REQUIRED_DIST.filter((path) => !existsSync(join(REPO, path))).map(
        (path) => `built product missing: ${path} (run the build first)`,
      ),
      // Codex's workspace-write sandbox makes /tmp writable, so cells there cannot show an outside denial.
      ...(/^\/(private\/)?tmp(\/|$)/.test(realpathSync(work))
        ? [`--work ${work} lies under /tmp, a native workspace-write root`]
        : []),
      ...(Buffer.byteLength(socket) > 100
        ? [`--work ${work} is too long for the daemon socket ${socket}`]
        : []),
      ...(fileState(CODEX_SYSTEM_CONFIG).exists
        ? [`${CODEX_SYSTEM_CONFIG} already exists; the probe never replaces a host's Codex config`]
        : []),
    ];
    if (summary.gaps.length) {
      summary.outcome = "unsupported";
      return finish(out, summary);
    }
    const product = await loadProduct(REPO);
    const managedPath = product.harnessRuntimeEnv({
      PATH: SYSTEM_PATH,
      HOME: join(work, "path-home"),
    }).PATH;
    summary.host = hostFacts(hostDir, managedPath);
    const install = await installCodex(join(work, "codex-prefix"), join(out, "codex"));
    summary.codexInstall = install.receipt;
    const distro = await fetchDistroProfile(join(out, "distro-profile"));
    summary.distroProfile = { ...distro.receipt, names: distro.names };
    const pauseMs = kernelLogPauseMs(summary.host.sysctl);
    const providerPort = await freeLoopbackPort();
    route = installProviderRoute({ out, port: providerPort });
    summary.providerRoute = { ...route, restore: null };
    Object.assign(
      summary,
      runPhases({
        controls: phaseControls({ out, distro, selectedBwrap: summary.host.selectedBwrap }),
        snapshot: (phase, stage) => {
          const dir = join(out, "phases", phase, `host-${stage}`);
          const state = hostState(
            readSysctls(),
            recorded(dir, "apparmor-profiles", "sudo", ["-n", "cat", APPARMOR_PROFILES]),
            fileState(DISTRO_PROFILE.installPath),
          );
          json(join(dir, "state.json"), state);
          return state;
        },
        runCell: (phase, plan) =>
          runPlannedCell({
            phase,
            plan,
            install,
            host: summary.host,
            out,
            work,
            pauseMs,
            providerPort,
          }),
      }),
    );
  } catch (error) {
    summary.outcome = "harness_error";
    summary.error = String(error?.stack ?? error);
  } finally {
    if (route) summary.providerRoute.restore = removeProviderRoute({ out, applied: route });
  }
  if (summary.outcome !== "harness_error")
    Object.assign(summary, summarize(summary.phases, summary.cells, summary.providerRoute));
  return finish(out, summary);
}

/** Undoes every recorded host change again; a no-op once restored. Exit 0 only when every
 * read-back matches its recorded start. */
function runRestore({ out }) {
  const results = restoreRecorded(out);
  const lines = Object.entries(results).map(([name, result]) => ({
    name,
    restored: result.restored,
    gaps: result.gaps,
    steps: result.steps.map((step) => step.step),
  }));
  process.stdout.write(
    lines.length
      ? `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
      : "no host change was recorded; nothing to restore\n",
  );
  if (lines.some((line) => !line.restored)) process.exitCode = 1;
}

function parseOptions(argv, required) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`bad argument ${flag}`);
    options[flag.slice(2)] = resolve(value);
  }
  for (const name of required) if (!options[name]) throw new Error(`--${name} is required`);
  return options;
}

const [mode, ...rest] = process.argv.slice(2);
if (tryValue(() => realpathSync(process.argv[1])) !== SELF) {
  // Imported: no command runs.
} else {
  try {
    if (mode === "cell" && rest[0] === "--spec" && rest[1]) {
      // The worker has recorded any leftover process by now; a lingering handle must not keep
      // the unit alive until RuntimeMaxSec, so it exits explicitly (the unit stop ends the rest).
      const { capture, cleanup, access, turn, daemon } = (await runCellWorker(rest[1])).result;
      const verdicts = daemon
        ? { read: daemon.read, viewImage: daemon.viewImage, write: daemon.write }
        : { access, exec: turn?.exec, viewImage: turn?.viewImage, write: turn?.write };
      process.stdout.write(`${JSON.stringify({ capture, cleanup, ...verdicts })}\n`);
      process.exit(0);
    } else if (mode === "run") await runProbe(parseOptions(rest, ["out", "work"]));
    else if (mode === "restore") runRestore(parseOptions(rest, ["out"]));
    else {
      process.stderr.write(USAGE);
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n${USAGE}`);
    if (mode === "cell") process.exit(2);
    process.exitCode = 2;
  }
}
