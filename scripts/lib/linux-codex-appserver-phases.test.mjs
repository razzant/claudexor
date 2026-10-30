import { describe, expect, it } from "vitest";
import {
  CELLS,
  changeVerified,
  distroProfileFailed,
  EGRESS_PROPERTIES,
  hostState,
  kernelAudit,
  PHASES,
  REPORTED_SERVICE_PROPERTIES,
  runPhases,
  serviceRunArgv,
  USERNS_RESTRICTION,
} from "./linux-codex-appserver-phases.mjs";
import { exitCodeFor, renderSummary, summarize } from "./linux-codex-appserver-summary.mjs";

const SHA = "11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9";
const EXPECTED = { names: ["bwrap", "unpriv_bwrap"], sha256: SHA };
const BASE_PROFILES = ["unprivileged_userns (enforce)", "rsyslogd (enforce)"];
const usable = {
  access: { readonly: "usable", workspace_write: "usable", full: "usable" },
  turn: { exec: "read", viewImage: "returned_image", write: "refused" },
  daemon: { read: "read" },
};
const failing = {
  access: { readonly: "capability_failed", workspace_write: "capability_failed", full: "usable" },
  turn: { exec: "not_read", viewImage: "failed", write: "not_started" },
  daemon: { read: "not_read" },
};

/** Fake host: the kernel profile list and the distro profile file; both controls act on them. */
function fakeEffects({
  cell = () => ({}),
  applyEffect = "exact",
  restoreWorks = true,
  applyThrows = false,
} = {}) {
  const host = { profiles: [...BASE_PROFILES], file: { exists: false } };
  const log = [];
  const read = () =>
    hostState(
      { [USERNS_RESTRICTION]: "1" },
      { status: 0, stdout: host.profiles.join("\n") },
      { ...host.file },
    );
  const control = (name, apply) => ({
    expected: name === "distro" ? EXPECTED : { names: ["bwrap"], sha256: null },
    preconditions: (phase, before) =>
      before.sysctl[USERNS_RESTRICTION] === "1" ? [] : ["restriction off"],
    apply: (phase) => {
      log.push(`apply ${phase}`);
      if (applyThrows) throw new Error("sudo vanished");
      apply();
      if (applyEffect === "extra") host.profiles.push("something_else (enforce)");
      return { installPath: name === "distro" ? "/etc/apparmor.d/x" : null, steps: [] };
    },
    restore: (phase, applied, before) => {
      log.push(
        `restore ${phase} ${applied ? "record" : "from-before"} ${before.installFile.exists}`,
      );
      if (restoreWorks) {
        host.profiles = [...BASE_PROFILES];
        host.file = { exists: false };
      }
      return {
        restored: restoreWorks,
        gaps: restoreWorks ? [] : ["still loaded: bwrap (enforce)"],
      };
    },
  });
  return {
    log,
    host,
    effects: {
      snapshot: (phase, stage) => {
        log.push(`snapshot ${phase} ${stage}`);
        return read();
      },
      controls: {
        distro: control("distro", () => {
          host.file = { exists: true, type: "file", sha256: SHA, mode: 0o644, uid: 0, gid: 0 };
          host.profiles.push("bwrap (enforce)", "unpriv_bwrap (enforce)");
        }),
        minimal: control("minimal", () => host.profiles.push("bwrap (unconfined)")),
      },
      runCell: (phase, plan) => {
        log.push(`cell ${phase}/${plan.id}`);
        return {
          ...plan,
          verdict: "ran",
          capture: { known: true, problems: [] },
          cleanup: { known: true, problems: [] },
          ...(phase === "baseline" || phase === "restored-baseline" ? failing : usable),
          ...cell(phase, plan),
        };
      },
    },
  };
}

const ids = (cells, phase) =>
  cells.filter((c) => c.phase === phase).map((c) => `${c.id}/${c.verdict}`);

