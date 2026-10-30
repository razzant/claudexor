/** The cell worker of the Linux Codex app-server probe: the main process of one disposable
 * unit. It replaces its environment with the cell's recorded one, starts the scripted
 * loopback provider, spawns ONE real Codex app-server through the built product's own
 * `spawnProcess` and launch composition, asks it the cell's questions, stops it, and writes
 * observations plus complete raw streams. Classification is pure and lives in
 * linux-codex-appserver-cell.mjs; the orchestrator decides what a cell means. */
import { createHash } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createAppServerClient } from "./codex-appserver-client.mjs";
import { providerConfigToml, startScriptedProvider } from "./scripted-responses-provider.mjs";
import {
  accessVerdicts,
  classifyDaemonRun,
  classifyProbe,
  classifyTurn,
  commandProbes,
  COMMAND_TIMEOUT_MS,
  deadProxyEnv,
  managedLaunch,
  modelExecCommand,
  outsideTargetGaps,
  parseKeyValues,
  startupWarnings,
} from "./linux-codex-appserver-cell.mjs";
import { runDaemonCell } from "./linux-codex-appserver-daemon.mjs";
import {
  egressProbe,
  helperExecutions,
  startProcessSampler,
} from "./linux-codex-appserver-observe.mjs";

const TURN_TIMEOUT_MS = 120_000;
const EXIT_WAIT_MS = 15_000;

function tryValue(read) {
  try {
    return read();
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isExecutableFile(path) {
  return Boolean(
    tryValue(() => statSync(path).isFile() && (accessSync(path, constants.X_OK), true)),
  );
}

/** The built product exports the managed Codex route uses, loaded from this checkout. */
export async function loadProduct(repo) {
  const load = (path) => import(pathToFileURL(join(repo, path)).href);
  const [core, auth, toml, session, attachments, cli, util, schema] = await Promise.all([
    load("packages/core/dist/index.js"),
    load("packages/harness-codex/dist/auth.js"),
    load("packages/harness-codex/dist/toml.js"),
    load("packages/harness-codex/dist/app-server-session.js"),
    load("packages/harness-codex/dist/attachments.js"),
    load("packages/harness-codex/dist/missing-cli.js"),
    load("packages/util/dist/index.js"),
    load("packages/schema/dist/index.js"),
  ]);
  return {
    spawnProcess: core.spawnProcess,
    providerScrubEnv: core.providerScrubEnv,
    harnessRuntimeEnv: core.harnessRuntimeEnv,
    CODEX_FILE_AUTH_ARGS: auth.CODEX_FILE_AUTH_ARGS,
    CODEX_PROJECT_DOC_FALLBACK_ARGS: auth.CODEX_PROJECT_DOC_FALLBACK_ARGS,
    codexConfigHasNodeRepl: toml.codexConfigHasNodeRepl,
    codexAppServerThreadRequest: session.codexAppServerThreadRequest,
    codexTurnParams: session.codexTurnParams,
    codexAppServerInput: attachments.codexAppServerInput,
    BIN: cli.BIN,
    CLAUDEXOR_VERSION: util.CLAUDEXOR_VERSION,
    HarnessRunSpec: schema.HarnessRunSpec,
  };
}

/** The worker's own kernel view (copied raw) and the facts the verdicts compare against. */
function processFacts(raw) {
  const copy = (name, path) => {
    const bytes = tryValue(() => readFileSync(path));
    if (bytes) writeFileSync(join(raw, name), bytes);
    return bytes ? String(bytes) : null;
  };
  const status = copy("worker-proc-self-status.txt", "/proc/self/status") ?? "";
  const cgroup = copy("worker-proc-self-cgroup.txt", "/proc/self/cgroup") ?? "";
  const apparmor =
    copy("worker-apparmor-current.txt", "/proc/self/attr/apparmor/current") ??
    copy("worker-attr-current.txt", "/proc/self/attr/current");
  const statusFacts = {};
  for (const line of status.split("\n")) {
    const match = /^(NoNewPrivs|Seccomp|CapEff|CapBnd|CapAmb):\s*(.*)$/.exec(line);
    if (match) statusFacts[match[1]] = match[2].trim();
  }
  const cgroupPath =
    cgroup
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3) ?? null;
  return {
    pid: process.pid,
    uid: process.getuid?.() ?? null,
    namespaces: Object.fromEntries(
      ["user", "mnt", "net", "pid"].map((ns) => [
        ns,
        tryValue(() => readlinkSync(`/proc/self/ns/${ns}`)),
      ]),
    ),
    status: statusFacts,
    apparmor: apparmor?.trim() ?? null,
    cgroupPath,
    cgroupUnit: cgroupPath?.split("/").find((name) => /\.(?:service|scope)$/.test(name)) ?? null,
  };
}

/** Same-user read and write outside Codex, so a denial inside cannot be the unit's own. */
function controls(spec) {
  const probe = (dir) => {
    const path = join(dir, "cx-probe-control.txt");
    try {
      writeFileSync(path, "control\n", { flag: "wx" });
      const ok = readFileSync(path, "utf8") === "control\n";
      rmSync(path);
      return ok;
    } catch {
      return false;
    }
  };
  return {
    read: tryValue(() => readFileSync(spec.nonceFile, "utf8")) === `${spec.nonce}\n`,
    writeProject: probe(spec.project),
    writeOutside: probe(spec.outside),
  };
}

/** path -> "sha256 mode" of every entry under the fixture directories. */
function manifest(dirs) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const key = relative("/", path);
      if (stat.isDirectory()) {
        out[key] = `dir ${stat.mode}`;
        walk(path);
      } else
        out[key] = `${createHash("sha256").update(readFileSync(path)).digest("hex")} ${stat.mode}`;
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}

