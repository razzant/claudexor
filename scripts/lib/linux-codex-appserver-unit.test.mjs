import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  freeLoopbackPort,
  phaseControls,
  PROVIDER_PORTS,
} from "./linux-codex-appserver-controls.mjs";
import {
  accessVerdicts,
  classifyDaemonRun,
  classifyProbe,
  classifyTurn,
  commandProbes,
} from "./linux-codex-appserver-cell.mjs";
import { DAEMON_RUN_TIMEOUT_MS } from "./linux-codex-appserver-daemon.mjs";
import {
  cmdlineArgs,
  environPath,
  helperExecutions,
  startProcessSampler,
} from "./linux-codex-appserver-observe.mjs";
import {
  CODEX_PIN,
  digestMismatches,
  EGRESS_PROPERTIES,
  hostState,
  kernelAudit,
  kernelLogDiff,
  kernelLogPauseMs,
  MINIMAL_BWRAP_PROFILE,
  REPORTED_SERVICE_PROPERTIES,
  runInTransientUnit,
  serviceGeometry,
  UNIT_OUTER_TIMEOUT_MS,
  UNIT_RUNTIME_MAX_SEC,
  UNIT_TIMEOUT_STOP_SEC,
  USERNS_RESTRICTION,
  workerEndProblem,
} from "./linux-codex-appserver-phases.mjs";
import { READING, summarize } from "./linux-codex-appserver-summary.mjs";
import { DOCTOR_SMOKE_STEP, EXEC_CALL_ID } from "./scripted-responses-provider.mjs";
import { jobSection } from "./workflow-sections.mjs";

// Offline checks only. The unit lifecycle, kernel-log, pin and geometry cases are carried
// from the fixed `codex sandbox` probe's regressions (bdd217377a9f) for the helpers this probe
// reuses; the worker-end cases pin the fix that an overflowed (ENOBUFS) unit run is never
// "settled".
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_PATH = join(repoRoot, ".github", "workflows", "linux-codex-appserver-probe.yml");
const DOC_PATH = join(repoRoot, "docs", "evidence", "linux-codex-appserver-probe.md");
const result = (status, stdout = "", stderr = "", extra = {}) => ({
  status,
  signal: null,
  error: null,
  stdout,
  stderr,
  ...extra,
});

describe("disposable unit lifecycle", () => {
  const service = {
    unit: "cx-appserver-baseline-system-abc123",
    user: "runner",
    group: "docker",
    workingDirectory: "/w/project",
    readWritePath: "/w",
    command: ["/node", "probe.mjs", "cell", "--spec", "/w/spec.json"],
  };
  const name = "cx-appserver-baseline-system-abc123.service";
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
      ...EGRESS_PROPERTIES,
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

  it("never treats an overflowed, timed-out, signalled or failed worker run as complete", () => {
    expect(workerEndProblem(result(0, '{"capture":{}}\n'))).toBeNull();
    expect(workerEndProblem(result(null, "", "", { signal: "SIGTERM", error: "ENOBUFS" }))).toBe(
      "the cell worker's unit run failed (ENOBUFS)",
    );
    expect(workerEndProblem(result(null, "", "", { error: "ETIMEDOUT" }))).toMatch(/ETIMEDOUT/);
    expect(workerEndProblem(result(null, "", "", { signal: "SIGKILL" }))).toBe(
      "the cell worker's unit run ended by SIGKILL",
    );
    expect(workerEndProblem(result(2))).toBe("the cell worker exited 2");
    expect(workerEndProblem(undefined)).toBe("the cell worker left no start record");
  });
});

