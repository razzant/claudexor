# Linux Codex readonly probe (claudexor#337)

`.github/workflows/linux-codex-readonly-probe.yml` runs
`scripts/linux-codex-readonly-probe.mjs` on a GitHub-hosted `ubuntu-24.04` x86_64 runner. It asks
one question without any credential: does the real Codex 0.162.1 Linux read-only sandbox read a
project file and refuse a write for the same normal user, both directly and inside a systemd
service with the hardening reported in #337? It then runs the same four cells under two controlled
host changes, one at a time, to find which restriction the result depends on.

This is a diagnostic control on a disposable runner. The two host changes exist only to locate the
boundary behind #337 on that runner, and neither is a recommended setting for a host that runs
Claudexor.

## What runs

- Codex 0.162.1, the release-tested baseline, from its public npm tarballs. #337 was observed with
  Codex 0.153.3; see the limits below. Each tarball must match its registry `sha512` integrity; it
  is unpacked into the npm global layout the managed installer produces, and the launcher, native
  binary and bundled `bwrap` must match pinned `sha256` digests.
- `codex sandbox -- <command>`, Codex's CLI entry point to its sandbox. Without configuration it
  applies the read-only policy and starts the `codex-linux-sandbox` helper. The probe assumes that
  the helper gets its arguments from the same builder as the agent's command execution; that
  assumption has not been checked against the 0.162.1 source, and where it fails, a
  `codex sandbox` result says less about the commands a model runs. No login, model, API key or
  token is involved: each Codex process gets an explicit seven-variable environment with a fresh
  `HOME` and `CODEX_HOME`.
- Ubuntu's `bubblewrap` (the reported system `bwrap`) and `strace` are installed on the disposable
  runner. Apart from those packages, the transient units and the two control phases below, each of
  which reverts its own change, nothing on the runner changes.

Four cells, every combination of:

| geometry | meaning |
| --- | --- |
| direct | the runner's normal user, from the workflow step |
| service | the same user in a transient `systemd-run` unit with `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=no`, `PrivateNetwork=no`, `PrivateUsers=no`, `RestrictNamespaces=no` and only the cell directory writable |

| helper | meaning |
| --- | --- |
| system | standard `PATH`; Codex selects the first suitable `bwrap` on it |
| bundled | a `PATH` without `bwrap`; Codex falls back to its own `codex-resources/bwrap` |

The probe records which `bwrap` the standard `PATH` selects, the path it resolves to, and whether
that is `/usr/bin/bwrap`, the file the control profile names (`host.systemBwrap`, also printed in
the summary).

In each cell the worker first checks that Codex launches there at all: `codex --version` must print
`codex-cli 0.162.1`. It writes a random nonce into a project file and checks, outside Codex, that
the same user can read it and write that directory. Through `codex sandbox` it then runs `cat` of
the nonce file, an identity script (namespace ids, `NoNewPrivs`, `Seccomp`, `CapEff` and the
AppArmor label inside the sandbox) and a write into the project directory. Each Codex run is
stopped after 60 seconds. A final `strace -f` run of the read and the kernel log before and after
the cell are kept as raw diagnostics.

Each transient unit also gets `RuntimeMaxSec=600` and `TimeoutStopSec=30`, which bound only its
life. However the wait ends, the probe reads that exact unit's state, stops it and reads it again.
A unit that does not read back as stopped ends the comparison (see below).

## Phases

The four cells run three times, in this order:

| phase | host change during the phase |
| --- | --- |
| `baseline` | none: the runner as provisioned |
| `apparmor-bwrap-profile` | a per-binary AppArmor profile for `/usr/bin/bwrap` that grants `userns` |
| `userns-sysctl-relaxed` | `kernel.apparmor_restrict_unprivileged_userns=0` |