describe("phase sequence", () => {
  it("runs baseline, the verified distro profile and a restored baseline over all three cells", () => {
    const { effects, log, host } = fakeEffects();
    const { phases, cells } = runPhases(effects);
    expect(CELLS.map((c) => `${c.id}:${c.kind}:${c.helper}`)).toEqual([
      "system:appserver:system",
      "bundled:appserver:bundled",
      "daemon:daemon:system",
    ]);
    for (const phase of ["baseline", "distro-profile", "restored-baseline"])
      expect(ids(cells, phase)).toEqual(["system/ran", "bundled/ran", "daemon/ran"]);
    expect(log.filter((line) => line.startsWith("apply") || line.startsWith("restore"))).toEqual([
      "apply distro-profile",
      "restore distro-profile record false",
    ]);
    expect(
      phases.map((p) => [p.id, p.setup?.verified ?? null, p.endState?.restored ?? null]),
    ).toEqual([
      ["baseline", null, true],
      ["distro-profile", true, true],
      ["restored-baseline", null, true],
      ["minimal-profile", null, null],
      ["minimal-restored", null, null],
    ]);
    // The distro profile worked for the system helper, so the comparison is skipped, not a defect.
    expect(phases[3].skipped).toBe("the distro profile did not fail for the system helper");
    expect(ids(cells, "minimal-profile")).toEqual([
      "system/skipped",
      "bundled/skipped",
      "daemon/skipped",
    ]);
    expect(host.profiles).toEqual(BASE_PROFILES);
    expect(summarize(phases, cells)).toEqual({ outcome: "complete", defects: [] });
  });

  it("compares the prior minimal profile only after a failed distro profile, then restores it", () => {
    const { effects, log, host } = fakeEffects({
      cell: (phase, plan) => (phase === "distro-profile" && plan.id === "daemon" ? failing : {}),
    });
    const { phases, cells } = runPhases(effects);
    expect(phases[3]).toMatchObject({
      id: "minimal-profile",
      ran: true,
      condition: "distro-profile failed for daemon",
      setup: { verified: true },
      endState: { restored: true },
    });
    expect(ids(cells, "minimal-restored")).toEqual(["system/ran", "bundled/ran", "daemon/ran"]);
    expect(log.filter((line) => line.startsWith("apply") || line.startsWith("restore"))).toEqual([
      "apply distro-profile",
      "restore distro-profile record false",
      "apply minimal-profile",
      "restore minimal-profile record false",
    ]);
    expect(host.profiles).toEqual(BASE_PROFILES);
    expect(summarize(phases, cells).outcome).toBe("complete");
  });

  it("names the failing system-helper cells, and nothing when none ran", () => {
    const cell = (id, kind, values) => ({
      phase: "distro-profile",
      id,
      kind,
      helper: id === "bundled" ? "bundled" : "system",
      verdict: "ran",
      ...values,
    });
    expect(
      distroProfileFailed([
        cell("system", "appserver", usable),
        cell("bundled", "appserver", failing),
        cell("daemon", "daemon", usable),
      ]),
    ).toEqual([]);
    expect(
      distroProfileFailed([
        cell("system", "appserver", { ...usable, turn: { exec: "not_read" } }),
        cell("daemon", "daemon", usable),
      ]),
    ).toEqual(["system"]);
    // A fixture route that never reached the model is a harness defect, not a profile failure.
    expect(
      distroProfileFailed([
        cell("system", "appserver", usable),
        cell("daemon", "daemon", { daemon: { read: "not_admitted" } }),
      ]),
    ).toEqual([]);
    expect(
      distroProfileFailed([{ ...cell("system", "appserver", usable), verdict: "not_run" }]),
    ).toBeNull();
  });

  it("stops every later cell and phase after an unknown capture, before any host change", () => {
    const { effects, log } = fakeEffects({
      cell: (phase, plan) =>
        plan.id === "system"
          ? { capture: { known: false, problems: ["command/exec readonly_read timeout"] } }
          : {},
    });
    const { phases, cells } = runPhases(effects);
    expect(cells.map((c) => c.verdict)).toEqual(["ran", ...Array(14).fill("not_run")]);
    expect(log).not.toContain("apply distro-profile");
    expect(cells[1].reason).toMatch(/stopped after baseline\/system: capture unknown/);
    const summary = summarize(phases, cells);
    expect(summary.outcome).toBe("incomplete");
    expect(exitCodeFor(summary.outcome)).toBe(1);
  });

  it("still restores the profile when a cell's cleanup is unknown, and runs nothing after", () => {
    const { effects, log, host } = fakeEffects({
      cell: (phase, plan) =>
        phase === "distro-profile" && plan.id === "system"
          ? { cleanup: { known: false, problems: ["1 process(es) left in the unit cgroup"] } }
          : {},
    });
    const { phases, cells } = runPhases(effects);
    expect(log).toContain("restore distro-profile record false");
    expect(host.profiles).toEqual(BASE_PROFILES);
    expect(cells.filter((c) => c.verdict === "not_run").map((c) => `${c.phase}/${c.id}`)).toEqual([
      "distro-profile/bundled",
      "distro-profile/daemon",
      ...["restored-baseline", "minimal-profile", "minimal-restored"].flatMap((phase) =>
        CELLS.map((cell) => `${phase}/${cell.id}`),
      ),
    ]);
    expect(phases[1].endState.restored).toBe(true);
    expect(summarize(phases, cells).defects).toContain(
      "distro-profile/system: cleanup unknown (1 process(es) left in the unit cgroup)",
    );
  });

  it("runs no cell under a change that is not exactly the intended one, and restores it", () => {
    const { effects, log } = fakeEffects({ applyEffect: "extra", restoreWorks: true });
    const { phases, cells } = runPhases(effects);
    expect(phases[1].setup.verified).toBe(false);
    expect(phases[1].setup.differences).toContain("profile something_else (enforce) added");
    expect(ids(cells, "distro-profile")).toEqual([
      "system/not_run",
      "bundled/not_run",
      "daemon/not_run",
    ]);
    expect(log).toContain("restore distro-profile record false");
  });

  it("blocks the restored baseline and the comparison when the end state does not match", () => {
    const { effects } = fakeEffects({ restoreWorks: false });
    const { phases, cells } = runPhases(effects);
    expect(phases[1].endState.restored).toBe(false);
    for (const phase of ["restored-baseline", "minimal-profile", "minimal-restored"])
      expect(ids(cells, phase)).toEqual(["system/not_run", "bundled/not_run", "daemon/not_run"]);
    expect(summarize(phases, cells).defects.join("\n")).toMatch(
      /distro-profile: host state not restored/,
    );
  });

  it("restores from the recorded start when the apply itself threw", () => {
    const { effects, log } = fakeEffects({ applyThrows: true });
    const { phases } = runPhases(effects);
    expect(phases[1].error).toMatch(/sudo vanished/);
    expect(log).toContain("restore distro-profile from-before false");
  });

  it("keeps a cell the harness could not run as a harness error, restores and stops", () => {
    const { effects, log, host } = fakeEffects();
    const runCell = effects.runCell;
    effects.runCell = (phase, plan) => {
      if (phase === "distro-profile" && plan.id === "bundled") throw new Error("unit start threw");
      return runCell(phase, plan);
    };
    const { phases, cells } = runPhases(effects);
    expect(ids(cells, "distro-profile")).toEqual([
      "system/ran",
      "bundled/harness_error",
      "daemon/not_run",
    ]);
    expect(log).toContain("restore distro-profile record false");
    expect(host.profiles).toEqual(BASE_PROFILES);
    expect(phases[2].notRunReason).toMatch(
      /stopped after distro-profile\/bundled: capture unknown/,
    );
    expect(summarize(phases, cells).outcome).toBe("incomplete");
  });

  it("never changes a host whose state it cannot read", () => {
    const { effects, log } = fakeEffects();
    effects.snapshot = (phase, stage) => {
      log.push(`snapshot ${phase} ${stage}`);
      return hostState({ [USERNS_RESTRICTION]: "1" }, { status: 1, stdout: "" }, { exists: false });
    };
    const { phases } = runPhases(effects);
    expect(phases[0].notRunReason).toMatch(/the loaded AppArmor profile list is unreadable/);
    expect(log.some((line) => line.startsWith("apply") || line.startsWith("cell"))).toBe(false);
  });

  it("skips the control phase whose precondition fails without touching the host", () => {
    const { effects, log } = fakeEffects();
    effects.controls.distro.preconditions = () => [
      "kernel.apparmor_restrict_unprivileged_userns is 0, not 1",
    ];
    const { phases } = runPhases(effects);
    expect(phases[1].notRunReason).toMatch(/precondition not met/);
    expect(log.some((line) => line.startsWith("apply") || line.startsWith("restore"))).toBe(false);
  });
});

