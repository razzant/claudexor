import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  APPARMOR_PARSER,
  BWRAP_PROFILE,
  CODEX_PIN,
  CODEX_VERSION_OUTPUT,
  DIAGNOSTIC_CONTROL,
  LIMITATIONS,
  PHASE_READING,
  PHASES,
  REPORTED_SERVICE_PROPERTIES,
  SANDBOX_RUN_TIMEOUT_MS,
  STRACE_ARGS,
  SYSCTL,
  SYSTEM_BWRAP,
  UNIT_OUTER_TIMEOUT_MS,
  UNIT_RUNTIME_MAX_SEC,
  UNIT_TIMEOUT_STOP_SEC,
  USERNS_RESTRICTION,
  WRITE_STARTED,
  cellDefects,
  cellPlan,
  classifyCell,
  digestMismatches,
  exitCodeFor,
  hostState,
  kernelAudit,
  kernelLogDiff,
  kernelLogPauseMs,
  phaseOutcome,
  preconditionGaps,
  probeEnds,
  renderSummary,
  runInTransientUnit,
  runPhases,
  serviceGeometry,
  summarize,
  systemHelper,
  tracedHelper,
} from "./linux-codex-readonly-probe.mjs";
import { jobSection } from "./workflow-sections.mjs";

// Offline checks only: no Codex download, sudo, systemd unit, AppArmor or
// sysctl change and no model. The real Linux run is the diagnostic workflow;
// these pin what it may call proof and how its control phases change and
// restore the host.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(repoRoot, "scripts", "linux-codex-readonly-probe.mjs");
const WORKFLOW_PATH = join(repoRoot, ".github", "workflows", "linux-codex-readonly-probe.yml");
const DOC_PATH = join(repoRoot, "docs", "evidence", "linux-codex-readonly-probe.md");
const scratch = mkdtempSync(join(tmpdir(), "cx337-probe-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const NONCE = "cx337-0123456789abcdef0123456789abcdef";
const OUTSIDE = { user: "user:[4026531837]", mnt: "mnt:[4026531841]", net: "net:[4026531840]" };
const INSIDE =
  "user=user:[4026532301]\nmnt=mnt:[4026532302]\nnet=net:[4026532304]\napparmor=bwrap (unconfined)\n";
const SAME = "user=user:[4026531837]\nmnt=mnt:[4026531841]\nnet=net:[4026531840]\n";
const SAME_NET = "user=user:[4026532301]\nmnt=mnt:[4026532302]\nnet=net:[4026531840]\n";
const result = (status, stdout = "", stderr = "", extra = {}) => ({
  status,
  signal: null,
  error: null,
  stdout,
  stderr,
  ...extra,
});
const launched = result(0, `${CODEX_VERSION_OUTPUT}\n`);
const refused = {
  ...result(2, `${WRITE_STARTED}\n`, "x: Read-only file system\n"),
  targetExists: false,
};

function observed({ launch, read, identity, write, controls } = {}) {
  return {
    outside: { namespaces: OUTSIDE },
    controls: controls ?? { read: NONCE, write: { ok: true } },
    launch: launch ?? launched,
    probes: {
      read: read ?? result(0, `${NONCE}\n`),
      identity: identity ?? result(0, INSIDE),
      write: write ?? refused,
    },
  };
}

describe("cell verdicts", () => {
  it("proves only a nonce read, a cleanly refused write and new user, mount and network namespaces", () => {
    expect(classifyCell(NONCE, observed())).toMatchObject({
      verdict: "proven",
      facts: { codexLaunched: true, probesStarted: true, isolated: true },
    });
    // The #337 failure is the loopback setup of a new network namespace, so a
    // shared one can never be proof, however the filesystem behaves.
    expect(classifyCell(NONCE, observed({ identity: result(0, SAME_NET) }))).toMatchObject({
      verdict: "not_isolated",
      reason: "the command ran in the caller's net namespace",
    });
  });

  it("reports a pass-through stand-in as a write fault and a bare refusal as not isolated", () => {
    const landed = { ...result(0, `${WRITE_STARTED}\n`), targetExists: true };
    expect(
      classifyCell(NONCE, observed({ identity: result(0, SAME), write: landed })).verdict,
    ).toBe("write_not_refused");
    expect(classifyCell(NONCE, observed({ identity: result(0, SAME) }))).toMatchObject({
      verdict: "not_isolated",
      reason: "the command ran in the caller's user, mnt, net namespaces",
    });
  });

  it("calls a helper that dies before the command a capability failure, whatever it prints", () => {
    const dead = (stderr) =>
      observed({
        read: result(1, "", stderr),
        identity: result(1, "", stderr),
        write: { ...result(1, "", stderr), targetExists: false },
      });
    const loopback = "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n";
    expect(classifyCell(NONCE, dead(loopback))).toEqual({
      ...classifyCell(NONCE, dead("")),
      verdict: "capability_failed",
    });
    const wrongContent = observed({ read: result(0, "cx337-ffffffffffffffffffffffffffffffff\n") });
    expect(classifyCell(NONCE, wrongContent).verdict).toBe("capability_failed");
    // A sandbox that hangs until our timeout still ran: capability, not worker.
    const hung = observed({
      read: result(null, "", "", { signal: "SIGTERM", error: "ETIMEDOUT" }),
    });
    expect(classifyCell(NONCE, hung).verdict).toBe("capability_failed");
  });

  it("calls a Codex that never launched a worker defect, never a capability failure", () => {
    const enoent = result(null, "", "", { error: "ENOENT" });
    const missingModule = result(
      1,
      "",
      "Error: Cannot find module '/w/codex.js'\n  code: 'MODULE_NOT_FOUND'\n",
    );
    const cases = [
      // No node: neither the launch check nor any probe started.
      observed({
        launch: enoent,
        read: enoent,
        identity: enoent,
        write: { ...enoent, targetExists: false },
      }),
      // No launcher: node ran and exited before Codex existed.
      observed({
        launch: missingModule,
        read: missingModule,
        identity: missingModule,
        write: { ...missingModule, targetExists: false },
      }),
      observed({ launch: result(0, "codex-cli 0.153.3\n") }),
      { ...observed(), launch: undefined },
      observed({ read: result(null, "", "", { error: "EACCES" }) }),
    ];
    for (const observation of cases)
      expect(classifyCell(NONCE, observation).verdict, JSON.stringify(observation.launch)).toBe(
        "worker_defect",
      );
    expect(classifyCell(NONCE, cases[0]).facts).toMatchObject({
      codexLaunched: false,
      controlRead: true,
      controlWrite: true,
    });
  });

  it("never counts a write ended by signal, error or timeout as refused", () => {
    const ended = [
      { status: null, signal: "SIGKILL" },
      { status: 1, error: "ETIMEDOUT" },
      { status: 1, signal: "SIGTERM" },
      { status: 0 },
    ];
    for (const end of ended) {
      const write = { ...result(1, `${WRITE_STARTED}\n`, "", end), targetExists: false };
      expect(classifyCell(NONCE, observed({ write })).verdict).toBe("inconclusive");
    }
    const unstarted = { ...result(2, ""), targetExists: false };
    expect(classifyCell(NONCE, observed({ write: unstarted })).verdict).toBe("inconclusive");
  });

  it("keeps failed controls or unknown namespace ids inconclusive", () => {
    const cases = [
      observed({ controls: { read: NONCE, write: { ok: false, error: "EROFS" } } }),
      observed({ controls: { read: null, write: { ok: true } } }),
      observed({ identity: result(0, "user=\nmnt=\nnet=\n") }),
      observed({ identity: result(0, "user=user:[4026532301]\nmnt=mnt:[4026532302]\n") }),
      observed({ identity: result(1, INSIDE) }),
    ];
    for (const observation of cases)
      expect(classifyCell(NONCE, observation).verdict).toBe("inconclusive");
  });

  it("keeps how each probe ended, its time and first stderr line beside the verdict, never in it", () => {
    const loopback = "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
    const failing = observed({
      read: result(1, "", `\n${loopback}\nmore\n`, { ms: 812 }),
      identity: result(null, "", "", { signal: "SIGTERM", error: "ETIMEDOUT", ms: 60_004 }),
      write: { ...result(1, "", "a | b\n", { ms: 57_000 }), targetExists: false },
    });
    expect(probeEnds(failing)).toEqual({
      read: { ended: "exited 1", ms: 812, atTimeLimit: false, stderr: loopback },
      identity: { ended: "failed (ETIMEDOUT)", ms: 60_004, atTimeLimit: true, stderr: null },
      write: { ended: "exited 1", ms: 57_000, atTimeLimit: true, stderr: "a | b" },
    });
    expect(probeEnds({})).toEqual({ read: null, identity: null, write: null });
    // The same failure with no message or a different one is still the same verdict.
    expect(classifyCell(NONCE, failing)).toEqual(
      classifyCell(NONCE, { ...failing, probes: { ...failing.probes, read: result(1) } }),
    );
    expect(SANDBOX_RUN_TIMEOUT_MS).toBe(60_000);
  });
});

/** A cell that ran with all of its evidence; only the verdict varies. */
function ranCell(plan, verdict, extra = {}) {
  const service = plan.geometry === "service";
  return {
    ...plan,
    verdict,
    reason: verdict,
    facts: { controlRead: true, controlWrite: true },
    evidence: `phases/p/cells/${plan.id}`,
    worker: { status: 0, signal: null, error: null },
    unit: service ? `cx337-p-${plan.id}-abc123.service` : null,
    serviceGeometry: service ? { established: true, mismatches: [] } : null,
    unitSettled: service ? true : null,
    sandboxLabel: null,
    trace: { expected: true, recorded: true, helper: { kind: plan.helper, execs: [] } },
    kernelLog: { state: "captured", newLines: 0, apparmor: [], suppressed: 0 },
    ...extra,
  };
}

describe("service geometry and harness conclusion", () => {
  const unit = "cx337-baseline-service-system-abc123.service";
  const applied = {
    outside: { status: { NoNewPrivs: "1" } },
    unit: {
      name: unit,
      properties: Object.fromEntries(REPORTED_SERVICE_PROPERTIES.map((p) => p.split("="))),
    },
  };
  const [directSystem, , serviceSystem] = cellPlan();

  it("establishes geometry only from the worker's own unit, NoNewPrivs and systemctl values", () => {
    expect(serviceGeometry(applied, unit)).toEqual({ established: true, mismatches: [] });
    const permissive = { ...applied, outside: { status: { NoNewPrivs: "0" } } };
    expect(serviceGeometry(permissive, unit).mismatches).toEqual(["kernel NoNewPrivs is 0"]);
    expect(serviceGeometry(applied, "cx337-other.service").established).toBe(false);
    expect(serviceGeometry(null, unit).mismatches).toHaveLength(
      2 + REPORTED_SERVICE_PROPERTIES.length,
    );
  });

  it("lets a landed write outrank a phase and calls it proven only with four clean proofs", () => {
    const proven = cellPlan().map((plan) => ({ phase: "p", ...ranCell(plan, "proven") }));
    expect(phaseOutcome(proven)).toBe("proven");
    expect(phaseOutcome(proven.slice(1))).toBe("not_proven");
    const [first, second, third, fourth] = proven;
    expect(phaseOutcome([first, second, { ...third, unitSettled: false }, fourth])).toBe(
      "not_proven",
    );
    const notRun = cellPlan().map((plan) => ({ phase: "p", ...plan, verdict: "not_run" }));
    expect(phaseOutcome(notRun)).toBe("not_run");
    const landed = { ...first, verdict: "write_not_refused" };
    expect(phaseOutcome([landed, ...notRun.slice(1)])).toBe("write_not_refused");
    expect(phaseOutcome([landed, second, third, fourth])).toBe("write_not_refused");
  });

  it("treats sandbox verdicts as data and harness gaps as defects", () => {
    const failing = cellPlan().map((plan) => ({
      phase: "baseline",
      ...ranCell(plan, "capability_failed"),
    }));
    expect(failing.flatMap(cellDefects)).toEqual([]);
    const phase = { id: "baseline", preconditionGaps: [], endState: { restored: true } };
    expect(summarize([phase], failing)).toEqual({ outcome: "complete", defects: [] });
    expect(exitCodeFor("complete")).toBe(0);

    const at = (plan, extra) => ({ phase: "baseline", ...ranCell(plan, "proven", extra) });
    const broken = [
      at(directSystem, { worker: { status: 1, signal: null, error: null } }),
      at(directSystem, { kernelLog: { state: "unavailable", newLines: 0, apparmor: [] } }),
      at(directSystem, { trace: { expected: true, recorded: false, helper: { kind: "unknown" } } }),
      at(directSystem, { facts: { controlRead: true, controlWrite: false } }),
      at(serviceSystem, { serviceGeometry: { established: false, mismatches: ["x is unknown"] } }),
      at(serviceSystem, { unitSettled: false }),
      at(serviceSystem, {
        verdict: "worker_defect",
        reason: "the cell worker left no observations",
      }),
    ];
    expect(broken.map(cellDefects)).toEqual([
      ["baseline/direct-system: the cell worker exited 1"],
      ["baseline/direct-system: kernel log unavailable"],
      ["baseline/direct-system: the strace run left no trace"],
      ["baseline/direct-system: the outside read or write control failed"],
      ["baseline/service-system: requested service geometry not established (x is unknown)"],
      ["baseline/service-system: transient unit not shown stopped"],
      ["baseline/service-system: the cell worker left no observations"],
    ]);
    expect(summarize([phase], broken).outcome).toBe("incomplete");
    const outcomes = ["complete", "incomplete", "unsupported", "harness_error"];
    expect(outcomes.map(exitCodeFor)).toEqual([0, 1, 2, 2]);
  });

  it("diffs the kernel log per cell and keeps an unavailable one unknown rather than empty", () => {
    const ok = (stdout) => result(0, stdout);
    expect(kernelLogDiff(ok("a\n"), ok("a\nb\nc\n"))).toEqual({
      state: "captured",
      lines: ["b", "c"],
    });
    expect(kernelLogDiff(ok("a\nb\n"), ok("b\nz\n"))).toEqual({ state: "rotated", lines: ["z"] });
    expect(kernelLogDiff(ok("a\n"), ok("z\n"))).toEqual({ state: "rotated", lines: ["z"] });
    expect(kernelLogDiff(result(1, "", "sudo: a password is required\n"), ok("a\n")).state).toBe(
      "unavailable",
    );
    expect(kernelLogDiff(ok("a\n"), result(null, "", "", { error: "ENOENT" })).state).toBe(
      "unavailable",
    );
  });

  it("groups AppArmor audit lines and counts what the printk limiter dropped", () => {
    // Lines as run 40865743092 captured them in its first cell.
    const diff = [
      '[   44.602235] audit: type=1400 audit(1793273379.183:127): apparmor="AUDIT" operation="userns_create" class="namespace" info="Userns create - transitioning profile" profile="unconfined" pid=2738 comm="bwrap" requested="userns_create" target="unprivileged_userns" execpath="/usr/bin/bwrap"',
      '[   44.603329] audit: type=1400 audit(1793273379.184:128): apparmor="DENIED" operation="capable" class="cap" profile="unprivileged_userns" pid=2739 comm="bwrap" capability=8  capname="setpcap"',
      '[   44.603398] audit: type=1400 audit(1793273379.184:129): apparmor="DENIED" operation="capable" class="cap" profile="unprivileged_userns" pid=2739 comm="bwrap" capability=12  capname="net_admin"',
      '[   44.605414] audit: type=1400 audit(1793273379.186:130): apparmor="AUDIT" operation="userns_create" class="namespace" info="Userns create - transitioning profile" profile="unconfined" pid=2736 comm="bwrap" requested="userns_create" target="unprivileged_userns" execpath="/usr/bin/bwrap"',
      "[   50.100000] kauditd_printk_skb: 14 callbacks suppressed",
    ];
    expect(kernelAudit(diff)).toEqual({
      apparmor: [
        {
          apparmor: "AUDIT",
          operation: "userns_create",
          info: "Userns create - transitioning profile",
          profile: "unconfined",
          comm: "bwrap",
          target: "unprivileged_userns",
          execpath: "/usr/bin/bwrap",
          count: 2,
        },
        {
          apparmor: "DENIED",
          operation: "capable",
          profile: "unprivileged_userns",
          comm: "bwrap",
          capname: "setpcap",
          count: 1,
        },
        {
          apparmor: "DENIED",
          operation: "capable",
          profile: "unprivileged_userns",
          comm: "bwrap",
          capname: "net_admin",
          count: 1,
        },
      ],
      suppressed: 14,
    });
    expect(kernelLogPauseMs({ "kernel.printk_ratelimit": "5" })).toBe(6000);
    expect(kernelLogPauseMs({ "kernel.printk_ratelimit": "0" })).toBe(1000);
    expect(kernelLogPauseMs({ "kernel.printk_ratelimit": "600" })).toBe(31_000);
    expect(kernelLogPauseMs({})).toBe(6000);
  });
});

describe("traced helper", () => {
  const systemBwrap = "/usr/bin/bwrap";
  const bundledBwrap = "/w/codex/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap";
  const options = { systemBwrap, bundledBwrap: [bundledBwrap, null] };
  const exec = (pid, path, rest = ', "--as-pid-1", "--unshare-net"], ["PATH=/x"]) = 0') =>
    `${pid}  execve("${path}", ["bwrap"${rest}`;
  const started = (pid, path = systemBwrap) =>
    exec(pid, path, ', "--ro-bind", "/", "/"], ["PATH=/x"] <unfinished ...>');
  // strace -o pads a short line so that its ` = ` return starts at column 40.
  const padded = (head, value) => `${head.padEnd(40)}= ${value}`;
  const open = (pid, path, fd) => `${pid}  open("${path}", O_RDONLY|O_CLOEXEC) = ${fd}`;
  const ran = (pid, path, kind, openedAs = null) => ({ pid, path, openedAs, kind });

  it("counts an exec only when the trace shows it returned 0, joining split lines by pid", () => {
    const trace = [
      // Codex's feature probe runs bwrap under its full path as argv0.
      '2814  execve("/usr/bin/bwrap", ["/usr/bin/bwrap", "--help"], ["CODEX_HOME=/c"]) = 0',
      exec(2815, systemBwrap),
      started(2813),
      padded("2816  close(9)", "0"),
      padded("2813  <... execve resumed>)", "0"),
      // A non-leader thread's exec returns under the thread group leader.
      started(2820),
      "2819  +++ superseded by execve in pid 2820 +++",
      padded("2819  <... execve resumed>)", "0"),
    ].join("\n");
    expect(tracedHelper(trace, options)).toEqual({
      kind: "system",
      execs: [
        ran(2815, systemBwrap, "system"),
        ran(2813, systemBwrap, "system"),
        ran(2820, systemBwrap, "system"),
      ],
      failed: [],
      unresolved: [],
    });
  });

  it("keeps failed and unresolved exec attempts apart and never counts them as executed", () => {
    const attempt = ran(2813, systemBwrap, "system");
    const cases = [
      // A split exec that resumed with an error.
      [
        [
          started(2813),
          padded("2816  close(9)", "0"),
          padded("2813  <... execve resumed>)", "-1 EACCES (Permission denied)"),
        ],
        { failed: [{ ...attempt, errno: "EACCES" }], unresolved: [] },
      ],
      // A split exec whose continuation the trace never shows.
      [
        [started(2813), padded("2816  close(9)", "0")],
        { failed: [], unresolved: [{ ...attempt, returned: null }] },
      ],
      // A complete exec that failed.
      [
        [exec(2813, systemBwrap, '], ["PATH=/x"]) = -1 EACCES (Permission denied)')],
        { failed: [{ ...attempt, errno: "EACCES" }], unresolved: [] },
      ],
      // Another thread's return is not this thread's.
      [
        [started(2813), padded("2814  <... execve resumed>)", "0")],
        { failed: [], unresolved: [{ ...attempt, returned: null }] },
      ],
      // Killed inside the exec, with or without strace's unknown return.
      [
        [
          started(2813),
          padded("2813  <... execve resumed>)", "?"),
          "2813  +++ killed by SIGKILL +++",
        ],
        { failed: [], unresolved: [{ ...attempt, returned: "?" }] },
      ],
      [
        [started(2813), "2813  +++ killed by SIGKILL +++", padded("2813  close(4)", "0")],
        { failed: [], unresolved: [{ ...attempt, returned: null }] },
      ],
    ];
    for (const [lines, attempts] of cases)
      expect(tracedHelper(lines.join("\n"), options), lines.join("\n")).toEqual({
        kind: "none",
        execs: [],
        ...attempts,
      });
    const retried = [
      exec(2813, systemBwrap, '], ["PATH=/x"]) = -1 EACCES (Permission denied)'),
      exec(2813, systemBwrap),
    ];
    expect(tracedHelper(retried.join("\n"), options)).toMatchObject({
      kind: "system",
      execs: [attempt],
      failed: [{ ...attempt, errno: "EACCES" }],
    });
  });

  it("only infers the file behind /proc/self/fd/N, from a hint a close or reassignment drops", () => {
    const fdExec = (pid, fd) => exec(pid, `/proc/self/fd/${fd}`);
    const bound = [
      '2925  openat(AT_FDCWD, "/etc/ld-musl-x86_64.path", O_RDONLY|O_CLOEXEC) = -1 ENOENT (No such file or directory)',
      open(2925, "/w/other", 3),
      open(2925, bundledBwrap, 3),
      `2926  openat(AT_FDCWD, "${bundledBwrap}", O_RDONLY|O_CLOEXEC <unfinished ...>`,
      padded("2925  close(9)", "0"),
      padded("2926  <... openat resumed>)", "4"),
      fdExec(2925, 3),
      fdExec(2926, 4),
    ].join("\n");
    expect(tracedHelper(bound, options)).toEqual({
      kind: "bundled (inferred)",
      execs: [
        ran(2925, "/proc/self/fd/3", "bundled (inferred)", bundledBwrap),
        ran(2926, "/proc/self/fd/4", "bundled (inferred)", bundledBwrap),
      ],
      failed: [],
      unresolved: [],
    });
    // Closed or replaced before the exec, by this thread or one sharing its
    // descriptors, or a new task or program under the pid: the hint is gone.
    for (const between of [
      [padded("2925  close(3)", "0"), padded("2925  dup2(7, 3)", "3")],
      [padded("2925  dup2(7, 3)", "3")],
      ["2925  dup3(7, 3, O_CLOEXEC)                  = 3"],
      [padded("2931  close(3)", "0")],
      ["2931  close(3 <unfinished ...>"],
      ["2931  close_range(3, 4294967295, 0)          = 0"],
      ["2931  close_range(3, ~0, CLOSE_RANGE_UNSHARE) = 0"],
      ["2925  +++ exited with 0 +++"],
      [
        "2900  clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f) = 2925",
      ],
      ['2925  execve("/bin/true", ["true"], ["PATH=/x"]) = 0'],
    ]) {
      const trace = [open(2925, bundledBwrap, 3), ...between, fdExec(2925, 3)].join("\n");
      expect(tracedHelper(trace, options).execs, between.join("\n")).toEqual([
        ran(2925, "/proc/self/fd/3", "bundled (inferred)"),
      ]);
    }
    // A later open of N is the hint instead, and still inferred.
    for (const [file, kind] of [
      ["/w/other", "other (inferred)"],
      [systemBwrap, "system (inferred)"],
    ]) {
      const reopened = [
        open(2925, bundledBwrap, 3),
        padded("2925  close(3)", "0"),
        open(2925, file, 3),
      ];
      expect(tracedHelper([...reopened, fdExec(2925, 3)].join("\n"), options).execs).toEqual([
        ran(2925, "/proc/self/fd/3", kind, file),
      ]);
    }
    // Another thread's open of N says nothing about this thread's N.
    const unbound = [open(2925, bundledBwrap, 3), fdExec(2930, 3)];
    expect(tracedHelper(unbound.join("\n"), options).execs).toEqual([
      ran(2930, "/proc/self/fd/3", "bundled (inferred)"),
    ]);
    // Only an exec under the installed helper's own path names it.
    expect(tracedHelper(exec(2925, bundledBwrap), options).kind).toBe("bundled");
  });

  it("reports missing, foreign and mixed execs as such", () => {
    const empty = { execs: [], failed: [], unresolved: [] };
    expect(tracedHelper("", options)).toEqual({ kind: "none", ...empty });
    expect(tracedHelper(null, options)).toEqual({ kind: "unknown", ...empty });
    expect(tracedHelper(exec(1, "/opt/bwrap"), options).kind).toBe("other");
    const mixed = [exec(1, systemBwrap), exec(2, "/proc/self/fd/3")].join("\n");
    expect(tracedHelper(mixed, options).kind).toBe("mixed");
    const [filter, ...traced] = STRACE_ARGS.at(-1).split(/[=,]/);
    expect(filter).toBe("trace");
    expect(traced).toEqual(
      expect.arrayContaining([
        ...["execve", "open", "openat", "close", "close_range", "dup2", "dup3"],
        ...["clone", "clone3", "socket", "ioctl", "sendmsg", "recvmsg"],
      ]),
    );
  });
});

describe("control phases", () => {
  const PROFILE_FILE = "/out/phases/apparmor-bwrap-profile/bwrap.apparmor";
  const ORIGINAL_PROFILES = ["docker-default (enforce)", "unprivileged_userns (enforce)"];

  /** A host whose two restrictions the fake tools really change, and whose
   * cells pass only where the restriction no longer applies to their helper.
   * `cell(phase, plan)` may override fields of a cell's record. */
  function fakeHost({
    restriction = "1",
    profiles = ORIGINAL_PROFILES,
    systemBwrap = systemHelper(SYSTEM_BWRAP, SYSTEM_BWRAP),
    tool,
    cellThrows,
    cell,
  } = {}) {
    const host = {
      sysctl: { [USERNS_RESTRICTION]: restriction, "kernel.printk_ratelimit": "5" },
      profiles: [...profiles],
      profilesReadable: true,
    };
    const log = [];
    const snapshot = (phase, stage) => {
      log.push(`${phase} snapshot ${stage}`);
      const listing = host.profilesReadable
        ? result(0, `${host.profiles.join("\n")}\n`)
        : result(1, "", "sudo: a password is required\n");
      return hostState({ ...host.sysctl }, listing);
    };
    const command = (phase, step, args) => {
      log.push(`${phase} ${step} sudo ${args.join(" ")}`);
      const custom = tool?.(step, args, host);
      if (custom) return custom;
      const [, file, flag, value] = args;
      if (file === APPARMOR_PARSER && flag === "-r") host.profiles.push("bwrap (unconfined)");
      if (file === APPARMOR_PARSER && flag === "-R")
        host.profiles = host.profiles.filter((line) => !line.startsWith("bwrap ("));
      if (file === SYSCTL && flag === "-w") {
        const [name, setting] = value.split("=");
        host.sysctl[name] = setting;
      }
      return result(0);
    };
    const runCell = (phase, plan) => {
      log.push(`${phase} cell ${plan.id}`);
      if (cellThrows?.(phase, plan)) throw new Error("boom\nat stack");
      const relaxed =
        host.sysctl[USERNS_RESTRICTION] === "0" ||
        (plan.helper === "system" && host.profiles.includes("bwrap (unconfined)"));
      return ranCell(plan, relaxed ? "proven" : "capability_failed", cell?.(phase, plan));
    };
    return {
      host,
      log,
      run: (options = {}) =>
        runPhases({
          snapshot,
          command,
          runCell,
          profileFile: PROFILE_FILE,
          systemBwrap,
          ...options,
        }),
    };
  }

  const matrix = (cells) =>
    Object.fromEntries(
      PHASES.map(({ id }) => [
        id,
        cells.filter((cell) => cell.phase === id).map((cell) => `${cell.id}=${cell.verdict}`),
      ]),
    );

  it("runs baseline, profile and sysctl phases over all four cells, reverting each change", () => {
    const fake = fakeHost();
    const { phases, cells } = fake.run();
    const cellsOf = (phase) => cellPlan().map((plan) => `${phase} cell ${plan.id}`);
    expect(fake.log).toEqual([
      "baseline snapshot before",
      ...cellsOf("baseline"),
      "baseline snapshot after",
      "apparmor-bwrap-profile snapshot before",
      `apparmor-bwrap-profile setup sudo -n ${APPARMOR_PARSER} -r ${PROFILE_FILE}`,
      "apparmor-bwrap-profile snapshot applied",
      ...cellsOf("apparmor-bwrap-profile"),
      `apparmor-bwrap-profile restore sudo -n ${APPARMOR_PARSER} -R ${PROFILE_FILE}`,
      "apparmor-bwrap-profile snapshot after",
      "userns-sysctl-relaxed snapshot before",
      `userns-sysctl-relaxed setup sudo -n ${SYSCTL} -w ${USERNS_RESTRICTION}=0`,
      "userns-sysctl-relaxed snapshot applied",
      ...cellsOf("userns-sysctl-relaxed"),
      `userns-sysctl-relaxed restore sudo -n ${SYSCTL} -w ${USERNS_RESTRICTION}=1`,
      "userns-sysctl-relaxed snapshot after",
    ]);
    expect(cells).toHaveLength(PHASES.length * cellPlan().length);
    expect(matrix(cells)).toEqual({
      baseline: [
        "direct-system=capability_failed",
        "direct-bundled=capability_failed",
        "service-system=capability_failed",
        "service-bundled=capability_failed",
      ],
      "apparmor-bwrap-profile": [
        "direct-system=proven",
        "direct-bundled=capability_failed",
        "service-system=proven",
        "service-bundled=capability_failed",
      ],
      "userns-sysctl-relaxed": [
        "direct-system=proven",
        "direct-bundled=proven",
        "service-system=proven",
        "service-bundled=proven",
      ],
    });
    const [baseline, profile, relaxed] = phases;
    expect(baseline).toMatchObject({
      ran: true,
      setup: null,
      restore: null,
      endState: { restored: true, differences: [] },
      sandboxOutcome: "not_proven",
      verdicts: { capability_failed: 4 },
    });
    expect(profile).toMatchObject({
      ran: true,
      setup: {
        argv: ["sudo", "-n", APPARMOR_PARSER, "-r", PROFILE_FILE],
        status: 0,
        verified: true,
        differences: ["profile bwrap (unconfined) added"],
      },
      restore: { argv: ["sudo", "-n", APPARMOR_PARSER, "-R", PROFILE_FILE], status: 0 },
      endState: { restored: true },
      sandboxOutcome: "not_proven",
    });
    expect(
      ["before", "applied", "after"].map((stage) => profile.hostState[stage].profiles.bwrap),
    ).toEqual([null, "bwrap (unconfined)", null]);
    expect(relaxed.setup.differences).toEqual([`${USERNS_RESTRICTION} 1 -> 0`]);
    expect(
      ["before", "applied", "after"].map(
        (stage) => relaxed.hostState[stage].sysctl[USERNS_RESTRICTION],
      ),
    ).toEqual(["1", "0", "1"]);
    expect(relaxed.sandboxOutcome).toBe("proven");
    expect(fake.host).toMatchObject({
      sysctl: { [USERNS_RESTRICTION]: "1" },
      profiles: ORIGINAL_PROFILES,
    });
    expect(summarize(phases, cells)).toEqual({ outcome: "complete", defects: [] });
  });

  it("does not touch a host that differs from the reported restriction", () => {
    for (const [options, gap] of [
      [{ restriction: "0" }, `${USERNS_RESTRICTION} is 0, not 1`],
      [
        { profiles: [...ORIGINAL_PROFILES, "bwrap (enforce)"] },
        "a profile named bwrap is already loaded",
      ],
    ]) {
      const fake = fakeHost(options);
      const { phases, cells } = fake.run();
      expect(fake.log.filter((line) => / (setup|restore) /.test(line))).toEqual([]);
      expect(phases.map((phase) => phase.ran)).toEqual([true, false, false]);
      expect(phases[1].preconditionGaps).toEqual([gap]);
      for (const cell of cells.filter((cell) => cell.phase !== "baseline"))
        expect(cell).toMatchObject({ verdict: "not_run", reason: `precondition not met: ${gap}` });
      const conclusion = summarize(phases, cells);
      expect(conclusion.outcome).toBe("incomplete");
      expect(conclusion.defects).toContain(
        `apparmor-bwrap-profile: planned cells not run (precondition not met: ${gap})`,
      );
      expect(exitCodeFor(conclusion.outcome)).toBe(1);
    }
  });

  it("runs no cell under an unverified change and still reverts the attempt", () => {
    const fake = fakeHost({
      tool: (step, args) =>
        args[1] === APPARMOR_PARSER
          ? result(1, "", step === "setup" ? "AppArmor parser error\n" : "Profile doesn't exist\n")
          : null,
    });
    const { phases, cells } = fake.run();
    const [, profile, relaxed] = phases;
    expect(profile).toMatchObject({
      ran: false,
      setup: { status: 1, verified: false, differences: [] },
      restore: { argv: ["sudo", "-n", APPARMOR_PARSER, "-R", PROFILE_FILE], status: 1 },
      endState: { restored: true },
      sandboxOutcome: "not_run",
    });
    expect(fake.log).not.toContain("apparmor-bwrap-profile cell direct-system");
    // Its end state was verified, so the next phase still runs.
    expect(relaxed).toMatchObject({ ran: true, sandboxOutcome: "proven" });
    expect(summarize(phases, cells).defects).toEqual([
      "apparmor-bwrap-profile: planned cells not run (the applied host state is not exactly the intended change)",
      "apparmor-bwrap-profile: change not verified after setup (no difference)",
    ]);

    // A change that brings anything else with it is not the controlled change.
    const noisy = fakeHost({
      tool: (step, args, host) => {
        if (args[1] !== APPARMOR_PARSER || step !== "setup") return null;
        host.profiles.push("bwrap (unconfined)", "stray (enforce)");
        return result(0);
      },
    });
    const run = noisy.run();
    expect(run.phases[1].setup).toMatchObject({
      verified: false,
      differences: ["profile bwrap (unconfined) added", "profile stray (enforce) added"],
    });
    expect(run.phases[1].endState).toEqual({
      restored: false,
      differences: ["profile stray (enforce) added"],
    });
  });

  it("blocks every later phase when a restore is not verified", () => {
    const fake = fakeHost({
      tool: (step, args) =>
        step === "restore" && args[1] === APPARMOR_PARSER ? result(1, "", "busy\n") : null,
    });
    const { phases, cells } = fake.run();
    expect(phases[1].endState).toEqual({
      restored: false,
      differences: ["profile bwrap (unconfined) added"],
    });
    const blocked =
      "the host state after apparmor-bwrap-profile was not verified as the state it started from";
    expect(phases[2]).toMatchObject({
      ran: false,
      notRunReason: blocked,
      setup: null,
      endState: null,
    });
    expect(fake.log.some((line) => line.startsWith("userns-sysctl-relaxed"))).toBe(false);
    expect(cells.filter((cell) => cell.phase === "userns-sysctl-relaxed")).toEqual(
      cellPlan().map((plan) => ({
        phase: "userns-sysctl-relaxed",
        ...plan,
        verdict: "not_run",
        reason: blocked,
        facts: null,
      })),
    );
    expect(summarize(phases, cells).defects).toEqual([
      "apparmor-bwrap-profile: host state not restored (profile bwrap (unconfined) added)",
      `userns-sysctl-relaxed: planned cells not run (${blocked})`,
    ]);

    const sysctlStuck = fakeHost({
      tool: (step, args) => (step === "restore" && args[1] === SYSCTL ? result(255) : null),
    });
    const stuck = sysctlStuck.run();
    expect(stuck.phases[2].endState).toEqual({
      restored: false,
      differences: [`${USERNS_RESTRICTION} 1 -> 0`],
    });
    expect(summarize(stuck.phases, stuck.cells).outcome).toBe("incomplete");
  });

  it("keeps a cell the harness could not run as a worker defect, reverts and stops", () => {
    const fake = fakeHost({
      cellThrows: (phase, plan) =>
        phase === "apparmor-bwrap-profile" && plan.id === "direct-system",
    });
    const { phases, cells } = fake.run();
    expect(cells.find((cell) => cell.phase === "apparmor-bwrap-profile")).toEqual({
      phase: "apparmor-bwrap-profile",
      ...cellPlan()[0],
      verdict: "worker_defect",
      reason: "the harness failed while running this cell: boom",
      facts: null,
    });
    // Without a record of how its worker ended, the cell may have left one running.
    const stopped =
      "the comparison stopped after apparmor-bwrap-profile/direct-system: the harness has no record of how its worker ended, so a process it started may still be running";
    expect(matrix(cells)["apparmor-bwrap-profile"]).toEqual([
      "direct-system=worker_defect",
      "direct-bundled=not_run",
      "service-system=not_run",
      "service-bundled=not_run",
    ]);
    expect(fake.log).toContain(
      `apparmor-bwrap-profile restore sudo -n ${APPARMOR_PARSER} -R ${PROFILE_FILE}`,
    );
    expect(phases[1]).toMatchObject({
      notRunReason: stopped,
      endState: { restored: true },
      sandboxOutcome: "not_proven",
    });
    expect(phases[2]).toMatchObject({ ran: false, notRunReason: stopped, setup: null });
    expect(summarize(phases, cells).defects).toEqual([
      `apparmor-bwrap-profile: planned cells not run (${stopped})`,
      `userns-sysctl-relaxed: planned cells not run (${stopped})`,
      "apparmor-bwrap-profile/direct-system: the harness failed while running this cell: boom",
    ]);
  });

  it("stops the comparison after a cell whose processes are not shown to have ended", () => {
    const at = (phaseId, cellId, extra) =>
      fakeHost({ cell: (phase, plan) => (phase === phaseId && plan.id === cellId ? extra : {}) });
    const stoppedAfter = (where, why) =>
      `the comparison stopped after ${where}: ${why}, so a process it started may still be running`;

    // An unsettled baseline unit: no control phase changes the host at all.
    const fake = at("baseline", "service-system", { unitSettled: false });
    const { phases, cells } = fake.run();
    const stopped = stoppedAfter(
      "baseline/service-system",
      "its transient unit was not shown stopped",
    );
    expect(fake.log).toEqual([
      "baseline snapshot before",
      "baseline cell direct-system",
      "baseline cell direct-bundled",
      "baseline cell service-system",
      "baseline snapshot after",
    ]);
    expect(fake.host.sysctl[USERNS_RESTRICTION]).toBe("1");
    expect(matrix(cells)).toEqual({
      baseline: [
        "direct-system=capability_failed",
        "direct-bundled=capability_failed",
        "service-system=capability_failed",
        "service-bundled=not_run",
      ],
      "apparmor-bwrap-profile": cellPlan().map((plan) => `${plan.id}=not_run`),
      "userns-sysctl-relaxed": cellPlan().map((plan) => `${plan.id}=not_run`),
    });
    for (const cell of cells.filter((cell) => cell.verdict === "not_run"))
      expect(cell.reason).toBe(stopped);
    expect(phases.map((phase) => phase.sandboxOutcome)).toEqual([
      "not_proven",
      "not_run",
      "not_run",
    ]);
    const conclusion = summarize(phases, cells);
    expect(conclusion).toEqual({
      outcome: "incomplete",
      defects: [
        `baseline: planned cells not run (${stopped})`,
        `apparmor-bwrap-profile: planned cells not run (${stopped})`,
        `userns-sysctl-relaxed: planned cells not run (${stopped})`,
        "baseline/service-system: transient unit not shown stopped",
      ],
    });
    expect(exitCodeFor(conclusion.outcome)).toBe(1);

    // In a control phase the change is still reverted; a last cell leaves none of its own phase.
    const control = at("apparmor-bwrap-profile", "service-bundled", { unitSettled: null });
    const run = control.run();
    expect(control.log).toContain(
      `apparmor-bwrap-profile restore sudo -n ${APPARMOR_PARSER} -R ${PROFILE_FILE}`,
    );
    expect(control.log.some((line) => line.startsWith("userns-sysctl-relaxed"))).toBe(false);
    expect(run.phases[1]).toMatchObject({ notRunReason: null, endState: { restored: true } });
    expect(summarize(run.phases, run.cells).defects).toEqual([
      `userns-sysctl-relaxed: planned cells not run (${stoppedAfter("apparmor-bwrap-profile/service-bundled", "its transient unit was not shown stopped")})`,
      "apparmor-bwrap-profile/service-bundled: transient unit not shown stopped",
    ]);

    // A direct worker the harness had to end, or a service cell that threw, shows no end either.
    const killed = at("baseline", "direct-system", {
      worker: { status: null, signal: "SIGTERM", error: "ETIMEDOUT" },
    }).run();
    expect(killed.phases[0].notRunReason).toBe(
      stoppedAfter("baseline/direct-system", "its worker failed (ETIMEDOUT)"),
    );
    const thrown = fakeHost({
      cellThrows: (phase, plan) => phase === "baseline" && plan.id === "service-bundled",
    }).run();
    expect(thrown.phases.map((phase) => phase.notRunReason)).toEqual([
      null,
      stoppedAfter("baseline/service-bundled", "its transient unit was not shown stopped"),
      stoppedAfter("baseline/service-bundled", "its transient unit was not shown stopped"),
    ]);

    // A worker that exited by itself, even non-zero, or never started, ended.
    for (const worker of [
      { status: 1, signal: null, error: null },
      { status: null, signal: null, error: "ENOENT" },
    ]) {
      const settled = at("baseline", "direct-system", { worker }).run();
      expect(settled.phases.map((phase) => phase.ran)).toEqual([true, true, true]);
      expect(settled.cells.filter((cell) => cell.verdict === "not_run")).toEqual([]);
    }
  });

  it("runs the profile phase only when Codex's system bwrap is the profiled file", () => {
    for (const [systemBwrap, gap] of [
      [
        systemHelper("/usr/local/bin/bwrap", "/usr/local/bin/bwrap"),
        "the system bwrap /usr/local/bin/bwrap resolves to /usr/local/bin/bwrap, not the profiled /usr/bin/bwrap",
      ],
      [null, "no bwrap on the system PATH, so no cell can execute /usr/bin/bwrap"],
    ]) {
      const fake = fakeHost({ systemBwrap });
      const { phases, cells } = fake.run();
      expect(phases[1]).toMatchObject({ ran: false, preconditionGaps: [gap], setup: null });
      expect(fake.log.some((line) => line.startsWith("apparmor-bwrap-profile setup"))).toBe(false);
      // The sysctl reaches every helper, whichever file Codex selects.
      expect(phases[2]).toMatchObject({ ran: true, setup: { verified: true } });
      expect(summarize(phases, cells).defects).toEqual([
        `apparmor-bwrap-profile: planned cells not run (precondition not met: ${gap})`,
      ]);
    }
    // AppArmor attaches by the resolved path, so a link to the profiled file is that file.
    expect(systemHelper("/bin/bwrap", "/usr/bin/bwrap")).toEqual({
      path: "/bin/bwrap",
      realpath: "/usr/bin/bwrap",
      profiledPath: "/usr/bin/bwrap",
      matchesProfile: true,
    });
    const linked = fakeHost({ systemBwrap: systemHelper("/bin/bwrap", "/usr/bin/bwrap") });
    expect(linked.run().phases[1]).toMatchObject({ ran: true, preconditionGaps: [] });
    // A helper never recorded is not mistaken for one that is absent.
    expect(fakeHost().run({ systemBwrap: undefined }).phases[1]).toMatchObject({
      ran: false,
      preconditionGaps: ["the system bwrap was not recorded"],
    });
  });

  it("ends every skipped or stopped comparison as an incomplete run that exits 1", () => {
    const scenarios = {
      "restriction already relaxed": fakeHost({ restriction: "0" }),
      "profile already loaded": fakeHost({ profiles: [...ORIGINAL_PROFILES, "bwrap (enforce)"] }),
      "system helper not the profiled file": fakeHost({
        systemBwrap: systemHelper("/usr/local/bin/bwrap", "/usr/local/bin/bwrap"),
      }),
      "change not verified": fakeHost({
        tool: (step, args) =>
          step === "setup" && args[1] === APPARMOR_PARSER ? result(1, "", "parser error\n") : null,
      }),
      "host state not restored": fakeHost({
        tool: (step, args) =>
          step === "restore" && args[1] === APPARMOR_PARSER ? result(1, "", "busy\n") : null,
      }),
      "unit not shown stopped": fakeHost({
        cell: (phase, plan) =>
          phase === "baseline" && plan.id === "service-bundled" ? { unitSettled: false } : {},
      }),
    };
    for (const [name, fake] of Object.entries(scenarios)) {
      const { phases, cells } = fake.run();
      expect(cells, name).toHaveLength(PHASES.length * cellPlan().length);
      expect(
        cells.some((cell) => cell.verdict === "not_run"),
        name,
      ).toBe(true);
      const conclusion = summarize(phases, cells);
      expect(conclusion.outcome, name).toBe("incomplete");
      expect(exitCodeFor(conclusion.outcome), name).toBe(1);
      expect(renderSummary({ ...conclusion, phases, cells }), name).toMatch(
        /^# Linux Codex readonly probe \(claudexor#337\): harness incomplete\n/,
      );
    }
  });

  it("never changes a host whose state it cannot read", () => {
    const fake = fakeHost();
    fake.host.profilesReadable = false;
    const { phases, cells } = fake.run();
    expect(phases[0]).toMatchObject({
      ran: true,
      preconditionGaps: ["the loaded AppArmor profile list is unreadable"],
      endState: { restored: false },
    });
    expect(phases.slice(1).map((phase) => phase.ran)).toEqual([false, false]);
    expect(fake.log.filter((line) => / (setup|restore) /.test(line))).toEqual([]);
    expect(cells.filter((cell) => cell.verdict === "not_run")).toHaveLength(8);
    expect(summarize(phases, cells).defects[0]).toBe(
      "baseline: the loaded AppArmor profile list is unreadable",
    );
  });

  it("labels every cell by phase and states the diagnostic control in the summary", () => {
    const { phases, cells } = fakeHost({
      cell: (phase, plan) =>
        phase === "baseline" && plan.id === "direct-system"
          ? {
              probes: {
                read: {
                  ended: "exited 1",
                  ms: 812,
                  atTimeLimit: false,
                  stderr: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted",
                },
              },
              trace: {
                expected: true,
                recorded: true,
                helper: {
                  kind: "system",
                  execs: [],
                  failed: [{ errno: "ENOENT" }, { errno: "ENOENT" }, { errno: "EACCES" }],
                  unresolved: [{ returned: null }],
                },
              },
            }
          : {},
    }).run();
    const host = { systemBwrap: systemHelper(SYSTEM_BWRAP, SYSTEM_BWRAP) };
    const markdown = renderSummary({ outcome: "complete", defects: [], host, phases, cells });
    expect(markdown).toContain(DIAGNOSTIC_CONTROL);
    expect(markdown).toContain(
      "System helper: Codex's PATH selects /usr/bin/bwrap, resolving to /usr/bin/bwrap; the profile names /usr/bin/bwrap, the same file.",
    );
    expect(markdown).toContain(
      "| cell | baseline | apparmor-bwrap-profile | userns-sysctl-relaxed |",
    );
    expect(markdown).toContain(
      "| direct-bundled | capability_failed | capability_failed | proven |",
    );
    expect(markdown).toContain(
      "| apparmor-bwrap-profile | AppArmor profile bwrap for /usr/bin/bwrap with `userns` loaded | yes | yes | not_proven |",
    );
    expect(markdown).toContain(
      "That does not show the profile attached to the helper in any cell.",
    );
    expect(markdown).toContain(
      `## How to read the phases\n\n${PHASE_READING.map((rule) => `- ${rule}`).join("\n")}\n`,
    );
    expect(markdown).toContain(
      "| baseline | direct-system | capability_failed | capability_failed | exited 1 in 812 ms: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted | system; exec attempts: 2 failed (ENOENT), 1 failed (EACCES), 1 unresolved | n/a | direct | n/a | captured: 0 lines, 0 AppArmor (0 DENIED) |",
    );
    expect(markdown).toContain(
      "| userns-sysctl-relaxed | service-bundled | proven | proven | n/a | bundled | n/a | established | true | captured: 0 lines, 0 AppArmor (0 DENIED) |",
    );
    expect(markdown).toContain("## Harness defects\n\n- none\n");
    expect(markdown).toContain(`Limits:\n${LIMITATIONS.map((limit) => `- ${limit}`).join("\n")}`);
    const elsewhere = renderSummary({
      outcome: "complete",
      host: { systemBwrap: systemHelper("/usr/local/bin/bwrap", "/usr/local/bin/bwrap") },
    });
    expect(elsewhere).toContain(
      "System helper: Codex's PATH selects /usr/local/bin/bwrap, resolving to /usr/local/bin/bwrap; the profile names /usr/bin/bwrap, a different file.",
    );
    expect(renderSummary({ outcome: "complete", host: { systemBwrap: null } })).toContain(
      "System helper: no bwrap on the system PATH; the profile names /usr/bin/bwrap.",
    );
    const unsupported = renderSummary({
      outcome: "unsupported",
      gaps: ["platform is darwin, not linux"],
    });
    expect(unsupported).toContain("- unsupported: platform is darwin, not linux");
    expect(unsupported).not.toContain("## Harness defects");
  });
});

describe("disposable unit lifecycle", () => {
  const service = {
    unit: "cx337-baseline-service-system-abc123",
    user: "runner",
    group: "docker",
    workingDirectory: "/w/project",
    readWritePath: "/w",
    command: ["/node", "probe.mjs", "cell", "--spec", "/w/spec.json"],
  };
  const name = "cx337-baseline-service-system-abc123.service";
  const gone = result(0, "LoadState=not-found\nActiveState=inactive\n");
  function recordingRun(responses) {
    const calls = [];
    const run = (step, file, args, timeoutMs) => {
      calls.push({ step, file, args, timeoutMs });
      if (responses[step] instanceof Error) throw responses[step];
      return responses[step] ?? result(0);
    };
    return { run, calls };
  }

  it("bounds the unit's life and settles exactly that unit after a normal run", () => {
    const notLoaded = result(5, "", `Failed to stop ${name}: Unit ${name} not loaded.\n`);
    const { run, calls } = recordingRun({ stop: notLoaded, "state-after-stop": gone });
    const outcome = runInTransientUnit({ run, ...service });
    expect(calls.map((call) => call.step)).toEqual([
      "start",
      "state-before-stop",
      "stop",
      "state-after-stop",
    ]);
    const start = calls[0];
    expect(start.args.slice(0, 2)).toEqual(["-n", "systemd-run"]);
    expect(start.args).toEqual(
      expect.arrayContaining(["--wait", "--pipe", "--collect", "--uid=runner", "--gid=docker"]),
    );
    expect(start.args.filter((_, index) => start.args[index - 1] === "-p")).toEqual([
      ...REPORTED_SERVICE_PROPERTIES,
      "ReadWritePaths=/w",
      `RuntimeMaxSec=${UNIT_RUNTIME_MAX_SEC}`,
      `TimeoutStopSec=${UNIT_TIMEOUT_STOP_SEC}`,
    ]);
    expect(start.args.slice(start.args.indexOf("--") + 1)).toEqual(service.command);
    expect(start.timeoutMs).toBe(UNIT_OUTER_TIMEOUT_MS);
    expect(UNIT_OUTER_TIMEOUT_MS).toBeGreaterThan(
      (UNIT_RUNTIME_MAX_SEC + UNIT_TIMEOUT_STOP_SEC) * 1000,
    );
    for (const call of calls.slice(1))
      expect(call.args.slice(0, 4)).toEqual([
        "-n",
        "systemctl",
        call.step === "stop" ? "stop" : "show",
        name,
      ]);
    expect(outcome).toMatchObject({ unit: name, settled: true });
    expect(outcome.steps.stop).toEqual(notLoaded);
  });

  it("still stops exactly that unit when the outer wait times out or the start throws", () => {
    for (const start of [
      result(null, "", "", { signal: "SIGTERM", error: "ETIMEDOUT" }),
      new Error("spawn failed"),
    ]) {
      const { run, calls } = recordingRun({
        start,
        "state-before-stop": result(0, "LoadState=loaded\nActiveState=active\n"),
        "state-after-stop": result(0, "LoadState=loaded\nActiveState=failed\nResult=signal\n"),
      });
      const outcome = runInTransientUnit({ run, ...service });
      expect(calls.filter((call) => call.step === "stop").map((call) => call.args)).toEqual([
        ["-n", "systemctl", "stop", name],
      ]);
      expect(outcome.settled).toBe(true);
      expect(outcome.steps.start.status).toBeNull();
      expect(outcome.steps["state-before-stop"].stdout).toContain("ActiveState=active");
    }
  });

  it("reports a unit still active after stop, or of unknown state, as unsettled", () => {
    const stuck = recordingRun({
      stop: result(1, "", "Job failed\n"),
      "state-after-stop": result(0, "LoadState=loaded\nActiveState=deactivating\n"),
    });
    expect(runInTransientUnit({ run: stuck.run, ...service }).settled).toBe(false);
    const blind = recordingRun({ "state-after-stop": result(1, "", "Failed to connect to bus\n") });
    expect(runInTransientUnit({ run: blind.run, ...service }).settled).toBe(false);
  });
});

describe("pins and preconditions", () => {
  it("pins 0.162.1 by registry integrity and extracted digests", () => {
    expect(CODEX_PIN.version).toBe("0.162.1");
    expect(CODEX_VERSION_OUTPUT).toBe("codex-cli 0.162.1");
    for (const tarball of [CODEX_PIN.main, CODEX_PIN.linux]) {
      expect(tarball.url).toMatch(
        /^https:\/\/registry\.npmjs\.org\/@openai\/codex\/-\/codex-0\.162\.1(?:-linux-x64)?\.tgz$/,
      );
      expect(tarball.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    }
    expect(digestMismatches(CODEX_PIN.sha256)).toEqual([]);
    expect(digestMismatches({ ...CODEX_PIN.sha256, bwrap: "0".repeat(64) })).toHaveLength(1);
  });

  it("plans both geometries with Codex's PATH-selected and bundled helpers in three phases", () => {
    expect(cellPlan().map((cell) => cell.id)).toEqual([
      "direct-system",
      "direct-bundled",
      "service-system",
      "service-bundled",
    ]);
    expect(PHASES.map((phase) => phase.id)).toEqual([
      "baseline",
      "apparmor-bwrap-profile",
      "userns-sysctl-relaxed",
    ]);
  });

  it("loads exactly Ubuntu's minimal per-binary userns profile for /usr/bin/bwrap", () => {
    expect(BWRAP_PROFILE).toBe(
      [
        "# claudexor#337 diagnostic control: loaded for one probe phase on a disposable runner, then removed.",
        "abi <abi/4.0>,",
        "include <tunables/global>",
        "",
        "profile bwrap /usr/bin/bwrap flags=(unconfined) {",
        "  userns,",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("refuses unsupported hosts before any download", () => {
    const linux = { platform: "linux", arch: "x64", uid: 1001, systemdRun: true, sudo: true };
    expect(preconditionGaps(linux)).toEqual([]);
    expect(preconditionGaps({ ...linux, uid: 0 })).toHaveLength(1);
    expect(
      preconditionGaps({
        platform: "darwin",
        arch: "arm64",
        uid: 501,
        systemdRun: false,
        sudo: false,
      }),
    ).toHaveLength(4);
  });
});

describe("cell worker with stand-in launchers", () => {
  // A launcher that never sandboxes: `--version` prints the pinned version and
  // `sandbox -- argv` runs argv directly, except that `refuse` and
  // `kill-writer` stand-ins end write probes themselves.
  function standIn(name, mode) {
    const path = join(scratch, `${name}.mjs`);
    writeFileSync(
      path,
      [
        'import { spawnSync } from "node:child_process";',
        'import { appendFileSync, writeSync } from "node:fs";',
        "appendFileSync(`${process.env.TMPDIR}/env.jsonl`, `${JSON.stringify(Object.keys(process.env).sort())}\\n`);",
        `if (process.argv[2] === "--version") { writeSync(1, ${JSON.stringify(`${CODEX_VERSION_OUTPUT}\n`)}); process.exit(0); }`,
        'const argv = process.argv.slice(process.argv.indexOf("--") + 1);',
        `const mode = ${JSON.stringify(mode)};`,
        'if (mode !== "pass-through" && /write-target\\.txt$/.test(String(argv.at(-1)))) {',
        `  writeSync(1, ${JSON.stringify(`${WRITE_STARTED}\n`)});`,
        '  if (mode === "kill-writer") process.kill(process.pid, "SIGKILL");',
        "  process.exit(1);",
        "}",
        'if (argv[0] === "/bin/cat") writeSync(2, "x".repeat(300000));',
        'process.exitCode = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" }).status ?? 1;',
      ].join("\n"),
    );
    return path;
  }

  function runWorker(name, mode, overrides = {}) {
    const root = join(scratch, name);
    const dir = (part) => join(root, part);
    for (const part of ["home", "codex-home", "tmp", "project", "raw"])
      mkdirSync(dir(part), { recursive: true });
    const spec = {
      node: process.execPath,
      launcher: standIn(name, mode),
      root,
      raw: dir("raw"),
      project: dir("project"),
      home: dir("home"),
      codexHome: dir("codex-home"),
      tmp: dir("tmp"),
      path: "/usr/bin:/bin",
      nonceFile: join(dir("project"), "cx337-nonce.txt"),
      writeTarget: join(dir("project"), "cx337-write-target.txt"),
      controlTarget: join(dir("project"), "cx337-control.txt"),
      strace: null,
      ...overrides,
    };
    writeFileSync(spec.nonceFile, `${NONCE}\n`);
    writeFileSync(join(root, "spec.json"), JSON.stringify(spec));
    const worker = spawnSync(
      process.execPath,
      [SCRIPT, "cell", "--spec", join(root, "spec.json")],
      {
        cwd: spec.project,
        env: { PATH: "/usr/bin:/bin", CX337_INHERITED_CANARY: "must-not-reach-codex" },
        encoding: "utf8",
      },
    );
    expect(worker.status, worker.stderr).toBe(0);
    const observations = JSON.parse(readFileSync(join(root, "observations.json"), "utf8"));
    const envFile = join(spec.tmp, "env.jsonl");
    const envNames = existsSync(envFile)
      ? readFileSync(envFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    return { observations, envNames, spec };
  }

  // These cell smokes need POSIX getuid, /bin/sh and Unix signals. Keep the
  // pure verdict/lifecycle checks and the unsupported-host test portable.
  it.skipIf(process.platform === "win32")(
    "keeps complete raw output and never calls a pass-through stand-in proof",
    () => {
      const { observations, envNames, spec } = runWorker("pass-through", "pass-through");
      expect(observations.launch).toMatchObject({ status: 0, stdout: `${CODEX_VERSION_OUTPUT}\n` });
      const read = observations.probes.read;
      expect(read.stdout.trim()).toBe(NONCE);
      expect(read.stderr).toHaveLength(300000);
      expect(probeEnds(observations).read).toEqual({
        ended: "exited 0",
        ms: expect.any(Number),
        atTimeLimit: false,
        stderr: "x".repeat(300),
      });
      expect(readFileSync(join(spec.raw, "read.stderr"))).toHaveLength(300000);
      expect(readFileSync(join(spec.raw, "read.stdout"), "utf8")).toBe(`${NONCE}\n`);
      const recordedRead = JSON.parse(readFileSync(join(spec.raw, "read.json"), "utf8"));
      expect(recordedRead.argv).toEqual([
        process.execPath,
        spec.launcher,
        "sandbox",
        "--",
        "/bin/cat",
        spec.nonceFile,
      ]);
      expect(Object.keys(recordedRead.env).sort()).toEqual([
        "CODEX_HOME",
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "TERM",
        "TMPDIR",
      ]);
      expect(observations.probes.write).toMatchObject({
        targetExists: true,
        targetContent: "cx337",
      });
      expect(existsSync(spec.writeTarget)).toBe(false);
      expect(classifyCell(NONCE, observations).verdict).toBe("write_not_refused");
      // Exactly the worker's own variables reach the launcher; macOS adds its
      // per-process __CF_USER_TEXT_ENCODING to every child.
      expect(envNames).toHaveLength(4);
      for (const names of envNames)
        expect(names.filter((name) => name !== "__CF_USER_TEXT_ENCODING")).toEqual(
          Object.keys(recordedRead.env).sort(),
        );
    },
  );

  it.skipIf(process.platform === "win32")(
    "never calls a refusing stand-in proof without a new user namespace",
    () => {
      const { observations } = runWorker("refusing", "refuse");
      expect(observations.controls).toEqual({ read: NONCE, write: { ok: true } });
      expect(observations.probes.write).toMatchObject({ status: 1, targetExists: false });
      expect(classifyCell(NONCE, observations).verdict).toBe(
        process.platform === "linux" ? "not_isolated" : "inconclusive",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "records a writer killed by a signal as not cleanly refused",
    () => {
      const { observations, spec } = runWorker("kill-writer", "kill-writer");
      expect(observations.probes.write).toMatchObject({ status: null, signal: "SIGKILL" });
      expect(readFileSync(join(spec.raw, "write.stdout"), "utf8")).toBe(`${WRITE_STARTED}\n`);
      const { facts } = classifyCell(NONCE, observations);
      expect(facts).toMatchObject({
        writeStarted: true,
        writeFailedCleanly: false,
        writeLanded: false,
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "calls a missing node or launcher a worker defect, keeping the raw failure",
    () => {
      const noNode = runWorker("missing-node", "pass-through", {
        node: join(scratch, "absent-node"),
      });
      expect(noNode.observations.launch).toMatchObject({ status: null, error: "ENOENT" });
      expect(noNode.observations.probes.read).toMatchObject({ status: null, error: "ENOENT" });
      const noLauncher = runWorker("missing-launcher", "pass-through", {
        launcher: join(scratch, "absent-launcher.mjs"),
      });
      expect(noLauncher.observations.launch.status).toBe(1);
      expect(noLauncher.observations.probes.read.stderr).toMatch(/MODULE_NOT_FOUND/);
      for (const { observations, envNames } of [noNode, noLauncher]) {
        expect(observations.controls).toEqual({ read: NONCE, write: { ok: true } });
        expect(envNames).toEqual([]);
        expect(classifyCell(NONCE, observations)).toMatchObject({
          verdict: "worker_defect",
          facts: { codexLaunched: false },
        });
      }
    },
  );

  it.skipIf(process.platform === "linux")(
    "refuses a non-Linux host before sudo or download",
    () => {
      const out = join(scratch, "unsupported");
      const run = spawnSync(
        process.execPath,
        [SCRIPT, "run", "--out", out, "--work", join(scratch, "unsupported-work")],
        { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" },
      );
      expect(run.status).toBe(2);
      const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
      expect(summary).toMatchObject({
        schema: "claudexor-linux-codex-readonly-probe/4",
        diagnosticControl: DIAGNOSTIC_CONTROL,
        outcome: "unsupported",
      });
      expect(summary.gaps[0]).toBe(`platform is ${process.platform}, not linux`);
      expect(readFileSync(join(out, "summary.md"), "utf8")).toContain(DIAGNOSTIC_CONTROL);
      expect(existsSync(join(out, "host", "sudo-n-true.json"))).toBe(false);
      expect(existsSync(join(out, "codex"))).toBe(false);
      expect(existsSync(join(out, "phases"))).toBe(false);
    },
  );
});

describe("evidence doc", () => {
  it("states the phase-reading rules the summary prints", () => {
    const flat = (text) => text.replace(/\s+/g, " ");
    const doc = flat(readFileSync(DOC_PATH, "utf8"));
    for (const rule of PHASE_READING) expect(doc).toContain(flat(rule));
  });
});

describe("diagnostic workflow", () => {
  it("runs only on dispatch or the one diagnostic branch, read-only and secret-free", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const triggers = workflow.slice(
      workflow.indexOf("\non:\n") + 1,
      workflow.indexOf("\npermissions:"),
    );
    expect(triggers).toBe(
      "on:\n  workflow_dispatch:\n  push:\n    branches:\n      - diag/linux-codex-readonly-probe\n",
    );
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    // The host changes live only in the probe's tested phases, never in a step.
    const commands = workflow
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(commands).not.toMatch(
      /secrets\.|GITHUB_TOKEN|id-token|sysctl|apparmor_parser|aa-(?:complain|disable|teardown)|setcap/,
    );
    const job = jobSection(workflow, "probe");
    expect(job).toContain("runs-on: ubuntu-24.04");
    expect(job).toContain("persist-credentials: false");
    expect(job).toContain("node scripts/linux-codex-readonly-probe.mjs run \\");
  });
});