describe("pins, geometry and kernel evidence", () => {
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

  it("loads exactly the prior minimal per-binary userns profile for the comparison", () => {
    expect(MINIMAL_BWRAP_PROFILE).toBe(
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

  it("establishes geometry only from the worker's own unit, NoNewPrivs and systemctl values", () => {
    const unit = "cx-appserver-baseline-system-abc123.service";
    const applied = {
      outside: { status: { NoNewPrivs: "1" } },
      unit: {
        name: unit,
        properties: Object.fromEntries(REPORTED_SERVICE_PROPERTIES.map((p) => p.split("="))),
      },
    };
    expect(serviceGeometry(applied, unit)).toEqual({ established: true, mismatches: [] });
    const permissive = { ...applied, outside: { status: { NoNewPrivs: "0" } } };
    expect(serviceGeometry(permissive, unit).mismatches).toEqual(["kernel NoNewPrivs is 0"]);
    expect(serviceGeometry(applied, "cx-other.service").established).toBe(false);
    expect(serviceGeometry(null, unit).mismatches).toHaveLength(
      2 + REPORTED_SERVICE_PROPERTIES.length,
    );
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

describe("profile controls", () => {
  const out = mkdtempSync(join(tmpdir(), "cx337-controls-test-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));
  const distro = { file: "/artifacts/bwrap-userns-restrict", names: ["bwrap", "unpriv_bwrap"] };
  const before = (sysctl, profiles) =>
    hostState({ [USERNS_RESTRICTION]: sysctl }, { status: 0, stdout: profiles.join("\n") }, null);

  it("changes the host only when Codex's selected bwrap is the file both profiles attach to", () => {
    const system = phaseControls({
      out,
      distro,
      selectedBwrap: { path: "/usr/bin/bwrap", realpath: "/usr/bin/bwrap" },
    });
    expect(existsSync(join(out, "phases", "minimal-profile", "bwrap-minimal.apparmor"))).toBe(true);
    expect(system.minimal.expected).toEqual({ names: ["bwrap"], sha256: null });
    expect(system.distro.preconditions("distro-profile", before("1", []))).toEqual([]);
    expect(
      system.minimal.preconditions("minimal-profile", before("0", ["bwrap (enforce)"])),
    ).toEqual([`${USERNS_RESTRICTION} is 0, not 1`, "already loaded: bwrap (enforce)"]);
    const other = phaseControls({
      out,
      distro,
      selectedBwrap: { path: "/usr/local/bin/bwrap", realpath: "/usr/local/bin/bwrap" },
    });
    expect(other.distro.preconditions("distro-profile", before("1", []))).toEqual([
      "the managed PATH selects /usr/local/bin/bwrap, not /usr/bin/bwrap",
    ]);
  });
});

describe("executed helpers", () => {
  it("reads argv and PATH from /proc bytes and names bubblewrap by exe link or argv0", () => {
    expect(cmdlineArgs(Buffer.from("codex\0-c\0x\0app-server\0--stdio\0"))).toEqual([
      "codex",
      "-c",
      "x",
      "app-server",
      "--stdio",
    ]);
    expect(environPath(Buffer.from("HOME=/h\0PATH=/a:/b\0LANG=C\0"))).toBe("/a:/b");
    expect(environPath(Buffer.from("HOME=/h\0"))).toBeNull();
    const seen = [
      { exe: "/usr/bin/bwrap", argv0: "bwrap" },
      { exe: "/p/codex-resources/bwrap", argv0: "bwrap" },
      { exe: null, exeError: "EACCES", argv0: "bwrap" },
      { exe: "/p/codex", argv0: "codex" },
    ];
    expect(helperExecutions(seen)).toEqual(seen.slice(0, 3));
  });

  it("takes the provider port below the ephemeral range and fits the daemon cell in the unit", async () => {
    expect(PROVIDER_PORTS.last).toBeLessThan(32768);
    const port = await freeLoopbackPort();
    expect(port).toBeGreaterThanOrEqual(PROVIDER_PORTS.first);
    expect(port).toBeLessThanOrEqual(PROVIDER_PORTS.last);
    // CLI start + run + CLI stop + exit wait, each at its limit.
    expect(120_000 + DAEMON_RUN_TIMEOUT_MS + 120_000 + 30_000).toBeLessThan(
      UNIT_RUNTIME_MAX_SEC * 1000,
    );
  });

  it("samples nothing, and says so, without a cgroup v2 view", () => {
    expect(startProcessSampler(null).stop()).toEqual({
      available: false,
      reason: "no cgroup v2 view",
      processes: [],
    });
  });
});

describe("harness defects", () => {
  const cell = (extra) => ({
    phase: "baseline",
    id: "daemon",
    kind: "daemon",
    verdict: "ran",
    capture: { known: true, problems: [] },
    cleanup: { known: true, problems: [] },
    egress: { blocked: true, code: "EPERM" },
    ...extra,
  });

  it("flags an open egress, a refused fixture route, a sent credential and an ineffective control", () => {
    const phase = { id: "baseline", endState: { restored: true } };
    expect(summarize([phase], [cell({ daemon: { read: "not_read" } })])).toEqual({
      outcome: "complete",
      defects: [],
    });
    const { defects } = summarize(
      [phase],
      [
        cell({ egress: { blocked: false, code: "timeout" } }),
        cell({ daemon: { read: "not_admitted", credentialHeaders: [] } }),
        cell({ daemon: { read: "read", credentialHeaders: ["authorization"] } }),
        cell({ id: "bundled", helperEvidence: { actualPath: { bundledControlEffective: false } } }),
        cell({ daemon: { read: "capture_unknown" } }),
        cell({ helperEvidence: { codexAppServer: [{ exe: "/x/codex", pinned: false }] } }),
      ],
      {
        verified: true,
        restore: { restored: false, gaps: ["/etc/codex/config.toml still exists"] },
      },
    );
    expect(defects).toEqual([
      "provider route not restored (/etc/codex/config.toml still exists)",
      "baseline/daemon: egress not shown closed (timeout)",
      "baseline/daemon: the fixture route did not admit the codex lane",
      "baseline/daemon: the provider saw credential headers authorization",
      "baseline/bundled: the bundled control's app-server PATH still holds a bwrap",
      "baseline/daemon: daemon read verdict unknown",
      "baseline/daemon: an app-server binary is not the pinned Codex (/x/codex)",
    ]);
  });

  it("counts a skipped comparison phase as no defect", () => {
    const phases = [{ id: "minimal-profile", skipped: "the distro profile did not fail" }];
    const cells = [{ phase: "minimal-profile", id: "system", verdict: "skipped" }];
    expect(summarize(phases, cells)).toEqual({ outcome: "complete", defects: [] });
  });
});

describe("harness defects from the actual producers", () => {
  const nonce = "b7".repeat(32);
  const spec = {
    nonce,
    nonceFile: "/cell/project/research/input.txt",
    marker: "probe",
    writeTargets: {
      readonly: "/cell/project/ro",
      project: "/cell/project/ww",
      outside: "/cell/outside/w",
      full: "/cell/full/w",
    },
  };
  const cell = (extra) => ({
    phase: "baseline",
    id: "system",
    kind: "appserver",
    verdict: "ran",
    capture: { known: true, problems: [] },
    cleanup: { known: true, problems: [] },
    ...extra,
  });
  const execOutput = (text) => ({ [EXEC_CALL_ID]: `Process exited with code 0\nOutput:\n${text}` });
  const item = (exitCode, aggregatedOutput) => ({
    method: "item/completed",
    params: { item: { type: "commandExecution", exitCode, aggregatedOutput } },
  });
  const turn = (extra) =>
    classifyTurn({ turn: { started: true }, notifications: [], providerLog: [], nonce, ...extra });

  // Probe verdicts by the real classifier; `answer(probe)` is the JSON-RPC outcome.
  const access = (answer, identity = "", outside = { user: "u:1", mnt: "m:1", net: "n:1" }) => {
    const verdicts = Object.fromEntries(
      commandProbes(spec).map((probe) => [
        probe.id,
        classifyProbe(probe, answer(probe), spec, { exists: false }),
      ]),
    );
    return accessVerdicts(verdicts, identity, outside);
  };
  const refusing = (probe) =>
    probe.access === "full"
      ? {
          state: "result",
          result: { exitCode: 0, stdout: probe.target ? "cx-probe-write-started\n" : `${nonce}\n` },
        }
      : { state: "result", result: { exitCode: 1, stdout: "", stderr: "bwrap startup refused" } };

  it("keeps a negative sandbox baseline with unknown namespace identity as complete data", () => {
    const verdicts = access(refusing);
    expect(verdicts).toMatchObject({
      readonly: "capability_failed",
      workspace_write: "capability_failed",
      namespaces: "unknown",
      anyUnknown: false,
    });
    expect(summarize([], [cell({ access: verdicts })])).toEqual({
      outcome: "complete",
      defects: [],
    });
  });

  it("still fails the run when a probe produced no verdict", () => {
    for (const state of ["timeout", "error"]) {
      const verdicts = access((probe) =>
        probe.id === "readonly_read" ? { state } : refusing(probe),
      );
      expect(verdicts.readonly).toBe("unknown");
      expect(summarize([], [cell({ access: verdicts })]).defects).toEqual([
        "baseline/system: readonly verdict unknown",
      ]);
    }
    // An unanswered identity probe shows only in anyUnknown; it must not be silently dropped.
    const identity = access((probe) =>
      probe.id.endsWith("_identity") ? { state: "timeout" } : refusing(probe),
    );
    expect(identity.anyUnknown).toBe(true);
    expect(summarize([], [cell({ access: identity })]).defects).toEqual([
      "baseline/system: a probe verdict unknown",
    ]);
  });

  it("separates a refused or failed daemon operation from a model path never exercised", () => {
    const exec = { reply: "call:exec_command", tools: ["exec_command"] };
    const final = (output) => ({
      reply: "final_message",
      tools: ["exec_command"],
      functionCallOutputs: { [EXEC_CALL_ID]: output },
    });
    const ran = { outcome: { status: "succeeded" }, eventTypes: { "harness.started": 1 } };
    const answer = (text) => ({ ...ran, detail: { primaryOutput: { text } } });
    const states = [
      [
        "read",
        answer(nonce),
        [exec, final(`Process exited with code 0\nOutput:\n${nonce}\n`)],
        "complete",
      ],
      [
        "not_read",
        answer("denied"),
        [exec, final("Process exited with code 1\nOutput:\n")],
        "complete",
      ],
      ["capture_unknown", {}, [], "incomplete"],
      ["not_admitted", { outcome: { status: "failed" }, eventTypes: {} }, [], "incomplete"],
      ["no_model_request", ran, [{ reply: DOCTOR_SMOKE_STEP }], "incomplete"],
      ["not_called", ran, [exec], "incomplete"],
    ];
    for (const [read, obs, providerLog, outcome] of states) {
      const daemon = classifyDaemonRun({ obs, providerLog, nonce, hostWrite: { exists: false } });
      expect(daemon.read).toBe(read);
      expect(summarize([], [cell({ id: "daemon", kind: "daemon", daemon })]).outcome).toBe(outcome);
    }
  });

  it("does the same for the scripted turn's exec_command", () => {
    const offered = [{ tools: ["exec_command"] }];
    const withOutput = [{ tools: ["exec_command"], functionCallOutputs: execOutput("x") }];
    const states = [
      [
        "read",
        turn({ notifications: [item(0, `${nonce}\nwrite_rc=1`)], providerLog: withOutput }),
        "complete",
      ],
      [
        "not_read",
        turn({ notifications: [item(1, "denied")], providerLog: withOutput }),
        "complete",
      ],
      ["rpc_error", turn({ turn: { started: false, startState: "error" } }), "incomplete"],
      ["capture_unknown", turn({ turn: { started: false } }), "incomplete"],
      ["no_model_request", turn(), "incomplete"],
      ["not_called", turn({ providerLog: offered }), "incomplete"],
      ["capture_unknown", turn({ providerLog: withOutput }), "incomplete"],
    ];
    for (const [exec, produced, outcome] of states) {
      expect(produced.exec).toBe(exec);
      expect(summarize([], [cell({ turn: produced })]).outcome).toBe(outcome);
    }
  });
});

describe("evidence doc and workflow", () => {
  it("states the reading rules the summary prints", () => {
    const flat = (text) => text.replace(/\s+/g, " ");
    const doc = flat(readFileSync(DOC_PATH, "utf8"));
    for (const rule of READING) expect(doc).toContain(flat(rule));
  });

  it("runs only on dispatch or the one diagnostic branch, read-only and secret-free", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const triggers = workflow.slice(
      workflow.indexOf("\non:\n") + 1,
      workflow.indexOf("\npermissions:"),
    );
    expect(triggers).toBe(
      "on:\n  workflow_dispatch:\n  push:\n    branches:\n      - diag/linux-codex-appserver-probe\n",
    );
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    // Host changes live only in the probe's tested controls, never in a workflow step.
    const commands = workflow
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(commands).not.toMatch(
      /secrets\.|GITHUB_TOKEN|id-token|sysctl|apparmor_parser|aa-(?:complain|disable|teardown)|setcap|\/etc\/codex/,
    );
    const job = jobSection(workflow, "probe");
    expect(job).toContain("runs-on: ubuntu-24.04");
    expect(job).toContain("persist-credentials: false");
    expect(job).toContain("--filter=@claudexor/cli...");
    expect(job).toContain("node scripts/linux-codex-appserver-probe.mjs run \\");
    expect(job).toMatch(
      /if: always\(\)\n\s+run: node scripts\/linux-codex-appserver-probe\.mjs restore/,
    );
  });
});