Every phase that starts reads the recorded sysctls (the user-namespace and AppArmor restrictions,
`user.max_user_namespaces`, Yama's ptrace scope and the printk rate limit) and the kernel's loaded
AppArmor profile list (`/sys/kernel/security/apparmor/profiles`) before its cells, after its change
in a control phase, and after it ends. It also keeps a kernel-log diff for each cell.

`apparmor-bwrap-profile` writes Ubuntu's minimal per-binary form for a third-party user of user
namespaces into the artifact directory, loads it with `sudo apparmor_parser -r` and removes it
with `sudo apparmor_parser -R` after the cells. Nothing is installed in `/etc/apparmor.d`.

    abi <abi/4.0>,
    include <tunables/global>

    profile bwrap /usr/bin/bwrap flags=(unconfined) {
      userns,
    }

The system-helper cells are the test. The bundled-helper cells are negative controls: the profile
can attach only to an executable at `/usr/bin/bwrap`, and Codex executes its bundled helper, a
different file, through `/proc/self/fd/N`.

Loading the profile is verified; attaching it is not. The verified change shows that the kernel
listed `bwrap (unconfined)` after the load, not that the profile confined the helper in any cell.
The service cells keep `NoNewPrivileges=yes`, under which AppArmor may refuse an exec-time profile
transition, and the probe does not adjust the unit for that. A cell shows the profile attached
through a `sandboxLabel` naming `bwrap`, which the identity command reads when the sandbox runs
it. An AppArmor line naming the profile during the cell is a weaker sign, since kernel lines are
not tied to the cell's own processes. When the identity command fails and no such line appears,
whether the profile attached in that cell is unknown: audit lines can be rate-limited or
suppressed, so their absence decides nothing.

`userns-sysctl-relaxed` records the original value, runs
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, runs the cells and writes the
recorded value back the same way.

Both control phases follow the same rules:

- A phase changes the host only from the reported restriction: the sysctl reads `1` and no profile
  named `bwrap` is loaded. `apparmor-bwrap-profile` also needs the `bwrap` that the standard `PATH`
  selects to resolve to `/usr/bin/bwrap`, because AppArmor attaches a profile by the resolved path
  of the executable. Otherwise a phase changes nothing and its cells are `not_run`.
- Its cells run only when the host state read after the change differs from the state before by
  exactly the intended change: the profile `bwrap (unconfined)` added, or the sysctl `1 -> 0`.
- Once it has attempted a change, it always reverts it, also when the change could not be verified
  or a cell failed.
- A phase has ended in its starting state only when the sysctls and the profile list read
  afterwards equal those read before it. Otherwise every later phase is `not_run`.

In every phase, a cell whose processes are not shown to have ended stops the comparison: a service
cell whose transient unit does not read back as stopped, a direct cell whose worker ended by a
signal or was stopped at its time limit, or a cell the harness could not finish. A process such
a cell left could act during any later cell, so the rest of its phase and every later phase are
`not_run`, and no later host change is applied. A change the current phase applied is still
reverted.

The privileged commands live in the probe script, and its tests pin their exact argv, order and
restore logic with injected commands. The workflow file runs no `sysctl`, `apparmor_parser` or
`aa-*` command itself.

## How to read the phases

A comparison concerns this runner only, and it compares the verdicts of the same cell across the
phases. In `apparmor-bwrap-profile` a failure can also mean the profile never attached (see
above), and the summary's `change verified` column shows only that it was loaded. The summary
prints these rules:

- Compare phases only in a `complete` run: a `not_run` cell or any harness defect leaves the
  comparison open.
- A baseline cell that is `proven` has no failure for the controls to locate.
- Support: a system cell `proven` in both `apparmor-bwrap-profile` and `userns-sysctl-relaxed`,
  while the bundled cells still fail under the profile, is strong support that this runner's
  failure is AppArmor's restriction of unprivileged user namespaces applied to bwrap.
- Refutation: a cell that fails in both control phases fails for another reason on this runner.
  `userns-sysctl-relaxed` runs its cells only after the sysctl reads `0`.
- Profile failing, sysctl passing: the profile did not take effect for the helper (attachment
  path, `NoNewPrivileges`, the profile itself). That is not a refutation.
- Profile passing, sysctl failing: relaxing the restriction for every program cannot be stricter
  than one profile, so this is an artifact such as timing or a leftover process; rerun rather than
  conclude.
- In `apparmor-bwrap-profile`, `direct-system` is the clean cell. The service cells run with
  `NoNewPrivileges=yes`, under which AppArmor may refuse the exec-time profile transition, so a
  failing `service-system` beside a proven `direct-system` is not a refutation.
- A bundled cell `proven` under `apparmor-bwrap-profile` breaks the negative control, and that
  phase cannot be credited to the profile.
- A cell whose sandbox probe ended by `ETIMEDOUT` or ran for about the 60 s limit failed on
  timing: an artifact, not a refutation.

## Verdicts

Each cell's verdict comes from its untraced runs only:

- `proven`: Codex launched; the nonce came back; the command ran in new user, mount and network
  namespaces; and the write started inside and failed with an exit status (no signal, error or
  timeout), leaving no host file. The network namespace counts because the #337 error comes from
  bubblewrap configuring loopback in a new one. `proven` does not attest which helper executed;
  see `trace.helper` below.
- `capability_failed`: Codex launched, but `codex sandbox` did not return the nonce, for example
  because the helper failed before the command. Its stderr, the trace and the kernel log stay
  evidence; they do not decide the verdict.
- `not_isolated`: the command ran in the caller's user, mount or network namespace.
- `write_not_refused`: the write reached the host file.
- `inconclusive`: an outside control failed, the namespace ids are unknown, or the write did not
  start inside or ended by signal, error or timeout.
- `worker_defect`: no sandbox ran. In that cell `codex --version` did not print the pinned version
  (a missing node or launcher, for example), a probe process could not be started, or the cell
  worker left no observations.
- `not_run`: the cell was planned but never started, because its phase's precondition or change
  was not verified, an earlier phase did not end in its starting state, or an earlier cell's
  processes were not shown to have ended.

Each cell also reports:

- `probes`: for the read, identity and write runs, how each ended (`exited 1`,
  `failed (ETIMEDOUT)` and so on), how many milliseconds it took, whether it reached the time limit
  (`atTimeLimit`: ended by `ETIMEDOUT` or within 5 seconds of the 60-second limit) and its first
  stderr line. That line is the helper's own message when it failed before the command, which
  `capability_failed` alone does not tell apart. These help read a failure and never decide the
  verdict; the summary shows the read run's.
- `trace.helper`: which `bwrap` the separately traced read executed. That read is a different
  process from the runs that decide the verdict. An exec counts as executed only when the trace
  shows it returned 0. strace splits a call that another thread interrupts into an
  `<unfinished ...>` line and a later `<... execve resumed>` line; the probe joins the two by pid,
  including strace's `superseded by execve` handover to the thread group leader. An attempt that
  returned an error is listed in `failed` with its errno, and one whose return the trace never
  shows is listed in `unresolved`; neither counts as executed, and with no exec that returned 0
  the helper is `none`. The system helper appears as an exec of `/usr/bin/bwrap` with argv0
  `bwrap`. Codex runs its bundled helper by opening the file and executing `/proc/self/fd/N` with
  argv0 `bwrap`, and a text trace cannot show what N named at that moment: a descriptor can be
  closed, replaced or inherited between the open and the exec. Such an exec is therefore only ever
  reported as inferred. Its `openedAs` hint is the file the same thread last opened as N; the trace
  also records `close`, `close_range`, `dup2` and `dup3`, and any of them on N in any thread drops
  the hint, as does a new task or program under that pid. Without a hint, or with the installed
  helper as the hint, the exec is `bundled (inferred)`; with another file it is
  `system (inferred)` or `other (inferred)`. Only an exec under the installed helper's own path is
  reported as `bundled`.
- `sandboxLabel`: the AppArmor label the identity script read inside the sandbox, when it ran. In
  `apparmor-bwrap-profile` it is the direct per-cell sign that the profile attached.
- `kernelLog`: the dmesg lines added during the cell (`kernel-log-diff.txt` in its evidence), its
  AppArmor audit records grouped by operation, profile, target, capability and `execpath`, and the
  count in any `callbacks suppressed` line. These are the lines printed between the cell's two
  `dmesg` captures by any process on the runner: they show what happened while the cell ran, not
  which process caused each line. The kernel prints the `callbacks suppressed` line only when the
  next audit line passes the limiter, so the count can cover lines dropped before the cell began.
  With no audit daemon, the kernel prints audit records to dmesg under the printk rate limit
  (`kernel.printk_ratelimit` seconds, `kernel.printk_ratelimit_burst` lines, both recorded), and
  AppArmor suppresses repeated audit records of the same capability denial for the same profile.
  The probe waits `kernel.printk_ratelimit` + 1 seconds before each cell, so every cell starts with
  a fresh window. Run 40865743092, which had no such pause, logged exactly 10 audit lines in its
  first cell and none in later cells: the first cell hit the burst ceiling at its default of 10. A
  pause cannot lift that ceiling: a cell that produces more audit lines within one window than the
  burst allows still loses the rest. A missing line is not evidence that nothing was denied.

A service cell also reports whether its geometry was established: the worker ran in the expected
unit, the kernel shows `NoNewPrivs: 1`, and `systemctl show` reports each requested value.

## Job conclusion

Sandbox verdicts are experimental data and never fail the job. `summary.json` records the harness
`outcome` and its `defects`, every phase with its host-state reads, setup and restore command
records, observed differences and sandbox outcome, and every cell labelled with its `phase`.

`summary.json` uses schema `claudexor-linux-codex-readonly-probe/4`. In `/3`, the entries of
`trace.helper.execs` were `{path, file, kind}`, and a split exec counted as executed whatever it
returned. In `/4` they are `{pid, path, openedAs, kind}`, only execs that returned 0 are listed
there, and the other attempts are listed separately in `failed` and `unresolved`.

The run:

- exits 0 (`complete`) when all twelve planned cells ran with their evidence and every phase ended
  in its starting host state;
- exits 1 (`incomplete`) on any harness defect: a cell `not_run` (a control phase skipped for its
  precondition, or a comparison stopped after a cell whose processes were not shown to have ended)
  or `worker_defect`, a failed outside control, a cell worker that did not exit 0, an unavailable
  kernel log, a missing trace, an unestablished service geometry, a transient unit not shown
  stopped, a control change that could not be verified, or a host state not restored;
- exits 2 for an unsupported host or a harness exception.

A kernel log that could not be read is reported as `unavailable`, never as empty. A phase's sandbox
outcome is `write_not_refused` when any write landed, `proven` only when all four of its cells are
`proven` without a defect, `not_run` when none ran, and `not_proven` otherwise.

The runner is discarded after the job, so the restores protect the comparison and the later
phases. A job stopped by its time limit restores nothing, and it fails.

## Running it

`workflow_dispatch` is available once this file is on the default branch. Before that, a push to
the single diagnostic branch runs it:

    git push origin <commit>:refs/heads/diag/linux-codex-readonly-probe

The artifact `linux-codex-readonly-probe-<run id>-<attempt>` holds `summary.json`, `summary.md`,
host and install receipts, and per phase under `phases/<phase>/`: the host-state reads
(`host-before/`, `host-applied/`, `host-after/`), the `setup` and `restore` command records and,
for `apparmor-bwrap-profile`, the loaded `bwrap.apparmor`. Each cell under
`phases/<phase>/cells/<cell>/` keeps its spec, observations, `kernel-log-diff.txt` and the complete
argv, env, stdout and stderr of every process it started, with `strace.txt` and the kernel log
captures.

## What a result can and cannot show

- No model turn or Claudexor review runs, so model-driven project reading remains unproven.
- #337 was observed with Codex 0.153.3; the probe pins 0.162.1, the release-tested baseline. A
  change in how Codex launches its sandbox between those versions is outside what this probe
  shows.
- A GitHub-hosted VM is not the #337 host: kernel build, AppArmor policy and unit details may
  differ. No result here establishes or excludes the original cause.
- The transient unit reproduces only the reported hardening. The original unit's other
  properties, environment, `PATH` and writable paths are unknown.
- A verdict that changes between phases shows which restriction this runner's failure depends on.
  It does not show that the original host failed for the same reason, and neither change becomes
  a fix to apply to a host.
- A loaded profile is not an attached one. Without a `bwrap` label inside the sandbox, a cell does
  not establish whether the profile confined its helper, and in the service cells
  `NoNewPrivileges=yes` may keep it from attaching at all.
- Helper choice is steered only through `PATH`, Codex's own selection rule. Which helper ran comes
  from the separately traced read, which counts only execs that returned 0 and only infers which
  file a `/proc/self/fd/N` exec ran.
- A direct cell has no unit to stop. The harness sees its worker end, but a Codex process that a
  timed-out run left behind is not tracked; stopping a service cell's unit ends every process in
  it.

The same Codex build has a second credential-free route that this probe does not run: the
app-server Claudexor uses, after its `initialize` handshake, accepts `command/exec` with
`sandboxPolicy: {"type": "readOnly"}` and runs one command under its sandbox without a thread or
turn. A follow-up could add it to cover the app-server process itself.
