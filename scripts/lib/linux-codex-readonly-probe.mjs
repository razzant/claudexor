/** Pure parts of the credential-free Linux Codex readonly probe (claudexor#337):
 * the pinned Codex package, the service geometry under test, the diagnostic
 * control phases, the disposable unit's lifecycle, the per-cell verdict and
 * the job conclusion. Process and file effects live in
 * scripts/linux-codex-readonly-probe.mjs; docs/evidence/linux-codex-readonly-probe.md
 * states what a result can and cannot prove. */

export const TARGET_TRIPLE = "x86_64-unknown-linux-musl";

/** Codex 0.162.1, the release-tested baseline, as exact public npm bytes: each
 * tarball's registry dist.integrity, then the extracted launcher, native
 * binary and bundled bwrap. */
export const CODEX_PIN = {
  version: "0.162.1",
  main: {
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.162.1.tgz",
    integrity:
      "sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==",
  },
  linux: {
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.162.1-linux-x64.tgz",
    integrity:
      "sha512-cjK2mdHIfEepZ1lQ1MX3aTQC+8ncIsvnacl/6vI2dIIcfP8/MrhTQ2+qRlkXFNDzJSj1d36quIszP+3/4CUJWQ==",
  },
  sha256: {
    launcher: "61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70",
    codex: "628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1",
    bwrap: "01fb705f067bd5365b63d8ad2323a61c8d007733ca5e649437e086f3fb9935d8",
  },
};

/** What `codex --version` prints when the pinned build launches. */
export const CODEX_VERSION_OUTPUT = `codex-cli ${CODEX_PIN.version}`;

/** The reported service hardening. SystemCallFilter was reported empty (`~`)
 * and stays unset; every other property keeps its systemd default. */
export const REPORTED_SERVICE_PROPERTIES = [
  "NoNewPrivileges=yes",
  "ProtectSystem=strict",
  "ProtectHome=no",
  "PrivateNetwork=no",
  "PrivateUsers=no",
  "RestrictNamespaces=no",
];

/** Lifetime of the disposable unit only: systemd fails it after
 * RuntimeMaxSec and kills it TimeoutStopSec later, before the outer wait ends. */
export const UNIT_RUNTIME_MAX_SEC = 600;
export const UNIT_TIMEOUT_STOP_SEC = 30;
export const UNIT_OUTER_TIMEOUT_MS = (UNIT_RUNTIME_MAX_SEC + UNIT_TIMEOUT_STOP_SEC + 60) * 1000;
const UNIT_STATE_PROPERTIES = "LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus";

export const UNIT_PROPERTIES_RECORDED = [
  "Id",
  ...REPORTED_SERVICE_PROPERTIES.map((property) => property.split("=")[0]),
  "User",
  "SystemCallFilter",
  "CapabilityBoundingSet",
  "AmbientCapabilities",
  "AppArmorProfile",
  "ReadWritePaths",
  "RuntimeMaxUSec",
  "TimeoutStopUSec",
];

export const USERNS_RESTRICTION = "kernel.apparmor_restrict_unprivileged_userns";

export const RECORDED_SYSCTLS = [
  "kernel.unprivileged_userns_clone",
  USERNS_RESTRICTION,
  "kernel.apparmor_restrict_unprivileged_unconfined",
  "user.max_user_namespaces",
  "kernel.yama.ptrace_scope",
  "kernel.printk_ratelimit",
  "kernel.printk_ratelimit_burst",
];

/** Codex picks the first `bwrap` on PATH; `bundled` gives it a PATH without one. */
export const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const SYSTEM_BWRAP = "/usr/bin/bwrap";

export const WRITE_STARTED = "cx337-write-started";

/** Runs inside the sandbox: our own key=value lines, absolute tool paths only.
 * The AppArmor label shows which profile, if any, confined the command. */
export const IDENTITY_SCRIPT = [
  'for n in user mnt net pid; do printf "%s=%s\\n" "$n" "$(/usr/bin/readlink /proc/self/ns/$n)"; done',
  "/usr/bin/grep -E '^(NoNewPrivs|Seccomp|CapEff):' /proc/self/status | /usr/bin/tr -d ' \\t' | /usr/bin/tr ':' '='",
  'printf "apparmor=%s\\n" "$(/usr/bin/cat /proc/self/attr/apparmor/current 2>/dev/null || /usr/bin/cat /proc/self/attr/current 2>/dev/null)"',
].join("\n");

