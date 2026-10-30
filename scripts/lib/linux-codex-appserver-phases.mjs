/** Pure parts of the Linux Codex app-server probe that span cells: the pinned Codex bytes,
 * the reported service geometry and its disposable unit, host-state reads and their
 * differences, the phase sequence with its stop rules, harness defects and the summary.
 * Pins, the unit lifecycle and the kernel-log helpers are carried over from the fixed
 * `codex sandbox` probe (bdd217377a9f, scripts/lib/linux-codex-readonly-probe.mjs). */
import { parseKeyValues } from "./linux-codex-appserver-cell.mjs";

export const TARGET_TRIPLE = "x86_64-unknown-linux-musl";

/** Codex 0.162.1 as exact public npm bytes: registry integrity of each tarball, then the
 * launcher, native binary and bundled bwrap. */
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

export function digestMismatches(digests) {
  return Object.entries(CODEX_PIN.sha256)
    .filter(([name, pinned]) => digests[name] !== pinned)
    .map(([name, pinned]) => `${name} sha256 ${digests[name]} is not pinned ${pinned}`);
}

/** The reported service hardening; every other property keeps its systemd default. */
export const REPORTED_SERVICE_PROPERTIES = [
  "NoNewPrivileges=yes",
  "ProtectSystem=strict",
  "ProtectHome=no",
  "PrivateNetwork=no",
  "PrivateUsers=no",
  "RestrictNamespaces=no",
];
/** Deliberate geometry addition, not part of the #337 report: the unit's network is closed to
 * everything but loopback, so a misapplied provider redirect cannot reach a real endpoint. The
 * worker verifies it (an immediate EPERM) before any thread or daemon starts. */
export const EGRESS_PROPERTIES = ["IPAddressDeny=any", "IPAddressAllow=localhost"];
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
  "IPAddressDeny",
  "IPAddressAllow",
];

export const USERNS_RESTRICTION = "kernel.apparmor_restrict_unprivileged_userns";
export const RECORDED_SYSCTLS = [
  "kernel.unprivileged_userns_clone",
  USERNS_RESTRICTION,
  "kernel.apparmor_restrict_unprivileged_unconfined",
  "user.max_user_namespaces",
  "kernel.printk_ratelimit",
  "kernel.printk_ratelimit_burst",
];
/** The PATH a systemd service gets; the managed spawn prepends its own prefixes to it. */
export const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const SYSTEM_BWRAP = "/usr/bin/bwrap";
export const APPARMOR_PROFILES = "/sys/kernel/security/apparmor/profiles";

/** argv for `sudo`: the worker as the main process of a disposable system unit, run as the
 * same normal user with the reported hardening, only loopback networking and only its cell
 * directory writable. */
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
    ...[...REPORTED_SERVICE_PROPERTIES, ...EGRESS_PROPERTIES].flatMap((property) => [
      "-p",
      property,
    ]),
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

/** Runs `command` in the unit, then settles exactly that unit however the wait ended: reads
 * its state, stops it (which ends every process in its cgroup) and reads it again. */
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

export function exitedZero(result) {
  return Boolean(result) && result.status === 0 && !result.signal && !result.error;
}

/** Why the unit's start step does not show the cell worker finishing on its own, or null.
 * Any spawn error counts, ENOBUFS included: spawnSync then killed `systemd-run` mid-output, so
 * the worker's record is incomplete (the bdd21737 fix: such an end is never "settled"). */
export function workerEndProblem(start) {
  if (exitedZero(start)) return null;
  if (!start) return "the cell worker left no start record";
  if (start.error) return `the cell worker's unit run failed (${start.error})`;
  if (start.signal) return `the cell worker's unit run ended by ${start.signal}`;
  return `the cell worker exited ${start.status}`;
}