function manifestDifferences(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => before[key] !== after[key])
    .map((key) => `${key}: ${before[key] ?? "absent"} -> ${after[key] ?? "absent"}`);
}

/** Processes still in this unit's cgroup besides the worker; null when there is no cgroup v2
 * view (then cleanup cannot be shown). Waits briefly for exits already under way. */
async function cgroupSurvivors(cgroupPath) {
  if (!cgroupPath) return null;
  const file = join("/sys/fs/cgroup", cgroupPath, "cgroup.procs");
  let others = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const pids = tryValue(() => readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number));
    if (!pids) return null;
    others = pids.filter((pid) => pid !== process.pid);
    if (others.length === 0) return [];
    await sleep(500);
  }
  return others.map((pid) => ({
    pid,
    cmdline: tryValue(() =>
      readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim(),
    ),
    exe: tryValue(() => readlinkSync(`/proc/${pid}/exe`)),
  }));
}

/** realpath of a path whose last component may not exist yet. */
function realpathLoose(path) {
  return (
    tryValue(() => realpathSync(path)) ??
    tryValue(() => join(realpathSync(dirname(path)), basename(path))) ??
    path
  );
}

function firstOnPath(pathValue, name) {
  const dir = String(pathValue)
    .split(":")
    .find((entry) => entry && isExecutableFile(join(entry, name)));
  return dir
    ? { path: join(dir, name), realpath: tryValue(() => realpathSync(join(dir, name))) }
    : null;
}