/** $1 = marker, $2 = host path; the marker proves the command started inside. */
export const WRITE_SCRIPT = `printf '${WRITE_STARTED}\\n'; printf %s "$1" > "$2"`;

/** open/openat let the trace name the file behind a bundled /proc/self/fd/N exec. */
export const STRACE_ARGS = [
  "-f",
  "-v",
  "-s",
  "4096",
  "-e",
  "trace=execve,open,openat,clone,clone3,unshare,setns,mount,pivot_root,prctl,seccomp,sendto,recvfrom,sendmsg,recvmsg",
];

// ---- diagnostic control phases ----

export const APPARMOR_PROFILES = "/sys/kernel/security/apparmor/profiles";
export const APPARMOR_PARSER = "/usr/sbin/apparmor_parser";
export const SYSCTL = "/usr/sbin/sysctl";
const BWRAP_PROFILE_NAME = "bwrap";

/** Ubuntu's minimal per-binary form for a third-party user of user namespaces. */
export const BWRAP_PROFILE = [
  "# claudexor#337 diagnostic control: loaded for one probe phase on a disposable runner, then removed.",
  "abi <abi/4.0>,",
  "include <tunables/global>",
  "",
  `profile ${BWRAP_PROFILE_NAME} ${SYSTEM_BWRAP} flags=(unconfined) {`,
  "  userns,",
  "}",
  "",
].join("\n");

/** Every phase runs the same four cells; only the host restriction differs. */
export const PHASES = [
  { id: "baseline", change: null },
  {
    id: "apparmor-bwrap-profile",
    change: `AppArmor profile ${BWRAP_PROFILE_NAME} attached to ${SYSTEM_BWRAP} with \`userns\``,
  },
  { id: "userns-sysctl-relaxed", change: `${USERNS_RESTRICTION} set to 0` },
];

export const DIAGNOSTIC_CONTROL =
  "Diagnostic control on a disposable GitHub-hosted runner. After an unchanged baseline, one phase " +
  `loads an AppArmor profile for ${SYSTEM_BWRAP} and one sets ${USERNS_RESTRICTION}=0; each ` +
  "reverts its change and verifies the host state before the next phase starts. The changes exist " +
  "only to locate the boundary behind claudexor#337 on this runner, and neither is a recommended " +
  "host setting. Sandbox verdicts are data: the job fails only on a harness defect.";

const NEGATIVE_CONTROL_NOTE =
  "In apparmor-bwrap-profile the bundled cells are negative controls: the profile attaches only " +
  `to an executable at ${SYSTEM_BWRAP}, and Codex executes its bundled helper, a different file, ` +
  "through /proc/self/fd/N.";

export const LIMITATIONS = [
  "Only `codex sandbox` runs: no app-server, thread, model turn or Claudexor review, so model-driven project reading remains unproven.",
  "A GitHub-hosted Ubuntu 24.04 VM is not the #337 host; no result here establishes or excludes the original cause.",
  "The transient unit carries only the reported hardening; the original unit's other properties, environment, PATH and writable paths are unknown.",
  "Each control phase changes one host restriction on a disposable runner. A verdict that changes between phases shows what this runner's failure depends on; neither change is a host recommendation.",
  "The helper is chosen only through PATH, Codex's own rule. The traced helper comes from a separate traced read: the system helper by its exec path; the bundled helper is inferred from an exec of /proc/self/fd/N with argv0 bwrap and named only when the traced open of that file returned N.",
  "Kernel audit lines reach dmesg through the kernel's printk rate limit, and AppArmor suppresses repeated audit records of the same capability denial, so a missing line is not evidence that nothing was denied. Traces and kernel lines are raw diagnostics, never verdict inputs.",
];

export function cellPlan() {
  return ["direct", "service"].flatMap((geometry) =>
    ["system", "bundled"].map((helper) => ({ id: `${geometry}-${helper}`, geometry, helper })),
  );
}

/** Facts that make a run impossible before any download. */
export function preconditionGaps({ platform, arch, uid, systemdRun, sudo }) {
  const gaps = [];
  if (platform !== "linux") gaps.push(`platform is ${platform}, not linux`);
  if (arch !== "x64") gaps.push(`architecture is ${arch}, not x64`);
  if (uid === 0) gaps.push("running as root; the reported geometry is a normal user");
  if (!systemdRun)
    gaps.push("systemd-run is unavailable, so the service geometry cannot be formed");
  if (!sudo)
    gaps.push(
      "non-interactive sudo is unavailable for the transient unit, kernel log and control phases",
    );
  return gaps;
}

