import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  CODEX_PIN,
  REPORTED_SERVICE_PROPERTIES,
  UNIT_OUTER_TIMEOUT_MS,
  UNIT_RUNTIME_MAX_SEC,
  UNIT_TIMEOUT_STOP_SEC,
  WRITE_STARTED,
  cellPlan,
  classifyCell,
  digestMismatches,
  exitCodeFor,
  kernelLogState,
  preconditionGaps,
  renderSummary,
  runInTransientUnit,
  serviceGeometry,
  summarize,
} from "./linux-codex-readonly-probe.mjs";
import { jobSection } from "./workflow-sections.mjs";

// Offline checks only: no Codex download, sudo, systemd unit or model. The
// real Linux run is the diagnostic workflow; these pin what it may call proof.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(repoRoot, "scripts", "linux-codex-readonly-probe.mjs");
const WORKFLOW_PATH = join(repoRoot, ".github", "workflows", "linux-codex-readonly-probe.yml");
const scratch = mkdtempSync(join(tmpdir(), "cx337-probe-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const NONCE = "cx337-0123456789abcdef0123456789abcdef";
const OUTSIDE = { user: "user:[4026531837]", mnt: "mnt:[4026531841]" };
const INSIDE = "user=user:[4026532301]\nmnt=mnt:[4026532302]\nnet=net:[4026532304]\n";
const SAME = "user=user:[4026531837]\nmnt=mnt:[4026531841]\n";
const result = (status, stdout = "", stderr = "", extra = {}) => ({
  status,
  signal: null,
  error: null,
  stdout,
  stderr,
  ...extra,
});
const refused = {
  ...result(2, `${WRITE_STARTED}\n`, "x: Read-only file system\n"),
  targetExists: false,
};

function observed({ read, identity, write, controls } = {}) {
  return {
    outside: { namespaces: OUTSIDE },
    controls: controls ?? { read: NONCE, write: { ok: true } },
    probes: {
      read: read ?? result(0, `${NONCE}\n`),
      identity: identity ?? result(0, INSIDE),
      write: write ?? refused,
    },
  };
}

describe("cell verdicts", () => {
  it("proves only a nonce read, a cleanly refused write and new namespaces together", () => {
    expect(classifyCell(NONCE, observed()).verdict).toBe("proven");
  });

  it("reports a pass-through stand-in as a write fault and a bare refusal as not isolated", () => {
    const landed = { ...result(0, `${WRITE_STARTED}\n`), targetExists: true };
    expect(
      classifyCell(NONCE, observed({ identity: result(0, SAME), write: landed })).verdict,
    ).toBe("write_not_refused");
    expect(classifyCell(NONCE, observed({ identity: result(0, SAME) })).verdict).toBe(
      "not_isolated",
    );
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
      observed({ identity: result(0, "user=\nmnt=\n") }),
      observed({ identity: result(1, INSIDE) }),
    ];
    for (const observation of cases)
      expect(classifyCell(NONCE, observation).verdict).toBe("inconclusive");
  });
});

describe("service geometry and outcome", () => {
  const unit = "cx337-service-system-abc123.service";
  const applied = {
    outside: { status: { NoNewPrivs: "1" } },
    unit: {
      name: unit,
      properties: Object.fromEntries(REPORTED_SERVICE_PROPERTIES.map((p) => p.split("="))),
    },
  };

  it("establishes geometry only from the worker's own unit, NoNewPrivs and systemctl values", () => {
    expect(serviceGeometry(applied, unit)).toEqual({ established: true, mismatches: [] });
    const permissive = { ...applied, outside: { status: { NoNewPrivs: "0" } } };
    expect(serviceGeometry(permissive, unit).mismatches).toEqual(["kernel NoNewPrivs is 0"]);
    expect(serviceGeometry(applied, "cx337-other.service").established).toBe(false);
    expect(serviceGeometry(null, unit).mismatches).toHaveLength(
      2 + REPORTED_SERVICE_PROPERTIES.length,
    );
  });

  it("is never proven while a service geometry is unestablished or a unit unsettled", () => {
    const direct = { id: "direct-system", geometry: "direct", verdict: "proven" };
    const service = {
      id: "service-system",
      geometry: "service",
      verdict: "proven",
      serviceGeometry: { established: true, mismatches: [] },
      unitSettled: true,
    };
    expect(summarize([direct, service])).toEqual({ outcome: "proven", problems: [] });
    const unestablished = {
      ...service,
      serviceGeometry: { established: false, mismatches: ["ProtectSystem is unknown"] },
    };
    expect(summarize([direct, unestablished])).toEqual({
      outcome: "not_proven",
      problems: [
        "service-system: requested service geometry not established (ProtectSystem is unknown)",
      ],
    });
    expect(summarize([direct, { ...service, unitSettled: false }]).outcome).toBe("not_proven");
    expect(summarize([direct, { ...service, verdict: "write_not_refused" }]).outcome).toBe(
      "write_not_refused",
    );
    expect(summarize([]).outcome).toBe("not_proven");
    const outcomes = ["proven", "not_proven", "write_not_refused", "unsupported", "harness_error"];
    expect(outcomes.map(exitCodeFor)).toEqual([0, 1, 1, 2, 2]);
  });

  it("keeps an unavailable kernel log unknown rather than empty", () => {
    const ok = (stdout) => result(0, stdout);
    expect(kernelLogState(ok("a\n"), ok("a\nb\n"))).toBe("captured");
    expect(kernelLogState(ok("a\n"), ok("z\n"))).toBe("rotated");
    expect(kernelLogState(result(1, "", "sudo: a password is required\n"), ok("a\n"))).toBe(
      "unavailable",
    );
    expect(kernelLogState(ok("a\n"), result(null, "", "", { error: "ENOENT" }))).toBe(
      "unavailable",
    );
    const markdown = renderSummary({
      outcome: "not_proven",
      problems: [],
      cells: [
        {
          id: "direct-system",
          geometry: "direct",
          verdict: "proven",
          reason: "r",
          kernelLog: "unavailable",
        },
      ],
    });
    expect(markdown).toContain("| direct-system | proven | r | direct | n/a | unavailable |");
  });
});

describe("disposable unit lifecycle", () => {
  const service = {
    unit: "cx337-service-system-abc123",
    user: "runner",
    group: "docker",
    workingDirectory: "/w/project",
    readWritePath: "/w",
    command: ["/node", "probe.mjs", "cell", "--spec", "/w/spec.json"],
  };
  const name = "cx337-service-system-abc123.service";
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
    for (const tarball of [CODEX_PIN.main, CODEX_PIN.linux]) {
      expect(tarball.url).toMatch(
        /^https:\/\/registry\.npmjs\.org\/@openai\/codex\/-\/codex-0\.162\.1(?:-linux-x64)?\.tgz$/,
      );
      expect(tarball.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    }
    expect(digestMismatches(CODEX_PIN.sha256)).toEqual([]);
    expect(digestMismatches({ ...CODEX_PIN.sha256, bwrap: "0".repeat(64) })).toHaveLength(1);
  });

  it("plans both geometries with Codex's PATH-selected and bundled helpers", () => {
    expect(cellPlan().map((cell) => cell.id)).toEqual([
      "direct-system",
      "direct-bundled",
      "service-system",
      "service-bundled",
    ]);
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
  // A launcher that never sandboxes: `sandbox -- argv` runs argv directly,
  // except that `refuse` and `kill-writer` stand-ins end write probes themselves.
  function standIn(name, mode) {
    const path = join(scratch, `${name}.mjs`);
    writeFileSync(
      path,
      [
        'import { spawnSync } from "node:child_process";',
        'import { appendFileSync, writeSync } from "node:fs";',
        "appendFileSync(`${process.env.TMPDIR}/env.jsonl`, `${JSON.stringify(Object.keys(process.env).sort())}\\n`);",
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

  function runWorker(name, mode) {
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
    const envNames = readFileSync(join(spec.tmp, "env.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { observations, envNames, spec };
  }

  // These cell smokes need POSIX getuid, /bin/sh and Unix signals. Keep the
  // pure verdict/lifecycle checks and the unsupported-host test portable.
  it.skipIf(process.platform === "win32")(
    "keeps complete raw output and never calls a pass-through stand-in proof",
    () => {
      const { observations, envNames, spec } = runWorker("pass-through", "pass-through");
      const read = observations.probes.read;
      expect(read.stdout.trim()).toBe(NONCE);
      expect(read.stderr).toHaveLength(300000);
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
      expect(envNames).toHaveLength(3);
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
      expect(summary.outcome).toBe("unsupported");
      expect(summary.gaps[0]).toBe(`platform is ${process.platform}, not linux`);
      expect(existsSync(join(out, "host", "sudo-n-true.json"))).toBe(false);
      expect(existsSync(join(out, "codex"))).toBe(false);
    },
  );
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
    expect(workflow).not.toMatch(
      /secrets\.|GITHUB_TOKEN|id-token|sysctl|apparmor_parser|aa-(?:complain|disable|teardown)|setcap/,
    );
    const job = jobSection(workflow, "probe");
    expect(job).toContain("runs-on: ubuntu-24.04");
    expect(job).toContain("persist-credentials: false");
    expect(job).toContain("node scripts/linux-codex-readonly-probe.mjs run \\");
  });
});
