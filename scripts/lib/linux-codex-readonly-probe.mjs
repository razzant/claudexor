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

/** Each Codex run in a cell is stopped after this long; five runs per cell at
 * most keep a hung cell inside the job budget. */
export const SANDBOX_RUN_TIMEOUT_MS = 60_000;
/** A probe that ended this close to the limit failed on timing. */
const TIME_LIMIT_MARGIN_MS = 5_000;

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

/** open/openat show which file a thread opened as the N of a bundled
 * /proc/self/fd/N exec, and close, close_range, dup2 and dup3 when N stops
 * naming it; socket and ioctl show bubblewrap's network setup. */
export const STRACE_ARGS = [
  "-f",
  "-v",
  "-s",
  "4096",
  "-e",
  "trace=execve,open,openat,close,close_range,dup2,dup3,clone,clone3,unshare,setns,mount,pivot_root,prctl,seccomp,socket,ioctl,sendto,recvfrom,sendmsg,recvmsg",
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
    change: `AppArmor profile ${BWRAP_PROFILE_NAME} for ${SYSTEM_BWRAP} with \`userns\` loaded`,
  },
  { id: "userns-sysctl-relaxed", change: `${USERNS_RESTRICTION} set to 0` },
];

export const DIAGNOSTIC_CONTROL =
  "Diagnostic control on a disposable GitHub-hosted runner. After an unchanged baseline, one phase " +
  `loads an AppArmor profile for ${SYSTEM_BWRAP} and one sets ${USERNS_RESTRICTION}=0; each ` +
  "reverts its change and verifies the host state before the next phase starts, and a cell whose " +
  "processes are not shown to have ended stops the comparison. The changes exist only to locate " +
  "the boundary behind claudexor#337 on this runner, and neither is a recommended host setting. " +
  "Sandbox verdicts are data: the job fails only on a harness defect.";

const NEGATIVE_CONTROL_NOTE =
  "In apparmor-bwrap-profile the bundled cells are negative controls: the profile can attach only " +
  `to an executable at ${SYSTEM_BWRAP}, and Codex executes its bundled helper, a different file, ` +
  "through /proc/self/fd/N.";

const ATTACHMENT_NOTE =
  "`change verified` means the host state read after the change differed from the one before by " +
  "exactly that change: for apparmor-bwrap-profile, the kernel listed the profile " +
  "`bwrap (unconfined)`. That does not show the profile attached to the helper in any cell. A " +
  "cell shows it attached through a label inside the sandbox naming `bwrap`; an AppArmor line " +
  "naming the profile during the cell is a weaker sign, since kernel lines are not tied to the " +
  "cell's own processes. When the identity command failed and no such line appears, attachment " +
  "in that cell is unknown.";

/** How the phases may be read. docs/evidence/linux-codex-readonly-probe.md
 * states the same rules. */
export const PHASE_READING = [
  "Compare phases only in a `complete` run: a `not_run` cell or any harness defect leaves the comparison open.",
  "A baseline cell that is `proven` has no failure for the controls to locate.",
  "Support: a system cell `proven` in both `apparmor-bwrap-profile` and `userns-sysctl-relaxed`, while the bundled cells still fail under the profile, is strong support that this runner's failure is AppArmor's restriction of unprivileged user namespaces applied to bwrap.",
  "Refutation: a cell that fails in both control phases fails for another reason on this runner. `userns-sysctl-relaxed` runs its cells only after the sysctl reads `0`.",
  "Profile failing, sysctl passing: the profile did not take effect for the helper (attachment path, `NoNewPrivileges`, the profile itself). That is not a refutation.",
  "Profile passing, sysctl failing: relaxing the restriction for every program cannot be stricter than one profile, so this is an artifact such as timing or a leftover process; rerun rather than conclude.",
  "In `apparmor-bwrap-profile`, `direct-system` is the clean cell. The service cells run with `NoNewPrivileges=yes`, under which AppArmor may refuse the exec-time profile transition, so a failing `service-system` beside a proven `direct-system` is not a refutation.",
  "A bundled cell `proven` under `apparmor-bwrap-profile` breaks the negative control, and that phase cannot be credited to the profile.",
  "A cell whose sandbox probe ended by `ETIMEDOUT` or ran for about the 60 s limit failed on timing: an artifact, not a refutation.",
];