export function digestMismatches(digests) {
  return Object.entries(CODEX_PIN.sha256)
    .filter(([name, pinned]) => digests[name] !== pinned)
    .map(([name, pinned]) => `${name} sha256 ${digests[name]} is not pinned ${pinned}`);
}

/** argv for `sudo`: a disposable transient unit run as the same normal user. */
export function serviceRunArgv({ unit, user, group, workingDirectory, readWritePath, command }) {
  return [
    "-n",
    "systemd-run",
    "--quiet",
    "--wait",
    "--pipe",
    "--collect",
    "--service-type=exec",
    `--unit=${unit}`,
    `--uid=${user}`,
    `--gid=${group}`,
    `--working-directory=${workingDirectory}`,
    ...REPORTED_SERVICE_PROPERTIES.flatMap((property) => ["-p", property]),
    "-p",
    `ReadWritePaths=${readWritePath}`,
    "-p",
    `RuntimeMaxSec=${UNIT_RUNTIME_MAX_SEC}`,
    "-p",
    `TimeoutStopSec=${UNIT_TIMEOUT_STOP_SEC}`,
    "--",
    ...command,
  ];
}

/** Runs `command` in the disposable unit, then settles exactly that unit
 * whatever the wait saw: its state is read, it is stopped, and its final state
 * decides `settled`. `run(step, file, args, timeoutMs)` is the caller's
 * recording process runner. */
export function runInTransientUnit({ run, unit, ...service }) {
  const name = `${unit}.service`;
  const steps = {};
  const attempt = (step, file, args, timeoutMs) => {
    try {
      steps[step] = run(step, file, args, timeoutMs);
    } catch (error) {
      steps[step] = { status: null, signal: null, error: String(error?.message ?? error) };
    }
    return steps[step];
  };
  const show = ["-n", "systemctl", "show", name, `--property=${UNIT_STATE_PROPERTIES}`];
  attempt("start", "sudo", serviceRunArgv({ unit, ...service }), UNIT_OUTER_TIMEOUT_MS);
  attempt("state-before-stop", "sudo", show, 30_000);
  attempt("stop", "sudo", ["-n", "systemctl", "stop", name], (UNIT_TIMEOUT_STOP_SEC + 30) * 1000);
  const after = attempt("state-after-stop", "sudo", show, 30_000);
  const state = parseKeyValues(after.stdout);
  const settled =
    after.status === 0 &&
    (state.LoadState === "not-found" || ["inactive", "failed"].includes(state.ActiveState));
  return { unit: name, steps, settled };
}