describe("host change verification", () => {
  const before = hostState(
    { [USERNS_RESTRICTION]: "1" },
    { status: 0, stdout: BASE_PROFILES.join("\n") },
    { exists: false },
  );
  const applied = (profiles, file) =>
    hostState(
      { [USERNS_RESTRICTION]: "1" },
      { status: 0, stdout: [...BASE_PROFILES, ...profiles].join("\n") },
      file,
    );
  const pinned = { exists: true, type: "file", sha256: SHA, mode: 0o644, uid: 0, gid: 0 };

  it("accepts exactly both pinned profiles in any mode plus the pinned file", () => {
    expect(
      changeVerified(
        before,
        applied(["bwrap (enforce)", "unpriv_bwrap (complain)"], pinned),
        EXPECTED,
      ).verified,
    ).toBe(true);
  });

  it("accepts the minimal comparison only as one added profile with no file change", () => {
    const minimal = { names: ["bwrap"], sha256: null };
    expect(
      changeVerified(before, applied(["bwrap (unconfined)"], { exists: false }), minimal).verified,
    ).toBe(true);
    expect(changeVerified(before, applied(["bwrap (unconfined)"], pinned), minimal).verified).toBe(
      false,
    );
    expect(
      changeVerified(
        before,
        applied(["bwrap (unconfined)", "unpriv_bwrap (enforce)"], { exists: false }),
        minimal,
      ).verified,
    ).toBe(false);
  });

  it("rejects a missing profile, a different file or an unrelated change", () => {
    expect(changeVerified(before, applied(["bwrap (enforce)"], pinned), EXPECTED).verified).toBe(
      false,
    );
    expect(
      changeVerified(
        before,
        applied(["bwrap (enforce)", "unpriv_bwrap (enforce)"], { ...pinned, sha256: "0" }),
        EXPECTED,
      ).verified,
    ).toBe(false);
    const sysctl = hostState(
      { [USERNS_RESTRICTION]: "0" },
      {
        status: 0,
        stdout: [...BASE_PROFILES, "bwrap (enforce)", "unpriv_bwrap (enforce)"].join("\n"),
      },
      pinned,
    );
    expect(changeVerified(before, sysctl, EXPECTED).verified).toBe(false);
    expect(
      changeVerified(
        before,
        hostState({ [USERNS_RESTRICTION]: "1" }, { status: 1, stdout: "" }, pinned),
        EXPECTED,
      ).verified,
    ).toBe(false);
  });
});