export async function runCellWorker(specFile) {
  const spec = JSON.parse(readFileSync(specFile, "utf8"));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, spec.env);
  mkdirSync(spec.raw, { recursive: true });
  const rawFile = (name) => join(spec.raw, name);
  const capture = [];
  const obs = {
    spec: specFile,
    startedAt: new Date().toISOString(),
    outside: processFacts(spec.raw),
  };
  if (obs.outside.cgroupUnit) {
    const show = spawnSync(
      "systemctl",
      ["show", obs.outside.cgroupUnit, "--no-pager", `--property=${spec.unitProperties.join(",")}`],
      { encoding: "utf8" },
    );
    writeFileSync(rawFile("unit-show.txt"), show.stdout ?? "");
    obs.unit = { name: obs.outside.cgroupUnit, properties: parseKeyValues(show.stdout) };
  }
  obs.controls = controls(spec);
  obs.outsideTargetGaps = outsideTargetGaps(spec, realpathLoose);
  capture.push(...obs.outsideTargetGaps);
  // Fail closed BEFORE any Codex or daemon process starts: the unit must refuse to send
  // anything to a non-loopback address.
  obs.egress = await egressProbe();
  const egressOpen = spec.egress?.required === "blocked" && !obs.egress.blocked;
  if (egressOpen)
    capture.push(
      `egress is not closed: a UDP send to ${obs.egress.host}:${obs.egress.port} ended ${obs.egress.code}, so no Codex or daemon process started`,
    );
  const fixtureDirs = [spec.project, spec.outside, spec.fullControl];
  const fixtureBefore = manifest(fixtureDirs);
  const sampler = startProcessSampler(obs.outside.cgroupPath);
  if (spec.kind === "daemon")
    return finishDaemonCell(spec, { obs, capture, sampler, fixtureBefore });
  if (egressOpen) {
    obs.executed = sampler.stop();
    obs.fixture = { differences: manifestDifferences(fixtureBefore, manifest(fixtureDirs)) };
    obs.result = {
      capture: { known: false, problems: capture },
      cleanup: { known: true, problems: [] },
      probes: {},
    };
    writeFileSync(join(spec.root, "observations.json"), `${JSON.stringify(obs, null, 2)}\n`);
    return obs;
  }
  const provider = await startScriptedProvider({
    logDir: join(spec.raw, "provider"),
    script: {
      command: modelExecCommand(spec.nonceFile, spec.writeTargets.readonly, spec.marker),
      workdir: spec.project,
      imagePath: spec.imageFile,
    },
  });
  writeFileSync(
    join(spec.codexHome, "config.toml"),
    providerConfigToml({ baseUrl: provider.baseUrl, model: spec.model }),
  );
  const product = await loadProduct(spec.repo);
  const launch = managedLaunch(product, {
    codexHome: spec.codexHome,
    helper: spec.helper,
    env: process.env,
    hasBwrap: (dir) => isExecutableFile(join(dir, "bwrap")),
  });
  // Egress restriction BEFORE the first thread/start: a dead proxy with a loopback exemption.
  Object.assign(launch.patch, deadProxyEnv());
  obs.launch = {
    ...launch,
    pathBwrap: firstOnPath(launch.patch.PATH ?? launch.managedPath, "bwrap"),
    codexOnPath: firstOnPath(launch.patch.PATH ?? launch.managedPath, "codex"),
  };
  writeFileSync(rawFile("launch.json"), `${JSON.stringify(obs.launch, null, 2)}\n`);

  const proc = {
    exit: null,
    terminationUnconfirmed: null,
    launchAdvisory: null,
    error: null,
    started: false,
  };
  let io = null;
  let onSpawned;
  const spawned = new Promise((resolve) => (onSpawned = resolve));
  const client = createAppServerClient({
    write: (line) => io?.write(line),
    record: (direction, line) =>
      appendFileSync(
        rawFile(direction === "in" ? "appserver-stdout.jsonl" : "appserver-stdin.jsonl"),
        `${line}\n`,
      ),
  });
  const abort = new AbortController();
  const runSpec = product.HarnessRunSpec.parse({
    session_id: `probe-${spec.phase}-${spec.cell}`,
    intent: "explain",
    prompt: "Read the probe file and quote it exactly.",
    cwd: spec.project,
    access: "readonly",
    model_hint: spec.model,
    external_context_policy: "off",
  });
  const events = product.spawnProcess(launch.bin, launch.args, {
    stdoutFraming: "lf",
    cwd: spec.project,
    env: launch.patch,
    inheritEnv: runSpec.env_inheritance,
    keepStdinOpen: true,
    abortSignal: abort.signal,
    onSpawn(childIo) {
      io = childIo;
      proc.started = true;
      onSpawned();
    },
  });
  const pump = (async () => {
    try {
      for await (const event of events) {
        if (event.type === "stdout") client.receive(event.line);
        else if (event.type === "stderr")
          appendFileSync(rawFile("appserver-stderr.log"), `${event.line}\n`);
        else if (event.type === "exit")
          proc.exit = { code: event.code, signal: event.signal, drain: event.drain ?? null };
        else if (event.type === "termination_unconfirmed")
          proc.terminationUnconfirmed = {
            survivors: event.survivors,
            unresolved: event.unresolved,
          };
        else if (event.type === "launch_advisory") proc.launchAdvisory = event.detail;
      }
    } catch (error) {
      proc.error = String(error?.stack ?? error);
    } finally {
      client.close(proc.exit ? "app-server exited" : "app-server stream ended");
    }
  })();
  await Promise.race([spawned, pump]);

  obs.initialize = await client.request(
    "initialize",
    {
      clientInfo: { name: "claudexor", version: product.CLAUDEXOR_VERSION },
      capabilities: { experimentalApi: true },
    },
    { timeoutMs: 30_000 },
  );
  if (obs.initialize.state === "result") {
    client.notify("initialized", null);
    await client.waitForNotification((n) => n.method === "remoteControl/status/changed", {
      timeoutMs: 10_000,
    });
    // "<originator>/<codex version> (...)": which Codex actually answered.
    obs.codexVersion =
      /^[^/\s]+\/(\S+)/.exec(String(obs.initialize.result.userAgent ?? ""))?.[1] ?? null;
    if (obs.codexVersion !== spec.codexVersion)
      capture.push(
        `the app-server reported Codex ${obs.codexVersion}, not the pinned ${spec.codexVersion}`,
      );
  } else capture.push(`initialize ${obs.initialize.state}`);
  obs.startup = startupWarnings(client.notifications);

  obs.probes = {};
  for (const probe of obs.initialize.state === "result" ? commandProbes(spec) : []) {
    const outcome = await client.request("command/exec", probe.params, {
      timeoutMs: COMMAND_TIMEOUT_MS + 15_000,
    });
    const host = probe.target
      ? {
          exists: existsSync(probe.target),
          content: tryValue(() => readFileSync(probe.target, "utf8")),
        }
      : {};
    obs.probes[probe.id] = {
      params: probe.params,
      outcome,
      host,
      verdict: classifyProbe(probe, outcome, spec, host),
    };
    if (probe.target && host.exists) rmSync(probe.target, { force: true });
    if (!["result", "error"].includes(outcome.state)) {
      capture.push(`command/exec ${probe.id} ${outcome.state}; later probes skipped`);
      break;
    }
  }

  obs.turn = { started: false };
  if (obs.initialize.state === "result" && !capture.length) {
    const [method, params] = product.codexAppServerThreadRequest(runSpec, null);
    const thread = await client.request(method, params, { timeoutMs: 60_000 });
    const threadId = thread.result?.thread?.id ?? null;
    obs.turn = {
      threadState: thread.state,
      threadError: thread.error ?? null,
      threadId,
      sandboxEcho: thread.result?.sandbox ?? null,
      started: false,
    };
    if (threadId) {
      const from = client.notifications.length;
      const turnParams = {
        threadId,
        ...product.codexTurnParams(runSpec),
        input: product.codexAppServerInput(runSpec),
      };
      const start = await client.request("turn/start", turnParams, { timeoutMs: 60_000 });
      obs.turn.startState = start.state;
      obs.turn.started = start.state === "result";
      if (obs.turn.started) {
        const done = await client.waitForNotification(
          (n) => n.method === "turn/completed" && (n.params?.threadId ?? threadId) === threadId,
          { fromIndex: from, timeoutMs: TURN_TIMEOUT_MS },
        );
        obs.turn.completed = Boolean(done);
        if (!done) capture.push("the scripted turn did not complete");
      } else capture.push(`turn/start ${start.state}`);
    } else capture.push(`${method} ${thread.state}`);
    obs.turn.hostWrite = { exists: existsSync(spec.writeTargets.readonly) };
  }

  io?.end();
  const exited = await Promise.race([pump.then(() => true), sleep(EXIT_WAIT_MS).then(() => false)]);
  obs.stopping = { exitedAfterStdinEof: exited };
  if (!exited) {
    abort.abort();
    obs.stopping.aborted = true;
    obs.stopping.endedAfterAbort = await Promise.race([
      pump.then(() => true),
      sleep(60_000).then(() => false),
    ]);
  }
  await provider.close();
  writeFileSync(rawFile("provider-log.json"), `${JSON.stringify(provider.log, null, 2)}\n`);
  writeFileSync(rawFile("notifications.json"), `${JSON.stringify(client.snapshot(), null, 2)}\n`);
  const { configWarnings, warnings } = startupWarnings(client.notifications);
  obs.sessionWarnings = { configWarnings, warnings };
  obs.process = proc;
  const fixtureAfter = manifest(fixtureDirs);
  obs.fixture = { differences: manifestDifferences(fixtureBefore, fixtureAfter) };
  obs.executed = sampler.stop();
  obs.helperPath = actualHelperPath(spec, obs.executed);
  obs.survivors = await cgroupSurvivors(obs.outside.cgroupPath);

  const snapshot = client.snapshot();
  if (snapshot.captureProblems.length) capture.push(...snapshot.captureProblems);
  if (!proc.started) capture.push("the app-server did not start");
  if (proc.error) capture.push(`app-server stream failed: ${proc.error.split("\n")[0]}`);
  if (proc.exit?.drain === "truncated") capture.push("app-server output drain was truncated");
  const cleanup = [];
  if (!proc.exit) cleanup.push("the app-server exit was not observed");
  if (proc.terminationUnconfirmed)
    cleanup.push("spawnProcess could not confirm the process tree ended");
  if (obs.survivors === null)
    cleanup.push("no cgroup view, so leftover processes cannot be ruled out");
  else if (obs.survivors.length)
    cleanup.push(`${obs.survivors.length} process(es) left in the unit cgroup`);
  const verdicts = Object.fromEntries(
    Object.entries(obs.probes).map(([id, probe]) => [id, probe.verdict]),
  );
  obs.result = {
    capture: { known: capture.length === 0, problems: capture },
    cleanup: { known: cleanup.length === 0, problems: cleanup },
    probes: verdicts,
    access: accessVerdicts(
      verdicts,
      obs.probes.readonly_identity?.outcome?.result?.stdout,
      obs.outside.namespaces,
    ),
    turn: classifyTurn({
      turn: obs.turn,
      notifications: client.notifications,
      providerLog: provider.log,
      nonce: spec.nonce,
      hostWrite: obs.turn.hostWrite,
    }),
    identity: parseKeyValues(obs.probes.readonly_identity?.outcome?.result?.stdout),
    helpers: helperExecutions(obs.executed.processes),
    helperPath: obs.helperPath,
    codexProcesses: codexAppServers(obs.executed),
  };
  obs.finishedAt = new Date().toISOString();
  writeFileSync(join(spec.root, "observations.json"), `${JSON.stringify(obs, null, 2)}\n`);
  return obs;
}