export const LIMITATIONS = [
  "Only `codex sandbox` runs: no app-server, thread, model turn or Claudexor review, so model-driven project reading remains unproven.",
  "The #337 report observed Codex 0.153.3; this probe pins 0.162.1, so a change in how Codex launches its sandbox between those versions is outside what it shows.",
  "A GitHub-hosted Ubuntu 24.04 VM is not the #337 host; no result here establishes or excludes the original cause.",
  "The transient unit carries only the reported hardening; the original unit's other properties, environment, PATH and writable paths are unknown.",
  "Each control phase changes one host restriction on a disposable runner. A verdict that changes between phases shows what this runner's failure depends on; neither change is a host recommendation.",
  "A verified profile change shows the kernel loaded the profile, not that it attached to the helper in a cell; the service cells keep NoNewPrivileges=yes, under which AppArmor may refuse the exec-time transition.",
  "The helper is chosen only through PATH, Codex's own rule. The traced helper comes from a separate traced read and counts only execs the trace shows returning 0; an exec of /proc/self/fd/N with argv0 bwrap is only ever inferred to be the bundled helper, because a text trace cannot show what N named at that moment.",
  "A cell's kernel lines are those printed while it ran, by any process on the runner, not lines proven to come from its own processes. They reach dmesg through the kernel's printk rate limit, and AppArmor suppresses repeated audit records of the same capability denial, so a missing line is not evidence that nothing was denied. Traces and kernel lines are raw diagnostics, never verdict inputs.",
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

/** The bwrap Codex selects from SYSTEM_PATH and whether it is the file the
 * control profile names: AppArmor attaches a profile by the resolved path of
 * the executable, so only that file can carry it. */
export function systemHelper(path, realpath) {
  return { path, realpath, profiledPath: SYSTEM_BWRAP, matchesProfile: realpath === SYSTEM_BWRAP };
}

function profiledHelperGaps(helper) {
  if (helper === undefined) return ["the system bwrap was not recorded"];
  if (helper?.matchesProfile === true) return [];
  if (!helper?.path) return [`no bwrap on the system PATH, so no cell can execute ${SYSTEM_BWRAP}`];
  return [
    `the system bwrap ${helper.path} resolves to ${helper.realpath ?? "an unreadable path"}, not the profiled ${SYSTEM_BWRAP}`,
  ];
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

/** How each sandbox probe of a cell ended, to read a failure by and never a
 * verdict input: its end, duration, whether it reached the per-run time limit,
 * and its first stderr line, the helper's own message when it failed before
 * the command. */
export function probeEnds(observations) {
  return Object.fromEntries(
    ["read", "identity", "write"].map((name) => {
      const probe = observations?.probes?.[name];
      if (!probe) return [name, null];
      return [
        name,
        {
          ended: ended(probe),
          ms: probe.ms ?? null,
          atTimeLimit:
            probe.error === "ETIMEDOUT" ||
            probe.ms >= SANDBOX_RUN_TIMEOUT_MS - TIME_LIMIT_MARGIN_MS,
          stderr: lines(probe.stderr)[0]?.trim().slice(0, 300) ?? null,
        },
      ];
    }),
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

const UNFINISHED = " <unfinished ...>";

/** The value and errno strace printed after a call's closing parenthesis,
 * which it pads to a column. The return holds no quote, so it is looked for
 * after the last one; null when the trace shows no return. */
function traceReturn(call) {
  const tail = call.slice(call.lastIndexOf('"') + 1);
  const found = [...tail.matchAll(/\)\s+=\s+(\?|-?\d+)(?=\s|$)(?:\s+(E[A-Z0-9]+))?/g)].at(-1);
  return found ? { value: found[1], errno: found[2] ?? null } : null;
}

/** Which descriptor numbers a call closes or replaces, or null. */
function releasedBy(name, args) {
  if (!["close", "close_range", "dup2", "dup3"].includes(name)) return null;
  const [first, second] = args.split(",", 2).map((part) => Number.parseInt(part, 10));
  if (name === "close") return (fd) => fd === first;
  if (name === "dup2" || name === "dup3") return (fd) => fd === second;
  if (name !== "close_range") return null;
  // An open-ended range may print its last descriptor as ~0 or -1.
  const from = Number.isInteger(first) ? first : 0;
  const to = Number.isInteger(second) && second >= from ? second : Infinity;
  return (fd) => fd >= from && fd <= to;
}

/** Which bwrap the traced read executed. An exec counts only when the trace
 * shows it returned 0. strace splits a call that another thread interrupts
 * into `<unfinished ...>` and `<... execve resumed>` lines; the two are joined
 * by pid, also across strace's `superseded by execve` handover to the thread
 * group leader. An attempt that returned an error is kept in `failed`, one
 * whose return the trace never shows in `unresolved`, neither as executed.
 *
 * Codex runs the system helper by its path and the bundled one as
 * /proc/self/fd/N with argv0 `bwrap`. A text trace cannot show what N named at
 * that exec, so a descriptor exec is only ever `(inferred)`. Its `openedAs`
 * hint is the file the same thread last opened as N, dropped when any thread
 * closes or replaces N; without a hint the exec is taken for the bundled
 * helper, Codex's own route. `bundledBwrap` may list several spellings of the
 * installed helper's path. */
export function tracedHelper(trace, { systemBwrap, bundledBwrap }) {
  const helper = { kind: "unknown", execs: [], failed: [], unresolved: [] };
  if (typeof trace !== "string") return helper;
  const bundled = [bundledBwrap].flat().filter(Boolean);
  const named = (file) =>
    file === systemBwrap ? "system" : bundled.includes(file) ? "bundled" : "other";
  const opened = new Map(); // pid -> Map(fd -> path of that thread's last open)
  const pending = new Map(); // pid -> the call it started and has not returned from
  // A thread runs one call at a time: one it leaves without a return stays unresolved.
  const leave = (pid) => {
    const attempt = pending.get(pid)?.attempt;
    if (attempt) helper.unresolved.push({ ...attempt, returned: null });
    pending.delete(pid);
  };
  const enter = (pid, name, args) => {
    const released = releasedBy(name, args);
    if (released)
      for (const table of opened.values())
        for (const fd of table.keys()) if (released(fd)) table.delete(fd);
    const exec = name === "execve" && /^"([^"]*)", \["bwrap"[,\]]/.exec(args);
    if (!exec) return null;
    const fd = /^\/proc\/self\/fd\/(\d+)$/.exec(exec[1]);
    const openedAs = fd ? (opened.get(pid)?.get(Number(fd[1])) ?? null) : null;
    const kind = fd ? `${openedAs ? named(openedAs) : "bundled"} (inferred)` : named(exec[1]);
    return { pid: Number(pid), path: exec[1], openedAs, kind };
  };
  const exit = (pid, name, args, attempt) => {
    const result = traceReturn(args);
    const returned = /^\d+$/.test(result?.value ?? "") ? result.value : null;
    const open = (name === "open" || name === "openat") && /^(?:[^,"]+, )?"([^"]*)"/.exec(args);
    if (open && returned !== null) {
      if (!opened.has(pid)) opened.set(pid, new Map());
      opened.get(pid).set(Number(returned), open[1]);
    }
    // A new task, or a new program in this one, starts without this thread's opens.
    if ((name === "clone" || name === "clone3") && returned !== null) opened.delete(returned);
    if (name === "execve" && returned === "0") opened.delete(pid);
    if (!attempt) return;
    if (result?.value === "0") helper.execs.push(attempt);
    else if (result?.value === "-1") helper.failed.push({ ...attempt, errno: result.errno });
    else helper.unresolved.push({ ...attempt, returned: result?.value ?? null });
  };
  for (const line of trace.split("\n")) {
    const [, pid, body] = /^(\d+)\s+(.*)$/.exec(line) ?? [];
    if (!pid) continue;
    const superseded = /^\+\+\+ superseded by execve in pid (\d+) \+\+\+$/.exec(body);
    if (superseded) {
      // The exec'ing thread takes over this pid, and its exec returns under it.
      const call = pending.get(superseded[1]);
      pending.delete(superseded[1]);
      opened.delete(superseded[1]);
      leave(pid);
      if (call) pending.set(pid, call);
      continue;
    }
    if (/^\+\+\+ (?:exited with|killed by) /.test(body)) {
      leave(pid);
      opened.delete(pid);
      continue;
    }
    const resumed = /^<\.\.\. (\w+) resumed>(.*)$/.exec(body);
    if (resumed) {
      const call = pending.get(pid);
      if (call?.name !== resumed[1]) continue;
      pending.delete(pid);
      exit(pid, call.name, call.args + resumed[2], call.attempt);
      continue;
    }
    const call = /^(\w+)\((.*)$/.exec(body);
    if (!call) continue;
    leave(pid);
    const unfinished = call[2].endsWith(UNFINISHED);
    const args = unfinished ? call[2].slice(0, -UNFINISHED.length) : call[2];
    const attempt = enter(pid, call[1], args);
    if (unfinished) pending.set(pid, { name: call[1], args, attempt });
    else exit(pid, call[1], args, attempt);
  }
  for (const pid of [...pending.keys()]) leave(pid);
  const kinds = [...new Set(helper.execs.map((exec) => exec.kind))];
  helper.kind = kinds.length === 1 ? kinds[0] : kinds.length ? "mixed" : "none";
  return helper;
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
    // The profile can reach the system cells only through the file it names.
    preconditions: (before, { systemBwrap }) => [
      ...restrictionAsReported(before),
      ...profiledHelperGaps(systemBwrap),
    ],
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

/** Why the harness cannot show that every process of a cell ended, or null: a
 * service cell's unit must read back stopped, and a direct cell's worker must
 * have exited by itself or never started. A cell the harness could not finish
 * shows neither. */
function unsettled(cell) {
  if (cell.geometry === "service")
    return cell.unitSettled === true ? null : "its transient unit was not shown stopped";
  if (!cell.worker) return "the harness has no record of how its worker ended";
  const { signal, error } = cell.worker;
  return signal || error === "ETIMEDOUT" ? `its worker ${ended(cell.worker)}` : null;
}

/** Runs every phase in order with injected effects, so sequencing, labels and
 * restores are testable without root: `snapshot(phase, stage)` reads the host
 * state, `command(phase, step, args)` runs `sudo args`, `runCell(phase, plan)`
 * runs one cell. A control phase applies its change only to the reported
 * restriction (the sysctl at 1, no bwrap profile, and for the profile the
 * system helper `systemBwrap` being the profiled file), runs its cells only
 * when the applied state differs from the state before by exactly that change,
 * and always reverts a change it attempted. A phase that does not end in its
 * starting state blocks the rest; so does a cell whose processes are not shown
 * to have ended, since one left running could act during any later cell: the
 * rest of its phase and every later phase are then not run. */
export function runPhases({
  snapshot,
  command,
  runCell,
  profileFile,
  systemBwrap,
  phases = [],
  cells = [],
}) {
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
      phase.preconditionGaps = actions
        ? [...gaps, ...actions.preconditions(before, { systemBwrap })]
        : gaps;
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
            for (const plan of cellPlan()) {
              const cell = guarded(
                () => ({ phase: id, ...runCell(id, plan) }),
                (error) => ({
                  phase: id,
                  ...plan,
                  verdict: "worker_defect",
                  reason: `the harness failed while running this cell: ${error.split("\n")[0]}`,
                  facts: null,
                }),
              );
              phaseCells.push(cell);
              const reason = unsettled(cell);
              if (reason) {
                blocked = `the comparison stopped after ${id}/${plan.id}: ${reason}, so a process it started may still be running`;
                break;
              }
            }
            if (blocked && phaseCells.length < cellPlan().length) notRun(blocked);
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
            blocked ??= `the host state after ${id} was not verified as the state it started from`;
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

/** The executed helper, then any exec attempt that failed or never returned. */
function helperCell(helper) {
  if (!helper) return "n/a";
  const failed = new Map();
  for (const { errno } of helper.failed ?? []) failed.set(errno, (failed.get(errno) ?? 0) + 1);
  const attempts = [...failed].map(([errno, count]) => `${count} failed (${errno ?? "no errno"})`);
  if (helper.unresolved?.length) attempts.push(`${helper.unresolved.length} unresolved`);
  return attempts.length ? `${helper.kind}; exec attempts: ${attempts.join(", ")}` : helper.kind;
}

function probeCell(probe) {
  if (!probe) return "n/a";
  const ms = probe.ms === null ? "" : ` in ${probe.ms} ms`;
  const limit = probe.atTimeLimit ? " (time limit)" : "";
  const stderr = probe.stderr ? `: ${probe.stderr.replaceAll("|", "\\|")}` : "";
  return `${probe.ended}${ms}${limit}${stderr}`;
}

function systemHelperLine(helper) {
  if (!helper?.path)
    return `System helper: no bwrap on the system PATH; the profile names ${SYSTEM_BWRAP}.`;
  const same = helper.matchesProfile ? "the same file" : "a different file";
  return `System helper: Codex's PATH selects ${helper.path}, resolving to ${helper.realpath ?? "an unreadable path"}; the profile names ${SYSTEM_BWRAP}, ${same}.`;
}

export function renderSummary(summary) {
  const out = [`# Linux Codex readonly probe (claudexor#337): harness ${summary.outcome}`, ""];
  out.push(DIAGNOSTIC_CONTROL, "");
  if (summary.host) out.push(systemHelperLine(summary.host.systemBwrap), "");
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
    out.push("", ATTACHMENT_NOTE, "", "## How to read the phases", "");
    out.push(...PHASE_READING.map((rule) => `- ${rule}`), "", "## Cells", "");
    out.push(
      "| phase | cell | verdict | reason | read probe | traced helper | label inside sandbox | service geometry | unit settled | kernel log |",
    );
    out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
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
        `| ${cell.phase} | ${cell.id} | ${cell.verdict} | ${cell.reason} | ${probeCell(cell.probes?.read)} | ${helperCell(cell.trace?.helper)} | ${cell.sandboxLabel ?? "n/a"} | ${geometry} | ${service ? String(cell.unitSettled) : "n/a"} | ${kernelLogCell(cell.kernelLog)} |`,
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