describe("geometry, kernel evidence and summary", () => {
  it("starts the worker in a unit carrying exactly the reported hardening", () => {
    const argv = serviceRunArgv({
      unit: "u",
      user: "runner",
      group: "runner",
      workingDirectory: "/c/project",
      readWritePath: "/c",
      command: ["node", "w"],
    });
    for (const property of [...REPORTED_SERVICE_PROPERTIES, ...EGRESS_PROPERTIES])
      expect(argv).toContain(property);
    expect(EGRESS_PROPERTIES).toEqual(["IPAddressDeny=any", "IPAddressAllow=localhost"]);
    expect(argv.slice(0, 7)).toEqual([
      "-n",
      "systemd-run",
      "--quiet",
      "--wait",
      "--pipe",
      "--collect",
      "--service-type=exec",
    ]);
    expect(argv).toContain("ReadWritePaths=/c");
    expect(argv.slice(-3)).toEqual(["--", "node", "w"]);
  });

  it("groups AppArmor audit lines and keeps the executable that created a namespace", () => {
    const audit = kernelAudit([
      '[1.0] audit: type=1400 apparmor="AUDIT" operation="userns_create" class="namespace" info="Userns create - transitioning profile" profile="unconfined" pid=7 comm="bwrap" requested="userns_create" target="unprivileged_userns" execpath="/w/codex-resources/bwrap"',
      '[1.1] audit: type=1400 apparmor="DENIED" operation="capable" class="cap" profile="unprivileged_userns" pid=8 comm="bwrap" capability=12 capname="net_admin"',
      "[1.2] kauditd_printk_skb: 3 callbacks suppressed",
    ]);
    expect(audit.suppressed).toBe(3);
    expect(audit.apparmor.map((group) => group.execpath ?? group.capname)).toEqual([
      "/w/codex-resources/bwrap",
      "net_admin",
    ]);
  });

  it("renders verdicts per phase, startup warnings verbatim and the defects", () => {
    const cell = (phase, id, readonly) => ({
      phase,
      id,
      helper: id,
      verdict: "ran",
      access: { readonly, workspace_write: readonly, full: "usable" },
      turn: {
        exec: readonly === "usable" ? "read" : "not_read",
        viewImage: readonly === "usable" ? "returned_image" : "failed",
      },
      startup: {
        settled: true,
        configWarnings:
          readonly === "usable"
            ? []
            : [
                {
                  summary:
                    "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.",
                },
              ],
      },
      helperEvidence: {
        pathBwrap: "/usr/bin/bwrap",
        inside: {
          apparmor: "bwrap//&unpriv_bwrap (enforce)",
          NoNewPrivs: "1",
          CapEff: "0000000000000000",
          bwrap: "/usr/bin/bwrap",
        },
        kernelExecpaths: [],
      },
    });
    const markdown = renderSummary({
      outcome: "complete",
      defects: [],
      phases: [{ id: "baseline", change: "none", endState: { restored: true } }],
      cells: [
        cell("baseline", "system", "capability_failed"),
        cell("distro-profile", "system", "usable"),
      ],
    });
    expect(markdown).toContain(
      "| system | readonly (command/exec) | capability_failed | usable | missing | missing | missing |",
    );
    expect(markdown).toContain(
      "| system | readonly turn: view_image | failed | returned_image | missing | missing | missing |",
    );
    expect(markdown).toContain(
      "| daemon | daemon: run / work state | missing | missing | missing | missing | missing |",
    );
    expect(markdown).toContain("needs access to create user namespaces. (settled)");
    expect(markdown).toContain("## Harness defects\n\n- none");
    expect(PHASES.map((phase) => phase.id)).toEqual([
      "baseline",
      "distro-profile",
      "restored-baseline",
      "minimal-profile",
      "minimal-restored",
    ]);
  });
});