/** The native Codex app-server processes the sampler saw (not the npm `node` launcher), each
 * with the sha256 of the file the kernel says it executed. */
export function codexAppServers(executed) {
  return executed.processes
    .filter((entry) => entry.argv.includes("app-server") && basename(entry.exe ?? "") === "codex")
    .map((entry) => ({
      ...entry,
      sha256: tryValue(() => createHash("sha256").update(readFileSync(entry.exe)).digest("hex")),
    }));
}

/** The PATH Codex's native app-server actually ran with (read from its /proc environ by the
 * sampler) and the first `bwrap` on it: what the bundled control's PATH removal really left. */
function actualHelperPath(spec, executed) {
  const paths = [
    ...new Set(
      codexAppServers(executed)
        .map((entry) => entry.path)
        .filter(Boolean),
    ),
  ];
  const firstBwrap = paths.length === 1 ? firstOnPath(paths[0], "bwrap") : null;
  return {
    observed: paths.length === 1 ? paths[0] : null,
    distinctPaths: paths.length,
    firstBwrap: firstBwrap?.realpath ?? (paths.length === 1 ? "none" : null),
    bundledControlEffective:
      spec.helper === "bundled" && paths.length === 1 ? firstBwrap === null : null,
  };
}

/** The daemon cell: the real daemon route inside this unit (linux-codex-appserver-daemon.mjs),
 * then the same fixture, executable and cgroup evidence as an app-server cell. */