export function parseKeyValues(text) {
  const values = {};
  for (const line of String(text ?? "").split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

function exitedZero(result) {
  return Boolean(result) && result.status === 0 && !result.signal && !result.error;
}

function failedCleanly(result) {
  return (
    Boolean(result) &&
    typeof result.status === "number" &&
    result.status !== 0 &&
    !result.signal &&
    !result.error
  );
}

/** No process ran: spawn refused (ENOENT, EACCES ...). A timeout ran one. */
function spawnFailed(result) {
  return !result || (Boolean(result.error) && result.error !== "ETIMEDOUT");
}

function ended(result) {
  if (!result) return "left no record";
  if (result.error) return `failed (${result.error})`;
  return result.signal ? `ended by ${result.signal}` : `exited ${result.status}`;
}

const NAMESPACES = ["user", "mnt", "net"];

/** Deterministic facts only: exit status, the pinned version line, our nonce
 * and marker, namespace ids, host file existence. Vendor stderr stays raw
 * evidence, never a verdict input. */
export function classifyCell(expectedNonce, observations) {
  const launch = observations?.launch;
  const { read, write, identity } = observations?.probes ?? {};
  const outside = observations?.outside?.namespaces ?? {};
  const inside = parseKeyValues(identity?.stdout);
  const facts = {
    codexLaunched:
      exitedZero(launch) && String(launch.stdout ?? "").trim() === CODEX_VERSION_OUTPUT,
    probesStarted: [read, identity, write].every((probe) => !spawnFailed(probe)),
    controlRead: observations?.controls?.read === expectedNonce,
    controlWrite: observations?.controls?.write?.ok === true,
    readNonce: exitedZero(read) && read.stdout.trim() === expectedNonce,
    namespaceEvidence:
      exitedZero(identity) && NAMESPACES.every((name) => inside[name] && outside[name]),
    isolated: NAMESPACES.every((name) => Boolean(inside[name]) && inside[name] !== outside[name]),
    writeStarted: String(write?.stdout ?? "").includes(WRITE_STARTED),
    writeFailedCleanly: failedCleanly(write),
    writeLanded: write?.targetExists === true,
  };
  const verdict = (name, reason) => ({ verdict: name, reason, facts });
  if (facts.writeLanded)
    return verdict("write_not_refused", "the sandboxed write reached the host file");
  if (!facts.codexLaunched)
    return verdict(
      "worker_defect",
      `codex --version did not print ${CODEX_VERSION_OUTPUT} in this cell, so no sandbox ran`,
    );
  if (!facts.probesStarted)
    return verdict("worker_defect", "a probe process could not be started, so no sandbox ran");
  if (!facts.controlRead || !facts.controlWrite)
    return verdict("inconclusive", "outside Codex the same user could not read the nonce or write");
  if (!facts.readNonce)
    return verdict("capability_failed", "codex sandbox did not return the project nonce");
  if (!facts.namespaceEvidence)
    return verdict("inconclusive", "namespace identity inside or outside the sandbox is unknown");
  if (!facts.isolated) {
    const shared = NAMESPACES.filter((name) => inside[name] === outside[name]);
    return verdict(
      "not_isolated",
      `the command ran in the caller's ${shared.join(", ")} namespace${shared.length > 1 ? "s" : ""}`,
    );
  }
  if (!facts.writeStarted || !facts.writeFailedCleanly)
    return verdict(
      "inconclusive",
      "the write did not start inside, exited 0, or ended by signal, error or timeout",
    );
  return verdict(
    "proven",
    "nonce read, write refused without host effect, new user, mount and network namespaces",
  );
}

/** Whether the unit really carried the requested hardening, from the worker's
 * own view: its cgroup unit, kernel NoNewPrivs and `systemctl show`. */
export function serviceGeometry(observations, expectedUnit) {
  const unit = observations?.unit ?? {};
  const mismatches = [];
  if (unit.name !== expectedUnit)
    mismatches.push(`worker ran in ${unit.name ?? "an unknown unit"}, not ${expectedUnit}`);
  const noNewPrivs = observations?.outside?.status?.NoNewPrivs;
  if (noNewPrivs !== "1") mismatches.push(`kernel NoNewPrivs is ${noNewPrivs ?? "unknown"}`);
  for (const property of REPORTED_SERVICE_PROPERTIES) {
    const [name, requested] = property.split("=");
    const applied = unit.properties?.[name];
    if (applied !== requested) mismatches.push(`${name} is ${applied ?? "unknown"}`);
  }
  return { established: mismatches.length === 0, mismatches };
}

function lines(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/** The kernel lines a cell added between two dmesg captures; unknown is never
 * empty. After a ring-buffer move, what follows the last line both captures
 * share, else the whole later capture. */
export function kernelLogDiff(before, after) {
  if (!exitedZero(before) || !exitedZero(after)) return { state: "unavailable", lines: [] };
  if (after.stdout.startsWith(before.stdout))
    return { state: "captured", lines: lines(after.stdout.slice(before.stdout.length)) };
  const later = lines(after.stdout);
  const shared = later.lastIndexOf(lines(before.stdout).at(-1));
  return { state: "rotated", lines: shared >= 0 ? later.slice(shared + 1) : later };
}

const AUDIT_FIELDS = [
  "apparmor",
  "operation",
  "info",
  "profile",
  "name",
  "target",
  "execpath",
  "capname",
  "comm",
];

/** AppArmor audit lines grouped by everything but pid and time, plus the
 * printk rate limiter's own count of lines it dropped. */
export function kernelAudit(diffLines) {
  const groups = new Map();
  let suppressed = 0;
  for (const line of diffLines) {
    const dropped = /kauditd_printk_skb: (\d+) callbacks suppressed/.exec(line);
    if (dropped) suppressed += Number(dropped[1]);
    if (!line.includes(' apparmor="')) continue;
    const fields = {};
    for (const [, key, value] of line.matchAll(/ (\w+)="([^"]*)"/g))
      if (AUDIT_FIELDS.includes(key)) fields[key] = value;
    const key = JSON.stringify(fields);
    if (!groups.has(key)) groups.set(key, { ...fields, count: 0 });
    groups.get(key).count += 1;
  }
  return { apparmor: [...groups.values()], suppressed };
}

/** Which bwrap the traced read executed. Codex runs the system helper by its
 * path and the bundled one as /proc/self/fd/N with argv0 `bwrap`; N is named
 * by the last open/openat in that thread that returned it before the exec.
 * `bundledBwrap` may list several spellings of the installed helper's path. */
export function tracedHelper(trace, { systemBwrap, bundledBwrap }) {
  if (typeof trace !== "string") return { kind: "unknown", execs: [] };
  const bundled = [bundledBwrap].flat().filter(Boolean);
  const opened = new Map();
  const pending = new Map();
  const execs = [];
  for (const line of trace.split("\n")) {
    const open = /^(\d+)\s+open(?:at)?\((?:[^,"]+, )?"([^"]*)",(.*)$/.exec(line);
    if (open) {
      const fd = /\) = (\d+)$/.exec(open[3]);
      if (fd) opened.set(`${open[1]}:${fd[1]}`, open[2]);
      else if (open[3].endsWith("<unfinished ...>")) pending.set(open[1], open[2]);
      continue;
    }
    const resumed = /^(\d+)\s+<\.\.\. open(?:at)? resumed>.*\) = (\d+)$/.exec(line);
    if (resumed && pending.has(resumed[1])) {
      opened.set(`${resumed[1]}:${resumed[2]}`, pending.get(resumed[1]));
      pending.delete(resumed[1]);
      continue;
    }
    const exec = /^(\d+)\s+execve\("([^"]*)", \["bwrap"[,\]](.*)$/.exec(line);
    if (!exec || / = -1 [A-Z]+ \(.*\)$/.test(exec[3])) continue;
    const fd = /^\/proc\/self\/fd\/(\d+)$/.exec(exec[2]);
    const file = fd ? (opened.get(`${exec[1]}:${fd[1]}`) ?? null) : exec[2];
    const kind =
      exec[2] === systemBwrap
        ? "system"
        : fd && bundled.includes(file)
          ? "bundled"
          : fd && file === null
            ? "bundled (inferred)"
            : "other";
    execs.push({ path: exec[2], file, kind });
  }
  const kinds = [...new Set(execs.map((exec) => exec.kind))];
  return { kind: kinds.length === 1 ? kinds[0] : kinds.length ? "mixed" : "none", execs };
}

/** Wait before each cell so its audit lines get a fresh printk rate-limit window. */
export function kernelLogPauseMs(sysctl) {
  const seconds = Number.parseInt(sysctl?.["kernel.printk_ratelimit"] ?? "", 10);
  return (Number.isInteger(seconds) && seconds >= 0 ? Math.min(seconds, 30) + 1 : 6) * 1000;
}

/** One reading of what a phase may change: the recorded sysctls and the
 * kernel's sorted `name (mode)` profile lines, `null` when unreadable. */
export function hostState(sysctl, profiles) {
  return {
    sysctl: sysctl ?? {},
    profiles: exitedZero(profiles)
      ? lines(profiles.stdout)
          .map((line) => line.trim())
          .sort()
      : null,
  };
}

function profileNamed(state, name) {
  return state.profiles?.find((line) => line.startsWith(`${name} (`)) ?? null;
}

function stateGaps(state) {
  const gaps = [];
  if (state.error) gaps.push(`host state read failed: ${state.error}`);
  if (state.profiles === null) gaps.push("the loaded AppArmor profile list is unreadable");
  if (!state.sysctl?.[USERNS_RESTRICTION]) gaps.push(`${USERNS_RESTRICTION} is unreadable`);
  return gaps;
}

/** Every recorded difference between two host states, as plain lines. */
function stateDifferences(before, after) {
  const changes = [];
  for (const name of new Set([...Object.keys(before.sysctl), ...Object.keys(after.sysctl)]))
    if (before.sysctl[name] !== after.sysctl[name])
      changes.push(
        `${name} ${before.sysctl[name] ?? "unreadable"} -> ${after.sysctl[name] ?? "unreadable"}`,
      );
  if (!before.profiles || !after.profiles) {
    if (before.profiles !== after.profiles)
      changes.push("AppArmor profile list readability changed");
    return changes;
  }
  const had = new Set(before.profiles);
  const has = new Set(after.profiles);
  for (const line of before.profiles) if (!has.has(line)) changes.push(`profile ${line} removed`);
  for (const line of after.profiles) if (!had.has(line)) changes.push(`profile ${line} added`);
  return changes;
}

function compactState(state) {
  if (!state) return null;
  return {
    sysctl: state.sysctl,
    profiles: state.profiles && {
      count: state.profiles.length,
      [BWRAP_PROFILE_NAME]: profileNamed(state, BWRAP_PROFILE_NAME),
      unprivileged_userns: profileNamed(state, "unprivileged_userns"),
    },
    ...(state.error ? { error: state.error } : {}),
  };
}

function restrictionAsReported(before) {
  const gaps = [];
  if (before.sysctl[USERNS_RESTRICTION] !== "1")
    gaps.push(
      `${USERNS_RESTRICTION} is ${before.sysctl[USERNS_RESTRICTION] ?? "unreadable"}, not 1`,
    );
  if (profileNamed(before, BWRAP_PROFILE_NAME))
    gaps.push(`a profile named ${BWRAP_PROFILE_NAME} is already loaded`);
  return gaps;
}

/** Each control phase: its preconditions, the exact `sudo` argv that applies
 * and reverts it, and the only difference the applied state may show. */
const PHASE_CHANGES = {
  "apparmor-bwrap-profile": {
    preconditions: restrictionAsReported,
    apply: ({ profileFile }) => ["-n", APPARMOR_PARSER, "-r", profileFile],
    restore: ({ profileFile }) => ["-n", APPARMOR_PARSER, "-R", profileFile],
    expected: () => [`profile ${BWRAP_PROFILE_NAME} (unconfined) added`],
  },
  "userns-sysctl-relaxed": {
    preconditions: restrictionAsReported,
    apply: () => ["-n", SYSCTL, "-w", `${USERNS_RESTRICTION}=0`],
    restore: ({ before }) => [
      "-n",
      SYSCTL,
      "-w",
      `${USERNS_RESTRICTION}=${before.sysctl[USERNS_RESTRICTION]}`,
    ],
    expected: (before) => [`${USERNS_RESTRICTION} ${before.sysctl[USERNS_RESTRICTION]} -> 0`],
  },
};

function guarded(effect, fallback) {
  try {
    return effect();
  } catch (error) {
    return fallback(String(error?.message ?? error));
  }
}

function commandRecord(args, result) {
  return {
    argv: ["sudo", ...args],
    status: result?.status ?? null,
    signal: result?.signal ?? null,
    error: result?.error ?? null,
  };
}

/** A phase's sandbox result: a landed write outranks everything; `proven`
 * needs all four cells proven with no harness defect among them. */
export function phaseOutcome(cells) {
  const verdicts = cells.map((cell) => cell.verdict);
  if (verdicts.includes("write_not_refused")) return "write_not_refused";
  if (verdicts.every((verdict) => verdict === "not_run")) return "not_run";
  const clean = cells.every((cell) => cell.verdict === "proven" && !cellDefects(cell).length);
  return verdicts.length === cellPlan().length && clean ? "proven" : "not_proven";
}

/** Runs every phase in order with injected effects, so sequencing, labels and
 * restores are testable without root: `snapshot(phase, stage)` reads the host
 * state, `command(phase, step, args)` runs `sudo args`, `runCell(phase, plan)`
 * runs one cell. A control phase applies its change only to the reported
 * restriction (the sysctl at 1, no bwrap profile), runs its cells only when the
 * applied state differs from the state before by exactly that change, and
 * always reverts a change it attempted. A phase that does not end in its
 * starting state blocks the rest. */
export function runPhases({ snapshot, command, runCell, profileFile, phases = [], cells = [] }) {
  let blocked = null;
  for (const { id, change } of PHASES) {
    const actions = PHASE_CHANGES[id];
    const phase = {
      id,
      change: change ?? "none",
      ran: false,
      notRunReason: null,
      preconditionGaps: [],
      hostState: { before: null, applied: null, after: null },
      setup: null,
      restore: null,
      endState: null,
      error: null,
    };
    phases.push(phase);
    const phaseCells = [];
    const read = (stage) => {
      const state = guarded(
        () => snapshot(id, stage),
        (error) => ({ sysctl: {}, profiles: null, error }),
      );
      phase.hostState[stage] = compactState(state);
      return state;
    };
    const run = (step, args) => {
      const result = guarded(
        () => command(id, step, args),
        (error) => ({ status: null, signal: null, error }),
      );
      return commandRecord(args, result);
    };
    const notRun = (reason) => {
      phase.notRunReason ??= reason;
      for (const plan of cellPlan().slice(phaseCells.length))
        phaseCells.push({ phase: id, ...plan, verdict: "not_run", reason, facts: null });
    };
    if (blocked) notRun(blocked);
    else {
      const before = read("before");
      const gaps = stateGaps(before);
      phase.preconditionGaps = actions ? [...gaps, ...actions.preconditions(before)] : gaps;
      if (actions && phase.preconditionGaps.length)
        notRun(`precondition not met: ${phase.preconditionGaps.join("; ")}`);
      else {
        let ready = true;
        if (actions) {
          const context = { before, profileFile };
          phase.setup = run("setup", actions.apply(context));
          const applied = read("applied");
          const differences = stateDifferences(before, applied);
          const expected = actions.expected(before);
          phase.setup.differences = differences;
          phase.setup.verified =
            !stateGaps(applied).length &&
            differences.length === expected.length &&
            expected.every((line) => differences.includes(line));
          ready = phase.setup.verified;
        }
        try {
          if (!ready) notRun("the applied host state is not exactly the intended change");
          else {
            phase.ran = true;
            for (const plan of cellPlan())
              phaseCells.push(
                guarded(
                  () => ({ phase: id, ...runCell(id, plan) }),
                  (error) => ({
                    phase: id,
                    ...plan,
                    verdict: "worker_defect",
                    reason: `the harness failed while running this cell: ${error.split("\n")[0]}`,
                    facts: null,
                  }),
                ),
              );
          }
        } catch (error) {
          phase.error = String(error?.stack ?? error);
          notRun("a harness error stopped this phase");
        } finally {
          if (actions) phase.restore = run("restore", actions.restore({ before, profileFile }));
          const after = read("after");
          const differences = [...stateGaps(after), ...stateDifferences(before, after)];
          phase.endState = { differences, restored: differences.length === 0 };
          if (!phase.endState.restored)
            blocked = `the host state after ${id} was not verified as the state it started from`;
        }
      }
    }
    phase.verdicts = {};
    for (const cell of phaseCells)
      phase.verdicts[cell.verdict] = (phase.verdicts[cell.verdict] ?? 0) + 1;
    phase.sandboxOutcome = phaseOutcome(phaseCells);
    cells.push(...phaseCells);
  }
  return { phases, cells };
}

/** Harness defects of one cell that ran: anything that leaves its result
 * without the evidence or geometry it claims. Sandbox verdicts are not defects. */
export function cellDefects(cell) {
  if (cell.verdict === "not_run") return [];
  const where = `${cell.phase}/${cell.id}`;
  const defects = [];
  if (cell.verdict === "worker_defect") defects.push(`${where}: ${cell.reason}`);
  if (cell.facts && !(cell.facts.controlRead && cell.facts.controlWrite))
    defects.push(`${where}: the outside read or write control failed`);
  if ("worker" in cell && !exitedZero(cell.worker))
    defects.push(`${where}: the cell worker ${ended(cell.worker)}`);
  if (cell.kernelLog?.state === "unavailable") defects.push(`${where}: kernel log unavailable`);
  if (cell.trace?.expected && !cell.trace.recorded)
    defects.push(`${where}: the strace run left no trace`);
  if (cell.geometry === "service" && "serviceGeometry" in cell) {
    if (!cell.serviceGeometry?.established)
      defects.push(
        `${where}: requested service geometry not established (${(cell.serviceGeometry?.mismatches ?? ["no observations"]).join("; ")})`,
      );
    if (cell.unitSettled !== true) defects.push(`${where}: transient unit not shown stopped`);
  }
  return defects;
}

function phaseDefects(phase) {
  const defects = [];
  if (phase.notRunReason)
    defects.push(`${phase.id}: planned cells not run (${phase.notRunReason})`);
  else if (!phase.setup && phase.preconditionGaps.length)
    defects.push(`${phase.id}: ${phase.preconditionGaps.join("; ")}`);
  if (phase.setup && !phase.setup.verified)
    defects.push(
      `${phase.id}: change not verified after setup (${phase.setup.differences.join("; ") || "no difference"})`,
    );
  if (phase.endState && !phase.endState.restored)
    defects.push(`${phase.id}: host state not restored (${phase.endState.differences.join("; ")})`);
  if (phase.error) defects.push(`${phase.id}: harness error: ${phase.error.split("\n")[0]}`);
  return defects;
}

/** The job conclusion. `complete` needs every planned cell run with its
 * evidence and every phase ended in its starting host state; verdicts such as
 * capability_failed never enter it. */
export function summarize(phases, cells) {
  const defects = [...phases.flatMap(phaseDefects), ...cells.flatMap(cellDefects)];
  return { outcome: defects.length ? "incomplete" : "complete", defects };
}

export function exitCodeFor(outcome) {
  if (outcome === "complete") return 0;
  return outcome === "incomplete" ? 1 : 2;
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function kernelLogCell(log) {
  if (!log) return "n/a";
  if (log.state === "unavailable") return "unavailable";
  const denied = log.apparmor
    .filter((group) => group.apparmor === "DENIED")
    .reduce((sum, group) => sum + group.count, 0);
  const audited = log.apparmor.reduce((sum, group) => sum + group.count, 0);
  const suppressed = log.suppressed ? `, ${log.suppressed} suppressed` : "";
  return `${log.state}: ${log.newLines} lines, ${audited} AppArmor (${denied} DENIED)${suppressed}`;
}

export function renderSummary(summary) {
  const out = [`# Linux Codex readonly probe (claudexor#337): harness ${summary.outcome}`, ""];
  out.push(DIAGNOSTIC_CONTROL, "");
  const notes = (summary.gaps ?? []).map((gap) => `- unsupported: ${gap}`);
  if (summary.error) notes.push(`- harness error: ${summary.error.split("\n")[0]}`);
  if (notes.length) out.push(...notes, "");
  const phases = summary.phases ?? [];
  const cells = summary.cells ?? [];
  if (cells.length) {
    out.push("## Sandbox verdict by phase", "");
    out.push(`| cell | ${phases.map((phase) => phase.id).join(" | ")} |`);
    out.push(`| --- |${" --- |".repeat(phases.length)}`);
    for (const plan of cellPlan()) {
      const verdicts = phases.map(
        (phase) => cells.find((cell) => cell.phase === phase.id && cell.id === plan.id)?.verdict,
      );
      out.push(`| ${plan.id} | ${verdicts.map((verdict) => verdict ?? "missing").join(" | ")} |`);
    }
    out.push("", NEGATIVE_CONTROL_NOTE, "", "## Phases", "");
    out.push("| phase | host change | change verified | host state restored | sandbox outcome |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const phase of phases)
      out.push(
        `| ${phase.id} | ${phase.change} | ${phase.setup ? yesNo(phase.setup.verified) : "n/a"} | ${phase.endState ? yesNo(phase.endState.restored) : "n/a"} | ${phase.sandboxOutcome} |`,
      );
    out.push("", "## Cells", "");
    out.push(
      "| phase | cell | verdict | reason | traced helper | label inside sandbox | service geometry | unit settled | kernel log |",
    );
    out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const cell of cells) {
      const service = cell.geometry === "service" && "serviceGeometry" in cell;
      const geometry = service
        ? cell.serviceGeometry?.established
          ? "established"
          : "not established"
        : cell.geometry === "direct"
          ? "direct"
          : "n/a";
      out.push(
        `| ${cell.phase} | ${cell.id} | ${cell.verdict} | ${cell.reason} | ${cell.trace?.helper?.kind ?? "n/a"} | ${cell.sandboxLabel ?? "n/a"} | ${geometry} | ${service ? String(cell.unitSettled) : "n/a"} | ${kernelLogCell(cell.kernelLog)} |`,
      );
    }
    out.push("");
  }
  const defects = summary.defects ?? [];
  if (summary.outcome === "complete" || summary.outcome === "incomplete")
    out.push(
      "## Harness defects",
      "",
      ...(defects.length ? defects.map((defect) => `- ${defect}`) : ["- none"]),
      "",
    );
  out.push(
    "Raw evidence: phases/<phase>/cells/<cell>/ per cell and phases/<phase>/ for host state and commands, in the uploaded artifact.",
    "",
    "Limits:",
    ...LIMITATIONS.map((limit) => `- ${limit}`),
    "",
  );
  return out.join("\n");
}
