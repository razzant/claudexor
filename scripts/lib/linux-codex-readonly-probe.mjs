/** Pure parts of the credential-free Linux Codex readonly probe (claudexor#337):
 * the pinned Codex package, the service geometry under test, the disposable
 * unit's lifecycle and the per-cell verdict. Process and file effects live in
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

export const RECORDED_SYSCTLS = [
  "kernel.unprivileged_userns_clone",
  "kernel.apparmor_restrict_unprivileged_userns",
  "kernel.apparmor_restrict_unprivileged_unconfined",
  "user.max_user_namespaces",
  "kernel.yama.ptrace_scope",
];

/** Codex picks the first `bwrap` on PATH; `bundled` gives it a PATH without one. */
export const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export const WRITE_STARTED = "cx337-write-started";

/** Runs inside the sandbox: our own key=value lines, absolute tool paths only. */
export const IDENTITY_SCRIPT = [
  'for n in user mnt net pid; do printf "%s=%s\\n" "$n" "$(/usr/bin/readlink /proc/self/ns/$n)"; done',
  "/usr/bin/grep -E '^(NoNewPrivs|Seccomp|CapEff):' /proc/self/status | /usr/bin/tr -d ' \\t' | /usr/bin/tr ':' '='",
].join("\n");

/** $1 = marker, $2 = host path; the marker proves the command started inside. */
export const WRITE_SCRIPT = `printf '${WRITE_STARTED}\\n'; printf %s "$1" > "$2"`;

export const STRACE_ARGS = [
  "-f",
  "-v",
  "-s",
  "4096",
  "-e",
  "trace=execve,clone,clone3,unshare,setns,mount,pivot_root,prctl,seccomp,sendto,recvfrom,sendmsg,recvmsg",
];

export const LIMITATIONS = [
  "Only `codex sandbox` runs: no app-server, thread, model turn or Claudexor review, so model-driven project reading remains unproven.",
  "A GitHub-hosted Ubuntu 24.04 VM is not the #337 host; no result here establishes or excludes the original cause.",
  "The transient unit carries only the reported hardening; the original unit's other properties, environment, PATH and writable paths are unknown.",
  "The helper is chosen only through PATH, Codex's own rule; strace and kernel log files are raw diagnostics, not verdicts.",
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
  if (!sudo) gaps.push("non-interactive sudo is unavailable for the transient unit and kernel log");
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

/** Deterministic facts only: exit status, our nonce and marker, namespace ids,
 * host file existence. Vendor stderr stays raw evidence, never a verdict input. */
export function classifyCell(expectedNonce, observations) {
  const { read, write, identity } = observations?.probes ?? {};
  const outside = observations?.outside?.namespaces ?? {};
  const inside = parseKeyValues(identity?.stdout);
  const facts = {
    controlRead: observations?.controls?.read === expectedNonce,
    controlWrite: observations?.controls?.write?.ok === true,
    readNonce: exitedZero(read) && read.stdout.trim() === expectedNonce,
    namespaceEvidence:
      exitedZero(identity) && Boolean(inside.user && inside.mnt && outside.user && outside.mnt),
    isolated: Boolean(inside.user) && inside.user !== outside.user && inside.mnt !== outside.mnt,
    writeStarted: String(write?.stdout ?? "").includes(WRITE_STARTED),
    writeFailedCleanly: failedCleanly(write),
    writeLanded: write?.targetExists === true,
  };
  const verdict = (name, reason) => ({ verdict: name, reason, facts });
  if (facts.writeLanded)
    return verdict("write_not_refused", "the sandboxed write reached the host file");
  if (!facts.controlRead || !facts.controlWrite)
    return verdict("inconclusive", "outside Codex the same user could not read the nonce or write");
  if (!facts.readNonce)
    return verdict("capability_failed", "codex sandbox did not return the project nonce");
  if (!facts.namespaceEvidence)
    return verdict("inconclusive", "namespace identity inside or outside the sandbox is unknown");
  if (!facts.isolated)
    return verdict("not_isolated", "the command ran in the caller's user or mount namespace");
  if (!facts.writeStarted || !facts.writeFailedCleanly)
    return verdict(
      "inconclusive",
      "the write did not start inside, exited 0, or ended by signal, error or timeout",
    );
  return verdict("proven", "nonce read, write refused without host effect, new namespaces");
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

/** Raw dmesg captures before and after a cell; unknown is never zero. */
export function kernelLogState(before, after) {
  if (!exitedZero(before) || !exitedZero(after)) return "unavailable";
  return after.stdout.startsWith(before.stdout) ? "captured" : "rotated";
}

/** `proven` needs every cell proven, every service geometry established and
 * every disposable unit settled; a landed write outranks everything. */
export function summarize(cells) {
  const problems = [];
  for (const cell of cells) {
    if (cell.geometry !== "service") continue;
    if (!cell.serviceGeometry?.established)
      problems.push(
        `${cell.id}: requested service geometry not established (${(cell.serviceGeometry?.mismatches ?? ["no observations"]).join("; ")})`,
      );
    if (cell.unitSettled !== true) problems.push(`${cell.id}: transient unit not shown stopped`);
  }
  const verdicts = cells.map((cell) => cell.verdict);
  const outcome = verdicts.includes("write_not_refused")
    ? "write_not_refused"
    : verdicts.length > 0 && verdicts.every((verdict) => verdict === "proven") && !problems.length
      ? "proven"
      : "not_proven";
  return { outcome, problems };
}

export function exitCodeFor(outcome) {
  if (outcome === "proven") return 0;
  return outcome === "unsupported" || outcome === "harness_error" ? 2 : 1;
}

export function renderSummary(summary) {
  const lines = [`# Linux Codex readonly probe (claudexor#337): ${summary.outcome}`, ""];
  for (const item of [...(summary.gaps ?? []), ...(summary.problems ?? [])])
    lines.push(`- ${item}`);
  if (summary.error) lines.push(`- harness error: ${summary.error.split("\n")[0]}`);
  if (summary.cells?.length) {
    lines.push("", "| cell | verdict | reason | service geometry | unit settled | kernel log |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const cell of summary.cells) {
      const geometry =
        cell.geometry === "service"
          ? cell.serviceGeometry?.established
            ? "established"
            : "not established"
          : "direct";
      const settled = cell.geometry === "service" ? String(cell.unitSettled) : "n/a";
      lines.push(
        `| ${cell.id} | ${cell.verdict} | ${cell.reason} | ${geometry} | ${settled} | ${cell.kernelLog} |`,
      );
    }
  }
  lines.push("", "Raw evidence per cell: cells/<cell>/ in the uploaded artifact.", "", "Limits:");
  lines.push(...LIMITATIONS.map((limit) => `- ${limit}`), "");
  return lines.join("\n");
}