async function finishDaemonCell(spec, { obs, capture, sampler, fixtureBefore }) {
  const fixtureDirs = [spec.project, spec.outside, spec.fullControl];
  const ran = capture.length
    ? { obs: { skipped: "an earlier capture problem" }, providerLog: [] }
    : await runDaemonCell(spec, { raw: spec.raw, capture });
  obs.daemon = ran.obs;
  writeFileSync(
    join(spec.raw, "provider-log.json"),
    `${JSON.stringify(ran.providerLog, null, 2)}\n`,
  );
  const hostWrite = { exists: existsSync(spec.writeTargets.readonly) };
  obs.fixture = { differences: manifestDifferences(fixtureBefore, manifest(fixtureDirs)) };
  obs.executed = sampler.stop();
  obs.survivors = await cgroupSurvivors(obs.outside.cgroupPath);
  const cleanup = [];
  // `daemon stop` is evidence; whether the daemon pid it started is gone is the verdict.
  if (ran.obs.start?.pid && ran.obs.daemonExited !== true)
    cleanup.push("the daemon process was not shown to have exited");
  if (obs.survivors === null)
    cleanup.push("no cgroup view, so leftover processes cannot be ruled out");
  else if (obs.survivors.length)
    cleanup.push(`${obs.survivors.length} process(es) left in the unit cgroup`);
  const daemon = classifyDaemonRun({
    obs: ran.obs,
    providerLog: ran.providerLog,
    nonce: spec.nonce,
    hostWrite,
    telemetry: tryValue(() =>
      readFileSync(join(spec.raw, "run-dir", "final", "telemetry.yaml"), "utf8"),
    ),
  });
  obs.result = {
    capture: { known: capture.length === 0, problems: capture },
    cleanup: { known: cleanup.length === 0, problems: cleanup },
    daemon,
    identity: daemon.execIdentity,
    helpers: helperExecutions(obs.executed.processes),
    codexProcesses: codexAppServers(obs.executed),
  };
  obs.finishedAt = new Date().toISOString();
  writeFileSync(join(spec.root, "observations.json"), `${JSON.stringify(obs, null, 2)}\n`);
  return obs;
}