function lines(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/** Whether the unit carried the requested hardening, from the worker's own view. */
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

/** Kernel lines a cell added between two dmesg captures; unknown is never empty. */
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

/** AppArmor audit lines grouped by everything but pid and time, plus the printk limiter's
 * own count of dropped lines. `execpath` names the executable that created a namespace. */
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

/** Wait before each cell so its audit lines get a fresh printk rate-limit window. */
export function kernelLogPauseMs(sysctl) {
  const seconds = Number.parseInt(sysctl?.["kernel.printk_ratelimit"] ?? "", 10);
  return (Number.isInteger(seconds) && seconds >= 0 ? Math.min(seconds, 30) + 1 : 6) * 1000;
}

// ---- host state and phases ----

/** One read of everything a phase may change: sysctls, the kernel's sorted profile lines
 * (null when unreadable) and the profile file a control phase installs. */
export function hostState(sysctl, profiles, installFile) {
  return {
    sysctl: sysctl ?? {},
    profiles: exitedZero(profiles)
      ? lines(profiles.stdout)
          .map((line) => line.trim())
          .sort()
      : null,
    installFile: installFile ?? null,
  };
}

function fileLabel(file) {
  if (!file) return "unreadable";
  return file.exists
    ? `${file.type} ${file.sha256 ?? "?"} mode ${file.mode} ${file.uid}:${file.gid}`
    : "absent";
}

/** Every recorded difference between two host states, as plain lines. */
export function stateDifferences(before, after) {
  const changes = [];
  for (const name of new Set([...Object.keys(before.sysctl), ...Object.keys(after.sysctl)]))
    if (before.sysctl[name] !== after.sysctl[name])
      changes.push(
        `${name} ${before.sysctl[name] ?? "unreadable"} -> ${after.sysctl[name] ?? "unreadable"}`,
      );
  if (fileLabel(before.installFile) !== fileLabel(after.installFile))
    changes.push(
      `profile file ${fileLabel(before.installFile)} -> ${fileLabel(after.installFile)}`,
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

function stateGaps(state) {
  const gaps = [];
  if (state.error) gaps.push(`host state read failed: ${state.error}`);
  if (state.profiles === null) gaps.push("the loaded AppArmor profile list is unreadable");
  if (!state.sysctl?.[USERNS_RESTRICTION]) gaps.push(`${USERNS_RESTRICTION} is unreadable`);
  if (!state.installFile) gaps.push("the profile file state is unreadable");
  return gaps;
}

/** The ordered phases. The last two run only when the distro profile failed for the system
 * helper while every earlier phase ended verified (`when: "distro_failed"`): one comparison
 * with the prior minimal per-binary profile (bdd217377a9f), to tell a stacking/NoNewPrivileges
 * effect of the distro profile from no remedy at all. It is not a product fallback. */
export const PHASES = [
  { id: "baseline", change: null },
  {
    id: "distro-profile",
    control: "distro",
    change:
      "Ubuntu noble apparmor-profiles bwrap-userns-restrict copied to /etc/apparmor.d and loaded",
  },
  { id: "restored-baseline", change: null },
  {
    id: "minimal-profile",
    control: "minimal",
    when: "distro_failed",
    change:
      "comparison only: the prior minimal `flags=(unconfined) { userns, }` profile for /usr/bin/bwrap loaded from a file",
  },
  { id: "minimal-restored", change: null, when: "distro_failed" },
];
/** `system` and `bundled` drive one app-server directly; `daemon` runs the real daemon route
 * with the system helper. */
export const CELLS = [
  { id: "system", kind: "appserver", helper: "system" },
  { id: "bundled", kind: "appserver", helper: "bundled" },
  { id: "daemon", kind: "daemon", helper: "system" },
];

/** The prior minimal per-binary control, byte for byte as bdd217377a9f loaded it. */
export const MINIMAL_BWRAP_PROFILE = [
  "# claudexor#337 diagnostic control: loaded for one probe phase on a disposable runner, then removed.",
  "abi <abi/4.0>,",
  "include <tunables/global>",
  "",
  `profile bwrap ${SYSTEM_BWRAP} flags=(unconfined) {`,
  "  userns,",
  "}",
  "",
].join("\n");

/** The applied change is exactly the expected profiles added (any mode) and, when `sha256` is
 * set, those bytes at the install path; with `sha256: null` the install path must not change. */
export function changeVerified(before, applied, { names, sha256 }) {
  const differences = stateDifferences(before, applied);
  const added = differences.filter(
    (line) => line.startsWith("profile ") && line.endsWith(" added"),
  );
  const addedNames = added.map((line) => line.slice("profile ".length).split(" (")[0]).sort();
  const fileChanged = differences.some((line) => line.startsWith("profile file "));
  const others = differences.filter(
    (line) => !added.includes(line) && !line.startsWith("profile file "),
  );
  const fileVerified =
    sha256 === null
      ? !fileChanged
      : applied.installFile?.exists === true && applied.installFile.sha256 === sha256;
  const verified =
    !stateGaps(applied).length &&
    JSON.stringify(addedNames) === JSON.stringify([...names].sort()) &&
    others.length === 0 &&
    fileVerified;
  return { verified, differences };
}

const UNKNOWN_VERDICTS = ["capture_unknown", "rpc_error", "unknown"];
const ACCESS_MODES = ["readonly", "workspace_write", "full"];
const MODEL_PATH_MISSING = ["no_model_request", "not_called"];

/** What the classified verdicts of a cell leave unknown or unexercised, without the cell's
 * name. One meaning for the phase controller (stop) and the summary (defect): a `not_read`,
 * `capability_failed` or refused write is data, a verdict that never saw the command or its
 * result is not. `namespaces` unknown only leaves readonly `inconclusive`. */
export function verdictGaps(cell) {
  const gaps = [];
  let unknownMode = false;
  for (const mode of ACCESS_MODES)
    if (UNKNOWN_VERDICTS.includes(cell.access?.[mode])) {
      unknownMode = true;
      gaps.push(`${mode} verdict unknown`);
    }
  if (cell.access?.anyUnknown && !unknownMode) gaps.push("a probe verdict unknown");
  for (const [label, verdict] of [
    ["scripted turn exec_command", cell.turn?.exec],
    ["daemon read", cell.daemon?.read],
  ]) {
    if (UNKNOWN_VERDICTS.includes(verdict)) gaps.push(`${label} verdict unknown`);
    else if (MODEL_PATH_MISSING.includes(verdict)) gaps.push(`${label} not exercised (${verdict})`);
  }
  return gaps;
}

/** Why a cell leaves later cells unsafe or its result unknown, or null. */
export function cellStop(cell) {
  if (cell.capture?.known === false) return `capture unknown (${cell.capture.problems.join("; ")})`;
  if (cell.cleanup?.known === false) return `cleanup unknown (${cell.cleanup.problems.join("; ")})`;
  const gaps = verdictGaps(cell);
  if (gaps.length) return `evidence not captured (${gaps.join("; ")})`;
  return null;
}

/** Whether the distro profile left the system helper with a known failure to read: the direct
 * `system` cell's readonly `capability_failed` or its turn `not_read`, or the `daemon` cell's
 * sandboxed read `not_read`. Inconclusive isolation evidence, a read that never ran and a route
 * that never reached the model are not a known failure. Null when no system-helper cell ran
 * there, so nothing is established. */
export function distroProfileFailed(cells) {
  const ran = cells.filter(
    (cell) => cell.phase === "distro-profile" && cell.helper === "system" && cell.verdict === "ran",
  );
  if (!ran.length) return null;
  const failing = ran.filter((cell) =>
    cell.kind === "daemon"
      ? cell.daemon?.read === "not_read"
      : cell.access?.readonly === "capability_failed" || cell.turn?.exec === "not_read",
  );
  return failing.length ? failing.map((cell) => cell.id) : [];
}

function conditionHolds(when, cells) {
  if (when !== "distro_failed") return { holds: true };
  const failing = distroProfileFailed(cells);
  if (failing === null)
    return { holds: false, reason: "no system-helper cell ran under distro-profile" };
  return failing.length
    ? { holds: true, reason: `distro-profile failed for ${failing.join(", ")}` }
    : { holds: false, reason: "the distro profile did not fail for the system helper" };
}

/** Runs the phases with injected effects; `controls[phase.control]` gives a control phase's
 * `preconditions(id, before)`, `apply(id)`, `restore(id, applied, before)` and `expected`
 * ({names, sha256}). A control phase changes the host only when its preconditions hold, runs
 * cells only when the applied state is exactly the intended change, and always restores a
 * change it attempted. A cell with unknown capture or cleanup or an unknown or unexercised
 * verdict (`verdictGaps`), or a phase that does not end in
 * its starting state, stops every later cell and phase. A conditional phase whose condition
 * does not hold is `skipped`, which is not a defect. */
export function runPhases({ snapshot, controls, runCell }) {
  const phases = [];
  const cells = [];
  let blocked = null;
  for (const { id, change, control, when } of PHASES) {
    const phase = {
      id,
      change: change ?? "none",
      ran: false,
      notRunReason: null,
      skipped: null,
      preconditionGaps: [],
      hostState: {},
      setup: null,
      restore: null,
      endState: null,
      error: null,
    };
    phases.push(phase);
    const phaseCells = [];
    const effects = control ? controls[control] : null;
    const read = (stage) => {
      let state;
      try {
        state = snapshot(id, stage);
      } catch (error) {
        state = {
          sysctl: {},
          profiles: null,
          installFile: null,
          error: String(error?.message ?? error),
        };
      }
      phase.hostState[stage] = state;
      return state;
    };
    const notRun = (reason) => {
      phase.notRunReason ??= reason;
      for (const plan of CELLS.slice(phaseCells.length))
        phaseCells.push({ phase: id, ...plan, verdict: "not_run", reason });
    };
    const condition = blocked ? null : conditionHolds(when, cells);
    if (blocked) notRun(blocked);
    else if (!condition.holds) {
      phase.skipped = condition.reason;
      for (const plan of CELLS)
        phaseCells.push({ phase: id, ...plan, verdict: "skipped", reason: condition.reason });
    } else {
      phase.condition = condition.reason ?? null;
      const before = read("before");
      phase.preconditionGaps = [
        ...stateGaps(before),
        ...(effects ? effects.preconditions(id, before) : []),
      ];
      if (phase.preconditionGaps.length)
        notRun(`precondition not met: ${phase.preconditionGaps.join("; ")}`);
      else {
        let applied = null;
        let attempted = false;
        try {
          let ready = true;
          if (effects) {
            attempted = true;
            applied = effects.apply(id);
            phase.setup = {
              ...applied,
              ...changeVerified(before, read("applied"), effects.expected),
            };
            ready = phase.setup.verified && !applied.refused;
          }
          if (!ready) notRun("the applied host state is not exactly the intended change");
          else {
            phase.ran = true;
            for (const plan of CELLS) {
              let cell;
              try {
                cell = { phase: id, ...runCell(id, plan) };
              } catch (error) {
                const reason = `the harness failed while running this cell: ${String(error?.message ?? error).split("\n")[0]}`;
                cell = {
                  phase: id,
                  ...plan,
                  verdict: "harness_error",
                  reason,
                  capture: { known: false, problems: [reason] },
                };
              }
              phaseCells.push(cell);
              const stop = cellStop(cell);
              if (stop) {
                blocked = `stopped after ${id}/${plan.id}: ${stop}`;
                break;
              }
            }
            if (blocked) notRun(blocked);
          }
        } catch (error) {
          phase.error = String(error?.stack ?? error);
          notRun("a harness error stopped this phase");
        } finally {
          // An attempt that threw still restores, from what the start state recorded.
          if (attempted) {
            try {
              phase.restore = effects.restore(id, applied, before);
            } catch (error) {
              phase.restore = { restored: false, gaps: [String(error?.message ?? error)] };
            }
          }
          const after = read("after");
          const differences = [...stateGaps(after), ...stateDifferences(before, after)];
          phase.endState = {
            differences,
            restored: differences.length === 0 && phase.restore?.restored !== false,
          };
          if (!phase.endState.restored)
            blocked ??= `the host state after ${id} was not verified as the state it started from`;
        }
      }
    }
    cells.push(...phaseCells);
  }
  return { phases, cells };
}
